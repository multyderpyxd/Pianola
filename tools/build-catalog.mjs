// Construye catalog/index.json: colecciones abiertas alojadas en GitHub, con la calidad
// de cada archivo ya analizada. La app busca en este índice y descarga cada MIDI
// directamente de raw.githubusercontent.com (CORS abierto), fijado a un commit.
//
// Uso: node tools/build-catalog.mjs /ruta/datos   (ver docs/catalogo.md para preparar los datos)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseMidi, buildTimeline } from '../js/midi.js';
import { analyzeMidi } from '../js/quality.js';

const root = process.argv[2] || '/tmp/data';
const LABEL_CODE = { performed: 0, expressive: 1, mechanical: 2 };

const COLLECTIONS = [
  {
    id: 'asap', name: 'Concertistas', genre: 'Clásica',
    full: 'ASAP · interpretaciones de concurso grabadas en Yamaha Disklavier',
    license: 'CC BY-NC-SA 4.0', url: 'https://github.com/fosfrancesco/asap-dataset',
    repo: 'fosfrancesco/asap-dataset', sha: 'afc815c75c42e83a79c03feb6da8a35e77d4c6b8',
  },
  {
    id: 'supra', name: 'Rollos históricos', genre: 'Clásica',
    full: 'SUPRA · rollos Welte-Mignon (1905-1932) de la Universidad de Stanford',
    license: 'CC BY-NC-SA 4.0', url: 'https://github.com/pianoroll/SUPRA',
    repo: 'pianoroll/SUPRA', sha: 'b2becba0d0d860eddc560bbaca858688c0bcda41',
  },
  {
    id: 'pop909', name: 'Pop al piano', genre: 'Pop',
    full: 'POP909 · 909 canciones pop chinas arregladas para piano por músicos',
    license: 'MIT', url: 'https://github.com/music-x-lab/POP909-Dataset',
    repo: 'music-x-lab/POP909-Dataset', sha: 'd83e6edba6872a704f5d3b8b32f5cb540088dae6',
  },
];

const COMPOSERS_ES = {
  Bach: 'Johann Sebastian Bach', Balakirev: 'Mili Balákirev', Beethoven: 'Ludwig van Beethoven', Brahms: 'Johannes Brahms',
  Chopin: 'Frédéric Chopin', Debussy: 'Claude Debussy', Glinka: 'Mijaíl Glinka', Haydn: 'Joseph Haydn', Liszt: 'Franz Liszt',
  Mozart: 'Wolfgang Amadeus Mozart', Prokofiev: 'Serguéi Prokófiev', Rachmaninoff: 'Serguéi Rajmáninov', Ravel: 'Maurice Ravel',
  Schubert: 'Franz Schubert', Schumann: 'Robert Schumann', Scriabin: 'Aleksandr Skriabin',
};
const ORD = { 1: '1.er', 2: '2.º', 3: '3.er', 4: '4.º' };

function asapTitle(t) {
  let m;
  if ((m = t.match(/^Piano_Sonatas_(\d+)-(\d+)$/))) return `Sonata para piano n.º ${m[1]} · ${ORD[m[2]] || m[2] + '.º'} mov.`;
  if ((m = t.match(/^Keyboard_Sonatas_(.+)$/))) return `Sonata ${m[1].replace(/_/g, ' ')}`;
  if ((m = t.match(/^(Prelude|Fugue)_bwv_(\d+)$/))) return `${m[1] === 'Prelude' ? 'Preludio' : 'Fuga'} BWV ${m[2]}`;
  if ((m = t.match(/^Etudes_op_(\d+)_(\d+)$/))) return `Estudio op. ${m[1]} n.º ${m[2]}`;
  if ((m = t.match(/^Transcendental_Etudes_(\d+)$/))) return `Estudio trascendental n.º ${m[1]}`;
  if ((m = t.match(/^Ballades_(\d+)$/))) return `Balada n.º ${m[1]}`;
  if ((m = t.match(/^Scherzos_(\d+)$/))) return `Scherzo n.º ${m[1]}`;
  if ((m = t.match(/^Preludes_op_(\d+)_(\d+)$/))) return `Preludio op. ${m[1]} n.º ${m[2]}`;
  if ((m = t.match(/^Kreisleriana_(\d+)$/))) return `Kreisleriana · ${m[1]}`;
  if ((m = t.match(/^Impromptu_op\.?(\d+)(?:_D\.\d+)?_(\d+).*$/))) return `Impromptu op. ${m[1]} n.º ${m[2]}`;
  return t.replace(/_/g, ' ').replace(/\bop\b\.?\s*/g, 'op. ').replace(/\bno\b\.?\s*/gi, 'n.º ').replace(/\s+/g, ' ').trim();
}
function asapPerformer(file) {
  const base = file.split('/').pop();
  const m = base.match(/^(.+?)(\d{2})M?(?:_\d+)?\.mid$/);
  if (!m) return null;
  const cap = w => w.charAt(0) + w.slice(1).toLowerCase();
  let name = m[1];
  if (name.includes('_')) {
    const [last, ...rest] = name.split('_').filter(Boolean);
    name = `${cap(last)}${rest.length ? ' ' + rest.map(x => x + '.').join(' ') : ''}`;
  } else {
    const k = name.match(/^([A-Z]?[a-z]+(?:[A-Z][a-z]+)*)([A-Z]{1,2})?$/);
    name = k ? `${k[1]}${k[2] ? ' ' + k[2].split('').map(x => x + '.').join(' ') : ''}` : cap(name);
  }
  return name;
}
const decodeEntities = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
function personName(s) {
  // «Chopin, Frédéric (1810-1849)» → «Frédéric Chopin»
  if (!s) return '';
  const clean = decodeEntities(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const [last, first] = clean.split(/,\s*/);
  return first ? `${first} ${last}` : clean;
}

function analyze(file) {
  const buf = readFileSync(file);
  const midi = parseMidi(buf);
  const tl = buildTimeline(midi);
  const q = analyzeMidi(midi, tl);
  return { dur: Math.round(tl.duration / 1000), score: q.score, label: LABEL_CODE[q.label], pianoOnly: q.pianoOnly ? 1 : 0, notes: tl.noteCount };
}

const items = [];
let failed = 0;
function add(col, path, title, who, performer, file) {
  if (!existsSync(file)) { failed++; return; }
  try {
    const a = analyze(file);
    if (a.notes < 20 || a.dur < 15) return;
    items.push([COLLECTIONS.findIndex(c => c.id === col), path, title, who, performer || '', a.dur, a.score, a.label, a.pianoOnly]);
  } catch { failed++; }
}

// ASAP: una fila por interpretación
const csv = readFileSync(join(root, 'asap/metadata.csv'), 'utf8').trim().split('\n').slice(1);
for (const line of csv) {
  const c = line.split(',');
  const composer = COMPOSERS_ES[c[0]] || c[0];
  add('asap', c[5], asapTitle(c[1]), composer, asapPerformer(c[5]), join(root, 'asap', c[5]));
}

// SUPRA: índice ATON
const aton = readFileSync(join(root, 'supra/index.aton'), 'utf8').split('@@BEGIN: ROLL').slice(1);
for (const block of aton) {
  const get = k => (block.match(new RegExp(`^@${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim() || '';
  const druid = get('DRUID');
  if (!druid) continue;
  const path = `welte-red/midi-exp/${druid}_exp.mid`;
  add('supra', path, decodeEntities(get('TITLE')).replace(/\s+:\s*/g, ': ').replace(/\s+/g, ' '), personName(get('COMPOSER')) || 'Anónimo', personName(get('PERFORMER')), join(root, 'supra', path));
}

// POP909
const pop = JSON.parse(readFileSync(join(root, 'pop909_index.json'), 'utf8'));
for (const [id, s] of Object.entries(pop)) {
  const path = `POP909/${id}/${id}.mid`;
  add('pop909', path, s.name, s.artist, '', join(root, 'pop909', path));
}

const out = {
  v: 1,
  built: new Date().toISOString().slice(0, 10),
  collections: COLLECTIONS.map(({ repo, sha, ...c }) => ({ ...c, base: `https://raw.githubusercontent.com/${repo}/${sha}/` })),
  fields: ['coleccion', 'ruta', 'titulo', 'autor', 'interprete', 'segundos', 'nota', 'etiqueta', 'pianoSolo'],
  items,
};
mkdirSync('catalog', { recursive: true });
writeFileSync('catalog/index.json', JSON.stringify(out));
const by = COLLECTIONS.map((c, i) => `${c.id}: ${items.filter(x => x[0] === i).length}`).join(', ');
console.log(`catálogo: ${items.length} obras (${by}); fallidas ${failed}; ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
