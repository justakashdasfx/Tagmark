/**
 * Vercel function: GET /api/meta?url=https://…
 * Reads a public web page and returns its title, image and the text Tagmark needs to tag it.
 * Only signed-in Tagmark users can call it (their Supabase token is checked), and it refuses
 * anything that resolves to a private or local network address.
 *
 * Environment variables to set in Vercel: SUPABASE_URL and SUPABASE_ANON_KEY.
 */
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 1500000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links are supported');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('That port isn’t supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('That address isn’t allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address isn’t allowed');
    return;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address isn’t allowed');
}

async function verifyUser(authHeader) {
  if (!authHeader || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: authHeader },
  });
  return res.ok ? res.json() : null;
}

async function readCapped(resp) {
  const reader = resp.body.getReader();
  const parts = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  try { await reader.cancel(); } catch { /* already finished */ }
  return new TextDecoder('utf-8').decode(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const clean = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parse(html, base) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = decode(attrs.content).trim();
  }

  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const jsonLdTypes = [];
  const collect = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node === 'object') {
      if (node['@type']) [].concat(node['@type']).forEach((t) => jsonLdTypes.push(String(t)));
      if (node['@graph']) collect(node['@graph']);
    }
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collect(JSON.parse(m[1])); } catch { /* ignore bad JSON-LD */ }
  }

  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].slice(0, 10).map((m) => clean(m[1])).filter(Boolean);
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let image = meta['og:image'] || meta['twitter:image'] || '';
  if (image) { try { image = new URL(image, base).href; } catch { image = ''; } }

  return {
    title: meta['og:title'] || (titleTag ? clean(titleTag) : ''),
    description: meta['og:description'] || meta.description || '',
    image,
    ogType: meta['og:type'] || '',
    siteName: meta['og:site_name'] || '',
    jsonLdTypes,
    keywords: (meta.keywords || '').split(',').map((k) => k.trim()).filter(Boolean),
    headings,
    text: clean(body).slice(0, 5000),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyUser(req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Sign in first' });

    let current = new URL(String(req.query.url || ''));
    let resp;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublic(current);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        resp = await fetch(current, {
          redirect: 'manual', signal: ctrl.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; TagmarkBot/1.0)', accept: 'text/html,application/xhtml+xml' },
        });
      } finally { clearTimeout(timer); }
      const next = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && next) { current = new URL(next, current); continue; }
      break;
    }
    if (!resp.ok) throw new Error(`The site answered ${resp.status}`);
    if (!/text\/html|application\/xhtml/i.test(resp.headers.get('content-type') || '')) throw new Error('That link isn’t a web page');

    const html = await readCapped(resp);
    return res.status(200).json(parse(html, current.href));
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Could not read that page' });
  }
};
