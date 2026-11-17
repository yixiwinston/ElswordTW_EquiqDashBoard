// PR 檢查的第二關：用配裝模擬器實際解碼並計算這份檔案。算不出來的檔案在這裡就退回並說明原因，
// 不會等到合併後才在部署時被無聲略過。只把 PR 的檔案當資料讀（git show），不執行 PR 的任何程式。
//   node scripts/check-with-calculator.mjs --calculator <已建置的計算機目錄> <base-sha> <head-sha>
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ENTRY_PATH_PATTERN } from '../site/lib/dash-format.js';
import { loadCalculator } from './lib/calculator.mjs';

const args = process.argv.slice(2);
const calculator = args[args.indexOf('--calculator') + 1];
const [base, head] = args.filter((arg, i) => /^[0-9a-f]{40}$/.test(arg) && args[i - 1] !== '--calculator');
if (!calculator || !base || !head) { console.error('用法：check-with-calculator.mjs --calculator <目錄> <base-sha> <head-sha>'); process.exit(2); }
const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

/** 把結果交給後續的 report job（GITHUB_OUTPUT）與工作摘要。原因只留一行純文字。 */
function finish(reason) {
  const line = reason ? String(reason).replace(/[\r\n`<>]/g, ' ').slice(0, 200) : '';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reason=${line}\n`);
  const summary = line ? `### ❌ 計算機無法採用這份配裝\n\n- ${line}\n` : '### ✅ 計算機可以計算這份配裝\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exit(line ? 1 : 0);
}

const changes = git('diff', '--name-status', '--no-renames', '-z', `${base}...${head}`).split('\0').filter(Boolean);
const [status, path] = changes;
// 格式與路徑由 validate-submission 把關；刪除不需要計算。
if (changes.length !== 2 || !ENTRY_PATH_PATTERN.test(path)) finish('檔案路徑不符。');
if (status === 'D') finish('');

try {
  const { summarize } = await loadCalculator(calculator);
  const summary = summarize(JSON.parse(git('show', `${head}:${path}`)));
  if (!(Number.isFinite(summary.damage) && summary.damage > 0)) finish('計算結果不是有效數值。');
  finish('');
} catch (error) {
  finish(error?.message ?? '這份配裝無法計算。');
}
