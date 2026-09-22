// 「改动未保存」追踪 + 切换分区前的离开确认。
//
// 控制台的交互约定（改这次之前是反过来的，容易误判）：
//   * 开关（.switch）= 单点配置，拨动即写盘、立即生效；
//   * 参数（数字/文本/下拉）= 成组配置，改完点保存。
// 这个模块负责后者：统计有几项和基线不一致、通知界面画提示、
// 在切换分区或关页面时拦一下，避免「改了半天结果没保存」。
import { $$ } from './dom.js';

// 同一时刻只会挂载一个 view，所以一个全局守卫就够；router 在切换前问它。
let leaveGuard = null;

export function setLeaveGuard(fn) { leaveGuard = fn; }
export function clearLeaveGuard() { if (leaveGuard) leaveGuard = null; }

export async function confirmLeave() {
  if (typeof leaveGuard !== 'function') return true;
  try { return (await leaveGuard()) !== false; } catch (e) { return true; }
}

function controlKey(el) { return el.id || el.name || ''; }
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
 * @returns {{count:()=>number, markClean:()=>void, dispose:()=>void}}
 */
export function trackDirty(root, { selector, onChange, label = '当前页面' }) {
  const controls = () => $$(selector, root).filter((el) => controlKey(el));

  const snapshot = () => {
    const map = new Map();
    for (const el of controls()) map.set(controlKey(el), controlValue(el));
    return map;
  };

  let baseline = snapshot();
  let dirty = false;
  let unloadArmed = false;

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

  const onInput = () => sync();
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);

  setLeaveGuard(() => {
    if (!dirty) return true;
    return window.confirm(`「${label}」还有 ${count()} 项改动没有保存，确定离开？`);
  });

  sync();

  return {
    count,
    /** 保存成功（并把表单按服务端返回值重新填充）之后调用，重建基线 */
    markClean() { baseline = snapshot(); sync(); },
    dispose() {
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      if (unloadArmed) { window.removeEventListener('beforeunload', onBeforeUnload); unloadArmed = false; }
      clearLeaveGuard();
    }
  };
}
