// Cloudflare Worker：Discord 登入 → 驗證 Dash_ 檔 → 以 GitHub App 身分開 PR。
// 靜態站拿不到任何密鑰；Discord secret、GitHub App 私鑰、簽章金鑰都只存在這裡。
import { LIMITS, cleanText, createEntry, parseUpload, slotFromFileName } from '../../site/lib/dash-format.js';

// 上游 API 位址。只有在本機沙盒測試（security/）時才用環境變數改指到假伺服器，正式環境不要設定。
const discordApi = env => env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const githubApi = env => env.GITHUB_API_BASE || 'https://api.github.com';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const DISCORD_EPOCH_MS = 1420070400000;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// ---------- 小工具 ----------

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = text => b64url(encoder.encode(text));
const fromB64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

function base64Utf8(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

function siteOrigin(env) { return new URL(env.SITE_URL).origin; }

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': siteOrigin(env),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(env) },
  });
}

/** 導回網站。page 只會是空字串或固定的 'upload.html'，不接受外部傳入的網址，避免被當成跳板。 */
function redirectToSite(env, fragment, page = '') {
  return new Response(null, { status: 302, headers: { Location: `${env.SITE_URL}${page}#${fragment}`, 'Cache-Control': 'no-store' } });
}

// ---------- 工作階段（HS256 JWT，放在前端的 sessionStorage，以 Authorization 標頭送回） ----------

async function signSession(env, payload) {
  const body = `${b64urlText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify(payload))}`;
  return `${body}.${b64url(await hmac(env.SESSION_SECRET, body))}`;
}

async function readSession(env, request) {
  const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, '請先用 Discord 登入。');
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new HttpError(401, '登入資訊無效，請重新登入。');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid = false;
  try { valid = await crypto.subtle.verify('HMAC', key, fromB64url(signature), encoder.encode(`${header}.${payload}`)); } catch { /* 視為無效 */ }
  if (!valid) throw new HttpError(401, '登入資訊無效，請重新登入。');
  const session = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  if (!(session.exp > Date.now() / 1000)) throw new HttpError(401, '登入已過期，請重新登入。');
  // 停權名單：BLOCKED_OWNER_KEYS 是逗號分隔的 owner key，設定後立即生效，不必等權杖過期。
  if (String(env.BLOCKED_OWNER_KEYS ?? '').split(',').map(key => key.trim()).includes(session.k)) throw new HttpError(403, '這個帳號已被停止上傳。');
  return session;
}

// ---------- 速率限制（Durable Object：每個 key 一個物件，計數是原子操作） ----------
// 之前用 KV「先讀再寫」，並發請求會同時讀到舊值而一起通過；Durable Object 會把同一個 key 的請求排隊處理。

export class Limiter {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const { limit, ttlSeconds } = await request.json();
    const now = Date.now();
    // 從讀取到寫入之間沒有其他 I/O，執行環境保證不會有別的請求插進來。
    let bucket = await this.state.storage.get('bucket');
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + ttlSeconds * 1000 };
    const ok = bucket.count < limit;
    if (ok) {
      bucket.count += 1;
      await this.state.storage.put('bucket', bucket);
      await this.state.storage.setAlarm(bucket.resetAt);
    }
    return Response.json({ ok });
  }

  // 視窗結束後清掉自己，不留垃圾資料。
  async alarm() { await this.state.storage.deleteAll(); }
}

async function hit(env, key, limit, ttlSeconds) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const response = await stub.fetch('https://limiter/hit', { method: 'POST', body: JSON.stringify({ limit, ttlSeconds }) });
  return (await response.json()).ok;
}

// ---------- Discord OAuth ----------

async function login(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!await hit(env, `login:${ip}`, 30, 3600)) {
    return new Response('登入嘗試過於頻繁，請稍後再試。', { status: 429 });
  }
  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  const callback = new URL('/auth/callback', request.url).href;
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: callback,
    scope: env.DISCORD_GUILD_ID ? 'identify guilds.members.read' : 'identify',
    state,
    prompt: 'none',
  }).toString();
  const response = new Response(null, { status: 302, headers: { Location: authorize.href, 'Cache-Control': 'no-store' } });
  // state 綁在 Worker 網域的 cookie；回呼是頂層導覽，SameSite=Lax 會帶上。
  response.headers.append('Set-Cookie', `dash_state=${state}; Max-Age=600; Path=/auth; HttpOnly; Secure; SameSite=Lax`);
  // 登入後要回到哪一頁：只記固定代號，不記網址。
  const returnTo = new URL(request.url).searchParams.get('return') === 'upload' ? 'upload' : '';
  response.headers.append('Set-Cookie', `dash_return=${returnTo}; Max-Age=600; Path=/auth; HttpOnly; Secure; SameSite=Lax`);
  return response;
}

async function callback(env, request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const cookies = request.headers.get('Cookie') ?? '';
  const cookieState = /(?:^|;\s*)dash_state=([0-9a-f]{32})/.exec(cookies)?.[1];
  const page = /(?:^|;\s*)dash_return=upload(?:;|$)/.test(cookies) ? 'upload.html' : '';
  if (!code || !state || state !== cookieState) return redirectToSite(env, 'login-error=state', page);

  const tokenResponse = await fetch(`${discordApi(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: new URL('/auth/callback', request.url).href,
      client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
    }),
  });
  if (!tokenResponse.ok) return redirectToSite(env, 'login-error=discord', page);
  const { access_token: accessToken } = await tokenResponse.json();
  const discord = path => fetch(`${discordApi(env)}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });

  try {
    const userResponse = await discord('/users/@me');
    if (!userResponse.ok) return redirectToSite(env, 'login-error=discord', page);
    const user = await userResponse.json();

    // 帳號年齡：Discord ID 是 snowflake，前 42 位元就是建立時間，不需額外權限。
    const createdAt = Number(BigInt(user.id) >> 22n) + DISCORD_EPOCH_MS;
    const minAgeDays = Number(env.MIN_ACCOUNT_AGE_DAYS ?? 30);
    if (Date.now() - createdAt < minAgeDays * 86400000) return redirectToSite(env, 'login-error=account-age', page);

    if (env.DISCORD_GUILD_ID) {
      const memberResponse = await discord(`/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`);
      if (!memberResponse.ok) return redirectToSite(env, 'login-error=not-member', page);
      const member = await memberResponse.json();
      if (env.DISCORD_REQUIRED_ROLE_ID && !member.roles?.includes(env.DISCORD_REQUIRED_ROLE_ID)) {
        return redirectToSite(env, 'login-error=missing-role', page);
      }
    }

    // 檔案路徑用不可逆的 key；公開顯示的是 Discord 使用者名稱與頭像（頭像網址本身含數字 ID）。
    const ownerKey = hex(await hmac(env.OWNER_KEY_SECRET, user.id)).slice(0, 16);
    const username = user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;
    const session = await signSession(env, {
      k: ownerKey,
      n: cleanText(username, LIMITS.maxNameLength),
      a: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : '',
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });
    const response = redirectToSite(env, `session=${session}`, page);
    response.headers.append('Set-Cookie', 'dash_state=; Max-Age=0; Path=/auth; HttpOnly; Secure; SameSite=Lax');
    return response;
  } finally {
    // 只需要驗一次身分，Discord token 用完就撤銷，不保存。
    await fetch(`${discordApi(env)}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken, client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET }),
    }).catch(() => {});
  }
}

// ---------- GitHub App ----------

let installationToken; // { token, expiresAt }，同一個 isolate 內重用

async function githubToken(env) {
  if (installationToken && installationToken.expiresAt - Date.now() > 5 * 60 * 1000) return installationToken.token;
  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), char => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))}`;
  const appJwt = `${body}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(body)))}`;
  const response = await fetch(`${githubApi(env)}/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'loadout-dashboard-worker' },
  });
  if (!response.ok) throw new HttpError(502, 'GitHub 驗證失敗，請通知管理員。');
  const data = await response.json();
  installationToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
  return installationToken.token;
}

/** 呼叫 repo API。allow 列出「不算錯誤」的狀態碼（例如 404 代表檔案不存在）。 */
async function github(env, method, path, body, allow = []) {
  const response = await fetch(`${githubApi(env)}/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await githubToken(env)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'loadout-dashboard-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok && !allow.includes(response.status)) {
    console.error('GitHub', method, path, response.status, (await response.text()).slice(0, 300));
    throw new HttpError(502, 'GitHub 暫時無法處理，請稍後再試。');
  }
  return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) };
}

const baseBranch = env => env.GITHUB_BASE_BRANCH || 'main';
const ownerDir = key => `data/loadouts/${key}`;
const branchName = (key, slot) => `dash/${key}/${slot}`;

async function listSlots(env, key) {
  const { status, data } = await github(env, 'GET', `/contents/${ownerDir(key)}?ref=${baseBranch(env)}`, null, [404]);
  if (status === 404 || !Array.isArray(data)) return [];
  return data.map(file => slotFromFileName(file.name)).filter(Boolean);
}

/** 讀某個版本（分支、commit 或主分支）上的配裝檔，只取顯示用的角色名稱與備註。 */
async function readNames(env, key, slot, ref) {
  const { status, data } = await github(env, 'GET', `/contents/${ownerDir(key)}/Dash_${slot}.json?ref=${encodeURIComponent(ref)}`, null, [404]);
  if (status !== 200 || typeof data?.content !== 'string') return { character: '', label: '' };
  try {
    const entry = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\s+/g, '')), char => char.charCodeAt(0))));
    return { character: cleanText(entry.character, LIMITS.maxCharacterLength), label: cleanText(entry.label, LIMITS.maxLabelLength) };
  } catch { return { character: '', label: '' }; }
}

async function openPulls(env, key) {
  const { data } = await github(env, 'GET', '/pulls?state=open&per_page=100');
  const prefix = `dash/${key}/`;
  return data.filter(pull => pull.head.ref.startsWith(prefix) && pull.head.repo?.full_name === env.GITHUB_REPO)
    .map(pull => ({ slot: pull.head.ref.slice(prefix.length), url: pull.html_url, number: pull.number }));
}

/** 準備這個 slot 專用的分支：已有待審 PR 就沿用（更新同一個 PR），否則對齊主分支重來。 */
async function prepareBranch(env, key, slot, pulls) {
  const branch = branchName(key, slot);
  const pending = pulls.find(pull => pull.slot === slot);
  if (!pending) {
    const { data: base } = await github(env, 'GET', `/git/ref/heads/${baseBranch(env)}`);
    const created = await github(env, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: base.object.sha }, [422]);
    if (created.status === 422) await github(env, 'PATCH', `/git/refs/heads/${branch}`, { sha: base.object.sha, force: true });
  }
  return { branch, pending };
}

async function ensurePull(env, branch, pending, title, body) {
  if (pending) return pending.url;
  const { data } = await github(env, 'POST', '/pulls', { title, body, head: branch, base: baseBranch(env), maintainer_can_modify: false });
  return data.html_url;
}

// ---------- API ----------

const RESULT_MARKER = '<!-- dash-result -->';

/** 每個檔名最近一次投稿的狀態：審核中、被退回（附原因）。已合併的由 listSlots 判斷是否上榜。 */
async function submissionStates(env, key) {
  const { data } = await github(env, 'GET', '/pulls?state=all&sort=updated&direction=desc&per_page=50');
  const prefix = `dash/${key}/`;
  const latest = new Map();
  for (const pull of data) {
    if (!pull.head.ref.startsWith(prefix) || pull.head.repo?.full_name !== env.GITHUB_REPO) continue;
    const slot = pull.head.ref.slice(prefix.length);
    if (!latest.has(slot)) latest.set(slot, pull);
  }
  const states = new Map();
  await Promise.all([...latest].slice(0, LIMITS.maxSlotsPerOwner * 2).map(async ([slot, pull]) => {
    if (pull.merged_at) return undefined;
    // 待審或被退回的檔案不在主分支上，名稱要從該 PR 的 commit 讀（分支刪掉後 commit 仍可讀）。
    const names = await readNames(env, key, slot, pull.head.sha);
    if (pull.state === 'open') return states.set(slot, { status: 'pending', ...names });
    // 被退回：原因寫在 workflow 留的註解裡。任何人都能在公開 PR 留言，所以只採信 github-actions 機器人的留言。
    const { data: comments } = await github(env, 'GET', `/issues/${pull.number}/comments?per_page=30`);
    const comment = comments.filter(item => item.user?.login === 'github-actions[bot]' && item.body?.startsWith(RESULT_MARKER)).at(-1);
    const reason = comment ? cleanText(comment.body.slice(RESULT_MARKER.length), 200) : '';
    return states.set(slot, { status: 'rejected', ...names, reason: reason || '檢查沒有通過，請確認檔案後再上傳一次。' });
  }));
  return states;
}

async function me(env, request) {
  const session = await readSession(env, request);
  const [slots, states] = await Promise.all([listSlots(env, session.k), submissionStates(env, session.k)]);
  const entries = await Promise.all([...new Set([...slots, ...states.keys()])].sort().map(async slot => {
    const pending = states.get(slot);
    const names = pending ?? await readNames(env, session.k, slot, baseBranch(env));
    return { slot, character: names.character, label: names.label, live: slots.includes(slot), status: pending?.status ?? 'live', reason: pending?.reason ?? '' };
  }));
  entries.sort((a, b) => a.character.localeCompare(b.character) || a.label.localeCompare(b.label));
  return json(env, 200, { name: session.n, avatar: session.a ?? '', ownerKey: session.k, entries, maxSlots: LIMITS.maxSlotsPerOwner });
}

async function throttle(env, key) {
  if (!await hit(env, `cooldown:${key}`, 1, 60)) throw new HttpError(429, '請間隔 1 分鐘再送出。');
  if (!await hit(env, `daily:${key}`, Number(env.DAILY_LIMIT_PER_USER ?? 10), 86400)) throw new HttpError(429, '今天的送出次數已用完，明天再試。');
  if (!await hit(env, 'daily:all', Number(env.DAILY_LIMIT_GLOBAL ?? 300), 86400)) throw new HttpError(429, '今日收件量已滿，請明天再試。');
}

/** 讀請求內容，超過上限就中斷，不把整個超大請求讀進記憶體。 */
async function readLimited(request, maxBytes) {
  if (Number(request.headers.get('Content-Length') ?? 0) > maxBytes) throw new HttpError(413, '檔案太大。');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, '檔案太大。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function submit(env, request) {
  const session = await readSession(env, request);
  // 先看大小再讀內容；信封外層只多出檔名、標籤、暱稱。
  const raw = await readLimited(request, LIMITS.maxBytes + 2048);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new HttpError(400, '請求格式無效。'); }

  if (typeof payload?.content !== 'string') throw new HttpError(400, '缺少檔案內容。');
  const character = cleanText(payload.character, LIMITS.maxCharacterLength);
  if (!character) throw new HttpError(400, '請填寫角色名稱。');
  const label = cleanText(payload.label, LIMITS.maxLabelLength);
  // 玩家上傳的檔名不限也不採用。存檔名稱由「角色名稱＋備註」決定：同一組再上傳就是更新同一份，
  // repo 裡仍然是 Dash_<slot>.json，Dash_ 前綴的規則由這裡統一產生。
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${character.toLowerCase()}\n${label.toLowerCase()}`));
  const slot = `c${hex(digest).slice(0, 15)}`;
  const { errors, loadout } = parseUpload(payload.content);
  if (errors.length) throw new HttpError(422, '檔案沒有通過格式檢查。', { errors: errors.slice(0, 10) });

  await throttle(env, session.k);

  // 配額先算（已合併的 + 待審中的），通過了才建立分支，避免留下孤兒分支。
  const [slots, pulls] = await Promise.all([listSlots(env, session.k), openPulls(env, session.k)]);
  const used = new Set([...slots, ...pulls.map(pull => pull.slot)]);
  if (!used.has(slot) && used.size >= LIMITS.maxSlotsPerOwner) {
    throw new HttpError(409, `每個帳號最多保留 ${LIMITS.maxSlotsPerOwner} 份配裝，請先刪除一份，或用相同的角色名稱與備註更新既有的那份。`);
  }
  const { branch, pending } = await prepareBranch(env, session.k, slot, pulls);

  const entry = createEntry({ ownerKey: session.k, ownerName: session.n, avatar: session.a, character, slot, label, loadout });
  const path = `${ownerDir(session.k)}/Dash_${slot}.json`;
  const existing = await github(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, [404]);
  await github(env, 'PUT', `/contents/${path}`, {
    message: `${existing.status === 200 ? 'Update' : 'Add'} Dash_${slot} (${session.k})`,
    content: base64Utf8(`${JSON.stringify(entry, null, 2)}\n`),
    branch,
    ...(existing.status === 200 ? { sha: existing.data.sha } : {}),
  });
  const url = await ensurePull(env, branch, pending, `Dash_${slot} · ${session.k} · ${loadout.Job}`,
    `由 Dashboard 上傳流程自動建立。\n\n- owner: \`${session.k}\`\n- 檔案: \`${path}\`\n\n合併前會由 validate-submission 工作流程檢查。`);
  return json(env, 201, { status: pending ? 'updated' : 'created', slot, pullRequest: url });
}

async function remove(env, request, slot) {
  const session = await readSession(env, request);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(slot)) throw new HttpError(400, '檔名無效。');
  if (!(await listSlots(env, session.k)).includes(slot)) throw new HttpError(404, '找不到這份配裝。');
  await throttle(env, session.k);
  const { branch, pending } = await prepareBranch(env, session.k, slot, await openPulls(env, session.k));
  const path = `${ownerDir(session.k)}/Dash_${slot}.json`;
  const existing = await github(env, 'GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, [404]);
  if (existing.status === 200) {
    await github(env, 'DELETE', `/contents/${path}`, { message: `Remove Dash_${slot} (${session.k})`, sha: existing.data.sha, branch });
  }
  const url = await ensurePull(env, branch, pending, `Remove Dash_${slot} · ${session.k}`, '由擁有者從 Dashboard 提出的刪除請求。');
  return json(env, 202, { status: 'removal-requested', slot, pullRequest: url });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
      if (request.method === 'GET' && url.pathname === '/auth/login') return await login(env, request);
      if (request.method === 'GET' && url.pathname === '/auth/callback') return await callback(env, request);

      if (url.pathname.startsWith('/api/')) {
        // 會改資料的請求只接受來自 Dashboard 網站本身的呼叫。
        if (request.method !== 'GET' && request.headers.get('Origin') !== siteOrigin(env)) throw new HttpError(403, '來源不允許。');
        if (request.method === 'GET' && url.pathname === '/api/me') return await me(env, request);
        if (request.method === 'POST' && url.pathname === '/api/submit') return await submit(env, request);
        const removal = /^\/api\/entries\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'DELETE' && removal) return await remove(env, request, decodeURIComponent(removal[1]));
      }
      return json(env, 404, { error: '找不到這個路徑。' });
    } catch (error) {
      if (error instanceof HttpError) return json(env, error.status, { error: error.message, ...error.extra });
      console.error(error);
      return json(env, 500, { error: '伺服器發生錯誤。' });
    }
  },
};
