// 分区路由的回归测试（不需要浏览器、不需要桥接）。
//
// 守的是两个很隐蔽、但在真实浏览器里会「页面看着正常、实际已经死了」的问题：
//   1. 重复的 hashchange（同分区）不能把正在挂载中的那次 render 判成过期 ——
//      否则刚挂好的分区会被立刻 cleanup，DOM 还在、tracker/轮询/守卫却已经没了；
//   2. 挂载期间又切走时，旧的那次挂载结果必须被丢掉并清理，不能把旧内容留在新页面上。
// 顺带覆盖「有未保存改动时切换分区要拦一下」。
//
// 用法：node scripts/test-console-router.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { defineView, startRouter, currentRoute } from '../public/console/core/router.js';
import { setLeaveGuard, clearLeaveGuard } from '../public/console/core/dirty.js';

const root = {
  innerHTML: '',
  firstElementChild: null,
  appendChild() {},
  querySelectorAll: () => []
};
const listeners = {};
const locationStub = { hash: '' };
const historyStub = {
  replaceState(_state, _title, url) {
    // location.hash 是带 '#' 的，stub 必须照这个语义，否则断言会比错对象
    if (typeof url === 'string' && url.startsWith('#')) locationStub.hash = url;
  }
};
globalThis.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
globalThis.location = locationStub;
globalThis.history = historyStub;
globalThis.document = {
  createElement: () => ({ className: '', textContent: '', append() {}, appendChild() {}, style: {} }),
  querySelectorAll: () => []
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const hashchange = () => { for (const fn of listeners.hashchange || []) fn(); };
// startRouter 每调一次就多一个 hashchange 监听；除第一次外先清掉，
// 这样每个用例只面对一个监听器（否则守卫会被问两次，断言数就飘了）。
const resetListeners = () => { for (const key of Object.keys(listeners)) delete listeners[key]; };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('控制台路由回归测试\n');

// ── 1. 同分区重复 hashchange 不能把在飞的挂载判成过期 ────────────────
await check('重复 hashchange 不会打断正在挂载的分区', async () => {
  let cleaned = 0;
  let released = null;
  const gate = new Promise((resolve) => { released = resolve; });
  defineView({
    id: 'race',
    mount: async () => {
      await gate;                    // 模拟「片段还在加载」
      return () => { cleaned += 1; };
    }
  });

  locationStub.hash = '#/race';
  const started = startRouter({ root, fallback: 'race', onNavigate() {} });
  await tick();
  // 挂载还没完成时又来一次同分区 hashchange（浏览器/jsdom 都可能发生）
  locationStub.hash = '#/race';
  hashchange();
  await tick();
  released();
  await started;
  await tick();

  assert.equal(currentRoute(), 'race');
  assert.equal(cleaned, 0, '正在挂载的分区被误判过期并 cleanup 了');
});

// ── 2. 挂载期间切走：旧结果必须丢掉并清理 ────────────────────────────
await check('挂载期间切走 → 旧分区被清理、新分区生效', async () => {
  resetListeners();
  let slowCleaned = 0;
  let fastMounted = 0;
  let released = null;
  const gate = new Promise((resolve) => { released = resolve; });
  defineView({ id: 'slow', mount: async () => { await gate; return () => { slowCleaned += 1; }; } });
  defineView({ id: 'fast', mount: async () => { fastMounted += 1; } });

  locationStub.hash = '#/slow';
  // 注意不能 await：这次挂载会一直等 gate，await 会把测试挂死
  const started = startRouter({ root, fallback: 'slow', onNavigate() {} });
  await tick();

  locationStub.hash = '#/fast';
  hashchange();
  await tick();
  released();                       // 让慢的那次挂载完成
  await started;
  await tick();

  assert.equal(fastMounted, 1, '新分区没有挂载');
  assert.equal(slowCleaned, 1, '过期的挂载结果没有被清理');
  assert.equal(currentRoute(), 'fast');
});

// ── 3. 有未保存改动时切换分区会被拦下 ────────────────────────────────
await check('守卫说“别走”时不切换，并把地址栏改回去', async () => {
  let mounted = 0;
  defineView({ id: 'guarded', mount: async () => { mounted += 1; } });
  let asked = 0;
  setLeaveGuard(() => { asked += 1; return false; });
  const locationBefore = locationStub.hash;   // 当前停在 test 2 留下的分区

  locationStub.hash = '#/guarded';
  hashchange();
  await tick();
  await tick();

  assert.equal(mounted, 0, '被拦下时不该挂载新分区');
  assert.equal(asked, 1, '守卫没有被问到');
  assert.equal(locationStub.hash, locationBefore, '地址栏没有回到原分区');
  clearLeaveGuard();
});

await check('守卫说“可以走”时正常切换', async () => {
  let mounted = 0;
  defineView({ id: 'free', mount: async () => { mounted += 1; } });
  setLeaveGuard(() => true);
  locationStub.hash = '#/free';
  hashchange();
  await tick();
  await tick();
  assert.equal(mounted, 1, '允许离开时应该正常挂载');
  clearLeaveGuard();
});

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败 ❌` : '，全部通过 ✅'}`);
if (failed) process.exit(1);
