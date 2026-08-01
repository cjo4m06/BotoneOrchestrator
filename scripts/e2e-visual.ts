/**
 * 視覺驗證端到端：**真的啟 dev server、真的開瀏覽器**，跑完整個 VisualVerifier。
 *
 * 為什麼需要這條：視覺模組有 150 條單元測試，但全部用假的 playwright。
 * 「假 browser 回傳的假 DOM 量測」驗得到判斷邏輯，驗不到真實瀏覽器的行為——
 * 選擇器對不對、量測時機（動畫沉澱）、截圖寫得出來、server 起得來又收得掉。
 * 這個模組是唯一會判 UI 好壞的東西，卻從沒在真實流程裡跑過。
 *
 * 兩個方向都要驗（D18：誤判的代價高於漏抓）：
 *   · 正常頁面 → 綠。判紅會逼 agent 去改沒有壞的東西。
 *   · 真的壞掉的頁面 → 紅。判綠等於這道關卡不存在。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { VisualVerifier } from '../src/worker/visual.js';
import { createLogger } from '../src/observability/logger.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
}

const SHELL = (title: string, body: string, extraCss = ''): string => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:15px/1.6 system-ui,sans-serif;color:#111}
  header{padding:16px 24px;border-bottom:1px solid #ddd;display:flex;gap:16px;align-items:center}
  main{padding:24px;max-width:900px}
  .card{border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px}
  button{padding:8px 14px;border:1px solid #ccc;border-radius:6px;background:#fff}
  ${extraCss}
</style></head><body>
<header><strong>${title}</strong><nav><a href="/">首頁</a></nav></header>
<main>${body}</main></body></html>`;

/** 內建的極簡靜態 server：用 npx 下載套件太慢，常常撐爆 dev server 的就緒逾時。 */
const SERVER_JS = `
const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join, extname } = require('node:path');
const root = process.argv[2], port = Number(process.argv[3]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
createServer((req, res) => {
  const p = join(root, decodeURIComponent((req.url || '/').split('?')[0]));
  const f = existsSync(p) && !p.endsWith('/') ? p : join(root, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(port, '127.0.0.1', () => console.log('ready on ' + port));
`;

function makeSite(root: string): void {
  mkdirSync(root, { recursive: true });

  // 正常頁：版面規矩，不該被判紅
  writeFileSync(join(root, 'index.html'), SHELL('正常頁面', `
    <div class="card"><h2>訂單摘要</h2><p>這是一段正常長度的說明文字，不會溢出容器。</p>
      <button>確認送出</button></div>
    <div class="card"><h2>付款方式</h2><p>信用卡 / 轉帳</p></div>`));

  // 正常頁 2：有省略號截斷（曾經被誤判成溢出的情境）
  writeFileSync(join(root, 'ellipsis.html'), SHELL('省略號頁面', `
    <div class="card"><p class="cut">這是一段刻意很長很長很長很長很長很長很長很長很長很長很長很長的文字，靠 CSS 截斷</p></div>`,
    `.cut{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}`));

  // 壞掉的頁：內容明確溢出視窗（水平捲軸）
  writeFileSync(join(root, 'broken.html'), SHELL('破版頁面', `
    <div class="card" style="width:3000px">這個卡片寬 3000px，會把頁面撐出水平捲軸</div>`));
}

async function main(): Promise<void> {
  console.log('════════ 視覺驗證端到端 ════════\n（真的啟 server、真的開瀏覽器）\n');
  const dir = mkdtempSync(join(tmpdir(), 'botone-visual-e2e-'));
  const shots = join(dir, 'shots');
  makeSite(join(dir, 'site'));

  const log = createLogger();
  const verifier = new VisualVerifier({ log });
  writeFileSync(join(dir, 'server.cjs'), SERVER_JS);
  const base = {
    devServer: `node ${join(dir, 'server.cjs')} ${join(dir, 'site')} 4599`,
    devPort: 4599,
    breakpoints: [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }],
    screenshotRoot: shots,
  };

  try {
    // ① 正常頁面不可被判紅（誤判會逼 agent 去改沒壞的東西）
    const good = await verifier.verify({
      cwd: dir,
      config: { ...base, routes: ['/index.html', '/ellipsis.html'] } as never,
    });
    check(`① 正常頁面判綠（status=${good.status}）`,
      good.status === 'ok' || good.status === 'skipped',
      good.status === 'skipped'
        ? `環境缺件已優雅降級：${good.skipReason ?? ''}`
        : good.checks.filter((c) => !c.ok).map((c) => c.detail).join('；') || '無問題');

    if (good.status === 'skipped') {
      console.log('\n⚠️ 瀏覽器或 dev server 不可用，後續探針無意義（這本身是設計中的降級行為）');
      return;
    }

    // ② 截圖真的寫得出來（PR 要附圖，寫不出來等於視覺驗證沒有證據）
    // 用回傳的路徑而不是掃目錄：回傳值才是 PR 會引用的那一份
    const pngs = good.screenshots;
    check('② 截圖有實際產出且檔案存在（PR 的視覺證據）',
      pngs.length >= 2 && pngs.every((p) => existsSync(p)),
      `${pngs.length} 張：${pngs.map((p) => basename(p)).join(', ')}`);

    // ③ 真的破版要被抓到（判綠等於這道關卡不存在）
    const bad = await verifier.verify({ cwd: dir, config: { ...base, routes: ['/broken.html'] } as never });
    const failed = bad.checks.filter((c) => !c.ok);
    check('③ 明確破版（3000px 溢出）被判紅', bad.status === 'failed' && failed.length > 0,
      failed.map((c) => c.detail).join('；') || `status=${bad.status}`);

    // ④ 多斷點都有跑到（RWD 破版只在窄螢幕出現是最常見的情形）
    check('④ 兩個斷點都有量測（RWD 破版常常只在窄螢幕出現）',
      pngs.some((f) => f.includes('mobile')) && pngs.some((f) => f.includes('desktop')),
      pngs.map((p) => basename(p)).join(', '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n────────\n${pass} 通過 / ${fail} 失敗`);
  console.log(fail === 0 ? '結論：✅ 視覺驗證在真實瀏覽器上可用' : '結論：❌ 有缺口');
}

main()
  .catch((e) => { console.error(e); fail += 1; })
  .finally(() => process.exit(fail === 0 ? 0 : 1));
