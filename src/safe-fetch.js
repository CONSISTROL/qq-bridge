// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

const REQUEST_TIMEOUT_MS = 20000;

/**
 * 单次请求总时限（含 TCP/TLS、响应头、响应体）。
 * 默认 20s；调用方可传 `options.timeoutMs`（正安全整数，上限 5 分钟）。
 * 非法的值一律退回默认 —— 这个参数会直接决定连接存活多久，不能让它变成负数/Infinity。
 */
function requestTimeout(options) {
  const value = Number(options?.timeoutMs);
  return Number.isSafeInteger(value) && value > 0 && value <= 300000 ? value : REQUEST_TIMEOUT_MS;
}
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
/**
 * 允许携带的自定义请求头白名单。
 * 只放行 Referer / User-Agent / Cookie，且拒绝 CRLF 注入。
 * - Referer：B 站、pixiv（i.pximg.net 防盗链）必需。
 * - Cookie：pixiv 的 R-18 搜索必须带登录会话；值来自本机 config.json（管理员填的），
 *   不是 AI/群友可控的输入。仍然只在**第一跳**发送，重定向后不带（避免泄漏给第三方域名）。
 * 绝不接受任意 header —— 避免这个安全下载器被当成可定制的 HTTP 代理。
 */
const ALLOWED_IMAGE_HEADERS = new Set(['referer', 'user-agent', 'cookie']);

export function sanitizeImageHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (!ALLOWED_IMAGE_HEADERS.has(name)) continue;
    const value = String(rawValue ?? '').trim();
    if (!value || value.length > 512 || /[\r\n]/.test(value)) continue;
    if (name === 'referer' && !/^https?:\/\//i.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 解析代理配置。只接受 http:// 代理（Clash 的 mixed-port / 大多数本地代理都是这种）；
 * https:// 代理要先给代理本身做一层 TLS，本项目没这个需求，直接拒绝而不是悄悄降级。
 * @returns {{host:string, port:number}|null} null 表示没配代理（走直连）
 */
export function parseProxy(proxyUrl) {
  const raw = String(proxyUrl ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`代理地址无效：${raw}`); }
  if (url.protocol !== 'http:') throw new Error(`只支持 http:// 代理，收到 ${url.protocol}//`);
  if (!url.hostname) throw new Error('代理地址缺少主机名');
  return { host: url.hostname, port: Number(url.port) || 80 };
}

/**
 * 通过 HTTP 代理向目标建一条 TCP/TLS 隧道（CONNECT）。
 *
 * 只在调用方显式传 `options.proxy` 时才会走到这里——目标站点选不选代理由调用方决定
 * （桥接只对 pixiv 系域名开代理，bobopic/B站 继续直连）。
 * `tls.connect(..., { servername })` 仍然校验证书，隧道本身不影响证书验证。
 */
function connectViaProxy(proxy, targetHost, targetPort, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(socket);
    };
    const timer = setTimeout(() => done(new Error(`代理连接超时：${proxy.host}:${proxy.port}`)), timeoutMs);
    timer.unref?.();
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode}）：${targetHost}:${targetPort}`));
        return;
      }
      if (!secure) { done(null, socket); return; }
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => done(null, tlsSocket));
      tlsSocket.on('error', (error) => done(error));
    });
    req.on('timeout', () => { req.destroy(new Error(`代理连接超时：${proxy.host}:${proxy.port}`)); });
    req.on('error', (error) => done(error));
    req.end();
  });
}

function requestOnce(url, ip, limit, binary = false, extraHeaders = {}, timeoutMs = REQUEST_TIMEOUT_MS, proxy = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    // 代理模式下由代理侧解析目标域名（本机仍先跑一遍 resolveSafeHost 做内网拦截），
    // 因此 hostname 用回真实域名、并挂上单次隧道 socket；直连模式仍钉死已校验的 IP。
    const start = (tunnelSocket) => {
      if (settled) { tunnelSocket?.destroy(); return; }
      try {
        req = mod.request({
          hostname: tunnelSocket ? hostname : ip,
          port,
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            host: url.host,
            'user-agent': 'Mozilla/5.0',
            accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
            ...extraHeaders,
          },
          ...(tunnelSocket ? { createConnection: () => tunnelSocket } : {}),
          servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
          rejectUnauthorized: url.protocol === 'https:',
          timeout: timeoutMs,
        }, (res) => {
          response = res;
          res.on('error', (error) => finish(error));
          res.on('aborted', () => finish(new Error('响应体读取中断')));
          res.on('close', () => {
            if (!res.complete) finish(new Error('响应体读取中断'));
          });
          if (settled) { res.destroy(); return; }
          const statusCode = res.statusCode || 0;
          if (REDIRECT_STATUSES.has(statusCode)) {
            finish(null, { statusCode, redirect: String(res.headers.location || '') });
            // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
            res.destroy();
            return;
          }
          const chunks = [];
          const decoder = binary ? null : new StringDecoder('utf8');
          let size = 0;
          const appendText = (text) => {
            const points = Array.from(text);
            const remaining = limit - size;
            chunks.push(points.slice(0, remaining).join(''));
            size += Math.min(points.length, remaining);
            if (size >= limit) {
              finish(null, { statusCode, body: chunks.join(''), truncated: true });
              res.destroy();
            }
          };
          res.on('data', (chunk) => {
            if (settled) return;
            if (!binary) { appendText(decoder.write(chunk)); return; }
            size += chunk.length;
            if (size > limit) {
              finish(new Error(`图片超过大小限制（${limit} 字节）`));
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            if (binary) finish(null, { statusCode, buffer: Buffer.concat(chunks) });
            else {
              appendText(decoder.end());
              finish(null, { statusCode, body: chunks.join(''), truncated: false });
            }
          });
        });
        req.on('timeout', () => {
          const error = new Error(`请求超时：${url.hostname}`);
          finish(error);
          req.destroy(error);
          response?.destroy();
        });
        req.on('error', (error) => finish(error));
        req.end();
      } catch (error) {
        finish(error);
        req?.destroy();
      }
    };
    if (proxy) {
      connectViaProxy(proxy, hostname, Number(port), url.protocol === 'https:', timeoutMs)
        .then((socket) => start(socket))
        .catch((error) => finish(error));
    } else {
      start(null);
    }
  });
}

export async function safeFetch(urlString, maxChars = 50000, options = {}) {
  validateLimit(maxChars, 'maxChars');
  // 自定义头只在第一跳生效，重定向后回到默认（防止把凭据带去别的主机）。
  // 典型用途：很多站点（如 Bing）对裸 "Mozilla/5.0" 返回降级页，必须给完整浏览器 UA。
  const extraHeaders = sanitizeImageHeaders(options.headers);
  const timeoutMs = requestTimeout(options);
  const proxy = parseProxy(options.proxy);
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars, false, i === 0 ? extraHeaders : {}, timeoutMs, proxy);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。
 *  options.headers 只接受 Referer / User-Agent（见 sanitizeImageHeaders），
 *  且仅在**第一跳**发送，重定向后不再携带，避免把 Referer 泄漏给未知站点。 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024, options = {}) {
  validateLimit(maxBytes, 'maxBytes');
  const extraHeaders = sanitizeImageHeaders(options.headers);
  const timeoutMs = requestTimeout(options);
  const proxy = parseProxy(options.proxy);
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxBytes, true, i === 0 ? extraHeaders : {}, timeoutMs, proxy);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
