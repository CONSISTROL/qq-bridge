// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-dsh-token-discovery.mjs',
  // 主题探索的纯逻辑（提示词/解析容错/队列预算去重）
  'test-topic-explore.mjs',
  // 豆包接入的纯逻辑（提问词/回答解析/证据分级/**交叉验证护栏**）
  'test-doubao.mjs',
  // 出站口播清洗（「行，」「总结：」这类确定性 AI 标签，靠提示词压不住）
  'test-speech-style.mjs',
  // 机器人资料的纯逻辑（内容校验/广告识别/变更历史/回滚取值）
  'test-self-profile.mjs',
  // stop.sh 的兜底清理：只认真实的 node 进程，不能按命令行子串误杀调用方
  // （实测 `node --check src/bridge.js && ./restart.sh` 会把执行它的 shell 杀掉）。
  'test-stop-guard.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
