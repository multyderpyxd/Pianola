# Prueba de la v1.1 en Chrome móvil: Explorar (BitMidi simulado), listas, temporizador y volumen.
import asyncio, json, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8081/'
FIX = 'tests/fixtures/'
OUT = '/tmp/shots2/'

RESULTS = [
    {"id": 101, "name": "Chopin - Nocturne Op 9 No 2.mid", "slug": "chopin-nocturne-op-9-no-2-mid", "plays": 15400, "url": "/chopin-nocturne-op-9-no-2-mid", "downloadUrl": "/uploads/101.mid"},
    {"id": 102, "name": "chopin_waltz_64_2.mid", "slug": "chopin-waltz-64-2-mid", "plays": 820, "url": "/chopin-waltz-64-2-mid", "downloadUrl": "/uploads/102.mid"},
    {"id": 103, "name": "Chopin Fantaisie Impromptu.mid", "slug": "chopin-fantaisie-impromptu-mid", "plays": 3, "url": "/chopin-fantaisie-impromptu-mid", "downloadUrl": "/uploads/103.mid"},
]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='light')
        page = await ctx.new_page()
        errors, calls = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        cors = {'Access-Control-Allow-Origin': '*'}
        async def api(route):
            calls.append(route.request.url)
            await route.fulfill(status=200, headers={**cors, 'Content-Type': 'application/json'},
                body=json.dumps({"result": {"query": {}, "results": RESULTS, "total": 3, "pageTotal": 1}}))
        async def files(route):
            calls.append(route.request.url)
            await route.fulfill(status=200, headers={**cors, 'Content-Type': 'audio/midi'}, body=open(FIX + 'multi.mid', 'rb').read())
        await page.route('https://bitmidi.com/api/midi/search**', api)
        await page.route('https://bitmidi.com/uploads/**', files)

        await page.goto(BASE + '?demo'); await page.wait_for_timeout(900)
        await page.screenshot(path=OUT + '1-welcome.png')
        await page.click('[data-empty="demo"]'); await page.wait_for_timeout(300)
        await page.set_input_files('#fileInput', [FIX + 'running.mid']); await page.wait_for_timeout(500)

        # Explorar
        await page.click('[data-filter="online"]'); await page.wait_for_timeout(300)
        await page.screenshot(path=OUT + '2-explore.png')
        await page.click('[data-q="Chopin"]'); await page.wait_for_timeout(700)
        await page.screenshot(path=OUT + '3-results.png')
        print('search calls:', [c.split('bitmidi.com')[1] for c in calls])
        await page.click('.row[data-key="bitmidi:101"] .row-main'); await page.wait_for_timeout(2500)
        st = await page.evaluate("({playing: pianola.player.playing, saveChip: !document.querySelector('#saveChip').hidden, meta: document.querySelector('#nowMeta').textContent})")
        print('online play:', st)
        await page.screenshot(path=OUT + '4-player-online.png')
        await page.click('#saveChip'); await page.wait_for_timeout(600)
        st = await page.evaluate("({saveChip: !document.querySelector('#saveChip').hidden, meta: document.querySelector('#nowMeta').textContent})")
        print('after save:', st)
        # volumen
        await page.evaluate("""() => { const v = document.querySelector('#volume'); v.value = 80; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); }""")
        await page.wait_for_timeout(200)
        sx = await page.evaluate("pianola.ble.log.filter(m => m[0] === 0xf0).map(m => m.map(x => x.toString(16)).join(' '))")
        print('volume sysex:', sx[-1:] )
        await page.go_back(); await page.wait_for_timeout(500)
        await page.screenshot(path=OUT + '5-results-saved.png')

        # Listas
        await page.click('[data-filter="lists"]'); await page.wait_for_timeout(300)
        await page.screenshot(path=OUT + '6-lists-empty.png')
        await page.click('[data-empty="lnew"]'); await page.wait_for_timeout(500)
        await page.fill('#plName', 'Para dormir')
        await page.click('#plForm [type="submit"]'); await page.wait_for_timeout(700)
        await page.screenshot(path=OUT + '7-picker.png')
        boxes = page.locator('.pick input:not([disabled])')
        n = await boxes.count()
        for i in range(n):
            await boxes.nth(i).check()
        await page.click('[data-a="done"]'); await page.wait_for_timeout(600)
        await page.screenshot(path=OUT + '8-playlist.png')
        await page.click('.pl-head [data-act="lplay"]'); await page.wait_for_timeout(1200)
        await page.click('#miniOpen'); await page.wait_for_timeout(600)
        print('playlist meta:', await page.inner_text('#nowMeta'), '| queue', await page.evaluate('pianola.player.playing'))
        # temporizador: al terminar esta
        await page.click('#sleepChip'); await page.wait_for_timeout(400)
        await page.screenshot(path=OUT + '9-sleep.png')
        await page.click('[data-s="end"]'); await page.wait_for_timeout(300)
        print('sleep chip:', await page.inner_text('#sleepChip'))
        await page.evaluate("pianola.player.seek(pianola.player.duration - 300)")
        await page.wait_for_timeout(2500)
        print('after end:', await page.evaluate("({playing: pianola.player.playing, title: document.querySelector('#nowTitle').textContent})"), '| chip:', await page.inner_text('#sleepChip'))
        await page.screenshot(path=OUT + '10-after-sleep.png')
        await page.go_back(); await page.wait_for_timeout(400)
        # menú de canción → añadir a lista
        await page.click('[data-filter="all"]'); await page.wait_for_timeout(300)
        await page.click('.row >> nth=0 >> [data-act="more"]'); await page.wait_for_timeout(400)
        await page.click('[data-m="list"]'); await page.wait_for_timeout(400)
        await page.screenshot(path=OUT + '11-add-to-list.png')
        await page.go_back(); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(900)
        await page.click('[data-filter="lists"]'); await page.wait_for_timeout(300)
        print('lists after reload:', await page.locator('.row[data-pl]').all_inner_texts())
        await page.screenshot(path=OUT + '12-lists.png')
        print('errors', errors)
        await b.close()
asyncio.run(main())
