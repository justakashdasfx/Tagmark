/**
 * sync.js — local-first sync with Supabase, using plain fetch (no SDK, no build step).
 *
 * The device is always the source of truth for what you are doing right now. Sync:
 *   1. pulls rows other devices changed since the last pull (newest edit wins, per bookmark),
 *   2. pushes what changed here (edits, deletions as tombstones, and settings).
 * It works offline and catches up whenever it next runs. See supabase.sql for the tables.
 */
import { store } from './platform.js';
import { CONFIG } from './config.js';

const SETTINGS_KEYS = ['userRules', 'folders', 'disabledRules', 'topics', 'pinnedTags', 'prefs'];
const LOCK = 'tagmark-sync';

export const isConfigured = () =>
  !!CONFIG.url && !!CONFIG.key && !/YOUR-/i.test(`${CONFIG.url}${CONFIG.key}`);

async function getSync() {
  const { sync } = await store.get({ sync: null });
  return sync || {};
}
async function setSync(patch) {
  const cur = await getSync();
  await store.set({ sync: { ...cur, ...patch } });
}

/* ---------------- auth ---------------- */

async function authFetch(path, body, query = '') {
  const res = await fetch(`${CONFIG.url}/auth/v1/${path}${query}`, {
    method: 'POST',
    headers: { apikey: CONFIG.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.message || json.error || `Sign-in failed (${res.status})`);
  }
  return json;
}

const toSession = (json) => ({
  access_token: json.access_token,
  refresh_token: json.refresh_token,
  expires_at: Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
  user: { id: json.user?.id, email: json.user?.email },
});

export async function signIn(email, password) {
  const json = await authFetch('token', { email, password }, '?grant_type=password');
  await setSync({ session: toSession(json), lastPull: null, lastPushAt: 0, lastSettingsPush: 0, error: null });
  return syncNow();
}

export async function signUp(email, password) {
  const json = await authFetch('signup', { email, password });
  if (json.access_token) {
    await setSync({ session: toSession(json), lastPull: null, lastPushAt: 0, lastSettingsPush: 0, error: null });
    return syncNow();
  }
  return { needsConfirm: true };
}

export async function signOut() {
  await setSync({ session: null, lastPull: null, lastPushAt: 0, lastSettingsPush: 0, lastSync: null, syncing: false, error: null });
}

async function token() {
  let { session } = await getSync();
  if (!session) throw new Error('Not signed in');
  if (session.expires_at - 60 < Date.now() / 1000) {
    const json = await authFetch('token', { refresh_token: session.refresh_token }, '?grant_type=refresh_token');
    session = toSession(json);
    await setSync({ session });
  }
  return session.access_token;
}

/** For the website's link-reader API. */
export function getAccessToken() {
  const run = () => token();
  return navigator.locks ? navigator.locks.request(LOCK, run) : run();
}

/* ---------------- REST ---------------- */

async function rest(path, { method = 'GET', body, headers = {} } = {}) {
  const t = await token();
  const res = await fetch(`${CONFIG.url}/rest/v1/${path}`, {
    method,
    headers: { apikey: CONFIG.key, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(res.status === 404 ? 'Sync tables not found. Did you run supabase.sql?' : `Sync failed (${res.status}) ${text}`);
  }
  return method === 'GET' ? res.json() : null;
}

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const iso = (ms) => new Date(ms).toISOString();

/* ---------------- pull ---------------- */

async function pull() {
  const cfg = await getSync();
  const since = cfg.lastPull || null;

  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const filter = since ? `&synced_at=gt.${encodeURIComponent(since)}` : '';
    const page = await rest(`bookmarks?select=id,data,updated_at,synced_at,deleted${filter}&order=synced_at.asc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }

  const local = await store.get({ bookmarks: [], tombstones: [] });
  const byId = new Map(local.bookmarks.map((b) => [b.id, b]));
  const tombs = new Map(local.tombstones.map((t) => [t.id, t.at]));
  const applied = new Map(); // id -> timestamp, so we don't echo these straight back
  let maxSynced = since;
  let changed = 0;

  for (const r of rows) {
    if (!maxSynced || r.synced_at > maxSynced) maxSynced = r.synced_at;
    const ts = Date.parse(r.updated_at);
    const mine = byId.get(r.id);
    const tomb = tombs.get(r.id);

    if (tomb !== undefined && tomb >= ts) continue;   // we deleted it more recently; our tombstone gets pushed

    if (r.deleted) {
      if (mine && (mine.updatedAt || 0) <= ts) { byId.delete(r.id); changed++; }
      if (tomb !== undefined && tomb < ts) tombs.delete(r.id);
      continue;
    }
    if (!mine || (mine.updatedAt || 0) < ts) {
      byId.set(r.id, { ...r.data, id: r.id, updatedAt: ts });
      applied.set(r.id, ts);
      tombs.delete(r.id);
      changed++;
    }
  }

  if (changed || tombs.size !== local.tombstones.length) {
    await store.set({
      bookmarks: [...byId.values()],
      tombstones: [...tombs].map(([id, at]) => ({ id, at })),
    });
  }

  // settings (rules, folders, topics, pinned tags, view + sidebar preferences)
  const [srow] = await rest('settings?select=data,updated_at&limit=1');
  if (srow) {
    const ts = Date.parse(srow.updated_at);
    const { settingsUpdatedAt } = await store.get({ settingsUpdatedAt: 0 });
    if (ts > settingsUpdatedAt) {
      const patch = { settingsUpdatedAt: ts };
      for (const k of SETTINGS_KEYS) if (k in (srow.data || {})) patch[k] = srow.data[k];
      await store.set(patch);
      await setSync({ lastSettingsPush: ts });
      changed++;
    }
  }

  await setSync({ lastPull: maxSynced });
  return { changed, applied };
}

/* ---------------- push ---------------- */

async function push(applied) {
  const cfg = await getSync();
  const startedAt = Date.now();
  const uid = cfg.session.user.id;
  const upsert = { Prefer: 'resolution=merge-duplicates,return=minimal' };

  const local = await store.get({
    bookmarks: [], tombstones: [], settingsUpdatedAt: 0,
    userRules: [], folders: [], disabledRules: [], topics: null, pinnedTags: [], prefs: null,
  });

  // Bookmarks saved before sync existed have no timestamp yet.
  let legacy = false;
  for (const b of local.bookmarks) {
    if (!b.updatedAt) { b.updatedAt = b.savedAt || startedAt; legacy = true; }
  }
  if (legacy) await store.set({ bookmarks: local.bookmarks });

  const last = cfg.lastPushAt || 0;
  const dirty = local.bookmarks.filter((b) => b.updatedAt > last && applied.get(b.id) !== b.updatedAt);
  const rows = [
    ...dirty.map((b) => ({ id: b.id, user_id: uid, data: b, updated_at: iso(b.updatedAt), deleted: false })),
    ...local.tombstones.map((t) => ({ id: t.id, user_id: uid, data: {}, updated_at: iso(t.at), deleted: true })),
  ];
  for (const part of chunks(rows, 200)) {
    await rest('bookmarks?on_conflict=id', { method: 'POST', headers: upsert, body: part });
  }

  const settingsDirty = local.settingsUpdatedAt > (cfg.lastSettingsPush || 0);
  if (settingsDirty) {
    const data = {};
    for (const k of SETTINGS_KEYS) data[k] = local[k];
    await rest('settings?on_conflict=user_id', {
      method: 'POST', headers: upsert,
      body: [{ user_id: uid, data, updated_at: iso(local.settingsUpdatedAt) }],
    });
  }

  // Deletions that reached the server no longer need to be remembered here.
  const { tombstones } = await store.get({ tombstones: [] });
  await store.set({ tombstones: tombstones.filter((t) => t.at > startedAt) });
  await setSync({
    lastPushAt: startedAt,
    lastSettingsPush: settingsDirty ? local.settingsUpdatedAt : (cfg.lastSettingsPush || 0),
  });
  return { sent: dirty.length + local.tombstones.length };
}

/* ---------------- public ---------------- */

async function doSync() {
  const cfg = await getSync();
  if (!cfg.session) return { skipped: true };
  try {
    await setSync({ syncing: true, error: null });
    const { changed, applied } = await pull();
    const { sent } = await push(applied);
    await setSync({ syncing: false, lastSync: Date.now(), error: null });
    return { changed, sent };
  } catch (e) {
    const message = e?.message || String(e);
    await setSync({ syncing: false, error: message });
    return { error: message };
  }
}

/** Safe to call from anywhere, any time. Calls queue up instead of overlapping. */
export function syncNow() {
  if (!isConfigured()) return Promise.resolve({ skipped: true });
  return navigator.locks ? navigator.locks.request(LOCK, doSync) : doSync();
}
