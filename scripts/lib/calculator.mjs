// 對配裝模擬器（damage-calculator）內部模組的依賴全部集中在這裡：解碼匯出檔、計算數值。
// build-index（產生排行資料）與 check-with-calculator（PR 檢查）共用，兩邊的判定才會一致。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 載入已建置的計算機（需先在該目錄執行 pnpm install && pnpm run build）。 */
export async function loadCalculator(calculator) {
  const calculatorModule = path => import(pathToFileURL(resolve(calculator, 'dist', path)).href);
  const gameData = JSON.parse(await readFile(resolve(calculator, 'dist/data/game-data.json'), 'utf8'));
  const { parseLoadoutJson } = await calculatorModule('frontend/loadout-transfer.js');
  const { evaluateLoadout } = await calculatorModule('frontend/projection.js');

  const classes = new Map(gameData.classes.classes.map(item => [item.id, item]));
  const firstClass = gameData.classes.classes.find(item => item.active);
  const blankState = () => ({
    schemaVersion: 3, Job: firstClass.id, values: {}, lowerwearAlternativeEnabled: false,
    masterBeastSpiritStoneColor: gameData.masterBeast.spiritStoneColorSelector.defaultColor,
    petSkillAttackEnabled: true, nutProtectionPotionEnabled: false, nephronRaidEnabled: false,
    transcendenceSkillDamageSharePct: 100,
  });

  const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  const text = value => (value === undefined || value === null || value === '' ? null : String(value));

  /** 依計算機的裝備版面整理成「群組 → 部位：裝備」；共用同一個選項的部位（左冰套裝）只列一次。 */
  function gearOf(values) {
    const groups = [];
    for (const group of gameData.layout.groups) {
      const seen = new Set();
      const items = [];
      for (const slot of gameData.layout.slots.filter(item => item.group === group.id && item.selectionField)) {
        const item = text(values[slot.selectionField]);
        if (!item || seen.has(slot.selectionField)) continue;
        seen.add(slot.selectionField);
        items.push({ slot: slot.sharedSelection ? '套裝' : slot.label, item });
      }
      if (items.length) groups.push({ id: group.id, name: group.name, items });
    }
    const weapon = [['強化', values['Weapon.ENHC']], ['成長', values['Weapon.Growth']]]
      .filter(([, value]) => text(value)).map(([slot, value]) => ({ slot, item: String(value) }));
    if (weapon.length) groups.push({ id: 'weapon', name: '武器', items: weapon });
    return groups;
  }

  function summarize(entry) {
    const result = parseLoadoutJson(JSON.stringify(entry.loadout), blankState(), gameData);
    // 職業代碼對不上時計算機會退回預設職業；這種檔案直接視為無效，不能掛錯職業上榜。
    if (result.state.Job !== entry.loadout.Job) throw new Error(`無法辨識職業：${entry.loadout.Job}`);
    const evaluation = evaluateLoadout(gameData, result.state, false, false, 0, 0);
    const damage = evaluation.damage?.result;
    if (!damage) throw new Error(evaluation.damageError?.message ?? '這份配裝無法計算。');
    const stats = {};
    for (const [key, stat] of Object.entries(damage.attributes.stats)) stats[key] = round(stat.finalTotal);
    const values = result.state.values;
    // 致命一擊與極大化有遞減：raw 是計算機的「角色屬性合計」（黃字總和，不含職業被動的遞減來源），actual 是套用遞減、關卡懲罰與上限後副本內的實際機率。
    const rate = item => item ? { actual: round(item.finalRate * 100), raw: round(item.baseRawStatPct) } : null;
    const spiritRecord = [1, 2, 3, 4, 5, 6].map(n => text(values[`SpiritRecord.Class.${n}`])).filter(Boolean);
    return {
      job: result.state.Job,
      attackType: damage.attack.attackType,
      damage: Math.round(damage.finalDamage.finalDamage),
      attackPower: Math.round(damage.attack.attackPower),
      stats,
      stage: { adapt: values['Stage.Adapt'] ?? null, critRatePenalty: values['Stage.CritRatePenalty'] ?? null, bossDefense: values['Stage.BossDEF'] ?? null },
      rates: { critRatePct: rate(damage.combatRates?.critRate), extremizationPct: rate(damage.combatRates?.extremization) },
      spiritRecord,
      beastStoneColor: result.state.masterBeastSpiritStoneColor || null,
      title: text(values['Effect.Title']),
      gear: gearOf(values),
      // 匯入時被計算機清掉的欄位數（通常代表檔案比目前的遊戲資料舊）。
      clearedFields: result.clearedFields.length,
    };
  }

  return { gameData, classes, summarize };
}
