// 控制台主题回归测试：浅色默认 / 深色可切 / 选择持久化 / 两套变量一一对应
//
// 重点不是"跑起来好看"，而是三件容易在后续改样式时被破坏的事：
//   1. 默认必须是浅色（没存过偏好时）；
//   2. 存过 dark 时，必须在首屏渲染前就定下主题（否则深色用户会闪一下浅色）；
//   3. 样式里不能再出现写死的色值，且两套主题的变量集合必须完全一致
//      （少定义一个变量不会报错，只会静默退化成透明/继承色）。
//
// 控制台已拆成分区结构：外壳在 public/console/index.html，样式在
// public/console/style.css，主题逻辑在 public/console/core/theme.js。
//
// 用法：node scripts/test-console-theme.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'public', 'console', 'index.html');const STYLE = path.join(ROOT, 'public', 'console', 'style.css');
const THEME = path.join(ROOT, 'public', 'console', 'core', 'theme.js');
const html = fs.readFileSync(SHELL, 'utf8');
const style = fs.readFileSync(STYLE, 'utf8');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1; }
}

console.log('控制台主题测试\n');

// ── 0. 结构：外壳不内联样式，样式与脚本各自独立加载 ─────────────────
check('外壳仍是默认浅色 <html data-theme="light">', () => assert.match(html, /<html[^>]*data-theme="light"/));
check('外壳外链独立样式表（不再内联 <style>）', () => {
  assert.match(html, /<link rel="stylesheet" href="\/console\/style\.css">/);
  assert.ok(!html.includes('<style>'), '外壳里不该再有内联 <style>');
});
check('外壳以 ES module 加载入口脚本', () => assert.match(html, /<script type="module" src="\/console\/app\.js"><\/script>/));

// ── 1. 结构：有两套主题变量块 ───────────────────────────────────────
check('存在默认 :root 变量块', () => assert.ok(/:root\s*\{/.test(style)));
check('存在 [data-theme="dark"] 覆盖块', () => assert.ok(/:root\[data-theme="dark"\]\s*\{/.test(style)));

// ── 2. 变量集合一致 + 无写死色值 ────────────────────────────────────
const varsOf = (marker) => {
  const i = style.indexOf(marker);
  const seg = style.slice(i);
  return new Set([...seg.slice(0, seg.indexOf('}')).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};
const lightVars = varsOf(':root {');
const darkVars = varsOf(':root[data-theme="dark"]');

check('两套主题变量集合完全一致', () => {
  const onlyLight = [...lightVars].filter((v) => !darkVars.has(v));
  const onlyDark = [...darkVars].filter((v) => !lightVars.has(v));
  assert.deepEqual(onlyLight, [], `深色缺少: ${onlyLight.join(', ')}`);
  assert.deepEqual(onlyDark, [], `浅色缺少: ${onlyDark.join(', ')}`);
});
check('规则里没有写死的色值（全部走变量）', () => {
  // 把两个变量块本身剔掉，剩下的规则里不应再出现 #hex / rgb() / rgba()
  const rest = style.replace(/:root(?:\s*\[[^\]]*\])?\s*\{[^}]*\}/g, '');
  const literals = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `发现写死色值: ${literals.join(', ')}`);
});
check('引用的变量都有定义（不会静默退化）', () => {
  const used = new Set([...style.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !lightVars.has(v) || !darkVars.has(v));
  assert.deepEqual(missing, [], `未定义: ${missing.join(', ')}`);
});
check('有底色的控件显式指定了前景色', () => {
  const bad = [];
  for (const m of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, sel, body] = m;
    if (/background:\s*var\(--(accent|danger|ok|err|pill)/.test(body) && !/color:/.test(body)) {
      bad.push(sel.trim().replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(bad, [], `缺 color 的规则: ${bad.join(' | ')}`);
});

// ── 3. 行为：默认浅色 / 存 dark 恢复深色 / 点击可切换并写回 ─────────
// 首屏防闪烁脚本必须留在外壳内联（ES module 是延迟执行的，等不到它）。
const headScript = html.slice(0, html.indexOf('</head>')).match(/<script>([\s\S]*?)<\/script>/)[1];
// theme.js 刻意不 import 任何东西，所以能去掉 export 前缀直接丢进 vm 当普通脚本跑。
const themeScript = fs.readFileSync(THEME, 'utf8').replace(/^export /gm, '');

function makeDom() {
  const attrs = new Map();
  const listeners = {};
  const store = new Map();
  const btn = {
    textContent: '', title: '',
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  return {
    store,
    btn,
    listeners,
    fire: (type) => listeners[type]?.(),
    doc: {
      documentElement: {
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        setAttribute: (k, v) => attrs.set(k, v)
      },
      getElementById: (id) => (id === 'themeToggle' ? btn : null),
      addEventListener: (type, fn) => { listeners[type] = fn; }
    },
    attrs
  };
}

function run(saved, { brokenStorage = false } = {}) {
  const dom = makeDom();
  const ctx = {
    document: dom.doc,
    localStorage: brokenStorage
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : {
        getItem: (k) => (dom.store.has(k) ? dom.store.get(k) : null),
        setItem: (k, v) => dom.store.set(k, String(v))
      }
  };
  ctx.window = ctx;
  if (saved !== undefined) dom.store.set('qq-console-theme', saved);
  vm.createContext(ctx);
  vm.runInContext(headScript, ctx);    // 首屏防闪烁脚本
  vm.runInContext(themeScript, ctx);   // currentTheme / applyTheme / initTheme
  ctx.initTheme();                     // 外壳 app.js 里也是显式调用它
  return { ctx, dom };
}

check('没存过偏好 → 浅色（默认）', () => {
  const { dom } = run(undefined);
  assert.equal(dom.attrs.get('data-theme') ?? 'light', 'light');
});
check('存过 dark → 首屏脚本就切深色（不闪浅色）', () => {
  const { dom } = run('dark');
  assert.equal(dom.attrs.get('data-theme'), 'dark');
});
check('按钮文案显示的是「切到哪」而不是当前态', () => {
  assert.equal(run(undefined).dom.btn.textContent, '🌙 深色');
  assert.equal(run('dark').dom.btn.textContent, '☀️ 浅色');
});
check('点击可来回切换并写入 localStorage', () => {
  const { dom } = run(undefined);
  dom.fire('click');
  assert.equal(dom.attrs.get('data-theme'), 'dark');
  assert.equal(dom.store.get('qq-console-theme'), 'dark', '深色未持久化');
  dom.fire('click');
  assert.equal(dom.attrs.get('data-theme'), 'light');
  assert.equal(dom.store.get('qq-console-theme'), 'light', '浅色未持久化');
});
check('localStorage 不可用时不影响渲染（隐私模式）', () => {
  const { dom } = run(undefined, { brokenStorage: true });
  assert.equal(dom.attrs.get('data-theme'), 'light');
});

console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : '，全部通过 ✅'}`);
