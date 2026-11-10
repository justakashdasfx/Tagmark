import { h, icon, tagHue, getTheme, setTheme } from './dom.js';
import {
  loadState, patchState, saveBookmark, getPrefs, setPrefs, tagsOf, isActive,
  archiveBookmarks, trashBookmarks, untrashBookmarks, deleteBookmarks, emptyTrash,
  togglePinnedTag, bulkAddTag, bulkSetFolder, reclassifyAll, exportData, importData,
  TYPE_LABEL, TYPE_ORDER, uid,
} from './storage.js';
import { DEFAULT_RULES, DEFAULT_TOPICS, matchFolders } from './rules-engine.js';
import { renderGuide } from './guide.js';
import { store, isExtension, openUrl } from './platform.js';
import { syncNow, signIn, signUp, signOut, isConfigured } from './sync.js';
import { fetchPage } from './meta.js';

const $ = (s) => document.querySelector(s);
const searchEl = $('#search');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

let state;
let prefs = getPrefs(null);
let visible = [];              // bookmarks currently shown, in order
let focusedId = null;          // keyboard cursor
let lastPickId = null;         // anchor for shift-click ranges
let introPlayed = false;       // card entrance plays once per page load
let lastMode = null;           // 'gallery' | 'list' of the last render (for the cross-fade)
let lastPinned = null;         // tag that was just pinned (drives a one-off animation)
let flipRects = null;          // positions captured before a mouse-driven change
let flipTimer = 0;
let quietUntil = 0;            // while true, Settings keeps its DOM so switches can animate
const selected = new Set();
const cardEls = new Map();

/* ============================================================
   helpers
   ============================================================ */

const route = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return [parts[0] || 'all', decodeURIComponent(parts.slice(1).join('/'))];
};
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
const singular = (t) => (TYPE_LABEL[t] || t).replace(/s$/, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isManual = (f) => !(f.conditions || []).length;
const lower = (s) => String(s).toLowerCase();
const fmtDate = (ts) => {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};

const folderIdsFor = (b) => new Set([
  ...(b.folderIds || []),
  ...matchFolders(
    { url: b.url, title: b.title, description: b.description, type: b.type, tags: tagsOf(b) },
    state.folders,
  ),
]);

const SORTS = {
  newest: (a, b) => b.savedAt - a.savedAt,
  oldest: (a, b) => a.savedAt - b.savedAt,
  'name-asc': (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  'name-desc': (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: 'base', numeric: true }),
};

const FIELDS = ['url', 'host', 'path', 'handle', 'title', 'description', 'type', 'tags', 'keywords', 'text'];
const OPS = [
  ['contains', 'contains'], ['equals', 'is'], ['notContains', 'does not contain'],
  ['notEquals', 'is not'], ['startsWith', 'starts with'], ['endsWith', 'ends with'],
  ['in', 'is one of'], ['regex', 'matches regex'], ['isEmpty', 'is empty'], ['notEmpty', 'is not empty'],
];
const opLabel = (op) => (OPS.find(([v]) => v === op) || [op, op])[1];
const summarize = (r) => {
  const parts = (r.conditions || [])
    .filter((c) => !c.conditions)
    .map((c) => `${c.field} ${opLabel(c.op)} ${Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '')}`.trim());
  return parts.join(r.match === 'any' ? ', or ' : ', and ') || 'No conditions';
};

/** Tag counts over bookmarks that are neither archived nor trashed. */
function tagCounts() {
  const map = new Map();
  for (const b of state.bookmarks) {
    if (!isActive(b)) continue;
    for (const t of tagsOf(b)) {
      const k = lower(t);
      if (!map.has(k)) map.set(k, { name: t, count: 0 });
      map.get(k).count++;
    }
  }
  return map;
}
const isPinned = (name) => state.pinnedTags.some((t) => lower(t) === lower(name));

/* ============================================================
   motion helpers (mouse-driven changes only; keyboard stays instant)
   ============================================================ */

function captureRects() {
  const rects = new Map();
  for (const [id, el] of cardEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom > -120 && r.top < innerHeight + 120) rects.set(id, r);
  }
  return rects;
}

function armFlip() {
  if (reduced.matches) return;
  flipRects = captureRects();
  clearTimeout(flipTimer);
  flipTimer = setTimeout(() => { flipRects = null; }, 700);
}

/** Items that kept existing glide from where they were to where they are now. */
function playFlip() {
  const prev = flipRects;
  flipRects = null;
  if (!prev || reduced.matches) return;
  for (const [id, el] of cardEls) {
    const p = prev.get(id);
    if (!p) continue;
    const n = el.getBoundingClientRect();
    const dx = p.left - n.left;
    const dy = p.top - n.top;
    if (!dx && !dy) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 260, easing: EASE },
    );
  }
}

async function fadeOut(ids) {
  if (reduced.matches) return;
  const anims = [];
  for (const id of ids) {
    const el = cardEls.get(id);
    if (el) {
      anims.push(el.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.96)' }],
        { duration: 140, easing: EASE, fill: 'forwards' },
      ).finished.catch(() => {}));
    }
  }
  await Promise.all(anims);
}

/** Run a write; with `animate`, fade the items out and let the rest close the gap. */
async function runWithMotion(ids, write, animate = true) {
  selected.clear();
  updateSelectionUI();
  if (animate && !reduced.matches) {
    armFlip();
    await fadeOut(ids);
  }
  await write();
}

/* ============================================================
   tooltips (replace the browser's native ones; any element can opt in with data-tip / data-key)
   ============================================================ */

const tipEl = h('div', { class: 'tip', role: 'tooltip' });
let tipHover = null;
let tipTimer = 0;
let tipWarm = false;      // just closed one: the next opens instantly
let tipWarmTimer = 0;

function placeTip(el) {
  tipEl.replaceChildren(...[el.dataset.tip, el.dataset.key ? h('kbd', {}, el.dataset.key) : null].filter(Boolean));
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const hgt = tipEl.offsetHeight;
  let top = r.top - hgt - 8;
  let origin = 'bottom';
  if (top < 8) { top = r.bottom + 8; origin = 'top'; }
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  tipEl.style.transformOrigin = `${r.left + r.width / 2 - left}px ${origin}`;
}

function showTip(el) {
  tipEl.classList.toggle('instant', tipWarm || tipEl.classList.contains('show'));
  placeTip(el);
  tipEl.classList.add('show');
}

function hideTip() {
  clearTimeout(tipTimer);
  tipHover = null;
  if (!tipEl.classList.contains('show')) return;
  tipEl.classList.remove('instant', 'show');
  tipWarm = true;
  clearTimeout(tipWarmTimer);
  tipWarmTimer = setTimeout(() => { tipWarm = false; }, 300);
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  if (!el || el === tipHover) return;
  tipHover = el;
  clearTimeout(tipTimer);
  if (tipWarm || tipEl.classList.contains('show')) showTip(el);
  else tipTimer = setTimeout(() => { if (tipHover === el && el.isConnected) showTip(el); }, 450);
});
document.addEventListener('pointerout', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  if (!el || el.contains(e.relatedTarget)) return;
  hideTip();
});
for (const ev of ['pointerdown', 'keydown', 'scroll', 'blur']) window.addEventListener(ev, hideTip, true);

/* ============================================================
   toasts (transitions, not keyframes, so rapid toasts retarget smoothly)
   ============================================================ */

function toast(message, { action, onAction, duration = 6000 } = {}) {
  let timer;
  const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, message));
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 240);
  }
  if (action) {
    el.append(h('button', { onclick: () => { onAction?.(); dismiss(); } }, action));
  }
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2500); });
  $('#toasts').append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  timer = setTimeout(dismiss, duration);
}

/* ============================================================
   segmented control
   ============================================================ */

function segmented(options, value, onChange, { text = false } = {}) {
  const el = h('div', { class: 'seg', role: 'group' });
  el.style.setProperty('--n', String(options.length));
  const buttons = options.map((o) => h('button', {
    type: 'button', 'data-tip': o.label, 'aria-label': o.label, 'aria-pressed': 'false',
    onclick: () => onChange(o.value),
  }, icon(o.icon, 15), text ? o.label : null));
  el.set = (v) => {
    const i = Math.max(0, options.findIndex((o) => o.value === v));
    el.style.setProperty('--i', String(i));
    buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  };
  el.set(value);
  el.append(...buttons);
  return el;
}

const THEMES = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];
const themeControls = new Set();
function themeSeg(text) {
  const seg = segmented(THEMES, getTheme(), (v) => {
    setTheme(v);
    for (const s of themeControls) {
      if (s.isConnected) s.set(v); else themeControls.delete(s);
    }
  }, { text });
  themeControls.add(seg);
  return seg;
}

/* ============================================================
   dropdown (replaces the browser's <select> for sort and the bar's folder picker)
   ============================================================ */

const openDropdowns = new Set();
document.addEventListener('pointerdown', (e) => {
  for (const d of [...openDropdowns]) if (!d.el.contains(e.target)) d.close();
});

function dropdown({ groups, value = null, onChange, placeholder = '', ariaLabel = '', placement = 'bottom', className = '' }) {
  const root = h('div', { class: ('dd ' + className).trim() });
  const labelEl = h('span', { class: 'dd-label' });
  const trigger = h('button', {
    type: 'button', class: 'dd-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': ariaLabel || null,
  }, labelEl, icon('chevron', 14));
  const menu = h('div', { class: 'dd-menu', role: 'listbox', 'data-placement': placement });
  root.append(trigger, menu);

  let data = groups;
  let current = value;

  const optionEls = () => [...menu.querySelectorAll('.dd-opt')];

  function build() {
    menu.replaceChildren(...data.flatMap((g) => [
      g.label ? h('div', { class: 'dd-group' }, g.label) : null,
      ...g.options.map((o) => h('button', {
        type: 'button', role: 'option', class: 'dd-opt' + (o.value === current ? ' sel' : ''),
        'aria-selected': String(o.value === current),
        onclick: () => choose(o.value),
      }, icon('check', 14), o.label)),
    ]).filter(Boolean));
    const all = data.flatMap((g) => g.options);
    const match = all.find((o) => o.value === current);
    labelEl.textContent = match ? match.label : placeholder;
  }

  function choose(v) {
    close(true);
    if (placeholder) { onChange(v); return; }   // action-style menu: nothing stays selected
    if (v === current) return;
    current = v;
    build();
    onChange(v);
  }

  function open() {
    for (const d of [...openDropdowns]) if (d !== api) d.close();
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    openDropdowns.add(api);
    (menu.querySelector('.dd-opt.sel') || menu.querySelector('.dd-opt'))?.focus({ preventScroll: true });
  }

  function close(refocus = false) {
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    openDropdowns.delete(api);
    if (refocus) trigger.focus();
  }

  trigger.addEventListener('click', () => (root.classList.contains('open') ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', (e) => {
    const opts = optionEls();
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(opts.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(0, i - 1)]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); opts[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close();
  });

  const api = {
    el: root,
    open,
    close,
    setValue(v) { current = v; build(); },
    setGroups(g) { data = g; build(); },
  };
  build();
  return api;
}

/* ============================================================
   toolbar: view toggle, sort, empty-trash
   ============================================================ */

const viewSeg = segmented(
  [
    { value: 'gallery', label: 'Gallery', icon: 'all' },
    { value: 'list', label: 'List', icon: 'list' },
  ],
  prefs.view,
  (v) => { viewSeg.set(v); setPrefs({ view: v }); },
);

const sortDD = dropdown({
  ariaLabel: 'Sort bookmarks',
  value: prefs.sort,
  groups: [
    { label: 'Date created', options: [{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }] },
    { label: 'Name', options: [{ value: 'name-asc', label: 'Name A–Z' }, { value: 'name-desc', label: 'Name Z–A' }] },
  ],
  onChange: (v) => { armFlip(); setPrefs({ sort: v }); },
});

const emptyTrashBtn = h('button', {
  class: 'ghost bordered danger-text',
  onclick: async () => {
    const n = state.bookmarks.filter((b) => b.deletedAt).length;
    if (!n || !confirm(`Permanently delete ${plural(n, 'bookmark')} in Trash? This can’t be undone.`)) return;
    await emptyTrash();
    toast('Trash emptied');
  },
}, 'Empty trash');

const addBtn = h('button', { class: 'primary', onclick: () => openAddLink() }, icon('plus', 15), 'Add link');

function syncTools() {
  const [view] = route();
  const isList = !['settings', 'tags', 'guide'].includes(view);
  viewSeg.style.display = isList ? '' : 'none';
  sortDD.el.style.display = isList ? '' : 'none';
  addBtn.style.display = isList ? '' : 'none';
  emptyTrashBtn.style.display = view === 'trash' && state.bookmarks.some((b) => b.deletedAt) ? '' : 'none';
  $('#searchbox').style.display = ['settings', 'guide'].includes(view) ? 'none' : '';
  searchEl.placeholder = view === 'tags' ? 'Search tags' : 'Search bookmarks';
  viewSeg.set(prefs.view);
  sortDD.setValue(prefs.sort);
}

/* ============================================================
   boot + render
   ============================================================ */

async function refresh() {
  state = await loadState();
  prefs = getPrefs(state);
  const ids = new Set(state.bookmarks.map((b) => b.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  if (focusedId && !ids.has(focusedId)) focusedId = null;
  render();
}

function render() {
  hideTip();
  renderSidebar();
  renderContent();
  syncTools();
  syncBar();
  updateSelectionUI();
  lastPinned = null;
}

function scrollGuide() {
  const [view, arg] = route();
  if (view !== 'guide' || !arg) return;
  requestAnimationFrame(() => document.getElementById('g-' + arg)?.scrollIntoView({ block: 'start' }));
}

window.addEventListener('hashchange', () => {
  selected.clear();
  focusedId = null;
  window.scrollTo(0, 0);
  render();
  scrollGuide();
});
store.onChange((changes) => {
  const keys = Object.keys(changes);
  if (keys.every((k) => k === 'sync')) { onSyncStatus(); return; }
  refresh();
  if (!isExtension && keys.some((k) => SYNC_TRIGGER_KEYS.has(k))) scheduleSync(); // the extension's background worker does this itself
});
searchEl.addEventListener('input', () => {
  focusedId = null;
  renderContent();
  updateSelectionUI();
});

/* ============================================================
   sidebar
   ============================================================ */

function renderSidebar() {
  const [view, arg] = route();
  const sb = { ...prefs.sidebar, all: true };
  const active = state.bookmarks.filter(isActive);
  const byType = {};
  for (const b of active) byType[b.type] = (byType[b.type] || 0) + 1;
  const archivedCount = state.bookmarks.filter((b) => b.archivedAt && !b.deletedAt).length;
  const trashCount = state.bookmarks.filter((b) => b.deletedAt).length;
  const counts = tagCounts();

  const link = (href, lead, label, count, isActiveItem, extra = '') =>
    h('a', { class: 'nav' + (isActiveItem ? ' active' : '') + (extra ? ' ' + extra : ''), href },
      lead, h('span', { class: 'label' }, label), count ? h('span', { class: 'count' }, count) : null);

  const items = [];
  items.push(link('#/all', icon('all'), 'All bookmarks', active.length, view === 'all'));
  for (const t of TYPE_ORDER) {
    if (sb[t]) items.push(link('#/type/' + t, icon(t), TYPE_LABEL[t], byType[t] || 0, view === 'type' && arg === t));
  }
  if (sb.archived) items.push(link('#/archived', icon('archive'), 'Archived', archivedCount, view === 'archived'));
  if (sb.trash) items.push(link('#/trash', icon('trash'), 'Trash', trashCount, view === 'trash'));

  const folders = [];
  if (sb.folders) {
    folders.push(
      h('div', { class: 'group-title' }, 'Folders',
        h('button', { class: 'icon', 'data-tip': 'New folder', 'aria-label': 'New folder', onclick: () => editFolder() }, icon('plus', 15))),
      state.folders.length
        ? state.folders.map((f) => link(
          '#/folder/' + f.id, icon(isManual(f) ? 'folder' : 'smart'), f.name,
          active.filter((b) => folderIdsFor(b).has(f.id)).length,
          view === 'folder' && arg === f.id))
        : h('div', { class: 'muted small', style: 'padding: 2px 10px' }, 'Group links by hand or by rule'),
    );
  }

  const tags = [];
  if (sb.tags) {
    tags.push(h('div', { class: 'group-title' }, 'Tags',
      h('a', { href: '#/tags', class: view === 'tags' ? 'on' : '' }, 'All tags')));
    if (state.pinnedTags.length) {
      for (const name of state.pinnedTags) {
        const c = counts.get(lower(name));
        tags.push(link(
          '#/tag/' + encodeURIComponent(name),
          h('span', { class: 'dot', style: `--h:${tagHue(name)}` }),
          name, c ? c.count : 0,
          view === 'tag' && lower(arg) === lower(name),
          lastPinned && lower(lastPinned) === lower(name) ? 'enter' : ''));
      }
    } else {
      tags.push(h('a', { class: 'hintlink', href: '#/tags' }, 'Pin tags from the Tags page'));
    }
  }

  $('#sidebar').replaceChildren(...[
    h('div', { class: 'brand' }, h('span', { class: 'mark' }, icon('bookmark', 14)), 'Tagmark'),
    items,
    folders,
    tags,
    h('div', { class: 'spacer' }),
    h('div', { class: 'sidefoot' },
      link('#/guide', icon('book'), 'Guide', null, view === 'guide'),
      link('#/settings', icon('settings'), 'Settings', null, view === 'settings'),
      h('button', { class: 'nav', onclick: openShortcuts },
        icon('keyboard'), h('span', { class: 'label' }, 'Shortcuts'), h('kbd', {}, '?')),
      themeSeg(false)),
  ].flat(2).filter(Boolean));
}

/* ============================================================
   content
   ============================================================ */

function filtered() {
  const [view, arg] = route();
  let list;
  if (view === 'trash') list = state.bookmarks.filter((b) => b.deletedAt);
  else if (view === 'archived') list = state.bookmarks.filter((b) => b.archivedAt && !b.deletedAt);
  else list = state.bookmarks.filter(isActive);

  if (view === 'type') list = list.filter((b) => b.type === arg);
  if (view === 'tag') list = list.filter((b) => tagsOf(b).some((t) => lower(t) === lower(arg)));
  if (view === 'folder') list = list.filter((b) => folderIdsFor(b).has(arg));

  const q = searchEl.value.trim().toLowerCase();
  if (q) {
    list = list.filter((b) =>
      `${b.title} ${b.url} ${b.description} ${tagsOf(b).join(' ')}`.toLowerCase().includes(q));
  }
  return [...list].sort(SORTS[prefs.sort] || SORTS.newest);
}

function renderContent() {
  const [view, arg] = route();
  const content = $('#content');
  const heading = $('#heading');
  cardEls.clear();

  if (view === 'settings') {
    visible = [];
    heading.replaceChildren('Settings');
    if (performance.now() < quietUntil && content.querySelector('.settings')) return; // keep switches mid-animation
    content.replaceChildren(settingsView());
    return;
  }

  if (view === 'guide') {
    visible = [];
    heading.replaceChildren('Guide');
    content.replaceChildren(renderGuide());
    return;
  }

  if (view === 'tags') {
    visible = [];
    const page = tagsView();
    heading.replaceChildren('Tags', page.total ? h('span', { class: 'n' }, page.total) : null);
    content.replaceChildren(page.el);
    return;
  }

  const title =
    view === 'type' ? (TYPE_LABEL[arg] || arg)
      : view === 'tag' ? arg
        : view === 'folder' ? (state.folders.find((f) => f.id === arg)?.name || 'Folder')
          : view === 'archived' ? 'Archived'
            : view === 'trash' ? 'Trash'
              : 'All bookmarks';

  visible = filtered();
  heading.replaceChildren(title, state.bookmarks.length ? h('span', { class: 'n' }, visible.length) : null);

  if (!visible.length) {
    content.replaceChildren(emptyState(view, arg));
    return;
  }

  const mode = prefs.view;
  const intro = introPlayed ? '' : ' intro';
  const container = mode === 'list'
    ? h('div', { class: 'rows' + intro }, visible.map(row))
    : h('div', { class: 'grid' + intro }, visible.map(card));
  introPlayed = true;
  content.replaceChildren(container);

  if (lastMode && lastMode !== mode && !reduced.matches) {
    container.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE });
  }
  lastMode = mode;
  playFlip();
}

function placeholder(host) {
  return h('span', { class: 'ph', style: `--h:${tagHue(host)}` }, (host[0] || '?').toUpperCase());
}

function chips(b, max) {
  const tags = tagsOf(b);
  const out = tags.slice(0, max).map((t) => h('a', {
    class: 'chip', style: `--h:${tagHue(t)}`, href: '#/tag/' + encodeURIComponent(t),
  }, t));
  if (tags.length > max) out.push(h('span', { class: 'chip more' }, `+${tags.length - max}`));
  return out;
}

function pickButton(b) {
  return h('button', {
    class: 'pick', 'data-tip': 'Select', 'data-key': 'x', 'aria-label': 'Select bookmark',
    onclick: (e) => { e.stopPropagation(); toggleSelect(b.id, e.shiftKey); },
  }, icon('check', 14));
}

function favicon(b, host) {
  const letter = () => h('span', { class: 'fav' }, (host[0] || '?').toUpperCase());
  return b.favicon
    ? h('img', { src: b.favicon, referrerpolicy: 'no-referrer', alt: '', onerror: (e) => e.target.replaceWith(letter()) })
    : letter();
}

function image(b, host, cls) {
  return b.image
    ? h('img', {
      class: cls, src: b.image, loading: 'lazy', referrerpolicy: 'no-referrer', alt: '',
      onerror: (e) => e.target.replaceWith(placeholder(host)),
    })
    : placeholder(host);
}

/* ---------- gallery card: fixed thumbnail ratio, fixed text rows ---------- */
function card(b, i) {
  const host = hostOf(b.url);
  const typeIcon = icon(b.type, 14);
  typeIcon.dataset.tip = singular(b.type);

  const el = h('article', {
    class: 'item card', style: `--i:${Math.min(i, 12)}`,
    onclick: (e) => onItemClick(e, b),
  },
  pickButton(b),
  h('a', { class: 'thumb', href: b.url, target: '_blank', rel: 'noopener', tabindex: '-1' }, image(b, host)),
  h('div', { class: 'body' },
    h('div', { class: 'src', 'data-tip': `Saved ${fmtDate(b.savedAt)}` }, favicon(b, host), h('span', { class: 'host' }, host), typeIcon),
    h('a', { class: 'title', href: b.url, target: '_blank', rel: 'noopener' }, b.title),
    h('div', { class: 'tags' }, chips(b, 3))));

  cardEls.set(b.id, el);
  return el;
}

/* ---------- list row ---------- */
function row(b, i) {
  const host = hostOf(b.url);
  const typeIcon = icon(b.type, 13);
  typeIcon.dataset.tip = singular(b.type);

  const el = h('article', {
    class: 'item rowi', style: `--i:${Math.min(i, 12)}`,
    onclick: (e) => onItemClick(e, b),
  },
  pickButton(b),
  h('a', { class: 'rthumb', href: b.url, target: '_blank', rel: 'noopener', tabindex: '-1' }, image(b, host)),
  h('div', { class: 'rmain' },
    h('a', { class: 'title', href: b.url, target: '_blank', rel: 'noopener' }, b.title),
    h('div', { class: 'src' }, favicon(b, host), h('span', { class: 'host' }, host), typeIcon)),
  h('div', { class: 'tags' }, chips(b, 4)),
  h('span', { class: 'when' }, fmtDate(b.savedAt)));

  cardEls.set(b.id, el);
  return el;
}

function onItemClick(e, b) {
  if (e.target.closest('.pick')) return;
  // While selecting (or with a modifier), a click toggles selection instead of opening.
  if (selected.size || e.metaKey || e.ctrlKey || e.shiftKey) {
    e.preventDefault();
    toggleSelect(b.id, e.shiftKey);
  }
}

/* ---------- tags page ---------- */
function tagsView() {
  const q = searchEl.value.trim().toLowerCase();
  const map = tagCounts();
  for (const p of state.pinnedTags) {
    if (!map.has(lower(p))) map.set(lower(p), { name: p, count: 0 });
  }
  const pinIndex = (name) => state.pinnedTags.findIndex((t) => lower(t) === lower(name));
  let list = [...map.values()];
  const total = list.length;
  if (q) list = list.filter((t) => lower(t.name).includes(q));
  list.sort((a, b) => {
    const pa = pinIndex(a.name);
    const pb = pinIndex(b.name);
    if (pa >= 0 && pb >= 0) return pa - pb;
    if (pa >= 0) return -1;
    if (pb >= 0) return 1;
    return b.count - a.count || a.name.localeCompare(b.name);
  });

  if (!list.length) {
    return {
      total,
      el: h('div', { class: 'empty' },
        h('h2', {}, q ? `No tags match “${q}”` : 'No tags yet'),
        h('p', {}, q ? 'Try a shorter word.' : 'Tags appear here as you save bookmarks. Pin the ones you use most to keep them in the sidebar.')),
    };
  }

  return {
    total,
    el: h('div', { class: 'tagpage' }, list.map((t) => {
      const pinned = isPinned(t.name);
      return h('div', { class: 'tagitem' },
        h('a', { class: 'taglink', href: '#/tag/' + encodeURIComponent(t.name) },
          h('span', { class: 'dot', style: `--h:${tagHue(t.name)}` }),
          h('span', { class: 'tname' }, t.name),
          h('span', { class: 'count' }, t.count)),
        h('button', {
          class: 'pinbtn' + (pinned ? ' on' : '') + (lastPinned && lower(lastPinned) === lower(t.name) ? ' pop' : ''),
          'data-tip': pinned ? 'Unpin from sidebar' : 'Pin to sidebar',
          'aria-label': pinned ? `Unpin ${t.name}` : `Pin ${t.name}`,
          'aria-pressed': String(pinned),
          onclick: async () => {
            if (!pinned) lastPinned = t.name;
            await togglePinnedTag(t.name);
          },
        }, icon('pin', 16)));
    })),
  };
}

/* ---------- empty states ---------- */
function emptyState(view, arg) {
  const q = searchEl.value.trim();

  if (q) {
    return h('div', { class: 'empty' },
      h('h2', {}, `No results for “${q}”`),
      h('p', {}, 'Try another word, or search by a tag or a domain.'),
      h('button', { class: 'ghost bordered', onclick: () => { searchEl.value = ''; renderContent(); updateSelectionUI(); } }, 'Clear search'));
  }

  if (view === 'trash') {
    return h('div', { class: 'empty' },
      h('h2', {}, 'Trash is empty'),
      h('p', {}, 'Bookmarks you delete wait here until you empty the trash, so nothing is lost by accident.'));
  }

  if (view === 'archived') {
    return h('div', { class: 'empty' },
      h('h2', {}, 'Nothing archived'),
      h('p', {}, 'Archive bookmarks you want to keep without seeing them every day. Select one and press E.'),
      h('button', { class: 'ghost bordered', onclick: () => { location.hash = '#/all'; } }, 'Back to all bookmarks'));
  }

  if (!state.bookmarks.length && !isExtension) {
    const needsSignIn = isConfigured() && !state.sync?.session;
    return h('div', { class: 'empty' },
      h('div', { class: 'stack' }, h('i'), h('i'), h('i', {}, icon('bookmark', 30))),
      h('h2', {}, needsSignIn ? 'Sign in to load your bookmarks' : 'Your library is empty'),
      h('p', {}, needsSignIn
        ? 'Bookmarks saved by the Tagmark extension sync to your account and show up here.'
        : 'Paste a link to save it, or install the Tagmark extension to save pages in one click.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        needsSignIn ? h('button', { class: 'primary', onclick: () => { location.hash = '#/settings'; } }, 'Sign in') : null,
        h('button', { class: needsSignIn ? 'ghost bordered' : 'primary', onclick: () => openAddLink() }, 'Add a link')));
  }

  if (!state.bookmarks.length) {
    return h('div', { class: 'empty' },
      h('div', { class: 'stack' }, h('i'), h('i'), h('i', {}, icon('bookmark', 30))),
      h('h2', {}, 'Save your first page'),
      h('p', {}, 'Tagmark tags and files everything for you.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open any page you want to keep.'),
        h('li', {}, 'Click the Tagmark icon in the toolbar.'),
        h('li', {}, 'It’s tagged and sorted instantly. Adjust tags right in the popup.')),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('button', { class: 'primary', onclick: () => { location.hash = '#/settings'; } }, 'Set up your rules'),
        h('button', { class: 'ghost bordered', onclick: () => { location.hash = '#/guide'; } }, 'Read the guide')),
      h('p', { class: 'hint' }, 'Press ', h('kbd', {}, '?'), ' any time for keyboard shortcuts.'));
  }

  if (view === 'folder') {
    const f = state.folders.find((x) => x.id === arg);
    return h('div', { class: 'empty' },
      h('h2', {}, 'This folder is empty'),
      h('p', {}, f && !isManual(f)
        ? 'Nothing matches this folder’s rules yet. You can change the rules in Settings.'
        : 'Select bookmarks in the library, then choose Move to… in the bar at the bottom.'),
      h('button', { class: 'ghost bordered', onclick: () => { location.hash = '#/all'; } }, 'Back to all bookmarks'));
  }

  return h('div', { class: 'empty' },
    h('h2', {}, 'Nothing here yet'),
    h('p', {}, 'Bookmarks that match this view will show up here.'),
    h('button', { class: 'ghost bordered', onclick: () => { location.hash = '#/all'; } }, 'Back to all bookmarks'));
}

/* ============================================================
   selection + bulk bar
   ============================================================ */

const barCount = h('span', { class: 'count' });
const barTag = h('input', {
  placeholder: 'Add tag…', 'aria-label': 'Add tag to selected',
  onkeydown: async (e) => {
    if (e.key === 'Escape') { barTag.blur(); return; }
    if (e.key !== 'Enter' || !barTag.value.trim()) return;
    e.preventDefault();
    const tag = barTag.value.trim();
    const ids = [...selected];
    barTag.value = '';
    await bulkAddTag(ids, tag);
    toast(`Added “${tag}” to ${plural(ids.length, 'bookmark')}`);
  },
});
const folderDD = dropdown({
  ariaLabel: 'Move selected to folder',
  placeholder: 'Move to…',
  placement: 'top',
  className: 'dd-bar',
  groups: [],
  onChange: async (v) => {
    const ids = [...selected];
    await bulkSetFolder(ids, v === '__none' ? '' : v);
    const name = state.folders.find((f) => f.id === v)?.name;
    toast(v === '__none' ? `Removed ${plural(ids.length, 'bookmark')} from folders` : `Moved ${plural(ids.length, 'bookmark')} to ${name}`);
  },
});
const archiveLabel = h('span', {}, 'Archive');
const archiveBtn = h('button', { onclick: () => archiveIds([...selected], route()[0] !== 'archived') }, icon('archive', 15), archiveLabel);
const trashBtn = h('button', { onclick: () => trashIds([...selected]) }, icon('trash', 15), 'Trash');
const restoreBtn = h('button', { onclick: () => restoreIds([...selected]) }, icon('restore', 15), 'Restore');
const foreverBtn = h('button', { class: 'danger', onclick: () => deleteForever([...selected]) }, icon('trash', 15), 'Delete forever');
const clearBtn = h('button', { 'data-tip': 'Clear selection', 'data-key': 'Esc', 'aria-label': 'Clear selection', onclick: () => clearSelection() }, icon('x', 15));

function buildBar() {
  $('#bar').replaceChildren(barCount, barTag, folderDD.el, archiveBtn, trashBtn, restoreBtn, foreverBtn, clearBtn);
}

/** Show the bar parts that make sense for the current view (Trash gets Restore / Delete forever). */
function syncBar() {
  const view = route()[0];
  const inTrash = view === 'trash';
  const manual = (state?.folders || []).filter(isManual);
  const show = (el, on) => { el.style.display = on ? '' : 'none'; };

  folderDD.setGroups([{
    options: [
      ...manual.map((f) => ({ value: f.id, label: f.name })),
      ...(manual.length ? [{ value: '__none', label: 'Remove from folder' }] : []),
    ],
  }]);

  show(barTag, !inTrash);
  show(folderDD.el, !inTrash && manual.length > 0);
  show(archiveBtn, !inTrash);
  show(trashBtn, !inTrash);
  show(restoreBtn, inTrash);
  show(foreverBtn, inTrash);
  archiveLabel.textContent = view === 'archived' ? 'Unarchive' : 'Archive';
}

function toggleSelect(id, range = false) {
  if (range && lastPickId && visible.some((b) => b.id === lastPickId)) {
    const ids = visible.map((b) => b.id);
    const [from, to] = [ids.indexOf(lastPickId), ids.indexOf(id)].sort((a, b) => a - b);
    ids.slice(from, to + 1).forEach((x) => selected.add(x));
  } else if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  lastPickId = id;
  focusedId = id;
  updateSelectionUI();
}

function clearSelection() {
  selected.clear();
  updateSelectionUI();
}

function updateSelectionUI() {
  document.body.classList.toggle('selecting', selected.size > 0);
  for (const [id, el] of cardEls) {
    el.classList.toggle('selected', selected.has(id));
    el.classList.toggle('focused', id === focusedId);
    el.querySelector('.pick')?.setAttribute('aria-pressed', String(selected.has(id)));
  }
  const bar = $('#bar');
  bar.classList.toggle('show', selected.size > 0);
  bar.inert = selected.size === 0;
  if (selected.size) barCount.textContent = `${selected.size} selected`;
}

/* ---------- archive / trash actions (keyboard passes { keyboard: true } to skip motion) ---------- */

async function trashIds(ids, { keyboard = false, nextFocus = null } = {}) {
  if (!ids.length) return;
  focusedId = nextFocus;
  await runWithMotion(ids, () => trashBookmarks(ids), !keyboard);
  toast(`Moved ${plural(ids.length, 'bookmark')} to Trash`, { action: 'Undo', onAction: () => untrashBookmarks(ids) });
}

async function archiveIds(ids, on, { keyboard = false, nextFocus = null } = {}) {
  if (!ids.length) return;
  focusedId = nextFocus;
  await runWithMotion(ids, () => archiveBookmarks(ids, on), !keyboard);
  toast(on ? `Archived ${plural(ids.length, 'bookmark')}` : `Moved ${plural(ids.length, 'bookmark')} back to the library`,
    { action: 'Undo', onAction: () => archiveBookmarks(ids, !on) });
}

async function restoreIds(ids, { keyboard = false, nextFocus = null } = {}) {
  if (!ids.length) return;
  focusedId = nextFocus;
  await runWithMotion(ids, () => untrashBookmarks(ids), !keyboard);
  toast(`Restored ${plural(ids.length, 'bookmark')}`, { action: 'Undo', onAction: () => trashBookmarks(ids) });
}

async function deleteForever(ids, { keyboard = false, nextFocus = null } = {}) {
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${plural(ids.length, 'bookmark')}? This can’t be undone.`)) return;
  focusedId = nextFocus;
  await runWithMotion(ids, () => deleteBookmarks(ids), !keyboard);
  toast(`Deleted ${plural(ids.length, 'bookmark')} permanently`);
}

/* ============================================================
   keyboard
   ============================================================ */

const columns = () => {
  if (prefs.view === 'list') return 1;
  const grid = $('.grid');
  return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
};

function setFocus(id) {
  focusedId = id;
  updateSelectionUI();
  cardEls.get(id)?.scrollIntoView({ block: 'nearest' });
}

function moveFocus(delta) {
  if (!visible.length) return;
  const ids = visible.map((b) => b.id);
  let i = focusedId ? ids.indexOf(focusedId) : -1;
  i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta));
  setFocus(ids[i]);
}

/** Ids a keyboard action applies to: the selection, else the highlighted item. */
function targets() {
  if (selected.size) return { ids: [...selected], nextFocus: null };
  if (!focusedId) return { ids: [], nextFocus: null };
  const ids = visible.map((b) => b.id);
  const i = ids.indexOf(focusedId);
  return { ids: [focusedId], nextFocus: ids[i + 1] || ids[i - 1] || null };
}

function onKey(e) {
  const t = e.target;
  const mod = e.metaKey || e.ctrlKey;
  const typing = t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable);
  const view = route()[0];

  if (mod && e.key.toLowerCase() === 'k') {
    if (view === 'settings') return;
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if (t instanceof HTMLElement && t.closest('.dd')) return; // dropdowns handle their own keys
  if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys

  if (e.key === 'Escape') {
    if (t === searchEl && searchEl.value) {
      searchEl.value = '';
      renderContent();
      updateSelectionUI();
    } else if (typing) t.blur();
    else if (selected.size) clearSelection();
    else if (focusedId) setFocus(null);
    return;
  }

  if (t === searchEl) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      searchEl.blur();
      if (visible[0]) setFocus(visible[0].id);
    }
    return;
  }
  if (typing || e.altKey) return;

  if (mod && e.key.toLowerCase() === 'a') {
    if (!visible.length) return;
    e.preventDefault();
    visible.forEach((b) => selected.add(b.id));
    updateSelectionUI();
    return;
  }
  if (mod) return;

  switch (e.key) {
    case '/':
      if (view === 'settings') return;
      e.preventDefault();
      searchEl.focus();
      break;
    case '?':
      openShortcuts();
      break;
    case 'j': case 'ArrowRight':
      e.preventDefault(); moveFocus(1); break;
    case 'k': case 'ArrowLeft':
      e.preventDefault(); moveFocus(-1); break;
    case 'ArrowDown':
      e.preventDefault(); moveFocus(columns()); break;
    case 'ArrowUp':
      e.preventDefault(); moveFocus(-columns()); break;
    case 'Enter': case 'o': {
      const b = visible.find((x) => x.id === focusedId);
      if (b) { e.preventDefault(); openUrl(b.url); }
      break;
    }
    case 'x': case ' ':
      if (focusedId) { e.preventDefault(); toggleSelect(focusedId, e.shiftKey); }
      break;
    case 't':
      if (selected.size && view !== 'trash') { e.preventDefault(); barTag.focus(); }
      break;
    case 'e': {
      if (view === 'trash') break;
      const { ids, nextFocus } = targets();
      if (ids.length) { e.preventDefault(); archiveIds(ids, view !== 'archived', { keyboard: true, nextFocus }); }
      break;
    }
    case 'r': {
      if (view !== 'trash') break;
      const { ids, nextFocus } = targets();
      if (ids.length) { e.preventDefault(); restoreIds(ids, { keyboard: true, nextFocus }); }
      break;
    }
    case 'Delete': case 'Backspace': {
      const { ids, nextFocus } = targets();
      if (!ids.length) break;
      e.preventDefault();
      if (view === 'trash') deleteForever(ids, { keyboard: true, nextFocus });
      else trashIds(ids, { keyboard: true, nextFocus });
      break;
    }
    default:
  }
}

function openShortcuts() {
  const dlg = $('#shortcuts');
  const rowOf = (label, ...keys) => [h('dt', {}, label), h('dd', {}, keys.map((k) => h('kbd', {}, k)))];
  dlg.replaceChildren(h('div', { class: 'form' },
    h('h3', {}, 'Keyboard shortcuts'),
    h('dl', { class: 'keys' },
      rowOf('Search', '/'),
      rowOf('Move between bookmarks', '←', '→', '↑', '↓'),
      rowOf('Move with the left hand', 'j', 'k'),
      rowOf('Open the highlighted bookmark', 'Enter'),
      rowOf('Select or unselect', 'x'),
      rowOf('Select a range', 'Shift', 'click'),
      rowOf('Select everything shown', MOD, 'A'),
      rowOf('Add a tag to the selection', 't'),
      rowOf('Archive or unarchive', 'e'),
      rowOf('Move to Trash (you can undo)', 'Delete'),
      rowOf('Restore from Trash', 'r'),
      rowOf('Clear, close, or go back', 'Esc'),
      rowOf('Show this list', '?')),
    h('div', { class: 'row end' },
      h('button', { class: 'primary', onclick: () => dlg.close() }, 'Done'))));
  dlg.showModal();
}

/* ============================================================
   settings
   ============================================================ */

const SIDEBAR_ITEMS = [
  ['all', 'All bookmarks', 'all', 'Always shown'],
  ['archived', 'Archived', 'archive'],
  ['trash', 'Trash', 'trash'],
  ['post', 'Posts', 'post'],
  ['profile', 'Profiles', 'profile'],
  ['video', 'Videos', 'video'],
  ['article', 'Articles', 'article'],
  ['repo', 'Repos', 'repo'],
  ['link', 'Web links', 'link'],
  ['folders', 'Folders', 'folder'],
  ['tags', 'Pinned tags', 'tag'],
];

/** Settings switches write to storage; keep the page's DOM for a moment so the switch can animate. */
const quiet = () => { quietUntil = performance.now() + 600; };

function settingsView() {
  const disabled = new Set(state.disabledRules);
  const topics = state.topics || DEFAULT_TOPICS;

  const toggleBuiltin = async (id, on) => {
    quiet();
    const set = new Set(state.disabledRules);
    if (on) set.delete(id); else set.add(id);
    await patchState({ disabledRules: [...set] });
    await reclassifyAll();
  };
  const toggleUser = async (rule, on) => {
    quiet();
    rule.enabled = on;
    await patchState({ userRules: state.userRules });
    await reclassifyAll();
  };

  const group = (title, description, action, items, emptyText) =>
    h('section', { class: 'group' },
      h('div', { class: 'row-between' }, h('h2', {}, title), action),
      h('p', {}, description),
      items.length ? h('div', { class: 'list' }, items) : h('div', { class: 'none' }, emptyText || 'Nothing here yet.'));

  const sw = (checked, onchange, disabledSwitch = false) =>
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked, disabled: disabledSwitch, onchange: (e) => onchange(e.target.checked) }));

  return h('div', { class: 'settings' },
    h('p', { class: 'guide-hint' }, 'New to Tagmark? ', h('a', { href: '#/guide' }, 'Read the guide'), ' to see how rules, folders and topics work.'),

    group('Your rules',
      'Run after the built-in rules and topics, so they can match on a bookmark’s type and tags too.',
      h('button', { class: 'primary', onclick: () => editRule() }, 'New rule'),
      state.userRules.map((r) => h('div', { class: 'item-row' },
        sw(r.enabled !== false, (on) => toggleUser(r, on)),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'detail' }, `When ${summarize(r)}, add “${(r.actions || []).map((a) => a.value).join(', ')}”`)),
        h('button', { class: 'ghost', onclick: () => editRule(r) }, 'Edit'),
        h('button', { class: 'ghost', onclick: () => deleteRule(r) }, 'Delete'))),
      'No custom rules yet. Try: handle is a person you follow, then add their name as a tag.'),

    group('Folders',
      'A folder with conditions fills itself. A folder without conditions is manual.',
      h('button', { class: 'primary', onclick: () => editFolder() }, 'New folder'),
      state.folders.map((f) => h('div', { class: 'item-row' },
        icon(isManual(f) ? 'folder' : 'smart'),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, f.name),
          h('div', { class: 'detail' }, isManual(f) ? 'Manual' : `When ${summarize(f)}`)),
        h('button', { class: 'ghost', onclick: () => editFolder(f) }, 'Edit'),
        h('button', { class: 'ghost', onclick: () => deleteFolder(f) }, 'Delete'))),
      'No folders yet.'),

    group('Sidebar',
      'Choose what appears in the sidebar. Everything stays reachable from the Tags page and search.', null,
      SIDEBAR_ITEMS.map(([key, label, ic, note]) => h('div', { class: 'item-row' },
        sw(key === 'all' ? true : prefs.sidebar[key], (on) => { quiet(); setPrefs({ sidebar: { [key]: on } }); }, key === 'all'),
        icon(ic),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, label),
          note ? h('div', { class: 'detail' }, note) : null)))),

    group('Topics',
      'Automatic tags from keywords and domains. A topic applies when its score passes the threshold.',
      h('button', { class: 'primary', onclick: () => editTopic() }, 'New topic'),
      [
        ...topics.map((t) => h('div', { class: 'item-row' },
          sw(t.enabled !== false, (on) => toggleTopic(t, on)),
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, t.tag),
            h('div', { class: 'detail' },
              `${plural(Object.keys(t.keywords || {}).length, 'keyword')}, ${plural(Object.keys(t.domains || {}).length, 'domain')}, threshold ${t.threshold ?? 6}`)),
          h('button', { class: 'ghost', onclick: () => editTopic(t) }, 'Edit'),
          h('button', { class: 'ghost', onclick: () => deleteTopic(t) }, 'Delete'))),
        h('div', { class: 'item-row' },
          h('button', { class: 'ghost bordered', onclick: resetTopics }, 'Reset to defaults')),
      ]),

    group('Built-in rules',
      'These recognise X, LinkedIn, YouTube, GitHub and articles. Turn off any you don’t want.',
      null,
      DEFAULT_RULES.map((r) => h('div', { class: 'item-row' },
        sw(!disabled.has(r.id), (on) => toggleBuiltin(r.id, on)),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'detail' }, summarize(r)))))),

    group('Appearance',
      'Choose how Tagmark looks.', null,
      [h('div', { class: 'item-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, 'Theme'),
          h('div', { class: 'detail' }, 'System follows your device’s light or dark setting.')),
        themeSeg(true))]),

    syncGroup(),

    h('section', { class: 'group' },
      h('h2', {}, 'Data'),
      h('p', {}, 'Everything is stored in this browser. Export a backup now and then.'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', {
          class: 'ghost bordered',
          onclick: async () => { const n = await reclassifyAll(); toast(`Re-ran rules on ${plural(n, 'bookmark')}`); },
        }, 'Re-run rules on all'),
        h('button', { class: 'ghost bordered', onclick: downloadBackup }, 'Export JSON'),
        h('label', { class: 'ghost bordered filebtn' }, 'Import JSON',
          h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: importFile })))),
  );
}

async function downloadBackup() {
  const data = await exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', {
    href: URL.createObjectURL(blob),
    download: `tagmark-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded');
}

async function importFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const added = await importData(JSON.parse(await file.text()));
    toast(`Imported ${plural(added, 'new bookmark')}`);
  } catch {
    toast('That file couldn’t be read. Is it a Tagmark export?');
  }
}

/* ============================================================
   rule + folder editing
   ============================================================ */

function editRule(rule) {
  openEditor({
    title: rule ? 'Edit rule' : 'New rule',
    name: rule?.name || '',
    match: rule?.match || 'all',
    conditions: rule?.conditions || [{ field: 'url', op: 'contains', value: '' }],
    tag: rule?.actions?.[0]?.value || '',
    withTag: true,
    onSave: async ({ name, match, conditions, tag }) => {
      const next = {
        id: rule?.id || uid(), name, enabled: rule?.enabled !== false, builtin: false,
        stage: 'user', match, conditions, actions: [{ type: 'addTag', value: tag }],
      };
      const rules = rule
        ? state.userRules.map((r) => (r.id === rule.id ? next : r))
        : [...state.userRules, next];
      await patchState({ userRules: rules });
      await reclassifyAll();
    },
  });
}

async function deleteRule(rule) {
  await patchState({ userRules: state.userRules.filter((r) => r.id !== rule.id) });
  await reclassifyAll();
}

function editFolder(folder) {
  openEditor({
    title: folder ? 'Edit folder' : 'New folder',
    name: folder?.name || '',
    match: folder?.match || 'all',
    conditions: folder?.conditions || [],
    withTag: false,
    allowEmpty: true,
    onSave: async ({ name, match, conditions }) => {
      const next = { id: folder?.id || uid(), name, match, conditions };
      const folders = folder
        ? state.folders.map((f) => (f.id === folder.id ? next : f))
        : [...state.folders, next];
      await patchState({ folders });
    },
  });
}

async function deleteFolder(folder) {
  state.bookmarks.forEach((b) => { b.folderIds = (b.folderIds || []).filter((id) => id !== folder.id); });
  await patchState({
    folders: state.folders.filter((f) => f.id !== folder.id),
    bookmarks: state.bookmarks,
  });
}

/* ---------- editor dialog ---------- */

function conditionsEditor(initial) {
  const rows = h('div', { class: 'conds' });

  const addRow = (c = { field: 'url', op: 'contains', value: '' }) => {
    const field = h('select', {}, FIELDS.map((f) => h('option', { value: f, selected: f === c.field }, f)));
    const op = h('select', {}, OPS.map(([v, l]) => h('option', { value: v, selected: v === c.op }, l)));
    const value = h('input', {
      placeholder: 'value',
      value: Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? ''),
    });
    const sync = () => {
      value.style.display = ['isEmpty', 'notEmpty'].includes(op.value) ? 'none' : '';
    };
    op.addEventListener('change', sync);
    sync();

    const rowEl = h('div', { class: 'cond' }, field, op, value,
      h('button', { class: 'icon', type: 'button', 'data-tip': 'Remove condition', 'aria-label': 'Remove condition', onclick: () => rowEl.remove() }, icon('x', 15)));
    rowEl._get = () => ({
      field: field.value,
      op: op.value,
      value: op.value === 'in'
        ? value.value.split(',').map((s) => s.trim()).filter(Boolean)
        : value.value.trim(),
    });
    rows.append(rowEl);
  };

  initial.filter((c) => !c.conditions).forEach(addRow);

  return {
    el: h('div', {}, rows,
      h('button', { class: 'ghost bordered', type: 'button', onclick: () => addRow() }, 'Add condition')),
    get: () => [...rows.children]
      .map((r) => r._get())
      .filter((c) => ['isEmpty', 'notEmpty'].includes(c.op) || (Array.isArray(c.value) ? c.value.length : c.value !== '')),
  };
}

function openEditor({ title, name, match, conditions, tag = '', withTag, allowEmpty = false, onSave }) {
  const dlg = $('#editor');
  const nameIn = h('input', { value: name, placeholder: 'Name' });
  const tagIn = withTag ? h('input', { value: tag, placeholder: 'Tag to add, e.g. Inspiration' }) : null;
  const matchSel = h('select', {},
    h('option', { value: 'all', selected: match === 'all' }, 'All conditions match'),
    h('option', { value: 'any', selected: match === 'any' }, 'Any condition matches'));
  const cond = conditionsEditor(conditions);
  const error = h('div', { class: 'error small' });

  dlg.replaceChildren(h('div', { class: 'form' },
    h('h3', {}, title),
    h('label', {}, 'Name', nameIn),
    h('label', {}, 'When', matchSel),
    cond.el,
    withTag ? h('label', {}, 'Then add tag', tagIn) : null,
    error,
    h('div', { class: 'row end' },
      h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', {
        class: 'primary', type: 'button',
        onclick: async () => {
          const conditionsOut = cond.get();
          if (!nameIn.value.trim()) return (error.textContent = 'Give it a name.');
          if (!allowEmpty && !conditionsOut.length) return (error.textContent = 'Add at least one condition.');
          if (withTag && !tagIn.value.trim()) return (error.textContent = 'Choose a tag to add.');
          await onSave({
            name: nameIn.value.trim(),
            match: matchSel.value,
            conditions: conditionsOut,
            tag: tagIn?.value.trim(),
          });
          dlg.close();
        },
      }, 'Save')),
  ));
  dlg.showModal();
}

/* ============================================================
   topic editing
   ============================================================ */

const saveTopics = async (topics) => {
  await patchState({ topics });
  await reclassifyAll();
};
const cloneTopics = () => structuredClone(state.topics || DEFAULT_TOPICS);

async function toggleTopic(topic, on) {
  quiet();
  const topics = cloneTopics();
  const t = topics.find((x) => x.id === topic.id);
  if (t) t.enabled = on;
  await saveTopics(topics);
}
async function deleteTopic(topic) {
  await saveTopics(cloneTopics().filter((t) => t.id !== topic.id));
}
async function resetTopics() {
  if (!confirm('Replace all topics with the defaults? Your changes to topics will be lost.')) return;
  await patchState({ topics: null });
  await reclassifyAll();
  toast('Topics reset to defaults');
}

const weightsText = (obj) =>
  Object.entries(obj || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

function parseWeights(text, fallback) {
  const out = {};
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)\s*[:=]\s*([\d.]+)$/);
    const key = (m ? m[1] : s).trim().toLowerCase();
    const weight = m ? parseFloat(m[2]) : fallback;
    if (key && Number.isFinite(weight)) out[key] = weight;
  }
  return out;
}

function editTopic(topic) {
  const dlg = $('#editor');
  const tagIn = h('input', { value: topic?.tag || '', placeholder: 'Tag, e.g. Design' });
  const thrIn = h('input', { type: 'number', min: '1', step: '0.5', value: String(topic?.threshold ?? 6) });
  const kwIn = h('textarea', { rows: '9', placeholder: 'figma: 3\ntypography: 3\nwireframe: 2' }, weightsText(topic?.keywords));
  const domIn = h('textarea', { rows: '4', placeholder: 'dribbble.com: 6' }, weightsText(topic?.domains));
  const error = h('div', { class: 'error small' });

  dlg.replaceChildren(h('div', { class: 'form' },
    h('h3', {}, topic ? 'Edit topic' : 'New topic'),
    h('label', {}, 'Tag', tagIn),
    h('label', {}, 'Threshold (score needed to apply the tag)', thrIn),
    h('label', {}, 'Keywords, one per line as “word: weight”', kwIn),
    h('label', {}, 'Domains, one per line as “domain.com: weight”', domIn),
    h('p', { class: 'muted small', style: 'margin:0' },
      'Keyword weights run 0.5–3 and domain weights 4–6. A match in the title counts ×3, description ×2, headings ×1.5, page text ×1 (up to 3 hits per word). Raise the threshold if the tag shows up too often, lower it if it’s missing.'),
    error,
    h('div', { class: 'row end' },
      h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', {
        class: 'primary', type: 'button',
        onclick: async () => {
          const tag = tagIn.value.trim();
          if (!tag) return (error.textContent = 'Give the topic a tag name.');
          const threshold = parseFloat(thrIn.value);
          if (!Number.isFinite(threshold) || threshold <= 0) return (error.textContent = 'Threshold must be a number above 0.');

          const next = {
            id: topic?.id || uid(),
            enabled: topic?.enabled !== false,
            tag,
            threshold,
            domains: parseWeights(domIn.value, 5),
            keywords: parseWeights(kwIn.value, 2),
          };
          const topics = cloneTopics();
          const i = topics.findIndex((t) => t.id === next.id);
          if (i >= 0) topics[i] = next; else topics.push(next);
          await saveTopics(topics);
          dlg.close();
        },
      }, 'Save')),
  ));
  dlg.showModal();
}

/* ============================================================
   sync (Settings panel + automatic syncing)
   ============================================================ */

const SYNC_TRIGGER_KEYS = new Set(['bookmarks', 'tombstones', 'userRules', 'folders', 'disabledRules', 'topics', 'pinnedTags', 'prefs']);
let syncTimer = 0;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow(); }, 2500);
}

const timeAgo = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(ms).toLocaleDateString();
};

/** Sync status changed (sync.js writes it often): update just the panel, not the whole page. */
async function onSyncStatus() {
  const { sync } = await store.get({ sync: null });
  if (state) state.sync = sync;
  const el = document.getElementById('sync-group');
  if (el) fillSyncGroup(el);
  if (route()[0] === 'all' && state && !state.bookmarks.length) renderContent(); // empty-state wording depends on being signed in
}

function syncGroup() {
  const el = h('section', { class: 'group', id: 'sync-group' });
  fillSyncGroup(el);
  return el;
}

function fillSyncGroup(el) {
  const sync = state?.sync || {};
  const email = sync.session?.user?.email;
  let body;

  if (!isConfigured()) {
    body = h('div', { class: 'none' },
      'Sync isn’t set up yet. Add your Supabase URL and key to ', h('code', {}, 'config.js'), ', then reload. The Guide has the steps.');
  } else if (!email) {
    const emailIn = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' });
    const passIn = h('input', { type: 'password', placeholder: 'Password (6+ characters)', autocomplete: 'current-password' });
    const inBtn = h('button', { class: 'primary', type: 'button' }, 'Sign in');
    const upBtn = h('button', { class: 'ghost bordered', type: 'button' }, 'Create account');
    const submit = async (kind) => {
      const address = emailIn.value.trim();
      if (!address || passIn.value.length < 6) { toast('Enter your email and a password of at least 6 characters.'); return; }
      inBtn.disabled = upBtn.disabled = true;
      try {
        const res = kind === 'in' ? await signIn(address, passIn.value) : await signUp(address, passIn.value);
        if (res?.needsConfirm) toast('Check your email to confirm your account, then sign in.');
        else if (res?.error) toast(res.error);
        else toast(kind === 'in' ? 'Signed in. Your bookmarks are syncing.' : 'Account created. Syncing…');
      } catch (e) {
        toast(e.message || 'That didn’t work.');
      }
      inBtn.disabled = upBtn.disabled = false;
    };
    inBtn.onclick = () => submit('in');
    upBtn.onclick = () => submit('up');
    passIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit('in'); });
    body = h('div', { class: 'sync-form' }, emailIn, passIn, h('div', { class: 'row' }, inBtn, upBtn));
  } else {
    const status = sync.syncing ? 'Syncing…'
      : sync.error ? sync.error
        : sync.lastSync ? `Last synced ${timeAgo(sync.lastSync)}` : 'Not synced yet';
    body = h('div', { class: 'list' },
      h('div', { class: 'item-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, `Signed in as ${email}`),
          h('div', { class: 'detail' + (sync.error && !sync.syncing ? ' error' : '') }, status)),
        h('button', {
          class: 'ghost bordered', disabled: !!sync.syncing,
          onclick: async () => {
            const r = await syncNow();
            toast(r?.error ? r.error : r?.changed || r?.sent ? 'Synced' : 'Everything is up to date');
          },
        }, 'Sync now'),
        h('button', { class: 'ghost', onclick: async () => { await signOut(); toast('Signed out. Your bookmarks stay on this device.'); } }, 'Sign out')));
  }

  el.replaceChildren(
    h('h2', {}, 'Sync'),
    h('p', {}, 'Keep your bookmarks, rules and folders in step across your devices and the web app.'),
    body);
}

/* ---------- add a link (website) ---------- */

function openAddLink() {
  const dlg = $('#editor');
  const signedIn = !!state?.sync?.session;
  const input = h('input', { type: 'url', placeholder: 'https://…', 'aria-label': 'Link' });
  const error = h('div', { class: 'error small' });
  const saveBtn = h('button', { class: 'primary', type: 'button' }, 'Save');

  async function save() {
    let url = input.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { error.textContent = 'That doesn’t look like a link.'; return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const page = await fetchPage(url);
      const { existed } = await saveBookmark(page, '');
      dlg.close();
      toast(existed ? 'Already in your library' : 'Saved');
    } catch (e) {
      error.textContent = e.message || 'Couldn’t save that link.';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
  saveBtn.onclick = save;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  dlg.replaceChildren(h('div', { class: 'form' },
    h('h3', {}, 'Add a link'),
    h('label', {}, 'Link', input),
    h('p', { class: 'muted small', style: 'margin:0' },
      signedIn ? 'Tagmark reads the page for its title and image, then tags it.'
        : 'Sign in under Settings, Sync, and Tagmark will also fetch the page’s title and image.'),
    error,
    h('div', { class: 'row end' },
      h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      saveBtn)));
  dlg.showModal();
  input.focus();
}

/* ============================================================
   start (last on purpose: everything above must be defined first)
   ============================================================ */

$('#searchbox').prepend(icon('search'));
$('#tools').append(emptyTrashBtn, sortDD.el, viewSeg);
if (!isExtension) $('#tools').prepend(addBtn);
document.addEventListener('keydown', onKey);
document.body.append(tipEl);
buildBar();
refresh().then(() => { scrollGuide(); syncNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
if (!isExtension) setInterval(() => { syncNow(); }, 60000);
