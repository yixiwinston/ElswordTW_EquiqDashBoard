// 上傳頁：確認 Discord 登入後，填角色名稱、選計算機匯出的 JSON（檔名不限）送出，並管理自己已上傳的配裝。
import { CONFIG } from './config.js';
import { $, api, applyArt, clearSession, h, loginUrl, restoreSession } from './lib/common.js';
import { AVATAR_PATTERN, LIMITS, cleanText, parseUpload } from './lib/dash-format.js';

const STATUS_TEXT = { live: '已上榜', pending: '審核中', rejected: '被退回' };
const state = {
  session: null,
  me: null,                 // { entries: [{ slot, character, label, live, status, reason }], maxSlots }
  check: null,              // 目前選的檔案的檢查結果
  busy: false,
  result: null,             // 最近一次送出／刪除的結果訊息
};

const call = (path, options) => api(state.session, path, options, logout);

function logout() {
  clearSession();
  state.session = null;
  state.me = null;
  render();
}

async function loadMine() {
  if (!state.session || !CONFIG.apiBase) return;
  try { state.me = await call('/api/me'); } catch { state.me = null; }
  renderMine();
}

async function chooseFile(file) {
  state.check = null;
  state.result = null;
  if (file) {
    if (file.size > LIMITS.maxBytes) state.check = { errors: [`檔案超過 ${LIMITS.maxBytes / 1024} KB，不像是配裝模擬器的匯出檔。`] };
    else {
      const content = await file.text();
      const { errors, loadout } = parseUpload(content);
      state.check = { errors, loadout, content };
    }
  }
  renderCheck();
}

async function submit(form) {
  state.busy = true;
  state.result = null;
  renderCheck();
  try {
    const result = await call('/api/submit', {
      method: 'POST',
      body: JSON.stringify({
        content: state.check.content,
        character: cleanText(form.elements.character.value, LIMITS.maxCharacterLength),
        label: cleanText(form.elements.label.value, LIMITS.maxLabelLength),
      }),
    });
    state.result = { ok: true, message: result.status === 'updated' ? '已更新審核中的投稿。' : '已送出。系統會自動檢查，結果會顯示在下方「我的配裝」。' };
    state.check = null;
    form.elements.file.value = '';
    loadMine();
  } catch (error) {
    state.result = { ok: false, message: error.message, details: error.details };
  }
  state.busy = false;
  renderCheck();
}

async function remove(entry, button) {
  // 瀏覽器的確認對話框在部分環境不能用，所以改成「再按一次確認」。
  if (button.dataset.armed !== 'yes') { button.dataset.armed = 'yes'; button.textContent = '確定刪除？'; return; }
  button.disabled = true;
  try {
    await call(`/api/entries/${encodeURIComponent(entry.slot)}`, { method: 'DELETE' });
    state.result = { ok: true, message: '已送出刪除請求，幾分鐘後會從列表移除。' };
  } catch (error) {
    state.result = { ok: false, message: error.message };
  }
  await loadMine();
  renderCheck();
}

// ---------- 畫面 ----------

function renderAccount() {
  if (!state.session) return $('account').replaceChildren();
  const avatar = h('div', { class: 'avatar small', 'aria-hidden': 'true' }, h('span', {}, [...state.session.name][0]?.toUpperCase() ?? '?'));
  if (AVATAR_PATTERN.test(state.session.avatar)) {
    const image = h('img', { alt: '', referrerPolicy: 'no-referrer', onload: () => avatar.classList.add('has-image'), onerror: () => image.remove() });
    image.src = state.session.avatar;
    avatar.append(image);
  }
  return $('account').replaceChildren(avatar, h('span', { class: 'handle' }, state.session.name),
    h('button', { class: 'btn link', type: 'button', onclick: logout }, '登出'));
}

/** 檔案檢查結果、送出按鈕狀態與結果訊息。表單本身不重繪，已填的角色名稱才不會被洗掉。 */
function renderCheck() {
  const box = $('check');
  if (!box) return;
  const { check, result, busy } = state;
  const parts = [];
  if (check?.errors.length) {
    parts.push(h('div', { class: 'check bad', role: 'alert' }, '這個檔案不能上傳：', h('ul', {}, check.errors.slice(0, 6).map(error => h('li', {}, error)))));
  } else if (check) {
    parts.push(h('div', { class: 'check ok', role: 'status' }, `格式正確：職業 ${check.loadout.Job}，${Object.keys(check.loadout.values).length} 個欄位。`));
  }
  if (result) {
    parts.push(h('div', { class: `check ${result.ok ? 'ok' : 'bad'}`, role: result.ok ? 'status' : 'alert' }, result.message,
      result.details && h('ul', {}, result.details.map(detail => h('li', {}, detail)))));
  }
  box.replaceChildren(...parts);
  const button = $('send');
  button.disabled = busy || !check || check.errors.length > 0;
  button.textContent = busy ? '送出中…' : '送出審核';
}

function renderForm() {
  if (!CONFIG.apiBase) {
    return $('upload').replaceChildren(h('p', { class: 'muted' }, '這個站台還沒有接上登入服務（config.js 的 apiBase 未設定），暫時無法上傳。'));
  }
  if (!state.session) {
    return $('upload').replaceChildren(
      h('p', { class: 'muted' }, '上傳前請先登入。登入只用來確認你的 Discord 帳號（名稱與頭像），不會取得其他權限。'),
      h('div', { class: 'actions' }, h('a', { class: 'btn discord', href: loginUrl('upload') }, '用 Discord 登入')));
  }
  $('upload').replaceChildren(
    h('form', { class: 'upload', onsubmit: event => { event.preventDefault(); submit(event.currentTarget); } },
      h('div', { class: 'field' }, h('label', { for: 'character' }, '角色名稱（遊戲內 ID）'),
        h('input', { id: 'character', name: 'character', type: 'text', maxLength: LIMITS.maxCharacterLength, required: true, autocomplete: 'off' })),
      h('div', { class: 'field' }, h('label', { for: 'file' }, '配裝檔案（配裝模擬器匯出的 .json）'),
        h('input', { id: 'file', name: 'file', type: 'file', accept: '.json,application/json', required: true, onchange: event => chooseFile(event.target.files[0]) })),
      h('div', { class: 'field' }, h('label', { for: 'label' }, '備註（選填；同一個角色想放第二份配裝時用來區分，例如「襲擊戰用」）'),
        h('input', { id: 'label', name: 'label', type: 'text', maxLength: LIMITS.maxLabelLength })),
      h('div', { id: 'check', class: 'upload' }),
      h('p', { class: 'muted' }, `會連同你的 Discord 使用者名稱（${state.session.name}）與頭像一起公開顯示。`),
      h('div', { class: 'actions' }, h('button', { id: 'send', class: 'btn primary', type: 'submit', disabled: true }, '送出審核'))));
  return renderCheck();
}

function renderMine() {
  const entries = state.me?.entries ?? [];
  $('mine-panel').hidden = !state.session || !entries.length;
  if (!entries.length) return;
  const used = entries.filter(entry => entry.live || entry.status === 'pending').length;
  $('mine-title').textContent = `我的配裝（${used} / ${state.me.maxSlots}）`;
  $('mine').replaceChildren(h('ul', { class: 'mine-list' }, entries.map(entry => h('li', {},
    h('div', { class: 'mine-entry' },
      h('span', {}, h('strong', {}, entry.character || '（未命名）'), entry.label && h('span', { class: 'muted' }, `　${entry.label}`), ' ',
        h('span', { class: `status ${entry.status}` }, STATUS_TEXT[entry.status] ?? entry.status),
        entry.status !== 'live' && entry.live && h('span', { class: 'muted' }, '（舊版仍在榜上）')),
      entry.status === 'rejected' && h('span', { class: 'reason' }, `原因：${entry.reason}`),
      entry.status === 'pending' && h('span', { class: 'muted' }, '通過檢查後幾分鐘內會出現在列表。')),
    entry.live && h('button', { class: 'btn link', type: 'button', onclick: event => remove(entry, event.currentTarget) }, '刪除')))));
}

function render() {
  renderAccount();
  renderForm();
  renderMine();
}

applyArt();
$('calculator-link').href = CONFIG.calculatorUrl;
$('max-slots').textContent = LIMITS.maxSlotsPerOwner;
const restored = restoreSession();
state.session = restored.session;
$('notice').textContent = restored.loginError;
$('notice').hidden = !restored.loginError;
render();
loadMine();
