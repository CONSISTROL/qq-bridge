// 控制台「未保存」追踪的回归测试（不需要浏览器、不需要桥接）。
//
// 守的是一个真实踩到的坑：浏览器/密码管理器会在弹窗打开时自动填充密码框，
// 而自动填充只是「凭空把值写进去」，不是用户的改动。之前的实现纯比「当前值 vs 基线」，
// 于是「点开 qq_video 的 ⚙ 再点取消」也会弹出「还有 1 项没保存」。
//
// 现在的规则：
//   * 基线重建后，用户还没碰过这块区域时冒出来的值 → 并进基线，不算改动；
//   * 用户点过/敲过/聚焦过这块区域（pointerdown / keydown / focusin）→ 之后的改动照常计数；
//   * 控件还处于焦点上时的改动也算（键盘用户 Tab 进去改）。
//
// 用法：node scripts/test-console-dirty.mjs
import assert from 'node:assert/strict';
import { trackDirty, confirmLeave, clearLeaveGuard } from '../public/console/core/dirty.js';

let passed = 0;
let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

// ── 最小 DOM 桩 ────────────────────────────────────────────────────
// dirty.js 只用到：root.querySelectorAll / addEventListener / removeEventListener、
// el.id|el.dataset|el.type|el.value|el.checked、el.closest(scope)、document.activeElement、window.confirm。
class Element {
  constructor({ key, type = 'text', value = '', checked = false, inScope = false }) {
    this.id = key;
    this.type = type;
    this.value = value;
    this.checked = checked;
    this.dataset = {};
    this._inScope = inScope;
  }
  closest(sel) { return this._inScope && sel === '#scope' ? this : null; }
}
globalThis.Element = Element;

function makeRoot(controls) {
  const listeners = new Map();
  const listOf = (type) => {
    if (!listeners.has(type)) listeners.set(type, []);
    return listeners.get(type);
  };
  return {
    controls,
    listeners,
    querySelectorAll: () => controls,
    addEventListener(type, fn) { listOf(type).push(fn); },
    removeEventListener(type, fn) {
      const list = listOf(type);
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(type, target, isTrusted = true) {
      for (const fn of [...listOf(type)]) fn({ type, target, isTrusted });
    }
  };
}

globalThis.document = { activeElement: null };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  confirm: () => true
};
clearLeaveGuard();

// ── 用例 ───────────────────────────────────────────────────────────
check('刚建好基线时没有未保存项', () => {
  const root = makeRoot([new Element({ key: 'a', value: '1' })]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  assert.equal(t.count(), 0);
  t.dispose();
});

check('自动填充（无手势、未聚焦）不算改动', () => {
  const el = new Element({ key: 'a', value: '1' });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  el.value = 'browser-autofilled';
  root.fire('input', el);
  assert.equal(t.count(), 0, '自动填充被算成了用户改动');
  el.checked = true;
  root.fire('change', el);
  assert.equal(t.count(), 0, '自动填充触发的 change 也算成了用户改动');
  t.dispose();
});

check('用户点过之后（pointerdown 在 scope 内）的改动照常计数', () => {
  const el = new Element({ key: 'a', value: '1', inScope: true });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  root.fire('pointerdown', el);
  el.value = 'user-typed';
  root.fire('input', el);
  assert.equal(t.count(), 1);
  t.dispose();
});

check('scope 外的点击不算「碰过」：紧接着的自动填充仍被吸收', () => {
  const el = new Element({ key: 'a', value: '1' });
  const outside = new Element({ key: 'open-button' });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  root.fire('pointerdown', outside); // 比如点 ⚙ 打开弹窗
  el.value = 'browser-autofilled';
  root.fire('input', el);
  assert.equal(t.count(), 0);
  t.dispose();
});

check('键盘聚焦后的改动算改动（Tab 进字段再输入）', () => {
  const el = new Element({ key: 'a', value: '1', inScope: true });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  root.fire('focusin', el);
  el.value = '2';
  root.fire('input', el);
  assert.equal(t.count(), 1);
  t.dispose();
});

check('控件还在焦点上时的改动算改动（没配 scope 的旧用法也能用）', () => {
  const el = new Element({ key: 'a', value: '1' });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x' });
  globalThis.document.activeElement = el;
  el.value = '2';
  root.fire('input', el);
  assert.equal(t.count(), 1);
  globalThis.document.activeElement = null;
  t.dispose();
});

check('markClean 之后重新变干净，且自动填充门槛复位', () => {
  const el = new Element({ key: 'a', value: '1', inScope: true });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  root.fire('pointerdown', el);
  el.value = '2';
  root.fire('input', el);
  assert.equal(t.count(), 1);
  t.markClean(); // 保存成功、表单按服务端值重填
  assert.equal(t.count(), 0);
  el.value = 'browser-autofilled-again';
  root.fire('input', el);
  assert.equal(t.count(), 0, 'markClean 之后自动填充又算成改动了');
  t.dispose();
});

check('有未保存改动时离开守卫会拦下，清干净后放行', async () => {
  const el = new Element({ key: 'a', value: '1', inScope: true });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', label: '测试参数', interactionScope: '#scope' });
  root.fire('keydown', el);
  el.value = '2';
  root.fire('input', el);
  assert.equal(t.count(), 1);
  let asked = 0;
  globalThis.window.confirm = (msg) => { asked += 1; return /测试参数/.test(msg); };
  assert.equal(await confirmLeave(), true, '确认后应当放行');
  assert.equal(asked, 1);
  t.markClean();
  assert.equal(await confirmLeave(), true);
  assert.equal(asked, 1, '干净时不该再问');
  t.dispose();
  clearLeaveGuard();
});

check('dispose 撤掉监听与守卫（分区切走就是它）', async () => {
  const el = new Element({ key: 'a', value: '1', inScope: true });
  const root = makeRoot([el]);
  const t = trackDirty(root, { selector: 'x', interactionScope: '#scope' });
  t.dispose();
  assert.deepEqual(root.listeners.get('input'), []);
  assert.deepEqual(root.listeners.get('change'), []);
  assert.deepEqual(root.listeners.get('pointerdown'), []);
  el.value = '2';
  root.fire('input', el);
  assert.equal(await confirmLeave(), true, 'dispose 后守卫不该再拦');
});

let failedNames = [];
for (const [name, fn] of queue) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failedNames.push(name); console.error(`  ✗ ${name}\n    ${error.message}`); }
}
console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败：${failedNames.join('、')}` : ''}`);
process.exit(failed ? 1 : 0);
