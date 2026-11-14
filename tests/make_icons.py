import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
BG = (18, 17, 16, 255); IVORY = (237, 231, 219, 255); FELT = (178, 46, 46, 255)

def motif(d, cx, cy, scale):
    # 3 teclas blancas + 2 negras (en negativo) + franja de fieltro
    kw, gap, kh = 150 * scale, 14 * scale, 400 * scale
    total = 3 * kw + 2 * gap
    x0 = cx - total / 2
    top = cy - kh / 2 + 20 * scale
    d.rounded_rectangle([x0 - 4 * scale, top - 46 * scale, x0 + total + 4 * scale, top - 22 * scale], radius=10 * scale, fill=FELT)
    for i in range(3):
        x = x0 + i * (kw + gap)
        d.rounded_rectangle([x, top, x + kw, top + kh], radius=26 * scale, fill=IVORY)
        d.rectangle([x, top, x + kw, top + 40 * scale], fill=IVORY)
    bw, bh = 92 * scale, 238 * scale
    for i in range(1, 3):
        bx = x0 + i * (kw + gap) - gap / 2 - bw / 2
        d.rounded_rectangle([bx, top - 2 * scale, bx + bw, top + bh], radius=16 * scale, fill=BG)
        d.rectangle([bx, top - 2 * scale, bx + bw, top + 30 * scale], fill=BG)

S = 1024
# "any": cuadrado redondeado
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=BG)
motif(d, S / 2, S / 2, 1.0)
for size in (192, 512):
    img.resize((size, size), Image.LANCZOS).save(f'{out}/icon-{size}.png')
# "maskable": a sangre, motivo dentro de la zona segura (80 %)
m = Image.new('RGBA', (S, S), BG)
motif(ImageDraw.Draw(m), S / 2, S / 2, 0.78)
m.resize((512, 512), Image.LANCZOS).save(f'{out}/maskable-512.png')
img.resize((180, 180), Image.LANCZOS).save(f'{out}/apple-touch-icon.png')
print('ok')
