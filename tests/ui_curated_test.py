# Prueba v1.4: colecciones temáticas y «Reproducir» en el catálogo.
import asyncio, sys, os
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8081/'
async def main():
    os.makedirs('/tmp/shots5', exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        async def raw(route):
            await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, body=open('tests/fixtures/asap-performance.mid', 'rb').read())
        await page.route('https://raw.githubusercontent.com/**', raw)
        await page.goto(BASE + '?demo'); await page.wait_for_timeout(700)
        await page.click('[data-filter="online"]'); await page.wait_for_timeout(1000)
        print('colecciones:', [t.replace('\n', ' | ') for t in await page.locator('.col-card.col-sm').all_inner_texts()])
        await page.locator('.col-card.col-sm').first.scroll_into_view_if_needed()
        await page.screenshot(path='/tmp/shots5/1-home.png')
        await page.click('[data-cur="sleep"]'); await page.wait_for_timeout(400)
        print('para dormir:', await page.locator('.list-note').first.inner_text(), '|', [t.split('\n')[0] for t in (await page.locator('.row[data-key]').all_inner_texts())[:8]])
        await page.screenshot(path='/tmp/shots5/2-sleep.png')
        await page.click('[data-act="catplay"]'); await page.wait_for_timeout(2500)
        if not await page.evaluate("document.querySelector('#player').classList.contains('open')"):
            await page.click('#miniOpen'); await page.wait_for_timeout(500)
        await page.screenshot(path='/tmp/shots5/3-player.png')
        print('suena:', await page.evaluate("({playing: pianola.player.playing, meta: document.querySelector('#nowMeta').textContent})"))
        await page.go_back(); await page.wait_for_timeout(300)
        await page.click('[data-act="cathome"]'); await page.wait_for_timeout(300)
        await page.click('[data-cur="legends"]'); await page.wait_for_timeout(300)
        print('leyendas:', await page.locator('.list-note').first.inner_text())
        print('errors', errors)
        await b.close()
asyncio.run(main())
