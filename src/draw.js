// 画图：豆包网页版（浏览器自动化，无兜底）——失败如实报错；验证码需人工在控制台点掉。
//
// 为什么走桥接而不是 MCP 侧直连：密钥只在桥接的 config.json 里（不进 DSH 侧配置），
// 出图后直接复用现有的图片发送链路（缩放/体积上限/防重复都在那里）。
//
// 接口（OpenAI 兼容风格）：
//   Authorization: Bearer <ARK_API_KEY>
//   { model, prompt, size: '1024x1024', response_format: 'url'|'b64_json', watermark: false }
import { safeFetchBuffer } from './safe-fetch.js';
import { generateImageWeb } from './draw-web.js';

// 现在只有豆包网页版一条通道（无兜底）。
const DEFAULT_MODEL = 'doubao-web';
const SIZES = new Set(['1024x1024', '864x1152', '1152x864', '1280x720', '720x1280', '832x1248', '1248x832']);


export function drawConfig(cfg) {
  const d = cfg?.draw ?? {};
  return {
    provider: String(d.provider || '').trim() || 'auto',
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
  // 按 owner 要求：**不做兜底**，只走豆包网页版；失败就把原因如实返回。
  return generateImageWeb({ stateDir: cfg?.stateDir || path.join(process.cwd(), 'state'), prompt, timeoutMs });

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
