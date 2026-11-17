// 用假的 Discord／GitHub 回應把 Worker 的主要流程跑一遍：node --test worker/test
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { Limiter } from '../src/index.js';
import { LIMITS, validateEntry } from '../../site/lib/dash-format.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// 假的 Durable Object 命名空間：每個 key 一個 Limiter，儲存放在記憶體。
const kv = new Map();
function limiterStub(name) {
  if (!kv.has(name)) {
    const store = new Map();
    kv.set(name, new Limiter({ storage: { get: async key => store.get(key), put: async (key, value) => { store.set(key, value); }, setAlarm: async () => {}, deleteAll: async () => store.clear() } }));
  }
  return { fetch: (url, init) => kv.get(name).fetch(new Request(url, init)) };
}
const env = {
  SITE_URL: 'https://example.github.io/loadout-dashboard/', GITHUB_REPO: 'example/loadout-dashboard',
  GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_GUILD_ID: 'guild', MIN_ACCOUNT_AGE_DAYS: '30',
  SESSION_SECRET: 'session-secret', OWNER_KEY_SECRET: 'owner-secret',
  LIMITER: { idFromName: name => name, get: limiterStub },
};

// 假的 GitHub repo：主分支上的檔案、分支、PR。
const repo = { files: new Map(), branches: new Map(), pulls: [], comments: {}, member: true, userId: '175928847299117063' };
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? 'GET';
  const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  if (url.host === 'discord.com') {
    if (url.pathname.endsWith('/oauth2/token')) return reply(200, { access_token: 'discord-token' });
    if (url.pathname.endsWith('/oauth2/token/revoke')) return reply(200, {});
    if (url.pathname.endsWith('/users/@me')) return reply(200, { id: repo.userId, username: 'tester', global_name: '測試玩家', avatar: 'a1b2c3', discriminator: '0' });
    if (url.pathname.endsWith('/member')) return repo.member ? reply(200, { roles: [] }) : reply(404, {});
  }
  const path = url.pathname.replace('/repos/example/loadout-dashboard', '');
  if (url.pathname.endsWith('/access_tokens')) return reply(201, { token: 'ghs', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  if (path === '/git/ref/heads/main') return reply(200, { object: { sha: 'a'.repeat(40) } });
  if (path === '/git/refs' && method === 'POST') {
    const name = body.ref.replace('refs/heads/', '');
    if (repo.branches.has(name)) return reply(422, {});
    repo.branches.set(name, new Map(repo.files)); return reply(201, {});
  }
  if (path === '/pulls' && method === 'GET') return reply(200, repo.pulls.filter(pull => url.searchParams.get('state') === 'all' || pull.state === 'open'));
  const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
  if (comments) return reply(200, repo.comments[comments[1]] ?? []);
  if (path === '/pulls' && method === 'POST') {
    const pull = { number: repo.pulls.length + 1, state: 'open', merged_at: null, html_url: `https://github.com/example/loadout-dashboard/pull/${repo.pulls.length + 1}`, head: { ref: body.head, sha: `${String(repo.pulls.length + 1).padStart(40, 'e')}`, repo: { full_name: env.GITHUB_REPO } } };
    repo.pulls.push(pull); return reply(201, pull);
  }
  if (path.startsWith('/contents/')) {
    const file = decodeURIComponent(path.slice('/contents/'.length));
    const ref = url.searchParams.get('ref');
    const tree = method === 'GET' ? (ref === 'main' ? repo.files : (repo.branches.get(ref) ?? repo.branches.get(repo.pulls.find(pull => pull.head.sha === ref)?.head.ref))) : repo.branches.get(body.branch);
    if (method === 'GET') {
      if (tree?.has(file)) return reply(200, { sha: 'f'.repeat(40), content: Buffer.from(tree.get(file)).toString('base64') });
      const children = [...(tree?.keys() ?? [])].filter(name => name.startsWith(`${file}/`)).map(name => ({ name: name.slice(file.length + 1) }));
      return children.length ? reply(200, children) : reply(404, {});
    }
    if (method === 'PUT') { tree.set(file, Buffer.from(body.content, 'base64').toString('utf8')); return reply(201, {}); }
    if (method === 'DELETE') { tree.delete(file); return reply(200, {}); }
  }
  throw new Error(`未預期的請求：${method} ${url}`);
};

const call = (path, init = {}) => worker.fetch(new Request(`https://api.example.workers.dev${path}`, init), env);
const exported = await readFile(new URL('./fixtures/Dash_main.json', import.meta.url), 'utf8');

async function loginSession() {
  const start = await call('/auth/login');
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const done = await call(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: `dash_state=${state}` } });
  return new URL(done.headers.get('Location')).hash;
}
const submit = (token, payload, origin = 'https://example.github.io') => call('/api/submit', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

test('登入、送出、配額與限制', async () => {
  repo.member = false;
  assert.equal(await loginSession(), '#login-error=not-member');
  repo.member = true;
  const forged = await call('/auth/callback?code=abc&state=' + '0'.repeat(32), { headers: { Cookie: 'dash_state=' + '1'.repeat(32) } });
  assert.match(forged.headers.get('Location'), /login-error=state$/);

  const hash = await loginSession();
  assert.match(hash, /^#session=/);
  const token = hash.slice('#session='.length);

  assert.equal((await submit('bad.token.here', { content: exported, character: '角色一號' })).status, 401);
  assert.equal((await submit(token, { content: exported, character: '角色一號' }, 'https://evil.example')).status, 403);
  assert.equal((await submit(token, { content: exported })).status, 400);                       // 沒填角色名稱
  assert.equal((await submit(token, { content: '{"format":"nope"}', character: '角色一號' })).status, 422);

  // 檔名不限：就算帶了奇怪的 fileName 也不會被採用，存檔名稱一律由角色名稱＋備註產生。
  const created = await submit(token, { fileName: '../../evil.yml', content: exported, label: '主力', character: '角色<b>一號' });
  assert.equal(created.status, 201);
  const { status, slot } = await created.json();
  assert.equal(status, 'created');
  assert.match(slot, /^c[0-9a-f]{15}$/);
  const [[branch, tree]] = repo.branches;
  const [[path, content]] = tree;
  assert.match(branch, new RegExp(`^dash/[0-9a-f]{16}/${slot}$`));
  assert.match(path, new RegExp(`^data/loadouts/[0-9a-f]{16}/Dash_${slot}\\.json$`));
  const entry = JSON.parse(content);
  assert.deepEqual(validateEntry(entry, path), []);
  assert.equal(entry.owner.name, 'tester');               // 公開的是 Discord 使用者名稱
  assert.equal(entry.owner.avatar, `https://cdn.discordapp.com/avatars/${repo.userId}/a1b2c3.png?size=128`);
  assert.equal(entry.character, '角色b一號');             // 角括號被清掉

  assert.equal((await submit(token, { content: exported, character: '角色b一號', label: '主力' })).status, 429); // 60 秒冷卻
  kv.clear();
  const updated = await submit(token, { content: exported, character: '角色B一號', label: '主力' });   // 大小寫不同仍是同一份
  assert.equal((await updated.json()).status, 'updated');
  assert.equal(repo.pulls.length, 1);                      // 同一個角色＋備註沿用同一個 PR

  for (let i = 1; i < LIMITS.maxSlotsPerOwner; i += 1) { kv.clear(); assert.equal((await submit(token, { content: exported, character: `角色${i}` })).status, 201); }
  kv.clear();
  assert.equal((await submit(token, { content: exported, character: '多出來的角色' })).status, 409); // 超過每人上限
  assert.equal(repo.branches.size, LIMITS.maxSlotsPerOwner);                     // 被拒絕的不會留下分支

  const me = await (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(me.entries.length, LIMITS.maxSlotsPerOwner);
  assert.ok(me.entries.every(item => item.status === 'pending' && !item.live && item.character));

  // 一筆被退回（只採信機器人的留言）、一筆已合併上榜。
  const [rejected, merged] = repo.pulls;
  rejected.state = 'closed';
  repo.comments[rejected.number] = [
    { user: { login: 'github-actions[bot]' }, body: '<!-- dash-result -->\n請填完整上衣的強化與鍛造等級。' },
    { user: { login: 'someone-else' }, body: '<!-- dash-result -->\n假的原因 <b>x</b>' },
  ];
  merged.state = 'closed'; merged.merged_at = '2026-11-17T00:00:00Z';
  const mergedSlot = merged.head.ref.split('/').at(-1);
  for (const [file, text] of repo.branches.get(merged.head.ref)) repo.files.set(file, text);
  const after = await (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
  const bySlot = Object.fromEntries(after.entries.map(item => [item.slot, item]));
  assert.deepEqual(bySlot[slot], { slot, character: '角色B一號', label: '主力', live: false, status: 'rejected', reason: '請填完整上衣的強化與鍛造等級。' });
  assert.deepEqual(bySlot[mergedSlot], { slot: mergedSlot, character: '角色1', label: '', live: true, status: 'live', reason: '' });
});

test('登入後回到上傳頁，且不接受任意導向', async () => {
  for (const [query, expected] of [['?return=upload', 'https://example.github.io/loadout-dashboard/upload.html#session='], ['?return=https://evil.example', 'https://example.github.io/loadout-dashboard/#session='], ['', 'https://example.github.io/loadout-dashboard/#session=']]) {
    kv.clear();
    const start = await call(`/auth/login${query}`);
    const cookies = start.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const done = await call(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookies } });
    assert.ok(done.headers.get('Location').startsWith(expected), `${query} → ${done.headers.get('Location').slice(0, 70)}`);
  }
});

test('帳號太新不能登入', async () => {
  repo.userId = String((BigInt(Date.now() - 1420070400000 - 86400000) << 22n));
  assert.equal(await loginSession(), '#login-error=account-age');
});
