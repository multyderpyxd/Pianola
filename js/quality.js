// quality.js — ¿Este MIDI lo tocó una persona o lo escribió un programa?
//
// Mide huellas que deja cada forma de crear un MIDI:
//  · dinámica: cuántas fuerzas de nota distintas hay y cómo varían
//  · tiempo: si los ataques caen exactos en la rejilla o «respiran»
//  · acordes: si sus notas entran a la vez (programa) o escalonadas (manos)
//  · articulación: variedad de duraciones
//  · pedal: ausente, todo/nada, o continuo (medio pedal: solo sale de un piano real)
//  · mapa de tempo: cambios de tempo que imitan el rubato
//  · soltar tecla: velocidad de note-off (solo la registra un teclado físico)
//  · metadatos: firmas de programas de partituras o de grabación
// y lo resume en una nota de 0 a 100 y una etiqueta.

export const LABELS = {
  performed: { short: 'Interpretada', long: 'Tocada por una persona en un instrumento real' },
  expressive: { short: 'Expresiva', long: 'Secuenciada a mano con dinámica o rubato' },
  mechanical: { short: 'Mecánica', long: 'Escrita con un programa: tiempos y fuerzas uniformes' },
};

const SOFTWARE_RE = /finale|sibelius|musescore|noteworthy|encore|guitar ?pro|cakewalk|cubase|band-in-a-box|lilypond|abc2midi|harmony assistant|capella|overture|anvil studio|midi ?illustrator|notation|score ?writer|powertab|tuxguitar|rosegarden|reaper/i;
const LIVE_RE = /disklavier|e-competition|performed by|played by|recorded (live|by)|live recording|transcri/i;
const ROLL_RE = /welte|ampico|duo-art|piano ?roll|pianola/i;

const sat = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function toNotes(midi) {
  // Notas con ticks (para la rejilla) emparejadas por canal y tecla.
  const all = [];
  midi.tracks.forEach((t, ti) => t.events.forEach((e, i) => { if (e.kind === 'ch') all.push({ ...e, ti, i }); }));
  all.sort((a, b) => a.tick - b.tick || a.ti - b.ti || a.i - b.i);
  const open = new Map();
  const notes = [];
  const ctrl = [];
  let offVels = new Set();
  let explicitOffs = 0;
  for (const e of all) {
    const k = (e.ch << 7) | e.d1;
    if (e.type === 0x90 && e.d2 > 0) {
      const n = { tick: e.tick, offTick: -1, ch: e.ch, pitch: e.d1, vel: e.d2 };
      notes.push(n);
      let q = open.get(k);
      if (!q) open.set(k, (q = []));
      q.push(n);
    } else if (e.type === 0x80 || e.type === 0x90) {
      if (e.type === 0x80) { explicitOffs++; offVels.add(e.d2); }
      const q = open.get(k);
      if (q && q.length) q.shift().offTick = e.tick;
    } else ctrl.push(e);
  }
  let unmatched = 0;
  const lastTick = all.length ? all[all.length - 1].tick : 0;
  for (const n of notes) if (n.offTick < 0) { n.offTick = lastTick; unmatched++; }
  return { notes, ctrl, offVels, explicitOffs, unmatched };
}

function entropyBits(counts, total) {
  let h = 0;
  for (const c of counts) if (c) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

export function analyzeMidi(midi, tl) {
  const ppq = midi.division & 0x8000 ? 0 : (midi.division || 480);
  const { notes, ctrl, offVels, explicitOffs, unmatched } = toNotes(midi);
  const pitched = notes.filter(n => n.ch !== 9);
  const N = pitched.length;
  const durationMin = Math.max(tl.duration / 60000, 1 / 60);
  const reasons = [];

  if (N < 8) {
    return { score: 0, label: 'mechanical', features: { notes: N }, reasons: ['Casi no tiene notas'], version: 1 };
  }

  // --- Dinámica
  const velHist = new Array(128).fill(0);
  let sum = 0, sum2 = 0, same = 0;
  pitched.forEach((n, i) => {
    velHist[n.vel]++; sum += n.vel; sum2 += n.vel * n.vel;
    if (i && n.vel === pitched[i - 1].vel) same++;
  });
  const velMean = sum / N;
  const velStd = Math.sqrt(Math.max(0, sum2 / N - velMean * velMean));
  const velDistinct = velHist.filter(Boolean).length;
  const velTop = Math.max(...velHist) / N;
  const velEntropy = entropyBits(velHist, N);
  const velRunSame = same / Math.max(1, N - 1);

  // --- Tiempo: ataques en rejilla (corrigiendo lo que caería por azar)
  let gridness = 0, onGrid = 0, chance = 1;
  if (ppq) {
    const grids = [ppq / 8, ppq / 6].filter(g => Number.isInteger(g) && g >= 1);
    if (grids.length) {
      for (const n of pitched) if (grids.some(g => n.tick % g === 0)) onGrid++;
      const frac = onGrid / N;
      // probabilidad de caer en alguna rejilla si los ticks fueran aleatorios
      const pts = new Set();
      for (const g of grids) for (let t = 0; t < ppq; t += g) pts.add(t);
      chance = pts.size / ppq;
      gridness = chance >= 0.95 ? 0.5 : Math.max(0, (frac - chance) / (1 - chance));
    } else gridness = 0.5;
  }

  // --- Acordes: ¿entran a la vez exacta?
  const byOn = pitched.map(n => ({ t: tl.toMs(n.tick), tick: n.tick })).sort((a, b) => a.t - b.t);
  let chords = 0, syncChords = 0, spreadSum = 0;
  for (let i = 0; i < byOn.length;) {
    let j = i + 1;
    while (j < byOn.length && byOn[j].t - byOn[i].t <= 35) j++;
    if (j - i >= 2) {
      chords++;
      const ticks = new Set(byOn.slice(i, j).map(x => x.tick));
      if (ticks.size === 1) syncChords++;
      spreadSum += byOn[j - 1].t - byOn[i].t;
    }
    i = j;
  }
  const syncFrac = chords ? syncChords / chords : null;
  const chordSpreadMs = chords ? spreadSum / chords : 0;

  // --- Articulación
  const durs = new Map();
  for (const n of pitched) { const d = n.offTick - n.tick; durs.set(d, (durs.get(d) || 0) + 1); }
  const durDistinctRatio = durs.size / N;
  const durEntropy = entropyBits([...durs.values()], N);

  // --- Pedal, tempo, soltar tecla
  const pedal = ctrl.filter(e => e.type === 0xb0 && e.d1 === 64);
  const pedalVals = new Set(pedal.map(e => e.d2));
  const pedalPerMin = pedal.length / durationMin;
  const tempoEvents = midi.tracks.reduce((a, t) => a + t.events.filter(e => e.kind === 'tempo').length, 0);
  const tempoPerMin = Math.max(0, tempoEvents - 1) / durationMin;
  const offVelDistinct = offVels.size;

  // --- Instrumentación y metadatos
  const programs = new Set(ctrl.filter(e => e.type === 0xc0 && e.ch !== 9).map(e => e.d1));
  const channels = new Set(pitched.map(n => n.ch));
  const pianoOnly = !notes.some(n => n.ch === 9) && [...programs].every(p => p <= 7);
  const texts = midi.tracks.flatMap(t => t.texts || []).join(' · ');
  const software = (texts.match(SOFTWARE_RE) || [])[0] || null;
  const liveHint = LIVE_RE.test(texts);
  const rollHint = ROLL_RE.test(texts);
  const timeSigs = midi.tracks.reduce((a, t) => a + (t.timeSigs || 0), 0);

  // --- Integridad
  const dupKeys = new Set();
  let dups = 0;
  for (const n of notes) { const k = `${n.ch}:${n.pitch}:${n.tick}`; if (dupKeys.has(k)) dups++; else dupKeys.add(k); }
  const dupRatio = dups / notes.length;
  const unmatchedRatio = unmatched / notes.length;

  // --- Subpuntuaciones (0 = máquina, 1 = humano)
  const sDyn = 0.4 * sat(velDistinct, 4, 36) + 0.35 * sat(velStd, 3, 14) + 0.25 * (1 - sat(velRunSame, 0.15, 0.75));
  const sGrid = 1 - gridness;
  const sChord = syncFrac === null ? sGrid : 1 - syncFrac;
  const sTime = 0.55 * sGrid + 0.45 * sChord;
  const sArtic = sat(durDistinctRatio, 0.03, 0.35);
  const sPedal = !pianoOnly ? 0.5 : pedal.length === 0 ? 0.15 : pedalVals.size > 4 ? 1 : 0.6;
  const sRubato = sat(tempoPerMin, 1, 25);
  const sKey = sat(offVelDistinct, 2, 20);
  // Nadie toca veinte acordes con todas sus notas en el mismo tick: eso es cuantización.
  const chordVeto = syncFrac !== null && chords >= 20 && syncFrac >= 0.85;

  let score = 100 * (0.32 * sDyn + 0.30 * sTime + 0.12 * sArtic + 0.10 * sPedal + 0.08 * Math.max(sRubato, sTime) + 0.08 * Math.max(sKey, sTime));
  if (chordVeto) score = Math.min(score, 60);
  if (software) score -= 8;
  if (liveHint || rollHint) score += 6;
  if (dupRatio > 0.02) score -= 10 * sat(dupRatio, 0.02, 0.2);
  if (unmatchedRatio > 0.05) score -= 10;
  if (tl.duration < 20000) score -= 10;
  score = Math.round(Math.max(0, Math.min(100, score)));

  let label;
  if (!chordVeto && ((sTime >= 0.55 && sDyn >= 0.45) || (sTime >= 0.85 && sDyn >= 0.1 && sArtic >= 0.25))) label = 'performed';
  else if (sDyn >= 0.5 || sRubato >= 0.35 || (sDyn >= 0.35 && sPedal >= 0.6)) label = 'expressive';
  else label = 'mechanical';
  if (label === 'performed' && score < 50) label = 'expressive';

  // --- Por qué (en lenguaje llano, lo más relevante primero)
  if (velDistinct <= 3) reasons.push(velDistinct === 1 ? 'Todas las notas con la misma fuerza' : `Solo ${velDistinct} fuerzas de nota distintas`);
  else if (sDyn >= 0.7) reasons.push(`Dinámica rica: ${velDistinct} fuerzas de nota distintas`);
  if (gridness >= 0.85) reasons.push('Ataques exactos en la rejilla rítmica');
  else if (gridness <= 0.25 && ppq) reasons.push('Ritmo natural, sin cuantizar');
  if (syncFrac !== null && chords >= 10) {
    if (syncFrac >= 0.9) reasons.push('Las notas de cada acorde entran a la vez exacta');
    else if (syncFrac <= 0.35) reasons.push(`Acordes escalonados como al tocar (≈${Math.round(chordSpreadMs)} ms)`);
  }
  if (pianoOnly) {
    if (pedalVals.size > 4) reasons.push('Pedal continuo, con medio pedal');
    else if (pedal.length) reasons.push('Pedal de todo o nada');
    else reasons.push('Sin pedal');
  } else reasons.push(notes.some(n => n.ch === 9) ? 'Arreglo con batería y varios instrumentos' : 'Arreglo con varios instrumentos');
  if (sRubato >= 0.35) reasons.push('Tempo que respira (rubato secuenciado)');
  if (offVelDistinct > 6) reasons.push('Registra cómo se suelta cada tecla');
  if (software) reasons.push(`Firmado por ${software}`);
  if (rollHint) reasons.push('Rollo de pianola');
  if (dupRatio > 0.02) reasons.push('Notas duplicadas');
  if (tl.duration < 20000) reasons.push('Muy corto');

  return {
    version: 1,
    score,
    label,
    pianoOnly,
    reasons,
    features: {
      notes: N, ppq, velDistinct, velStd: round(velStd, 1), velTop: round(velTop), velEntropy: round(velEntropy),
      velRunSame: round(velRunSame), gridness: round(gridness), gridChance: round(chance), syncFrac: syncFrac === null ? null : round(syncFrac),
      chordSpreadMs: Math.round(chordSpreadMs), chords, durDistinctRatio: round(durDistinctRatio, 3), durEntropy: round(durEntropy),
      pedalEvents: pedal.length, pedalValues: pedalVals.size, pedalPerMin: round(pedalPerMin, 1), tempoEvents, tempoPerMin: round(tempoPerMin, 1),
      offVelDistinct, explicitOffs, programs: [...programs], channels: channels.size, software, liveHint, rollHint, timeSigs,
      dupRatio: round(dupRatio, 3), unmatchedRatio: round(unmatchedRatio, 3),
      sub: { dyn: round(sDyn), time: round(sTime), grid: round(sGrid), chord: round(sChord), artic: round(sArtic), pedal: round(sPedal), rubato: round(sRubato), key: round(sKey) },
    },
  };
}

export function analyzeBuffer(buf, { parseMidi, buildTimeline }) {
  const midi = parseMidi(buf);
  const tl = buildTimeline(midi);
  return analyzeMidi(midi, tl);
}
