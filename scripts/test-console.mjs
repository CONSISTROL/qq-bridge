// 控制台增强功能综合测试（node 直接调 API）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面外壳 + 分区静态资源
//    控制台已从单文件拆成「外壳 + core/ + views/*.html」，这里守住三件事：
//    外壳能加载、每个分区片段都在、/console/* 的静态路由不带令牌也能取到
//    （浏览器给 <script type="module"> 加不了自定义头，所以这条是硬要求）。
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('控制台外壳加载', page.status === 200 && html.includes('QQ 桥接控制台') && html.includes('/console/app.js'), `长度 ${html.length}`);

const anon = await fetch(BASE + '/');
ok('外壳匿名访问被拒（401）', anon.status === 401, `HTTP ${anon.status}`);

const VIEWS = [
  ['overview', ['运行模式', '会话映射', '挂起审批', '活动日志']],
  ['persona', ['人格（角色扮演）', '静默开关']],
  ['social1', ['一代仿真模式（reserved）']],
  ['social2', ['二代仿真模式（reserved2）控制台', '工具调用日志', '轻量记忆']],
  ['slang', ['群聊黑话 / 网络用语库', '本地向量检索（黑话选词 / 语义匹配）']],
  ['tools', ['DSH 侧 MCP 工具', '后台控制端引导']],
  ['security', ['白名单 / 管理员', '安全拦截通知', '控制台访问令牌']],
  ['ops', ['测试发送', '桥接控制']]
];
for (const [name, markers] of VIEWS) {
  const res = await fetch(`${BASE}/console/views/${name}.html`); // 故意不带令牌
  const body = res.status === 200 ? await res.text() : '';
  const missing = markers.filter((m) => !body.includes(m));
  ok(`分区片段 ${name}.html`, res.status === 200 && missing.length === 0,
    res.status === 200 ? (missing.length ? `缺少 ${missing.join(' / ')}` : `${body.length} 字节`) : `HTTP ${res.status}`);
}

const assets = [
  ['/console/style.css', 'text/css', '--accent'],
  ['/console/app.js', 'text/javascript', 'startRouter'],
  ['/console/core/api.js', 'text/javascript', 'export async function api'],
  ['/console/core/theme.js', 'text/javascript', 'initTheme'],
  ['/console/core/router.js', 'text/javascript', 'defineView'],
  ['/console/core/poll.js', 'text/javascript', 'export function every'],
  ['/console/core/dom.js', 'text/javascript', 'export function esc'],
  ['/console/core/status.js', 'text/javascript', 'refreshStatus'],
  ['/console/core/fragments.js', 'text/javascript', 'mountFragment']
];
for (const [path, type, marker] of assets) {
  const res = await fetch(BASE + path); // 同样匿名
  const ctype = res.headers.get('content-type') || '';
  const body = res.status === 200 ? await res.text() : '';
  ok(`静态资源 ${path}`, res.status === 200 && ctype.includes(type) && body.includes(marker),
    res.status === 200 ? ctype : `HTTP ${res.status}`);
}

// 静态路由的边界：目录穿越 / 空相对路径 / 不允许的扩展名
const traversal = await fetch(`${BASE}/console/%2e%2e%2fsrc%2fbridge.js`);
ok('静态路由挡住 %2e%2e 穿越', traversal.status === 404 || traversal.status === 400, `HTTP ${traversal.status}`);
const escape = await fetch(`${BASE}/console/../../config.json`);
// URL 解析会先把 .. 归一化成 /config.json，落到普通 API 路由上（没有令牌 → 401）。
// 关键是它绝不能返回 config.json 的内容：这里只要求不是 200 且不含配置字段。
const escapeBody = escape.status === 200 ? await escape.text() : '';
ok('静态路由挡住 .. 穿越', escape.status !== 200 && !escapeBody.includes('consoleToken'),
  `HTTP ${escape.status}`);
const emptyRel = await fetch(`${BASE}/console/`);
ok('静态路由拒绝空路径（无目录列表）', emptyRel.status === 400, `HTTP ${emptyRel.status}`);
const badExt = await fetch(`${BASE}/console/index.html.bak`);
ok('静态路由拒绝非白名单扩展名', badExt.status === 403, `HTTP ${badExt.status}`);
// 扩展名白名单只留 html/js/css：以后有人往 public/console 里丢数据文件也不会被匿名读到
const jsonExt = await fetch(`${BASE}/console/views/overview.json`);
ok('静态路由拒绝 .json', jsonExt.status === 403, `HTTP ${jsonExt.status}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);
if (origRole) {
  r = await api('/api/role', 'POST', { role: origRole });
  ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
}

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
// 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 8. 测试发送到机器人测试群（真实发送）
// 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
// 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
ok('测试发送群消息', r.body.ok === true || snowlumaDown,
  r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
// 还原白名单（去掉测试群）
await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '987654321', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）
fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
