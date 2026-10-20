// 走 anihub 真实链路打开 DSH：用一次性 JWT 在浏览器内换 local-web 会话，再打开 DSH 页面。
// 用法：AH_JWT=<登录拿到的 token> node probe-dsh-live.mjs
import puppeteer from 'puppeteer'

const JWT = process.env.AH_JWT || ''
const ORIGIN = 'https://anihub.xin'
const TARGET = `${ORIGIN}/local-web/http/127.0.0.1:3080/`

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors'],
  executablePath: '/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })

const wsLog = []
const badHttp = []
const errors = []
const cdp = await page.createCDPSession()
await cdp.send('Network.enable')
cdp.on('Network.webSocketCreated', () => wsLog.push('created'))
cdp.on('Network.webSocketFrameReceived', () => wsLog.push('frame'))
cdp.on('Network.webSocketClosed', () => wsLog.push('closed'))
cdp.on('Network.responseReceived', (e) => {
  if (e.response.status >= 400 && !/favicon/.test(e.response.url)) badHttp.push(`HTTP${e.response.status} ${e.response.url.slice(0, 80)}`)
})
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

// 1) 先在站点根打开（同源），用 JWT 换 local-web 会话 cookie
await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
const stamp = await page.evaluate(async (jwt) => {
  const r = await fetch('/api/local-web/session', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } })
  return `session ${r.status}`
}, JWT)
console.log('STEP1:', stamp)

// 2) 打开 DSH
try {
  await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 45000 })
} catch (e) {
  console.log('NAV_ERROR:', e.message.slice(0, 120))
}
await new Promise((r) => setTimeout(r, 9000))

const info = await page.evaluate(() => {
  const text = document.body.innerText || ''
  return {
    title: document.title,
    url: location.href.replace(/token=[^&]+/, 'token=<redacted>'),
    hasAuthError: /authentication required|reopen the URL printed|登录已失效/i.test(text),
    hasReconnect: /重新连接/.test(text),
    hasComposer: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
    head: text.slice(0, 140).replace(/\s+/g, ' '),
  }
})

console.log(JSON.stringify(info, null, 1))
console.log('WS:', { created: wsLog.filter((x) => x === 'created').length, frames: wsLog.filter((x) => x === 'frame').length, closed: wsLog.filter((x) => x === 'closed').length })
console.log('BAD_HTTP:', badHttp.slice(0, 5))
console.log('JS_ERRORS:', errors.slice(0, 3))
await page.screenshot({ path: '/tmp/dsh-live.png' }).catch(() => {})
await browser.close()
