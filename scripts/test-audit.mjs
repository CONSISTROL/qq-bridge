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
  // 出站口播清洗（「行，」「总结：」这类确定性 AI 标签，靠提示词压不住）
  'test-speech-style.mjs',
  // 机器人资料的纯逻辑（内容校验/广告识别/变更历史/回滚取值）
  'test-self-profile.mjs',
  // 三级记忆：归档（追加/检索/保留期）+ 日记（保存/检索/召回触发词）
  'test-memory.mjs',
  // 控制台视图契约（id/title/mount/html 缺一不可，漏了会整站「加载中…」）
  'test-console-views.mjs',
  // 相册：统一索引 + 元数据（备注/标签/来源/添加时间）
  'test-album.mjs',
  // 表情包时机判定与选图（含严肃语境门、行动导向提示、一步发送指引）
  'test-sticker-picker.mjs',
  // 聊天文件读取（PDF → 文本；扫描件 → 渲染页面图）的纯逻辑 + 真 poppler 集成
  'test-file-extract.mjs',
  // stop.sh 的兜底清理：只认真实的 node 进程，不能按命令行子串误杀调用方
  // （实测 `node --check src/bridge.js && ./restart.sh` 会把执行它的 shell 杀掉）。
  'test-stop-guard.mjs',
];
let failed = 0;
// 单脚本超时：原本 60s，但 test-audit-bridge 现在有 150+ 个用例，其中一批是**真实等待**的时序用例
// （送达探针 deliverCheckMs、写类超时 wsTimeoutMs、重发退避……合计 30s 以上），60s 会偶发
// `spawnSync /usr/bin/node ETIMEDOUT`——那是超时不是断言失败，排查时会被误导（真实踩过两次）。
// 抬到 120s 留出余量；真卡住的用例仍然会在两分钟内暴露。
const SCRIPT_TIMEOUT_MS = 120000;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: SCRIPT_TIMEOUT_MS,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}（用时 ${seconds}s）`);
  } else {
    console.log(`(${test} 用时 ${seconds}s)`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
