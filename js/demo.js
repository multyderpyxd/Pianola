// demo.js — Canción de ejemplo generada al vuelo (dominio público):
// «Himno de la alegría», L. v. Beethoven, arreglo sencillo a dos manos.

import { writeMidi } from './midi.js';

const TPQ = 480;
const Q = TPQ, H = TPQ * 2, E = TPQ / 2, DQ = TPQ * 1.5;

// Notas: C4 = 60
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, G3 = 55;

const A = [[E4, Q], [E4, Q], [F4, Q], [G4, Q], [G4, Q], [F4, Q], [E4, Q], [D4, Q], [C4, Q], [C4, Q], [D4, Q], [E4, Q]];
const phraseA = [...A, [E4, DQ], [D4, E], [D4, H]];
const phraseA2 = [...A, [D4, DQ], [C4, E], [C4, H]];
const phraseB = [
  [D4, Q], [D4, Q], [E4, Q], [C4, Q],
  [D4, Q], [E4, E], [F4, E], [E4, Q], [C4, Q],
  [D4, Q], [E4, E], [F4, E], [E4, Q], [D4, Q],
  [C4, Q], [D4, Q], [G3, H],
];
const melody = [...phraseA, ...phraseA2, ...phraseB, ...phraseA2];

// Armonía por compás: [acorde de la 1.ª mitad, acorde de la 2.ª mitad]
const CH = { C: { root: 48, chord: [52, 55] }, G: { root: 43, chord: [47, 50, 53] } };
const harmonyA = [['C', 'C'], ['G', 'G'], ['C', 'C'], ['G', 'G']];
const harmonyA2 = [['C', 'C'], ['G', 'G'], ['C', 'C'], ['G', 'C']];
const harmonyB = [['G', 'G'], ['G', 'C'], ['G', 'G'], ['C', 'G']];
const harmony = [...harmonyA, ...harmonyA2, ...harmonyB, ...harmonyA2];

function note(events, tick, n, dur, vel, ch = 0) {
  events.push({ tick, data: [0x90 | ch, n, vel], order: 1 });
  events.push({ tick: tick + dur - 12, data: [0x80 | ch, n, 64], order: 0 });
}

export function odeToJoy() {
  const bpm = 104;
  const uspq = Math.round(60000000 / bpm);
  const right = [];
  const left = [];
  right.push({ tick: 0, data: [0xff, 0x51, 3, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255] });
  right.push({ tick: 0, data: [0xc0, 0] });
  left.push({ tick: 0, data: [0xc1, 0] });

  let t = 0;
  melody.forEach(([n, d], i) => {
    const beatAccent = t % (TPQ * 4) === 0 ? 8 : 0;
    const shape = Math.round(6 * Math.sin(i / 3));
    note(right, t, n, d, 74 + beatAccent + shape);
    t += d;
  });
  const total = t;

  const bar = TPQ * 4;
  harmony.forEach(([h1, h2], b) => {
    const t0 = b * bar;
    const a = CH[h1], c = CH[h2];
    note(left, t0, a.root, H, 58, 1);
    c.chord.forEach(n => note(left, t0 + H, n, H, 46, 1));
    // pedal: se levanta justo antes de cada compás y se vuelve a pisar tras el ataque
    left.push({ tick: t0 + 30, data: [0xb1, 64, 127] });
    left.push({ tick: t0 + bar - 20, data: [0xb1, 64, 0], order: 0 });
  });
  left.push({ tick: total + 40, data: [0xb1, 64, 0] });

  return writeMidi({
    tpq: TPQ,
    tracks: [
      { name: 'Mano derecha', events: right },
      { name: 'Mano izquierda', events: left },
    ],
  });
}

export const DEMO_TITLE = 'Himno de la alegría — Beethoven';
