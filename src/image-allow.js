// 图片来源的白名单 / Referer 判定纯函数。
//
// 背景（真实踩过的坑）：AI 在群里/私聊里看到一张图，手上只有消息里的 `media.url`
// ——那通常是腾讯自家 CDN（`multimedia.nt.qq.com.cn/download?...&rkey=...`）。
// 旧实现里 `refererAllow` 只列了 B 站图床，于是 AI 一调 qq_save_sticker 就被拒：
// 「图片站点不在 refererAllow 白名单内」。
//
// 这里把判定逻辑从 bridge.js 里抽出来，做成可离线单测的纯函数：
// - 白名单按 **hostname** 精确比较（B 站的封面/表情 http、https 混用，按 origin 比会漏）；
// - Referer **不再**「命中白名单就无脑发」：B 站图床有防盗链必须带，
//   QQ/腾讯图床带了反而可能被判盗链，所以按 refererHosts 后缀匹配决定。

/** 默认允许抓取的图床：B 站 + 腾讯/QQ 图片 CDN。 */
export const DEFAULT_REFERER_ALLOW = Object.freeze([
  'https://i0.hdslb.com',
  'https://i1.hdslb.com',
  'https://i2.hdslb.com',
  'https://multimedia.nt.qq.com.cn',
  'https://multimedia.qpic.cn',
  'https://gchat.qpic.cn',
  'https://c2cpicdw.qpic.cn',
  'https://p.qpic.cn',
  'https://q1.qlogo.cn',
  'https://tianquan.gtimg.cn'
]);

/** 默认需要带 imageReferer 的域名后缀（只有 B 站系图床有防盗链）。 */
export const DEFAULT_REFERER_HOSTS = Object.freeze(['hdslb.com', 'bilibili.com']);

/** 从 URL 里安全取出 hostname（非法 URL 返回空串）。 */
export function hostnameOf(url) {
  try { return new URL(String(url ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

/** 目标 hostname 是否命中 refererAllow（空白名单 = 不限制目标站点）。 */
export function hostInImageAllowList(hostname, allowList) {
  const list = Array.isArray(allowList) ? allowList : [];
  if (!list.length) return true;
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return false;
  return list.some((entry) => {
    // 兼容只写域名（`i0.hdslb.com`）和写完整 origin（`https://i0.hdslb.com`）两种配置。
    const entryHost = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(entry)) ? hostnameOf(entry) : String(entry ?? '').trim().toLowerCase();
    return entryHost && entryHost === host;
  });
}

/** 该图床是否需要带 Referer（后缀匹配，避免 evil-hdslb.com 蒙混过关）。 */
export function hostNeedsImageReferer(hostname, refererHosts) {
  const host = String(hostname ?? '').toLowerCase();
  const list = Array.isArray(refererHosts) && refererHosts.length ? refererHosts : DEFAULT_REFERER_HOSTS;
  return list.some((suffix) => {
    const s = String(suffix ?? '').trim().toLowerCase().replace(/^\*?\./, '');
    return Boolean(s) && (host === s || host.endsWith('.' + s));
  });
}

/** 是否腾讯/QQ 图片 CDN：这类链接是聊天里随手可得的，收藏原图应优先走 qq_collect_sticker。 */
export function isQqImageCdnHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return false;
  return ['qq.com.cn', 'qpic.cn', 'gtimg.cn', 'qlogo.cn'].some((suffix) => host === suffix || host.endsWith('.' + suffix));
}

/**
 * 把 config.socialV2.image 归一化成运行时参数（纯函数，文件系统相关的 libraryDir 由调用方补）。
 * 注意：refererAllow 缺省时用 DEFAULT_REFERER_ALLOW，而不是空数组——
 * 空数组在旧语义里是「不限制站点」，当默认值会把白名单直接失效。
 */
export function normalizeImageLimits(img, { maxBytesDefault = 5 * 1024 * 1024 } = {}) {
  const raw = img && typeof img === 'object' ? img : {};
  const allow = Array.isArray(raw.refererAllow) ? raw.refererAllow.map(String).filter(Boolean) : [];
  const refererHosts = Array.isArray(raw.refererHosts) ? raw.refererHosts.map(String).filter(Boolean) : [];
  return {
    maxBytes: Math.max(1, Number(raw.maxBytes) || maxBytesDefault),
    allowRemoteUrl: raw.allowRemoteUrl === true,
    refererAllow: allow,
    refererHosts: refererHosts.length ? refererHosts : [...DEFAULT_REFERER_HOSTS],
    imageReferer: String(raw.imageReferer || 'https://www.bilibili.com')
  };
}

/** 白名单被拒时的可执行提示：把 AI 引到不受白名单限制的 qq_collect_sticker。 */
export function imageAllowRejectHint(hostname) {
  return isQqImageCdnHost(hostname)
    ? `；这是 QQ 聊天图片的 CDN 链接，收藏会话里的原图请改用 qq_collect_sticker(messageId=消息id)，它由网关直接取字节，不受此白名单限制`
    : `；如需允许该站点，请把它加进 config.json 的 socialV2.image.refererAllow`;
}
