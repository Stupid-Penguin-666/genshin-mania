/* Cloud settings for the Download Beatmaps screen.

   Fill these two values in after creating your Supabase project
   (see supabase/README.md). Both are PUBLIC by design: the site only ever
   uses the public key, and database rules (supabase/schema.sql) decide what
   that key may do. Never put a service_role key or a database password here.

   Leave them empty and the game still works; the Download Beatmaps screen
   just says that downloads are not set up. */
window.TANT_CONFIG = {
  supabaseUrl: "https://usvpzxgqwqijpqwuifhe.supabase.co",   // example: "https://abcdefghijkl.supabase.co"
  supabaseKey: "sb_publishable_QDJOdWEw_x216rspwcJBwA_DU5LcWtE",   // the anon / publishable key from Project Settings > API
  bucket: "beatmap-audio",
};
