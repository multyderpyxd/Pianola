import asyncio, json
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8080/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='dark')
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(BASE)
        await page.wait_for_function('navigator.serviceWorker.controller !== null || new Promise(r => navigator.serviceWorker.ready.then(() => r(true)))', timeout=10000)
        await page.reload(); await page.wait_for_timeout(800)
        ctrl = await page.evaluate('!!navigator.serviceWorker.controller')
        print('sw controls page:', ctrl, '| bluetooth API:', await page.evaluate('!!navigator.bluetooth'), '| conn label:', await page.inner_text('#connBtn'))
        # Simular "Compartir" desde otra app: POST multipart a ./share
        midi = list(open('tests/fixtures/multi.mid', 'rb').read())
        status = await page.evaluate('''async (bytes) => {
            const fd = new FormData();
            fd.append('midi', new File([new Uint8Array(bytes)], 'Compartida_desde_WhatsApp.mid', {type: 'audio/midi'}));
            const r = await fetch('./share', {method: 'POST', body: fd});
            return [r.status, r.url];
        }''', midi)
        print('share POST ->', status)
        await page.goto(BASE + '?shared=1'); await page.wait_for_timeout(1200)
        titles = await page.locator('.row-title').all_inner_texts()
        print('rows after share:', titles, '| url:', page.url)
        # Sin conexión: la app debe abrir desde la caché
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_timeout(1000)
        print('offline reload ok:', await page.locator('.brand').inner_text(), '| rows:', await page.locator('.row').count())
        await ctx.set_offline(False)
        # Manifest
        man = await page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        print('manifest share_target action:', man['share_target']['action'])
        await page.screenshot(path='/tmp/shots/dark-9-shared.png')
        print('errors', errors)
        await b.close()
asyncio.run(main())
