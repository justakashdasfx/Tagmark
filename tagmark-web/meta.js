/** Website only: ask the /api/meta function to read a page, so "Add link" can fill in title and image. */
import { getAccessToken } from './sync.js';

export async function fetchPage(url) {
  try {
    const t = await getAccessToken();
    const res = await fetch(`/api/meta?url=${encodeURIComponent(url)}`, { headers: { Authorization: `Bearer ${t}` } });
    if (res.ok) return { ...(await res.json()), url };
  } catch { /* not signed in, offline, or the page can't be read: fall through */ }
  let title = url;
  try { const u = new URL(url); title = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname); } catch { /* keep url */ }
  return { url, title };
}
