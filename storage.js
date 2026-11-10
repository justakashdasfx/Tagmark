/**
 * storage.js — all reads/writes go through here, so moving to Supabase later
 * means replacing this file, not the UI.
 *
 * Bookmark shape:
 *   { id, url, title, description, image, favicon, siteName,
 *     type, autoTags[], manualTags[], removedTags[], folderIds[], savedAt,
 *     page: { title, description, ogType, jsonLdTypes, keywords, headings, text } }
 * Displayed tags = (autoTags + manualTags) minus removedTags.
 * Re-running rules only replaces autoTags, so your manual edits survive.
 */
import { DEFAULT_RULES, DEFAULT_TOPICS, classify } from './rules-engine.js';
import { store } from './platform.js';

export const TYPE_LABEL = {
  post: 'Posts', profile: 'Profiles', video: 'Videos',
  article: 'Articles', repo: 'Repos', link: 'Web links',
};
export const TYPE_ORDER = ['post', 'profile', 'video', 'article', 'repo', 'link'];

const DEFAULTS = {
  bookmarks: [], userRules: [], folders: [], disabledRules: [], topics: null,
  pinnedTags: [], prefs: null,
  // sync bookkeeping (see sync.js)
  tombstones: [], settingsUpdatedAt: 0, sync: null,
};

/* Keys that count as "settings" for sync. */
export const SETTINGS_KEYS = ['userRules', 'folders', 'disabledRules', 'topics', 'pinnedTags', 'prefs'];

/* View + sidebar preferences. Sidebar defaults: All bookmarks, Archived, Trash. */
export const DEFAULT_PREFS = {
  view: 'gallery',   // 'gallery' | 'list'
  sort: 'newest',    // 'newest' | 'oldest' | 'name-asc' | 'name-desc'
  sidebar: {
    all: true, archived: true, trash: true,
    post: false, profile: false, video: false, article: false, repo: false, link: false,
    folders: true, tags: true,
  },
};

export function getPrefs(state) {
  const p = state?.prefs || {};
  return { ...DEFAULT_PREFS, ...p, sidebar: { ...DEFAULT_PREFS.sidebar, ...(p.sidebar || {}) }, };
}

export async function setPrefs(patch) {
  const state = await loadState();
  const cur = getPrefs(state);
  await patchState({
    prefs: { ...cur, ...patch, sidebar: { ...cur.sidebar, ...(patch.sidebar || {}) } },
  });
}

/** A bookmark that is neither archived nor in the trash. */
export const isActive = (b) => !b.deletedAt && !b.archivedAt;

export const loadState = () => store.get(DEFAULTS);

const sig = (b) => JSON.stringify({ ...b, updatedAt: 0 });

/**
 * Every write goes through here. It stamps what changed (bookmarks get updatedAt, settings get
 * settingsUpdatedAt) and records deletions as tombstones, which is all sync needs to work out
 * what to send. Writes made by sync.js itself bypass this on purpose.
 */
export async function patchState(patch) {
  const next = { ...patch };
  const now = Date.now();

  if (patch.bookmarks) {
    const old = await store.get({ bookmarks: [], tombstones: [] });
    const before = new Map(old.bookmarks.map((b) => [b.id, sig(b)]));
    for (const b of patch.bookmarks) if (before.get(b.id) !== sig(b)) b.updatedAt = now;

    const present = new Set(patch.bookmarks.map((b) => b.id));
    const removed = old.bookmarks.filter((b) => !present.has(b.id)).map((b) => ({ id: b.id, at: now }));
    const base = patch.tombstones ?? old.tombstones;
    next.tombstones = [...base.filter((t) => !present.has(t.id)), ...removed];
  }

  if (SETTINGS_KEYS.some((k) => k in patch)) next.settingsUpdatedAt = now;
  await store.set(next);
}
export const uid = () => crypto.randomUUID();

export function allRules(state) {
  const disabled = new Set(state.disabledRules);
  return [
    ...DEFAULT_RULES.map((r) => ({ ...r, enabled: !disabled.has(r.id) })),
    ...state.userRules,
  ];
}

export function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src|ref_url)$/i.test(key)) u.searchParams.delete(key);
  }
  if (/(^|\.)(x|twitter)\.com$/.test(u.hostname)) {
    u.searchParams.delete('s');
    u.searchParams.delete('t');
  }
  return u.href;
}

export function tagsOf(b) {
  const removed = new Set((b.removedTags || []).map((t) => t.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const t of [...(b.autoTags || []), ...(b.manualTags || [])]) {
    const k = t.toLowerCase();
    if (removed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/* ---------------- save ---------------- */

export async function saveBookmark(page, favicon = '') {
  const state = await loadState();
  const url = normalizeUrl(page.url);
  const existing = state.bookmarks.find((b) => b.url === url);
  if (existing) {
    if (existing.deletedAt) {
      existing.deletedAt = null;
      await patchState({ bookmarks: state.bookmarks });
      return { bookmark: existing, existed: false };
    }
    return { bookmark: existing, existed: true };
  }

  const result = classify(
    { ...page, url },
    { rules: allRules(state), topics: state.topics || DEFAULT_TOPICS },
  );

  const bookmark = {
    id: uid(),
    url,
    title: page.title || url,
    description: page.description || '',
    image: page.image || '',
    favicon,
    siteName: page.siteName || '',
    type: result.type,
    autoTags: result.tags,
    manualTags: [],
    removedTags: [],
    folderIds: [],
    savedAt: Date.now(),
    page: {
      title: page.title || '',
      description: page.description || '',
      ogType: page.ogType || '',
      jsonLdTypes: page.jsonLdTypes || [],
      keywords: page.keywords || [],
      headings: page.headings || [],
      text: page.text || '',
    },
  };
  state.bookmarks.unshift(bookmark);
  await patchState({ bookmarks: state.bookmarks });
  return { bookmark, existed: false };
}

/* ---------------- edit ---------------- */

async function mutate(id, fn) {
  const { bookmarks } = await loadState();
  const b = bookmarks.find((x) => x.id === id);
  if (!b) return null;
  fn(b);
  await patchState({ bookmarks });
  return b;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export const removeTagFrom = (id, tag) =>
  mutate(id, (b) => {
    b.manualTags = (b.manualTags || []).filter((t) => !same(t, tag));
    if ((b.autoTags || []).some((t) => same(t, tag)) && !b.removedTags.some((t) => same(t, tag))) {
      b.removedTags.push(tag);
    }
  });

export const addManualTag = (id, tag) =>
  mutate(id, (b) => {
    const t = tag.trim();
    if (!t) return;
    b.removedTags = (b.removedTags || []).filter((x) => !same(x, t));
    if (!(b.manualTags || []).some((x) => same(x, t))) b.manualTags.push(t);
  });

export const setFolder = (id, folderId) =>
  mutate(id, (b) => { b.folderIds = folderId ? [folderId] : []; });

export async function deleteBookmark(id) {
  const { bookmarks } = await loadState();
  await patchState({ bookmarks: bookmarks.filter((b) => b.id !== id) });
}

/* ---------------- re-run rules on everything saved ---------------- */

export async function reclassifyAll() {
  const state = await loadState();
  const rules = allRules(state);
  const topics = state.topics || DEFAULT_TOPICS;
  for (const b of state.bookmarks) {
    const r = classify({ url: b.url, ...b.page }, { rules, topics });
    b.type = r.type;
    b.autoTags = r.tags;
  }
  await patchState({ bookmarks: state.bookmarks });
  return state.bookmarks.length;
}

/* ---------------- backup ---------------- */

/** Backups never include sign-in tokens or sync bookkeeping. */
export async function exportData() {
  const { sync, tombstones, settingsUpdatedAt, ...rest } = await loadState();
  return rest;
}

export async function importData(data) {
  const state = await loadState();
  const urls = new Set(state.bookmarks.map((b) => b.url));
  let added = 0;
  for (const b of data.bookmarks || []) {
    if (b?.url && !urls.has(b.url)) { state.bookmarks.push(b); urls.add(b.url); added++; }
  }
  const mergeById = (mine, theirs = []) => {
    const ids = new Set(mine.map((x) => x.id));
    return [...mine, ...theirs.filter((x) => x?.id && !ids.has(x.id))];
  };
  state.folders = mergeById(state.folders, data.folders);
  state.userRules = mergeById(state.userRules, data.userRules);
  state.disabledRules = [...new Set([...state.disabledRules, ...(data.disabledRules || [])])];
  const { sync, ...toWrite } = state; // never rewrite sign-in tokens from an import
  await patchState(toWrite);
  return added;
}

/* ---------------- bulk actions (library selection) ---------------- */

async function mutateMany(ids, fn) {
  const set = new Set(ids);
  const { bookmarks } = await loadState();
  for (const b of bookmarks) if (set.has(b.id)) fn(b);
  await patchState({ bookmarks });
}

export async function deleteBookmarks(ids) {
  const set = new Set(ids);
  const { bookmarks } = await loadState();
  await patchState({ bookmarks: bookmarks.filter((b) => !set.has(b.id)) });
}

/** Put deleted bookmarks back (used by Undo). */
export async function restoreBookmarks(list) {
  const { bookmarks } = await loadState();
  const have = new Set(bookmarks.map((b) => b.id));
  const merged = [...bookmarks, ...list.filter((b) => !have.has(b.id))];
  merged.sort((a, b) => b.savedAt - a.savedAt);
  await patchState({ bookmarks: merged });
}

export const bulkAddTag = (ids, tag) =>
  mutateMany(ids, (b) => {
    const t = tag.trim();
    if (!t) return;
    b.removedTags = (b.removedTags || []).filter((x) => !same(x, t));
    if (!(b.manualTags || []).some((x) => same(x, t))) b.manualTags.push(t);
  });

export const bulkSetFolder = (ids, folderId) =>
  mutateMany(ids, (b) => { b.folderIds = folderId ? [folderId] : []; });

/* ---------------- archive, trash, pinned tags ---------------- */

export const archiveBookmarks = (ids, on = true) =>
  mutateMany(ids, (b) => { b.archivedAt = on ? Date.now() : null; });

export const trashBookmarks = (ids) =>
  mutateMany(ids, (b) => { b.deletedAt = Date.now(); });

export const untrashBookmarks = (ids) =>
  mutateMany(ids, (b) => { b.deletedAt = null; });

export async function emptyTrash() {
  const { bookmarks } = await loadState();
  await patchState({ bookmarks: bookmarks.filter((b) => !b.deletedAt) });
}

/** Returns true when the tag ends up pinned. */
export async function togglePinnedTag(name) {
  const { pinnedTags } = await loadState();
  const has = pinnedTags.some((t) => same(t, name));
  await patchState({
    pinnedTags: has ? pinnedTags.filter((t) => !same(t, name)) : [...pinnedTags, name],
  });
  return !has;
}
