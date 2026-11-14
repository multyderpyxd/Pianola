// player.js — Reproductor: lleva el reloj de la canción, envía los eventos a su hora,
// recupera el estado (programas, pedal, controladores) al saltar y nunca deja notas colgadas.

const LATE_DROP_MS = 300;          // notas que llegan con más retraso se descartan (pestaña congelada)
const PIANO_CH = 3;                // canal 4: toca el sonido seleccionado en el panel del FP-10
const PIANO_CCS = new Set([64, 66, 67]); // pedal de resonancia, sostenuto y celeste
const RPN_CCS = new Set([6, 38, 96, 97, 98, 99, 100, 101]);

export class Player extends EventTarget {
  constructor(transport, { now = () => performance.now() } = {}) {
    super();
    this.out = transport;
    this.now = now;
    this.tl = null;
    this.idx = 0;
    this.playing = false;
    this.pausedAt = 0;
    this.anchorPerf = 0;
    this.anchorSong = 0;
    this.speed = 1;
    this.mode = 'original';       // 'original' | 'piano'
    this.muteDrums = false;
    this.active = new Map();      // (canal<<7 | nota) → nº de encendidos pendientes
    this.used = new Set();        // canales de salida tocados desde el último silencio
  }

  get duration() { return this.tl ? this.tl.duration : 0; }

  get position() {
    if (!this.playing) return this.pausedAt;
    const p = this.anchorSong + (this.now() - this.anchorPerf) * this.speed;
    return Math.min(p, this.duration);
  }

  load(timeline) {
    if (this.playing) this.pause();
    else this.silence();
    this.tl = timeline;
    this.idx = 0;
    this.pausedAt = 0;
    this._emit('load');
  }

  unload() {
    this.pause();
    this.tl = null;
    this.pausedAt = 0;
    this._emit('load');
  }

  play() {
    if (!this.tl || this.playing) return;
    if (this.pausedAt >= this.duration - 1) this.pausedAt = 0;
    this.idx = lowerBound(this.tl.events, this.pausedAt);
    this._chase(this.pausedAt);
    this.anchorSong = this.pausedAt;
    this.anchorPerf = this.now();
    this.playing = true;
    this._emit('state');
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.position;
    this.playing = false;
    this.silence();
    this._emit('state');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.pause();
    this.pausedAt = 0;
    this.idx = 0;
    this._emit('seek');
  }

  seek(ms) {
    if (!this.tl) return;
    ms = Math.max(0, Math.min(ms, this.duration));
    const was = this.playing;
    if (was) this.silence();
    this.pausedAt = ms;
    this.idx = lowerBound(this.tl.events, ms);
    if (was) {
      this._chase(ms);
      this.anchorSong = ms;
      this.anchorPerf = this.now();
    }
    this._emit('seek');
  }

  setSpeed(s) {
    const p = this.position;
    this.speed = Math.max(0.25, Math.min(2, s));
    this.anchorSong = p;
    this.anchorPerf = this.now();
    this._emit('speed');
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this._reroute(() => { this.mode = mode; });
  }

  setMuteDrums(v) {
    if (v === this.muteDrums) return;
    this._reroute(() => { this.muteDrums = v; });
  }

  _reroute(change) {
    const was = this.playing;
    const p = this.position;
    if (was) this.silence();
    change();
    if (was) {
      this.idx = lowerBound(this.tl.events, p);
      this._chase(p);
      this.anchorSong = p;
      this.anchorPerf = this.now();
    }
  }

  // Llamado por el reloj (worker) cada pocos milisegundos.
  tick() {
    if (!this.playing || !this.tl) return;
    const p = this.anchorSong + (this.now() - this.anchorPerf) * this.speed;
    const ev = this.tl.events;
    while (this.idx < ev.length && ev[this.idx].t <= p) {
      const e = ev[this.idx++];
      if (e.p === 2 && p - e.t > LATE_DROP_MS * this.speed) continue;
      this._dispatch(e);
    }
    if (this.idx >= ev.length && p >= this.duration) {
      this.playing = false;
      this.pausedAt = this.duration;
      this.silence();
      this._emit('state');
      this._emit('ended');
    }
  }

  // Traduce un evento de la canción al mensaje que se envía (o null si se filtra).
  _route(e) {
    let ch = e.ch;
    const type = e.type;
    if (ch === 9 && this.muteDrums) return null;
    if (this.mode === 'piano') {
      if (ch === 9) return null;
      if (type === 0xb0) { if (!PIANO_CCS.has(e.d1)) return null; }
      else if (type !== 0x80 && type !== 0x90) return null;
      ch = PIANO_CH;
    }
    if (type === 0xc0 || type === 0xd0) return [type | ch, e.d1];
    return [type | ch, e.d1, e.d2];
  }

  _dispatch(e) {
    const m = this._route(e);
    if (!m) return;
    const ch = m[0] & 0x0f;
    const type = m[0] & 0xf0;
    this.used.add(ch);
    if (type === 0x90) {
      const k = (ch << 7) | m[1];
      this.active.set(k, (this.active.get(k) || 0) + 1);
      this.out.send(m);
    } else if (type === 0x80) {
      const k = (ch << 7) | m[1];
      const n = this.active.get(k) || 0;
      if (n <= 0) return;                    // su encendido no llegó a enviarse
      if (n === 1) { this.active.delete(k); this.out.send(m); }
      else this.active.set(k, n - 1);       // la misma tecla sigue sonando por otra voz
    } else {
      this.out.send(m);
    }
  }

  // Apaga todo lo que esté sonando y levanta los pedales.
  silence() {
    this.out.clear();
    for (const k of this.active.keys()) this.out.send([0x80 | (k >> 7), k & 0x7f, 0]);
    this.active.clear();
    for (const ch of this.used) {
      this.out.send([0xb0 | ch, 64, 0]);
      this.out.send([0xb0 | ch, 123, 0]);
    }
    this.used.clear();
  }

  // Deja cada canal exactamente como estaría en el instante `ms` de la canción.
  _chase(ms) {
    const ev = this.tl.events;
    const outChannels = new Set();
    for (const e of ev) {
      const m = this._route(e);
      if (m) outChannels.add(m[0] & 0x0f);
    }
    const state = new Map();
    for (const ch of outChannels) {
      const s = { cc: new Map(), rpn: [], pc: null, bend: [0, 64] };
      if (this.mode === 'piano' && ch === PIANO_CH) {
        s.cc.set(7, 100); s.cc.set(11, 127); s.cc.set(64, 0);
      } else {
        s.cc.set(7, 100); s.cc.set(10, 64); s.cc.set(11, 127); s.cc.set(64, 0); s.cc.set(1, 0);
        if (ch !== PIANO_CH) { s.cc.set(0, 0); s.cc.set(32, 0); s.pc = 0; }
      }
      state.set(ch, s);
    }
    for (let i = 0; i < ev.length && ev[i].t < ms; i++) {
      const e = ev[i];
      if (e.type === 0x80 || e.type === 0x90) continue;
      const m = this._route(e);
      if (!m) continue;
      const s = state.get(m[0] & 0x0f);
      if (!s) continue;
      const type = m[0] & 0xf0;
      if (type === 0xb0) {
        if (m[1] >= 120) continue;
        if (RPN_CCS.has(m[1])) { s.rpn.push(m[1], m[2]); if (s.rpn.length > 64) s.rpn.splice(0, 2); }
        else s.cc.set(m[1], m[2]);
      } else if (type === 0xc0) s.pc = m[1];
      else if (type === 0xe0) s.bend = [m[1], m[2]];
    }
    for (const [ch, s] of state) {
      this.used.add(ch);
      for (const [cc, v] of s.cc) if (cc !== 0 && cc !== 32) this.out.send([0xb0 | ch, cc, v]);
      for (let i = 0; i < s.rpn.length; i += 2) this.out.send([0xb0 | ch, s.rpn[i], s.rpn[i + 1]]);
      if (s.pc !== null) {
        if (s.cc.has(0)) this.out.send([0xb0 | ch, 0, s.cc.get(0)]);
        if (s.cc.has(32)) this.out.send([0xb0 | ch, 32, s.cc.get(32)]);
        this.out.send([0xc0 | ch, s.pc]);
      }
      this.out.send([0xe0 | ch, s.bend[0], s.bend[1]]);
    }
  }

  // Notas que suenan ahora (para el teclado visual).
  activeNotesAt(ms, into = new Set()) {
    into.clear();
    if (!this.tl) return into;
    const notes = this.tl.notes;
    let i = lowerBoundOn(notes, ms - 10000);
    for (; i < notes.length && notes[i].on <= ms; i++) {
      const n = notes[i];
      if (n.off > ms && n.ch !== 9) into.add(n.note);
    }
    return into;
  }

  _emit(type) { this.dispatchEvent(new Event(type)); }
}

export function lowerBound(events, t) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function lowerBoundOn(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].on < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}
