// PR 閘門：只允許「一個 PR 動一個 data/loadouts/<owner>/Dash_<slot>.json」。
// 由 base 分支的版本執行，PR 內容只透過 git 當資料讀取，不會執行 PR 帶來的任何程式。
//   HEAD_REF=<PR 分支名> SAME_REPO=<true|false> node scripts/validate-submission.mjs <base-sha> <head-sha>
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ENTRY_PATH_PATTERN, LIMITS, validateEntry } from '../site/lib/dash-format.js';

const [base, head] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) {
  console.error('用法：validate-submission.mjs <base-sha> <head-sha>');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const MAX_ENTRY_BYTES = LIMITS.maxBytes + 4096; // 信封與縮排的額外空間

function check() {
  // 三點差異 = 這個 PR 自己帶來的變更；--no-renames 讓搬移顯示成一刪一增。
  const changes = git('diff', '--name-status', '--no-renames', '-z', `${base}...${head}`).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < changes.length; i += 2) files.push({ status: changes[i], path: changes[i + 1] });
  if (files.length !== 1) return [`一個 PR 只能變更 1 個檔案，這個 PR 變更了 ${files.length} 個。`];

  const [{ status, path }] = files;
  const match = ENTRY_PATH_PATTERN.exec(path);
  if (!match) return [`檔案路徑不符：${path}（必須是 data/loadouts/<owner>/Dash_<slot>.json）`];

  // 檔案格式合法不代表送件人就是擁有者。能證明身分的只有 Worker（它驗過 Discord 登入），
  // 而 Worker 一定用本 repo 的 dash/<owner>/<slot> 分支；其他來源（fork、別的分支名）一律不受理，
  // 否則任何人都能開一個「格式正確」的 PR 去覆蓋或刪除別人的配裝。
  const expectedRef = `dash/${match[1]}/${match[2]}`;
  if (process.env.SAME_REPO !== 'true') return ['資料只接受透過網站上傳；來自 fork 的 PR 不受理。'];
  if (process.env.HEAD_REF !== expectedRef) return [`分支必須是 ${expectedRef}（由上傳服務建立），目前是 ${String(process.env.HEAD_REF).slice(0, 80)}。`];
  if (status === 'D') return [];
  if (status !== 'A' && status !== 'M') return [`不支援的變更類型：${status}`];

  const mode = git('ls-tree', head, '--', path).split(/\s+/)[0];
  if (mode !== '100644') return ['檔案必須是一般檔案（不可為連結或可執行檔）。'];
  const size = Number(git('cat-file', '-s', `${head}:${path}`).trim());
  if (size > MAX_ENTRY_BYTES) return [`檔案 ${size} bytes，超過上限 ${MAX_ENTRY_BYTES}。`];

  let entry;
  try { entry = JSON.parse(git('show', `${head}:${path}`)); } catch { return ['檔案不是有效的 JSON。']; }
  const errors = validateEntry(entry, path);

  const siblings = git('ls-tree', '--name-only', head, '--', `data/loadouts/${match[1]}/`).split('\n').filter(Boolean);
  if (siblings.length > LIMITS.maxSlotsPerOwner) errors.push(`每位玩家最多 ${LIMITS.maxSlotsPerOwner} 份配裝，合併後會有 ${siblings.length} 份。`);
  return errors;
}

const errors = check();
const summary = errors.length
  ? `### ❌ Dash_ 檔案未通過檢查\n\n${errors.map(error => `- ${error}`).join('\n')}\n`
  : '### ✅ Dash_ 檔案通過檢查\n';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
// 第一個錯誤交給 report job 留言給玩家（單行純文字）。
if (process.env.GITHUB_OUTPUT && errors.length) appendFileSync(process.env.GITHUB_OUTPUT, `reason=${errors[0].replace(/[\r\n`<>]/g, ' ').slice(0, 200)}\n`);
process.exit(errors.length ? 1 : 0);
