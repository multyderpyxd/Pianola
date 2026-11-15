import { loadMidi, parseMidi, buildTimeline, formatTime } from './midi.js';
import { analyzeMidi, LABELS } from './quality.js';
import { BleMidi, MockMidi } from './ble.js';
import { Player, lowerBoundOn } from './player.js';
import { library, playlistStore, newId, persistStorage, storageEstimate } from './library.js';
import { searchOnline, downloadOnline, keyOf, isOnlineId, loadCatalog, searchCatalog } from './online.js';
import { odeToJoy, DEMO_TITLE } from './demo.js';
import { icon, keysArt } from './icons.js';

const VERSION = '1.4.0';
const $ = s => document.querySelector(s);
const SIMULATED = new URLSearchParams(location.search).has('demo');

// ---------- Estado ----------
const ble = SIMULATED ? new MockMidi() : new BleMidi();
const player = new Player(ble);

const defaults = { keepAwake: true, background: false, muteDrums: false, mode: 'original', repeat: 'off', shuffle: false, sort: 'recent', volume: 127, analyzeOnline: true };
const settings = { ...defaults, ...readJSON('pianola.settings') };
function saveSettings() { try { localStorage.setItem('pianola.settings', JSON.stringify(settings)); } catch {} }
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }

let songs = [];
let filter = 'all';
let query = '';
let current = null;        // metadatos de la canción cargada
let queue = [];            // ids en orden de reproducción
let baseQueue = [];        // orden sin aleatorio
let qi = -1;
let resumeAfterReconnect = false;
let advanceToken = 0;
const pendingDelete = new Map();
const userNotes = new Set();

// Listas
let playlists = [];
let openListId = null;          // lista abierta en la pestaña Listas
let queueName = null;           // nombre de la lista que está sonando
const pendingListDelete = new Map();

// Explorar (BitMidi)
const SUGGESTIONS = ['Chopin', 'Debussy', 'Satie', 'Bach', 'Beethoven', 'Liszt', 'Ghibli', 'Final Fantasy', 'Zelda', 'Yiruma', 'Queen', 'Beatles'];
const online = { q: '', page: 0, pageTotal: 0, total: 0, results: [], loading: false, error: null, ctrl: null, loadingKey: null };
const onlineIndex = new Map();   // clave → resultado visto
const onlineCache = new Map();   // clave → archivo descargado
const transientMeta = new Map(); // clave → metadatos de una canción online sin guardar
let onlineTimer = null;
online.sort = 'relevance';
online.onlyPerformed = false;
online.source = readJSON('pianola.settings').exploreSource || 'catalog';
const cat = { data: null, loading: false, error: null, col: null, composer: null, curated: null, limit: 60 };

// Colecciones temáticas sobre el catálogo (por título, intérprete y duración)
const GREAT_PIANISTS = /paderewski|debussy|busoni|hofmann|lh[eé]vinne|backhaus|carre[nñ]o|landowska|scharwenka|pachmann|sauer|d'albert|grieg|saint-sa[eë]ns|mahler|reger|scriabin|skriabin|godowsky|rachmanin|granados|gabrilowitsch|dohn[aá]nyi|reisenauer|ganz|ney|stavenhagen|grainger/i;
const CURATED = [
  { id: 'sleep', name: 'Para dormir', desc: 'Nocturnos, nanas, romanzas y movimientos lentos, tocados por pianistas', test: it => it.genre !== 'Pop' && it.durSec <= 720 && it.quality.label === 'performed' && /noct|berceuse|lullab|wiegen|cradle|r[eê]verie|tr[aä]umerei|romanc|romanz|adagio|andante|largo|lento|[eé]l[eé]gie|consolation|liebestr|clair de lune|moonlight|barcarol|ave maria|sarabande|gymnop|pavan|serenad|nachtst|notturno/i.test(it.work) },
  { id: 'legends', name: 'Leyendas del piano', desc: 'Rollos grabados por Paderewski, Busoni, Hofmann, Debussy, Carreño…', test: it => it.collection === 'supra' && GREAT_PIANISTS.test(it.performer) },
  { id: 'virtuoso', name: 'Virtuosismo', desc: 'Estudios, rapsodias, tocatas y polonesas de alto voltaje', test: it => it.genre !== 'Pop' && /[eé]tude|estudio|rhapsod|rapsod|toccat|islamey|mephisto|polon|feux|wilde jagd|campanella|scherzo/i.test(it.work) },
  { id: 'dance', name: 'Bailes de los años 20', desc: 'Foxtrots, valses y tangos de rollo de pianola', test: it => it.collection === 'supra' && /fox|trot|walzer|waltz|valse|tango|one-step|two-step|shimmy|rag|blues|march|marsch/i.test(it.work) },
];

// Calidad de resultados online: se calcula al vuelo y se guarda en el móvil
const qcache = new Map(Object.entries(readJSON('pianola.qcache')));
const qfailed = new Set();
const analyzing = new Set();
let qActive = 0;
let qSaveTimer = null;
let renderTimer = null;

// Temporizador de apagado
const sleepTimer = { mode: null, until: 0, timer: null, tick: null };

player.setMode(settings.mode);
player.setMuteDrums(settings.muteDrums);

// ---------- Reloj ----------
let clock = null;
try {
  clock = new Worker('./js/clock-worker.js');
  clock.onmessage = () => player.tick();
} catch {
  let t = null;
  clock = { postMessage: m => { if (m === 'start' && !t) t = setInterval(() => player.tick(), 4); if (m === 'stop') { clearInterval(t); t = null; } } };
}

// ---------- Utilidades ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plural = (n, one, many) => `${n.toLocaleString('es-ES')} ${n === 1 ? one : many}`;
function titleFrom(name) {
  return name.replace(/\.(midi?|kar|rmi)$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sin título';
}

let toastTimer = null;
function toast(text, { action, onAction, ms = 3200 } = {}) {
  const el = $('#toast');
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.textContent = action || '';
  btn.onclick = () => { hideToast(); onAction?.(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').classList.remove('show'); }

// ---------- Capas (reproductor y hojas) con el botón Atrás de Android ----------
const layers = [];
function pushLayer(name, close) {
  layers.push({ name, close });
  history.pushState({ layer: name }, '');
}
function popLayer(name) {
  const top = layers[layers.length - 1];
  if (top && top.name === name) history.back();
}
window.addEventListener('popstate', () => {
  const top = layers.pop();
  top?.close();
});

// ---------- Hojas inferiores ----------
let sheetOnClose = null;
function openSheet(html, { onClose, onOpen } = {}) {
  const sheet = $('#sheet');
  const wasOpen = sheet.classList.contains('open');
  const inner = document.createElement('div');
  inner.innerHTML = html;
  $('#sheetBody').replaceChildren(inner);   // los oyentes viejos mueren con su contenedor
  sheet.scrollTop = 0;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('show');
  sheetOnClose = onClose || null;
  hideToast();
  if (!wasOpen) pushLayer('sheet', closeSheetNow);
  onOpen?.(inner);
}
function closeSheetNow() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('show');
  const cb = sheetOnClose; sheetOnClose = null;
  cb?.();
}
function closeSheet() {
  if (layers[layers.length - 1]?.name === 'sheet') history.back();
  else closeSheetNow();
}
$('#backdrop').addEventListener('click', closeSheet);

// ---------- Biblioteca ----------
function visibleSongs() {
  let list = songs.filter(s => !pendingDelete.has(s.id));
  if (filter === 'fav') list = list.filter(s => s.fav);
  if (query) { const q = norm(query); list = list.filter(s => norm(s.title).includes(q)); }
  const coll = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  if (settings.sort === 'az') list.sort((a, b) => coll.compare(a.title, b.title));
  else if (settings.sort === 'plays') list.sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0));
  else if (settings.sort === 'quality') list.sort((a, b) => (b.quality?.score ?? -1) - (a.quality?.score ?? -1));
  else list.sort((a, b) => b.addedAt - a.addedAt);
  return list;
}

const SORT_LABEL = { recent: 'Recientes', az: 'A–Z', plays: 'Más tocadas', quality: 'Mejor calidad' };

// ---------- Calidad ----------
const Q_VERSION = 1;
function summarizeQuality(q) {
  const f = q.features || {};
  return {
    v: Q_VERSION, score: q.score, label: q.label, pianoOnly: !!q.pianoOnly, reasons: (q.reasons || []).slice(0, 6),
    f: {
      velDistinct: f.velDistinct, gridness: f.gridness, syncFrac: f.syncFrac, chordSpreadMs: f.chordSpreadMs,
      pedalEvents: f.pedalEvents, pedalValues: f.pedalValues, tempoPerMin: f.tempoPerMin, offVelDistinct: f.offVelDistinct, software: f.software,
    },
  };
}
function analyzeBuffer(buf) {
  const midi = parseMidi(buf);
  const tl = buildTimeline(midi);
  let quality = null;
  try { quality = summarizeQuality(analyzeMidi(midi, tl)); } catch (e) { console.warn('calidad', e); }
  return { tl, quality };
}
function qBadge(q) {
  if (!q) return '';
  return `<span class="q q-${q.label}" title="${esc(LABELS[q.label].long)}">${LABELS[q.label].short} ${q.score}</span>`;
}
const pct = x => (x === null || x === undefined ? '—' : `${Math.round(x * 100)} %`);
function qualitySheet(q, title) {
  if (!q) { toast('Aún no se ha analizado esta canción'); return; }
  const f = q.f || {};
  openSheet(`<h3>${esc(title)}</h3>
    <div class="qhead q-${q.label}">
      <span class="qnum">${q.score}</span>
      <span><b>${LABELS[q.label].short}</b><small>${LABELS[q.label].long}</small></span>
    </div>
    <h4>Por qué</h4>
    <ul class="qreasons">${q.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    <h4>Datos</h4>
    <dl class="qstats">
      <dt>Fuerzas de nota distintas</dt><dd>${f.velDistinct ?? '—'}</dd>
      <dt>Ataques en rejilla exacta</dt><dd>${pct(f.gridness)}</dd>
      <dt>Acordes con notas simultáneas</dt><dd>${pct(f.syncFrac)}</dd>
      <dt>Escalonado medio de acordes</dt><dd>${f.chordSpreadMs ? `${f.chordSpreadMs} ms` : '—'}</dd>
      <dt>Pedal</dt><dd>${f.pedalEvents ? `${f.pedalEvents} movimientos, ${f.pedalValues} niveles` : 'no usa'}</dd>
      <dt>Cambios de tempo por minuto</dt><dd>${f.tempoPerMin ?? '—'}</dd>
      <dt>Velocidades al soltar tecla</dt><dd>${f.offVelDistinct ?? 0}</dd>
      ${f.software ? `<dt>Programa</dt><dd>${esc(f.software)}</dd>` : ''}
    </dl>
    <p class="foot">${q.pianoOnly ? 'Piano solo' : 'Arreglo con varios instrumentos'} · Análisis automático; puede equivocarse con archivos «humanizados» por software.</p>`);
}

function metaLine(s) {
  const parts = [formatTime(s.duration)];
  if (s.trackCount > 1) parts.push(plural(s.trackCount, 'pista', 'pistas'));
  if (s.hasDrums) parts.push('batería');
  if (s.performer) parts.push(`toca ${s.performer}`);
  return parts.join(' · ');
}

const BARS = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>';
const compact = n => new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function renderList() {
  const live = songs.filter(s => !pendingDelete.has(s.id));
  $('#countAll').textContent = live.length || '';
  document.querySelectorAll('.filter').forEach(b => b.classList.toggle('on', b.dataset.filter === filter));
  $('#sortBtn').hidden = filter === 'online' || filter === 'lists';
  $('#sortBtn').setAttribute('aria-label', `Orden: ${SORT_LABEL[settings.sort]}. Toca para cambiarlo`);
  $('#search').placeholder = filter === 'online'
    ? (online.source === 'catalog' ? 'Buscar en el catálogo: Chopin, Busoni…' : 'Buscar en BitMidi: Chopin, Ghibli…')
    : filter === 'lists' ? 'Buscar en tus listas' : 'Buscar en tu biblioteca';
  if (filter === 'online') return renderOnline();
  if (filter === 'lists') return renderLists();
  renderLibrary(live);
}

function rowState(id) {
  const isCur = current && current.id === id;
  return `${isCur ? ' is-current' : ''}${isCur && !player.playing ? ' paused' : ''}`;
}

function libRow(s) {
  const isCur = current && current.id === s.id;
  return `<li class="row${rowState(s.id)}" data-id="${s.id}">
    <button class="row-main" data-act="play" type="button">
      <span class="row-title">${isCur ? BARS : ''}<span>${esc(s.title)}</span></span>
      <span class="row-meta">${metaLine(s)}${qBadge(s.quality)}</span>
    </button>
    <button class="icon-btn fav${s.fav ? ' on' : ''}" data-act="fav" type="button" aria-label="${s.fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}" aria-pressed="${s.fav}">${icon.heart}</button>
    <button class="icon-btn" data-act="more" type="button" aria-label="Más opciones">${icon.more}</button>
  </li>`;
}

function renderLibrary(live) {
  const list = visibleSongs();
  const empty = $('#empty');
  if (!live.length && !query) {
    $('#list').innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `${keysArt}
      <h2>Tu piano, tu repertorio</h2>
      <p>Añade archivos MIDI o búscalos online, y Pianola los tocará en tu FP-10 por Bluetooth.</p>
      <div class="btns">
        <button class="btn primary" data-empty="add" type="button">${icon.plus} Añadir MIDI</button>
        <button class="btn ghost" data-empty="explore" type="button">${icon.search} Explorar online</button>
        <button class="btn ghost" data-empty="demo" type="button">Probar con una demo</button>
      </div>
      <p class="hint">También puedes compartir un .mid desde WhatsApp, Drive o Descargas y elegir Pianola.</p>`;
    return;
  }
  if (!list.length) {
    $('#list').innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = filter === 'fav' && !query
      ? '<h2>Sin favoritas aún</h2><p>Toca el corazón de una canción para tenerla a mano aquí.</p>'
      : `<h2>Nada por aquí</h2><p>Ninguna canción de tu biblioteca coincide con «${esc(query)}».</p>
         <div class="btns"><button class="btn ghost" data-empty="explore" type="button">${icon.search} Buscar en BitMidi</button></div>`;
    return;
  }
  empty.hidden = true;
  const hint = query.length >= 2
    ? `<li class="online-hint"><button type="button" data-act="go-online">${icon.search}<span>Buscar «${esc(query)}» en BitMidi</span></button></li>` : '';
  $('#list').innerHTML = list.map(libRow).join('') + hint;
}

// ---------- Explorar: repertorio online ----------
function savedFor(it) {
  return it ? songs.find(s => s.source === it.source && s.sourceId === it.sourceId && !pendingDelete.has(s.id)) : null;
}

function qOf(it) {
  return savedFor(it)?.quality || qcache.get(keyOf(it)) || it.quality || null;
}
function saveQCache() {
  clearTimeout(qSaveTimer);
  qSaveTimer = setTimeout(() => {
    try { localStorage.setItem('pianola.qcache', JSON.stringify(Object.fromEntries([...qcache.entries()].slice(-3000)))); } catch {}
  }, 800);
}
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { if (filter === 'online') renderList(); }, 150);
}
function pumpAnalysis() {
  if (!settings.analyzeOnline || filter !== 'online' || online.source !== 'bitmidi') return;
  while (qActive < 3) {
    const it = online.results.find(r => { const k = keyOf(r); return !qOf(r) && !analyzing.has(k) && !qfailed.has(k); });
    if (!it) return;
    const key = keyOf(it);
    analyzing.add(key);
    qActive++;
    (async () => {
      try {
        let buf = onlineCache.get(key);
        if (!buf) {
          buf = await downloadOnline(it);
          onlineCache.set(key, buf);
          if (onlineCache.size > 40) onlineCache.delete(onlineCache.keys().next().value);
        }
        const { tl, quality } = analyzeBuffer(buf);
        if (quality) { qcache.set(key, { ...quality, d: Math.round(tl.duration) }); saveQCache(); }
        else qfailed.add(key);
      } catch {
        qfailed.add(key);
      } finally {
        analyzing.delete(key);
        qActive--;
        scheduleRender();
        pumpAnalysis();
      }
    })();
  }
}

function onlineRow(it) {
  const key = keyOf(it);
  const saved = savedFor(it);
  const id = saved ? saved.id : key;
  const isCur = current && current.id === id;
  const loading = online.loadingKey === key;
  const q = qOf(it);
  const known = saved || transientMeta.get(key) || (q?.d ? { duration: q.d } : null);
  const meta = loading ? 'Descargando…' : (it.source === 'cat' ? [
    formatTime((it.durSec || 0) * 1000),
    it.performer ? `toca ${esc(it.performer)}` : esc(it.sourceName),
    saved ? 'en tu biblioteca' : null,
  ] : [
    known ? formatTime(known.duration) : null,
    it.plays ? `${compact(it.plays)} reproducciones` : null,
    saved ? 'en tu biblioteca' : null,
  ]).filter(Boolean).join(' · ')
    + (q ? qBadge(q) : analyzing.has(key) ? '<span class="q q-wait">analizando…</span>' : '');
  return `<li class="row${rowState(id)}${loading ? ' loading' : ''}" data-key="${key}">
    <button class="row-main" data-act="oplay" type="button">
      <span class="row-title">${isCur ? BARS : ''}<span>${esc(it.title)}</span></span>
      <span class="row-meta">${meta}</span>
    </button>
    <button class="icon-btn save${saved ? ' on' : ''}" data-act="osave" type="button" aria-label="${saved ? 'Ya está en tu biblioteca' : 'Guardar en la biblioteca'}">${saved ? icon.check : icon.plus}</button>
  </li>`;
}

function sourceSwitch() {
  const b = (src, label) => `<button type="button" data-act="src" data-src="${src}" class="${online.source === src ? 'on' : ''}" aria-pressed="${online.source === src}">${label}</button>`;
  return `<li class="src-switch">${b('catalog', 'Catálogo')}${b('bitmidi', 'BitMidi')}</li>`;
}

// una versión por obra (la mejor puntuada), para no repetir la misma pieza
function curatedItems(c, list = cat.data.items) {
  const best = new Map();
  for (const it of list) {
    if (!c.test(it)) continue;
    const k = `${it.author}|${it.work}`;
    if (!best.has(k) || best.get(k).quality.score < it.quality.score) best.set(k, it);
  }
  return [...best.values()];
}

function catalogList() {
  if (!cat.data) return [];
  let list = searchCatalog(cat.data, { q: query, col: cat.col, composer: cat.composer });
  if (cat.curated) {
    const c = CURATED.find(x => x.id === cat.curated);
    if (c) list = curatedItems(c, list);
  }
  if (online.onlyPerformed) list = list.filter(it => it.quality.label === 'performed');
  if (online.sort === 'quality') list = list.slice().sort((a, b) => b.quality.score - a.quality.score);
  return list;
}

function currentOnlineList() {
  if (online.source === 'catalog') return catalogList();
  let shown = online.results.slice();
  if (online.onlyPerformed) shown = shown.filter(it => qOf(it)?.label === 'performed');
  if (online.sort === 'quality') shown.sort((a, b) => (qOf(b)?.score ?? -1) - (qOf(a)?.score ?? -1));
  return shown;
}

function ensureCatalog() {
  if (cat.data || cat.loading) return;
  cat.loading = true;
  cat.error = null;
  loadCatalog()
    .then(d => { cat.data = d; d.items.forEach(it => onlineIndex.set(keyOf(it), it)); })
    .catch(e => { cat.error = e.message || String(e); })
    .finally(() => { cat.loading = false; if (filter === 'online') renderList(); });
}

function renderCatalog() {
  const list = $('#list');
  const empty = $('#empty');
  empty.hidden = true;
  ensureCatalog();
  if (!cat.data) {
    list.innerHTML = sourceSwitch() + (cat.error
      ? `<li class="pl-empty">No se pudo cargar el catálogo. <button class="btn ghost" type="button" data-act="catretry">Reintentar</button></li>`
      : '<li class="pl-empty loading">Cargando catálogo…</li>');
    return;
  }
  const browsing = !query && !cat.col && !cat.composer && !cat.curated;
  if (browsing) {
    const d = cat.data;
    list.innerHTML = sourceSwitch()
      + `<li class="list-note">${d.items.length.toLocaleString('es-ES')} obras de colecciones abiertas, con su calidad analizada.</li>`
      + d.collections.map(c => `<li class="col-card"><button type="button" data-act="catcol" data-col="${c.id}">
          <span class="col-name">${esc(c.name)} <small>${c.count.toLocaleString('es-ES')}</small></span>
          <span class="col-desc">${esc(c.full)}</span>
          <span class="col-lic">${esc(c.genre)} · licencia ${esc(c.license)}</span>
        </button></li>`).join('')
      + `<li class="list-head">Colecciones</li>`
      + CURATED.map(c => {
        const n = curatedItems(c).length;
        return n ? `<li class="col-card col-sm"><button type="button" data-act="catcur" data-cur="${c.id}">
          <span class="col-name">${esc(c.name)} <small>${n}</small></span><span class="col-lic">${esc(c.desc)}</span></button></li>` : '';
      }).join('')
      + `<li class="list-head">Compositores</li>
         <li class="list-tools">${d.composers.slice(0, 18).map(c => `<button class="chip-s" type="button" data-act="catcomp" data-comp="${esc(c.name)}">${esc(c.name.split(' ').pop())} <small>${c.n}</small></button>`).join('')}</li>`;
    return;
  }
  const all = catalogList();
  const shown = all.slice(0, cat.limit);
  const crumb = cat.curated ? CURATED.find(c => c.id === cat.curated)?.name
    : cat.col ? cat.data.collections.find(c => c.id === cat.col)?.name : cat.composer || '';
  list.innerHTML = sourceSwitch()
    + `<li class="list-note"><button class="back" type="button" data-act="cathome">${icon.back}Catálogo</button>${crumb ? ` · <b>${esc(crumb)}</b>` : ''} · ${all.length.toLocaleString('es-ES')} obra${all.length === 1 ? '' : 's'}</li>
       <li class="list-tools">
         ${all.length ? `<button class="chip-s on" type="button" data-act="catplay">▶ Reproducir</button>` : ''}
         <button class="chip-s${online.sort === 'quality' ? ' on' : ''}" type="button" data-act="osort">${online.sort === 'quality' ? 'Orden: mejor calidad' : 'Orden: relevancia'}</button>
         <button class="chip-s${online.onlyPerformed ? ' on' : ''}" type="button" data-act="operf" aria-pressed="${online.onlyPerformed}">Solo interpretadas</button>
       </li>`
    + (shown.length ? shown.map(onlineRow).join('') : `<li class="pl-empty">Nada en el catálogo coincide${query ? ` con «${esc(query)}»` : ''}. Prueba en BitMidi.</li>`)
    + (all.length > shown.length ? `<li class="more-row"><button class="btn ghost block" data-act="catmore" type="button">Ver más (${(all.length - shown.length).toLocaleString('es-ES')})</button></li>` : '');
}

function renderOnline() {
  if (online.source === 'catalog') return renderCatalog();
  const list = $('#list');
  const empty = $('#empty');
  if (!online.q) {
    list.innerHTML = sourceSwitch();
    empty.hidden = false;
    empty.innerHTML = `<h2>Explora el repertorio</h2>
      <p>Más de 100.000 MIDIs públicos de BitMidi. Toca uno para oírlo en el piano y ＋ para guardarlo.</p>
      <div class="suggest">${SUGGESTIONS.map(q => `<button class="chip-s" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <p class="hint">Muchos son arreglos de canciones con derechos de autor: están para escucharlos tú.</p>`;
    return;
  }
  if (!online.results.length) {
    list.innerHTML = sourceSwitch();
    empty.hidden = false;
    if (online.loading) empty.innerHTML = `<p class="loading">Buscando «${esc(online.q)}» en BitMidi…</p>`;
    else if (online.error) empty.innerHTML = `<h2>Sin conexión con BitMidi</h2>
      <p>Comprueba que tienes internet e inténtalo de nuevo.</p>
      <div class="btns"><button class="btn ghost" type="button" data-empty="retry">Reintentar</button></div>`;
    else empty.innerHTML = `<h2>Sin resultados</h2><p>Prueba con otras palabras, el título en inglés o el nombre del compositor.</p>`;
    return;
  }
  empty.hidden = true;
  const shown = currentOnlineList();
  const pending = settings.analyzeOnline ? online.results.filter(it => !qOf(it) && !qfailed.has(keyOf(it))).length : 0;
  const note = `<li class="list-note">${online.total.toLocaleString('es-ES')} resultado${online.total === 1 ? '' : 's'} en <a href="https://bitmidi.com" target="_blank" rel="noopener">BitMidi</a>${pending ? ` · analizando ${pending}…` : ''}</li>
    <li class="list-tools">
      <button class="chip-s${online.sort === 'quality' ? ' on' : ''}" type="button" data-act="osort">${online.sort === 'quality' ? 'Orden: mejor calidad' : 'Orden: relevancia'}</button>
      <button class="chip-s${online.onlyPerformed ? ' on' : ''}" type="button" data-act="operf" aria-pressed="${online.onlyPerformed}">Solo interpretadas</button>
    </li>`;
  const none = online.onlyPerformed && !shown.length
    ? `<li class="pl-empty">${pending ? 'Buscando interpretaciones reales entre los resultados…' : 'Ninguna interpretación real en estos resultados. Prueba a cargar más o con otra búsqueda.'}</li>` : '';
  const more = online.loading
    ? '<li class="more-row"><p class="list-note loading">Cargando…</p></li>'
    : online.page + 1 < online.pageTotal
      ? '<li class="more-row"><button class="btn ghost block" data-act="omore" type="button">Cargar más</button></li>' : '';
  list.innerHTML = sourceSwitch() + note + shown.map(onlineRow).join('') + none + more;
  pumpAnalysis();
}

function scheduleOnlineSearch(now = false) {
  clearTimeout(onlineTimer);
  const q = query;
  if (q.length < 2) {
    online.ctrl?.abort();
    Object.assign(online, { q: '', results: [], total: 0, pageTotal: 0, page: 0, loading: false, error: null });
    renderList();
    return;
  }
  if (q === online.q && !online.error && (online.results.length || online.loading)) { renderList(); return; }
  onlineTimer = setTimeout(() => runOnlineSearch(q, 0), now ? 0 : 450);
}

async function runOnlineSearch(q, page) {
  online.ctrl?.abort();
  const ctrl = new AbortController();
  online.ctrl = ctrl;
  if (page === 0) Object.assign(online, { q, results: [], total: 0, pageTotal: 0, page: 0 });
  online.loading = true;
  online.error = null;
  renderList();
  try {
    const r = await searchOnline(q, page, { signal: ctrl.signal });
    r.results.forEach(it => onlineIndex.set(keyOf(it), it));
    const seen = new Set(online.results.map(keyOf));
    online.results = page === 0 ? r.results : online.results.concat(r.results.filter(it => !seen.has(keyOf(it))));
    if (page === 0 || r.total) { online.total = r.total; online.pageTotal = r.pageTotal; }
    if (r.results.length) online.page = page;
    else online.pageTotal = Math.min(online.pageTotal, page);
  } catch (e) {
    if (e.name === 'AbortError') return;
    online.error = e.message || String(e);
    if (online.results.length) toast('No se pudieron cargar más resultados');
  } finally {
    if (online.ctrl === ctrl) { online.loading = false; renderList(); }
  }
}

async function fetchOnlineData(key) {
  if (onlineCache.has(key)) return onlineCache.get(key);
  const it = onlineIndex.get(key);
  if (!it) throw new Error('canción desconocida');
  online.loadingKey = key;
  renderList();
  try {
    const buf = await downloadOnline(it);
    onlineCache.set(key, buf);
    if (onlineCache.size > 40) onlineCache.delete(onlineCache.keys().next().value);
    return buf;
  } finally {
    if (online.loadingKey === key) online.loadingKey = null;
    renderList();
  }
}

function transientFrom(key, tl) {
  const it = onlineIndex.get(key);
  const m = {
    id: key, title: it?.title || 'Canción online', duration: tl.duration, noteCount: tl.noteCount,
    trackCount: tl.trackCount, hasDrums: tl.hasDrums, transient: true, quality: qcache.get(key) || it?.quality || null,
    sourceName: it?.sourceName, performer: it?.performer || undefined,
    source: it?.source, sourceId: it?.sourceId, sourceUrl: it?.pageUrl,
  };
  transientMeta.set(key, m);
  return m;
}

function playOnline(key) {
  const it = onlineIndex.get(key);
  if (!it) return;
  const id = savedFor(it)?.id || key;
  if (current && current.id === id && player.tl) { openPlayer(); if (!player.playing) togglePlay(); return; }
  const ids = currentOnlineList().map(r => savedFor(r)?.id || keyOf(r));
  queueName = null;
  startQueue(ids, Math.max(0, ids.indexOf(id)));
}

async function saveOnline(key, { quiet = false } = {}) {
  const it = onlineIndex.get(key);
  if (!it) return null;
  const existing = savedFor(it);
  if (existing) { if (!quiet) toast('Ya está en tu biblioteca'); return existing; }
  try {
    const buf = await fetchOnlineData(key);
    const extra = { source: it.source, sourceId: it.sourceId, sourceUrl: it.pageUrl, sourceName: it.sourceName };
    if (it.performer) extra.performer = it.performer;
    const r = await addBuffer(buf, it.name, it.title, extra);
    if (r === 'bad') { toast('Ese archivo no es un MIDI válido'); return null; }
    if (r === 'dup') { if (!quiet) toast('Ya está en tu biblioteca'); return savedFor(it); }
    // si estaba sonando como canción temporal, pasa a ser la de la biblioteca
    if (current && current.id === key) current = r;
    queue = queue.map(x => (x === key ? r.id : x));
    baseQueue = baseQueue.map(x => (x === key ? r.id : x));
    transientMeta.delete(key);
    persistStorage();
    if (!quiet) toast('Guardada en tu biblioteca', { action: 'Añadir a lista', onAction: () => addToListSheet(r.id) });
    return r;
  } catch {
    toast(`No se pudo descargar de ${it.sourceName || 'internet'}`);
    return null;
  } finally {
    renderList();
    updateNowPlaying();
  }
}

function goOnline() {
  filter = 'online';
  if (online.source === 'bitmidi') scheduleOnlineSearch(true);
  renderList();
  scrollTo(0, 0);
}

// ---------- Listas ----------
function playlistSongs(pl) {
  return pl.songIds.map(id => songs.find(s => s.id === id)).filter(s => s && !pendingDelete.has(s.id));
}
function plMeta(pl) {
  const ss = playlistSongs(pl);
  if (!ss.length) return 'Vacía';
  return `${plural(ss.length, 'canción', 'canciones')} · ${formatTime(ss.reduce((a, s) => a + (s.duration || 0), 0))}`;
}
async function savePlaylist(pl) {
  pl.updatedAt = Date.now();
  try { await playlistStore.put(pl); } catch (e) { console.warn(e); }
}

function renderLists() {
  const list = $('#list');
  const empty = $('#empty');
  const live = playlists.filter(p => !pendingListDelete.has(p.id));
  const open = openListId && live.find(p => p.id === openListId);
  if (open) return renderPlaylist(open);
  openListId = null;
  if (!live.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<h2>Tus listas</h2>
      <p>Junta varias canciones y Pianola las tocará una detrás de otra. Ideal para dormirte con el piano.</p>
      <div class="btns"><button class="btn primary" type="button" data-empty="lnew">${icon.plus} Crear una lista</button></div>`;
    return;
  }
  empty.hidden = true;
  let shown = live.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (query) { const q = norm(query); shown = shown.filter(p => norm(p.name).includes(q)); }
  list.innerHTML = `<li class="online-hint"><button type="button" data-act="lnew">${icon.plus}<span>Nueva lista</span></button></li>`
    + shown.map(p => `<li class="row" data-pl="${p.id}">
      <button class="row-main" data-act="lopen" type="button">
        <span class="row-title">${queueName === p.name && current ? BARS : ''}<span>${esc(p.name)}</span></span>
        <span class="row-meta">${plMeta(p)}</span>
      </button>
      <button class="icon-btn lplay" data-act="lplay" type="button" aria-label="Reproducir «${esc(p.name)}»">${icon.playSmall}</button>
      <button class="icon-btn" data-act="lmore" type="button" aria-label="Opciones de la lista">${icon.more}</button>
    </li>`).join('')
    + (shown.length ? '' : `<li class="pl-empty">Ninguna lista coincide con «${esc(query)}».</li>`);
}

function renderPlaylist(pl) {
  $('#empty').hidden = true;
  const ss = playlistSongs(pl);
  $('#list').innerHTML = `<li class="pl-head" data-pl="${pl.id}">
      <button class="back" type="button" data-act="lback">${icon.back}Listas</button>
      <h2>${esc(pl.name)}</h2>
      <p>${plMeta(pl)}</p>
      <div class="btns-row">
        <button class="btn primary" type="button" data-act="lplay"${ss.length ? '' : ' disabled'}>${icon.playSmall} Reproducir</button>
        <button class="btn ghost" type="button" data-act="ladd">${icon.plus} Añadir</button>
      </div>
    </li>`
    + (ss.length ? ss.map((s, i) => {
      const isCur = current && current.id === s.id;
      return `<li class="row${rowState(s.id)}" data-id="${s.id}" data-pl="${pl.id}">
        <span class="num">${i + 1}</span>
        <button class="row-main" data-act="pplay" type="button">
          <span class="row-title">${isCur ? BARS : ''}<span>${esc(s.title)}</span></span>
          <span class="row-meta">${metaLine(s)}${qBadge(s.quality)}</span>
        </button>
        <button class="icon-btn" data-act="pmore" type="button" aria-label="Opciones de la canción en la lista">${icon.more}</button>
      </li>`;
    }).join('') : '<li class="pl-empty">Lista vacía. Toca «Añadir» para elegir canciones.</li>');
}

function playPlaylist(plId, startId = null) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  const ids = playlistSongs(pl).map(s => s.id);
  if (!ids.length) { pickSongsSheet(plId); return; }
  if (startId && current && current.id === startId && player.tl && queueName === pl.name) {
    openPlayer(); if (!player.playing) togglePlay(); return;
  }
  queueName = pl.name;
  startQueue(ids, startId ? Math.max(0, ids.indexOf(startId)) : 0);
}

function newPlaylistSheet(addSongId = null) {
  const n = playlists.length + 1;
  openSheet(`<h3>Nueva lista</h3>
    <form id="plForm">
      <input class="field" id="plName" maxlength="80" placeholder="Para dormir" autocomplete="off" aria-label="Nombre de la lista">
      <div class="btns-row">
        <button class="btn ghost" type="button" data-cancel>Cancelar</button>
        <button class="btn primary" type="submit">Crear</button>
      </div>
    </form>`, {
    onOpen: body => {
      const input = body.querySelector('#plName');
      setTimeout(() => input.focus(), 250);
      body.querySelector('[data-cancel]').onclick = closeSheet;
      body.querySelector('#plForm').onsubmit = async e => {
        e.preventDefault();
        const name = input.value.trim() || `Lista ${n}`;
        const pl = { id: newId(), name, songIds: addSongId ? [addSongId] : [], createdAt: Date.now() };
        playlists.push(pl);
        await savePlaylist(pl);
        if (addSongId) { closeSheet(); renderList(); toast(`Añadida a «${name}»`); return; }
        filter = 'lists';
        openListId = pl.id;
        renderList();
        pickSongsSheet(pl.id);
      };
    },
  });
}

function pickSongsSheet(plId) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  const coll = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const lib = songs.filter(s => !pendingDelete.has(s.id)).sort((a, b) => coll.compare(a.title, b.title));
  if (!lib.length) {
    openSheet(`<h3>Tu biblioteca está vacía</h3>
      <p class="sub">Añade MIDIs o guarda canciones desde Explorar, y luego vuelve a esta lista.</p>
      <div class="btns-row"><button class="btn ghost" type="button" data-a="explore">Explorar</button>
      <button class="btn primary" type="button" data-a="add">Añadir MIDI</button></div>`, {
      onOpen: body => body.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'explore') { closeSheet(); goOnline(); }
        else if (a === 'add') { closeSheet(); $('#fileInput').click(); }
      }),
    });
    return;
  }
  const inList = new Set(pl.songIds);
  const picked = [];
  openSheet(`<h3>Añadir a «${esc(pl.name)}»</h3>
    <input class="field" type="search" id="pickSearch" placeholder="Buscar en tu biblioteca" autocomplete="off" aria-label="Buscar">
    <ul class="pick-list">${lib.map(s => `<li><label class="pick${inList.has(s.id) ? ' in' : ''}" data-t="${esc(norm(s.title))}">
      <input type="checkbox" value="${s.id}"${inList.has(s.id) ? ' checked disabled' : ''}>
      <span class="txt"><b>${esc(s.title)}</b><small>${formatTime(s.duration)}${inList.has(s.id) ? ' · ya está en la lista' : ''}</small></span>
    </label></li>`).join('')}</ul>
    <div class="sheet-foot"><button class="btn primary block" type="button" data-a="done" disabled>Elige canciones</button></div>`, {
    onOpen: body => {
      const done = body.querySelector('[data-a="done"]');
      body.addEventListener('change', e => {
        const cb = e.target;
        if (cb.type !== 'checkbox') return;
        if (cb.checked) picked.push(cb.value);
        else picked.splice(picked.indexOf(cb.value), 1);
        done.disabled = !picked.length;
        done.textContent = picked.length ? `Añadir ${plural(picked.length, 'canción', 'canciones')}` : 'Elige canciones';
      });
      body.querySelector('#pickSearch').addEventListener('input', e => {
        const q = norm(e.target.value.trim());
        body.querySelectorAll('.pick').forEach(l => { l.parentElement.hidden = !!q && !l.dataset.t.includes(q); });
      });
      done.addEventListener('click', async () => {
        const add = picked.filter(x => !pl.songIds.includes(x));
        pl.songIds.push(...add);
        await savePlaylist(pl);
        closeSheet();
        renderList();
        toast(`${plural(add.length, 'canción añadida', 'canciones añadidas')} a «${pl.name}»`);
      });
    },
  });
}

function addToListSheet(songId) {
  const s = songs.find(x => x.id === songId);
  if (!s) return;
  const lists = playlists.filter(p => !pendingListDelete.has(p.id));
  openSheet(`<h3>Añadir a una lista</h3>
    <p class="sub">${esc(s.title)}</p>
    <ul class="menu list-pick">
      ${lists.map(p => `<li><button type="button" data-l="${p.id}"><span>${esc(p.name)}</span>
        <small>${p.songIds.includes(songId) ? 'ya está' : plMeta(p)}</small></button></li>`).join('')}
      <li><button type="button" data-l="new" class="accent-text">＋ Nueva lista…</button></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', async e => {
      const l = e.target.closest('[data-l]')?.dataset.l;
      if (!l) return;
      if (l === 'new') { newPlaylistSheet(songId); return; }
      const pl = playlists.find(p => p.id === l);
      if (!pl) return;
      if (!pl.songIds.includes(songId)) { pl.songIds.push(songId); await savePlaylist(pl); }
      closeSheet();
      renderList();
      toast(`Añadida a «${pl.name}»`);
    }),
  });
}

function playlistMenu(plId) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  openSheet(`<h3>${esc(pl.name)}</h3><p class="sub">${plMeta(pl)}</p>
    <ul class="menu">
      <li><button type="button" data-m="play">Reproducir</button></li>
      <li><button type="button" data-m="add">Añadir canciones</button></li>
      <li><button type="button" data-m="rename">Renombrar</button></li>
      <li><button type="button" data-m="delete" class="danger">Eliminar lista</button></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', e => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (m === 'play') { closeSheet(); playPlaylist(plId); }
      else if (m === 'add') pickSongsSheet(plId);
      else if (m === 'rename') renamePlaylistSheet(plId);
      else if (m === 'delete') { closeSheet(); deletePlaylist(plId); }
    }),
  });
}

function renamePlaylistSheet(plId) {
  const pl = playlists.find(p => p.id === plId);
  openSheet(`<h3>Renombrar lista</h3>
    <form id="rnForm">
      <input class="field" id="rnInput" value="${esc(pl.name)}" maxlength="80" autocomplete="off" aria-label="Nombre">
      <div class="btns-row"><button class="btn ghost" type="button" data-cancel>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, {
    onOpen: body => {
      const input = body.querySelector('#rnInput');
      setTimeout(() => { input.focus(); input.select(); }, 250);
      body.querySelector('[data-cancel]').onclick = closeSheet;
      body.querySelector('#rnForm').onsubmit = async e => {
        e.preventDefault();
        const name = input.value.trim();
        if (name) {
          if (queueName === pl.name) queueName = name;
          pl.name = name;
          await savePlaylist(pl);
          renderList();
          updateNowPlaying();
        }
        closeSheet();
      };
    },
  });
}

function deletePlaylist(plId) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  if (openListId === plId) openListId = null;
  const timer = setTimeout(async () => {
    pendingListDelete.delete(plId);
    playlists = playlists.filter(p => p.id !== plId);
    try { await playlistStore.remove(plId); } catch {}
  }, 5000);
  pendingListDelete.set(plId, timer);
  renderList();
  toast(`Lista «${pl.name}» eliminada`, {
    action: 'Deshacer', ms: 5000,
    onAction: () => { clearTimeout(pendingListDelete.get(plId)); pendingListDelete.delete(plId); renderList(); },
  });
}

function playlistSongMenu(plId, songId) {
  const pl = playlists.find(p => p.id === plId);
  const s = songs.find(x => x.id === songId);
  if (!pl || !s) return;
  const idx = pl.songIds.indexOf(songId);
  openSheet(`<h3>${esc(s.title)}</h3><p class="sub">En «${esc(pl.name)}» · ${metaLine(s)}</p>
    <ul class="menu">
      <li><button type="button" data-m="play">Reproducir desde aquí</button></li>
      ${idx > 0 ? '<li><button type="button" data-m="up">Subir</button></li>' : ''}
      ${idx < pl.songIds.length - 1 ? '<li><button type="button" data-m="down">Bajar</button></li>' : ''}
      <li><button type="button" data-m="remove" class="danger">Quitar de la lista</button></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', async e => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      closeSheet();
      if (m === 'play') { playPlaylist(plId, songId); return; }
      const i = pl.songIds.indexOf(songId);
      if (m === 'up' && i > 0) [pl.songIds[i - 1], pl.songIds[i]] = [pl.songIds[i], pl.songIds[i - 1]];
      else if (m === 'down' && i < pl.songIds.length - 1) [pl.songIds[i + 1], pl.songIds[i]] = [pl.songIds[i], pl.songIds[i + 1]];
      else if (m === 'remove') pl.songIds.splice(i, 1);
      await savePlaylist(pl);
      renderList();
    }),
  });
}

$('#list').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const holder = btn.closest('[data-id],[data-key],[data-pl]');
  const id = holder?.dataset.id;
  const key = holder?.dataset.key;
  const plId = holder?.dataset.pl;
  switch (btn.dataset.act) {
    case 'play': {
      const ids = visibleSongs().map(s => s.id);
      if (current && current.id === id && player.tl) { openPlayer(); if (!player.playing) togglePlay(); return; }
      queueName = null;
      startQueue(ids, ids.indexOf(id));
      break;
    }
    case 'fav': toggleFav(id); break;
    case 'more': songMenu(id); break;
    case 'go-online': goOnline(); break;
    case 'oplay': playOnline(key); break;
    case 'osave': saveOnline(key); break;
    case 'omore': runOnlineSearch(online.q, online.page + 1); break;
    case 'src':
      online.source = btn.dataset.src;
      settings.exploreSource = online.source; saveSettings();
      if (online.source === 'bitmidi') scheduleOnlineSearch(true);
      renderList();
      break;
    case 'catcol': cat.col = btn.dataset.col; cat.composer = null; cat.curated = null; cat.limit = 60; renderList(); scrollTo(0, 0); break;
    case 'catcomp': cat.composer = btn.dataset.comp; cat.col = null; cat.curated = null; cat.limit = 60; renderList(); scrollTo(0, 0); break;
    case 'catcur': cat.curated = btn.dataset.cur; cat.col = null; cat.composer = null; cat.limit = 60; renderList(); scrollTo(0, 0); break;
    case 'catplay': {
      const list = catalogList();
      if (!list.length) break;
      const ids = list.map(r => savedFor(r)?.id || keyOf(r));
      queueName = cat.curated ? CURATED.find(c => c.id === cat.curated)?.name : null;
      startQueue(ids, 0);
      break;
    }
    case 'cathome': cat.col = null; cat.composer = null; cat.curated = null; cat.limit = 60; if (query) { query = ''; $('#search').value = ''; } renderList(); break;
    case 'catmore': cat.limit += 60; renderList(); break;
    case 'catretry': ensureCatalog(); renderList(); break;
    case 'osort': online.sort = online.sort === 'quality' ? 'relevance' : 'quality'; renderList(); break;
    case 'operf': online.onlyPerformed = !online.onlyPerformed; renderList(); break;
    case 'lnew': newPlaylistSheet(); break;
    case 'lopen': openListId = plId; renderList(); scrollTo(0, 0); break;
    case 'lback': openListId = null; renderList(); break;
    case 'lplay': playPlaylist(plId); break;
    case 'lmore': playlistMenu(plId); break;
    case 'ladd': pickSongsSheet(plId); break;
    case 'pplay': playPlaylist(plId, id); break;
    case 'pmore': playlistSongMenu(plId, id); break;
  }
});

$('#empty').addEventListener('click', e => {
  const chip = e.target.closest('[data-q]');
  if (chip) {
    $('#search').value = chip.dataset.q;
    query = chip.dataset.q;
    scheduleOnlineSearch(true);
    return;
  }
  const b = e.target.closest('[data-empty]');
  if (!b) return;
  const a = b.dataset.empty;
  if (a === 'add') $('#fileInput').click();
  else if (a === 'demo') addDemo();
  else if (a === 'explore') goOnline();
  else if (a === 'retry') runOnlineSearch(online.q || query, 0);
  else if (a === 'lnew') newPlaylistSheet();
});

document.querySelectorAll('.filter').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.filter === 'lists' && filter === 'lists') openListId = null;
  filter = b.dataset.filter;
  if (filter === 'online' && online.source === 'bitmidi') scheduleOnlineSearch(true);
  renderList();
}));
$('#sortBtn').addEventListener('click', () => {
  const order = ['recent', 'az', 'plays', 'quality'];
  settings.sort = order[(order.indexOf(settings.sort) + 1) % order.length];
  saveSettings();
  renderList();
  toast(`Orden: ${SORT_LABEL[settings.sort]}`, { ms: 1400 });
});
$('#search').addEventListener('input', e => {
  query = e.target.value.trim();
  if (filter === 'online' && online.source === 'bitmidi') scheduleOnlineSearch();
  else { cat.limit = 60; renderList(); }
});
$('#search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.target.blur();
  if (filter === 'online' && online.source === 'bitmidi') scheduleOnlineSearch(true);
});

async function toggleFav(id) {
  const s = songs.find(x => x.id === id);
  if (!s) return;
  s.fav = !s.fav;
  renderList();
  try { await library.update(id, { fav: s.fav }); } catch {}
}

async function showOnlineQuality(key) {
  const it = onlineIndex.get(key);
  let q = qcache.get(key);
  if (!q || !q.reasons?.length) {
    try {
      const { tl, quality } = analyzeBuffer(await fetchOnlineData(key));
      if (quality) { q = { ...quality, d: Math.round(tl.duration) }; qcache.set(key, q); saveQCache(); }
    } catch { toast('No se pudo descargar para analizarla'); return; }
  }
  qualitySheet(q || it?.quality, it?.title || '');
}

function onlineMenu(key) {
  const it = onlineIndex.get(key);
  const m = transientMeta.get(key);
  if (!it && !m) return;
  const url = it?.pageUrl || m?.sourceUrl || 'https://bitmidi.com';
  openSheet(`<h3>${esc(it?.title || m?.title)}</h3>
    <p class="sub">${esc(it?.sourceName || 'Online')}${m ? ` · ${metaLine(m)}` : ''} · sin guardar</p>
    <ul class="menu">
      <li><button type="button" data-m="save">Guardar en la biblioteca</button></li>
      <li><button type="button" data-m="list">Guardar y añadir a una lista…</button></li>
      ${qOf(it || {}) ? `<li><button type="button" data-m="quality">Ficha de calidad · ${LABELS[qOf(it).label].short} ${qOf(it).score}</button></li>` : ''}
      <li><a href="${esc(url)}" target="_blank" rel="noopener">Ver en ${esc(it?.sourceName || 'la fuente')} ↗</a></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', async e => {
      const a = e.target.closest('[data-m]')?.dataset.m;
      if (a === 'save') { closeSheet(); saveOnline(key); }
      else if (a === 'quality') showOnlineQuality(key);
      else if (a === 'list') { const r = await saveOnline(key, { quiet: true }); if (r) addToListSheet(r.id); else closeSheet(); }
    }),
  });
}

function songMenu(id) {
  if (isOnlineId(id)) return onlineMenu(id);
  const s = songs.find(x => x.id === id);
  if (!s) return;
  openSheet(`<h3>${esc(s.title)}</h3>
    <p class="sub">${metaLine(s)} · ${plural(s.noteCount, 'nota', 'notas')}</p>
    <ul class="menu">
      <li><button type="button" data-m="play">Reproducir</button></li>
      <li><button type="button" data-m="list">Añadir a una lista…</button></li>
      <li><button type="button" data-m="quality">Ficha de calidad${s.quality ? ` · ${LABELS[s.quality.label].short} ${s.quality.score}` : ''}</button></li>
      <li><button type="button" data-m="fav">${s.fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}</button></li>
      <li><button type="button" data-m="rename">Renombrar</button></li>
      ${s.sourceUrl ? `<li><a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">Ver en ${esc(s.sourceName || 'BitMidi')} ↗</a></li>` : ''}
      <li><button type="button" data-m="delete" class="danger">Eliminar de la biblioteca</button></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', e => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      if (m === 'play') { closeSheet(); const ids = visibleSongs().map(x => x.id); queueName = null; startQueue(ids, Math.max(0, ids.indexOf(id))); }
      else if (m === 'list') addToListSheet(id);
      else if (m === 'quality') qualitySheet(s.quality, s.title);
      else if (m === 'fav') { closeSheet(); toggleFav(id); }
      else if (m === 'rename') renameSheet(id);
      else if (m === 'delete') { closeSheet(); removeSong(id); }
    }),
  });
}

function renameSheet(id) {
  const s = songs.find(x => x.id === id);
  openSheet(`<h3>Renombrar</h3>
    <form id="renameForm">
      <input class="field" id="renameInput" value="${esc(s.title)}" maxlength="120" autocomplete="off" aria-label="Título">
      <div class="btns-row">
        <button class="btn ghost" type="button" data-cancel>Cancelar</button>
        <button class="btn primary" type="submit">Guardar</button>
      </div>
    </form>`, {
    onOpen: body => {
      const input = body.querySelector('#renameInput');
      setTimeout(() => { input.focus(); input.select(); }, 250);
      body.querySelector('[data-cancel]').onclick = closeSheet;
      body.querySelector('#renameForm').onsubmit = async e => {
        e.preventDefault();
        const title = input.value.trim();
        if (title) {
          s.title = title;
          try { await library.update(id, { title }); } catch {}
          if (current?.id === id) { current.title = title; updateNowPlaying(); }
          renderList();
        }
        closeSheet();
      };
    },
  });
}

function removeSong(id) {
  const s = songs.find(x => x.id === id);
  if (!s) return;
  if (current?.id === id) {
    player.unload();
    current = null;
    queue = queue.filter(x => x !== id);
    qi = -1;
    updateNowPlaying();
    closePlayer();
  }
  const timer = setTimeout(async () => {
    pendingDelete.delete(id);
    songs = songs.filter(x => x.id !== id);
    try { await library.remove(id); } catch {}
    for (const pl of playlists) {
      if (pl.songIds.includes(id)) { pl.songIds = pl.songIds.filter(x => x !== id); savePlaylist(pl); }
    }
  }, 5000);
  pendingDelete.set(id, timer);
  renderList();
  toast(`«${s.title}» eliminada`, {
    action: 'Deshacer', ms: 5000,
    onAction: () => { clearTimeout(pendingDelete.get(id)); pendingDelete.delete(id); renderList(); },
  });
}

// ---------- Importar ----------
$('#addBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

async function importFiles(files) {
  if (!files.length) return;
  let added = 0, dup = 0, bad = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (files.length > 3) toast(`Importando ${i + 1} de ${files.length}…`, { ms: 60000 });
    try {
      const buf = await f.arrayBuffer();
      const r = await addBuffer(buf, f.name || 'Sin título');
      if (r === 'dup') dup++; else if (r === 'bad') bad++; else added++;
    } catch { bad++; }
  }
  renderList();
  const parts = [];
  if (added) parts.push(`${plural(added, 'canción añadida', 'canciones añadidas')}`);
  if (dup) parts.push(`${dup} ya estaba${dup > 1 ? 'n' : ''}`);
  if (bad) parts.push(`${bad} no ${bad > 1 ? 'son MIDI válidos' : 'es un MIDI válido'}`);
  toast(parts.join(' · ') || 'Nada que importar');
  if (added) persistStorage();
}

async function addBuffer(buf, fileName, title, extra = {}) {
  let tl, quality;
  try { ({ tl, quality } = analyzeBuffer(buf)); } catch { return 'bad'; }
  if (!tl.noteCount) return 'bad';
  if (extra.sourceId && songs.some(s => s.source === extra.source && s.sourceId === extra.sourceId)) return 'dup';
  if (songs.some(s => s.fileName === fileName && s.size === buf.byteLength)) return 'dup';
  const meta = {
    id: newId(),
    title: title || titleFrom(fileName),
    fileName,
    size: buf.byteLength,
    duration: tl.duration,
    noteCount: tl.noteCount,
    trackCount: tl.trackCount,
    hasDrums: tl.hasDrums,
    addedAt: Date.now(),
    plays: 0,
    fav: false,
    quality,
    ...extra,
  };
  await library.add(meta, buf);
  songs.push(meta);
  return meta;
}

async function addDemo() {
  const bytes = odeToJoy();
  const r = await addBuffer(bytes.buffer, 'himno-de-la-alegria.mid', DEMO_TITLE);
  renderList();
  if (r === 'dup') toast('La demo ya está en tu biblioteca');
  else toast('Demo añadida. Tócala para escucharla en el piano.');
}

// Archivos recibidos con «Compartir» (los guarda el service worker)
async function importInbox() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('pianola-inbox');
    const keys = await cache.keys();
    if (!keys.length) return;
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('x-name') || 'compartido.mid');
      files.push(new File([await res.arrayBuffer()], name));
      await cache.delete(req);
    }
    await importFiles(files);
  } catch (e) { console.warn('inbox', e); }
  if (location.search.includes('shared')) history.replaceState(null, '', location.pathname);
}

// Arrastrar y soltar (ordenador)
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop').classList.add('show'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  importFiles([...(e.dataTransfer?.files || [])]);
});

// ---------- Conexión ----------
let lastBtError = '';
function errorText(e) {
  const n = e?.name || 'Error';
  const msg = e?.message || '';
  if (n === 'NotFoundError' && /cancel/i.test(msg)) return null; // el usuario cerró el selector
  lastBtError = `${n}: ${msg}`;
  console.warn('Bluetooth', lastBtError);
  if (/globally disabled/i.test(msg)) return navigator.brave
    ? 'Brave trae el Bluetooth web desactivado: actívalo en brave://flags («Web Bluetooth API») o usa Chrome.'
    : 'Este navegador tiene el Bluetooth web desactivado. Usa Chrome.';
  if (/adapter/i.test(msg)) return 'Chrome no tiene acceso al Bluetooth del móvil: dale permiso de «Dispositivos cercanos» a Chrome.';
  if (n === 'NotAllowedError' || /permission|blocked|denied/i.test(msg)) return 'El Bluetooth está bloqueado para Pianola en Chrome. Revisa los permisos.';
  if (n === 'SecurityError') return 'Bluetooth solo funciona si Pianola se abre desde una dirección https.';
  if (n === 'NotFoundError') return `Chrome no pudo buscar el piano (${msg || n}).`;
  return `No pude conectar con el piano (${msg || n}). Apágalo y enciéndelo, y vuelve a intentarlo.`;
}

function browserInfo() {
  const ua = navigator.userAgent;
  const inApp = /; wv\)/.test(ua) ? 'navegador integrado de otra app' : null;
  const samsung = /SamsungBrowser\/(\d+)/.exec(ua);
  const chrome = /Chrome\/(\d+)/.exec(ua);
  const engine = chrome ? ` (Chromium ${chrome[1]})` : '';
  const name = inApp || (navigator.brave ? `Brave${engine}` : samsung ? `Samsung Internet ${samsung[1]}` : chrome ? `Chrome ${chrome[1]}` : 'otro navegador');
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const android = /Android (\d+)/.exec(ua);
  return `${name}${android ? ` · Android ${android[1]}` : ''} · ${standalone ? 'app instalada' : 'pestaña'}`;
}

async function fillDiagnostics(root) {
  const el = root.querySelector('[data-diag]');
  if (!el) return;
  let avail = 'no disponible';
  try {
    if (navigator.bluetooth?.getAvailability) avail = (await navigator.bluetooth.getAvailability()) ? 'sí' : 'no';
    else if (navigator.bluetooth) avail = 'sí (sin comprobación)';
  } catch (e) { avail = `error (${e.message})`; }
  el.innerHTML = `Bluetooth accesible para el navegador: <b>${esc(avail)}</b><br>
    ${esc(browserInfo())}<br>
    Último error: ${lastBtError ? `<b>${esc(lastBtError)}</b>` : 'ninguno'}`;
}

async function ensureConnected() {
  if (ble.connected) return true;
  if (!ble.supported) { helpSheet(true); return false; }
  if (ble.state === 'connecting' || ble.state === 'reconnecting') {
    toast('Conectando con el piano…');
    return false;
  }
  try {
    await ble.connect();
    return true;
  } catch (e) {
    const t = errorText(e);
    if (t) toast(t, { ms: 9000, action: 'Ayuda', onAction: connSheet });
    return false;
  }
}

function renderConn() {
  const b = $('#connBtn');
  const st = ble.state;
  b.dataset.state = st;
  const label = { idle: 'Conectar', connecting: 'Conectando…', reconnecting: 'Reconectando…', connected: ble.name, unsupported: 'Sin Bluetooth' }[st] || 'Conectar';
  b.querySelector('.conn-label').textContent = label;
  b.setAttribute('aria-label', st === 'connected' ? `Conectado a ${ble.name}` : label);
}

ble.addEventListener('state', e => {
  const { state, lost } = e.detail;
  renderConn();
  updateTransport();
  if (state === 'reconnecting' && player.playing) {
    resumeAfterReconnect = true;
    player.pause();
    toast('Se perdió la conexión. Reconectando…', { ms: 8000 });
  } else if (state === 'connected') {
    updateMediaSession();
    if (settings.volume < 127) setTimeout(() => sendVolume(settings.volume), 300);
    if (resumeAfterReconnect) { resumeAfterReconnect = false; player.play(); toast('Reconectado'); }
  } else if (state === 'idle') {
    if (player.playing) player.pause();
    if (lost || resumeAfterReconnect) toast('No se pudo reconectar con el piano', { ms: 5000 });
    resumeAfterReconnect = false;
  }
  if ($('#sheet').classList.contains('open') && $('#sheetBody [data-conn]')) connSheet();
});

ble.addEventListener('midi', e => {
  const [st, n, v] = e.detail;
  const type = st & 0xf0;
  if (type === 0x90 && v > 0) userNotes.add(n);
  else if (type === 0x80 || type === 0x90) userNotes.delete(n);
  else if (type === 0xb0 && n >= 120) userNotes.clear();
  kick();
});

$('#connBtn').addEventListener('click', async () => {
  if (ble.connected || ble.state === 'reconnecting') { connSheet(); return; }
  if (!ble.supported) { helpSheet(true); return; }
  if (await ensureConnected()) toast(`Conectado a ${ble.name}`);
});

function connSheet() {
  const st = ble.state;
  const html = `<div data-conn>
    <h3>Piano</h3>
    <div class="conn-card">
      <span class="bt">${icon.bt}</span>
      <span><b>${st === 'connected' ? esc(ble.name) : 'Sin conectar'}</b>
      <small>${st === 'connected' ? 'Conectado por Bluetooth MIDI' : st === 'reconnecting' ? 'Reconectando…' : 'Toca «Conectar» con el piano encendido'}</small></span>
    </div>
    ${st === 'connected'
      ? `<div class="btns-row"><button class="btn ghost" type="button" data-c="test">Probar sonido</button><button class="btn danger" type="button" data-c="off">Desconectar</button></div>`
      : `<button class="btn primary block" type="button" data-c="on">Conectar</button>`}
    ${helpHTML()}
  </div>`;
  openSheet(html, {
    onOpen: body => { fillDiagnostics(body); body.addEventListener('click', async e => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (c === 'test') testSound();
      else if (c === 'off') { resumeAfterReconnect = false; player.pause(); ble.disconnect(); }
      else if (c === 'on') { if (await ensureConnected()) toast(`Conectado a ${ble.name}`); else fillDiagnostics(body); }
    }); },
  });
}

function helpHTML() {
  return `<h4>Si no conecta</h4>
    <ol class="steps">
      <li>Permisos de Chrome en Android: <b>Ajustes → Aplicaciones → Chrome → Permisos</b>. Pon «Dispositivos cercanos» en <b>Permitir</b> y «Ubicación» en <b>Permitir solo mientras se usa</b>. Tener el Bluetooth y la ubicación del móvil encendidos no basta si Chrome no tiene estos permisos.</li>
      <li>Permiso del sitio: en Chrome, abre la web, toca el icono a la izquierda de la dirección → <b>Permisos</b>, y quita cualquier bloqueo de Bluetooth o «Restablece permisos».</li>
      <li>Ábrela en <b>Chrome</b> o desde el icono instalado, no dentro de otra app (WhatsApp, Telegram, la app de Claude…) ni en Samsung Internet.</li>
      <li>Enciende el FP-10. Cuando su Bluetooth está listo para conectar, el botón <b>FUNCTION</b> se ilumina.</li>
      <li>No lo emparejes desde los ajustes de Bluetooth de Android: se conecta desde aquí. Si ya lo emparejaste, olvídalo en Ajustes y vuelve a probar.</li>
      <li>El piano atiende a una sola app a la vez: cierra Piano Every Day o Roland Piano App si están conectadas.</li>
    </ol>
    <h4>Diagnóstico</h4>
    <p class="diag" data-diag>Comprobando…</p>`;
}

function helpSheet(unsupported = false) {
  openSheet(`<h3>${unsupported ? 'Este navegador no tiene Bluetooth' : 'Conexión'}</h3>
    ${unsupported ? '<p class="sub">Abre Pianola con Chrome en Android, desde su dirección https, e instálala con «Añadir a pantalla de inicio».</p>' : ''}
    ${helpHTML()}`, { onOpen: fillDiagnostics });
}

async function testSound() {
  if (!ble.connected) return;
  const ch = settings.mode === 'piano' ? 3 : 0;
  const seq = [60, 64, 67, 72, 76, 79, 84];
  for (const n of seq) { ble.send([0x90 | ch, n, 78]); await sleep(110); }
  [48, 60, 64, 67, 72].forEach(n => ble.send([0x90 | ch, n, 70]));
  await sleep(1400);
  [...seq, 48].forEach(n => ble.send([0x80 | ch, n, 0]));
}

// ---------- Cola y reproducción ----------
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function startQueue(ids, index) {
  baseQueue = ids.slice();
  const first = ids[index];
  queue = settings.shuffle ? [first, ...shuffled(ids.filter(x => x !== first))] : ids.slice();
  // Conectar primero: el selector de Bluetooth necesita el toque del usuario.
  const ok = await ensureConnected();
  await startAt(queue.indexOf(first), { autoplay: ok });
  if (ok) openPlayerIfFirstTime();
  else if (ble.supported) toast('Conecta el piano para escucharla', { action: 'Conectar', onAction: () => ensureConnected().then(r => r && player.play()) });
}

async function startAt(i, { autoplay = true, gap = 0 } = {}) {
  const token = ++advanceToken;
  qi = i;
  const id = queue[i];
  let meta = songs.find(s => s.id === id);
  let tl;
  try {
    let buf;
    if (meta) buf = await library.data(id);
    else if (isOnlineId(id)) buf = await fetchOnlineData(id);
    else return;
    tl = loadMidi(buf);
  } catch {
    if (token === advanceToken) toast(isOnlineId(id) ? 'No se pudo descargar esa canción' : 'No se pudo leer esa canción');
    return;
  }
  if (token !== advanceToken) return;
  if (!meta) meta = transientFrom(id, tl);
  if (current?.id !== meta.id) player.setSpeed(1);   // cada canción empieza a su tempo
  current = meta;
  player.load(tl);
  stage.setRange(tl.range);
  updateNowPlaying();
  renderList();
  if (gap) { await sleep(gap); if (token !== advanceToken) return; }
  if (autoplay && ble.connected) {
    player.play();
    if (!meta.transient) {
      meta.plays = (meta.plays || 0) + 1;
      meta.lastPlayed = Date.now();
      library.update(id, { plays: meta.plays, lastPlayed: meta.lastPlayed }).catch(() => {});
    }
  }
}

async function togglePlay() {
  if (!player.tl) return;
  if (player.playing) { player.pause(); return; }
  if (!(await ensureConnected())) return;
  player.play();
}

function next({ auto = false } = {}) {
  if (!queue.length) return;
  if (auto && settings.repeat === 'one') { startAt(qi, { gap: 1200 }); return; }
  let n = qi + 1;
  if (n >= queue.length) {
    if (settings.repeat === 'all' || !auto) {
      if (settings.shuffle) { queue = shuffled(baseQueue); }
      n = 0;
    } else {
      player.seek(0);
      updateTransport();
      return;
    }
  }
  startAt(n, { gap: auto ? 1200 : 0 });
}

function prev() {
  if (!queue.length) return;
  if (player.position > 3000 || queue.length === 1) { player.seek(0); updateTransport(); return; }
  startAt((qi - 1 + queue.length) % queue.length);
}

player.addEventListener('ended', () => {
  if (sleepTimer.mode === 'end') {
    setSleep(null);
    toast('Temporizador: música detenida. Buenas noches', { ms: 6000 });
    return;
  }
  next({ auto: true });
});
player.addEventListener('state', () => {
  clock.postMessage(player.playing ? 'start' : 'stop');
  updateTransport();
  renderList();
  syncWake();
  syncBackground();
  kick();
});
player.addEventListener('seek', () => { updateTransport(); kick(); });

// ---------- Interfaz del reproductor ----------
let playerOpen = false;
let seenPlayer = false;
function openPlayer() {
  if (playerOpen || !current) return;
  playerOpen = true;
  seenPlayer = true;
  $('#player').classList.add('open');
  $('#player').setAttribute('aria-hidden', 'false');
  pushLayer('player', closePlayerNow);
  stage.resize();
  kick();
}
function openPlayerIfFirstTime() { if (!seenPlayer) openPlayer(); }
function closePlayerNow() {
  playerOpen = false;
  $('#player').classList.remove('open');
  $('#player').setAttribute('aria-hidden', 'true');
}
function closePlayer() {
  if (!playerOpen) return;
  if (layers[layers.length - 1]?.name === 'player') history.back();
  else closePlayerNow();
}

function updateNowPlaying() {
  const mini = $('#mini');
  document.body.classList.toggle('no-mini', !current);
  if (!current) { mini.hidden = true; return; }
  mini.hidden = false;
  $('#miniTitle').textContent = current.title;
  $('#nowTitle').textContent = current.title;
  const tl = player.tl;
  const parts = [];
  if (queueName && queue.length > 1 && qi >= 0) parts.push(`${qi + 1} de ${queue.length} · ${queueName}`);
  if (tl) {
    parts.push(plural(tl.noteCount, 'nota', 'notas'));
    if (tl.trackCount > 1) parts.push(plural(tl.trackCount, 'pista', 'pistas'));
  }
  const cq = current.quality || (current.transient && qcache.get(current.id));
  if (cq) parts.push(`${LABELS[cq.label].short} ${cq.score}`);
  if (current.performer) parts.push(`toca ${current.performer}`);
  if (current.transient) parts.push(`${current.sourceName || 'Online'}, sin guardar`);
  $('#nowMeta').textContent = parts.join(' · ');
  $('#seek').max = Math.max(1, Math.round(player.duration));
  $('#tDur').textContent = formatTime(player.duration);
  updateTransport();
  updateMediaSession();
}

function updateTransport() {
  const playing = player.playing;
  $('#playBtn').innerHTML = playing ? icon.pause : icon.play;
  $('#playBtn').setAttribute('aria-label', playing ? 'Pausa' : 'Reproducir');
  $('#miniPlay').innerHTML = playing ? icon.pause : icon.play;
  $('#miniPlay').setAttribute('aria-label', playing ? 'Pausa' : 'Reproducir');
  $('#shuffleBtn').classList.toggle('on', settings.shuffle);
  $('#shuffleBtn').setAttribute('aria-pressed', String(settings.shuffle));
  const rb = $('#repeatBtn');
  rb.dataset.mode = settings.repeat;
  rb.classList.toggle('on', settings.repeat !== 'off');
  rb.setAttribute('aria-label', { off: 'Repetir: no', all: 'Repetir: todas', one: 'Repetir: esta' }[settings.repeat]);
  $('#speedChip').textContent = `Velocidad ${Math.round(player.speed * 100)} %`;
  $('#speedChip').classList.toggle('on', Math.abs(player.speed - 1) > 0.001);
  $('#soundChip').textContent = settings.mode === 'piano' ? 'Sonido: piano del FP-10' : 'Sonido original';
  $('#soundChip').classList.toggle('on', settings.mode === 'piano');
  $('#playerKicker').textContent = ble.connected ? `En ${ble.name}` : 'Piano sin conectar';
  $('#saveChip').hidden = !current?.transient;
  const sc = $('#sleepChip');
  sc.classList.toggle('on', !!sleepTimer.mode);
  sc.textContent = sleepTimer.mode === 'time'
    ? `Para en ${Math.max(1, Math.ceil((sleepTimer.until - Date.now()) / 60000))} min`
    : sleepTimer.mode === 'end' ? 'Para al acabar esta' : 'Temporizador';
  const vol = $('#volume');
  if (vol && document.activeElement !== vol) {
    vol.value = settings.volume;
    vol.style.setProperty('--p', `${(settings.volume / 127) * 100}%`);
  }
  updateProgress(true);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

let seeking = false;
function updateProgress(force = false) {
  const pos = player.position, dur = player.duration || 1;
  const pct = `${Math.min(100, (pos / dur) * 100)}%`;
  $('#miniBar').style.width = pct;
  $('#miniSub').textContent = current ? `${formatTime(pos)} / ${formatTime(dur)}` : '';
  if (!seeking && (playerOpen || force)) {
    const s = $('#seek');
    s.value = Math.round(pos);
    s.style.setProperty('--p', pct);
    $('#tCur').textContent = formatTime(pos);
  }
}

$('#seek').addEventListener('input', e => {
  seeking = true;
  const v = +e.target.value;
  e.target.style.setProperty('--p', `${(v / (player.duration || 1)) * 100}%`);
  $('#tCur').textContent = formatTime(v);
});
$('#seek').addEventListener('change', e => { seeking = false; player.seek(+e.target.value); });

$('#playBtn').addEventListener('click', togglePlay);
$('#miniPlay').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', () => next());
$('#miniNext').addEventListener('click', () => next());
$('#prevBtn').addEventListener('click', prev);
$('#miniOpen').addEventListener('click', openPlayer);
$('#playerClose').addEventListener('click', closePlayer);
$('#playerMore').addEventListener('click', () => current && songMenu(current.id));

$('#shuffleBtn').addEventListener('click', () => {
  settings.shuffle = !settings.shuffle; saveSettings();
  if (current) {
    queue = settings.shuffle ? [current.id, ...shuffled(baseQueue.filter(x => x !== current.id))] : baseQueue.slice();
    qi = queue.indexOf(current.id);
  }
  updateTransport();
  toast(settings.shuffle ? 'Orden aleatorio' : 'Orden normal', { ms: 1400 });
});
$('#repeatBtn').addEventListener('click', () => {
  const order = ['off', 'all', 'one'];
  settings.repeat = order[(order.indexOf(settings.repeat) + 1) % 3]; saveSettings();
  updateTransport();
  toast({ off: 'Sin repetir', all: 'Repetir la lista', one: 'Repetir esta canción' }[settings.repeat], { ms: 1400 });
});
$('#soundChip').addEventListener('click', () => {
  settings.mode = settings.mode === 'piano' ? 'original' : 'piano'; saveSettings();
  player.setMode(settings.mode);
  updateTransport();
  toast(settings.mode === 'piano'
    ? 'Todo suena con el tono elegido en el panel del FP-10'
    : 'Cada pista con su instrumento (sonidos GM2 del piano)', { ms: 3200 });
});
$('#speedChip').addEventListener('click', speedSheet);
$('#saveChip').addEventListener('click', () => { if (current?.transient) saveOnline(current.id); });
$('#sleepChip').addEventListener('click', sleepSheet);

function setSleep(mode, minutes = 0) {
  clearTimeout(sleepTimer.timer);
  clearInterval(sleepTimer.tick);
  sleepTimer.mode = mode;
  sleepTimer.until = 0;
  if (mode === 'time') {
    sleepTimer.until = Date.now() + minutes * 60000;
    sleepTimer.timer = setTimeout(() => {
      // se cumplió el tiempo: deja terminar la canción en curso
      clearInterval(sleepTimer.tick);
      if (player.playing) { sleepTimer.mode = 'end'; sleepTimer.until = 0; }
      else setSleep(null);
      updateTransport();
    }, minutes * 60000);
    sleepTimer.tick = setInterval(updateTransport, 20000);
  }
  updateTransport();
}

function sleepSheet() {
  openSheet(`<h3>Temporizador</h3>
    <p class="sub">Cuando se cumpla el tiempo, Pianola deja terminar la canción que esté sonando y se detiene.</p>
    <div class="sleep-opts">${[15, 30, 45, 60, 90, 120].map(m => `<button class="preset" type="button" data-min="${m}">${m} min</button>`).join('')}</div>
    <ul class="menu">
      <li><button type="button" data-s="end">Al terminar esta canción</button></li>
      ${sleepTimer.mode ? '<li><button type="button" data-s="off" class="danger">Desactivar temporizador</button></li>' : ''}
    </ul>`, {
    onOpen: body => body.addEventListener('click', e => {
      const min = e.target.closest('[data-min]')?.dataset.min;
      const sv = e.target.closest('[data-s]')?.dataset.s;
      if (!min && !sv) return;
      if (min) { setSleep('time', +min); toast(`Pianola parará dentro de ${min} minutos`); }
      else if (sv === 'end') { setSleep('end'); toast('Parará al terminar esta canción'); }
      else { setSleep(null); toast('Temporizador desactivado'); }
      closeSheet();
    }),
  });
}

// Volumen general del piano (SysEx universal «Master Volume», que el FP-10 recibe)
let volTimer = null;
function sendVolume(v) {
  if (!ble.connected) return;
  ble.send([0xf0, 0x7f, 0x7f, 0x04, 0x01, 0x00, Math.max(0, Math.min(127, v | 0)), 0xf7]);
}
$('#volume').addEventListener('input', e => {
  const v = +e.target.value;
  settings.volume = v;
  e.target.style.setProperty('--p', `${(v / 127) * 100}%`);
  if (!volTimer) volTimer = setTimeout(() => { volTimer = null; sendVolume(settings.volume); }, 60);
});
$('#volume').addEventListener('change', () => {
  saveSettings();
  sendVolume(settings.volume);
  if (!ble.connected) toast('Conecta el piano para cambiar su volumen');
});

function speedSheet() {
  const render = body => {
    const v = Math.round(player.speed * 100);
    body.querySelector('.speed-value').textContent = `${v} %`;
    body.querySelectorAll('.preset').forEach(p => p.classList.toggle('on', +p.dataset.v === v));
  };
  openSheet(`<h3>Velocidad</h3>
    <p class="sub">Más despacio para estudiar una pieza, sin cambiar la afinación.</p>
    <div class="speed-value"></div>
    <div class="speed-row">
      <button class="round" type="button" data-d="-5" aria-label="Más lento">−</button>
      <button class="round" type="button" data-d="5" aria-label="Más rápido">+</button>
    </div>
    <div class="presets">${[50, 75, 90, 100, 125].map(v => `<button class="preset" type="button" data-v="${v}">${v} %</button>`).join('')}</div>`, {
    onOpen: body => {
      render(body);
      body.addEventListener('click', e => {
        const d = e.target.closest('[data-d]')?.dataset.d;
        const v = e.target.closest('[data-v]')?.dataset.v;
        if (!d && !v) return;
        const pct = v ? +v : Math.round(player.speed * 100) + +d;
        player.setSpeed(Math.max(25, Math.min(200, pct)) / 100);
        render(body);
        updateTransport();
      });
    },
  });
}

// ---------- Ajustes ----------
$('#settingsBtn').addEventListener('click', settingsSheet);

async function settingsSheet() {
  const est = await storageEstimate();
  const live = songs.filter(s => !pendingDelete.has(s.id));
  const bytes = live.reduce((a, s) => a + (s.size || 0), 0);
  const sw = (key, title, desc) => `<label class="setting"><span class="txt"><b>${title}</b><small>${desc}</small></span>
    <span class="switch"><input type="checkbox" data-s="${key}"${settings[key] ? ' checked' : ''}><span></span></span></label>`;
  openSheet(`<h3>Ajustes</h3>
    <h4>Reproducción</h4>
    ${sw('keepAwake', 'Pantalla encendida mientras suena', 'Evita que el móvil se bloquee a mitad de canción.')}
    ${sw('background', 'Seguir sonando fuera de la app', 'Experimental: continúa al cambiar de app o apagar la pantalla, con controles en la notificación. Si está desactivado, la música se pausa al salir.')}
    ${sw('muteDrums', 'Silenciar batería', 'Ignora el canal 10 de los archivos con percusión.')}
    <h4>Explorar</h4>
    ${sw('analyzeOnline', 'Analizar la calidad de los resultados', 'Descarga cada resultado (unos KB) para puntuar si es una interpretación real.')}
    <h4>Piano</h4>
    <div class="setting"><span class="txt"><b>${ble.connected ? esc(ble.name) : 'Sin conectar'}</b><small>${ble.supported ? 'Bluetooth MIDI' : 'Este navegador no tiene Bluetooth'}</small></span>
      <button class="btn ghost" type="button" data-a="conn">${ble.connected ? 'Gestionar' : 'Conectar'}</button></div>
    <details><summary>Ayuda de conexión</summary><div>${helpHTML()}</div></details>
    <h4>Biblioteca</h4>
    <div class="setting"><span class="txt"><b>${plural(live.length, 'canción', 'canciones')}</b><small>${(bytes / 1024).toLocaleString('es-ES', { maximumFractionDigits: 0 })} KB${est?.quota ? ` · espacio disponible ${(est.quota / 1e9).toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB` : ''}</small></span>
      <button class="btn ghost" type="button" data-a="demo">Añadir demo</button></div>
    <p class="foot">Pianola ${VERSION} · reproductor MIDI para Roland FP-10${SIMULATED ? ' · modo simulado' : ''}</p>`, {
    onOpen: body => {
      fillDiagnostics(body);
      body.addEventListener('change', e => {
        const k = e.target.dataset.s;
        if (!k) return;
        settings[k] = e.target.checked; saveSettings();
        if (k === 'muteDrums') player.setMuteDrums(settings.muteDrums);
        syncWake(); syncBackground();
      });
      body.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'conn') connSheet();
        else if (a === 'demo') { closeSheet(); addDemo(); }
      });
    },
  });
}

// ---------- Pantalla encendida, segundo plano y controles del sistema ----------
let wakeLock = null;
async function syncWake() {
  const want = settings.keepAwake && player.playing && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
}
let pausedByHide = false;
document.addEventListener('visibilitychange', () => {
  syncWake();
  if (document.visibilityState === 'hidden') {
    // Sin el modo de segundo plano, Android ralentiza la app al salir: mejor pausar limpio.
    if (player.playing && !settings.background) { pausedByHide = true; player.pause(); }
  } else {
    if (pausedByHide) { pausedByHide = false; toast('En pausa al salir de la app', { action: 'Seguir', onAction: () => togglePlay() }); }
    kick();
  }
});

let silentAudio = null;
function silentWav(seconds = 10, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
let bgPauseTimer = null;
function syncBackground() {
  const want = settings.background && player.playing;
  clearTimeout(bgPauseTimer);
  if (want) {
    if (!silentAudio) { silentAudio = new Audio(silentWav()); silentAudio.loop = true; }
    silentAudio.play().catch(() => {});
  } else if (silentAudio && !silentAudio.paused) {
    // margen para el salto entre canciones: si se pausa el audio, Android puede congelar la app
    bgPauseTimer = setTimeout(() => {
      if (!(settings.background && player.playing)) silentAudio.pause();
    }, settings.background ? 4000 : 0);
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: ble.connected ? `Pianola · ${ble.name}` : 'Pianola',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('nexttrack', () => next());
  set('previoustrack', prev);
  set('seekto', d => player.seek(d.seekTime * 1000));
}

addEventListener('pagehide', () => { if (player.playing) player.pause(); });

// ---------- Escenario: notas que caen y teclado ----------
const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);

class Stage {
  constructor(roll, keys) {
    this.roll = roll; this.keys = keys;
    this.rc = roll.getContext('2d'); this.kc = keys.getContext('2d');
    this.layout = new Map();
    this.setRange([48, 84]);
    new ResizeObserver(() => this.resize()).observe(roll);
  }
  setRange([lo, hi]) {
    lo = Math.max(21, lo - 2); hi = Math.min(108, hi + 2);
    while (hi - lo < 36) { if (lo > 21) lo--; if (hi - lo < 36 && hi < 108) hi++; if (lo === 21 && hi === 108) break; }
    if (isBlack(lo)) lo--;
    if (isBlack(hi)) hi++;
    this.lo = lo; this.hi = hi;
    this.compute();
  }
  compute() {
    const W = this.cssW || 360;
    let whites = 0;
    for (let n = this.lo; n <= this.hi; n++) if (!isBlack(n)) whites++;
    const ww = W / whites;
    this.ww = ww;
    this.layout.clear();
    let wi = 0;
    for (let n = this.lo; n <= this.hi; n++) {
      if (isBlack(n)) {
        const bw = ww * 0.6;
        this.layout.set(n, { x: wi * ww - bw / 2, w: bw, black: true });
      } else {
        this.layout.set(n, { x: wi * ww, w: ww, black: false });
        wi++;
      }
    }
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    for (const c of [this.roll, this.keys]) {
      const r = c.getBoundingClientRect();
      if (!r.width) continue;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.cssW = this.roll.getBoundingClientRect().width || 360;
    this.rollH = this.roll.getBoundingClientRect().height || 300;
    this.keysH = this.keys.getBoundingClientRect().height || 72;
    this.compute();
    this.draw(player.position);
  }
  draw(pos) {
    const tl = player.tl;
    const rc = this.rc, W = this.cssW, H = this.rollH;
    if (!W || !H) return;
    rc.clearRect(0, 0, W, H);
    // guías de octava
    rc.fillStyle = 'rgba(237,231,219,0.045)';
    for (let n = this.lo; n <= this.hi; n++) if (n % 12 === 0) { const k = this.layout.get(n); rc.fillRect(Math.round(k.x), 0, 1, H); }
    const active = new Set();
    if (tl) {
      const win = 2600 * player.speed;
      const notes = tl.notes;
      let i = lowerBoundOn(notes, pos - 12000);
      for (; i < notes.length && notes[i].on < pos + win; i++) {
        const n = notes[i];
        if (n.ch === 9 || n.off <= pos) continue;
        const k = this.layout.get(n.note);
        if (!k) continue;
        const yBottom = H - ((n.on - pos) / win) * H;
        const yTop = H - ((n.off - pos) / win) * H;
        const top = Math.max(-4, yTop), bottom = Math.min(H, yBottom);
        if (bottom <= 0) continue;
        const on = n.on <= pos;
        if (on) active.add(n.note);
        const pad = k.black ? 0.5 : Math.max(1, k.w * 0.12);
        rc.fillStyle = on ? '#d2493f' : k.black ? 'rgba(237,231,219,0.55)' : 'rgba(237,231,219,0.86)';
        roundRect(rc, k.x + pad, top, k.w - pad * 2, Math.max(2, bottom - top - 1), Math.min(3, k.w / 3));
      }
    }
    this.drawKeys(active);
  }
  drawKeys(active) {
    const kc = this.kc, W = this.cssW, H = this.keysH;
    kc.clearRect(0, 0, W, H);
    kc.fillStyle = '#7d1f22';
    kc.fillRect(0, 0, W, 3);
    const gold = '#d9a441';
    for (const [n, k] of this.layout) {
      if (k.black) continue;
      kc.fillStyle = active.has(n) ? '#d2493f' : userNotes.has(n) ? gold : '#ece6da';
      roundRect(kc, k.x + 0.5, 4, k.w - 1, H - 5, 2.5);
    }
    for (const [n, k] of this.layout) {
      if (!k.black) continue;
      kc.fillStyle = active.has(n) ? '#d2493f' : userNotes.has(n) ? gold : '#191816';
      roundRect(kc, k.x, 3, k.w, (H - 3) * 0.62, 2);
    }
  }
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
  c.fill();
}

const stage = new Stage($('#roll'), $('#keys'));

let raf = null;
function frame() {
  raf = null;
  updateProgress();
  if (playerOpen) stage.draw(player.position);
  if ((player.playing || userNotes.size) && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
}
function kick() { if (!raf) raf = requestAnimationFrame(frame); }

// ---------- Iconos estáticos ----------
$('#settingsBtn').innerHTML = icon.tune;
$('#sortBtn').innerHTML = icon.sort;
$('#addBtn').innerHTML = icon.plus;
document.querySelector('.search-ico').innerHTML = icon.search;
$('#miniNext').innerHTML = icon.next;
$('#playerClose').innerHTML = icon.down;
$('#playerMore').innerHTML = icon.more;
$('#prevBtn').innerHTML = icon.prev;
$('#nextBtn').innerHTML = icon.next;
$('#shuffleBtn').innerHTML = icon.shuffle;
$('#repeatBtn').innerHTML = icon.repeat;

// Abrir .mid con Pianola desde el sistema (escritorio)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map(h => h.getFile()));
    importFiles(files);
  });
}

// ---------- Arranque ----------
async function backfillQuality() {
  for (const s of songs) {
    if (s.quality?.v === Q_VERSION) continue;
    try {
      const buf = await library.data(s.id);
      const { quality } = analyzeBuffer(buf);
      if (!quality) continue;
      s.quality = quality;
      await library.update(s.id, { quality });
    } catch {}
    await sleep(20);
  }
  renderList();
}

async function init() {
  renderConn();
  updateNowPlaying();
  try { songs = await library.list(); } catch (e) { console.warn(e); songs = []; }
  try { playlists = await playlistStore.list(); } catch (e) { console.warn(e); playlists = []; }
  renderList();
  await importInbox();
  if ('serviceWorker' in navigator && !SIMULATED) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(r => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // hay versión nueva: recargar una vez, salvo si está sonando algo
      if (!hadController || reloaded || player.playing) return;
      reloaded = true;
      location.reload();
    });
  }
  ble.reconnectKnown().catch(() => {});
  setTimeout(() => backfillQuality(), 1200);
}
init();

// Para depurar desde la consola
window.pianola = { player, ble, settings };
