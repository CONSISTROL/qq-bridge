// 用现有 fact/remark/knowledge 给 MEMORY.md 打底（一次性；之后由 AI 自己维护）。
import { listItems } from '../src/memdb.js';
import { addNote, readMemoryDoc } from '../src/memory-doc.js';

const STATE = new URL('../state', import.meta.url).pathname;
const items = listItems({ stateDir: STATE, limit: 500 });
let n = 0;
for (const it of items) {
  const text = String(it.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 6) continue;
  if (it.kind === 'remark') {
    // 备注通常是「昵称|说明」，拆成「昵称：说明」
    const [name, ...rest] = text.split('|');
    addNote({ stateDir: STATE, section: '人物', text: `${name.trim()}：${rest.join('|').trim()}`.slice(0, 160) });
    n += 1;
  } else if (it.kind === 'fact') {
    addNote({ stateDir: STATE, section: '约定', text: text.slice(0, 160) });
    n += 1;
  }
}
console.log(`写入/合并 ${n} 条，当前笔记 ${readMemoryDoc({ stateDir: STATE }).length} 字`);
