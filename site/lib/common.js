// 主頁（app.js）與上傳頁（upload.js）共用：DOM 小工具、登入狀態、呼叫 API、套用背景圖。
import { CONFIG } from '../config.js';

const SESSION_KEY = 'dash-session';
export const LOGIN_ERRORS = {
  state: '登入流程逾時或被中斷，請再試一次。',
  discord: 'Discord 沒有回應，請稍後再試。',
  'account-age': '這個 Discord 帳號建立時間太短，暫時不能上傳。',
  'not-member': '需要先加入指定的 Discord 伺服器才能上傳。',
  'missing-role': '你的 Discord 帳號沒有上傳所需的身分組。',
};

export const $ = id => document.getElementById(id);

/** 建立元素。所有玩家提供的文字都只經過 textContent，不會被當成 HTML。 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function storage(action, value) {
  try {
    if (action === 'get') return sessionStorage.getItem(SESSION_KEY);
    if (action === 'set') sessionStorage.setItem(SESSION_KEY, value);
    if (action === 'clear') sessionStorage.removeItem(SESSION_KEY);
  } catch { /* 無法使用儲存空間時，登入只維持到重新整理 */ }
  return null;
}

function readSession(token) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))));
    if (!(payload.exp > Date.now() / 1000)) return null;
    return { token, name: String(payload.n ?? ''), avatar: String(payload.a ?? '') };
  } catch { return null; }
}

/** 讀回登入狀態：剛從 Discord 回來時權杖在網址的 # 後面（讀完立刻從網址清掉），否則取同一分頁先前存的。 */
export function restoreSession() {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromLogin = params.get('session');
  const loginError = params.get('login-error');
  if (fromLogin || loginError) history.replaceState(null, '', location.pathname + location.search);
  const token = fromLogin ?? storage('get');
  const session = token ? readSession(token) : null;
  if (session) storage('set', session.token); else storage('clear');
  return { session, loginError: loginError ? (LOGIN_ERRORS[loginError] ?? '登入失敗，請再試一次。') : '' };
}

export function clearSession() { storage('clear'); }

/** 登入網址。returnTo 只接受固定代號（目前只有 'upload'），實際導回哪一頁由 Worker 決定。 */
export const loginUrl = returnTo => `${CONFIG.apiBase}/auth/login${returnTo ? `?return=${returnTo}` : ''}`;

/** 呼叫 Worker。401 代表權杖失效，交給 onUnauthorized 處理（通常是登出）。 */
export async function api(session, path, options = {}, onUnauthorized = () => {}) {
  const response = await fetch(`${CONFIG.apiBase}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${session?.token ?? ''}` },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) onUnauthorized();
  if (!response.ok) throw Object.assign(new Error(body.error ?? '請求失敗。'), { details: body.errors });
  return body;
}

/** 套用 config.js 的佈景、背景圖與頁首插圖。 */
export function applyArt() {
  const root = document.documentElement;
  if (CONFIG.theme === 'dark' || CONFIG.theme === 'light') root.dataset.theme = CONFIG.theme;
  const art = CONFIG.art ?? {};
  if (art.background) {
    root.style.setProperty('--bg-image', `url(${JSON.stringify(art.background)})`);
    root.style.setProperty('--bg-dim', `${Math.round(Math.min(1, Math.max(0, art.backgroundDim ?? 0.7)) * 100)}%`);
    root.classList.add('has-background');
  }
  if (art.hero) {
    const hero = $('hero-art');
    hero.onload = () => { hero.hidden = false; };
    hero.src = art.hero;
  }
}
