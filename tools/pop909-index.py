# Convierte POP909/index.xlsx en JSON (id → nombre, artista). Uso: python3 tools/pop909-index.py index.xlsx salida.json
import json, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1], read_only=True).active
rows = list(ws.iter_rows(values_only=True))[1:]
json.dump({str(r[0]).zfill(3): {'name': r[1], 'artist': r[2]} for r in rows if r[0]}, open(sys.argv[2], 'w'), ensure_ascii=False)
print(len(rows))
