import { CONFIG } from './config.js';
import { $, applyArt, clearSession, h, restoreSession } from './lib/common.js';
import { AVATAR_PATTERN } from './lib/dash-format.js';

const number = new Intl.NumberFormat('zh-TW');
const dateTime = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium' });
const shortDate = new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' });
const state = {
  index: null,
  classFilter: 'all',
  sort: 'discord',
  rawRates: new Set(), // 目前切到「黃字」顯示的數值（致命一擊／極大化）
  query: '',
  selected: null,  // 目前打開明細的配裝 id（owner/slot）
  session: null,   // { token, name, avatar }
};

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

// ---------- 總覽與排行 ----------

/** 右上角：未登入顯示登入按鈕；已登入顯示名稱與前往上傳頁的連結。上傳與管理都在 upload.html。 */
function renderAccount() {
  const upload = h('a', { class: 'btn', href: './upload.html' }, state.session ? '上傳／管理我的配裝' : '上傳我的配裝');
  $('account').replaceChildren(...(state.session
    ? [h('span', { class: 'handle' }, state.session.name), upload, h('button', { class: 'btn link', type: 'button', onclick: () => { clearSession(); state.session = null; renderAccount(); } }, '登出')]
    : [upload]));
}

function renderTiles() {
  const { entries, classes, generatedAt } = state.index;
  const players = new Set(entries.map(entry => entry.id.split('/')[0])).size;
  const latest = entries.reduce((max, entry) => Math.max(max, Date.parse(entry.submittedAt)), 0);
  const tiles = [
    [number.format(entries.length), '份配裝'],
    [number.format(players), '位玩家'],
    [number.format(classes.length), '個職業'],
    [latest ? shortDate.format(latest) : '—', '最近一次投稿'],
  ];
  $('tiles').replaceChildren(...tiles.map(([value, label]) =>
    h('div', { class: 'tile' }, h('div', { class: 'value num' }, value), h('div', { class: 'label' }, label))));
  $('updated').textContent = `資料更新於 ${dateTime.format(new Date(generatedAt))}`;
}

function renderClassFilter() {
  const counts = new Map();
  for (const entry of state.index.entries) counts.set(entry.job, (counts.get(entry.job) ?? 0) + 1);
  const chip = (id, label, count) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.classFilter === id),
    onclick: () => { state.classFilter = id; renderClassFilter(); renderRanking(); },
  }, label, h('span', { class: 'count' }, count));
  $('class-filter').replaceChildren(
    chip('all', '全部', state.index.entries.length),
    ...state.index.classes.map(item => chip(item.id, item.name, counts.get(item.id) ?? 0)));
}

function visibleEntries() {
  const query = state.query.trim().toLowerCase();
  const entries = state.index.entries.filter(entry =>
    (state.classFilter === 'all' || entry.job === state.classFilter)
    && (!query || `${entry.player} ${entry.character} ${entry.label} ${entry.slot}`.toLowerCase().includes(query)));
  const text = new Intl.Collator('zh-TW', { numeric: true });
  const byPlayer = (a, b) => text.compare(a.player, b.player) || ownerOf(a).localeCompare(ownerOf(b));
  const byClass = (a, b) => text.compare(className(a.job), className(b.job));
  const bySlot = (a, b) => text.compare(a.slot, b.slot);
  const byCharacter = (a, b) => text.compare(a.character, b.character);
  const by = {
    discord: (a, b) => byPlayer(a, b) || byClass(a, b) || byCharacter(a, b),
    character: (a, b) => byCharacter(a, b) || byPlayer(a, b),
    class: (a, b) => byClass(a, b) || byPlayer(a, b) || byCharacter(a, b),
    damage: (a, b) => b.damage - a.damage,
  }[state.sort];
  return entries.sort(by);
}

function statValue(attribute, value) {
  const text = number.format(value);
  return attribute.unit === 'percent' ? `${text}%` : text;
}

// ---------- 明細面板 ----------

const wide = matchMedia('(min-width: 1200px)');
const ENTRY_HASH = /^#e-([0-9a-f]{16})-([A-Za-z0-9_-]{1,32})$/;
const ownerOf = entry => entry.id.split('/')[0];
const hashOf = entry => `#e-${entry.id.replace('/', '-')}`;
const className = job => state.index.classes.find(item => item.id === job)?.name ?? job;

/** 職業圖示：優先用 config.js 的 classIcons，其次 classes；都沒有（或載入失敗）就顯示職業代碼字樣。 */
function classArt(job) {
  const box = h('div', { class: 'class-art', 'aria-hidden': 'true' }, h('span', {}, job));
  const source = CONFIG.art?.classIcons?.[job] ?? CONFIG.art?.classes?.[job];
  if (source) {
    const image = h('img', { alt: '', loading: 'lazy', onload: () => box.classList.add('has-image'), onerror: () => image.remove() });
    image.src = source;
    box.append(image);
  }
  return box;
}

/** Discord 頭像；沒有頭像或載入失敗時顯示使用者名稱的第一個字。 */
function avatar(entry) {
  const box = h('div', { class: 'avatar', 'aria-hidden': 'true' }, h('span', {}, [...entry.player][0]?.toUpperCase() ?? '?'));
  // index.json 理論上已驗過，這裡再驗一次：只載入 Discord CDN 的頭像，不對任意網址發請求。
  if (typeof entry.avatar === 'string' && AVATAR_PATTERN.test(entry.avatar)) {
    const image = h('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onload: () => box.classList.add('has-image'), onerror: () => image.remove() });
    image.src = entry.avatar;
    box.append(image);
  }
  return box;
}

function select(id, { scroll = false, updateHash = true } = {}) {
  state.selected = id;
  const entry = state.index.entries.find(item => item.id === id);
  if (updateHash) history.replaceState(null, '', entry ? hashOf(entry) : location.pathname + location.search);
  // 選到的配裝若被目前的職業篩選或搜尋擋住，就放寬條件讓它出現在列表裡。
  if (entry && !visibleEntries().includes(entry)) {
    state.classFilter = 'all';
    state.query = '';
    $('search').value = '';
    renderClassFilter();
  }
  renderRanking();
  if (scroll && entry) document.getElementById(`row-${entry.id}`)?.scrollIntoView({ block: wide.matches ? 'nearest' : 'start', behavior: 'smooth' });
}

function selectFromHash() {
  const match = ENTRY_HASH.exec(location.hash);
  const id = match && `${match[1]}/${match[2]}`;
  if (id && state.index.entries.some(entry => entry.id === id)) select(id, { scroll: true, updateHash: false });
}

/** 一列數值。致命一擊、極大化預設顯示副本內實際機率，點擊切換成黃字總和。 */
function statRow(entry, attribute) {
  const rate = entry.rates?.[attribute.key];
  if (!rate) return h('div', {}, h('dt', {}, attribute.name), h('dd', {}, statValue(attribute, entry.stats[attribute.key])));
  const raw = state.rawRates.has(attribute.key);
  return h('div', { class: 'rate' }, h('dt', {}, attribute.name),
    h('dd', {}, h('button', {
      type: 'button', 'aria-pressed': String(raw), class: raw ? 'raw' : '',
      title: raw ? '目前顯示黃字總和，點一下看副本內實際值' : '目前顯示副本內實際值，點一下看黃字總和',
      onclick: () => { if (raw) state.rawRates.delete(attribute.key); else state.rawRates.add(attribute.key); renderRanking(); },
    }, h('span', { class: 'tag' }, raw ? '黃字' : '副本內'), `${number.format(raw ? rate.raw : rate.actual)}%`)));
}

function renderDetail(entry) {
  const stats = state.index.attributes.filter(attribute => entry.stats[attribute.key] !== undefined && entry.stats[attribute.key] !== null);
  const facts = [
    entry.attackType === 'magical' ? '魔法職業' : '物理職業',
    `攻擊力 ${number.format(entry.attackPower)}`,
    entry.title && `稱號 ${entry.title}`,
    entry.beastStoneColor !== undefined && `聖獸精靈石 ${entry.beastStoneColor ?? '未選'}`,
    entry.stage.adapt !== null && `適應力 ${entry.stage.adapt}%`,
    entry.stage.bossDefense !== null && `Boss 防禦 ${entry.stage.bossDefense}%`,
    entry.clearedFields > 0 && `${entry.clearedFields} 個欄位因遊戲資料更新而未採計`,
  ].filter(Boolean);
  // 同一位玩家的所有配裝，依職業、檔名排序，當成分頁切換。
  const siblings = state.index.entries.filter(item => ownerOf(item) === ownerOf(entry))
    .sort((a, b) => a.job.localeCompare(b.job) || a.slot.localeCompare(b.slot));
  return h('div', { class: 'detail' },
    h('header', { class: 'detail-head' },
      classArt(entry.job),
      avatar(entry),
      h('div', { class: 'detail-title' },
        h('div', { class: 'character' }, entry.character),
        h('div', { class: 'handle' }, entry.player)),
      h('div', { class: 'uploaded' }, '最後上傳', h('time', { dateTime: entry.submittedAt }, dateTime.format(new Date(entry.submittedAt))))),
    h('div', { class: 'headline' },
      h('div', {}, h('div', { class: 'big num' }, number.format(entry.damage)), h('div', { class: 'muted' }, '總增幅（純面板，不含 Buff／Debuff）')),
      h('div', { class: 'who' }, h('span', { class: 'badge' }, className(entry.job)), entry.label && h('span', { class: 'label' }, entry.label))),
    siblings.length > 1 && h('div', { class: 'tabs', role: 'group', 'aria-label': `${entry.player} 的所有角色` },
      siblings.map(item => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(item.id === entry.id), onclick: () => select(item.id, { scroll: true }),
      }, item.character, h('span', { class: 'count' }, className(item.job))))),
    h('div', { class: 'facts' }, facts.map(fact => h('span', {}, fact))),
    h('section', {}, h('h3', {}, '角色數值'),
      h('p', { class: 'muted' }, '致命一擊與極大化有遞減，表上是副本內的實際機率；點一下切換成黃字總和。'),
      h('dl', { class: 'stats' }, stats.map(attribute => statRow(entry, attribute)))),
    entry.spiritRecord?.length > 0 && h('section', {}, h('h3', {}, '賦靈錄'),
      h('div', { class: 'tabs' }, entry.spiritRecord.map(job => h('span', { class: 'badge' }, className(job))))),
    h('section', {}, h('h3', {}, '裝備'),
      h('div', { class: 'gear' }, entry.gear.map(group =>
        h('div', {}, h('strong', {}, group.name),
          h('ul', {}, group.items.map(item =>
            h('li', {}, h('span', { class: 'slot' }, item.slot), h('span', { class: 'item' }, item.item)))))))));
}

function renderRanking() {
  const entries = visibleEntries();
  // 寬螢幕右側面板固定顯示一份；還沒選就先顯示目前列表的第一名。
  if (wide.matches && !entries.some(entry => entry.id === state.selected) && !state.index.entries.some(entry => entry.id === state.selected)) {
    state.selected = entries[0]?.id ?? null;
  }
  const selected = state.index.entries.find(entry => entry.id === state.selected);
  const top = Math.max(1, ...entries.map(entry => entry.damage));

  // 分組排列時，每換一位玩家（或一個職業）插入一列小標題。
  const groupOf = { discord: entry => [ownerOf(entry), entry.player], class: entry => [entry.job, className(entry.job)] }[state.sort];
  let lastGroup;
  $('ranking').classList.toggle('grouped', !!groupOf);
  $('ranking').replaceChildren(...entries.flatMap((entry, i) => {
    const current = entry.id === state.selected;
    const [groupKey, groupName] = groupOf?.(entry) ?? [];
    const heading = groupOf && groupKey !== lastGroup
      ? h('li', { class: 'group' }, groupName, h('span', { class: 'count' }, entries.filter(item => groupOf(item)[0] === groupKey).length)) : null;
    lastGroup = groupKey;
    return [heading, h('li', { class: 'entry', id: `row-${entry.id}` },
      h('button', {
        type: 'button', 'aria-expanded': String(current), 'aria-current': current ? 'true' : undefined,
        // 窄螢幕再點一次收合；寬螢幕右側面板常駐，不收合。
        onclick: () => select(current && !wide.matches ? null : entry.id),
      },
        // 列首：依 Discord ID 排時放頭像，依職業／遊戲內 ID 排時放職業圖示，依總增幅排時放名次。
        state.sort === 'discord' ? avatar(entry) : state.sort === 'damage' ? h('span', { class: 'rank num' }, i + 1) : classArt(entry.job),
        h('span', { class: 'who' },
          h('span', { class: 'name' }, entry.character),
          h('span', { class: 'badge' }, className(entry.job)),
          state.sort !== 'discord' && h('span', { class: 'label handle' }, entry.player),
          entry.label && h('span', { class: 'label' }, entry.label)),
        h('span', { class: 'damage num' }, number.format(entry.damage)),
        h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${(entry.damage / top * 100).toFixed(1)}%` }))),
      current && !wide.matches && renderDetail(entry))].filter(Boolean);
  }));
  $('detail-panel').replaceChildren(...(selected ? [renderDetail(selected)] : [h('p', { class: 'empty' }, '點左邊任一列看配裝明細。')]));
  $('empty').hidden = entries.length > 0;
  $('empty').textContent = state.index.entries.length ? '沒有符合條件的配裝。' : '還沒有人上傳配裝，成為第一個吧。';
}

// ---------- 啟動 ----------

async function start() {
  applyArt();
  const restored = restoreSession();
  state.session = restored.session;
  showNotice(restored.loginError);
  renderAccount();
  $('search').addEventListener('input', event => { state.query = event.target.value; renderRanking(); });
  $('sort').addEventListener('change', event => { state.sort = event.target.value; renderRanking(); });

  try {
    // index.json 由 GitHub Actions 在每次合併後重建；no-cache 讓瀏覽器每次都向伺服器確認版本。
    const response = await fetch('./data/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    state.index = await response.json();
  } catch {
    state.index = { generatedAt: new Date().toISOString(), attributes: [], classes: [], entries: [] };
    showNotice('目前讀不到排行資料，請稍後重新整理。');
  }
  renderTiles();
  renderClassFilter();
  renderRanking();
  selectFromHash();
  addEventListener('hashchange', selectFromHash);
  wide.addEventListener('change', renderRanking);
}

start();
