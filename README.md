# Pianola

Web app instalable (PWA) que reproduce archivos MIDI en un Roland FP-10 por Bluetooth MIDI. Sin dependencias ni paso de compilación: lo que hay en el repositorio es exactamente lo que se publica.

## Qué hace

- Biblioteca local de canciones (IndexedDB): importar varios `.mid` a la vez, buscar, favoritas, renombrar, eliminar con «Deshacer» y ordenar por recientes, A–Z o más tocadas.
- **Catálogo Pianola**: 2 432 obras de colecciones abiertas (concertistas en Disklavier, rollos Welte de 1905-1932, pop al piano) con su calidad ya analizada; búsqueda local por obra, compositor o intérprete, colecciones temáticas («Para dormir», «Leyendas del piano», «Virtuosismo», «Bailes de los años 20») con botón de reproducir todo, y descarga directa desde GitHub (docs/catalogo.md).
- **Calidad**: cada MIDI se clasifica como Interpretada, Expresiva o Mecánica con una nota de 0 a 100 y su porqué (docs/calidad.md, 99,95 % de acierto en la validación).
- **Explorar**: busca en el archivo público de [BitMidi](https://bitmidi.com) (más de 100.000 MIDIs), escucha cualquier resultado en el piano sin guardarlo y guárdalo con ＋. La API de búsqueda y las descargas de BitMidi admiten CORS, así que no hace falta servidor propio.
- **Listas**: crea listas, añade canciones (selector múltiple o desde el menú de cada canción), reordénalas y reprodúcelas de principio a fin.
- **Temporizador**: para la música tras 15–120 min o al terminar la canción, dejando acabar la que suena.
- **Volumen del piano** desde el móvil con el mensaje universal *Master Volume* (`F0 7F 7F 04 01 00 vv F7`), que el FP-10 recibe según su MIDI Implementation.
- Recibe archivos desde «Compartir» en Android (WhatsApp, Drive, Descargas…) una vez instalada.
- Reproductor con cola, siguiente/anterior, aleatorio, repetir (lista o canción), barra de posición y velocidad de 25 % a 200 %.
- Dos modos de sonido: **original** (cada pista con su instrumento GM2 del piano) y **piano del FP-10** (todo por el canal 4, que suena con el tono elegido en el panel; sin batería).
- Notas que caen y teclado visual; lo que tocas tú en el piano se ilumina en dorado.
- Conexión en un toque, reconexión automática si se corta y nunca deja notas colgadas al pausar, saltar o cambiar de modo.
- Funciona sin conexión a internet después de la primera visita.

## Dónde está publicada

**https://multyderpyxd.github.io/Pianola/** — GitHub Pages sirve la raíz de la rama `main` tal cual (sin compilación; `.nojekyll` evita el procesado de Jekyll). Cada push a `main` publica la nueva versión; sube también `VERSION` en `sw.js` para que los móviles instalados se actualicen.

Alternativa con Firebase Hosting (incluido `firebase.json`): `firebase deploy --only hosting --project TU-PROYECTO`.

## Instalarla en el móvil

1. Abre la URL en **Chrome para Android**.
2. Menú ⋮ → **Instalar aplicación** (o «Añadir a pantalla de inicio»).
3. Ábrela desde el icono: a partir de ahí aparece en el menú «Compartir» para archivos MIDI.

## Conectar el FP-10

1. Enciende el piano. Cuando su Bluetooth está listo, el botón **FUNCTION** se ilumina.
2. **No** lo emparejes desde los ajustes de Bluetooth de Android. Si ya lo hiciste, olvídalo allí.
3. En Pianola toca **Conectar** (o directamente una canción) y elige el FP-10 en el selector de Chrome.
4. Acepta el permiso de «Dispositivos cercanos» (y la ubicación en Android antiguos).
5. El piano atiende a una sola app: cierra Piano Every Day / Roland Piano App si estaban conectadas.

## Probar sin piano

Añade `?demo` a la URL (por ejemplo `http://localhost:8080/?demo`) para usar un piano simulado.

```bash
npm run serve      # sirve la app en http://localhost:8080 (localhost cuenta como seguro)
npm test           # pruebas del lector MIDI, el empaquetado BLE y el reproductor
```

## Límites conocidos

- **Solo Android + Chrome** (u otro navegador Chromium). Safari en iPhone no tiene Web Bluetooth.
- Por defecto la pantalla se mantiene encendida mientras suena y la música se pausa si sales de la app, porque Android ralentiza las páginas en segundo plano. El ajuste «Seguir sonando fuera de la app» es experimental: mantiene la app viva con un audio silencioso y controles en la notificación.
- Se ignoran los mensajes SysEx de los archivos (reinicios GM, efectos propietarios de otros sintes).
- Los paquetes BLE se limitan a 20 bytes (lo mínimo garantizado); en pasajes muy densos con acordes enormes puede haber unos milisegundos de dispersión.

## Estructura

```
index.html, styles.css, manifest.webmanifest, sw.js
js/midi.js          lector SMF + línea temporal en ms (+ escritor mínimo)
js/ble.js           Bluetooth MIDI: conexión, empaquetado, cola de escritura, entrada
js/player.js        reloj, envío a tiempo, saltos con recuperación de estado, modos
js/library.js       IndexedDB (canciones, archivos y listas)
js/online.js        BitMidi y catálogo: búsqueda y descarga
js/quality.js       detector de calidad
catalog/index.json  índice del catálogo (tools/build-catalog.mjs)
tools/              evaluación del detector y construcción del catálogo
docs/               fuentes, calidad, catálogo y hoja de ruta
js/app.js           interfaz
js/clock-worker.js  reloj en un worker
js/demo.js          «Himno de la alegría» generado al vuelo
tests/              pruebas (Node) y generadores de MIDIs de referencia (Python)
```

Fuentes: Instrument Serif y Geist (licencia SIL OFL, en `fonts/`).
