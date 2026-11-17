// 對沙盒中的 Worker 發動攻擊並回報哪些被擋下。先啟動 mock-upstream 與 wrangler dev（見 security/README.md）。
//   node security/attack.mjs
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const API = process.env.API ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8799';
const SITE = 'http://localhost:8765';
const exported = await readFile(new URL('../worker/test/fixtures/Dash_main.json', import.meta.url), 'utf8');
const loadout = JSON.parse(exported);

const results = [];
const record = (id, name, blocked, detail = '') => { results.push({ id, name, blocked, detail }); console.log(`${blocked ? '擋下' : '【漏洞】'} ${id} ${name}${detail ? ` — ${detail}` : ''}`); };
const control = body => fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify(body) });
const mockState = async () => (await fetch(`${MOCK}/__state`)).json();
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

let userCounter = 0;
/** 換一個全新的 Discord 帳號登入（每個帳號有自己的速率限制與配額）。 */
async function login(overrides = {}) {
  userCounter += 1;
  await fetch(`${MOCK}/__reset`, { method: 'POST' });
  await control({ user: { id: String(175928847299117063n + BigInt(userCounter) + BigInt(Date.now() % 100000) * 1000n), username: `tester${userCounter}`, global_name: 'T', avatar: 'a1b2c3', discriminator: '0', ...overrides.user }, member: overrides.member ?? true });
  const start = await fetch(`${API}/auth/login`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await fetch(`${API}/auth/callback?code=x&state=${overrides.state ?? state}`, { redirect: 'manual', headers: { Cookie: `dash_state=${state}` } });
  const hash = new URL(done.headers.get('location')).hash;
  return hash.startsWith('#session=') ? hash.slice(9) : hash;
}
const submit = (token, payload, headers = {}) => fetch(`${API}/api/submit`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: SITE, 'Content-Type': 'application/json', ...headers },
  body: typeof payload === 'string' ? payload : JSON.stringify({ character: '角色', ...payload }),
});
const good = (extra = {}) => ({ content: exported, ...extra });
const mutate = change => { const copy = structuredClone(loadout); change(copy); return JSON.stringify(copy); };

// ---- 身分驗證 ----
record('A1', '沒有權杖直接送出', (await submit('', good())).status === 401);
{
  const token = await login();
  const [, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, k: '0'.repeat(16) })}.`;
  record('A2', 'JWT alg=none 偽造', (await submit(none, good())).status === 401);
  const swapped = `${token.split('.')[0]}.${b64({ ...claims, k: '0'.repeat(16) })}.${token.split('.')[2]}`;
  record('A3', '竄改 JWT 內容（冒用別人的 owner key）沿用原簽章', (await submit(swapped, good())).status === 401);
  const head = b64({ alg: 'HS256', typ: 'JWT' }); const body = b64({ ...claims, exp: 9999999999 });
  const guessed = `${head}.${body}.${createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url')}`;
  record('A4', '用猜測的密鑰自簽 JWT', (await submit(guessed, good())).status === 401);
  const expired = `${head}.${b64({ ...claims, exp: 1 })}.${token.split('.')[2]}`;
  record('A5', '過期權杖', (await submit(expired, good())).status === 401);
}
record('A6', 'OAuth state 不符（登入 CSRF）', (await login({ state: '0'.repeat(32) })) === '#login-error=state');
record('A7', '非伺服器成員登入', (await login({ member: false })) === '#login-error=not-member');
record('A8', '剛註冊的 Discord 帳號登入', (await login({ user: { id: String(BigInt(Date.now() - 1420070400000 - 3600000) << 22n) } })) === '#login-error=account-age');

// ---- 來源與 CORS ----
{
  const token = await login();
  record('A9', '從惡意網站發出請求（Origin 不符）', (await submit(token, good(), { Origin: 'https://evil.example' })).status === 403);
  const pre = await fetch(`${API}/api/submit`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  record('A10', 'CORS 不對惡意來源開放', pre.headers.get('access-control-allow-origin') !== 'https://evil.example' && pre.headers.get('access-control-allow-origin') !== '*');
}

// ---- 檔名與路徑 ----
{
  const token = await login();
  // 檔名不限之後，玩家給的檔名與角色名稱都不能影響 repo 內的路徑：路徑只會是 Dash_c<雜湊>.json。
  const response = await submit(token, good({ fileName: '../../.github/workflows/x.yml', character: '../../.github/workflows/x', label: '..\\..\\site/app.js' }));
  const paths = Object.values((await mockState()).files).flatMap(tree => Object.keys(tree));
  record('B1', '用檔名／角色名稱／備註夾帶路徑', response.status === 201 && paths.length === 1 && /^data\/loadouts\/[0-9a-f]{16}\/Dash_c[0-9a-f]{15}\.json$/.test(paths[0]), paths.join(','));
  record('B2', '沒填角色名稱', (await submit(token, { content: exported, character: '   ' })).status === 400);
}

// ---- 惡意內容 ----
{
  const token = await login();
  const cases = {
    '頂層 __proto__': exported.replace('{', '{"__proto__":{"polluted":1},'),
    '未知頂層欄位': mutate(copy => { copy.evil = { deep: 1 }; }),
    'values 內 constructor': mutate(copy => { copy.values.constructor = 'x'; }),
    'values 內 <script>': mutate(copy => { copy.values[Object.keys(copy.values)[0]] = '<script>alert(1)</script>'; }),
    'values 內巢狀物件': mutate(copy => { copy.values[Object.keys(copy.values)[0]] = { a: { b: 1 } }; }),
    '1e999 溢位': exported.replace(/"values":\{"(\d+)":[^,]+,/, '"values":{"$1":1e999,'),
    '超過 600 個欄位': mutate(copy => { for (let i = 1; i < 800; i += 1) copy.values[String(2000 + i)] = 1; }),
    '改 formatVersion': mutate(copy => { copy.formatVersion = 99; }),
    '不是 JSON': '}{',
    '深度巢狀炸彈': `${'['.repeat(20000)}${']'.repeat(20000)}`,
    '34KB 檔案': mutate(copy => { copy.values['1'] = 'x'.repeat(64); }) + ' '.repeat(34 * 1024),
  };
  for (const [name, content] of Object.entries(cases)) {
    const response = await submit(token, { content });
    record('C', `惡意內容：${name}`, response.status === 422 || response.status === 413, String(response.status));
  }
  const started = Date.now();
  const big = await submit(token, JSON.stringify({ character: 'x', content: 'x'.repeat(8 * 1024 * 1024) }));
  record('C12', '8 MB 請求', big.status === 413, `${big.status}，${Date.now() - started} ms`);
  const polluted = await (await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  record('C13', '原型污染沒有殘留在 Worker', polluted.polluted === undefined && ({}).polluted === undefined);
}

// ---- 公開欄位注入 ----
{
  const token = await login({ user: { username: 'evil<img src=x onerror=1>‮gnp', avatar: 'x.png?size=128#"><script>' } });
  const response = await submit(token, good({ character: '<img src=x onerror=alert(1)>‮@everyone', label: '[點我](javascript:alert(1)) ​hidden' }));
  const state = await mockState();
  const stored = Object.values(Object.values(state.files)[0] ?? {})[0] ?? '';
  const entry = stored ? JSON.parse(stored) : {};
  record('D1', '角色名／備註夾帶 HTML 標籤', response.status === 201 && !/[<>]/.test(`${entry.character}${entry.label}${entry.owner?.name}`), JSON.stringify([entry.character, entry.label, entry.owner?.name]));
  record('D2', '雙向控制字元／零寬字元偽裝名稱', !/[​-‏‪-‮⁠-⁩﻿]/.test(`${entry.character}${entry.label}${entry.owner?.name}`));
  record('D3', '偽造頭像網址', entry.owner?.avatar === '', JSON.stringify(entry.owner?.avatar));
  record('D4', 'PR 標題不含玩家自填文字（避免 @mention／連結）', !state.pulls.some(pull => /@everyone|img|onerror/.test(pull.title)), state.pulls[0]?.title);
}

// ---- 速率限制與配額 ----
{
  const token = await login();
  const burst = await Promise.all(Array.from({ length: 30 }, () => submit(token, good()).then(response => response.status)));
  const accepted = burst.filter(status => status === 201).length;
  record('E1', '同一帳號 30 個並發請求（60 秒只該過 1 個）', accepted <= 1, `通過 ${accepted} 個；狀態 ${[...new Set(burst)].join(',')}`);
}
{
  const token = await login();
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(token, good({ character: `角色${i}` })).then(response => response.status)));
  const state = await mockState();
  record('E2', '並發用 30 個不同角色名稱衝破每人 5 份配額', state.branches.length <= 5 && state.pulls.length <= 5, `建立了 ${state.branches.length} 個分支、${state.pulls.length} 個 PR`);
}
{
  const token = await login();
  const first = (await submit(token, good())).status;
  const second = (await submit(token, good())).status;
  record('E3', '循序連送兩次（冷卻）', first === 201 && second === 429, `${first},${second}`);
  const other = await fetch(`${API}/api/entries/${encodeURIComponent('../../x')}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Origin: SITE } });
  record('E4', '刪除請求夾帶路徑', other.status === 400 || other.status === 404, String(other.status));
}
{
  const start = await fetch(`${API}/auth/login?return=https://evil.example/`, { redirect: 'manual' });
  const cookies = start.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await fetch(`${API}/auth/callback?code=x&state=${state}`, { redirect: 'manual', headers: { Cookie: cookies } });
  record('E6', '登入後導向任意網址（開放式重新導向）', done.headers.get('location').startsWith(`${SITE}/#`), done.headers.get('location').slice(0, 40));
}
{
  const statuses = [];
  for (let i = 0; i < 40; i += 1) statuses.push((await fetch(`${API}/auth/login`, { redirect: 'manual' })).status);
  record('E5', '同一 IP 連續 40 次登入（每小時上限 30）', statuses.includes(429), `429 出現在第 ${statuses.indexOf(429) + 1} 次`);
}

const holes = results.filter(result => !result.blocked);
console.log(`\n${results.length} 項攻擊：擋下 ${results.length - holes.length}，打穿 ${holes.length}`);
process.exitCode = holes.length ? 1 : 0;
