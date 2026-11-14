/* ==========================================================================
   CLOUD.JS
   Thin client for the beatmap catalog on Supabase, using plain fetch (no
   library). Two kinds of caller:
     - everyone: list beatmaps, read a chart, download audio. Uses only the
       public key, which database rules limit to reading.
     - the owner: sign in with email + password, then add, edit and delete.
       Writes are accepted by the database only for the owner's user id.

   Exposes a single global: window.Cloud
   ========================================================================== */

const Cloud = (() => {
  const cfg = window.TANT_CONFIG || {};
  const SESSION_KEY = "tant_admin_session";
  const LIST_COLUMNS = "id,title,artist,bpm,lane_count,difficulty,note_count,duration_s,audio_path,audio_bytes,created_at,updated_at";

  // Errors carry a code so the UI can show them in the player's language.
  class CloudError extends Error {
    constructor(code, detail = "") {
      super(code);
      this.code = code;
      this.detail = detail;
    }
  }

  const isConfigured = () => !!(cfg.supabaseUrl && cfg.supabaseKey);
  const base = () => String(cfg.supabaseUrl).replace(/\/+$/, "");
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  // ------------------------------------------------------------------
  // Session (owner only)
  // ------------------------------------------------------------------
  let session = readSession();

  function readSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      return s && s.access_token && s.refresh_token ? s : null;
    } catch {
      return null;
    }
  }

  function storeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* storage may be blocked */ }
  }

  function toSession(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      email: data.user?.email || session?.email || "",
    };
  }

  async function authRequest(path, body) {
    if (!isConfigured()) throw new CloudError("not_configured");
    let res;
    try {
      res = await fetch(base() + path, {
        method: "POST",
        headers: { apikey: cfg.supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new CloudError("network", err.message);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) throw new CloudError("bad_login", data.error_description || data.msg || "");
      throw new CloudError("http", `${res.status} ${data.msg || data.message || ""}`.trim());
    }
    return data;
  }

  async function signIn(email, password) {
    const data = await authRequest("/auth/v1/token?grant_type=password", { email, password });
    storeSession(toSession(data));
    return session;
  }

  async function signOut() {
    if (session && isConfigured()) {
      try {
        await fetch(base() + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${session.access_token}` },
        });
      } catch { /* signing out locally is enough */ }
    }
    storeSession(null);
  }

  async function ensureFreshSession() {
    if (!session) throw new CloudError("forbidden");
    if (session.expires_at - 60 > Date.now() / 1000) return;
    try {
      const data = await authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      storeSession(toSession(data));
    } catch (err) {
      storeSession(null);
      throw err.code === "network" ? err : new CloudError("forbidden");
    }
  }

  const isAdmin = () => !!session;
  const adminEmail = () => session?.email || "";

  // ------------------------------------------------------------------
  // Requests
  // ------------------------------------------------------------------
  async function request(path, { method = "GET", headers = {}, body, auth = false } = {}) {
    if (!isConfigured()) throw new CloudError("not_configured");
    if (auth) await ensureFreshSession();

    const h = { apikey: cfg.supabaseKey, ...headers };
    if (auth) h.Authorization = `Bearer ${session.access_token}`;

    let res;
    try {
      res = await fetch(base() + path, { method, headers: h, body });
    } catch (err) {
      throw new CloudError("network", err.message);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) {
      const detail = data?.message || data?.error || "";
      if (res.status === 401 || res.status === 403) throw new CloudError("forbidden", detail);
      throw new CloudError("http", `${res.status} ${detail}`.trim());
    }
    return data;
  }

  // ------------------------------------------------------------------
  // Public reads
  // ------------------------------------------------------------------
  const list = () => request(`/rest/v1/beatmaps?select=${LIST_COLUMNS}&order=created_at.desc&limit=500`);

  async function getChart(id) {
    const rows = await request(`/rest/v1/beatmaps?select=chart&id=eq.${encodeURIComponent(id)}`);
    if (!rows || !rows.length) throw new CloudError("not_found");
    return rows[0].chart;
  }

  const audioUrl = (path) => `${base()}/storage/v1/object/public/${cfg.bucket}/${encodePath(path)}`;

  async function downloadAudio(path) {
    let res;
    try {
      res = await fetch(audioUrl(path));
    } catch (err) {
      throw new CloudError("network", err.message);
    }
    if (!res.ok) throw new CloudError(res.status === 404 ? "not_found" : "http", String(res.status));
    return res.blob();
  }

  // ------------------------------------------------------------------
  // Owner writes
  // ------------------------------------------------------------------
  async function uploadAudio(path, file) {
    await request(`/storage/v1/object/${cfg.bucket}/${encodePath(path)}`, {
      method: "POST",
      auth: true,
      headers: { "Content-Type": file.type || "application/octet-stream", "cache-control": "max-age=3600" },
      body: file,
    });
  }

  const removeAudio = (path) =>
    request(`/storage/v1/object/${cfg.bucket}/${encodePath(path)}`, { method: "DELETE", auth: true });

  async function insert(row) {
    const rows = await request("/rest/v1/beatmaps", {
      method: "POST", auth: true,
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    return rows && rows[0];
  }

  async function update(id, patch) {
    const rows = await request(`/rest/v1/beatmaps?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", auth: true,
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    // A policy that hides the row from this user answers 200 with no rows.
    if (!rows || !rows.length) throw new CloudError("forbidden");
    return rows[0];
  }

  async function remove(id) {
    const rows = await request(`/rest/v1/beatmaps?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE", auth: true, headers: { Prefer: "return=representation" },
    });
    if (!rows || !rows.length) throw new CloudError("forbidden");
  }

  return {
    CloudError, isConfigured, isAdmin, adminEmail,
    signIn, signOut,
    list, getChart, downloadAudio, audioUrl,
    uploadAudio, removeAudio, insert, update, remove,
  };
})();

window.Cloud = Cloud;
