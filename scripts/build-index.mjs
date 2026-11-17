// 把 data/loadouts 下的 Dash_ 檔解碼成 Dashboard 讀的 site/data/index.json。
// 解碼與數值計算直接呼叫配裝模擬器建置後的模組（見 scripts/lib/calculator.mjs），所以數字會跟計算機頁面一致，
// 計算機資料更新後重新部署就會跟著更新。
//   node scripts/build-index.mjs --calculator <已建置的 damage-calculator 目錄> [--out site/data/index.json]
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEntry } from '../site/lib/dash-format.js';
import { loadCalculator } from './lib/calculator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const calculator = option('--calculator');
if (!calculator) { console.error('缺少 --calculator <目錄>'); process.exit(2); }
const outFile = resolve(root, option('--out', 'site/data/index.json'));
const loadoutsDir = resolve(root, option('--loadouts', 'data/loadouts'));
const maxAgeDays = Number(process.env.ENTRY_MAX_AGE_DAYS ?? 180);
const now = Date.now();

const { gameData, classes, summarize } = await loadCalculator(calculator);

const entries = [];
const rejected = [];
const owners = (await readdir(loadoutsDir, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory());
for (const owner of owners) {
  for (const file of (await readdir(join(loadoutsDir, owner.name))).filter(name => name.endsWith('.json')).sort()) {
    const path = `data/loadouts/${owner.name}/${file}`;
    try {
      const entry = JSON.parse(await readFile(join(loadoutsDir, owner.name, file), 'utf8'));
      const errors = validateEntry(entry, path);
      if (errors.length) throw new Error(errors[0]);
      if (maxAgeDays > 0 && now - Date.parse(entry.submittedAt) > maxAgeDays * 86400000) { rejected.push({ path, reason: 'expired' }); continue; }
      entries.push({
        id: `${entry.owner.key}/${entry.slot}`,
        player: entry.owner.name, avatar: entry.owner.avatar || null, character: entry.character, slot: entry.slot, label: entry.label, submittedAt: entry.submittedAt,
        ...summarize(entry),
      });
    } catch (error) {
      rejected.push({ path, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }
}
entries.sort((a, b) => b.damage - a.damage || a.id.localeCompare(b.id));

const usedClasses = [...new Set(entries.map(entry => entry.job))];
const index = {
  generatedAt: new Date(now).toISOString(),
  gameDataUpdatedAt: gameData.classes.dataUpdatedAt ?? null,
  attributes: gameData.attributes.attributes.filter(item => item.active !== false)
    .map(item => ({ key: item.key, name: item.name.replaceAll('雙攻', '攻擊力'), unit: item.unit })),
  classes: usedClasses.map(id => ({ id, name: classes.get(id)?.name ?? id, attackType: classes.get(id)?.attackType ?? null })),
  entries,
};
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(index)}\n`);
console.log(`index.json：${entries.length} 筆配裝，略過 ${rejected.length} 筆。`);
for (const item of rejected) console.log(`  略過 ${item.path}：${item.reason}`);
