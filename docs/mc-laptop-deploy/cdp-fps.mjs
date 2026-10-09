#!/usr/bin/env node
// 通过 Chrome DevTools Protocol 测量 prismarine-viewer 页面的真实渲染帧率与 GL 后端
// 用法: node cdp-fps.mjs [时长秒]
const SECS = Number(process.argv[2] || 10);

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page' && /Prismarine|3200/.test(t.url + t.title)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 viewer 页面');
  console.log('目标页面:', page.url);

  // 不引三方库，用原生 WebSocket（Node 22+ 有；Node 18 用 ws 模块）
  let WS = globalThis.WebSocket;
  if (!WS) {
    // Node 18 没有全局 WebSocket；用 bot 依赖里已有的 ws
    const { createRequire } = await import('node:module');
    const req = createRequire('/home/wx/mc/bot/package.json');
    WS = req('ws').WebSocket;
  }
  const ws = new WS(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
  });

  const expr = `(async () => {
    const c = document.querySelector('canvas');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    let renderer = 'n/a', vendor = 'n/a';
    if (gl) {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      if (d) { renderer = gl.getParameter(d.UNMASKED_RENDERER_WEBGL); vendor = gl.getParameter(d.UNMASKED_VENDOR_WEBGL); }
    }
    const t0 = performance.now();
    let frames = 0;
    await new Promise((done) => {
      const tick = () => { frames++; if (performance.now() - t0 >= ${SECS * 1000}) done(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const el = (performance.now() - t0) / 1000;
    return JSON.stringify({
      canvas: c ? c.width + 'x' + c.height : 'no-canvas',
      renderer, vendor,
      frames, secs: +el.toFixed(2), fps: +(frames / el).toFixed(1),
    });
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const val = r?.result?.result?.value;
  if (!val) { console.log('原始返回:', JSON.stringify(r).slice(0, 400)); process.exit(1); }
  const o = JSON.parse(val);
  console.log('=== viewer 实测 ===');
  console.log('  画布尺寸 :', o.canvas);
  console.log('  GL 渲染器:', o.renderer);
  console.log('  GL 厂商  :', o.vendor);
  console.log(`  帧数/时长: ${o.frames} 帧 / ${o.secs}s`);
  console.log(`  ▶ 渲染帧率: ${o.fps} fps`);
  ws.close();
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
