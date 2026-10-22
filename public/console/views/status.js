// 服务状态：整页嵌入 status.deepseek.com（隐藏顶栏、无内边距，铺满导航右侧）。
import { $ } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'status';
export const title = '服务状态';
export const desc = 'DeepSeek 服务可用性与最近事件（嵌入 status.deepseek.com）';
export const icon = 'ops';
export const group = '系统';
export const order = 2;

export async function mount(root) {
  const view = await mountFragment(root, 'status');
  const frame = $('#dsStatusFrame', view);
  if (frame) frame.src = 'https://status.deepseek.com/';   // 每次进来重新加载，保证是最新状态
}
