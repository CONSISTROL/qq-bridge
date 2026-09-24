// 控制台「子路径反代」下 API 地址的回归测试（不需要浏览器、不需要桥接）。
//
// 守的是一个真实踩到的坑（2026-09-25，AniHub 的 /local-web 反代）：
//   AniHub 的 local-web 代理会把转发出去的 JS 里 `'/api/...'` 字面量**预先改写成**
//   `'<前缀>/api/...'`（见其 rewriteLocalJavaScript），而控制台为了兼容子路径反代，
//   又在 relativeUrl() 里「去掉开头的 / 再按当前页面相对解析」——两次处理叠加，前缀被
//   拼了两遍：
//       POST /local-web/http/127.0.0.1:3100/local-web/http/127.0.0.1:3100/api/restart → 404
//   表现：控制台页面本身完全正常（HTML/JS 都是单前缀），但**所有** /api 调用 404，
//   「运维 → 重启桥接」只提示 not found，nginx 日志里是一条双前缀的 404。
//
// 另外还要覆盖「反代没改写 JS」的情况（升级/换中间层后可能发生），以及直连 3100。
//
// 用法：node scripts/test-console-subpath.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeUrl } from '../public/console/core/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DIRECT = 'http://127.0.0.1:3100/';
const PROXY = 'https://anihub.xin/local-web/http/127.0.0.1:3100/';
const PREFIX = '/local-web/http/127.0.0.1:3100';

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

// api.js 只在函数体里读 document，所以给个最小桩就够；每个用例换 baseURI。
globalThis.document = { baseURI: DIRECT };

/** 浏览器解析后的真实请求路径——这才是断言该看的东西（相对 vs 绝对都会归一）。 */
const resolve = (path, base) => new URL(relativeUrl(path), base).pathname;

console.log('控制台子路径反代 / API 地址回归测试\n');

// ── 1. 直连 3100：行为不变 ─────────────────────────────────────────
globalThis.document.baseURI = DIRECT;
check('直连：/api/status → /api/status', () => {
  assert.equal(relativeUrl('/api/status'), 'api/status');
  assert.equal(resolve('/api/status', DIRECT), '/api/status');
});
check('直连：完整 URL 原样透传', () => {
  assert.equal(relativeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(relativeUrl('//example.com/x'), '//example.com/x');
});

// ── 2. 反代 + JS 被改写（线上真实情况）：绝不能再拼一遍前缀 ──────────
globalThis.document.baseURI = PROXY;
check('反代：已被改写的 <前缀>/api/restart 原样使用（不双前缀）', () => {
  const rewritten = `${PREFIX}/api/restart`;
  assert.equal(relativeUrl(rewritten), rewritten, '已带前缀的地址必须原样返回');
  assert.equal(resolve(rewritten, PROXY), `${PREFIX}/api/restart`);
  assert.notEqual(resolve(rewritten, PROXY), `${PREFIX}${PREFIX}/api/restart`);
});
check('反代：带 query 的改写地址同样不双前缀', () => {
  const rewritten = `${PREFIX}/api/socialV2/tool-log?limit=200`;
  assert.equal(resolve(rewritten, PROXY), `${PREFIX}/api/socialV2/tool-log`);
  assert.equal(new URL(relativeUrl(rewritten), PROXY).search, '?limit=200');
});
check('反代：恰好等于前缀（无尾斜杠）时原样使用', () => {
  assert.equal(relativeUrl(PREFIX), PREFIX);
});

// ── 3. 反代 + JS 没被改写（代理升级/换中间层）：仍要落回前缀下 ──────
check('反代：未改写的 /api/status 仍落到 <前缀>/api/status', () => {
  assert.equal(relativeUrl('/api/status'), 'api/status');
  assert.equal(resolve('/api/status', PROXY), `${PREFIX}/api/status`);
});

// ── 4. 反代注入了 <base>，但地址栏少一个尾斜杠（baseURI 不带 /）──────
globalThis.document.baseURI = `https://anihub.xin${PREFIX}`;
check('反代：baseURI 无尾斜杠时前缀判定仍成立', () => {
  const rewritten = `${PREFIX}/api/status`;
  assert.equal(relativeUrl(rewritten), rewritten);
  assert.equal(resolve(rewritten, `${PROXY}`), `${PREFIX}/api/status`);
});
check('反代：baseURI 无尾斜杠且 JS 未改写时也不双前缀', () => {
  assert.equal(resolve('/api/status', PROXY), `${PREFIX}/api/status`);
});

// ── 5. 前缀只是普通路径前缀、并非当前挂载点时不能误判 ────────────────
globalThis.document.baseURI = DIRECT;
check('直连：形似前缀的路径不受影响', () => {
  assert.equal(resolve(`${PREFIX}/api/status`, DIRECT), `${PREFIX}/api/status`);
  assert.equal(resolve('/local-web/http/api/status', DIRECT), '/local-web/http/api/status');
});

// ── 6. 拿真实源码跑一遍「反代改写」：两种行为下都必须落到单前缀 ────────
// 这是最贴近线上的一组：把 public/console/**/*.js 里所有 api('...') 字面量
// 按 AniHub rewriteLocalJavaScript 的同一条正则处理，再看 relativeUrl 解析结果。
globalThis.document.baseURI = PROXY;
{
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'public', 'console'));

  // AniHub localWeb.js: out.replace(/(["'`])\/api\//g, `$1${prefix}/api/`)
  const REWRITE = /(["'`])\/api\//g;
  // api('/api/x') / api(`/api/x?a=${b}`) / apiSafe('...')：只取字面量开头那段
  const CALL = /\bapi(?:Safe)?\(\s*([`'"])((?:(?!\1)[\s\S])*?)\1/g;

  let seen = 0;
  for (const rewrite of [true, false]) {
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const text = rewrite ? src.replace(REWRITE, `$1${PREFIX}/api/`) : src;
      for (const match of text.matchAll(CALL)) {
        // 模板串里可能还有 ${...}：只保留开头的静态部分，足够判断前缀是否重复
        const literal = match[2].split('${')[0];
        if (!literal.startsWith('/api/') && !literal.startsWith(`${PREFIX}/api/`)) continue;
        const rel = path.relative(ROOT, file);
        assert.ok(
          rewrite ? literal.startsWith(`${PREFIX}/api/`) : literal.startsWith('/api/'),
          `${rel}: 改写模拟没生效（${literal}）`
        );
        const got = new URL(relativeUrl(literal), PROXY);
        const bare = literal.replace(PREFIX, ''); // 以 /api/... 开头，可能带 query
        const want = `${PREFIX}${bare.split('?')[0]}`;
        assert.equal(got.pathname, want, `${rel}: ${literal} → ${got.pathname}（期望 ${want}）`);
        assert.ok(!got.pathname.includes(`${PREFIX}${PREFIX}`), `${rel}: 前缀被拼了两遍 → ${got.pathname}`);
        if (bare.includes('?')) {
          const q = bare.slice(bare.indexOf('?'));
          // 模板串被截断成 "...?" 时 URL.search 会归一成空串
          assert.equal(got.search, q === '?' ? '' : q, `${rel}: ${literal} 的 query 被改坏了`);
        }
        seen += 1;
      }
    }
  }
  assert.ok(seen > 100, `样本太少（${seen}），正则可能已失配`);
  console.log(`  （真实源码样本：${seen} 个 api 字面量 × 2 种反代行为）`);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
