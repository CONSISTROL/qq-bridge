// 运维：13 测试发送 + 14 桥接控制（重启 / 清空工作区）
import { api } from '../core/api.js';
import { $, toast, setMsg, confirmDanger } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'ops';
export const title = '运维';
export const desc = '测试发送、重启桥接、清空 QQ 聊天工作区';
export const icon = '🛠';
export const group = '系统';
export const order = 4;

export async function mount(root) {
  const view = await mountFragment(root, 'ops');

  $('#tsSend', view).addEventListener('click', async () => {
    const r = await api('/api/test-send', 'POST', {
      kind: $('#tsKind', view).value,
      id: $('#tsId', view).value.trim(),
      message: $('#tsMsg', view).value
    }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#tsMsg2', view), r.ok ? ('✅ 已发送 message_id=' + r.message_id) : ('❌ ' + (r.error || '失败')), r.ok);
  });

  $('#restartBtn', view).addEventListener('click', async () => {
    if (!confirmDanger('确定重启桥接？\n\n• 守护模式（start.bat）→ 退出后由守护窗口 5 秒拉起\n• 手动 node src/bridge.js → 桥接自己拉一个新进程（约 1 秒）\n\n重启期间 QQ 消息不会入队，会丢失约 5~10 秒窗口内的消息。')) return;
    const r = await api('/api/restart', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#restartMsg', view), r.message || r.error || '正在重启…', r.ok !== false);
  });

  $('#clearWsBtn', view).addEventListener('click', async () => {
    if (!confirmDanger('确定清空整个「QQ 聊天」工作区？\n将归档全部 QQ 会话、清除所有上下文映射、清空活动日志。\n此操作不可撤销。')) return;
    const r = await api('/api/workspace/reset', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#clearWsMsg', view), r.ok ? `✅ 已归档 ${r.archivedCount} 个会话，工作区已清空` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) toast('工作区已清空', 'ok');
  });
}
