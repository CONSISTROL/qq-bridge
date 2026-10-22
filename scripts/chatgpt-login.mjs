// ChatGPT 登录：起一个可见浏览器（Xvfb :42 + noVNC），主人自己登录一次即可。
import { openChatgptForLogin } from '../src/draw-web.js';
const { browser, page } = await openChatgptForLogin({ stateDir: './state' });
console.log('[chatgpt] 浏览器已打开 https://chatgpt.com/  —— 请在 noVNC 里完成登录');
console.log('[chatgpt] 登录后本进程会退出（最多等 10 分钟）');
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const url = page.url();
  const logged = await page.evaluate(() => !/auth|login/i.test(location.href) && !!document.querySelector('div[contenteditable="true"], textarea')).catch(() => false);
  if (logged && !/auth|login/i.test(url)) { console.log('[chatgpt] ✅ 看起来已登录'); break; }
}
await browser.close().catch(() => {});
