// 通用 DOM 小工具。所有 view 共用，避免每个文件各写一份 esc/查询/提示。

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// 事件委托：根节点上挂一个监听，命中 selector 才回调。
// 旧控制台在顶层写了 40+ 个 getElementById(...).addEventListener，
// 任何一个 id 写错都会让后面所有绑定整段失效——这是重写要解决的主要问题之一。
export function delegate(root, type, selector, handler) {
  root.addEventListener(type, (ev) => {
    const node = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (!node || !root.contains(node)) return;
    handler(ev, node);
  });
}

export function toast(message, kind = 'info', ttl = 4200) {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  node.textContent = String(message ?? '');
  wrap.appendChild(node);
  setTimeout(() => node.remove(), ttl);
  return node;
}

// 就地写一行状态文字（原来的 .meta + 绿/红）
export function setMsg(target, text, ok = true) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return;
  node.textContent = text ?? '';
  node.classList.remove('ok', 'err');
  if (text) node.classList.add(ok ? 'ok' : 'err');
}

export function confirmDanger(message) { return window.confirm(message); }

export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// 毫秒 → 「1 分 05 秒」这类人类可读的时长
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '-';
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  return `${s} 秒`;
}

// 时间戳 → 本地时间字符串；解析不了就原样显示
export function fmtClock(value) {
  if (value == null || value === '') return '-';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('zh-CN', { hour12: false });
}

// 逗号分隔文本 ⇄ 数组（白名单、关键词等输入框共用）
export function parseList(text) {
  return String(text ?? '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function joinList(list) {
  return (Array.isArray(list) ? list : []).join(', ');
}
