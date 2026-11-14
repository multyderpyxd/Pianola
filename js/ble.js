// ble.js — Bluetooth MIDI (BLE MIDI 1.0) sobre Web Bluetooth.
// Empaqueta mensajes MIDI en paquetes BLE con marca de tiempo y los envía
// en serie (Chrome solo admite una operación GATT a la vez por característica).

export const MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const MIDI_IO = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const DEFAULT_MTU = 20; // ATT_MTU 23 − 3: lo que garantiza cualquier conexión BLE
const LAST_DEVICE_KEY = 'pianola.lastDevice';

// Construye un paquete con tantos mensajes de la cola como quepan.
// Formato: [cabecera][ts][estado][datos...][ts][estado][datos...]...
export function buildPacket(queue, ts, mtu = DEFAULT_MTU) {
  const hi = 0x80 | ((ts >> 7) & 0x3f);
  const lo = 0x80 | (ts & 0x7f);
  const out = [hi];
  let taken = 0;
  while (taken < queue.length) {
    const m = queue[taken];
    if (out.length + 1 + m.length > mtu) break;
    out.push(lo);
    for (let i = 0; i < m.length; i++) out.push(m[i]);
    taken++;
  }
  return { packet: Uint8Array.from(out), taken };
}

function dataLength(status) {
  const t = status & 0xf0;
  if (t === 0xc0 || t === 0xd0) return 1;
  if (t === 0xf0) return status === 0xf2 ? 2 : (status === 0xf1 || status === 0xf3) ? 1 : 0;
  return 2;
}

// Decodifica un paquete entrante (lo que tocas en el piano) en mensajes MIDI.
export function parsePacket(u8) {
  const out = [];
  if (u8.length < 2 || !(u8[0] & 0x80)) return out;
  let i = 1, running = 0;
  while (i < u8.length) {
    let b = u8[i];
    if (b & 0x80) {                    // byte de marca de tiempo
      i++;
      if (i >= u8.length) break;
      b = u8[i];
      if (b & 0x80) {                  // byte de estado
        if (b === 0xf0) break;         // SysEx: no nos interesa
        if (b >= 0xf8) { i++; continue; }  // tiempo real
        running = b;
        i++;
      }
    }
    if (!running) { i++; continue; }
    const n = dataLength(running);
    if (i + n > u8.length) break;
    const msg = [running];
    for (let k = 0; k < n; k++) msg.push(u8[i++] & 0x7f);
    out.push(msg);
  }
  return out;
}

export class BleMidi extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.char = null;
    this.state = this.supported ? 'idle' : 'unsupported';
    this.queue = [];
    this.writing = false;
    this.pumpScheduled = false;
    this.wantConnected = false;
    this.mtu = DEFAULT_MTU;
    this._onDisc = () => this._handleDisconnect();
    this._onValue = e => this._handleValue(e);
  }

  get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  get connected() { return this.state === 'connected'; }
  get name() { return this.device?.name || 'Piano'; }

  _set(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  // Debe llamarse desde un gesto del usuario (toque).
  async connect() {
    if (!this.supported) throw new Error('unsupported');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MIDI_SERVICE] }, { namePrefix: 'FP-' }, { namePrefix: 'Roland' }],
      optionalServices: [MIDI_SERVICE],
    });
    try {
      await this._attach(device);
    } catch (e) {
      this.wantConnected = false;
      try { device.gatt.disconnect(); } catch {}
      this._set('idle');
      throw e;
    }
  }

  // Reconexión silenciosa al último piano (solo si el navegador expone getDevices()).
  async reconnectKnown() {
    if (!this.supported || !navigator.bluetooth.getDevices || this.connected) return false;
    let id = null;
    try { id = localStorage.getItem(LAST_DEVICE_KEY); } catch {}
    if (!id) return false;
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find(d => d.id === id);
    if (!device) return false;
    try {
      await this._attach(device);
      return true;
    } catch {
      this.wantConnected = false;
      try { device.gatt.disconnect(); } catch {}
      this._set('idle');
      return false;
    }
  }

  async _attach(device, { quiet = false } = {}) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisc);
    }
    this.device = device;
    this.wantConnected = true;
    device.removeEventListener('gattserverdisconnected', this._onDisc);
    device.addEventListener('gattserverdisconnected', this._onDisc);
    if (!quiet) this._set('connecting');
    const server = await withTimeout(device.gatt.connect(), 12000);
    const service = await server.getPrimaryService(MIDI_SERVICE);
    const ch = await service.getCharacteristic(MIDI_IO);
    // Algunos periféricos BLE MIDI esperan una lectura y la suscripción antes de aceptar datos.
    try { await ch.readValue(); } catch {}
    try {
      await ch.startNotifications();
      ch.removeEventListener('characteristicvaluechanged', this._onValue);
      ch.addEventListener('characteristicvaluechanged', this._onValue);
    } catch {}
    this.char = ch;
    this.queue.length = 0;
    try { localStorage.setItem(LAST_DEVICE_KEY, device.id); } catch {}
    this._set('connected');
  }

  async _handleDisconnect() {
    this.char = null;
    this.queue.length = 0;
    this.writing = false;
    if (this.reconnecting) return;              // ya hay un bucle de reconexión en marcha
    if (!this.wantConnected || !this.device) { this._set('idle'); return; }
    this.reconnecting = true;
    this._set('reconnecting');
    try {
      const delays = [400, 800, 1500, 2500, 4000, 6000, 8000];
      for (const d of delays) {
        await sleep(d);
        if (!this.wantConnected) return;
        try { await this._attach(this.device, { quiet: true }); return; } catch {}
      }
      this.wantConnected = false;
      try { this.device.gatt.disconnect(); } catch {}
      this._set('idle', { lost: true });
    } finally {
      this.reconnecting = false;
    }
  }

  _handleValue(e) {
    const v = e.target.value;
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (const msg of parsePacket(u8)) {
      this.dispatchEvent(new CustomEvent('midi', { detail: msg }));
    }
  }

  disconnect() {
    this.wantConnected = false;
    try { this.device?.gatt?.disconnect(); } catch {}
    this.char = null;
    this._set('idle');
  }

  forget() {
    try { localStorage.removeItem(LAST_DEVICE_KEY); } catch {}
    try { this.device?.forget?.(); } catch {}
  }

  // --- Envío ---
  send(msg) {
    if (!this.char) return;
    this.queue.push(msg);
    if (!this.pumpScheduled) {
      this.pumpScheduled = true;
      queueMicrotask(() => { this.pumpScheduled = false; this._pump(); });
    }
  }

  clear() { this.queue.length = 0; }

  get backlog() { return this.queue.length; }

  async _pump() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && this.char) {
        const ts = Math.floor(performance.now()) & 0x1fff;
        const { packet, taken } = buildPacket(this.queue, ts, this.mtu);
        if (!taken) { this.queue.shift(); continue; } // mensaje imposible de empaquetar
        this.queue.splice(0, taken);
        const c = this.char;
        try {
          if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(packet);
          else await c.writeValue(packet);
        } catch (err) {
          if (/in progress/i.test(String(err && err.message))) {
            // Otra operación GATT en curso: reintentar el mismo paquete en un momento.
            await sleep(4);
            const msgs = parsePacket(packet);
            this.queue.unshift(...msgs);
          } else {
            console.warn('BLE write', err);
            if (!this.device?.gatt?.connected) { this.queue.length = 0; break; }
          }
        }
      }
    } finally {
      this.writing = false;
    }
  }
}

// Transporte simulado para probar la interfaz sin piano (?demo en la URL).
export class MockMidi extends EventTarget {
  constructor() { super(); this.state = 'idle'; this.log = []; this.device = { name: 'FP-10 (simulado)' }; }
  get supported() { return true; }
  get connected() { return this.state === 'connected'; }
  get name() { return this.device.name; }
  get backlog() { return 0; }
  async connect() {
    this.state = 'connecting';
    this.dispatchEvent(new CustomEvent('state', { detail: { state: 'connecting' } }));
    await sleep(400);
    this.state = 'connected';
    this.dispatchEvent(new CustomEvent('state', { detail: { state: 'connected' } }));
  }
  async reconnectKnown() { return false; }
  disconnect() { this.state = 'idle'; this.dispatchEvent(new CustomEvent('state', { detail: { state: 'idle' } })); }
  forget() {}
  send(msg) { this.log.push(msg); if (this.log.length > 5000) this.log.splice(0, 2500); }
  clear() {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
