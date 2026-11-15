// online.js — Repertorio público de BitMidi (https://bitmidi.com).
// Su API de búsqueda y sus archivos permiten peticiones desde otras webs (CORS),
// así que se consultan directamente desde el navegador, sin servidor propio.

const BASE = 'https://bitmidi.com';
const PAGE_SIZE = 30;

export const ONLINE_SOURCE = { id: 'bitmidi', name: 'BitMidi', url: BASE };

export const keyOf = item => `${item.source}:${item.sourceId}`;
export const isOnlineId = id => typeof id === 'string' && /^(bitmidi|cat):/.test(id);
const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function cleanTitle(name = '') {
  let t = name
    .replace(/\.(midi?|kar|rmi)$/i, '')
    .replace(/_+/g, ' ')
    .replace(/''/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\s/.test(t) && t.includes('-')) t = t.replace(/-+/g, ' ');          // nombres tipo «frederic-chopin-nocturne»
  if (t === t.toLowerCase()) t = t.replace(/(^|\s)(\p{L})/gu, (m, a, c) => a + c.toUpperCase());
  return t || 'Sin título';
}

function normalize(m) {
  return {
    source: 'bitmidi',
    sourceName: 'BitMidi',
    sourceId: String(m.id),
    name: m.name || `${m.id}.mid`,
    title: cleanTitle(m.name),
    plays: Number(m.plays) || 0,
    pageUrl: BASE + (m.url || `/${m.slug || ''}`),
    fileUrl: BASE + (m.downloadUrl || `/uploads/${m.id}.mid`),
  };
}

export async function searchOnline(q, page = 0, { signal } = {}) {
  const url = `${BASE}/api/midi/search?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}`;
  let res;
  try {
    res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('sin conexión');
  }
  // BitMidi responde 404 cuando no hay más páginas
  if (res.status === 404) return { results: [], total: 0, pageTotal: 0, page };
  if (!res.ok) throw new Error(`BitMidi respondió ${res.status}`);
  const json = await res.json();
  const r = json.result || {};
  return {
    results: (r.results || []).map(normalize),
    total: Number(r.total) || 0,
    pageTotal: Number(r.pageTotal) || 0,
    page,
  };
}

export async function downloadOnline(item, { signal } = {}) {
  let res;
  try {
    res = await fetch(item.fileUrl, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('sin conexión');
  }
  if (!res.ok) throw new Error(`BitMidi respondió ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) throw new Error('archivo demasiado grande');
  return buf;
}

// ---------- Catálogo Pianola (colecciones abiertas en GitHub, ya analizadas) ----------
const LABELS_BY_CODE = ['performed', 'expressive', 'mechanical'];
let catalogPromise = null;

export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('./catalog/index.json')
      .then(r => { if (!r.ok) throw new Error(`catálogo ${r.status}`); return r.json(); })
      .then(prepareCatalog)
      .catch(e => { catalogPromise = null; throw e; });
  }
  return catalogPromise;
}

const lastName = full => (full || '').split(' ').filter(Boolean).pop() || full;

function prepareCatalog(c) {
  const cols = c.collections.map(col => ({ ...col, count: 0 }));
  const items = c.items.map(x => {
    const col = cols[x[0]];
    col.count++;
    const [, path, title, author, performer, secs, score, label, pianoOnly] = x;
    const display = col.genre === 'Pop' ? `${title} — ${author}` : `${lastName(author)}: ${title}`;
    return {
      source: 'cat',
      sourceId: `${col.id}:${path}`,
      sourceName: col.name,
      collection: col.id,
      genre: col.genre,
      name: path.split('/').pop(),
      title: display,
      work: title,
      author,
      performer,
      plays: 0,
      durSec: secs,
      quality: { v: 1, score, label: LABELS_BY_CODE[label], pianoOnly: !!pianoOnly, reasons: [], f: {}, d: secs * 1000 },
      pageUrl: col.url,
      fileUrl: col.base + path.split('/').map(encodeURIComponent).join('/'),
      search: norm(`${title} ${author} ${performer} ${col.name} ${col.genre}`),
    };
  });
  const composers = new Map();
  for (const it of items) if (it.genre !== 'Pop') composers.set(it.author, (composers.get(it.author) || 0) + 1);
  return {
    built: c.built,
    collections: cols,
    items,
    composers: [...composers.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
  };
}

export function searchCatalog(cat, { q = '', col = null, composer = null } = {}) {
  let list = cat.items;
  if (col) list = list.filter(it => it.collection === col);
  if (composer) list = list.filter(it => it.author === composer);
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  if (tokens.length) {
    list = list.filter(it => tokens.every(t => it.search.includes(t)));
    const nq = norm(q);
    list = list.slice().sort((a, b) => (norm(b.title).includes(nq) - norm(a.title).includes(nq)) || b.quality.score - a.quality.score);
  }
  return list;
}
