/**
 * platform.js — one thin layer so the same code runs as a Chrome extension and as a website.
 *   store.get(defaults) / store.set(obj) / store.onChange(fn)
 *   openUrl(url)
 * Extension: chrome.storage.local.  Website: IndexedDB (plus a BroadcastChannel so other tabs update).
 */
export const isExtension =
  typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.storage?.local;

function extensionStore() {
  return {
    get: (defaults) => chrome.storage.local.get(defaults),
    set: (obj) => chrome.storage.local.set(obj),
    onChange: (fn) => chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') fn(changes);
    }),
  };
}

function idbStore() {
  const DB = 'tagmark';
  const STORE = 'kv';
  const listeners = new Set();
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tagmark-store') : null;
  const asChanges = (keys) => Object.fromEntries(keys.map((k) => [k, {}]));
  if (channel) channel.onmessage = (e) => listeners.forEach((fn) => fn(asChanges(e.data)));

  let dbPromise;
  const open = () => (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

  return {
    async get(defaults = null) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const out = {};
        const tx = db.transaction(STORE, 'readonly');
        const os = tx.objectStore(STORE);
        if (defaults) {
          for (const key of Object.keys(defaults)) {
            const r = os.get(key);
            r.onsuccess = () => {
              out[key] = r.result === undefined ? structuredClone(defaults[key]) : r.result;
            };
          }
        } else {
          const r = os.openCursor();
          r.onsuccess = () => {
            const cur = r.result;
            if (cur) { out[cur.key] = cur.value; cur.continue(); }
          };
        }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      });
    },
    async set(obj) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        for (const [key, value] of Object.entries(obj)) os.put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      const keys = Object.keys(obj);
      listeners.forEach((fn) => fn(asChanges(keys)));
      channel?.postMessage(keys);
    },
    onChange(fn) { listeners.add(fn); },
  };
}

export const store = isExtension ? extensionStore() : idbStore();

export function openUrl(url) {
  if (isExtension && chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}
