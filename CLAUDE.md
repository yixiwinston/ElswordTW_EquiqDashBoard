# 交接筆記：配裝 Dashboard

這份筆記給接手的開發者（或 Claude Code）讀，記錄專案現況、做過的決定與原因、還沒完成的事。
部署步驟請看 `docs/DEPLOY.md`；這裡不重複。`README.md` 是給玩家看的公開說明，不放內部或架站資訊。

最後更新：2026-11-18。專案在一般 Claude 對話中開發，**尚未在真實的 Discord、GitHub、Cloudflare 環境跑過**。

---

## 一句話說明

玩家用 Discord 登入，上傳配裝模擬器（https://as930010.github.io/damage-calculator/ ）匯出的 JSON。
Cloudflare Worker 驗證後以 GitHub App 身分開 PR，GitHub Actions 檢查並合併。
部署時用計算機本身的程式重算數值，產生 `site/data/index.json`，再發布到 GitHub Pages。

```
upload.html ──Discord 登入──► Worker（worker/src/index.js）──開 PR──► GitHub repo
                                                                      │
                validate-submission.yml：來源／格式／配額 → 計算機實算 ◄─┘
                  ├ 沒過：report job 留言原因並關閉 PR（上傳頁會顯示原因）
                  └ 通過：merge job 自動合併（需 DASH_AUTO_MERGE=true）
                                                                      │
                deploy.yml：build（唯讀，建置計算機＋build-index）→ deploy（發布 Pages）
```

## 檔案地圖

| 路徑 | 用途 |
|---|---|
| `site/index.html`, `site/app.js` | 主頁：列表（四種排序）、明細面板、背景 |
| `site/upload.html`, `site/upload.js` | 上傳頁：登入、角色名稱、選檔、「我的配裝」狀態 |
| `site/lib/common.js` | 兩頁共用：DOM 小工具 `h()`、登入權杖、呼叫 API、套用背景 |
| `site/lib/dash-format.js` | **格式規則唯一來源**。瀏覽器、Worker、Actions 都 import 這份 |
| `site/config.js` | Worker 網址 `apiBase`、背景與圖示路徑 |
| `site/art/` | 背景與插圖。`scene.svg` 由 `scripts/make-scene.mjs` 產生，不要手改 |
| `worker/src/index.js` | Discord OAuth、session、速率限制（Durable Object）、開 PR、`/api/me` |
| `worker/wrangler.toml` | Worker 設定；密鑰不放這裡，用 `wrangler secret put` |
| `scripts/validate-submission.mjs` | PR 檢查第一關 |
| `scripts/check-with-calculator.mjs` | PR 檢查第二關：用計算機實算 |
| `scripts/lib/calculator.mjs` | **對計算機內部模組的依賴全部在這裡** |
| `scripts/build-index.mjs` | `data/loadouts/**` → `site/data/index.json` |
| `scripts/make-demo-data.mjs` | 用計算機的公開範例產生 10 筆示範資料到 `demo/` |
| `data/loadouts/<owner>/Dash_<slot>.json` | 投稿資料（由 Worker 寫入，不要手動加） |
| `security/` | 可重跑的攻擊測試與自檢報告（`security/README.md`）；未修補風險在本機的 `RISKS.local.md` |
| `docs/DEPLOY.md` | 架站與開發說明（部署步驟、目錄、檔案格式、本機預覽） |
| `.github/workflows/ci*.yml` | 三層 CI（快速／Worker 攻擊／前端注入） |

## 重要決定與原因

改這些之前請先理解原因。

1. **排行數字不取自上傳檔，而是部署時重算。** 上傳的 JSON 只是配裝選擇，數值由計算機的 `evaluateLoadout` 算出，玩家改 JSON 灌不了數字。
2. **玩家上傳的檔名不限，也不被採用。** 存檔名 `Dash_<slot>.json` 的 `slot` = `c` + SHA-256(角色名稱小寫 + "\n" + 備註小寫) 前 15 碼。同一組角色名稱與備註再上傳 = 更新同一份。`Dash_` 前綴規則仍在 repo 端保留。
3. **owner key = HMAC(OWNER_KEY_SECRET, Discord 數字 ID) 前 16 碼。** 用在路徑與分支名。**`OWNER_KEY_SECRET` 設定後不要再換**，換了所有人的檔案會變成別人的。
4. **公開顯示 Discord 使用者名稱與頭像**，都在登入當下由 Worker 取得，玩家不能自填，所以無法冒名。頭像網址含 Discord 數字 ID，等同公開。頁尾與上傳頁都有說明。
5. **PR 檢查只受理本 repo 的 `dash/<owner>/<slot>` 分支，且分支名要對應檔案路徑。** 這是資安自檢發現的高風險漏洞修正：否則任何人都能開格式合法的 PR 覆蓋別人的檔案。fork 的 PR 一律拒絕。
6. **速率限制用 Durable Object，不用 KV。** KV 先讀再寫，並發請求會一起通過（自檢實測有 2 個以上穿過）。
7. **workflow 權限拆開。** 會執行第三方程式（計算機建置）的 job 只有唯讀；有寫入或發布權限的 job 不執行外部程式。
8. **退回原因只採信 `github-actions[bot]` 的留言**（以 `<!-- dash-result -->` 開頭）。PR 是公開的，任何人都能留言。
9. **所有使用者文字都只經過 `textContent`。** `h()` 不會把字串當 HTML；另有 CSP（`index.html`、`upload.html` 的 meta）。
10. **登入後導回的頁面只認固定代號**（`?return=upload` → `upload.html`），不接受網址，避免開放式重新導向。
11. **配裝模擬器作者已同意開源使用**（2026-11-18 由使用者確認）。因此 PR 檢查與部署可以 checkout 並執行計算機 repo 的程式，網站也可以顯示它解碼出的裝備名稱與數值。使用者不是計算機作者；作者若調整內部模組，`scripts/lib/calculator.mjs` 需要跟著改。

## 名詞與數值定義

- **總增幅**：使用者定義為「純面板可提供的傷害總增幅，不算角色額外 Buff／Debuff」。目前取計算機算出的理論傷害，外部破防與無視防禦加成固定為 0、不帶入 Buff 模擬器。程式在 `scripts/lib/calculator.mjs` 的 `summarize()`（`evaluateLoadout(gameData, state, false, false, 0, 0)`）。
- **致命一擊、極大化**：有非線性遞減。表上預設顯示副本內實際值（`combatRates.*.finalRate`）；點擊切換「黃字」（`baseRawStatPct`，計算機的「角色屬性合計」，不含職業被動那段遞減來源）。
- **聖獸精靈石顏色、賦靈錄**：直接取自匯出檔。

## 目前的上限與預設值

| 項目 | 值 | 在哪裡改 |
|---|---|---|
| 檔案大小 | 32 KB | `dash-format.js` `LIMITS.maxBytes` |
| 每帳號份數 | 5（審核中也算） | `LIMITS.maxSlotsPerOwner` |
| 角色名稱／備註長度 | 24／30 字 | `LIMITS.maxCharacterLength`／`maxLabelLength` |
| Discord 帳號年齡 | ≥ 30 天 | `wrangler.toml` `MIN_ACCOUNT_AGE_DAYS` |
| 送出頻率 | 每人 60 秒 1 次、每日 10 次；全站每日 300 次 | `DAILY_LIMIT_PER_USER`／`DAILY_LIMIT_GLOBAL`；冷卻寫在 `throttle()` |
| 登入頻率 | 每 IP 每小時 30 次 | `login()` |
| 下架舊資料 | 180 天未更新不列出 | Actions 變數 `ENTRY_MAX_AGE_DAYS` |
| 停權 | 逗號分隔的 owner key | `wrangler.toml` `BLOCKED_OWNER_KEYS` |

## 還沒完成／待決定

依重要性排序。

1. **【待使用者決定】匯出檔自帶的開關要不要算進總增幅**：`nutProtectionPotionEnabled`（藥水）、`nephronRaidEnabled`（襲擊戰）、`petSkillAttackEnabled`（寵物技能）。目前照檔案內容計算；若算 Buff，要在 `summarize()` 解碼後強制關掉。
2. **真實環境驗證**：Discord OAuth、GitHub App、兩個 workflow（特別是 `report` job 的留言與關閉）、Durable Object 都只在本機模擬過。部署後照 `docs/DEPLOY.md`「上線前自己走一遍」測。
3. **上傳前預覽**：選檔後看不到上榜後的樣子。做法是把計算機的解碼模組打包進網站，前端直接呈現完整面板（作者已同意開源使用）。
4. **職業圖示**：`site/art/icons/` 是空的。放圖後在 `config.js` 的 `art.classIcons` 逐一對應（代碼大小寫有別，如 `DaB`、`CU`）。只能用有權使用的素材。
5. **CI**：已接進 Actions，分三層（皆唯讀、略過只改 `data/loadouts/` 的投稿 PR）：`ci.yml` 每次都跑單元測試＋PR 閘門攻擊；`ci-worker.yml` 改到 Worker／`site/lib`／`security` 才跑 Worker 攻擊（mock＋wrangler dev）；`ci-frontend.yml` 改到 `site/` 等才建計算機並跑前端注入測試。尚未設定 branch protection 把它們設為必要檢查。
6. **管理工具**：下架某筆只能手動刪 `data/loadouts/` 的檔案（走 PR）。
7. **部署失敗沒有通知**：每日排程重建若因計算機更新而壞掉，不會有人知道。建議把 `CALCULATOR_REF` 固定到確認過的 commit。
8. **其他已知風險**：詳見本機的 `security/RISKS.local.md`（`*.local.md` 已 gitignore，不會提交；新 clone 不會有這份，需向維護者取得）。repo 是公開的，**尚未修補的漏洞細節不要寫進任何會提交的檔案**。
9. 缺 LICENSE 與正式的隱私／資料移除說明。（計算機作者與出處已標示在 `index.html`、`upload.html` 頁尾。）

## 常用指令

```sh
npm test                               # Worker 單元測試（Discord／GitHub 為假回應）

# 本機預覽（需先 clone 並建置計算機）
git clone https://github.com/as930010/damage-calculator ../damage-calculator
(cd ../damage-calculator && pnpm install --frozen-lockfile && pnpm run build)
npm run demo                           # 產生 demo/ 示範資料與 site/data/index.json
npm run preview                        # http://localhost:8080

node scripts/make-scene.mjs            # 重新產生背景 site/art/scene.svg

# 資安攻擊測試：步驟見 security/README.md
node security/attack.mjs               # Worker（35 項）
node security/validator-attack.mjs     # PR 閘門（16 項）
python3 security/frontend-xss.py       # 前端注入
```

上次執行結果：單元測試 3/3 通過；攻擊測試全部擋下。

## 修改時要注意

- **改格式規則只改 `site/lib/dash-format.js`**，三個執行環境會一起生效。計算機若在匯出檔新增頂層欄位，要加進 `LOADOUT_KEYS` 白名單，否則新檔會被擋。
- **計算機更新導致解碼或計算失敗**時，只需改 `scripts/lib/calculator.mjs`。
- **改 Worker 的 API 形狀**時，同步更新 `worker/test/worker.test.mjs`、`security/mock-upstream.mjs`、`security/attack.mjs`。
- **改 workflow**時保持權限拆分：執行外部程式的 job 不可有寫入權限；檢查腳本必須取自 base 分支，PR 內容只當資料讀（不要改用 `pull_request_target` 執行 PR 程式）。
- **Worker 改用自訂網域**時，更新 `index.html` 與 `upload.html` 的 CSP `connect-src`。
- 前端不要用 `innerHTML` 插入任何資料。
- 不要提交：`security/.dev.vars`、`*.pem`、`*.local.md`、`node_modules/`、`.wrangler/`、`site/data/index.json`（已在 `.gitignore`）。

## 使用者偏好

- 介面與說明一律用繁體中文。
- 主要使用環境是 PC 1920×1080，也要能在手機上用。
- 背景：預設用程式產生的月夜稻草人場景（青色滿月約佔寬度 0.6、有立體感；稻草人居中且有輪廓細節；雲 3～4 叢由左至右；草隨風擺；鳥偶爾停在手上；螢火蟲）。
- 不使用遊戲官方影片或立繪做 AI 重製。
