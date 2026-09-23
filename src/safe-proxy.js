// 本地过滤代理：给无头浏览器用的「只能出公网」网络边界。
//
// 为什么需要它：桥接的控制台（127.0.0.1:3100）、DSH（127.0.0.1:3080）、OneBot（:3000）
// 都在本机。把任意外部页面的 JS 放进真浏览器里跑，如果不管住网络，那个页面就能
// `fetch('http://127.0.0.1:3100/api/...')` —— 这是实打实的 SSRF。
//
// 为什么不用 puppeteer 的 request 拦截：
// - `page.on('request')` 管不到 **WebSocket 握手**；
// - 应用层拦截漏一条路径就是漏洞。代理是网络层边界，子资源/重定向/WS 全在里面。
//
// 实现要点：
// - CONNECT（HTTPS/WSS）与普通 HTTP 都先 `resolveSafeHost` 解析并校验，命中内网直接拒；
// - **连的是校验通过的 IP，不是域名**：避免「校验时解析到公网、真正连接时又解析到内网」
//   的 DNS rebinding 窗口；
// - 只允许 80/443 之外的端口也可走，但同样必须过公网校验。

import http from 'node:http';
import net from 'node:net';
import { resolveSafeHost } from './safe-fetch.js';

/** 拒绝内网目标。allowLocalhostForTest 只给离线测试用，MCP 工具永远不会传。 */
export async function startSafeProxy({ allowLocalhostForTest = false, log = () => {} } = {}) {
  const resolveTarget = async (hostname) => {
    if (allowLocalhostForTest) return hostname; // 测试里连的是本地假站点
    return resolveSafeHost(hostname);
  };

  // 普通 HTTP：Chromium 发来的是绝对 URL（GET http://host/path）
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(String(req.url ?? ''));
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad proxy request');
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked: protocol not allowed');
      return;
    }
    resolveTarget(target.hostname)
      .then((ip) => {
        const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
        const upstream = http.request({
          host: ip,
          port,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: { ...req.headers, host: target.host }
        }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        upstream.on('error', () => {
          try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream error'); } catch { /* 已断开 */ }
        });
        req.pipe(upstream);
      })
      .catch((error) => {
        log(`[safe-proxy] 拒绝 HTTP ${target.hostname}: ${error?.message ?? error}`);
        try {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end(`blocked: ${error?.message ?? error}`);
        } catch { /* 已断开 */ }
      });
  });

  // HTTPS / WSS：CONNECT 隧道
  server.on('connect', (req, clientSocket, head) => {
    const [rawHost, rawPort] = String(req.url ?? '').split(':');
    const host = rawHost?.replace(/^\[|\]$/g, '');
    const port = Number(rawPort) || 443;
    const fail = (message) => {
      log(`[safe-proxy] 拒绝 CONNECT ${host}:${port}: ${message}`);
      try { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch { /* 忽略 */ }
      clientSocket.destroy();
    };
    if (!host) return fail('缺少主机名');
    resolveTarget(host)
      .then((ip) => {
        const upstream = net.connect(port, ip, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        const teardown = () => { upstream.destroy(); clientSocket.destroy(); };
        upstream.on('error', teardown);
        clientSocket.on('error', teardown);
        upstream.setTimeout(60000, teardown);
        clientSocket.setTimeout(60000, teardown);
      })
      .catch((error) => fail(error?.message ?? String(error)));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  log(`[safe-proxy] 出网过滤代理已启动 127.0.0.1:${port}${allowLocalhostForTest ? '（测试模式：允许本机）' : ''}`);
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
