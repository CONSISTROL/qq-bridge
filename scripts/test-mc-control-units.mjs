// mc-control.js 的静态契约检查（不连 tzd、不改任何东西）。
//
// 这里守的是一个真实踩过的 bug：`systemctl is-active <unit>` 对 **inactive** 的 unit
// 返回退出码 3，而 sshScript 用「ssh 退出码非零」判定失败 —— 于是
// 「停 AI」这类动作明明成功了，却返回 ok:false（我们真的遇到过：
// mcmind 已经 inactive，controlAi('stop') 却报 Command failed）。
// 因此每个控制脚本末尾的 is-active 都必须带 `|| true`，
// 让退出码反映「动作是否执行」，而不是「服务当前是否在跑」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'mc-control.js'), 'utf8');
let failures = 0;
const ok = (c, label, extra = '') => { console.log(`${c ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`); if (!c) failures += 1; };

// ① 取出所有含 is-active 的脚本行，逐条要求带 `|| true`
const lines = src.split('\n');
const activeLines = lines
  .map((text, i) => ({ n: i + 1, text }))
  .filter(({ text }) => text.includes('is-active') && !text.trim().startsWith('//') && !text.trim().startsWith('*'));
ok(activeLines.length >= 4, `找到 ${activeLines.length} 处 is-active 调用`);
for (const { n, text } of activeLines) {
  // getMcServices 那处用的是 $(systemctl is-active ...) 命令替换，退出码被 printf 吸收，天然安全
  const inSubshell = /\$\(systemctl is-active/.test(text);
  const guarded = /\|\|\s*true/.test(text);
  ok(inSubshell || guarded, `第 ${n} 行 is-active 不会把「服务已停」当成执行失败`, inSubshell ? '(命令替换，安全)' : guarded ? '' : text.trim().slice(0, 70));
}

// ② 三个控制函数都要存在且是导出的
for (const fn of ['controlStream', 'controlAi', 'controlServer', 'controlLive']) {
  ok(new RegExp(`export async function ${fn}\\b`).test(src), `导出 ${fn}`);
}

// ③ 启停 AI 必须先停旧 bot（mcmind 与 mcbot 同名会互相顶号）
const aiBody = src.slice(src.indexOf('export async function controlAi'));
ok(/stop \$\{UNITS\.legacyBot\}/.test(aiBody.slice(0, 900)), 'controlAi 会先停 legacyBot（避免同名顶号）');

// ④ 开播路径必须带 ipv4first（tzd 上 DNS 给 AAAA 但 IPv6 不通，Node fetch 会超时）
const liveBody = src.slice(src.indexOf('export async function controlLive'));
ok(/dns-result-order=ipv4first/.test(liveBody.slice(0, 900)), 'controlLive 带 --dns-result-order=ipv4first');
ok(/60043|人脸/.test(liveBody), 'controlLive 能识别 B站人脸认证（60043）');

// ⑤ 白名单：实现必须存在，且非法输入在进入 RCON 之前就被拒绝
for (const fn of ['getWhitelist', 'whitelistAction']) {
  ok(new RegExp(`export async function ${fn}\\b`).test(src), `导出 ${fn}`);
}
const { whitelistAction } = await import('../src/mc-control.js');
const badName = await whitelistAction('add', 'x; rm -rf /');
ok(badName.ok === false && /玩家名/.test(badName.error), '非法玩家名不会进入 RCON（命令注入防线）');
const badAction = await whitelistAction('stop', 'Notch');
ok(badAction.ok === false && /未知动作/.test(badAction.error), '未知动作被拒绝（只接受固定枚举）');

console.log(failures ? `\n❌ ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
