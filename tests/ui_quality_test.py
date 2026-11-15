# Prueba v1.2: calidad al vuelo en Explorar (BitMidi simulado con archivos reales), filtros y ficha.
import asyncio, json, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8081/'
FIX = 'tests/fixtures/'
OUT = '/tmp/shots3/'
FILES = {'101': 'nottingham-folk.mid', '102': 'asap-performance.mid', '103': 'asap-score.mid'}
RESULTS = [
    {"id": 101, "name": "folk_tune.mid", "plays": 50000, "url": "/a", "downloadUrl": "/uploads/101.mid"},
    {"id": 102, "name": "Glinka - The Lark (pianist).mid", "plays": 1200, "url": "/b", "downloadUrl": "/uploads/102.mid"},
    {"id": 103, "name": "Bach Italian Concerto.mid", "plays": 800, "url": "/c", "downloadUrl": "/uploads/103.mid"},
]
async def main():
    import os; os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='light')
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        cors = {'Access-Control-Allow-Origin': '*'}
        async def api(route):
            await route.fulfill(status=200, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps({"result": {"results": RESULTS, "total": 3, "pageTotal": 1}}))
        async def files(route):
            fid = route.request.url.rsplit('/', 1)[1].split('.')[0]
            await route.fulfill(status=200, headers={**cors, 'Content-Type': 'audio/midi'}, body=open(FIX + FILES[fid], 'rb').read())
        await page.route('https://bitmidi.com/api/midi/search**', api)
        await page.route('https://bitmidi.com/uploads/**', files)
        await page.goto(BASE + '?demo'); await page.wait_for_timeout(800)
        await page.click('[data-empty="demo"]'); await page.wait_for_timeout(500)
        await page.click('[data-filter="online"]'); await page.wait_for_timeout(300)
        await page.click('[data-src="bitmidi"]'); await page.wait_for_timeout(200)
        await page.fill('#search', 'test'); await page.press('#search', 'Enter')
        await page.wait_for_timeout(2500)
        rows = await page.locator('.row[data-key]').all_inner_texts()
        print('rows:', [r.replace('\n', ' | ') for r in rows])
        await page.screenshot(path=OUT + '1-explore-quality.png')
        await page.click('[data-act="operf"]'); await page.wait_for_timeout(300)
        print('solo interpretadas:', [r.split('\n')[0] for r in await page.locator('.row[data-key]').all_inner_texts()])
        await page.click('[data-act="operf"]'); await page.click('[data-act="osort"]'); await page.wait_for_timeout(300)
        print('orden calidad:', [r.split('\n')[0] for r in await page.locator('.row[data-key]').all_inner_texts()])
        await page.click('.row[data-key="bitmidi:102"] [data-act="osave"]'); await page.wait_for_timeout(600)
        await page.click('[data-filter="all"]'); await page.fill('#search', ''); await page.dispatch_event('#search', 'input'); await page.wait_for_timeout(1800)
        print('biblioteca:', [r.replace('\n', ' | ') for r in await page.locator('.row[data-id]').all_inner_texts()])
        await page.screenshot(path=OUT + '2-library-badges.png')
        await page.click('.row:has-text("Glinka") [data-act="more"]'); await page.wait_for_timeout(400)
        await page.click('[data-m="quality"]'); await page.wait_for_timeout(500)
        await page.screenshot(path=OUT + '3-quality-sheet.png')
        print('errors', errors)
        await b.close()
asyncio.run(main())
