// online.js — Repertorio público de BitMidi (https://bitmidi.com).
// Su API de búsqueda y sus archivos permiten peticiones desde otras webs (CORS),
// así que se consultan directamente desde el navegador, sin servidor propio.

const BASE = 'https://bitmidi.com';
const PAGE_SIZE = 30;

export const ONLINE_SOURCE = { id: 'bitmidi', name: 'BitMidi', url: BASE };

export const keyOf = item => `${item.source}:${item.sourceId}`;
export const isOnlineId = id => typeof id === 'string' && id.startsWith('bitmidi:');

export function cleanTitle(name = '') {
  return name
    .replace(/\.(midi?|kar|rmi)$/i, '')
    .replace(/_+/g, ' ')
    .replace(/''/g, '"')
    .replace(/\s+/g, ' ')
    .trim() || 'Sin título';
}

function normalize(m) {
  return {
    source: 'bitmidi',
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
