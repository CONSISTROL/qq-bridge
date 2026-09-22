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

export async function api(path, method = 'GET', body, _retried = 0) {
  const headers = {};
  if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers['x-console-token'] = token;

  let res;
  try {
    res = await fetch(path, {
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
