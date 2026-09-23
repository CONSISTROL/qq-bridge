// DSH launch token 自动发现的回归测试（不需要 DSH 在跑）。
//
// 守的是一个真踩过的坑：guard 日志是**追加写**的，同一个文件里会累积多次 DSH 重启的
// 启动记录（本机实测 6 次）。如果取第一个 token，就会永远用最早那次启动的 token ——
// DSH 一重启桥接就永久 401，而且 invalidateAuth() 重新发现拿到的还是同一个旧值，
// "401 自动重新发现" 的自愈逻辑等于没写。
//
// 用法：node scripts/test-dsh-token-discovery.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverDshLaunchToken } from '../src/dsh-client.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
const logsDir = path.join(home, 'guard', 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const writeLog = (name, text, mtimeMs) => {
  const file = path.join(logsDir, name);
  fs.writeFileSync(file, text);
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};

const logWith = (...tokens) => tokens
  .map((t, i) => `[guard] 启动 DSH #${i + 1}\ndsh web: http://127.0.0.1:3080/?token=${t}\n`)
  .join('');

// 模拟本机实况：一个文件里累积了多次重启
writeLog('server-manual.out.log', logWith('OLD_TOKEN_1', 'OLD_TOKEN_2', 'CURRENT_TOKEN_9'), Date.now());

console.log('DSH launch token 自动发现测试\n');

check('同一个日志文件里取最后一次启动的 token', () => {
  process.env.DSH_HOME = home;
  assert.equal(discoverDshLaunchToken(), 'CURRENT_TOKEN_9');
});

check('多个日志文件时优先最新修改的那个', () => {
  writeLog('server-old.out.log', logWith('ANCIENT_TOKEN'), Date.now() - 86_400_000);
  process.env.DSH_HOME = home;
  assert.equal(discoverDshLaunchToken(), 'CURRENT_TOKEN_9');
});

check('最新文件里没有 token 时退回更早的文件', () => {
  writeLog('server-newest.out.log', '[guard] 这次启动没打印 web 地址\n', Date.now() + 1000);
  process.env.DSH_HOME = home;
  assert.equal(discoverDshLaunchToken(), 'CURRENT_TOKEN_9');
});

check('日志目录不存在时返回空串（不抛错）', () => {
  process.env.DSH_HOME = path.join(home, 'nope');
  assert.equal(discoverDshLaunchToken(), '');
});

check('token 用 & 分隔时也能认出来', () => {
  writeLog('server-amp.out.log', 'dsh web: http://127.0.0.1:3080/?a=1&token=AMP_TOKEN_7\n', Date.now() + 2000);
  process.env.DSH_HOME = home;
  assert.equal(discoverDshLaunchToken(), 'AMP_TOKEN_7');
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败 ❌` : '，全部通过 ✅'}`);
if (failed) process.exit(1);
