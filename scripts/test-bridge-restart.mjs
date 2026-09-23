// 「重启桥接」按钮的行为约束（纯离线，读源码断言）。
//
// 背景：控制台按钮曾经只做 `releaseLock(); process.exit(0)`，默认「有守护窗口会把我拉起来」。
// 但手动 `node src/bridge.js` 启动时没有守护，按一下桥接就永久下线（真事故）。
// 现在分两条路：start.bat 会设 QQ_BRIDGE_GUARDED=1（守护模式，只退出）；没有这个变量时
// 桥接自己 detached 拉一个新进程。这个测试就是钉住这两条路，防止有人把自我重启删掉。
//
// 用法：node scripts/test-bridge-restart.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const startBat = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');

console.log('## 守护模式判定');
ok(/QQ_BRIDGE_GUARDED/.test(bridge), 'bridge 会检查 QQ_BRIDGE_GUARDED');
ok(/set QQ_BRIDGE_GUARDED=1/.test(startBat), 'start.bat 会设置 QQ_BRIDGE_GUARDED=1（守护窗口启动的实例）');
ok(!/QQ_BRIDGE_GUARDED/.test(fs.readFileSync(path.join(ROOT, 'restart.bat'), 'utf8')), 'restart.bat 不设这个变量（它先杀旧实例再起守护，不需要自我重启）');

console.log('## 两条重启路径');
const restartBlock = bridge.slice(bridge.indexOf("url.pathname === '/api/restart'"), bridge.indexOf("url.pathname === '/api/restart'") + 2600);
ok(/const guarded = String\(process\.env\.QQ_BRIDGE_GUARDED \?\? ''\) === '1'/.test(restartBlock), '按环境变量分流');
ok(/if \(!guarded\)/.test(restartBlock), '非守护模式走自我重启分支');
ok(/detached: true/.test(restartBlock) && /child\.unref\(\)/.test(restartBlock), '新进程 detached + unref（父进程退出后仍然活着）');
ok(/process\.platform === 'win32'/.test(restartBlock) && /'sh'/.test(restartBlock), 'win32 用 cmd、其它平台用 sh（跨平台）');
ok(/sleep 1; exec/.test(restartBlock), '新进程先等 1s：让 HTTP 端口与单实例锁释放，避免自我重启撞锁');
ok(/releaseLock\(\);[\s\S]{0,80}process\.exit\(0\)/.test(restartBlock), '无论哪条路都会先释放锁再退出');
ok(/respawned/.test(restartBlock) && /message: guarded/.test(restartBlock), '回执里说明走的是哪条路（不再笼统说“5 秒后恢复”）');
ok(!/child\.stdout|stdio: 'pipe'/.test(restartBlock), '不吞掉子进程输出（手动启动时日志还留在终端）');
ok(/stdio: 'inherit'/.test(restartBlock), '子进程继承 stdio，终端里能看到新实例的日志');

// ── Linux / macOS 脚本：bat 只能在 Windows 用，这套必须与 bat 语义对齐 ──
console.log('## Linux/macOS 脚本');
import { execFileSync } from 'node:child_process';
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
for (const name of ['start.sh', 'stop.sh', 'restart.sh', 'status.sh']) {
  const abs = path.join(ROOT, name);
  ok(fs.existsSync(abs), `${name} 存在`);
  if (!fs.existsSync(abs)) continue;
  ok((fs.statSync(abs).mode & 0o111) !== 0, `${name} 可执行位已设置`);
  let syntax = '';
  try { execFileSync('bash', ['-n', abs], { stdio: 'pipe' }); } catch (error) { syntax = String(error.stderr || error.message); }
  ok(!syntax, `${name} bash -n 语法检查通过`, syntax.split('\n')[0]);
}
const startSh = read('start.sh');
const stopSh = read('stop.sh');
const restartSh = read('restart.sh');
ok(/export QQ_BRIDGE_GUARDED=1/.test(startSh), 'start.sh 设置 QQ_BRIDGE_GUARDED=1（与 start.bat 的守护语义一致）');
ok(/wait "\$child"/.test(startSh) && /-eq 2/.test(startSh), 'start.sh 是守护循环：等子进程退出、退出码 2 = 已有实例则收工');
ok(/trap 'cleanup; exit 0' INT TERM/.test(startSh), 'start.sh 收到 Ctrl+C/SIGTERM 会结束循环（不会把刚停的桥接又拉起来）');
ok(/QQ_BRIDGE_GUARDED/.test(startSh) && !/QQ_BRIDGE_GUARDED/.test(stopSh), '守护标记只在 start.sh 里设，stop/restart 不碰');
ok(/bridge-guard\.pid/.test(startSh) && /bridge-guard\.pid/.test(stopSh), '守护 PID 落盘，stop/restart 才能精确杀守护');
ok(/先停守护循环/.test(stopSh) && stopSh.indexOf('bridge-guard.pid') < stopSh.indexOf('bridge.lock'), 'stop.sh 先停守护再停桥接（顺序反了会被守护拉起来）');
ok(/'node .\*src\/bridge\\\.js'/.test(stopSh) || /node .\*src\/bridge\\.js/.test(stopSh), 'stop.sh 兜底按命令行匹配（`node src/bridge.js` 相对路径也能命中）');
ok(/rm -f state\/bridge\.lock/.test(stopSh), 'stop.sh 清单实例锁，避免下次误报「已有实例在运行」');
ok(/\.\/stop\.sh/.test(restartSh) && /nohup bash \.\/start\.sh/.test(restartSh), 'restart.sh = 先 stop.sh 再 nohup 拉守护');
ok(/--fg/.test(restartSh) && /exec bash \.\/start\.sh/.test(restartSh), 'restart.sh --fg 支持前台守护');
ok(/bridge-guard\.pid/.test(read('status.sh')) || /bridge\.lock/.test(read('status.sh')), 'status.sh 会读守护/桥接 PID');
ok(/install/.test(restartSh) === false, 'restart.sh 不做 npm install 之类的副作用');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
