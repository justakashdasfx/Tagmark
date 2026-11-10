/**
 * rules-engine.js — dependency-free auto-tagging engine for the bookmark app.
 * Runs in the extension, the web app and a future Mac app. Everything
 * (rules, topics, folders) is plain JSON so it can be stored in the database.
 *
 * PIPELINE (classify):
 *   1. Source rules   (built-in, stage "source")  → sets type + tags (X Post, Profile, Video, Article…)
 *   2. Fallback                                    → no type yet? type "link", tag "Web Link"
 *   3. Topic scoring  (weighted keywords/domains)  → Design / Engineering / Coding …
 *   4. User rules     (stage "user")               → can read the type + tags produced above
 *   5. Folder rules                                → smart folders evaluate the final result
 *
 * PAGE CONTEXT (input), see page-context.js:
 *   { url, title, description, image, ogType, siteName,
 *     jsonLdTypes: [], keywords: [], headings: [], text }
 *
 * RULE SCHEMA
 *   {
 *     id: 'x-post',
 *     name: 'X post',
 *     enabled: true,
 *     builtin: true,            // built-ins can be disabled, not deleted
 *     stage: 'source' | 'user',
 *     match: 'all' | 'any',
 *     conditions: [ Condition | Group ],
 *     actions:    [ { type: 'addTag' | 'removeTag' | 'setType', value: string } ]
 *   }
 *   Condition = { field, op, value }
 *   Group     = { match: 'all' | 'any', conditions: [...] }   // nest as deep as needed
 *
 *   fields: url, host, path, handle, title, description, text, ogType,
 *           jsonLdTypes, keywords, type, tags
 *   ops:    equals, notEquals, contains, notContains, startsWith, endsWith,
 *           in, regex, isEmpty, notEmpty
 *           (field "host" is domain-aware: "x.com" also matches "www.x.com", "m.x.com")
 *
 * FOLDER SCHEMA (smart folder = folder with conditions; no conditions = manual folder)
 *   { id, name, match: 'all' | 'any', conditions: [...] }
 */

/* ------------------------------------------------------------------ */
/* Default source rules                                                */
/* ------------------------------------------------------------------ */

const X_HOSTS = ['x.com', 'twitter.com'];
const ARTICLE_LD_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report'];
const PUBLISHING_HOSTS = [
  'medium.com', 'substack.com', 'dev.to', 'hashnode.dev', 'hashnode.com',
  'wordpress.com', 'ghost.io', 'smashingmagazine.com', 'css-tricks.com', 'nngroup.com',
];

export const DEFAULT_RULES = [
  // ---------- X ----------
  {
    id: 'x-post', name: 'X post', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'in', value: X_HOSTS },
      { field: 'path', op: 'regex', value: String.raw`^/[^/]+/status/\d+` },
    ],
    actions: [
      { type: 'addTag', value: 'X' },
      { type: 'addTag', value: 'X Post' },
      { type: 'setType', value: 'post' },
    ],
  },
  {
    id: 'x-profile', name: 'X profile', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'in', value: X_HOSTS },
      {
        field: 'path', op: 'regex',
        value: String.raw`^/(?!(home|explore|search|notifications|messages|i|settings|compose|hashtag|login|tos|privacy)(/|$))[A-Za-z0-9_]{1,15}/?$`,
      },
    ],
    actions: [
      { type: 'addTag', value: 'X' },
      { type: 'addTag', value: 'Profile' },
      { type: 'setType', value: 'profile' },
    ],
  },

  // ---------- LinkedIn ----------
  {
    id: 'linkedin-post', name: 'LinkedIn post', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'linkedin.com' },
      { field: 'path', op: 'regex', value: String.raw`^/(posts|feed/update)/` },
    ],
    actions: [
      { type: 'addTag', value: 'LinkedIn' },
      { type: 'addTag', value: 'LinkedIn Post' },
      { type: 'setType', value: 'post' },
    ],
  },
  {
    id: 'linkedin-profile', name: 'LinkedIn profile', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'linkedin.com' },
      { field: 'path', op: 'regex', value: String.raw`^/in/` },
    ],
    actions: [
      { type: 'addTag', value: 'LinkedIn' },
      { type: 'addTag', value: 'Profile' },
      { type: 'setType', value: 'profile' },
    ],
  },
  {
    id: 'linkedin-company', name: 'LinkedIn company', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'linkedin.com' },
      { field: 'path', op: 'regex', value: String.raw`^/company/` },
    ],
    actions: [
      { type: 'addTag', value: 'LinkedIn' },
      { type: 'addTag', value: 'Profile' },
      { type: 'addTag', value: 'Company' },
      { type: 'setType', value: 'profile' },
    ],
  },
  {
    id: 'linkedin-article', name: 'LinkedIn article', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'linkedin.com' },
      { field: 'path', op: 'regex', value: String.raw`^/pulse/` },
    ],
    actions: [
      { type: 'addTag', value: 'LinkedIn' },
      { type: 'addTag', value: 'Article' },
      { type: 'setType', value: 'article' },
    ],
  },

  // ---------- YouTube ----------
  {
    id: 'youtube-video', name: 'YouTube video', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'in', value: ['youtube.com', 'youtu.be'] },
      {
        match: 'any',
        conditions: [
          { field: 'host', op: 'equals', value: 'youtu.be' },
          { field: 'path', op: 'regex', value: String.raw`^/(watch|shorts/|live/)` },
        ],
      },
    ],
    actions: [
      { type: 'addTag', value: 'YouTube' },
      { type: 'addTag', value: 'Video' },
      { type: 'setType', value: 'video' },
    ],
  },
  {
    id: 'youtube-channel', name: 'YouTube channel', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'youtube.com' },
      { field: 'path', op: 'regex', value: String.raw`^/(@|channel/|c/|user/)` },
    ],
    actions: [
      { type: 'addTag', value: 'YouTube' },
      { type: 'addTag', value: 'Profile' },
      { type: 'setType', value: 'profile' },
    ],
  },

  // ---------- GitHub (example of an extra source) ----------
  {
    id: 'github-repo', name: 'GitHub repo', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'host', op: 'equals', value: 'github.com' },
      { field: 'path', op: 'regex', value: String.raw`^/[^/]+/[^/]+/?$` },
    ],
    actions: [
      { type: 'addTag', value: 'GitHub' },
      { type: 'addTag', value: 'Repo' },
      { type: 'setType', value: 'repo' },
    ],
  },

  // ---------- Generic articles (only if nothing above matched) ----------
  {
    id: 'article-meta', name: 'Article (page metadata)', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'type', op: 'isEmpty' },
      {
        match: 'any',
        conditions: [
          { field: 'ogType', op: 'equals', value: 'article' },
          { field: 'jsonLdTypes', op: 'in', value: ARTICLE_LD_TYPES },
        ],
      },
    ],
    actions: [
      { type: 'addTag', value: 'Article' },
      { type: 'setType', value: 'article' },
    ],
  },
  {
    id: 'article-platform', name: 'Article (publishing platform)', enabled: true, builtin: true, stage: 'source', match: 'all',
    conditions: [
      { field: 'type', op: 'isEmpty' },
      { field: 'host', op: 'in', value: PUBLISHING_HOSTS },
    ],
    actions: [
      { type: 'addTag', value: 'Article' },
      { type: 'setType', value: 'article' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Default topic dictionaries (weights 0.5 – 6; user-editable)         */
/* ------------------------------------------------------------------ */

export const DEFAULT_TOPICS = [
  {
    id: 'design', tag: 'Design', enabled: true, threshold: 6,
    domains: {
      'dribbble.com': 6, 'behance.net': 6, 'figma.com': 6, 'awwwards.com': 6,
      'mobbin.com': 6, 'uxdesign.cc': 5, 'nngroup.com': 5, 'smashingmagazine.com': 3,
    },
    keywords: {
      'design system': 3, 'ui design': 3, 'ux design': 3, 'product design': 3, 'visual design': 3,
      'motion design': 3, 'graphic design': 3, figma: 3, typography: 3, typeface: 3,
      ux: 2, ui: 1.5, branding: 2, wireframe: 2, prototype: 1.5, 'user research': 2,
      'color palette': 2, layout: 1.5, illustration: 1.5, logo: 1.5, interaction: 1.5,
      accessibility: 1, design: 1,
    },
  },
  {
    id: 'coding', tag: 'Coding', enabled: true, threshold: 6,
    domains: {
      'github.com': 4, 'stackoverflow.com': 6, 'developer.mozilla.org': 6,
      'npmjs.com': 4, 'codepen.io': 5, 'dev.to': 2,
    },
    keywords: {
      javascript: 3, typescript: 3, python: 3, programming: 3, 'next.js': 3, rust: 2, golang: 2,
      react: 2.5, css: 2, npm: 2, 'pull request': 2, repository: 2, github: 2,
      framework: 1.5, api: 1.5, html: 1.5, 'open source': 1.5, tutorial: 1, code: 1,
    },
  },
  {
    id: 'engineering', tag: 'Engineering', enabled: true, threshold: 6,
    domains: { 'highscalability.com': 6, 'martinfowler.com': 6, 'infoq.com': 5 },
    keywords: {
      'system design': 3, 'software engineering': 3, microservices: 3, devops: 3, kubernetes: 3,
      'ci/cd': 2.5, observability: 2.5, scalability: 2.5, infrastructure: 2.5, distributed: 2.5,
      docker: 2.5, architecture: 2, backend: 2, database: 2, latency: 2, aws: 2,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const norm = (v) => String(v ?? '').trim().toLowerCase();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const domainMatch = (host, domain) => host === domain || host.endsWith('.' + domain);

const regexCache = new Map();
function cachedRegex(source, flags) {
  const key = flags + '/' + source;
  if (!regexCache.has(key)) {
    try { regexCache.set(key, new RegExp(source, flags)); } catch { regexCache.set(key, null); }
  }
  return regexCache.get(key);
}

function deriveHandle(host, segments) {
  if (['x.com', 'twitter.com', 'instagram.com', 'github.com', 'tiktok.com'].includes(host)) {
    return (segments[0] || '').replace(/^@/, '');
  }
  if (host === 'linkedin.com' && ['in', 'company'].includes(segments[0])) return segments[1] || '';
  if (host === 'youtube.com') return (segments.find((s) => s.startsWith('@')) || '').slice(1);
  return '';
}

function buildContext(page) {
  const url = new URL(page.url);
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  return {
    url: url.href,
    host,
    path: url.pathname,
    handle: deriveHandle(host, segments),
    title: page.title || '',
    description: page.description || '',
    text: (page.text || '').slice(0, 5000),
    ogType: page.ogType || '',
    jsonLdTypes: page.jsonLdTypes || [],
    keywords: page.keywords || [],
    headings: page.headings || [],
    type: '',
    tags: [],
  };
}

function getField(ctx, field) {
  return ctx[field];
}

/* ------------------------------------------------------------------ */
/* Condition evaluation                                                */
/* ------------------------------------------------------------------ */

function testCondition(cond, ctx) {
  if (cond.conditions) return testGroup(cond, ctx);

  const raw = getField(ctx, cond.field);
  const rawList = Array.isArray(raw) ? raw : [raw];
  const list = rawList.map(norm);
  const want = (Array.isArray(cond.value) ? cond.value : [cond.value]).map(norm);
  const isHost = cond.field === 'host';
  const empty = list.every((v) => !v);

  switch (cond.op) {
    case 'isEmpty': return empty;
    case 'notEmpty': return !empty;
    case 'equals':
      return list.some((v) => (isHost ? domainMatch(v, want[0]) : v === want[0]));
    case 'notEquals':
      return !list.some((v) => (isHost ? domainMatch(v, want[0]) : v === want[0]));
    case 'contains': return list.some((v) => v.includes(want[0]));
    case 'notContains': return !list.some((v) => v.includes(want[0]));
    case 'startsWith': return list.some((v) => v.startsWith(want[0]));
    case 'endsWith': return list.some((v) => v.endsWith(want[0]));
    case 'in':
      return list.some((v) => want.some((w) => (isHost ? domainMatch(v, w) : v === w)));
    case 'regex': {
      const re = cachedRegex(String(cond.value), 'i');
      return !!re && rawList.some((v) => re.test(String(v ?? '')));
    }
    default: return false;
  }
}

function testGroup(group, ctx) {
  const conds = group.conditions || [];
  if (!conds.length) return false; // an empty rule never matches
  return group.match === 'any'
    ? conds.some((c) => testCondition(c, ctx))
    : conds.every((c) => testCondition(c, ctx));
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function addTag(ctx, tag) {
  if (!tag) return;
  if (!ctx.tags.some((t) => norm(t) === norm(tag))) ctx.tags.push(tag);
}

function applyActions(rule, ctx) {
  for (const a of rule.actions || []) {
    if (a.type === 'addTag') addTag(ctx, a.value);
    else if (a.type === 'removeTag') ctx.tags = ctx.tags.filter((t) => norm(t) !== norm(a.value));
    else if (a.type === 'setType') ctx.type = a.value;
  }
}

function runRules(rules, ctx, matched) {
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (testGroup(rule, ctx)) {
      applyActions(rule, ctx);
      matched.push(rule.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Topic scoring                                                       */
/* ------------------------------------------------------------------ */

const FIELD_MULTIPLIERS = [
  ['title', 3],
  ['description', 2],
  ['keywordsText', 2],
  ['headingsText', 1.5],
  ['text', 1],
];

function keywordRegex(keyword) {
  return cachedRegex(`(?<!\\w)${escapeRegex(keyword)}(?!\\w)`, 'gi');
}

function scoreTopic(topic, ctx) {
  let score = 0;

  for (const [domain, weight] of Object.entries(topic.domains || {})) {
    if (domainMatch(ctx.host, domain)) score += weight;
  }

  const fields = {
    title: ctx.title,
    description: ctx.description,
    keywordsText: ctx.keywords.join(' '),
    headingsText: ctx.headings.join(' '),
    text: ctx.text,
  };

  for (const [keyword, weight] of Object.entries(topic.keywords || {})) {
    const re = keywordRegex(keyword);
    if (!re) continue;
    for (const [field, multiplier] of FIELD_MULTIPLIERS) {
      const hits = (fields[field] || '').match(re);
      if (hits) score += weight * multiplier * Math.min(hits.length, 3);
    }
  }
  return score;
}

function applyTopics(topics, ctx, { maxTopics = 3 } = {}) {
  const scores = {};
  const passed = [];
  for (const topic of topics) {
    if (topic.enabled === false) continue;
    const score = scoreTopic(topic, ctx);
    scores[topic.id] = Math.round(score * 10) / 10;
    if (score >= (topic.threshold ?? 6)) passed.push({ topic, score });
  }
  passed.sort((a, b) => b.score - a.score);
  for (const { topic } of passed.slice(0, maxTopics)) addTag(ctx, topic.tag);
  return scores;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} page      page context (see header)
 * @param {object} [options] { rules, topics, folders }
 * @returns {{ type, tags, folderIds, matchedRules, topicScores }}
 */
export function classify(page, { rules = DEFAULT_RULES, topics = DEFAULT_TOPICS, folders = [] } = {}) {
  const ctx = buildContext(page);
  const matched = [];

  // 1. built-in source rules
  runRules(rules.filter((r) => r.stage !== 'user'), ctx, matched);

  // 2. fallback
  if (!ctx.type) {
    ctx.type = 'link';
    addTag(ctx, 'Web Link');
  }

  // 3. topics
  const topicScores = applyTopics(topics, ctx);

  // 4. user rules (see type + tags from above)
  runRules(rules.filter((r) => r.stage === 'user'), ctx, matched);

  // 5. smart folders
  const folderIds = folders
    .filter((f) => (f.conditions || []).length > 0 && testGroup(f, ctx))
    .map((f) => f.id);

  return { type: ctx.type, tags: ctx.tags, folderIds, matchedRules: matched, topicScores };
}

/** Re-evaluate smart folders for an already-saved bookmark (e.g. after a folder rule is edited). */
export function matchFolders(bookmark, folders) {
  const ctx = buildContext({ url: bookmark.url, title: bookmark.title, description: bookmark.description });
  ctx.type = bookmark.type || '';
  ctx.tags = bookmark.tags || [];
  return folders
    .filter((f) => (f.conditions || []).length > 0 && testGroup(f, ctx))
    .map((f) => f.id);
}

/* ------------------------------------------------------------------ */
/* Example                                                             */
/* ------------------------------------------------------------------ */
/*
const userRules = [{
  id: 'u1', name: 'Gentlenmasc → tag', enabled: true, stage: 'user', match: 'all',
  conditions: [{ field: 'handle', op: 'equals', value: 'Gentlenmasc' }],
  actions: [{ type: 'addTag', value: 'Gentlenmasc' }],
}];

const folders = [
  { id: 'f-profiles', name: 'Profiles', match: 'all', conditions: [{ field: 'type', op: 'equals', value: 'profile' }] },
  { id: 'f-gentle',   name: 'Gentlenmasc', match: 'any', conditions: [{ field: 'url', op: 'contains', value: 'Gentlenmasc' }] },
];

classify(
  { url: 'https://x.com/Gentlenmasc/status/2119439363105038357', title: 'Post by Gentlenmasc' },
  { rules: [...DEFAULT_RULES, ...userRules], folders }
);
// → { type: 'post', tags: ['X', 'X Post', 'Gentlenmasc'], folderIds: ['f-gentle'], ... }
*/
