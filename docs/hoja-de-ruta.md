# Hoja de ruta

Hecho la noche del 15/11/2026: detector de calidad validado (v1.2), catálogo de 2 432 obras (v1.3) y colecciones temáticas con «Reproducir» (v1.4).

## Siguientes pasos propuestos

1. **Jazz y más clásica con GitHub Actions.** PiJAMA (2 777 interpretaciones de jazz, CC BY 4.0, en Zenodo), MAESTRO (1 276, CC BY-NC-SA, en Google Cloud Storage) y GiantMIDI-Piano (10 855, CC BY 4.0) no están archivo a archivo en GitHub. Una Action puede descargarlos, descomprimirlos en una rama `catalog-data` de este repositorio y regenerar `catalog/index.json` con `tools/build-catalog.mjs`. La app ya descarga desde `raw.githubusercontent.com`, así que no hace falta nada más en el cliente.
2. **Practicar con una mano.** Silenciar la pista o el registro de la mano izquierda o derecha (las colecciones de interpretación suelen venir en una sola pista; se separaría por tesitura o con un clasificador simple).
3. **Del audio al MIDI.** Transcribir grabaciones propias o de YouTube con un modelo de transcripción de piano (p. ej. el de ByteDance o Aria-AMT) en un servidor, y pasarlas por el detector de calidad.
4. **Detector v2.** Reconocer el «humanizado» aleatorio por software (variaciones sin correlación musical) y la sustitución de dinámicas por bloques.
