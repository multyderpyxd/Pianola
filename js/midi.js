// midi.js — Lector de archivos MIDI estándar (SMF 0/1/2), línea temporal en ms
// y un escritor mínimo (para la demo). Sin dependencias.

export class MidiError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');
function decodeText(bytes) {
  try { return utf8.decode(bytes).trim(); } catch { return latin1.decode(bytes).trim(); }
}

function findHeader(u8) {
  // Algunos archivos (RMID) envuelven el SMF en un contenedor RIFF.
  const lim = Math.min(u8.length - 4, 4096);
  for (let i = 0; i <= lim; i++) {
    if (u8[i] === 0x4d && u8[i + 1] === 0x54 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64) return i;
  }
  return -1;
}

export function parseMidi(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const start = findHeader(u8);
  if (start < 0 || u8.length < start + 14) throw new MidiError('No parece un archivo MIDI');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start + 4;
  const hlen = dv.getUint32(p); p += 4;
  if (hlen < 6) throw new MidiError('Cabecera MIDI dañada');
  const format = dv.getUint16(p);
  const ntrks = dv.getUint16(p + 2);
  const division = dv.getUint16(p + 4);
  p += hlen;

  const tracks = [];
  while (p + 8 <= u8.length) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const len = dv.getUint32(p + 4);
    p += 8;
    const end = Math.min(p + len, u8.length);
    if (id === 'MTrk') tracks.push(parseTrack(u8, p, end));
    p = end;
    if (tracks.length >= Math.max(ntrks, 1) + 256) break;
  }
  if (!tracks.length) throw new MidiError('El archivo no contiene pistas');
  return { format, division, tracks };
}

function parseTrack(u8, start, end) {
  const events = [];
  const texts = [];
  let timeSigs = 0, keySigs = 0;
  let p = start, tick = 0, status = 0, name = '';
  const readVar = () => {
    let v = 0, b, n = 0;
    do {
      if (p >= end) throw new RangeError('eot');
      b = u8[p++];
      v = v * 128 + (b & 0x7f);
      n++;
    } while (b & 0x80 && n < 4);
    return v;
  };
  try {
    while (p < end) {
      tick += readVar();
      if (p >= end) break;
      let b = u8[p];
      if (b & 0x80) p++;
      else if (status) b = status;          // running status: el byte es dato
      else { p++; continue; }               // dato suelto sin estado: ignorar

      if (b === 0xff) {
        const type = u8[p++];
        const len = readVar();
        const data = u8.subarray(p, Math.min(p + len, end));
        p += len;
        if (type === 0x51 && data.length >= 3) {
          const uspq = (data[0] << 16) | (data[1] << 8) | data[2];
          if (uspq > 0) events.push({ tick, kind: 'tempo', uspq });
        } else if (type === 0x2f) break;
        else if (type === 0x58) timeSigs++;
        else if (type === 0x59) keySigs++;
        if (type >= 0x01 && type <= 0x07 && data.length) {
          const txt = decodeText(data);
          if (type === 0x03 && !name) name = txt;
          if (texts.length < 24) texts.push(txt.slice(0, 160));
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { const len = readVar(); p += len; continue; }
      if (b > 0xf0) continue;                // mensajes de sistema no válidos en SMF

      status = b;
      const type = b & 0xf0;
      const ch = b & 0x0f;
      if (p >= end) break;
      const d1 = u8[p++] & 0x7f;
      let d2 = 0;
      if (type !== 0xc0 && type !== 0xd0) {
        if (p >= end) break;
        d2 = u8[p++] & 0x7f;
      }
      events.push({ tick, kind: 'ch', type, ch, d1, d2 });
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;   // pista truncada: nos quedamos con lo leído
  }
  return { name, events, texts, timeSigs, keySigs };
}

const MIN_NOTE_MS = 8;

// Convierte el SMF en una lista de eventos con tiempo absoluto en ms,
// emparejando notas (para el piano roll) y ordenando apagados antes que encendidos.
export function buildTimeline(midi) {
  const { division, tracks } = midi;
  let toMs;
  if (division & 0x8000) {
    const fps = -((division >> 8) << 24 >> 24);
    const tpf = (division & 0xff) || 40;
    const rate = (fps === 29 ? 29.97 : fps) * tpf;
    toMs = tick => (tick * 1000) / rate;
  } else {
    const tpq = division || 480;
    const tempos = [];
    tracks.forEach(t => t.events.forEach(e => { if (e.kind === 'tempo') tempos.push(e); }));
    tempos.sort((a, b) => a.tick - b.tick);
    const segs = [{ tick: 0, ms: 0, uspq: 500000 }];
    for (const t of tempos) {
      const last = segs[segs.length - 1];
      if (t.tick === last.tick) { last.uspq = t.uspq; continue; }
      const ms = last.ms + ((t.tick - last.tick) * last.uspq) / tpq / 1000;
      segs.push({ tick: t.tick, ms, uspq: t.uspq });
    }
    toMs = tick => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].tick <= tick) lo = mid; else hi = mid - 1;
      }
      const s = segs[lo];
      return s.ms + ((tick - s.tick) * s.uspq) / tpq / 1000;
    };
  }

  const all = [];
  tracks.forEach((t, ti) => t.events.forEach((e, i) => {
    if (e.kind === 'ch') all.push({ tick: e.tick, track: ti, seq: i, type: e.type, ch: e.ch, d1: e.d1, d2: e.d2 });
  }));
  all.sort((a, b) => a.tick - b.tick || a.track - b.track || a.seq - b.seq);

  const notes = [];
  const ctrl = [];
  const open = new Map();
  for (const e of all) {
    const t = toMs(e.tick);
    const key = (e.ch << 7) | e.d1;
    if (e.type === 0x90 && e.d2 > 0) {
      const n = { on: t, off: -1, ch: e.ch, note: e.d1, vel: e.d2, track: e.track };
      notes.push(n);
      let q = open.get(key);
      if (!q) open.set(key, (q = []));
      q.push(n);
    } else if (e.type === 0x80 || e.type === 0x90) {
      const q = open.get(key);
      if (q && q.length) q.shift().off = t;
    } else {
      ctrl.push({ t, ch: e.ch, type: e.type, d1: e.d1, d2: e.d2 });
    }
  }
  const lastT = all.length ? toMs(all[all.length - 1].tick) : 0;
  for (const n of notes) {
    if (n.off < 0) n.off = Math.max(lastT, n.on + 500);
    if (n.off - n.on < MIN_NOTE_MS) n.off = n.on + MIN_NOTE_MS;
  }

  // p: 0 = apagado, 1 = control/programa, 2 = encendido (a igual tiempo)
  const events = [];
  for (const c of ctrl) events.push({ t: c.t, p: 1, ch: c.ch, type: c.type, d1: c.d1, d2: c.d2 });
  for (const n of notes) {
    events.push({ t: n.on, p: 2, ch: n.ch, type: 0x90, d1: n.note, d2: n.vel });
    events.push({ t: n.off, p: 0, ch: n.ch, type: 0x80, d1: n.note, d2: 64 });
  }
  events.sort((a, b) => a.t - b.t || a.p - b.p);

  let duration = 0;
  for (const e of events) if (e.t > duration) duration = e.t;

  const channels = new Set();
  let lo = 127, hi = 0, pitched = 0;
  for (const n of notes) {
    channels.add(n.ch);
    if (n.ch !== 9) { pitched++; if (n.note < lo) lo = n.note; if (n.note > hi) hi = n.note; }
  }
  const trackNames = tracks.map(t => t.name).filter(Boolean);
  return {
    events,
    notes,
    duration,
    noteCount: notes.length,
    pitchedCount: pitched,
    range: pitched ? [lo, hi] : [48, 84],
    channels: [...channels].sort((a, b) => a - b),
    hasDrums: channels.has(9),
    trackCount: tracks.filter(t => t.events.some(e => e.kind === 'ch')).length,
    trackNames,
    toMs,
  };
}

export function loadMidi(buffer) {
  return buildTimeline(parseMidi(buffer));
}

// --- Escritor mínimo (formato 1) ---
function varLen(v) {
  const out = [v & 0x7f];
  while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

// tracks: [{ name, events: [{ tick, data: [bytes...] }] }]
export function writeMidi({ tpq = 480, tracks }) {
  const bytes = [];
  const push32 = v => bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  bytes.push(0x4d, 0x54, 0x68, 0x64); push32(6);
  bytes.push(0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (tpq >> 8) & 255, tpq & 255);
  for (const tr of tracks) {
    const body = [];
    if (tr.name) {
      const nb = [...new TextEncoder().encode(tr.name)];
      body.push(0, 0xff, 0x03, ...varLen(nb.length), ...nb);
    }
    const evs = tr.events.map((e, i) => ({ ...e, i }))
      .sort((a, b) => a.tick - b.tick || (a.order ?? 1) - (b.order ?? 1) || a.i - b.i);
    let last = 0;
    for (const e of evs) {
      body.push(...varLen(e.tick - last), ...e.data);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    bytes.push(0x4d, 0x54, 0x72, 0x6b); push32(body.length);
    for (const b of body) bytes.push(b);
  }
  return new Uint8Array(bytes);
}

export function formatTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
