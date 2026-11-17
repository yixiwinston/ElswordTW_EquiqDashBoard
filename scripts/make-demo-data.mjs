// 開發用：拿計算機的公開範例配裝做出幾份變化，產生示範用的 Dash_ 檔，方便在沒有真實投稿時預覽版面。
//   node scripts/make-demo-data.mjs --calculator <已建置的 damage-calculator 目錄> [--out demo/loadouts]
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEntry } from '../site/lib/dash-format.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const calculator = option('--calculator');
if (!calculator) { console.error('缺少 --calculator <目錄>'); process.exit(2); }
const out = resolve(root, option('--out', 'demo/loadouts'));

const gameData = JSON.parse(await readFile(resolve(calculator, 'dist/data/game-data.json'), 'utf8'));
const { serializeLoadout } = await import(pathToFileURL(resolve(calculator, 'dist/frontend/loadout-transfer.js')).href);
const examples = resolve(calculator, 'data/examples');
const exampleFile = (await readdir(examples)).filter(name => name.endsWith('.json')).sort().at(-1);
const example = JSON.parse(await readFile(join(examples, exampleFile), 'utf8'));

// 每筆：Discord 使用者名稱、檔名、備註、職業、要拿掉的欄位前綴（模擬還沒畢業的配裝）、武器強化。
const variants = [
  ['示範玩家 01', 'main', '畢業配裝', 'DaB', [], 'Lv.12'],
  ['示範玩家 02', 'main', '', 'DaB', ['Right.Ice.Ring', 'Right.Ice.Earring'], 'Lv.12'],
  ['示範玩家 03', 'raid', '襲擊戰用', 'DaB', ['Right.Ice.', 'Accessory.Ring2'], 'Lv.11'],
  ['示範玩家 04', 'main', '', 'CU', [], 'Lv.12'],
  ['示範玩家 05', 'main', '過渡中', 'CU', ['Ice.Weapon.', 'Accessory.Support'], 'Lv.11'],
  ['示範玩家 06', 'main', '', 'CE', ['Right.Ice.Top', 'Right.Ice.Bottom'], 'Lv.12'],
  ['示範玩家 07', 'alt', '小號', 'CE', ['Right.Ice.', 'Costume.'], 'Lv.10'],
  ['示範玩家 08', 'main', '', 'MO', ['Accessory.FaceTop'], 'Lv.12'],
  ['示範玩家 09', 'main', '', 'CA', ['MasterBeast.'], 'Lv.11'],
  ['示範玩家 01', 'alt', '第二隻', 'CA', ['Right.Ice.SetEffect.', 'Pet.'], 'Lv.11'],
];

await rm(out, { recursive: true, force: true });
let day = 0;
const characters = ['星塵旅人', '夜雨', 'Aster', '白羽', '霜月', 'Kairo', '小橘子', '黎明之歌', '墨染', '夜雨二號'];
for (const [index, [player, slot, label, Job, drop, enhancement]] of variants.entries()) {
  const values = Object.fromEntries(Object.entries(example.values).filter(([field]) => !drop.some(prefix => field.startsWith(prefix))));
  values['Weapon.ENHC'] = enhancement;
  const { json } = serializeLoadout({ ...example, Job, values }, gameData);
  const ownerKey = (BigInt(player.replace(/\D/g, '')) * 0x9e3779b97f4a7c15n % 2n ** 64n).toString(16).padStart(16, '0');
  const entry = createEntry({ ownerKey, ownerName: `demo_user${player.replace(/\D/g, '')}`, character: characters[index], slot, label, loadout: JSON.parse(json),
    now: new Date(Date.UTC(2026, 10, 16 - (day += index % 3), 12 - index, 5 * index)) });
  const dir = join(out, ownerKey);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `Dash_${slot}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}
console.log(`已在 ${out} 產生 ${variants.length} 份示範檔。`);
