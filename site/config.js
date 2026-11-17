// 部署前改這裡。apiBase 留空時網站仍可瀏覽，只是登入與上傳會停用。
export const CONFIG = {
  // Cloudflare Worker 的網址，結尾不要斜線，例如 https://loadout-dashboard-api.yourname.workers.dev
  apiBase: '',
  calculatorUrl: 'https://as930010.github.io/damage-calculator/',

  // 佈景：'auto' 跟隨系統；用深色背景圖時建議固定 'dark'。
  theme: 'dark',
  art: {
    // 整頁背景圖（固定不捲動、等比例填滿）。留空就是純色背景。
    // 預設是程式產生的動態場景（scripts/make-scene.mjs）；另有靜態的 './art/background.svg' 可換。
    background: './art/scene.svg',
    // 背景上蓋一層頁面底色的濃度（0–1）。圖越花、數字越要大，文字才看得清楚。
    backgroundDim: 0.3,
    // 頁首右側的插圖（寬螢幕才顯示）。留空不顯示。
    hero: '',
    // 各職業在明細面板的插圖：{ 職業代碼: 圖片路徑 }，沒設定的職業顯示代碼字樣。
    // 例：classes: { DaB: './art/classes/DaB.webp', CU: './art/classes/CU.webp' }
    classes: {},
    // 各職業的小圖示（列表列首與明細標頭的方形圖）。沒設定時改用上面 classes 的圖，再沒有就顯示代碼字樣。
    // 例：classIcons: { DaB: './art/icons/DaB.png', CU: './art/icons/CU.png' }
    classIcons: {},
  },
};
