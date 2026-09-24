// 视图片段加载：每个分区一个 .html（markup 保持纯 HTML，不用在 JS 里拼字符串）。
// 路径必须**相对当前页面**（不能以 / 开头）：控制台可能被反代在子路径下，
// 根绝对地址会跑到反代自己的根上去（见 core/api.js 的 relativeUrl 说明）。
const cache = new Map();

export async function fragment(name) {
  if (!cache.has(name)) {
    const res = await fetch(`console/views/${name}.html`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`视图片段 ${name}.html 加载失败（HTTP ${res.status}）`);
    cache.set(name, await res.text());
  }
  return cache.get(name);
}

// 把片段塞进 <div class="view"> 里。片段自带的缩进会原样保留，不影响渲染。
export async function mountFragment(root, name) {
  root.innerHTML = `<div class="view">${await fragment(name)}</div>`;
  return root.firstElementChild;
}
