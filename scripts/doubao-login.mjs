// 豆包 web 登录：点「登录」→ 截二维码 → 等扫码 → 存 cookie 到 profile。
// 产出的二维码可以直接发到主人 QQ，用豆包 App 扫。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const PROFILE = path.join(STATE, 'chrome-profile');
const QR = path.join(STATE, 'doubao-qr.png');
const DONE = path.join(STATE, 'doubao-login-state.json');
fs.mkdirSync(STATE, { recursive: true });
// Chrome 的持久 profile 被上次异常退出留下锁时会直接挂住，先清掉
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch { /* 忽略 */ }
}

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', '--lang=zh-CN'],
  defaultViewport: { width: 1280, height: 900 }
});
const page = (await browser.pages())[0] || (await browser.newPage());
await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3500));

// 已登录？页面右上角没有「登录」按钮
const loggedIn = async () => {
  // 唯一可靠判据：出现登录态 cookie（扫码成功后豆包会种 sessionid 一族）
  const cookies = await page.cookies().catch(() => []);
  const hit = cookies.some((c) => /^(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt)/i.test(c.name) && String(c.value || '').length > 8);
  if (hit) return true;
  return false;
};
if (await loggedIn()) {
  fs.writeFileSync(DONE, JSON.stringify({ ok: true, at: Date.now(), note: '已经登录过了' }));
  console.log('[doubao] 已经是登录状态');
  await browser.close();
  process.exit(0);
}

// 点右上角「登录」
const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button,div,a')].find((el) => (el.innerText || '').trim() === '登录'));
await btn?.click?.().catch(() => {});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: QR });
fs.writeFileSync(DONE, JSON.stringify({ ok: false, waiting: true, at: Date.now(), qr: QR }));
console.log(`[doubao] 二维码截图：${QR}`);

// 等扫码，最多 10 分钟
const deadline = Date.now() + 10 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  if (await loggedIn()) { ok = true; break; }
}
if (ok) {
  const cookies = await page.cookies().catch(() => []);
  fs.writeFileSync(path.join(STATE, 'doubao-cookies.json'), JSON.stringify(cookies, null, 2));
  fs.writeFileSync(DONE, JSON.stringify({ ok: true, at: Date.now() }));
  console.log('[doubao] ✅ 登录成功，cookie 已存进 profile');
} else {
  fs.writeFileSync(DONE, JSON.stringify({ ok: false, timeout: true, at: Date.now() }));
  console.log('[doubao] ⏰ 等待超时');
}
await browser.close();
