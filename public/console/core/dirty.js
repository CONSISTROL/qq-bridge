// 「改动未保存」追踪 + 切换分区前的离开确认。
//
// 控制台的交互约定（改这次之前是反过来的，容易误判）：
//   * 开关（.switch）= 单点配置，拨动即写盘、立即生效；
//   * 参数（数字/文本/下拉）= 成组配置，改完点保存。
// 这个模块负责后者：统计有几项和基线不一致、通知界面画提示、
// 在切换分区或关页面时拦一下，避免「改了半天结果没保存」。
import { $$ } from './dom.js';

// 同一时刻只会挂载一个 view，但一个 view 里可能同时有多个「未保存」区域
// （比如二代主表单 + 工具级配置弹窗），所以守卫是个集合：任何一个说「不能走」就拦下。
const guards = new Set();

/** 注册一个离开守卫，返回注销函数。 */
export function setLeaveGuard(fn) {
  guards.add(fn);
  return () => guards.delete(fn);
}

export function clearLeaveGuard() { guards.clear(); }

export async function confirmLeave() {
  for (const guard of [...guards]) {
    try {
      if ((await guard()) === false) return false;
    } catch (e) { /* 守卫自身出错不该把人锁在页面里 */ }
  }
  return true;
}

// 控件 key：优先 id，其次 name，再退到 data 属性。
// 工具配置弹窗里的字段是动态生成、没有 id 的，只能靠 data-v2-cfg-field 认。
function controlKey(el) {
  return el.id || el.name || el.dataset?.v2CfgField || el.getAttribute?.('data-key') || '';
}
function controlValue(el) {
  if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
  return el.value;
}

/**
 * 追踪一组控件的「未保存」状态。
 * @param {HTMLElement} root 视图根节点（事件委托挂这里）
 * @param {object} opts
 * @param {string} opts.selector 参与统计的控件选择器（只放参数类控件，别把开关/搜索框算进去）
 * @param {(count:number)=>void} opts.onChange 数量变化时回调（画提示、点亮保存按钮）
 * @param {string} [opts.label] 离开确认里的名字，如「社交参数」
 * @param {string} [opts.interactionScope] 判定「用户碰过这块区域」的范围选择器（默认整块 root）。
 *   工具配置弹窗必须传 '#v2CfgBody'：打开弹窗的 ⚙ 按钮在 root 里但在弹窗之外，
 *   若按 root 判定，点一下 ⚙ 就算「用户碰过」，紧接着的浏览器自动填充又会被算成改动。
 * @returns {{count:()=>number, markClean:()=>void, dispose:()=>void}}
 */
export function trackDirty(root, { selector, onChange, label = '当前页面', interactionScope = null }) {
  const controls = () => $$(selector, root).filter((el) => controlKey(el));

  const snapshot = () => {
    const map = new Map();
    for (const el of controls()) map.set(controlKey(el), controlValue(el));
    return map;
  };

  let baseline = snapshot();
  let dirty = false;
  let unloadArmed = false;
  let interacted = false;

  const count = () => {
    let n = 0;
    for (const el of controls()) {
      if (baseline.get(controlKey(el)) !== controlValue(el)) n += 1;
    }
    return n;
  };

  const onBeforeUnload = (e) => {
    // 浏览器只认 preventDefault + returnValue，且不会显示自定义文案
    e.preventDefault();
    e.returnValue = '';
  };

  const sync = () => {
    const n = count();
    const next = n > 0;
    if (next !== dirty) {
      dirty = next;
      if (dirty && !unloadArmed) { window.addEventListener('beforeunload', onBeforeUnload); unloadArmed = true; }
      if (!dirty && unloadArmed) { window.removeEventListener('beforeunload', onBeforeUnload); unloadArmed = false; }
    }
    if (typeof onChange === 'function') onChange(n);
  };

  // 「用户真的动过这块区域」：点进来、敲键盘、或把焦点放进某个控件。
  // 自动填充（浏览器密码管理器、扩展）既不点击也不聚焦，只会凭空把值写进去。
  const inScope = (target) => {
    if (!interactionScope) return true;
    return target instanceof Element && Boolean(target.closest(interactionScope));
  };
  const onGesture = (e) => { if (e.isTrusted !== false && inScope(e.target)) interacted = true; };

  const onInput = (e) => {
    const el = e.target;
    // 基线重建（也就是打开/保存后的那一刻）之后、用户还没碰过这块区域时冒出来的值，
    // 只可能是自动填充/程序写入 —— 不是用户的改动，直接并进基线。
    // 否则「打开工具配置再点取消」会凭空弹出「还有 1 项没保存」。
    if (!interacted && el && el !== document.activeElement && controls().includes(el)) {
      baseline.set(controlKey(el), controlValue(el));
    }
    sync();
  };
  root.addEventListener('pointerdown', onGesture, true);
  root.addEventListener('keydown', onGesture, true);
  root.addEventListener('focusin', onGesture, true);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);

  // 每个 tracker 只登记/注销自己的守卫，别去动别人的（主表单与弹窗要共存）
  const removeGuard = setLeaveGuard(() => {
    if (!dirty) return true;
    return window.confirm(`「${label}」还有 ${count()} 项改动没有保存，确定离开？`);
  });

  sync();

  return {
    count,
    /** 保存成功（并把表单按服务端返回值重新填充）之后调用，重建基线 */
    markClean() { baseline = snapshot(); interacted = false; sync(); },
    dispose() {
      root.removeEventListener('pointerdown', onGesture, true);
      root.removeEventListener('keydown', onGesture, true);
      root.removeEventListener('focusin', onGesture, true);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      if (unloadArmed) { window.removeEventListener('beforeunload', onBeforeUnload); unloadArmed = false; }
      removeGuard();
    }
  };
}
