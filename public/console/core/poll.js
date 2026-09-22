// 统一轮询调度器。
//
// 旧控制台在文件末尾挂了一个 setInterval(3s)，不管当前在看哪个分区，都把
// 会话/挂起/社交状态/黑话全刷一遍。现在按 view 注册：切走时 stopAll() 一次清空，
// 页面不可见时直接跳过，慢接口不会堆叠请求（busy 标记）。
const tasks = new Set();
let loop = null;

function tick() {
  if (document.hidden) return; // 页面在后台就别打桥接了
  const now = Date.now();
  for (const task of tasks) {
    if (task.busy || now - task.last < task.ms) continue;
    task.last = now;
    task.busy = true;
    Promise.resolve()
      .then(task.fn)
      .catch(() => {})
      .finally(() => { task.busy = false; });
  }
}

function ensureLoop() {
  if (loop) return;
  loop = setInterval(() => {
    if (tasks.size === 0) {
      clearInterval(loop);
      loop = null;
      return;
    }
    tick();
  }, 500);
}

/**
 * 注册一个周期性任务，返回停止函数。
 * @param {number} ms 周期（最小 250ms）
 * @param {Function} fn 任务体
 * @param {{immediate?: boolean}} opts immediate=true 时不等一个周期，下一次调度立刻跑
 */
export function every(ms, fn, { immediate = false } = {}) {
  const task = {
    ms: Math.max(250, Number(ms) || 1000),
    fn,
    last: immediate ? 0 : Date.now(),
    busy: false
  };
  tasks.add(task);
  ensureLoop();
  return () => tasks.delete(task);
}

/** 切换 view 时清空所有轮询（view 自己的 mount 清理逻辑之外的总闸） */
export function stopAll() {
  tasks.clear();
}

export function taskCount() { return tasks.size; }
