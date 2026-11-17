# 部署與開發說明

這份文件給架站者與開發者。玩家使用說明請看 [README](../README.md)。

## 架構

```
瀏覽器（GitHub Pages 靜態站）
  │ ① 用 Discord 登入                ② 上傳 Dash_x.json
  ▼                                   ▼
Cloudflare Worker ── 驗身分／伺服器成員／帳號年齡／速率限制／格式 ──► GitHub App 開 PR
                                                                        │
                    validate-submission.yml：來源、單一檔案、格式、配額，再用計算機實算一次 ◄─┘
                    （沒過 → 留言原因並關閉 PR，網站的「我的配裝」會顯示）
                                                                        │ 合併（人工或自動）
                    deploy.yml：用計算機引擎解碼＋算數值 → site/data/index.json → Pages
```

## 目錄

| 路徑 | 用途 |
|---|---|
| `site/` | 靜態網站：`index.html` 是列表與明細，`upload.html` 是登入後的上傳與管理頁。`config.js` 設定 Worker 網址。 |
| `site/lib/dash-format.js` | 檔案格式與上限。瀏覽器、Worker、Actions 共用，**規則只改這裡**。 |
| `worker/` | Cloudflare Worker：Discord OAuth、工作階段、速率限制、開 PR。 |
| `scripts/validate-submission.mjs` | PR 檢查第一關：來源、路徑、格式、配額。 |
| `scripts/check-with-calculator.mjs` | PR 檢查第二關：用計算機實算，算不出來就退回並附原因。 |
| `scripts/lib/calculator.mjs` | 對計算機內部模組的依賴集中在這裡。 |
| `scripts/build-index.mjs` | 把 `data/loadouts` 解碼成 `site/data/index.json`。 |
| `data/loadouts/<owner>/Dash_<slot>.json` | 投稿資料。`<owner>` 是 Discord 數字 ID 的 HMAC。 |

## 檔案格式

玩家上傳的就是計算機匯出的原檔（`format: "damage-calculator-loadout"`, `formatVersion: 3`），**檔名不限**，大小 32 KB 以內。
Worker 會包一層信封，並以 `Dash_<slot>.json` 的名稱寫進 repo；`<slot>` 是「角色名稱＋備註」的雜湊，
所以同一個角色名稱與備註再上傳就是更新同一份，玩家給的檔名不會被採用：

```json
{ "format": "dash-entry", "formatVersion": 1,
  "owner": { "key": "16 位十六進位", "name": "Discord 使用者名稱", "avatar": "Discord CDN 頭像網址或空字串" },
  "character": "遊戲內 ID", "slot": "c 加 15 位十六進位", "label": "備註", "submittedAt": "2026-11-17T01:00:00.000Z",
  "loadout": { "...計算機匯出內容原封不動..." } }
```

計算機日後在匯出檔新增頂層欄位時，要把欄位名加進 `dash-format.js` 的 `LOADOUT_KEYS`，否則新檔會被擋（刻意採白名單）。

## 可調整的上限

檔案大小、每帳號份數、送出頻率、帳號年齡、下架天數等預設值與修改位置，見 [CLAUDE.md](../CLAUDE.md) 的「目前的上限與預設值」。

## 部署步驟

前置：一個 GitHub 帳號、一個 Cloudflare 帳號（免費方案即可）、一個 Discord 帳號，本機有 Node.js 24 與 git。

### 1. 建立 GitHub repo

1. 建一個**公開** repo（例如 `loadout-dashboard`），把這個專案推上 `main`。
2. Settings → Pages → Source 選 **GitHub Actions**。
3. 記下網站網址：`https://<帳號>.github.io/<repo>/`（結尾有斜線）。

### 2. 建立 GitHub App（讓 Worker 能開 PR）

1. 個人 Settings → Developer settings → GitHub Apps → New GitHub App。
2. Webhook 取消勾選 Active。Repository permissions 只開 **Contents: Read and write**、**Pull requests: Read and write**；不要給 Workflows。
3. 建立後記下 **App ID**，按 Generate a private key 下載 `.pem`。
4. Install App → 只安裝到這個 repo。安裝頁網址最後那串數字就是 **Installation ID**。
5. 把私鑰轉成 PKCS#8：`openssl pkcs8 -topk8 -nocrypt -in 下載的.pem -out app.pkcs8.pem`

### 3. 建立 Discord 應用程式

1. https://discord.com/developers/applications → New Application。
2. OAuth2 頁記下 **Client ID** 與 **Client Secret**。Redirects 先留著，等第 4 步拿到 Worker 網址再填。
3. 要限定伺服器的話，在 Discord 開啟開發者模式，對伺服器按右鍵複製 **伺服器 ID**（強烈建議限定）。

### 4. 部署 Worker

```sh
cd worker
npm install
npx wrangler login
```

編輯 `wrangler.toml` 的 `[vars]`：`SITE_URL`（第 1 步的網址）、`GITHUB_REPO`（`帳號/repo`）、`GITHUB_APP_ID`、
`GITHUB_INSTALLATION_ID`、`DISCORD_CLIENT_ID`、`DISCORD_GUILD_ID`。然後設定密鑰並部署：

```sh
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET            # 貼上 openssl rand -hex 32 的結果
npx wrangler secret put OWNER_KEY_SECRET          # 同上，另外產生一組；設定後不要再換
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ../app.pkcs8.pem
npx wrangler deploy
```

部署完成會印出 Worker 網址（`https://loadout-dashboard-api.<子網域>.workers.dev`）。
回到 Discord 應用程式的 OAuth2 → Redirects，加上 `<Worker 網址>/auth/callback`。
部署成功後刪掉本機的兩個 `.pem` 檔。

### 5. 把網站接上 Worker

1. `site/config.js`：`apiBase` 填 Worker 網址（結尾不要斜線）。
2. Worker 若使用自訂網域：把 `site/index.html` 與 `site/upload.html` 裡 CSP 的 `https://*.workers.dev` 換成該網域。
3. 推上 `main`，等 Actions 的「Build index and deploy Pages」跑完。

### 6. Repo 設定

1. Settings → Secrets and variables → Actions → Variables：
   - `CALCULATOR_REF`：配裝模擬器某個確認過的 commit SHA（建議設定，不要長期追 `main`）。
   - `DASH_AUTO_MERGE`：設成 `true` 就自動合併通過檢查的投稿；不設就是每筆由你手動合併。
2. Settings → Branches → 保護 `main`：要求走 PR、把 `validate` 設為必要檢查。開自動合併時不要另外要求人工核准。

### 7. 上線前自己走一遍

1. 開網站 → 右上「上傳我的配裝」→ 用 Discord 登入，應該回到上傳頁並顯示你的名稱與頭像。
2. 填角色名稱、選一個配裝模擬器匯出的 JSON、送出。repo 應該出現一個 `dash/...` 分支的 PR，`validate` 會自動跑。
3. 合併（或等自動合併）後幾分鐘，主頁出現這筆配裝；上傳頁的「我的配裝」顯示「已上榜」。
4. 故意上傳一個不是匯出檔的 JSON，確認在網頁上就被擋下。
5. 之後要停權某個帳號：把它的 owner key（`data/loadouts/` 下的資料夾名）加進 `wrangler.toml` 的 `BLOCKED_OWNER_KEYS` 再 `npx wrangler deploy`。

## 背景圖與插圖

`site/config.js` 的 `art` 區塊：`background`（整頁背景）、`backgroundDim`（遮罩濃度）、`hero`（頁首插圖）、
`classes`（各職業在明細面板的插圖，以職業代碼對應）。把圖放進 `site/art/` 後改路徑即可；內附的兩張 SVG 只是佔位。

| 用途 | 建議放置路徑 | `config.js` 欄位 | 建議規格 |
|---|---|---|---|
| 整頁背景 | `site/art/background.webp` | `art.background` | 1920×1080 以上，橫式 |
| 預設動態場景 | `site/art/scene.svg`（由 `node scripts/make-scene.mjs` 產生） | `art.background` | 月夜稻草人，純向量與 CSS 動畫；開啟「減少動態效果」的裝置會靜止 |
| 頁首插圖 | `site/art/hero.png` | `art.hero` | 去背，顯示高度 150px |
| 職業圖示 | `site/art/icons/<職業代碼>.png` | `art.classIcons` | 正方形，至少 176×176 |

檔名與路徑沒有強制規定，網站只認 `config.js` 裡寫的路徑（相對於 `site/`）；職業代碼要跟計算機一致（如 `DaB`、`CU`），大小寫有別。

寬度 1200px 以上（含 1920×1080）會變成左排行、右明細的雙欄版面。請只使用你有權使用的圖片。

## 本機預覽

```sh
git clone https://github.com/as930010/damage-calculator ../damage-calculator
(cd ../damage-calculator && pnpm install --frozen-lockfile && pnpm run build)
npm run demo      # 用計算機的公開範例產生 10 份示範投稿與 index.json
npm run preview   # http://localhost:8080
npm test          # Worker 流程測試（Discord／GitHub 以假回應代替）
```

## 資安自檢

`security/` 內有可重跑的攻擊測試與完整結果，見 [security/README.md](../security/README.md)。

## 技術限制

- 工作階段是 24 小時的簽章權杖，無法單獨撤銷；要全部失效就更換 `SESSION_SECRET`。
- **依賴計算機程式**：PR 檢查與部署都會 checkout 並執行計算機 repo 的程式，網站也會顯示由它解碼出的裝備名稱與算出的數值（已獲計算機作者同意開源使用）。作者若調整內部模組，`scripts/lib/calculator.mjs` 需要跟著改。
