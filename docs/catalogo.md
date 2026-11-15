# Catálogo Pianola

`catalog/index.json` es un índice de colecciones MIDI abiertas alojadas en GitHub. La app busca en él sin conexión y, al tocar una obra, descarga el archivo de `raw.githubusercontent.com` fijado a un commit concreto (los archivos no cambian aunque la colección se actualice). Cada entrada lleva su nota de calidad ya calculada con `js/quality.js`.

| Colección | Obras | Licencia | Fuente |
|---|---|---|---|
| Concertistas (ASAP) | 1 067 | CC BY-NC-SA 4.0 | https://github.com/fosfrancesco/asap-dataset |
| Rollos históricos (SUPRA, Welte-Mignon) | 456 | CC BY-NC-SA 4.0 | https://github.com/pianoroll/SUPRA |
| Pop al piano (POP909) | 909 | MIT | https://github.com/music-x-lab/POP909-Dataset |

## Regenerarlo

```bash
# 1. Descargar los MIDIs y metadatos (lista de rutas con git ls-tree; descarga en paralelo desde raw.githubusercontent.com)
#    a /ruta/datos/{asap,supra,pop909} — ver tools/build-catalog.mjs para las rutas exactas
# 2. Índice de POP909 (Excel → JSON)
python3 tools/pop909-index.py POP909/index.xlsx /ruta/datos/pop909_index.json
# 3. Analizar y escribir catalog/index.json
node tools/build-catalog.mjs /ruta/datos
```

Formato: `collections` (nombre, licencia, URL base) e `items` como filas `[colección, ruta, título, autor, intérprete, segundos, nota, etiqueta, pianoSolo]` con etiqueta `0` interpretada, `1` expresiva, `2` mecánica.
