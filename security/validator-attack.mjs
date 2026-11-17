// 對 PR 閘門（scripts/validate-submission.mjs）的攻擊：在暫存 git repo 裡做出各種惡意 PR，確認都被拒絕。
//   node security/validator-attack.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEntry } from '../site/lib/dash-format.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = mkdtempSync(join(tmpdir(), 'dash-validator-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
cpSync(join(root, 'site'), join(repo, 'site'), { recursive: true });
cpSync(join(root, 'scripts'), join(repo, 'scripts'), { recursive: true });
mkdirSync(join(repo, '.github/workflows'), { recursive: true });
writeFileSync(join(repo, '.github/workflows/deploy.yml'), 'name: x\n');

const loadout = JSON.parse(readFileSync(join(root, 'worker/test/fixtures/Dash_main.json'), 'utf8'));
const victim = 'aaaaaaaaaaaaaaaa';
const attacker = 'bbbbbbbbbbbbbbbb';
const entry = (key, slot, extra = {}) => `${JSON.stringify({ ...createEntry({ ownerKey: key, ownerName: 'user', character: '角色', slot, label: '', loadout }), ...extra }, null, 2)}\n`;
const put = (path, content) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };

git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
put(`data/loadouts/${victim}/Dash_main.json`, entry(victim, 'main'));
git('add', '-A'); git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');

let holes = 0;
/** 在新分支上套用變更，跑閘門；expectPass 為 false 時閘門必須拒絕。 */
function attempt(name, branch, change, { expectPass = false, sameRepo = true } = {}) {
  git('checkout', '-q', '-B', branch, base);
  change();
  git('add', '-A'); git('commit', '-qm', name);
  const run = spawnSync('node', ['scripts/validate-submission.mjs', base, git('rev-parse', 'HEAD')], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HEAD_REF: branch, SAME_REPO: String(sameRepo), GITHUB_STEP_SUMMARY: '' },
  });
  const passed = run.status === 0;
  const ok = passed === expectPass;
  if (!ok) holes += 1;
  const reason = run.stdout.split('\n').find(line => line.startsWith('- '))?.slice(2) ?? '';
  console.log(`${ok ? (expectPass ? '放行' : '擋下') : '【漏洞】'} ${name}${reason ? ` — ${reason}` : ''}`);
}

attempt('V0 正常投稿（Worker 開的分支）', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main')), { expectPass: true });
attempt('V1 從 fork 覆蓋別人的配裝（格式完全合法）', 'patch-1', () => put(`data/loadouts/${victim}/Dash_main.json`, entry(victim, 'main', { character: '被冒名' })), { sameRepo: false });
attempt('V2 用自己的分支名去改別人的檔案', `dash/${attacker}/main`, () => put(`data/loadouts/${victim}/Dash_main.json`, entry(victim, 'main', { character: '被冒名' })));
attempt('V3 從 fork 刪除別人的配裝', 'patch-2', () => rmSync(join(repo, `data/loadouts/${victim}/Dash_main.json`)), { sameRepo: false });
attempt('V4 夾帶修改 workflow', `dash/${attacker}/main`, () => { put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main')); put('.github/workflows/deploy.yml', 'name: pwned\n'); });
attempt('V5 夾帶修改網站程式', `dash/${attacker}/main`, () => { put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main')); put('site/app.js', 'alert(1)'); });
attempt('V6 用符號連結指向別的檔案', `dash/${attacker}/main`, () => { mkdirSync(join(repo, `data/loadouts/${attacker}`), { recursive: true }); symlinkSync('../../../site/config.js', join(repo, `data/loadouts/${attacker}/Dash_main.json`)); });
attempt('V7 1 MB 檔案', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { label: 'x'.repeat(1024 * 1024) })));
attempt('V8 頭像改成 javascript: 網址', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { owner: { key: attacker, name: 'user', avatar: 'javascript:alert(1)' } })));
attempt('V9 頭像改成任意外部網址（追蹤像素）', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { owner: { key: attacker, name: 'user', avatar: 'https://evil.example/t.png?size=128' } })));
attempt('V10 名稱夾帶 HTML', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { character: '<img src=x onerror=alert(1)>' })));
attempt('V11 名稱夾帶雙向控制字元', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { character: 'abc‮def' })));
attempt('V12 檔名不是 Dash_ 開頭', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/evil.json`, entry(attacker, 'main')));
attempt('V13 放到 data/loadouts 以外', `dash/${attacker}/main`, () => put('site/data/Dash_main.json', entry(attacker, 'main')));
attempt('V14 檔案內 owner 與路徑不一致', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(victim, 'main')));
attempt('V15 信封多塞欄位', `dash/${attacker}/main`, () => put(`data/loadouts/${attacker}/Dash_main.json`, entry(attacker, 'main', { html: '<script>' })));

rmSync(repo, { recursive: true, force: true });
console.log(`\n打穿 ${holes} 項`);
process.exitCode = holes ? 1 : 0;
