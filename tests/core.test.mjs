import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMidi, parseMidi } from '../js/midi.js';
import { buildPacket, parsePacket } from '../js/ble.js';
import { Player } from '../js/player.js';
import { odeToJoy } from '../js/demo.js';

const fx = new URL('./fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', fx)));

function notesOf(tl) {
  return tl.notes.map(n => [Math.round(n.on * 1000) / 1000, Math.round(n.off * 1000) / 1000, n.note, n.vel]).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
}

for (const name of ['multi', 'running']) {
  test(`tiempos de notas coinciden con pretty_midi: ${name}`, () => {
    const tl = loadMidi(readFileSync(new URL(`${name}.mid`, fx)));
    const key = a => [Math.round(a[0]), a[2], Math.round(a[1])];
    const cmp = (a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a[3] - b[3]; };
    const got = notesOf(tl).sort(cmp);
    const exp = expected[name].slice().sort(cmp);
    assert.equal(got.length, exp.length);
    for (let i = 0; i < got.length; i++) {
      assert.ok(Math.abs(got[i][0] - exp[i][0]) < 0.5, `on ${i}: ${got[i][0]} vs ${exp[i][0]}`);
      assert.ok(Math.abs(got[i][1] - exp[i][1]) < 0.5, `off ${i}: ${got[i][1]} vs ${exp[i][1]}`);
      assert.equal(got[i][2], exp[i][2]);
      assert.equal(got[i][3], exp[i][3]);
    }
  });
}

test('rechaza archivos que no son MIDI y tolera basura', () => {
  assert.throws(() => parseMidi(new TextEncoder().encode('hola, esto no es midi')));
  const demo = odeToJoy();
  const truncated = demo.slice(0, demo.length - 200);
  const tl = loadMidi(truncated);
  assert.ok(tl.noteCount > 0);
});

test('demo: 2 pistas, duración razonable y orden de eventos', () => {
  const tl = loadMidi(odeToJoy());
  assert.equal(tl.trackCount, 2);
  assert.ok(tl.duration > 30000 && tl.duration < 45000, `duración ${tl.duration}`);
  for (let i = 1; i < tl.events.length; i++) {
    const a = tl.events[i - 1], b = tl.events[i];
    assert.ok(a.t < b.t || (a.t === b.t && a.p <= b.p));
  }
});

test('paquetes BLE: ≤20 bytes, cabecera y marcas correctas, ida y vuelta', () => {
  const msgs = [];
  for (let i = 0; i < 37; i++) msgs.push([0x90, 40 + i, 100]);
  msgs.push([0xc0, 5], [0xb0, 64, 127], [0xe0, 0, 64]);
  const queue = msgs.slice();
  const back = [];
  const ts = 0x1abc;
  while (queue.length) {
    const { packet, taken } = buildPacket(queue, ts, 20);
    assert.ok(taken > 0);
    assert.ok(packet.length <= 20);
    assert.equal(packet[0], 0x80 | ((ts >> 7) & 0x3f));
    assert.equal(packet[1], 0x80 | (ts & 0x7f));
    queue.splice(0, taken);
    back.push(...parsePacket(packet));
  }
  assert.deepEqual(back, msgs);
});

test('parsePacket entiende running status sin marca de tiempo', () => {
  const pkt = Uint8Array.from([0x80, 0x81, 0x90, 60, 100, 64, 90, 0x82, 67, 80]);
  assert.deepEqual(parsePacket(pkt), [[0x90, 60, 100], [0x90, 64, 90], [0x90, 67, 80]]);
});

function makePlayer() {
  let now = 0;
  const sent = [];
  const out = { send: m => sent.push({ t: now, m }), clear() {} };
  const p = new Player(out, { now: () => now });
  const advance = (ms, step = 5) => { for (let x = 0; x < ms; x += step) { now += step; p.tick(); } };
  return { p, sent, advance, setNow: v => { now = v; } };
}

function hanging(sent) {
  const on = new Map();
  for (const { m } of sent) {
    const type = m[0] & 0xf0, ch = m[0] & 15;
    if (type === 0x90 && m[2] > 0) on.set((ch << 7) | m[1], true);
    if (type === 0x80 || (type === 0x90 && m[2] === 0)) on.delete((ch << 7) | m[1]);
    if (type === 0xb0 && m[1] === 123) for (const k of [...on.keys()]) if ((k >> 7) === ch) on.delete(k);
  }
  return on.size;
}

test('reproductor: toca todo a tiempo y termina sin notas colgadas', () => {
  const tl = loadMidi(readFileSync(new URL('multi.mid', fx)));
  const { p, sent, advance } = makePlayer();
  let ended = false;
  p.addEventListener('ended', () => { ended = true; });
  p.load(tl);
  p.play();
  advance(tl.duration + 100);
  assert.ok(ended);
  const ons = sent.filter(s => (s.m[0] & 0xf0) === 0x90);
  assert.equal(ons.length, tl.noteCount);
  // cada encendido sale como mucho un tick (5 ms) después de su hora
  const want = tl.events.filter(e => e.type === 0x90).map(e => e.t);
  ons.forEach((s, i) => assert.ok(s.t - want[i] <= 5.0001 && s.t >= want[i] - 1e-9, `nota ${i}: ${s.t} vs ${want[i]}`));
  assert.equal(hanging(sent), 0);
});

test('pausa, salto y cambio de modo no dejan notas colgadas', () => {
  const tl = loadMidi(readFileSync(new URL('multi.mid', fx)));
  const { p, sent, advance } = makePlayer();
  p.load(tl);
  p.play(); advance(3000);
  p.pause(); assert.equal(hanging(sent), 0);
  p.play(); advance(1500);
  p.seek(20000); advance(800);
  p.setMode('piano'); advance(800);
  // en modo piano todo va al canal 4 (índice 3) y no hay batería ni cambios de programa
  const after = sent.slice(sent.findLastIndex(s => s.m[0] === 0xb3 && s.m[1] === 7));
  assert.ok(after.every(s => (s.m[0] & 0x0f) === 3 || (s.m[0] & 0xf0) === 0xb0));
  assert.ok(!after.some(s => (s.m[0] & 0xf0) === 0xc0));
  p.setSpeed(1.5); advance(800);
  p.stop();
  assert.equal(hanging(sent), 0);
});

test('al saltar recupera programa y pedal del punto de destino', () => {
  const tl = loadMidi(readFileSync(new URL('multi.mid', fx)));
  const { p, sent } = makePlayer();
  p.load(tl);
  p.seek(2000);           // el pedal está pisado entre 1 s y 3 s en las tres pistas
  sent.length = 0;
  p.play();
  const pedal = sent.filter(s => (s.m[0] & 0xf0) === 0xb0 && s.m[1] === 64);
  assert.ok(pedal.length >= 1 && pedal.every(s => s.m[2] === 127));
  const progs = sent.filter(s => (s.m[0] & 0xf0) === 0xc0).map(s => [s.m[0] & 15, s.m[1]]);
  assert.ok(progs.some(([ch, pg]) => pg === 48), 'cuerdas (48) en su canal');
});

test('descarta notas muy atrasadas (pestaña congelada) pero apaga bien', () => {
  const tl = loadMidi(odeToJoy());
  const { p, sent, setNow } = makePlayer();
  p.load(tl);
  p.play();
  setNow(10000); p.tick();          // salto de 10 s de golpe
  const burst = sent.filter(s => (s.m[0] & 0xf0) === 0x90);
  assert.ok(burst.length <= 3, `ráfaga de ${burst.length} notas`);
  p.stop();
  assert.equal(hanging(sent), 0);
});

test('SysEx de volumen general: cabe en un paquete y lleva marca antes del F7', () => {
  const sx = [0xf0, 0x7f, 0x7f, 0x04, 0x01, 0x00, 0x50, 0xf7];
  const { packet, taken } = buildPacket([[0x90, 60, 100], sx, [0x80, 60, 0]], 0x0123, 20);
  assert.equal(taken, 3);
  const lo = 0x80 | (0x0123 & 0x7f);
  assert.deepEqual([...packet], [0x80 | ((0x0123 >> 7) & 0x3f), lo, 0x90, 60, 100, lo, 0xf0, 0x7f, 0x7f, 0x04, 0x01, 0x00, 0x50, lo, 0xf7, lo, 0x80, 60, 0]);
  assert.ok(packet.length <= 20);
});

import { analyzeMidi } from '../js/quality.js';
import { buildTimeline } from '../js/midi.js';
const quality = f => { const m = parseMidi(readFileSync(new URL(f, fx))); return analyzeMidi(m, buildTimeline(m)); };

test('calidad: interpretación real de ASAP → Interpretada con nota alta', () => {
  const q = quality('asap-performance.mid');
  assert.equal(q.label, 'performed');
  assert.ok(q.score >= 80, `nota ${q.score}`);
});

test('calidad: partitura de ASAP y folk de Nottingham → no interpretadas, nota baja', () => {
  for (const f of ['asap-score.mid', 'nottingham-folk.mid']) {
    const q = quality(f);
    assert.notEqual(q.label, 'performed', f);
    assert.ok(q.score < 50, `${f}: nota ${q.score}`);
    assert.ok(q.reasons.length > 0);
  }
});
