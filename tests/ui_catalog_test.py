# Prueba v1.3: catálogo (índice local + descargas de GitHub simuladas).
import asyncio, json, sys, os
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8081/'
OUT = '/tmp/shots4/'
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='light')
        page = await ctx.new_page()
        errors, gh = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        async def raw(route):
            gh.append(route.request.url)
            await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, body=open('tests/fixtures/asap-performance.mid', 'rb').read())
        await page.route('https://raw.githubusercontent.com/**', raw)
        await page.goto(BASE + '?demo'); await page.wait_for_timeout(800)
        await page.click('[data-filter="online"]'); await page.wait_for_timeout(1200)
        await page.screenshot(path=OUT + '1-catalog-home.png')
        print('colecciones:', [t.split('\n')[0] for t in await page.locator('.col-card').all_inner_texts()])
        await page.click('[data-col="supra"]'); await page.wait_for_timeout(500)
        await page.screenshot(path=OUT + '2-supra.png')
        print('supra:', await page.locator('.list-note').first.inner_text())
        await page.click('[data-act="cathome"]'); await page.wait_for_timeout(300)
        await page.fill('#search', 'chopin balada'); await page.dispatch_event('#search', 'input'); await page.wait_for_timeout(400)
        first = await page.locator('.row[data-key]').first.inner_text()
        print('busqueda:', first.replace('\n', ' | '), '| total:', await page.locator('.list-note').first.inner_text())
        await page.locator('.row[data-key] .row-main').first.click(); await page.wait_for_timeout(2500)
        print('suena:', await page.evaluate("({playing: pianola.player.playing, title: document.querySelector('#nowTitle').textContent, meta: document.querySelector('#nowMeta').textContent})"))
        print('descarga:', gh[0][:110] if gh else None)
        await page.screenshot(path=OUT + '3-player.png')
        await page.click('#saveChip'); await page.wait_for_timeout(600)
        await page.go_back(); await page.wait_for_timeout(400)
        await page.click('[data-filter="all"]'); await page.fill('#search', ''); await page.dispatch_event('#search', 'input'); await page.wait_for_timeout(1500)
        print('biblioteca:', [r.replace('\n', ' | ') for r in await page.locator('.row[data-id]').all_inner_texts()])
        await page.click('[data-filter="online"]'); await page.click('[data-src="bitmidi"]'); await page.wait_for_timeout(400)
        await page.screenshot(path=OUT + '4-bitmidi-switch.png')
        print('errors', errors)
        await b.close()
asyncio.run(main())
