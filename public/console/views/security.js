// 白名单 / 管理员（10）、安全拦截通知（12）、控制台访问令牌（12b）
import { api, setToken, forgetToken } from '../core/api.js';
import { $, toast, setMsg, parseList, confirmDanger } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';
import { refreshStatus } from '../core/status.js';

export const id = 'security';
export const title = '白名单与安全';
export const desc = '群/私聊白名单、管理员、安全拦截通知、控制台令牌';
export const icon = '🔒';
export const group = '系统';
export const order = 3;

async function refreshWhitelist(view) {
  const w = await api('/api/whitelist').catch(() => null);
  if (!w) return;
  $('#wlGroups', view).value = (w.allow?.groups || []).join(', ');
  $('#wlPrivate', view).value = (w.allow?.private || []).join(', ');
  $('#ownerQQ', view).value = w.ownerQQ != null ? String(w.ownerQQ) : '';
  $('#dnGroups', view).value = (w.deny?.groups || []).join(', ');
  $('#dnPrivate', view).value = (w.deny?.private || []).join(', ');
}

async function loadSecurity(view) {
  const r = await api('/api/security').catch(() => null);
  if (r) $('#secInterceptNotify', view).checked = r.security?.interceptNotify !== false;
}

// 白名单/黑名单只接受数字；parseList 也认中文逗号和空格
const parseIds = (text) => parseList(text).map(Number).filter(Number.isFinite);

async function changeConsoleToken(view, generate) {
  const input = $('#consoleTokenInput', view);
  const msg = $('#consoleTokenMsg', view);
  const token = generate ? '' : input.value.trim();
  if (!generate && token && token.length < 16) {
    setMsg(msg, '❌ 令牌至少需要 16 位', false);
    return;
  }
  const r = await api('/api/console/token', 'POST', { token }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) {
    setMsg(msg, '❌ ' + (r.error || '修改失败'), false);
    return;
  }
  // 存到 localStorage，当前页面继续用新令牌（否则下一次轮询就 401 了）
  setToken(r.token);
  input.value = r.token;
  setMsg(msg, r.generated ? ('✅ 已生成随机令牌：' + r.token) : '✅ 已保存新令牌', true);
}

export async function mount(root) {
  const view = await mountFragment(root, 'security');
  await Promise.all([refreshWhitelist(view), loadSecurity(view)]);

  $('#wlSave', view).addEventListener('click', async () => {
    const r = await api('/api/whitelist', 'POST', {
      allow: { private: parseIds($('#wlPrivate', view).value), groups: parseIds($('#wlGroups', view).value) },
      deny: { private: parseIds($('#dnPrivate', view).value), groups: parseIds($('#dnGroups', view).value) },
      ownerQQ: $('#ownerQQ', view).value.trim()
    }).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      await refreshWhitelist(view);
      await refreshStatus();
      // 顶栏白名单摘要就是从这里来的，刷新后再提示
      toast('白名单已保存并生效', 'ok');
    } else {
      toast(r.error || '保存失败', 'err');
    }
  });

  $('#secSave', view).addEventListener('click', async () => {
    const r = await api('/api/security', 'POST', { interceptNotify: $('#secInterceptNotify', view).checked })
      .catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#secMsg', view), r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败')), r.ok);
  });

  $('#consoleTokenSave', view).addEventListener('click', () => changeConsoleToken(view, false));
  $('#consoleTokenRandom', view).addEventListener('click', () => changeConsoleToken(view, true));
  $('#consoleTokenForget', view).addEventListener('click', async () => {
    if (!confirmDanger('清除这个浏览器记住的令牌？\n下次打开控制台需要重新输入（令牌本身不变）。')) return;
    const r = await api('/api/console/logout', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    // 服务端清 Cookie，本地清 localStorage；两边都清掉才算真的「忘记」
    forgetToken();
    setMsg($('#consoleTokenMsg', view), r.ok ? '✅ 已忘记本机令牌；刷新页面会重新要求输入' : ('❌ ' + (r.error || '失败')), r.ok);
  });
}
