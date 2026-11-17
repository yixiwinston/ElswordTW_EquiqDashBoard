// Dash_ 檔案的結構驗證。瀏覽器、Worker、GitHub Actions 三邊共用這一份，
// 規則只改這裡。這層只看「形狀」，欄位值是否為合法裝備由 build-index 交給計算機判斷。

export const LIMITS = Object.freeze({
  maxBytes: 32 * 1024,       // 計算機匯出約 3–4 KB
  maxValueKeys: 600,         // 目前欄位代碼約 300 個
  maxStringLength: 64,
  maxSlotsPerOwner: 5,       // 同一位玩家可保留的檔案數（不同職業／用途各一份）；同檔名視為更新
  maxNameLength: 24,
  maxCharacterLength: 24,    // 遊戲內角色 ID
  maxLabelLength: 30,
});

export const FILE_NAME_PATTERN = /^Dash_([A-Za-z0-9_-]{1,32})\.json$/;
export const OWNER_KEY_PATTERN = /^[0-9a-f]{16}$/;
export const ENTRY_PATH_PATTERN = /^data\/loadouts\/([0-9a-f]{16})\/Dash_([A-Za-z0-9_-]{1,32})\.json$/;

// 對應 damage-calculator frontend/loadout-transfer.ts 的 serializeLoadout 輸出。
// 計算機新增頂層欄位時要在這裡補上，否則新檔會被擋下（刻意採白名單）。
const LOADOUT_KEYS = new Set([
  'format', 'formatVersion', 'Job',
  'Stage.Adapt', 'Stage.CritRatePenalty', 'Stage.BossDEF',
  'values',
  'lowerwearAlternativeEnabled', 'masterBeastSpiritStoneColor', 'petSkillAttackEnabled',
  'nutProtectionPotionEnabled', 'nephronRaidEnabled', 'transcendenceSkillDamageSharePct',
  'classSkillVersions', 'bossHealthCondition',
]);
const ENTRY_KEYS = new Set(['format', 'formatVersion', 'owner', 'character', 'slot', 'label', 'submittedAt', 'loadout']);
// 頭像只接受 Discord CDN 的固定格式，避免公開頁面去載入任意網址。
export const AVATAR_PATTERN = /^https:\/\/cdn\.discordapp\.com\/avatars\/\d{17,20}\/[a-z0-9_]{1,64}\.png\?size=128$/;

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
// 控制字元、角括號，以及可用來偽裝顯示內容的雙向控制／零寬字元一律不收：資料會被渲染到公開頁面。
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f<>\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, 'g');
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !UNSAFE_TEXT.test(value);
const primitive = value => (typeof value === 'number' && Number.isFinite(value)) || safeText(value, LIMITS.maxStringLength);

export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** 檢查檔名，回傳 slot（Dash_ 後面那段）或 null。 */
export function slotFromFileName(name) {
  return FILE_NAME_PATTERN.exec(String(name))?.[1] ?? null;
}

/** 整理顯示用文字：去頭尾空白、壓縮空白、移除不安全字元。 */
export function cleanText(value, max) {
  return String(value ?? '').normalize('NFC').replace(UNSAFE_TEXT_ALL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 驗證計算機匯出的配裝（damage-calculator-loadout v3）。回傳錯誤訊息陣列，空陣列代表通過。 */
export function validateLoadout(loadout) {
  const errors = [];
  if (!isRecord(loadout)) return ['內容必須是 JSON 物件。'];
  if (loadout.format !== 'damage-calculator-loadout' || loadout.formatVersion !== 3) {
    return ['不是配裝模擬器匯出的檔案（format／formatVersion 不符）。'];
  }
  for (const key of Object.keys(loadout)) if (!LOADOUT_KEYS.has(key)) errors.push(`不支援的欄位：${key.slice(0, 40)}`);
  if (typeof loadout.Job !== 'string' || !/^[A-Za-z]{1,8}$/.test(loadout.Job)) errors.push('Job 必須是職業代碼。');
  for (const key of ['Stage.Adapt', 'Stage.CritRatePenalty', 'Stage.BossDEF']) {
    if (loadout[key] !== undefined && loadout[key] !== null && !primitive(loadout[key])) errors.push(`${key} 格式無效。`);
  }

  if (!isRecord(loadout.values)) errors.push('values 必須是物件。');
  else {
    const keys = Object.keys(loadout.values);
    if (keys.length > LIMITS.maxValueKeys) errors.push(`values 欄位數超過 ${LIMITS.maxValueKeys}。`);
    for (const key of keys.slice(0, LIMITS.maxValueKeys)) {
      if (!/^[1-9]\d{0,3}$/.test(key)) { errors.push(`values 的鍵必須是欄位代碼：${key.slice(0, 20)}`); break; }
      if (!primitive(loadout.values[key])) { errors.push(`values.${key} 必須是有限數字或 ${LIMITS.maxStringLength} 字以內的文字。`); break; }
    }
  }

  for (const key of ['lowerwearAlternativeEnabled', 'petSkillAttackEnabled', 'nutProtectionPotionEnabled', 'nephronRaidEnabled']) {
    if (loadout[key] !== undefined && typeof loadout[key] !== 'boolean') errors.push(`${key} 必須是布林值。`);
  }
  if (loadout.masterBeastSpiritStoneColor !== undefined && !['黃', '綠', ''].includes(loadout.masterBeastSpiritStoneColor)) {
    errors.push('masterBeastSpiritStoneColor 無效。');
  }
  const share = loadout.transcendenceSkillDamageSharePct;
  if (share !== undefined && !(Number.isInteger(share) && share >= 0 && share <= 100)) errors.push('transcendenceSkillDamageSharePct 必須是 0–100 的整數。');

  const versions = loadout.classSkillVersions;
  if (versions !== undefined) {
    if (!isRecord(versions) || Object.keys(versions).length > 32
      || Object.entries(versions).some(([key, value]) => !/^[\w.:-]{1,48}$/.test(key) || typeof value !== 'boolean')) {
      errors.push('classSkillVersions 格式無效。');
    }
  }
  const boss = loadout.bossHealthCondition;
  if (boss !== undefined) {
    if (!isRecord(boss) || Object.keys(boss).some(key => !['enabled', 'comparison', 'lowerwear'].includes(key))
      || typeof boss.enabled !== 'boolean' || !['above', 'below'].includes(boss.comparison)
      || !['lowerwearA', 'lowerwearB'].includes(boss.lowerwear)) {
      errors.push('bossHealthCondition 格式無效。');
    }
  }
  return errors;
}

/** 讀玩家上傳的原始文字：大小、JSON、格式一次檢查完。 */
export function parseUpload(text) {
  if (byteLength(text) > LIMITS.maxBytes) return { errors: [`檔案超過 ${LIMITS.maxBytes / 1024} KB。`] };
  let loadout;
  try { loadout = JSON.parse(text); } catch { return { errors: ['檔案不是有效的 JSON。'] }; }
  const errors = validateLoadout(loadout);
  return errors.length ? { errors } : { errors, loadout };
}

/** Worker 寫進 repo 的信封：誰（路徑用的 key、Discord 使用者名稱與頭像）、哪隻角色、什麼時候，加上原封不動的配裝。 */
export function createEntry({ ownerKey, ownerName, avatar = '', character, slot, label, loadout, now = new Date() }) {
  return {
    format: 'dash-entry',
    formatVersion: 1,
    owner: { key: ownerKey, name: cleanText(ownerName, LIMITS.maxNameLength) || 'unknown', avatar: AVATAR_PATTERN.test(avatar) ? avatar : '' },
    character: cleanText(character, LIMITS.maxCharacterLength),
    slot,
    label: cleanText(label, LIMITS.maxLabelLength),
    submittedAt: now.toISOString(),
    loadout,
  };
}

/** 驗證 repo 內的信封檔；path 有給時一併確認路徑與內容一致。 */
export function validateEntry(entry, path) {
  if (!isRecord(entry) || entry.format !== 'dash-entry' || entry.formatVersion !== 1) return ['不是 dash-entry v1 檔案。'];
  const errors = [];
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`不支援的欄位：${key.slice(0, 40)}`);
  const owner = entry.owner;
  if (!isRecord(owner) || Object.keys(owner).some(key => !['key', 'name', 'avatar'].includes(key))
    || (owner.avatar !== undefined && owner.avatar !== '' && !(typeof owner.avatar === 'string' && AVATAR_PATTERN.test(owner.avatar)))
    || typeof owner.key !== 'string' || !OWNER_KEY_PATTERN.test(owner.key)
    || !safeText(owner.name, LIMITS.maxNameLength) || !owner.name) errors.push('owner 格式無效。');
  if (!safeText(entry.character, LIMITS.maxCharacterLength) || !entry.character) errors.push('character（遊戲內 ID）必填。');
  if (typeof entry.slot !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(entry.slot)) errors.push('slot 格式無效。');
  if (!safeText(entry.label, LIMITS.maxLabelLength)) errors.push('label 格式無效。');
  if (typeof entry.submittedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(entry.submittedAt)
    || Number.isNaN(Date.parse(entry.submittedAt))) errors.push('submittedAt 必須是 UTC ISO 時間。');
  if (path !== undefined) {
    const match = ENTRY_PATH_PATTERN.exec(path);
    if (!match) errors.push('路徑必須是 data/loadouts/<owner>/Dash_<slot>.json。');
    else if (match[1] !== owner?.key || match[2] !== entry.slot) errors.push('路徑與檔案內的 owner／slot 不一致。');
  }
  errors.push(...validateLoadout(entry.loadout));
  return errors;
}
