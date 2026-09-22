// hash 路由器 + view 注册表。
//
// 一个 view = 一个功能分区，约定：
//   { id, title, icon, group, desc?, badgeId?, mount(root) -> cleanup? }
// mount 里渲染自己的 markup 并绑定事件，返回的 cleanup 在切换分区时调用；
// 轮询交给 core/poll.js，切走时统一 stopAll()。
import { stopAll } from './poll.js';
import { confirmLeave } from './dirty.js';

const registry = new Map();
let rootEl = null;
let activeId = null;
let teardown = null;
let fallbackId = '';
let navigateHook = () => {};
let seq = 0;

export function defineView(view) {
  if (!view || typeof view.id !== 'string' || typeof view.mount !== 'function') {
    throw new Error('view 必须有 id 和 mount()');
  }
  registry.set(view.id, view);
  return view;
}

export function getViews() { return Array.from(registry.values()); }

export function currentRoute() {
  const m = /^#\/?([a-z0-9_-]+)/i.exec(location.hash || '');
  return m ? m[1].toLowerCase() : '';
}

export function navigate(id) {
  const next = '#/' + id;
  if (location.hash === next) { render(); return; }
  location.hash = next;
}

function showError(message) {
  if (!rootEl) return;
  rootEl.innerHTML = '';
  const box = document.createElement('section');
  box.className = 'card';
  const h = document.createElement('h2');
  h.textContent = '页面加载失败';
  const p = document.createElement('div');
  p.className = 'meta err';
  p.textContent = String(message);
  box.append(h, p);
  rootEl.appendChild(box);
}

async function render() {
  let id = currentRoute();
  if (!registry.has(id)) {
    id = fallbackId;
    if (id && currentRoute() !== id) {
      try { history.replaceState(null, '', '#/' + id); } catch (e) { location.hash = '#/' + id; }
    }
  }
  const view = registry.get(id);
  if (!view) { showError(`未知分区：#${currentRoute()}`); return; }

  // 早返回必须在领序号之前：否则一次「同分区的重复 hashchange」也会把序号 +1，
  // 让正在挂载中的那次 render 误判自己过期，于是刚挂好的分区被 cleanup 掉——
  // DOM 还在、tracker/轮询/守卫却已经死了（jsdom 回归测试抓到的就是这个）。
  if (id === activeId) return;

  // 当前分区有未保存改动时先问一句；用户选择「留下」就把地址栏改回去、DOM 原样不动
  // （旧分区还挂着，导航高亮也没变）。
  if (activeId) {
    const ok = await confirmLeave();
    if (!ok) {
      try { history.replaceState(null, '', '#/' + activeId); } catch (e) { /* 忽略 */ }
      return;
    }
    // 等用户确认期间可能又切了一次，交给那一次 render 处理
    if (currentRoute() !== id) return;
    // 同一 tick 里的两次 hashchange 可能都在等守卫：先到的那次已经挂上了，这次就别重复挂
    if (id === activeId) return;
  }

  // 到这里才算一次真正的切换，序号只在这里前进：
  // 只有「已经替换了 rootEl」的新 render 才会让旧的 render 作废。
  const mySeq = ++seq;

  if (teardown) {
    try { teardown(); } catch (e) { /* 单个 view 的清理失败不该影响切换 */ }
    teardown = null;
  }
  stopAll();
  activeId = id;

  navigateHook(view);
  rootEl.innerHTML = '<div class="view-loading">加载中…</div>';

  let cleanup;
  try {
    cleanup = await view.mount(rootEl);
  } catch (e) {
    if (mySeq === seq) {
      activeId = null; // 允许用户点回来重试
      navigateHook(view);
      showError(e?.message ?? e);
    }
    return;
  }
  // 加载期间用户又切走了：丢掉这次结果，别把旧内容留在新页面上
  if (mySeq !== seq) {
    if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { /* 忽略 */ } }
    return;
  }
  if (typeof cleanup === 'function') teardown = cleanup;
}

export function startRouter({ root, fallback, onNavigate }) {
  rootEl = root;
  fallbackId = fallback || '';
  if (typeof onNavigate === 'function') navigateHook = onNavigate;
  window.addEventListener('hashchange', () => { render(); });
  return render();
}

/** 强制重挂当前 view（保存完参数后想整页重读时用） */
export async function reloadView() {
  activeId = null;
  await render();
}
