# 把 index.json 的每個字串都換成 XSS 載荷，確認頁面只把它們當文字顯示。
#   python3 security/frontend-xss.py   （需要 playwright 與 Chrome）
import asyncio, json, pathlib, shutil, tempfile, functools, http.server, threading
from playwright.async_api import async_playwright

root = pathlib.Path(__file__).resolve().parent.parent
PAYLOADS = ['<img src=x onerror="window.__pwned=1">', '"><script>window.__pwned=1</script>', "';window.__pwned=1;//", '<svg onload=window.__pwned=1>', '{{constructor.constructor("window.__pwned=1")()}}']

def poison(value, counter=[0]):
    if isinstance(value, str):
        counter[0] += 1
        return PAYLOADS[counter[0] % len(PAYLOADS)]
    if isinstance(value, list): return [poison(v) for v in value]
    if isinstance(value, dict): return {k: poison(v) for k, v in value.items()}
    return value

async def main():
    site = pathlib.Path(tempfile.mkdtemp()) / 'site'
    shutil.copytree(root / 'site', site)
    index = json.loads((site / 'data/index.json').read_text('utf8'))
    for entry in index['entries']:
        keep = {'id': entry['id'], 'submittedAt': entry['submittedAt'], 'job': entry['job']}
        entry.update(poison({k: v for k, v in entry.items() if k not in keep}))
        entry['avatar'] = 'javascript:window.__pwned=1'
        entry['stats'] = {k: 1 for k in entry['stats']} if isinstance(entry['stats'], dict) else {}
        entry['damage'] = 1
    index['entries'][0]['avatar'] = 'x" onerror="window.__pwned=1'
    index['classes'] = [{'id': c['id'], 'name': PAYLOADS[0], 'attackType': None} for c in index['classes']]
    index['attributes'] = [{'key': a['key'], 'name': PAYLOADS[1], 'unit': PAYLOADS[3]} for a in index['attributes']]
    (site / 'data/index.json').write_text(json.dumps(index), 'utf8')
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
        dialogs = []
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.dismiss())))
        await page.goto(f'http://127.0.0.1:{server.server_port}/#session=x.eyJuIjoiPGltZyBzcmM9eCBvbmVycm9yPXdpbmRvdy5fX3B3bmVkPTE-IiwiZXhwIjo5OTk5OTk5OTk5fQ.x')
        await page.wait_for_selector('.entry')
        for mode in ['discord', 'character', 'class', 'damage']:
            await page.select_option('#sort', mode)
            for row in await page.locator('.entry > button').all(): await row.click()
        await page.wait_for_timeout(500)
        pwned = await page.evaluate('window.__pwned')
        injected = await page.evaluate("document.querySelectorAll('main script, main svg, main [onerror], main [onload], main img[src^=\"javascript\"], .account img, .account script').length")
        shown = await page.locator('.entry .name').first.inner_text()
        print('腳本執行:', pwned, '| 被注入的元素:', injected, '| 對話框:', dialogs, '| 畫面上顯示為文字:', shown[:40])
        await browser.close()
    server.shutdown()
    raise SystemExit(1 if pwned or injected or dialogs else 0)
asyncio.run(main())
