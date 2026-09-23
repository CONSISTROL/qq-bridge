// 无头浏览器渲染 / 出网过滤代理自检。
//
// 1) safe-proxy：内网/本机目标必须被拒（这是把无头浏览器放进来的**前提**——
//    桥接控制台 3100、DSH 3080 都在本机，页面 JS 绝不能碰到）；
// 2) browser-render：本地假 SPA 渲染后能拿到「只有执行 JS 才出现」的正文；
// 3) 生命周期：渲染完能关掉浏览器与代理，可用内存闸门函数可用；
// 4) 接线：mcp-web-search-safe.js 注册了 web_render 且指向渲染模块。
//
// puppeteer 是 optionalDependency（含 ~150MB Chromium），装不上时本脚本**跳过**而不是失败。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSafeProxy } from '../src/safe-proxy.js';
import { browserAvailable, renderPage, closeBrowser, availableMemoryBytes, MIN_FREE_BYTES } from '../src/browser-render.js';
import { looksLikeSpaShell, extractHtmlText } from '../src/html-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假 SPA：HTML 里没有任何正文，正文由 JS 注入 ──────────────────────────
const SPA_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>假 SPA 页面</title>
<script>window.__payload = { title: '渲染出来的标题', body: '这段正文只有执行 JS 才会出现。'.repeat(6) };</script>
</head><body><div id="app"></div>
<script>
  setTimeout(function () {
    document.getElementById('app').innerHTML =
      '<h1>' + window.__payload.title + '</h1><p>' + window.__payload.body + '</p>';
  }, 200);
</script></body></html>`;

console.log('## 出网过滤代理（SSRF 边界）');
{
  const proxy = await startSafeProxy({ log: () => {} });
  ok(proxy.port > 0, `代理已启动在 127.0.0.1:${proxy.port}`);

  // 通过代理 CONNECT 内网地址 → 必须被拒
  const connectThrough = (port, host) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    let buf = '';
    socket.setTimeout(5000, () => { socket.destroy(); resolve(`timeout:${buf}`); });
    socket.on('data', (d) => { buf += d.toString(); });
    socket.on('close', () => resolve(buf));
    socket.on('error', (e) => resolve(`error:${e.message}`));
  });

  const local = await connectThrough(proxy.port, '127.0.0.1');
  ok(!/200 Connection Established/.test(local), '拒绝 CONNECT 到 127.0.0.1', local.slice(0, 80));
  ok(/403|error|timeout/.test(local), '拒绝方式是 403/断开，而不是放行', local.slice(0, 80));

  const privateIp = await connectThrough(proxy.port, '192.168.1.1');
  ok(!/200 Connection Established/.test(privateIp), '拒绝 CONNECT 到 192.168.x.x', privateIp.slice(0, 80));

  const meta = await connectThrough(proxy.port, '169.254.169.254');
  ok(!/200 Connection Established/.test(meta), '拒绝 CONNECT 到云元数据地址 169.254.169.254', meta.slice(0, 80));

  // 普通 HTTP 代理路径（绝对 URL）也要拦
  const plain = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: 'http://127.0.0.1:3100/api/status' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
  ok(plain.status === 403, '拒绝经代理访问本机控制台 http://127.0.0.1:3100', JSON.stringify(plain).slice(0, 120));

  await proxy.close();
  ok(true, '代理可正常关闭');
}

console.log('## 无头浏览器渲染');
const browserOk = await browserAvailable();
if (!browserOk) {
  console.log('  ⏭ 未安装 puppeteer/Chromium，跳过渲染用例（optionalDependency）');
} else {
  // 本地假站点（测试模式允许本机，正式工具永远不传这个开关）
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SPA_PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/post`;

  // 纯 HTTP 抓取拿不到正文（这正是需要 web_render 的场景）
  const raw = await (await fetch(url)).text();
  ok(looksLikeSpaShell(raw) === true, '假 SPA 被识别为空壳（纯 HTTP 拿不到正文）');
  ok(!extractHtmlText(raw).includes('渲染出来的标题'), '纯 HTTP 抽取确实没有正文');

  const t0 = Date.now();
  const result = await renderPage(url, { allowLocalhostForTest: true, settleMs: 600 });
  const elapsed = Date.now() - t0;
  ok(result.rendered === true, '渲染完成');
  ok(result.text.includes('渲染出来的标题'), '拿到了 JS 注入的标题', result.text.slice(0, 80));
  ok(result.text.includes('这段正文只有执行 JS 才会出现'), '拿到了 JS 注入的正文');
  ok(!result.renderHint, '正文充足时不产生 renderHint', result.renderHint);
  ok(result.meta.title === '假 SPA 页面', '渲染后仍能取到 title', result.meta.title);
  ok(typeof result.elapsedMs === 'number' && result.elapsedMs > 0, `带耗时（${result.elapsedMs}ms，含启动 ${elapsed}ms）`);
  ok(!result.html, '不把整页 HTML 返回给模型（只回 text）');

  // 非测试模式：内网 URL 必须在校验阶段就被拒
  let rejected = '';
  try {
    await renderPage('http://127.0.0.1:3100/api/status');
  } catch (error) {
    rejected = String(error?.message ?? error);
  }
  ok(/内网|本机/.test(rejected), '非测试模式下拒绝渲染内网地址', rejected);

  await closeBrowser('test');
  await sleep(300);
  ok(true, '浏览器与代理已关闭');
  site.close();
}

console.log('## 内存保护');
{
  ok(typeof availableMemoryBytes === 'function' && availableMemoryBytes() > 0, `能读可用内存（${Math.round(availableMemoryBytes() / 1048576)}MB）`);
  ok(MIN_FREE_BYTES >= 128 * 1024 * 1024, `内存闸门 ${Math.round(MIN_FREE_BYTES / 1048576)}MB 不会低到没意义`);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'browser-render.js'), 'utf8');
  ok(src.includes('renderer-process-limit=1'), '限制 renderer 进程数');
  ok(src.includes('max-old-space-size=128'), '限制 V8 堆');
  ok(src.includes("'--blink-settings=imagesEnabled=false'"), '禁图（省内存与带宽）');
  ok(src.includes('--proxy-server='), '出网强制走过滤代理');
  ok(/if \(busy\) throw/.test(src), '同一时刻只渲染一个页面');
}

console.log('## 接线');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  ok(src.includes("'web_render'"), 'MCP 注册了 web_render');
  ok(src.includes('renderPage(url'), 'web_render 调用渲染模块');
  ok(src.includes('renderToolAvailable: await renderToolAvailable()'), 'web_fetch 的 renderHint 会提到 web_render');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(Boolean(pkg.optionalDependencies?.puppeteer), 'puppeteer 在 optionalDependencies（装不上不影响主程序）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
