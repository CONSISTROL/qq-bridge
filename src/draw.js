// 画图：接入火山引擎方舟（豆包 Seedream）文生图。
//
// 为什么走桥接而不是 MCP 侧直连：密钥只在桥接的 config.json 里（不进 DSH 侧配置），
// 出图后直接复用现有的图片发送链路（缩放/体积上限/防重复都在那里）。
//
// 接口（OpenAI 兼容风格）：
//   POST https://ark.cn-beijing.volces.com/api/v3/images/generations
//   Authorization: Bearer <ARK_API_KEY>
//   { model, prompt, size: '1024x1024', response_format: 'url'|'b64_json', watermark: false }
import { safeFetchBuffer } from './safe-fetch.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_MODEL = 'doubao-seedream-3-0-t2i-250415';
const SIZES = new Set(['1024x1024', '864x1152', '1152x864', '1280x720', '720x1280', '832x1248', '1248x832']);

export function drawConfig(cfg) {
  const d = cfg?.draw ?? {};
  return {
    enabled: d.enabled === true,
    apiKey: String(d.apiKey ?? '').trim(),
    model: String(d.model ?? '').trim() || DEFAULT_MODEL,
    size: SIZES.has(String(d.size ?? '')) ? String(d.size) : '1024x1024',
    watermark: d.watermark === true
  };
}

/**
 * 生成一张图，返回 { ok, buffer, mime, model, size } 或 { ok:false, error }。
 * prompt 最多 800 字（太长的描述模型也吃不透）。
 */
export async function generateImage({ cfg, prompt, size, timeoutMs = 120000 } = {}) {
  const c = drawConfig(cfg);
  if (!c.enabled) return { ok: false, error: '画图未启用（config.json → draw.enabled）' };
  if (!c.apiKey) return { ok: false, error: '画图缺少密钥（config.json → draw.apiKey）' };
  const p = String(prompt ?? '').trim().slice(0, 800);
  if (!p) return { ok: false, error: 'prompt 不能为空' };
  const sz = SIZES.has(String(size ?? '')) ? String(size) : c.size;

  // 注意：这里不能用 safe-fetch —— 它只支持 GET 且会剥掉 Authorization 头（安全设计）。
  // 目标是我们自己配置的固定可信域名，用 Node 内置 fetch + 超时即可。
  let res;
  try {
    res = await fetch(ARK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, prompt: p, size: sz, response_format: 'url', watermark: c.watermark }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, error: `出图请求失败：${error?.message ?? error}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `出图接口 ${res.status}：${body.slice(0, 300)}` };
  }
  let data;
  try { data = await res.json(); } catch (error) { return { ok: false, error: `出图响应不是 JSON：${error?.message ?? error}` }; }

  const first = Array.isArray(data?.data) ? data.data[0] : null;
  if (!first) return { ok: false, error: `出图响应里没有图片：${JSON.stringify(data).slice(0, 200)}` };

  // 两种返回：b64_json 直接给数据，url 需要再抓一次
  if (first.b64_json) {
    const buffer = Buffer.from(String(first.b64_json), 'base64');
    if (!buffer.length) return { ok: false, error: '出图返回的 base64 是空的' };
    return { ok: true, buffer, mime: 'image/png', model: c.model, size: sz };
  }
  if (first.url) {
    let buf;
    try { buf = await safeFetchBuffer(String(first.url), 12 * 1024 * 1024, { timeoutMs }); } catch (error) {
      return { ok: false, error: `下载出图失败：${error?.message ?? error}` };
    }
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf?.buffer ?? []);
    if (!buffer.length) return { ok: false, error: '下载出图得到空数据' };
    return { ok: true, buffer, mime: 'image/png', model: c.model, size: sz };
  }
  return { ok: false, error: '出图响应里既没有 b64_json 也没有 url' };
}
