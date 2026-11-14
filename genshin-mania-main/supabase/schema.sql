-- ============================================================================
-- Genshin Mania: beatmap catalog on Supabase.
--
-- HOW TO USE
--   1. Create the admin user first (Authentication > Users > Add user).
--   2. Copy that user's "User UID".
--   3. Replace OWNER_USER_ID below (one place only) with that UID.
--   4. SQL Editor > New query > paste this whole file > Run.
--
-- WHAT IT DOES
--   - Anyone (no account) can READ beatmaps and DOWNLOAD audio.
--   - Only the owner user can add, edit or delete beatmaps and audio.
--   The website only ever holds the public key; these rules are what keep
--   everyone else read-only. It is safe to run this file more than once.
-- ============================================================================

-- The one place that says who the owner is.
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select auth.uid() = 'OWNER_USER_ID'::uuid
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.beatmaps (
  id          uuid primary key default gen_random_uuid(),
  title       text        not null check (char_length(title) between 1 and 120),
  artist      text        not null default '' check (char_length(artist) <= 120),
  difficulty  text        not null default 'normal' check (difficulty in ('easy', 'normal', 'hard', 'expert')),
  bpm         numeric     not null check (bpm > 0 and bpm < 1000),
  lane_count  smallint    not null check (lane_count in (4, 6, 8)),
  note_count  integer     not null check (note_count > 0),
  duration_s  numeric     not null check (duration_s > 0),
  chart       jsonb       not null check (octet_length(chart::text) <= 400000),
  audio_path  text        not null check (char_length(audio_path) between 1 and 200),
  audio_bytes bigint      not null check (audio_bytes > 0 and audio_bytes <= 52428800),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists beatmaps_created_idx on public.beatmaps (created_at desc);

alter table public.beatmaps enable row level security;

grant select on public.beatmaps to anon, authenticated;
grant insert, update, delete on public.beatmaps to authenticated;

drop policy if exists "anyone can read beatmaps" on public.beatmaps;
create policy "anyone can read beatmaps" on public.beatmaps
  for select to anon, authenticated using (true);

drop policy if exists "owner can add beatmaps" on public.beatmaps;
create policy "owner can add beatmaps" on public.beatmaps
  for insert to authenticated with check (public.is_owner());

drop policy if exists "owner can edit beatmaps" on public.beatmaps;
create policy "owner can edit beatmaps" on public.beatmaps
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "owner can delete beatmaps" on public.beatmaps;
create policy "owner can delete beatmaps" on public.beatmaps
  for delete to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- Audio storage
-- A public bucket lets anyone download a file when they know its address.
-- There is deliberately NO public read policy on storage.objects, so nobody
-- can list the bucket; only the owner can.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'beatmap-audio', 'beatmap-audio', true, 52428800,
  array['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav',
        'audio/mp4', 'audio/aac', 'audio/x-m4a', 'application/octet-stream']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owner can list audio" on storage.objects;
create policy "owner can list audio" on storage.objects
  for select to authenticated using (bucket_id = 'beatmap-audio' and public.is_owner());

drop policy if exists "owner can upload audio" on storage.objects;
create policy "owner can upload audio" on storage.objects
  for insert to authenticated with check (bucket_id = 'beatmap-audio' and public.is_owner());

drop policy if exists "owner can replace audio" on storage.objects;
create policy "owner can replace audio" on storage.objects
  for update to authenticated
  using (bucket_id = 'beatmap-audio' and public.is_owner())
  with check (bucket_id = 'beatmap-audio' and public.is_owner());

drop policy if exists "owner can delete audio" on storage.objects;
create policy "owner can delete audio" on storage.objects
  for delete to authenticated using (bucket_id = 'beatmap-audio' and public.is_owner());
