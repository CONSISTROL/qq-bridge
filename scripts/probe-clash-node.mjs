// 找出「哪个 Clash 节点拉 pixiv 原图最快」——用来解决「原图拿不到、只能退 1200px」。
//
// 背景（2026-09-24 实测）：桥接取图本身没问题，瓶颈是代理出口。
//   本机直连 Cloudflare：1.19MB/s；经代理：30~60KB/s。
//   pixiv 那张 15.7MB 的原图经代理 240s 只下了 6.5MB（≈27KB/s），Range 分块也没救。
// 而 clash 的规则把 pixiv 指到「🧭 节点选择」这个组，组里选的节点可能并不是最快的。
//
// 用法：
//   node scripts/probe-clash-node.mjs                       # 只读：列出候选节点与延迟（不动选择组）
//   node scripts/probe-clash-node.mjs --switch              # 逐个切节点实测下载速度，测完恢复原节点
//   node scripts/probe-clash-node.mjs --switch --keep "HKBN · CMI"   # 测完把组固定到最快/指定节点
//
// 依赖：mihomo 的 external-controller（Clash Verge 默认是 unix socket，见下 DEFAULT_SOCK）。
// 可用 MIHOMO_SOCK / MIHOMO_URL(+MIHOMO_SECRET) 覆盖；npm run probe:node。
import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_SOCK = '/root/.local/share/io.github.clash-verge-rev.clash-verge-rev/verge-mihomo.sock';
const SOCK = process.env.MIHOMO_SOCK || DEFAULT_SOCK;
const BASE = process.env.MIHOMO_URL || 'http://localhost';
const SECRET = process.env.MIHOMO_SECRET || '';
// pixiv 规则用的组（`DOMAIN-SUFFIX,pximg.net,🧭 节点选择`）；换个组用 --group。
const GROUP = argValue('--group') || '🧭 节点选择';
// 拿来测速的原图（默认 149957497_p0.png，15.7MB：够大，能真实反映吞吐）。
const TEST_URL = argValue('--url')
  || process.env.PIXIV_TEST_URL
  || 'https://i.pximg.net/img-original/img/2026/09/22/07/00/02/149957497_p0.png';
const CHUNK_BYTES = Number(argValue('--bytes')) || 1024 * 1024;
const PROXY = process.env.CLASH_PROXY || 'http://127.0.0.1:7897';
const SWITCH = process.argv.includes('--switch');
const KEEP = argValue('--keep');
const MAX_DELAY = Number(argValue('--max-delay')) || 400;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] ?? '') : '';
}

/** 走 unix socket（Clash Verge）或 http(+secret)（自己起的 mihomo）请求控制器。 */
function api(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = SOCK && fs.existsSync(SOCK)
      ? { socketPath: SOCK, path, method }
      : (() => {
        const u = new URL(path, BASE);
        return { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method };
      })();
    const headers = {};
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (SECRET) headers.authorization = `Bearer ${SECRET}`;
    const req = http.request({ ...options, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 120)}`)); return; }
        try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('控制器请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 从 mixed-port 走代理下 CHUNK_BYTES 字节，返回 B/s（失败返回 0）。 */
async function measure(node) {
  const range = `0-${CHUNK_BYTES - 1}`;
  const t0 = Date.now();
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{size_download}',
      '--max-time', '45',
      '-x', PROXY,
      '-H', 'Referer: https://www.pixiv.net/',
      '-r', range,
      TEST_URL
    ], { timeout: 50000 });
    const bytes = Number(stdout) || 0;
    const secs = (Date.now() - t0) / 1000;
    return { bytes, secs, speed: secs > 0 ? bytes / secs : 0 };
  } catch {
    return { bytes: 0, secs: (Date.now() - t0) / 1000, speed: 0 };
  }
}

const speedText = (bps) => (bps >= 1024 * 1024 ? `${(bps / 1048576).toFixed(2)}MB/s` : `${Math.round(bps / 1024)}KB/s`);
const delayText = (d) => (d > 0 ? `${d}ms` : '超时');

async function main() {
  const proxies = (await api('/proxies')).proxies ?? {};
  const group = proxies[GROUP];
  if (!group) {
    console.error(`找不到策略组「${GROUP}」。现有组：`);
    for (const [name, p] of Object.entries(proxies)) {
      if (['Selector', 'URLTest', 'Fallback', 'LoadBalance'].includes(p.type)) console.error(`  [${p.type}] ${name}`);
    }
    process.exit(1);
  }
  const original = group.now;
  const nodes = (group.all ?? []).filter((n) => !/^(DIRECT|REJECT|PASS|COMPATIBLE)$/i.test(n) && !(proxies[n]?.type === 'Selector'));

  console.log(`策略组：${GROUP}（当前：${original}）`);
  console.log(`目标：${TEST_URL}`);
  console.log(SWITCH ? `模式：实测（每节点下 ${Math.round(CHUNK_BYTES / 1024)}KB，测完恢复 ${original}）\n` : '模式：只读（只测延迟，不动选择组）\n');

  const rows = [];
  for (const name of nodes) {
    let delay = 0;
    try {
      const res = await api(`/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`);
      delay = Number(res.delay) || 0;
    } catch { delay = 0; }
    const row = { name, delay, speed: 0 };
    if (SWITCH && delay > 0 && delay <= MAX_DELAY) {
      await api(`/proxies/${encodeURIComponent(GROUP)}`, { method: 'PUT', body: { name } });
      const m = await measure(name);
      row.speed = m.speed;
      row.note = m.bytes ? `${Math.round(m.bytes / 1024)}KB/${m.secs.toFixed(1)}s` : '失败';
    }
    rows.push(row);
    console.log(`  ${name.padEnd(22)} 延迟 ${delayText(delay).padEnd(8)}${SWITCH ? ` 下载 ${speedText(row.speed).padEnd(10)} ${row.note ?? ''}` : ''}`);
  }

  if (SWITCH) {
    const best = [...rows].filter((r) => r.speed > 0).sort((a, b) => b.speed - a.speed)[0];
    const target = KEEP || best?.name || original;
    await api(`/proxies/${encodeURIComponent(GROUP)}`, { method: 'PUT', body: { name: target } });
    console.log(`\n最快：${best ? `${best.name}（${speedText(best.speed)}）` : '没有可用节点'}`);
    console.log(`已把「${GROUP}」设为：${target}${target === original ? '（= 原节点，未改变）' : ''}`);
    if (KEEP) console.log('（--keep 指定，覆盖「最快」判定）');
    console.log('想换回来：在 Clash 界面里选回原节点，或用 --keep "<节点名>" 再跑一次。');
  } else {
    console.log('\n只读模式结束。加 --switch 才会实际切节点测下载速度（会短暂影响走该组的其他流量）。');
  }
}

await main();
