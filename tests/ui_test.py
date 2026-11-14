import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8080/'
SCHEME = sys.argv[1] if len(sys.argv) > 1 else 'light'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme=SCHEME, locale='es-ES')
        page = await ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        await page.goto(BASE + '?demo')
        await page.wait_for_timeout(1200)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-1-empty.png')
        await page.click('[data-empty="demo"]')
        await page.wait_for_timeout(400)
        await page.set_input_files('#fileInput', ['tests/fixtures/multi.mid', 'tests/fixtures/running.mid'])
        await page.wait_for_timeout(800)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-2-list.png')
        # tocar la demo
        await page.click('.row:has-text("Himno") .row-main')
        await page.wait_for_timeout(3500)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-3-player.png')
        info = await page.evaluate('({pos: pianola.player.position, playing: pianola.player.playing, sent: pianola.ble.log.length, conn: pianola.ble.state})')
        print('player', info)
        await page.click('#speedChip')
        await page.wait_for_timeout(500)
        await page.click('[data-v="75"]')
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-4-speed.png')
        await page.go_back()   # botón atrás cierra la hoja
        await page.wait_for_timeout(500)
        sheet_open = await page.evaluate("document.querySelector('#sheet').classList.contains('open')")
        player_open = await page.evaluate("document.querySelector('#player').classList.contains('open')")
        print('after back: sheet', sheet_open, 'player', player_open)
        await page.click('#soundChip')
        await page.wait_for_timeout(600)
        await page.go_back()  # cierra reproductor
        await page.wait_for_timeout(600)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-5-list-playing.png')
        await page.click('#settingsBtn')
        await page.wait_for_timeout(600)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-6-settings.png', full_page=False)
        await page.go_back(); await page.wait_for_timeout(400)
        # menú de canción y borrar con deshacer
        await page.click('.row:has-text("multi") [data-act="more"]')
        await page.wait_for_timeout(400)
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-7-menu.png')
        await page.click('[data-m="delete"]')
        await page.wait_for_timeout(500)
        n1 = await page.locator('.row').count()
        await page.screenshot(path=f'/tmp/shots/{SCHEME}-8-undo.png')
        await page.click('#toastAction')
        await page.wait_for_timeout(300)
        n2 = await page.locator('.row').count()
        print('rows after delete/undo', n1, n2)
        # pausa: no deben quedar notas colgadas en el log simulado
        await page.click('#miniPlay')
        await page.wait_for_timeout(300)
        hang = await page.evaluate('''(() => { const on = new Map();
          for (const m of pianola.ble.log) { const t = m[0] & 0xf0, ch = m[0] & 15;
            if (t === 0x90 && m[2] > 0) on.set((ch<<7)|m[1], 1);
            if (t === 0x80) on.delete((ch<<7)|m[1]);
            if (t === 0xb0 && m[1] === 123) for (const k of [...on.keys()]) if ((k>>7) === ch) on.delete(k); }
          return on.size; })()''')
        print('hanging notes after pause', hang)
        # reload persists library
        await page.reload(); await page.wait_for_timeout(1000)
        print('rows after reload', await page.locator('.row').count())
        print('errors', json.dumps(errors, ensure_ascii=False, indent=1))
        await b.close()
asyncio.run(main())
