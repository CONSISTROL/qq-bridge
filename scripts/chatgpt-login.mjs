// ChatGPT 登录：起一个可见浏览器（Xvfb :42 + noVNC），主人自己登录一次即可。
import { openChatgptForLogin } from '../src/draw-web.js';
const { browser, page } = await openChatgptForLogin({ stateDir: './state' });
console.log('[chatgpt] 浏览器已打开 https://chatgpt.com/  —— 请在 noVNC 里完成登录');
console.log('[chatgpt] 登录后本进程会退出（最多等 10 分钟）');
// 判据：页面上不再有「Log in / 登录」按钮，且出现了「New chat / 新对话」或账号头像。
// （之前用「有没有输入框」判断，落地页也有输入框 → 误判成已登录）
const loggedIn = async () => {
  const r = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    const hasLogin = /\bLog in\b|^登录$/m.test(txt);
    const hasNewChat = /New chat|新对话|Chat with|有什么可以帮/.test(txt);
    return { hasLogin, hasNewChat };
  }).catch(() => ({ hasLogin: true, hasNewChat: false }));
  return !r.hasLogin && r.hasNewChat;
};
const deadline = Date.now() + 15 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  if (await loggedIn()) { ok = true; break; }
}
console.log(ok ? '[chatgpt] ✅ 已登录（profile 已保存）' : '[chatgpt] ⏰ 等待超时，未检测到登录');
await browser.close().catch(() => {});
