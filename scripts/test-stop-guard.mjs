// stop.sh 的「兜底清理」不能靠命令行子串匹配（纯离线；只起几个自己的替身进程，不碰真桥接）。
//
// 背景（实测事故）：stop.sh 里原先是
//     pkill -f 'node .*src/bridge\.js'
// 这是命令行**子串**匹配，凡命令行里出现过这个路径的进程都会中枪。于是执行
//     node --check src/bridge.js && ./restart.sh
// 时，restart.sh → stop.sh 的 pkill 把**调用它的那个 shell 自己**杀了（bash 的 cmdline
// 里含 `node --check src/bridge.js`），整条命令 SIGTERM 中断。编辑器、grep、tail 同理。
//
// 现在按 argv 判断：argv 里要有 node 可执行文件，且它后面有一个参数正好是目标脚本，
// 中间不能有 --check/-e 这类「跑了但不是跑服务」的开关。这个测试就钉住这几条判据。
//
// 用法：node scripts/test-stop-guard.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP = path.join(ROOT, 'stop.sh');
let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const stopSrc = fs.readFileSync(STOP, 'utf8');
// 只对**可执行行**做静态断言：注释里会引用那条老写法做说明，不该算命中。
const stopCode = stopSrc.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

// ── 静态：不再有裸的子串 pkill/pgrep ──────────────────────────────────────
console.log('## 静态检查');
ok(!/pkill\s+-f/.test(stopCode), 'stop.sh 可执行部分不再有 pkill -f（子串匹配是误杀根源）');
ok(!/pgrep\s+-f\s+'node/.test(stopCode), '残留检查不再直接用 pgrep -f 判定');
ok(/is_node_script_pid/.test(stopCode), '按 argv 判断的 is_node_script_pid 就位');
ok(/kill_node_scripts\s+'src\/bridge\.js'/.test(stopCode), '桥接兜底清理走 kill_node_scripts');
ok(/kill_node_scripts\s+'src\/embedder\.js'/.test(stopCode), 'embedder 兜底清理同样走安全路径');
ok(/list_node_script_pids/.test(stopCode), '残留提示也用同一套判定');

// ── 动态：把 stop.sh 的函数定义抽出来，对替身进程逐个判定 ────────────────
// 只取到「1) 守护循环」之前的函数定义区，避免 source 整个脚本（那会把真桥接停掉）。
const head = stopSrc.slice(0, stopSrc.indexOf('# 1) 守护循环'));
if (!head.includes('is_node_script_pid')) {
  console.log('  ❌ 抽不出 is_node_script_pid 定义，动态用例无法运行');
  fail += 1;
}
const runner = `${head}\nif is_node_script_pid "$1" "$2"; then echo MATCH; else echo NOMATCH; fi\n`;

function classify(pid, script = 'src/bridge.js') {
  const r = spawnSync('bash', ['-s', '--', String(pid), script], {
    input: runner, encoding: 'utf8', cwd: ROOT, timeout: 15000
  });
  return { verdict: (r.stdout || '').trim().split('\n').pop() || `ERR:${r.stderr || r.status}`, stderr: r.stderr || '' };
}
/** 判定结果 + 「不许往 stderr 吐东西」（basename 收到 -c 这类参数时会喷 usage）。 */
function verdict(pid, script = 'src/bridge.js') {
  const { verdict: v, stderr } = classify(pid, script);
  if (stderr.trim()) return `${v} (stderr: ${stderr.trim().split('\n')[0]})`;
  return v;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-guard-'));
const spawned = [];
function spawnDecoy(argv) {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: false });
  spawned.push(child);
  return child;
}

try {
  console.log('## 动态：必须被识别为「不是桥接进程」（不能被误杀）');
  // ① 调用方 shell：cmdline 里含 `node --check src/bridge.js` 这种字面量 —— 就是真事故那条。
  const shellDecoy = spawnDecoy(['bash', '-c', 'cd /home/wx/qq-bridge && node --check src/bridge.js && sleep 30']);
  // ② 只把路径当普通参数的 shell（argv 里有 src/bridge.js，但程序是 bash）。
  const argDecoy = spawnDecoy(['bash', '-c', 'sleep 30', 'src/bridge.js']);
  // ③ node 跑别的东西，路径只是它的一个参数（-e 求值，不是跑服务）。
  const evalDecoy = spawnDecoy(['node', '-e', 'setTimeout(()=>{},30000)', 'src/bridge.js']);
  // ④ grep / tail 这类只提到路径的进程。
  const grepDecoy = spawnDecoy(['grep', '-r', 'src/bridge.js', '/dev/null']);

  for (const [label, child] of [['调用方 shell（含 node --check src/bridge.js 字面量）', shellDecoy], ['bash 把 src/bridge.js 当普通参数', argDecoy], ['node -e 求值（不是跑服务）', evalDecoy], ['grep 提到路径', grepDecoy]]) {
    const got = verdict(child.pid);
    ok(got === 'NOMATCH', `不误杀：${label}`, got);
  }

  console.log('## 动态：必须被识别为「真正的桥接进程」（要能兜底杀掉）');
  const fakeDir = path.join(tmp, 'src');
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeBridge = path.join(fakeDir, 'bridge.js');
  fs.writeFileSync(fakeBridge, 'setTimeout(() => {}, 30000);\n');
  // ① 相对路径形式：node src/bridge.js（start.sh 就是这么拉起来的）—— 用 cwd 对齐到一个假 ROOT。
  const relDecoy = spawnDecoy(['node', 'src/bridge.js']);
  // 上面这个进程的 cwd 是测试进程的 cwd；argv 里就是字面 `src/bridge.js`，正是要认的形态。
  // ② 绝对路径形式：/usr/bin/node /abs/path/src/bridge.js（embedder 就是这么被 spawn 的）。
  const absDecoy = spawnDecoy(['node', fakeBridge]);
  for (const [label, child] of [['node src/bridge.js（相对路径）', relDecoy], ['node /abs/…/src/bridge.js（绝对路径）', absDecoy]]) {
    const got = verdict(child.pid);
    ok(got === 'MATCH', `能兜底：${label}`, got);
  }

  console.log('## 动态：embedder 的脚本名独立判定');
  const fakeEmb = path.join(fakeDir, 'embedder.js');
  fs.writeFileSync(fakeEmb, 'setTimeout(() => {}, 30000);\n');
  const embDecoy = spawnDecoy(['node', fakeEmb]);
  ok(verdict(embDecoy.pid, 'src/embedder.js') === 'MATCH', 'embedder 进程按 src/embedder.js 能命中');
  ok(verdict(embDecoy.pid, 'src/bridge.js') === 'NOMATCH', 'embedder 进程不会被当成 bridge（脚本名要精确匹配）');
} finally {
  for (const child of spawned) {
    try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
