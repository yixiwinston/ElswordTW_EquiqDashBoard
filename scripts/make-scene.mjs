// 產生預設的動態背景 site/art/scene.svg：青色滿月、稻草人、飄過的雲、隨風擺動的草、停在手上的鳥、螢火蟲。
// 全部是程式畫的向量圖與 CSS 動畫，沒有腳本，也不使用任何外部素材。想調整就改下面的數字後重跑：
//   node scripts/make-scene.mjs
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../site/art/scene.svg');
// 固定種子的亂數，每次產生的畫面都一樣。
let seed = 20261117;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (min, max) => min + random() * (max - min);
const n = value => Number(value.toFixed(1));

const W = 1920, H = 1080, GROUND = 905, CX = 960;
const groundY = x => GROUND + 26 * Math.sin((x / W) * Math.PI * 1.3 + 0.4) - 18 * Math.cos((x / W) * Math.PI * 3.1);

// ---- 月亮：直徑約為畫面寬度的 0.6（鏡頭拉遠後月亮仍然巨大），不動 ----
const moon = { x: CX, y: 520, r: W * 0.3 };
// 坑洞：位置與大小以月球半徑為單位。每個坑由「暗面、亮底、受光的邊緣」三層疊出凹陷感（光從左上來）。
const craters = [[-0.36, -0.44, 0.16], [0.26, -0.18, 0.23], [-0.56, 0.12, 0.12], [0.44, 0.38, 0.18], [-0.12, 0.5, 0.1], [0.09, -0.62, 0.09], [0.62, -0.35, 0.08], [-0.74, -0.2, 0.065], [-0.26, 0.06, 0.055], [0.7, 0.09, 0.06], [0.18, 0.7, 0.07], [-0.5, 0.56, 0.085], [-0.05, -0.28, 0.04], [0.5, -0.62, 0.05]]
  .map(([dx, dy, size]) => {
    const r = size * moon.r;
    // 越靠近邊緣的坑越扁，貼在球面上的感覺。
    const squash = Math.sqrt(Math.max(0.25, 1 - (dx * dx + dy * dy)));
    const angle = n(Math.atan2(dy, dx) * 180 / Math.PI);
    return `<g transform="translate(${n(moon.x + dx * moon.r)} ${n(moon.y + dy * moon.r)}) rotate(${angle}) scale(${n(squash)} 1) rotate(${-angle})"><circle r="${n(r)}" fill="#1f7f86" opacity=".42"/><circle cx="${n(r * 0.1)}" cy="${n(r * 0.12)}" r="${n(r * 0.84)}" fill="#7fe6e1" opacity=".3"/><path d="M${n(-r * 0.95)} ${n(r * 0.3)}A${n(r)} ${n(r)} 0 0 1 ${n(r * 0.3)} ${n(-r * 0.95)}" fill="none" stroke="#0f5f68" stroke-opacity=".45" stroke-width="${n(Math.max(2, r * 0.09))}" stroke-linecap="round"/><path d="M${n(r * 0.95)} ${n(-r * 0.3)}A${n(r)} ${n(r)} 0 0 1 ${n(-r * 0.3)} ${n(r * 0.95)}" fill="none" stroke="#e2fffb" stroke-opacity=".5" stroke-width="${n(Math.max(1.5, r * 0.06))}" stroke-linecap="round"/></g>`;
  }).join('');

// ---- 雲：3～4 叢，大小不等，由左往右 12～20 秒穿過畫面 ----
const cloud = (scale) => {
  const puffs = [[0, 0, 150, 46], [-110, 14, 100, 34], [120, 12, 110, 36], [-40, -30, 90, 40], [60, -24, 80, 34]];
  return puffs.map(([x, y, rx, ry]) => `<ellipse cx="${n(x * scale)}" cy="${n(y * scale)}" rx="${n(rx * scale)}" ry="${n(ry * scale)}"/>`).join('');
};
const clouds = [[1.5, 300, 18, 0, .8], [0.9, 470, 13, -5, .68], [1.2, 620, 20, -11, .74], [0.7, 170, 15, -8, .6]]
  .map(([scale, y, seconds, delay, opacity]) => `<g class="cloud" style="animation-duration:${seconds}s;animation-delay:${delay}s" opacity="${opacity}"><g transform="translate(0 ${y})">${cloud(scale)}</g></g>`).join('');

// ---- 草：三層，每層分成幾束各自擺動 ----
const bladeLayer = (count, minH, maxH, color, yOffset, tufts) => {
  const groups = Array.from({ length: tufts }, () => []);
  for (let i = 0; i < count; i += 1) {
    const x = between(-20, W + 20);
    const base = groundY(x) + yOffset;
    const height = between(minH, maxH);
    const lean = between(-10, 10);
    const half = between(1.4, 3);
    groups[Math.floor((x + 20) / (W + 41) * tufts)].push(`M${n(x - half)} ${n(base)}Q${n(x + lean * 0.3)} ${n(base - height * 0.6)} ${n(x + lean)} ${n(base - height)}Q${n(x + lean * 0.5 + half)} ${n(base - height * 0.5)} ${n(x + half)} ${n(base)}Z`);
  }
  return groups.map(paths => `<path class="sway" style="animation-duration:${n(between(3.6, 6.2))}s;animation-delay:${n(-between(0, 6))}s" fill="${color}" d="${paths.join('')}"/>`).join('');
};
const hill = (yOffset) => { let d = `M0 ${H}`; for (let x = 0; x <= W; x += 60) d += `L${x} ${n(groundY(x) + yOffset)}`; return `${d}L${W} ${H}Z`; };

// ---- 螢火蟲 ----
const fireflies = Array.from({ length: 18 }, () => {
  const x = between(60, W - 60);
  const y = groundY(x) + between(-120, 120);
  const r = between(1.6, 3.2);
  return `<g class="drift" style="animation-duration:${n(between(7, 13))}s;animation-delay:${n(-between(0, 12))}s"><g class="glow" style="animation-duration:${n(between(3.2, 7.5))}s;animation-delay:${n(-between(0, 8))}s"><circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 4.5)}" fill="url(#firefly)"/><circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#fff3a6"/></g></g>`;
}).join('');

// ---- 星星（靜態） ----
const stars = Array.from({ length: 70 }, () => `<circle cx="${n(between(0, W))}" cy="${n(between(0, 620))}" r="${n(between(0.6, 1.8))}" opacity="${n(between(0.25, 0.8))}"/>`).join('');

// ---- 稻草人：鏡頭拉遠後縮小（SCALE），背對月光所以幾乎是剪影；細節靠輪廓與少量月色描邊呈現 ----
// 以腳底為原點畫，橫桿在 y = -300。
const SCALE = 0.6;
const foot = groundY(CX) + 8;
const A = -300;
const straw = (x, y, angles, length = 30) => angles.map(angle => { const rad = angle * Math.PI / 180; return `M${x} ${y}l${n(Math.cos(rad) * length * between(0.7, 1.15))} ${n(Math.sin(rad) * length * between(0.7, 1.15))}`; }).join('');
const scarecrow = `
  <g transform="translate(${CX} ${n(foot)}) scale(${SCALE})">
    <g fill="#0b1211" stroke="#49b8b8" stroke-opacity=".38" stroke-width="2.2" stroke-linejoin="round">
      <!-- 木樁與橫桿（略歪、有木節） -->
      <path d="M-10 ${A - 30} L9 ${A - 34} L12 60 L-9 60Z"/>
      <path d="M-238 ${A + 10} L-120 ${A + 2} L60 ${A - 6} L240 ${A - 14} L242 ${A + 4} L60 ${A + 12} L-120 ${A + 20} L-238 ${A + 28}Z"/>
      <!-- 上衣：肩線下垂、袖口與下擺破爛 -->
      <path d="M-70 ${A - 18} Q0 ${A - 34} 70 ${A - 22} L176 ${A - 12} L186 ${A + 44} L170 ${A + 36} L160 ${A + 60} L146 ${A + 40} L132 ${A + 66} L118 ${A + 44} L100 ${A + 58}
        L92 ${A + 150} L102 ${A + 214} L84 ${A + 196} L70 ${A + 232} L52 ${A + 200} L34 ${A + 240} L16 ${A + 204} L-4 ${A + 244} L-22 ${A + 206} L-42 ${A + 238} L-58 ${A + 200} L-78 ${A + 228} L-92 ${A + 190}
        L-100 ${A + 60} L-116 ${A + 46} L-130 ${A + 70} L-144 ${A + 46} L-160 ${A + 66} L-170 ${A + 42} L-186 ${A + 52} L-178 ${A - 4}Z"/>
      <!-- 頭：麻布袋，頸部用繩子束起 -->
      <path d="M-44 ${A - 74} Q-52 ${A - 124} -8 ${A - 132} Q46 ${A - 136} 46 ${A - 82} Q46 ${A - 44} 20 ${A - 34} L26 ${A - 20} L-24 ${A - 18} L-18 ${A - 34} Q-40 ${A - 46} -44 ${A - 74}Z"/>
      <!-- 帽子：寬帽簷、尖端折向一邊 -->
      <path d="M-112 ${A - 104} Q-40 ${A - 132} 0 ${A - 130} Q52 ${A - 128} 116 ${A - 110} L98 ${A - 96} Q40 ${A - 112} 0 ${A - 112} Q-48 ${A - 112} -96 ${A - 92}Z"/>
      <path d="M-50 ${A - 118} Q-34 ${A - 196} 4 ${A - 226} Q30 ${A - 244} 66 ${A - 232} Q44 ${A - 214} 40 ${A - 186} Q46 ${A - 150} 54 ${A - 118} Q0 ${A - 130} -50 ${A - 118}Z"/>
    </g>
    <!-- 稻草：手腕、領口、帽簷下、下擺 -->
    <path fill="none" stroke="#0b1211" stroke-width="5" stroke-linecap="round" d="${straw(-236, A + 18, [150, 172, 195, 215, 128], 34)}${straw(240, A - 6, [-35, -12, 12, 34, -58], 34)}${straw(-30, A - 96, [160, 185, 205], 22)}${straw(34, A - 98, [20, -5, -25], 22)}${straw(-20, A - 20, [110, 80, 135], 18)}${straw(18, A - 22, [70, 95, 45], 18)}${straw(-40, A + 232, [80, 100, 118], 26)}${straw(30, A + 236, [75, 95, 62], 26)}"/>
    <!-- 月色描出的細節：帽帶、繩結、補丁、鈕扣、縫線、木節 -->
    <g fill="none" stroke="#6fd6d2" stroke-opacity=".5" stroke-width="2.4" stroke-linecap="round">
      <path d="M-46 ${A - 124} Q2 ${A - 138} 50 ${A - 124}"/>
      <path d="M-22 ${A - 30} Q0 ${A - 24} 22 ${A - 32} M4 ${A - 28} l10 16 M4 ${A - 28} l-6 16"/>
      <path d="M-64 ${A + 40} l34 -4 l4 34 l-36 4Z M-58 ${A + 46} l6 0 M-44 ${A + 60} l6 0" stroke-dasharray="7 5"/>
      <path d="M38 ${A + 120} l30 6 l-6 30 l-30 -6Z" stroke-dasharray="7 5"/>
      <path d="M-2 ${A + 20} l0 150" stroke-dasharray="2 22"/>
      <path d="M-70 ${A + 176} Q0 ${A + 190} 78 ${A + 172}"/>
      <path d="M-150 ${A + 16} l18 -2 M150 ${A - 2} l18 -2 M-2 ${A + 300} l6 14"/>
    </g>
    <!-- 眼睛與嘴：布袋上剪開的洞，透出一點月光 -->
    <g fill="#7fe6e1" opacity=".75"><path d="M-24 ${A - 88} l16 -6 l-4 14Z"/><path d="M12 ${A - 94} l16 6 l-12 8Z"/></g>
    <path d="M-20 ${A - 60} l8 6 l8 -6 l8 6 l8 -6 l8 6" fill="none" stroke="#7fe6e1" stroke-opacity=".6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;

// ---- 鳥：只有輪廓，偶爾飛來停在手上（跟著稻草人一起縮小） ----
const bird = (dx, dy, cls, flip) => `<g class="${cls}"><g transform="translate(${n(CX + dx * SCALE)} ${n(foot + dy * SCALE)}) scale(${flip ? -SCALE : SCALE} ${SCALE})" fill="#060a0a"><ellipse cx="0" cy="-17" rx="24" ry="14"/><circle cx="19" cy="-31" r="10.5"/><path d="M27 -34 l15 4 l-15 4Z"/><path d="M-16 -22 l-36 -2 l30 16Z"/><path d="M-10 -24 Q4 -34 14 -20 Q2 -12 -10 -24Z" fill="#0f1a1a"/><path d="M-4 -4 l-2 7 M6 -4 l2 7" stroke="#060a0a" stroke-width="3"/></g></g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#04101c"/><stop offset=".6" stop-color="#0a2530"/><stop offset="1" stop-color="#123532"/></linearGradient>
  <!-- 球體感：亮點偏左上、往右下漸暗（moon），再疊一層邊緣變暗（limb）與右下的陰影（shade）。 -->
  <radialGradient id="moon" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="#d6fffb"/><stop offset=".38" stop-color="#86ece6"/><stop offset=".75" stop-color="#4cc3c4"/><stop offset="1" stop-color="#2a8f98"/></radialGradient>
  <radialGradient id="limb"><stop offset=".7" stop-color="#06343c" stop-opacity="0"/><stop offset=".93" stop-color="#06343c" stop-opacity=".3"/><stop offset="1" stop-color="#04242c" stop-opacity=".62"/></radialGradient>
  <radialGradient id="shade" cx="74%" cy="78%" r="62%"><stop offset="0" stop-color="#05303a" stop-opacity=".5"/><stop offset="1" stop-color="#05303a" stop-opacity="0"/></radialGradient>
  <radialGradient id="halo"><stop offset=".6" stop-color="#58e0dc" stop-opacity=".3"/><stop offset="1" stop-color="#58e0dc" stop-opacity="0"/></radialGradient>
  <radialGradient id="firefly"><stop offset="0" stop-color="#ffe45c" stop-opacity=".75"/><stop offset="1" stop-color="#ffe45c" stop-opacity="0"/></radialGradient>
  <linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3f10"/><stop offset="1" stop-color="#15130a"/></linearGradient>
</defs>
<style>
  .cloud { animation: cross linear infinite; fill: #0c1f2b; }
  @keyframes cross { from { transform: translateX(-420px); } to { transform: translateX(2340px); } }
  .sway { transform-box: fill-box; transform-origin: 50% 100%; animation: sway ease-in-out infinite alternate; }
  @keyframes sway { from { transform: skewX(-5deg); } to { transform: skewX(6deg); } }
  .glow { animation: glow ease-in-out infinite; opacity: 0; }
  @keyframes glow { 0%, 55%, 100% { opacity: 0; } 70%, 85% { opacity: 1; } }
  .drift { animation: drift ease-in-out infinite alternate; }
  @keyframes drift { from { transform: translate(-18px, 8px); } to { transform: translate(22px, -14px); } }
  /* 鳥：大部分時間不在；飛進來、停一陣子、再飛走。兩隻的週期不同，所以不會同步。 */
  .bird-a { animation: perch-a 46s ease-in-out infinite; opacity: 0; }
  .bird-b { animation: perch-b 71s ease-in-out infinite; opacity: 0; }
  @keyframes perch-a { 0%, 8% { opacity: 0; transform: translate(-420px, -200px); } 14% { opacity: 1; transform: translate(0, 0); } 15.5% { transform: translate(0, -3px); } 17%, 38% { opacity: 1; transform: translate(0, 0); } 45%, 100% { opacity: 0; transform: translate(480px, -260px); } }
  @keyframes perch-b { 0%, 52% { opacity: 0; transform: translate(440px, -230px); } 57% { opacity: 1; transform: translate(0, 0); } 58% { transform: translate(0, -3px); } 59%, 74% { opacity: 1; transform: translate(0, 0); } 79%, 100% { opacity: 0; transform: translate(-500px, -220px); } }
  @media (prefers-reduced-motion: reduce) { .cloud, .sway, .glow, .drift, .bird-a, .bird-b { animation: none; } .glow { opacity: .7; } }
</style>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<g fill="#d9fffb">${stars}</g>
<circle cx="${moon.x}" cy="${moon.y}" r="${n(moon.r * 1.5)}" fill="url(#halo)"/>
<circle cx="${moon.x}" cy="${moon.y}" r="${moon.r}" fill="url(#moon)"/>
${craters}
<circle cx="${moon.x}" cy="${moon.y}" r="${moon.r}" fill="url(#shade)"/>
<circle cx="${moon.x}" cy="${moon.y}" r="${moon.r}" fill="url(#limb)"/>
${clouds}
<path d="${hill(-24)}" fill="#2b2a10"/>
${bladeLayer(260, 16, 38, '#3a3410', -22, 6)}
${scarecrow}
${bird(-204, A + 12, 'bird-a', false)}
${bird(200, A - 8, 'bird-b', true)}
<path d="${hill(0)}" fill="url(#field)"/>
${bladeLayer(320, 22, 52, '#57480f', 4, 7)}
${bladeLayer(240, 34, 76, '#1d1a09', 62, 6)}
${fireflies}
</svg>
`;
await writeFile(out, svg);
console.log(`scene.svg：${(svg.length / 1024).toFixed(1)} KB`);
