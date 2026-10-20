// QQ 桥接模式控制台（host 插件，仅注册 settings 命名空间）。
//
// 【2026-10-11 重写】原实现用的是 DSH 0.1.x 的 API：
//     ctx.settings.register('qq-mode', Schema, { base, applies })
//   而 DSH 0.2.0 换成了「导出 Config schema + settings.configure()」：
//     const Config = z.object({...});
//     ctx.inject(['settings'], (child) => child.effect(() =>
//       child.settings.configure({ auto: false }, ctx.fiber)));
//   证据：插件自己的诊断日志在 2026-10-07T17:27 之后一直记录
//   "settings service unavailable"（ctx.settings 存在，但没有 register 方法），
//   随后桥接控制台切换模式时报：
//     settings.update failed: settings/rejected: No configurable plugin entry "qq-mode"
//   —— 因为命名空间从未注册成功，DSH 的 configEditor 里找不到 id 为 qq-mode 的条目。
//
// 命名空间来源：profile 的 cordis.patch.yml 里那个 `id: qq-mode` 的插件条目。
// 字段只有 mode / ownerQQ，桥接按 { ns: 'qq-mode', patch: { mode } } 读写。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAG = path.join(__dirname, '..', '..', '..', 'state', 'qq-mode-plugin.log');

// diag 必须在 loadZ 之前定义：loadZ 内部会用它记录失败原因。
function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * 复用 DSH 自己的 schemastery 实例，而不是插件依赖树里那份。
 *
 * 原因：插件的 package.json 声明 `^3.18.1`，pnpm 解析到 3.18.1，
 * 而 3.18.1 的 schema **没有** `.volatile()` 方法（实测
 * `z.string().volatile === undefined`）；DSH 0.2.0 内部用的是 3.18.4，有该方法。
 * 而 dsh-settings 写设置时要求字段必须是 volatile，否则抛
 * `Plugin entry "qq-mode" has no volatile fields`。
 *
 * 直接升仓库依赖会影响其它代码，所以这里只把 schema 工厂指向 DSH 的那份。
 *
 * ⚠️ 不能用 req.resolve('@deepseek-ai/dsh-settings/package.json') 来定位 DSH：
 * 实测它会解析到**仓库自己的** node_modules（profile 里 dsh-settings 也是一条软链），
 * 从而又拿回 3.18.1。所以这里改用绝对路径，并逐个候选探测。
 */
const Z_CANDIDATES = [
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs',
];

function loadZ() {
  const req = createRequire(import.meta.url);
  for (const zPath of Z_CANDIDATES) {
    try {
      if (!fs.existsSync(zPath)) continue;
      const mod = req(zPath);
      const zz = mod?.default ?? mod;
      const vol = typeof zz?.string === 'function' ? typeof zz.string().volatile : 'n/a';
      // 只接受真正支持 volatile 的那一份；否则继续试下一个候选
      if (vol === 'function') return zz;
      diag(`loadZ 跳过 path=${zPath}（volatile=${vol}）`);
    } catch (error) {
      diag(`loadZ 失败 path=${zPath}: ${error?.message ?? error}`);
    }
  }
  diag('loadZ 未找到支持 volatile 的 schemastery');
  return null;
}

const z = loadZ();

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

/** 设置 schema：桥接只读写 mode / ownerQQ。
 *
 * 字段必须标 `.volatile()`：dsh-settings 的 write() 会调用 volatileForm(schema)，
 * 没有任何 volatile 字段时抛 `Plugin entry "qq-mode" has no volatile fields`。
 * 参考官方 dsh-client-ui-settings-general：
 *   const Config = z.object({ welcomeNoticeVersion: z.string().volatile() });
 *
 * ⚠️ volatile() 必须在 default()/description() 之前调用：
 * 后者返回的是不同类型的包装对象，链式调用后再 volatile() 会抛
 *   TypeError: ....description(...).volatile is not a function
 * （这个错误会让整个插件 import 失败、apply 根本不执行，日志里什么都看不到。）
 */
if (!z || typeof z.object !== 'function') {
  throw new Error(
    'qq-mode-console: 未能加载 DSH 的 @deepseek-ai/schemastery（需要支持 .volatile() 的版本，>=3.18.4）',
  );
}

export const Config = z.object({
  ownerQQ: z
    .string()
    .volatile()
    .default('')
    .description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

export function apply(ctx) {
  diag(`apply called, settings=${typeof ctx.settings}`);
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => {
        try {
          child.settings.configure({ auto: false }, ctx.fiber);
          diag('configure ok (namespace=qq-mode, auto=false)');
          console.log(`[qq-mode-console] active (namespace=${QQMODE_NAMESPACE})`);
        } catch (error) {
          diag(`configure threw: ${error?.stack ?? error}`);
        }
      });
    });
  } catch (error) {
    diag(`apply threw: ${error?.stack ?? error}`);
    throw error;
  }
}
