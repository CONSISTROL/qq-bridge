// 主题切换（浅色为默认值）
//
// 这个模块刻意不 import 任何东西、加载时也不碰 DOM：scripts/test-console-theme.mjs
// 会把 core/theme.js 当普通脚本（去掉 export 前缀）丢进 vm 里跑，验证
// 「默认浅色 / 存过 dark 就恢复 / 点击可切换并持久化 / localStorage 不可用不炸」。
// 首屏防闪烁那段必须留在 index.html 内联，不能搬到这里（ES module 是延迟执行的）。
const THEME_KEY = 'qq-console-theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme, persist) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    // 按钮显示的是「点一下会切到哪」，不是当前状态
    btn.textContent = t === 'dark' ? '☀️ 浅色' : '🌙 深色';
    btn.title = t === 'dark' ? '当前深色，点击切到浅色' : '当前浅色，点击切到深色';
  }
  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式忽略 */ }
  }
}

export function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
}

export function initTheme() {
  applyTheme(currentTheme(), false);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', toggleTheme);
}
