// image-meta.js — 轻量图片元信息（不依赖第三方库）
//
// 用途：区分「真动图」和「单帧静态 .gif」。
// B 站评论区/专栏里大量 .gif 其实只有 1 帧（视频帧导出），发到 QQ 当然不会动。

/** 精确解析 GIF 帧数（按块结构遍历，不用粗略数 0x2C）。非 GIF 返回 0。 */
export function gifFrameCount(buf) {
  if (!buf || buf.length < 14) return 0;
  const head = buf.toString('ascii', 0, 6);
  if (head !== 'GIF87a' && head !== 'GIF89a') return 0;
  let p = 6;
  const packed = buf[p + 4];            // 逻辑屏幕描述符里的 packed 字节（偏移 6+4）
  p += 7;                               // 跳过整个逻辑屏幕描述符（7 字节）
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // 全局色表
  let frames = 0;
  let guard = 0;
  while (p < buf.length && guard++ < 100000) {
    const block = buf[p];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) { // 扩展块
      p += 2;
      while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    if (block === 0x2c) { // 图像描述符 = 一帧
      frames += 1;
      const localPacked = buf[p + 9];
      p += 10;
      if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 7) + 1));
      p += 1; // LZW 最小码长
      while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    p += 1; // 结构异常时就往前挪，避免死循环
  }
  return frames;
}

/** WebP 是否带 ANIM 块（动图）。非 WebP 返回 false。 */
export function isAnimatedWebp(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  return buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0; // ANIM 标志位
}

/** 汇总：这张图会不会动。 */
export function describeAnimation(buf) {
  const frames = gifFrameCount(buf);
  if (frames) return { kind: 'gif', frames, animated: frames > 1 };
  if (isAnimatedWebp(buf)) return { kind: 'webp', frames: null, animated: true };
  return { kind: null, frames: null, animated: false };
}
