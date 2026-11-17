# 資安自檢

這個資料夾是可重跑的攻擊測試。全部在本機進行，不會碰到真的 Discord 或 GitHub。

## 怎麼跑

```sh
# 1. 假的 Discord + GitHub
node security/mock-upstream.mjs 8799 &

# 2. 沙盒密鑰（任意值即可；私鑰用臨時產生的）
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/sandbox.pem
{ echo 'DISCORD_CLIENT_SECRET=sandbox'; echo 'SESSION_SECRET=sandbox-session'; echo 'OWNER_KEY_SECRET=sandbox-owner';
  printf 'GITHUB_APP_PRIVATE_KEY="%s"\n' "$(awk '{printf "%s\\n", $0}' /tmp/sandbox.pem)"; } > security/.dev.vars

# 3. 用真的 Workers 執行環境（workerd）在本機跑 Worker
(cd worker && npm install)
(cd security && npx --prefix ../worker wrangler dev -c wrangler.sandbox.toml --port 8787 --ip 127.0.0.1) &

# 4. 攻擊
node security/attack.mjs             # Worker：身分、來源、檔名、惡意內容、注入、速率與配額（34 項）
node security/validator-attack.mjs   # PR 閘門：冒名、夾帶檔案、連結、超大檔等（15 項）
python3 security/frontend-xss.py     # 前端：index.json 每個字串都換成 XSS 載荷
```

`attack.mjs` 的登入次數測試會把同一個 IP 的登入額度用完，重跑前請重啟 wrangler dev（並刪掉 `security/.wrangler`）。

## 2026-11-17 自檢結果

第一輪（修補前）打穿 7 項，全部已修，第二輪全數擋下。

| # | 問題 | 嚴重度 | 修法 |
|---|---|---|---|
| 1 | **任何人都能開「格式合法」的 PR 覆蓋或刪除別人的配裝**。閘門只檢查格式，沒檢查送件人；人工審核時看到綠勾很容易就合併。 | 高 | 閘門只受理本 repo 的 `dash/<owner>/<slot>` 分支，且分支名必須與檔案路徑一致；fork 的 PR 一律不受理。 |
| 2 | **速率限制可被並發繞過**。KV 是「先讀再寫」，30 個並發請求有 2 個以上通過冷卻；正式環境的 KV 還有最長約 60 秒的同步延遲，會更嚴重。配額檢查同理。 | 高 | 改用 Durable Object 做原子計數。重測：30 個並發只過 1 個，30 個不同檔名只建立 1 個分支。 |
| 3 | 自動合併與「必要檢查」互相卡住：合併動作寫在 validate 這個 job 裡，一旦把 validate 設成 main 的必要檢查，合併時它還沒結束。 | 中 | 拆成 `validate`（唯讀）與 `merge`（寫入）兩個 job。 |
| 4 | 角色名、備註、Discord 名稱可夾帶雙向控制字元／零寬字元，讓顯示出來的名字跟實際不同（冒充他人）。 | 中 | `cleanText` 會移除，格式驗證也直接拒絕。 |
| 5 | PR 標題含玩家自填的角色名，可塞 `@mention` 或連結語法騷擾維護者。 | 低 | 標題只放檔名、owner key、職業代碼。 |
| 6 | 部署流程在擁有 Pages 發布權限的 job 裡執行第三方 repo（計算機）的建置程式。 | 中 | 拆成 `build`（唯讀，執行外部程式）與 `deploy`（只上傳產物）。 |
| 7 | 網站沒有內容安全政策；萬一哪天出現注入點，登入權杖可被外送。 | 中（縱深防禦） | 加上 CSP：只執行本站腳本、只連本站與 Worker、圖片只來自本站與 Discord CDN。實測行內腳本、對外 fetch、外部圖片都被擋。 |

另外補強（原本沒被打穿）：請求內容改成邊讀邊算大小，超過上限立即中斷；新增停權名單 `BLOCKED_OWNER_KEYS`；前端載入頭像前再驗一次網址格式。

## 測過且原本就擋得住的

- 權杖：無權杖、`alg=none`、竄改內容、猜密鑰自簽、過期。
- 登入：OAuth state 不符、非伺服器成員、帳號太新。
- 來源：惡意網站的 Origin、CORS 預檢。
- 檔名：路徑跳脫、斜線、空字元、大小寫、過長。
- 內容：`__proto__`、`constructor`、未知欄位、巢狀物件、`1e999`、欄位數爆量、深層巢狀、超大檔。
- 前端：把 index.json 所有字串換成 XSS 載荷後，沒有任何腳本執行或元素被注入。
- 灌水：把數值欄位逐一改成 9999 與 10 億，計算機都判定無效或不採計，沒有一個能把傷害拉高 1.5 倍以上。

## 尚未修補的風險

不放在公開 repo，由維護者另行保存。

## 沒有測到的

- 真的 Discord OAuth 與 GitHub API（只對假伺服器測）。
- 兩個 workflow 在 GitHub 上的實際執行（只驗過 YAML 結構與腳本邏輯）。
- Durable Object 在正式環境的行為（只在本機 workerd 測）。
