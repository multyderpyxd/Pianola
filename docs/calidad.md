# Detector de calidad de MIDIs

`js/quality.js` estima si un MIDI fue **tocado por una persona** en un instrumento real, **secuenciado a mano con expresión** o **escrito por un programa** sin expresión. Funciona en el navegador (sin servidor) y tarda unos milisegundos por archivo.

## Señales que mide

| Señal | Humano | Programa |
|---|---|---|
| Fuerzas de nota (velocity) distintas, desviación y repeticiones seguidas | Decenas de valores que varían nota a nota | 1–5 valores fijos (p, mf, f…) |
| Ataques en rejilla de 1/32 o tresillo (corregido por azar) | Fuera de rejilla | Exactos |
| Acordes: ¿todas sus notas en el mismo tick? | Escalonados 5–30 ms | Simultáneos |
| Variedad de duraciones | Alta | Pocas duraciones distintas |
| Pedal de resonancia (CC64) | Continuo, con medio pedal | Ausente o todo/nada |
| Cambios de tempo por minuto | (secuenciado expresivo) muchos | Uno |
| Velocidad al soltar la tecla | Variable | Ninguna o fija |
| Metadatos | Disklavier, rollos… | Finale, Sibelius, MuseScore… |
| Integridad | — | Notas duplicadas, archivos cortados |

Con ellas calcula subpuntuaciones (dinámica, tiempo, articulación, pedal, rubato, tecla), una **nota de 0 a 100** y una etiqueta:

- **Interpretada**: tiempo humano y dinámica rica (o tiempo claramente humano con algo de dinámica). Un veto impide esta etiqueta si 20 o más acordes tienen todas sus notas en el mismo tick.
- **Expresiva**: tiempos cuantizados, pero con dinámica, pedal o rubato puestos a mano.
- **Mecánica**: tiempos y fuerzas uniformes.

## Validación (15/11/2026)

`node tools/eval-quality.mjs /ruta/datos` sobre colecciones de origen conocido:

| Colección | Archivos | Interpretada | Expresiva | Mecánica | Nota mediana |
|---|---|---|---|---|---|
| ASAP · interpretaciones de concertistas (Disklavier) | 1 067 | 1 067 | 0 | 0 | 94 |
| ASAP · las mismas obras exportadas de la partitura | 235 | 0 | 147 | 88 | 25 |
| SUPRA · rollos Welte-Mignon (1905-1932) | 456 | 455 | 1 | 0 | 89 |
| GiantMIDI · transcripciones de grabaciones | 52 | 52 | 0 | 0 | 94 |
| GiantMIDI · MAESTRO | 52 | 52 | 0 | 0 | 93 |
| Nottingham · folk desde ABC | 300 | 0 | 0 | 300 | 2 |
| POP909 · arreglos pop (dinámica humana, tiempos cuantizados) | 909 | 181 | 725 | 3 | 60 |

**Interpretada frente a no interpretada: 2 162 de 2 163 aciertos (99,95 %).** El único fallo es un rollo Welte con solo dos niveles de dinámica, que sale como «Expresiva».

Límites conocidos: un archivo «humanizado» por software con variaciones aleatorias de tiempo y fuerza puede pasar por interpretado; las partituras con muchos grupos irregulares (quintillos, septillos) no caen en la rejilla, pero el veto de acordes las detecta.
