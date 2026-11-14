import { loadMidi, formatTime } from './midi.js';
import { BleMidi, MockMidi } from './ble.js';
import { Player, lowerBoundOn } from './player.js';
import { library, newId, persistStorage, storageEstimate } from './library.js';
import { odeToJoy, DEMO_TITLE } from './demo.js';
import { icon, keysArt } from './icons.js';

const VERSION = '1.0.0';
const $ = s => document.querySelector(s);
const SIMULATED = new URLSearchParams(location.search).has('demo');

// ---------- Estado ----------
const ble = SIMULATED ? new MockMidi() : new BleMidi();
const player = new Player(ble);

const defaults = { keepAwake: true, background: false, muteDrums: false, mode: 'original', repeat: 'off', shuffle: false, sort: 'recent' };
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
  else list.sort((a, b) => b.addedAt - a.addedAt);
  return list;
}

const SORT_LABEL = { recent: 'Recientes', az: 'A–Z', plays: 'Más tocadas' };

function metaLine(s) {
  const parts = [formatTime(s.duration)];
  if (s.trackCount > 1) parts.push(plural(s.trackCount, 'pista', 'pistas'));
  if (s.hasDrums) parts.push('batería');
  return parts.join(' · ');
}

function renderList() {
  const live = songs.filter(s => !pendingDelete.has(s.id));
  $('#countAll').textContent = live.length || '';
  $('#countFav').textContent = live.filter(s => s.fav).length || '';
  $('#sortBtn').textContent = SORT_LABEL[settings.sort];
  document.querySelectorAll('.filter').forEach(b => b.classList.toggle('on', b.dataset.filter === filter));

  const list = visibleSongs();
  const empty = $('#empty');
  if (!live.length) {
    $('#list').innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `${keysArt}
      <h2>Tu piano, tu repertorio</h2>
      <p>Añade archivos MIDI y Pianola los tocará en tu FP-10 por Bluetooth.</p>
      <div class="btns">
        <button class="btn primary" data-empty="add" type="button">${icon.plus} Añadir MIDI</button>
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
      : `<h2>Nada por aquí</h2><p>Ninguna canción coincide con «${esc(query)}».</p>`;
    return;
  }
  empty.hidden = true;
  const playing = player.playing;
  $('#list').innerHTML = list.map(s => {
    const isCur = current && current.id === s.id;
    return `<li class="row${isCur ? ' is-current' : ''}${isCur && !playing ? ' paused' : ''}" data-id="${s.id}">
      <button class="row-main" data-act="play" type="button">
        <span class="row-title">${isCur ? '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}<span>${esc(s.title)}</span></span>
        <span class="row-meta">${metaLine(s)}</span>
      </button>
      <button class="icon-btn fav${s.fav ? ' on' : ''}" data-act="fav" type="button" aria-label="${s.fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}" aria-pressed="${s.fav}">${icon.heart}</button>
      <button class="icon-btn" data-act="more" type="button" aria-label="Más opciones">${icon.more}</button>
    </li>`;
  }).join('');
}

$('#list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const act = btn.dataset.act;
  if (act === 'play') {
    const ids = visibleSongs().map(s => s.id);
    if (current && current.id === id && player.tl) { openPlayer(); if (!player.playing) togglePlay(); return; }
    startQueue(ids, ids.indexOf(id));
  } else if (act === 'fav') toggleFav(id);
  else if (act === 'more') songMenu(id);
});

$('#empty').addEventListener('click', e => {
  const b = e.target.closest('[data-empty]');
  if (!b) return;
  if (b.dataset.empty === 'add') $('#fileInput').click();
  else addDemo();
});

document.querySelectorAll('.filter').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; renderList(); }));
$('#sortBtn').addEventListener('click', () => {
  const order = ['recent', 'az', 'plays'];
  settings.sort = order[(order.indexOf(settings.sort) + 1) % order.length];
  saveSettings();
  renderList();
});
$('#search').addEventListener('input', e => { query = e.target.value.trim(); renderList(); });

async function toggleFav(id) {
  const s = songs.find(x => x.id === id);
  if (!s) return;
  s.fav = !s.fav;
  renderList();
  try { await library.update(id, { fav: s.fav }); } catch {}
}

function songMenu(id) {
  const s = songs.find(x => x.id === id);
  if (!s) return;
  openSheet(`<h3>${esc(s.title)}</h3>
    <p class="sub">${metaLine(s)} · ${plural(s.noteCount, 'nota', 'notas')}</p>
    <ul class="menu">
      <li><button type="button" data-m="play">Reproducir</button></li>
      <li><button type="button" data-m="fav">${s.fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}</button></li>
      <li><button type="button" data-m="rename">Renombrar</button></li>
      <li><button type="button" data-m="delete" class="danger">Eliminar de la biblioteca</button></li>
    </ul>`, {
    onOpen: body => body.addEventListener('click', e => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      if (m === 'play') { closeSheet(); const ids = visibleSongs().map(x => x.id); startQueue(ids, Math.max(0, ids.indexOf(id))); }
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

async function addBuffer(buf, fileName, title) {
  let tl;
  try { tl = loadMidi(buf); } catch { return 'bad'; }
  if (!tl.noteCount) return 'bad';
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
function errorText(e) {
  const n = e?.name || '';
  if (n === 'NotFoundError') {
    if (/cancel/i.test(e.message || '')) return null; // el usuario cerró el selector
    return 'Activa el Bluetooth del móvil (y la ubicación, si te lo pide) y vuelve a intentarlo.';
  }
  if (n === 'NotAllowedError') return 'Chrome no tiene permiso para usar Bluetooth. Revisa «Dispositivos cercanos» y la ubicación.';
  if (n === 'SecurityError') return 'Bluetooth solo funciona si Pianola se abre desde una dirección https.';
  return 'No pude conectar con el piano. Apágalo y enciéndelo, y vuelve a intentarlo.';
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
    if (t) toast(t, { ms: 5000 });
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
    onOpen: body => body.addEventListener('click', async e => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (c === 'test') testSound();
      else if (c === 'off') { resumeAfterReconnect = false; player.pause(); ble.disconnect(); }
      else if (c === 'on') { if (await ensureConnected()) toast(`Conectado a ${ble.name}`); }
    }),
  });
}

function helpHTML() {
  return `<h4>Si no aparece el piano</h4>
    <ol class="steps">
      <li>Enciende el FP-10. Cuando su Bluetooth está listo para conectar, el botón <b>FUNCTION</b> se ilumina.</li>
      <li>No lo emparejes desde los ajustes de Bluetooth de Android: se conecta desde aquí. Si ya lo emparejaste, olvídalo en Ajustes y vuelve a probar.</li>
      <li>Cuando Chrome lo pida, permite «Dispositivos cercanos» (y la ubicación en Android antiguos).</li>
      <li>El piano atiende a una sola app a la vez: cierra Piano Every Day o Roland Piano App si están conectadas.</li>
    </ol>`;
}

function helpSheet(unsupported = false) {
  openSheet(`<h3>${unsupported ? 'Este navegador no tiene Bluetooth' : 'Conexión'}</h3>
    ${unsupported ? '<p class="sub">Abre Pianola con Chrome en Android, desde su dirección https, e instálala con «Añadir a pantalla de inicio».</p>' : ''}
    ${helpHTML()}`);
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
  const meta = songs.find(s => s.id === id);
  if (!meta) return;
  let tl;
  try { tl = loadMidi(await library.data(id)); }
  catch { toast('No se pudo leer esa canción'); return; }
  if (token !== advanceToken) return;
  if (current?.id !== meta.id) player.setSpeed(1);   // cada canción empieza a su tempo
  current = meta;
  player.load(tl);
  stage.setRange(tl.range);
  updateNowPlaying();
  renderList();
  if (gap) { await sleep(gap); if (token !== advanceToken) return; }
  if (autoplay && ble.connected) {
    player.play();
    meta.plays = (meta.plays || 0) + 1;
    meta.lastPlayed = Date.now();
    library.update(id, { plays: meta.plays, lastPlayed: meta.lastPlayed }).catch(() => {});
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

player.addEventListener('ended', () => next({ auto: true }));
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
  if (tl) {
    parts.push(plural(tl.noteCount, 'nota', 'notas'));
    if (tl.trackCount > 1) parts.push(plural(tl.trackCount, 'pista', 'pistas'));
  }
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
    <h4>Piano</h4>
    <div class="setting"><span class="txt"><b>${ble.connected ? esc(ble.name) : 'Sin conectar'}</b><small>${ble.supported ? 'Bluetooth MIDI' : 'Este navegador no tiene Bluetooth'}</small></span>
      <button class="btn ghost" type="button" data-a="conn">${ble.connected ? 'Gestionar' : 'Conectar'}</button></div>
    <details><summary>Ayuda de conexión</summary><div>${helpHTML()}</div></details>
    <h4>Biblioteca</h4>
    <div class="setting"><span class="txt"><b>${plural(live.length, 'canción', 'canciones')}</b><small>${(bytes / 1024).toLocaleString('es-ES', { maximumFractionDigits: 0 })} KB${est?.quota ? ` · espacio disponible ${(est.quota / 1e9).toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB` : ''}</small></span>
      <button class="btn ghost" type="button" data-a="demo">Añadir demo</button></div>
    <p class="foot">Pianola ${VERSION} · reproductor MIDI para Roland FP-10${SIMULATED ? ' · modo simulado' : ''}</p>`, {
    onOpen: body => {
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
async function init() {
  renderConn();
  updateNowPlaying();
  try { songs = await library.list(); } catch (e) { console.warn(e); songs = []; }
  renderList();
  await importInbox();
  if ('serviceWorker' in navigator && !SIMULATED) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  ble.reconnectKnown().catch(() => {});
}
init();

// Para depurar desde la consola
window.pianola = { player, ble, settings };
