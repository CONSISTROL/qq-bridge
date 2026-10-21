// 豆包 web 接口抓取：登录一次 → 让它画一张图 → 把网页实际调用的接口录下来。
//
// 用法：
//   node scripts/doubao-capture.mjs --login     # 首次：拉起浏览器、截登录二维码、等扫码
//   node scripts/doubao-capture.mjs --capture "画一只蓝色鲸鱼"   # 抓一次出图的请求/响应
//
// 产出：
//   state/doubao-login.png       登录用二维码截图（可以直接发到 QQ 让主人扫）
//   state/chrome-profile/        登录态（cookie，不进 git）
//   state/doubao-capture.jsonl   抓到的接口（url/method/headers/postData/响应片段）
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const PROFILE = path.join(STATE, 'chrome-profile');
const LOGIN_PNG = path.join(STATE, 'doubao-login.png');
const CAPTURE = path.join(STATE, 'doubao-capture.jsonl');
const args = process.argv.slice(2);
const mode = args.includes('--login') ? 'login' : args.includes('--capture') ? 'capture' : '';
const prompt = args.find((a, i) => args[i - 1] === '--capture') || '画一只戴墨镜的蓝色鲸鱼，像素风';

fs.mkdirSync(STATE, { recursive: true });

const browser = await puppeteer.launch({
  headless: false, // 有 Xvfb 时用有头模式，扫码/反爬都更顺
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', '--lang=zh-CN'],
  defaultViewport: { width: 1280, height: 900 }
});
const page = (await browser.pages())[0] || (await browser.newPage());
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');

const hits = [];
cdp.on('Network.requestWillBeSent', (e) => {
  const u = e.request?.url || '';
  if (!/doubao|volc|bytedance|byteimg|image|draw|generation|completion/i.test(u)) return;
  if (/\.(png|jpg|jpeg|webp|gif|css|woff2?)(\?|$)/i.test(u)) return; // 静态资源跳过
  hits.push({ id: e.requestId, at: Date.now(), url: u, method: e.request.method, headers: e.request.headers, postData: e.request.postData, type: e.type });
});
cdp.on('Network.responseReceived', async (e) => {
  const h = hits.find((x) => x.id === e.requestId);
  if (!h) return;
  h.status = e.response?.status;
  h.mimeType = e.response?.mimeType;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
    h.response = String(body?.body ?? '').slice(0, 4000);
    h.responseBase64 = body?.base64Encoded === true;
  } catch { /* 有些响应拿不到正文 */ }
});

console.log('[doubao] 打开 doubao.com …');
await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('[doubao] 打开失败：', e.message));
await new Promise((r) => setTimeout(r, 4000));

if (mode === 'login') {
  await page.screenshot({ path: LOGIN_PNG });
  console.log(`[doubao] 登录截图已保存：${LOGIN_PNG}`);
  console.log('[doubao] 扫完码后窗口里会出现对话界面；脚本最多等 10 分钟，检测到登录即退出。');
  const deadline = Date.now() + 10 * 60 * 1000;
  let logged = false;
  while (Date.now() < deadline) {
    const cookies = await page.cookies().catch(() => []);
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    const hasSession = cookies.some((c) => /sessionid|session/i.test(c.name) && String(c.value || '').length > 8);
    const inChat = /发消息|输入|新对话|豆包/.test(text) && !/登录|扫码/.test(text);
    if (hasSession || inChat) { logged = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await page.screenshot({ path: path.join(STATE, 'doubao-after-login.png') }).catch(() => {});
  console.log(logged ? '[doubao] ✅ 已登录（cookie 已存进 profile）' : '[doubao] ⏰ 等待超时，未检测到登录');
  fs.writeFileSync(path.join(STATE, 'doubao-cookies.json'), JSON.stringify(await page.cookies(), null, 2));
} else if (mode === 'capture') {
  console.log('[doubao] 发送提示词：', prompt);
  // 文本输入：豆包用 contenteditable textarea/div，先点输入框再输入
  const sel = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
  await page.click(sel).catch(() => {});
  await page.keyboard.type(prompt, { delay: 20 });
  await page.keyboard.press('Enter');
  // 等出图：最多 90 秒，页面里出现 doubao/byteimg 的图片或接口命中 image 相关
  const deadline = Date.now() + 90000;
  let done = false;
  while (Date.now() < deadline) {
    const imgCount = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /byteimg|doubao/i.test(i.src) && i.naturalWidth > 200).length).catch(() => 0);
    if (imgCount > 0) { done = true; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await page.screenshot({ path: path.join(STATE, 'doubao-capture.png') }).catch(() => {});
  console.log(done ? '[doubao] ✅ 已出图' : '[doubao] ⏰ 没等到图（可能未登录/被限流）');
  fs.writeFileSync(CAPTURE, hits.map((h) => JSON.stringify(h)).join('\n') + '\n');
  console.log(`[doubao] 抓到 ${hits.length} 个候选请求 → ${CAPTURE}`);
  // 把最像"文生图"的几个挑出来打印
  const likely = hits.filter((h) => /image|draw|generation/i.test(h.url));
  for (const h of likely.slice(0, 8)) console.log('  ·', h.method, h.status, h.url.slice(0, 140));
} else {
  console.log('用法：--login 或 --capture "提示词"');
}

await browser.close();
