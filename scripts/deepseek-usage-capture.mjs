// 抓 platform.deepseek.com 的用量接口：主人登录后，页面自己会调 API，我们把请求/响应录下来。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const STATE = './state';
const PROFILE = path.join(STATE, 'deepseek-profile');
const OUT = path.join(STATE, 'deepseek-usage-api.jsonl');
fs.mkdirSync(STATE, { recursive: true });
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch { /* 忽略 */ }
}

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,1000', '--window-position=0,0', '--start-maximized'],
  defaultViewport: { width: 1400, height: 1000 },
  env: { ...process.env, DISPLAY: process.env.DRAW_DISPLAY || ':42' }
});
const page = (await browser.pages())[0] || (await browser.newPage());
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
const hits = new Map();
const keep = (u) => /platform\.deepseek\.com\/api\//.test(u);
cdp.on('Network.requestWillBeSent', (e) => {
  if (!keep(e.request?.url || '')) return;
  hits.set(e.requestId, { url: e.request.url, method: e.request.method, postData: e.request.postData || '', headers: e.request.headers });
});
cdp.on('Network.responseReceived', async (e) => {
  const h = hits.get(e.requestId);
  if (!h) return;
  h.status = e.response?.status;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
    h.response = String(body?.body ?? '').slice(0, 20000);
  } catch { /* 忽略 */ }
});

await page.goto('https://platform.deepseek.com/usage', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
console.log('[ds] 已打开 https://platform.deepseek.com/usage —— 请在画面里登录');
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const logged = await page.evaluate(() => !/sign_in|login/i.test(location.href) && !/登录/.test(document.body.innerText.slice(0, 400))).catch(() => false);
  if (i % 6 === 5) console.log('[ds] 等待中… URL=', page.url());
  if (logged && hits.size > 0) { console.log('[ds] 已登录且有接口调用，再等 8 秒抓完整'); await new Promise((r) => setTimeout(r, 8000)); break; }
}
fs.writeFileSync(OUT, [...hits.values()].map((h) => JSON.stringify(h)).join('\n') + '\n');
console.log(`[ds] 抓到 ${hits.size} 个 /api/ 请求 → ${OUT}`);
for (const h of [...hits.values()].slice(0, 12)) console.log('  ·', h.method, h.status, String(h.url).replace('https://platform.deepseek.com', '').slice(0, 90));
await browser.close();
