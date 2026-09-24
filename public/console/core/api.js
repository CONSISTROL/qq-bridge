// 控制台 API 客户端：统一带令牌、统一 401 处理、统一错误信息。
import { toast } from './dom.js';

const TOKEN_KEY = 'consoleToken';
// 用户取消过一次输入令牌后就不再自动弹窗，否则 5 秒一次的轮询会变成弹窗轰炸。
// 手动操作（点按钮）里调 promptForToken() 仍然可以再弹。
let autoPromptAllowed = true;

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, String(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* 忽略 */ }
  autoPromptAllowed = true;
}

export function clearToken() { setToken(''); }

// 「忘记本机令牌」：清掉 localStorage 里的那份，并抑制自动弹窗——
// 否则点完按钮，下一个 5 秒轮询就会立刻弹一个输入框出来。
// 想重新进入时刷新页面即可：/ 会重新走 401 → 输入令牌的流程。
export function forgetToken() {
  clearToken();
  autoPromptAllowed = false;
}

// 通过 ?token=xxx 打开控制台时（根路径鉴权失败会重定向成这样）把令牌收进 localStorage，
// 然后从地址栏抹掉，避免令牌留在历史记录/截图里。
export function captureTokenFromUrl() {
  let qs;
  try { qs = new URLSearchParams(location.search); } catch (e) { return; }
  const token = qs.get('token');
  if (!token) return;
  setToken(token.trim());
  try { history.replaceState({}, '', location.pathname + location.hash); } catch (e) { /* 忽略 */ }
}

export function promptForToken() {
  const t = window.prompt('请输入控制台访问令牌：');
  if (!t || !t.trim()) return '';
  setToken(t.trim());
  return t.trim();
}

// 当前页面的挂载前缀（反代子路径）。取 `<base>` / 文档地址的目录部分：
//   直连 3100            → '/'
//   /local-web/http/127.0.0.1:3100/#/ops → '/local-web/http/127.0.0.1:3100/'
// baseURI 而不是 location.pathname：反代会注入 `<base href="<前缀>/">`，
// 而 location.pathname 在某些挂法下会少一个结尾斜杠。
function mountPrefix() {
  try {
    const p = new URL(document.baseURI).pathname;
    return p.endsWith('/') ? p : p + '/';
  } catch (e) {
    return '/';
  }
}

// 控制台可能被反代在**子路径**下（例如 https://anihub.xin/local-web/http/127.0.0.1:3100/），
// 那时根绝对地址 `/api/...` 会跑出前缀、打到反代自己的接口上（实测返回
// {"error":{"code":"NOT_FOUND","message":"接口不存在"}}）。所以这里统一把开头的 `/`
// 去掉，让浏览器按**当前页面**解析：直连 3100 是 `/api/...`，子路径反代是 `<前缀>/api/...`。
//
// ⚠ 但反代（AniHub 的 local-web 代理，见其 rewriteLocalJavaScript）会把发出去的 JS 里
// 的 `'/api/...'` 字面量**预先改写成** `'<前缀>/api/...'`。这时若还按「去掉开头 / 再相对
// 解析」，前缀会被拼第二遍，整站接口全 404：
//   `'/api/restart'` →（反代改写）`'<前缀>/api/restart'` →（这里去 / 相对解析）
//   `<前缀><前缀>/api/restart` → {"ok":false,"error":"not found"}
// 实测表现：控制台页面本身正常（HTML/JS 都是单前缀），但每个 /api 调用都 404，
// 「运维 → 重启桥接」只会提示 not found，且 nginx 日志里是一条双前缀的 404。
// 所以先判断「是不是已经带着当前挂载前缀」，是就原样用（它本身就是站点根下的绝对地址）
// —— 前提是路径不带兜底前缀时，两种反代行为（改写 / 不改写）都能落到 `<前缀>/api/...`。
export function relativeUrl(path) {
  const raw = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return raw; // 完整 URL / 协议相对，原样用
  const prefix = mountPrefix();
  if (prefix !== '/' && (raw === prefix.slice(0, -1) || raw.startsWith(prefix))) return raw; // 反代已改写，别再拼一遍
  return raw.replace(/^\/+/, '');
}

export async function api(path, method = 'GET', body, _retried = 0) {
  const headers = {};
  if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers['x-console-token'] = token;

  let res;
  try {
    res = await fetch(relativeUrl(path), {
      method,
      headers,
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('无法连接桥接：' + (e?.message ?? e));
  }

  if (res.status === 401) {
    if (_retried >= 2 || !autoPromptAllowed) {
      clearToken();
      throw new Error('未授权：控制台访问令牌无效');
    }
    if (!promptForToken()) {
      autoPromptAllowed = false;
      throw new Error('未授权：未提供控制台访问令牌');
    }
    return api(path, method, body, _retried + 1);
  }

  const text = await res.text();
  if (!text.trim()) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {};
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
  }
  return data;
}

// 包一层：失败时弹 toast 并返回 null，成功返回数据。
// 大多数 view 只需要「拿到就渲染、拿不到就提示」，不必每处都写 try/catch。
export async function apiSafe(path, method = 'GET', body, silent = false) {
  try {
    return await api(path, method, body);
  } catch (e) {
    if (!silent) toast(e?.message ?? String(e), 'err');
    return null;
  }
}
