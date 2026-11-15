// Evalúa el detector de calidad sobre colecciones con origen conocido.
// Uso: node tools/eval-quality.mjs /ruta/datos
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseMidi, buildTimeline } from '../js/midi.js';
import { analyzeMidi } from '../js/quality.js';

const root = process.argv[2] || '/tmp/data';
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.midi?$/i.test(f) ? [p] : []; });

const sets = [
  { name: 'ASAP interpretaciones', dir: 'asap', filter: p => !/midi_score\.mid$/.test(p), truth: 'performed' },
  { name: 'ASAP partituras', dir: 'asap', filter: p => /midi_score\.mid$/.test(p), truth: 'notperf' },
  { name: 'SUPRA rollos Welte', dir: 'supra', truth: 'performed' },
  { name: 'GiantMIDI transcripciones', dir: 'giant/midis_for_evaluation/giantmidi-piano', truth: 'performed' },
  { name: 'GiantMIDI maestro', dir: 'giant/midis_for_evaluation/maestro', truth: 'performed' },
  { name: 'GiantMIDI ground_truth', dir: 'giant/midis_for_evaluation/ground_truth', truth: null },
  { name: 'Nottingham folk', dir: 'nott', truth: 'notperf' },
  { name: 'POP909', dir: 'pop909', truth: null },
];

const rows = [];
let tp = 0, fp = 0, tn = 0, fn = 0;
const mistakes = [];
for (const s of sets) {
  let files;
  try { files = walk(join(root, s.dir)).filter(s.filter || (() => true)); } catch { continue; }
  const lab = { performed: 0, expressive: 0, mechanical: 0 }, scores = [];
  let errors = 0;
  for (const f of files) {
    let q;
    try { const m = parseMidi(readFileSync(f)); q = analyzeMidi(m, buildTimeline(m)); } catch { errors++; continue; }
    lab[q.label]++; scores.push(q.score);
    if (s.truth) {
      const pred = q.label === 'performed';
      if (s.truth === 'performed') pred ? tp++ : (fn++, mistakes.push([s.name, f, q]));
      else pred ? (fp++, mistakes.push([s.name, f, q])) : tn++;
    }
  }
  scores.sort((a, b) => a - b);
  const med = scores[Math.floor(scores.length / 2)] ?? 0;
  rows.push({ set: s.name, n: scores.length, err: errors, ...lab, mediana: med, p10: scores[Math.floor(scores.length * 0.1)] ?? 0, p90: scores[Math.floor(scores.length * 0.9)] ?? 0 });
}
console.table(rows);
const acc = (tp + tn) / Math.max(1, tp + tn + fp + fn);
console.log(`Interpretada vs. no interpretada → acierto ${(acc * 100).toFixed(1)} %  (VP ${tp}, FN ${fn}, VN ${tn}, FP ${fp})`);
if (process.argv.includes('--errores')) for (const [set, f, q] of mistakes.slice(0, 25)) console.log(set, '|', f.split('/').slice(-3).join('/'), '|', q.label, q.score, JSON.stringify(q.features.sub), q.features.velDistinct, q.features.gridness, q.features.syncFrac);
