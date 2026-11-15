# Fuentes de repertorio para Pianola

Inventario hecho el 15/11/2026. «Acceso directo» = la app puede descargar cada archivo desde el navegador (CORS). GitHub sirve los archivos de sus repositorios desde `raw.githubusercontent.com` con `Access-Control-Allow-Origin: *`, así que cualquier colección alojada allí archivo a archivo es utilizable sin servidor propio.

| Fuente | Qué es | Tamaño | Licencia | Acceso | Estado |
|---|---|---|---|---|---|
| **BitMidi** | Archivo público de MIDIs de la web «clásica» (pop, cine, videojuegos, clásica) subidos por usuarios | > 100 000 | Variada; muchos son arreglos de obras con derechos | API de búsqueda y descargas con CORS | Integrado (v1.1). Calidad muy desigual → análisis al vuelo |
| **ASAP** (fosfrancesco/asap-dataset) | Interpretaciones de concertistas grabadas en Yamaha Disklavier (subconjunto de MAESTRO), alineadas con su partitura | 1 067 interpretaciones + 222 partituras MIDI · 16 compositores | CC BY-NC-SA 4.0 | GitHub, archivo a archivo | Catálogo v1 · y conjunto etiquetado para validar el detector |
| **SUPRA** (pianoroll/SUPRA) | Rollos de pianola Welte-Mignon (1905-1932) con expresión: grabaciones históricas de pianistas | 456 | CC BY-NC-SA 4.0 | GitHub, archivo a archivo | Catálogo v1 |
| **POP909** (music-x-lab/POP909-Dataset) | 909 canciones pop arregladas para piano por músicos (melodía, puente y acompañamiento) | 909 (+ versiones) | MIT | GitHub, archivo a archivo | Catálogo v1 |
| Nottingham (jukedeck/nottingham-dataset) | Melodías folk británicas con acordes, transcritas de ABC | ~1 000 | GPL-3.0 | GitHub | Opcional: muy mecánico, útil solo por variedad |
| VGMIDI (lucasnfe/vgmidi) | Arreglos para piano de bandas sonoras de videojuegos | ~200 | Sin licencia declarada | GitHub | Descartado por licencia |
| GiantMIDI-Piano | 10 855 transcripciones de grabaciones de piano clásico | 10 855 | CC BY 4.0 | Google Drive (en GitHub solo 159 de evaluación) | Futuro, vía GitHub Actions |
| **PiJAMA** | Jazz para piano solo transcrito de 244 discos, 120 pianistas | 2 777 | CC BY 4.0 | Zenodo (zip de 60 MB) | Futuro: una GitHub Action puede descargarlo y publicarlo archivo a archivo |
| MAESTRO v3 | Concurso Yamaha e-Competition, Disklavier | 1 276 | CC BY-NC-SA 4.0 | Zip en Google Cloud Storage | Futuro, vía GitHub Actions (ASAP ya cubre parte) |
| Aria-MIDI / PianoCoRe | Más de un millón de grabaciones de piano transcritas, con género y compositor | 1,18 M / 250 k | CC BY-NC-SA 4.0 | Hugging Face / Zenodo, en paquetes | Futuro: subconjuntos por género |
| piano-midi.de | Clásica secuenciada a mano con mucha expresión | 571 | CC BY-SA | Web sin CORS ni API | Futuro (requiere espejo) |
| Mutopia | Partituras de dominio público con MIDI generado | ~2 100 | DP / CC | Web sin CORS; el repositorio solo tiene fuentes LilyPond | Descartado por ahora |
| Kunstderfuge, Classical Archives, VGMusic, FreeMidi, MidiWorld | Colecciones web | — | Restrictivas o sin licencia | Sin API | Descartadas |

## Cómo se amplía

1. **Directo (hecho en la app):** fuentes con CORS (BitMidi, GitHub).
2. **Catálogo precalculado:** un script recorre la colección, analiza la calidad de cada archivo y genera `catalog/*.json`; la app busca en local y descarga el archivo de GitHub solo al tocarlo.
3. **Espejo con GitHub Actions:** para colecciones en Zenodo, Google Drive o Hugging Face, una Action descarga el paquete, lo descomprime en una rama de datos del propio repositorio y el catálogo apunta allí. Mantiene la atribución y la licencia de cada fuente.
