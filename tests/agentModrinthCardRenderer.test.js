import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import puppeteer from 'puppeteer'
import { buildAgentModrinthCardHtml, createAgentModrinthCardRenderer } from '../dist/backend/modules/media/infrastructure/agentModrinthCardRenderer.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png, 'base64')
const view = {
  rank: 1, name: 'Sodium', author: 'CaffeineMC', downloads: '123,456', follows: '8,900',
  tagsText: 'fabric · optimization', versionsText: '1.21.1 · 1.21.4', clientSide: '必需', serverSide: '不支持',
  dateCreated: '2020-07-01', dateModified: '2026-11-15', license: 'LGPL-3.0-only',
  descriptionEn: 'A rendering optimization mod.\nEnglish is kept exactly as supplied.',
  descriptionZh: '一个渲染优化模组。\n与英文原文分开展示。',
  source: 'Modrinth', queryTimeBeijing: '2026-11-15 18:00',
}
const context = changes => ({ signal: new AbortController().signal, isCurrent: () => true, ...changes })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(changes = {}) {
  const calls = [], handlers = new Map()
  const page = {
    setDefaultTimeout(value) { calls.push(['timeout', value]) },
    setDefaultNavigationTimeout(value) { calls.push(['navigationTimeout', value]) },
    async setJavaScriptEnabled(value) { calls.push(['js', value]) },
    async setBypassServiceWorker(value) { calls.push(['serviceWorker', value]) },
    async setRequestInterception(value) { calls.push(['interception', value]) },
    on(event, handler) { handlers.set(event, handler) },
    async setOfflineMode(value) { calls.push(['offline', value]) },
    async setViewport(value) { calls.push(['viewport', value]) },
    async setContent(html, options) { calls.push(['html', html, options]) },
    async evaluate() { return 1400 },
    async screenshot(options) { calls.push(['screenshot', options]); return pngBytes },
    async close() { calls.push(['pageClose']) },
    ...changes.page,
  }
  const browser = {
    async newPage() { calls.push(['newPage']); return page },
    async close() { calls.push(['browserClose']) },
    ...changes.browser,
  }
  const launch = async options => { calls.push(['launch', options]); return browser }
  return { calls, handlers, page, browser, launch }
}

test('card HTML keeps every supplied field, separates both descriptions, and renders all input as text', () => {
  const html = buildAgentModrinthCardHtml({ ...view,
    name: '<img src="https://evil.example/icon" onerror="alert(1)">',
    descriptionEn: '<script>alert("secret")</script>\r\nA & B\n  exact spacing',
    descriptionZh: '中文 <iframe src="file:///etc/passwd"> & 翻译',
    iconUrl: 'http://127.0.0.1:1234/private-icon',
  })
  assert.match(html, /&lt;img src=&quot;https:\/\/evil\.example\/icon&quot; onerror=&quot;alert\(1\)&quot;&gt;/u)
  assert.match(html, /&lt;script&gt;alert\(&quot;secret&quot;\)&lt;\/script&gt;&#13;\nA &amp; B\n  exact spacing/u)
  assert.match(html, /中文 &lt;iframe/u)
  for (const key of ['author', 'downloads', 'follows', 'tagsText', 'versionsText', 'clientSide', 'serverSide', 'dateCreated', 'dateModified', 'license']) {
    assert.ok(html.includes(`data-field="${key}">${view[key]}`), key)
  }
  assert.match(html, /英文简介/u)
  assert.match(html, /中文翻译/u)
  assert.doesNotMatch(html, /希洛|<script|<img|<iframe|127\.0\.0\.1|@import|url\(/iu)
  assert.match(html, /Content-Security-Policy/u)
  assert.match(html, /default-src 'none'/u)
  assert.match(html, /script-src 'none'/u)
  assert.match(html, /connect-src 'none'/u)
  assert.match(html, /white-space:pre-wrap/u)
})

test('oversize or structured fields are refused rather than truncated or coerced into HTML', () => {
  assert.throws(() => buildAgentModrinthCardHtml({ ...view, descriptionEn: 'x'.repeat(16_385) }), /长度上限/u)
  assert.throws(() => buildAgentModrinthCardHtml({ ...view, author: { toString: () => '<secret>' } }), /必须是文本/u)
  assert.throws(() => buildAgentModrinthCardHtml({ ...view, downloads: Infinity }), /必须是文本/u)
  for (const timeoutMs of [0, 5001, Infinity, 1.5]) assert.throws(() => createAgentModrinthCardRenderer({ timeoutMs }), /时限/u)
})

test('each card owns an isolated offline browser, blocks every request, validates PNG, and closes both resources', async () => {
  const rows = [], renderer = createAgentModrinthCardRenderer({ launch: async options => {
    const row = fixture()
    rows.push(row)
    return row.launch(options)
  } })
  const result = await renderer.render(view, context())
  assert.deepEqual(result, { mime: 'image/png', base64: png })
  await renderer.render({ ...view, rank: 2 }, context())
  assert.equal(rows.length, 2)
  for (const row of rows) {
    const names = row.calls.map(call => call[0])
    assert.deepEqual(row.calls.find(call => call[0] === 'js'), ['js', false])
    assert.deepEqual(row.calls.find(call => call[0] === 'serviceWorker'), ['serviceWorker', true])
    assert.deepEqual(row.calls.find(call => call[0] === 'interception'), ['interception', true])
    assert.deepEqual(row.calls.find(call => call[0] === 'offline'), ['offline', true])
    assert.ok(['js', 'interception', 'offline'].every(name => names.indexOf(name) < names.indexOf('html')))
    assert.equal(names.filter(name => name === 'pageClose').length, 1)
    assert.equal(names.filter(name => name === 'browserClose').length, 1)
    const launch = row.calls.find(call => call[0] === 'launch')[1]
    assert.equal(launch.headless, true)
    assert.ok(launch.timeout <= 5000)
    assert.ok(!launch.args.includes('--no-sandbox'))
    const screenshot = row.calls.find(call => call[0] === 'screenshot')[1]
    assert.equal(screenshot.type, 'png')
    assert.deepEqual(screenshot.clip, { x: 0, y: 0, width: 980, height: 1400 })
    const requests = []
    row.handlers.get('request')({ abort: async reason => requests.push(reason) })
    await delay(0)
    assert.deepEqual(requests, ['blockedbyclient'])
  }
})

test('stale or asynchronously revoked authority never starts Chromium', async () => {
  let launches = 0
  const renderer = createAgentModrinthCardRenderer({ launch: async () => { launches++; throw new Error('must not launch') } })
  await assert.rejects(renderer.render(view, context({ isCurrent: () => false })), /授权已失效/u)
  await assert.rejects(renderer.render(view, context({ ensureCurrent: async () => { throw new Error('source revoked') } })), /source revoked/u)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(renderer.render(view, context({ signal: controller.signal })), /授权已失效/u)
  assert.equal(launches, 0)
})

test('cancellation while launch is pending closes its late browser without creating a page', async () => {
  const controller = new AbortController(), gate = deferred(), started = deferred(), row = fixture()
  const renderer = createAgentModrinthCardRenderer({ launch: async () => { started.resolve(); return gate.promise } })
  const rendering = renderer.render(view, context({ signal: controller.signal }))
  await started.promise
  controller.abort()
  await assert.rejects(rendering, /已取消/u)
  gate.resolve(row.browser)
  await delay(0)
  assert.equal(row.calls.filter(call => call[0] === 'newPage').length, 0)
  assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
})

test('deadline while launch is pending closes its late browser despite the launcher ignoring cancellation', async () => {
  const gate = deferred(), started = deferred(), row = fixture()
  const renderer = createAgentModrinthCardRenderer({ timeoutMs: 30, launch: async () => { started.resolve(); return gate.promise } })
  const rendering = renderer.render(view, context())
  await started.promise
  await assert.rejects(rendering, /超时/u)
  gate.resolve(row.browser)
  await delay(0)
  assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
  assert.equal(row.calls.filter(call => call[0] === 'newPage').length, 0)
})

test('a page arriving after cancellation is also closed and never receives content', async () => {
  const controller = new AbortController(), gate = deferred(), started = deferred()
  const row = fixture({ browser: { async newPage() { started.resolve(); return gate.promise } } })
  const renderer = createAgentModrinthCardRenderer({ launch: row.launch })
  const rendering = renderer.render(view, context({ signal: controller.signal }))
  await started.promise
  controller.abort()
  await assert.rejects(rendering, /已取消/u)
  gate.resolve(row.page)
  await delay(0)
  assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
  assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
  assert.ok(!row.calls.some(call => call[0] === 'html'))
})

test('hung rendering, excessive canvas, malformed screenshots, and late authority loss all close their resources', async t => {
  for (const [name, changes, expected] of [
    ['hung content', { page: { setContent: async () => new Promise(() => {}) } }, /超时/u],
    ['oversize canvas', { page: { evaluate: async () => 8193 } }, /画布上限/u],
    ['invalid image bytes', { page: { screenshot: async () => Buffer.from('<html>not png</html>') } }, /图片数据无效/u],
    ['renderer error', { page: { screenshot: async () => { throw new Error('screenshot unavailable') } } }, /screenshot unavailable/u],
  ]) await t.test(name, async () => {
    const row = fixture(changes)
    await assert.rejects(createAgentModrinthCardRenderer({ launch: row.launch, timeoutMs: 40 }).render(view, context()), expected)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
    if (name === 'oversize canvas') assert.ok(!row.calls.some(call => call[0] === 'screenshot'))
  })
  await t.test('authority revoked at screenshot completion', async () => {
    let active = true
    const row = fixture({ page: { async screenshot() { active = false; return pngBytes } } })
    await assert.rejects(createAgentModrinthCardRenderer({ launch: row.launch }).render(view, context({ isCurrent: () => active })), /授权已失效/u)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
  })
})

test('failed or stalled DevTools cleanup also terminates the owned browser process', async () => {
  let killed = 0
  const rejected = fixture({ browser: {
    process: () => ({ kill(signal) { assert.equal(signal, 'SIGKILL'); killed++ } }),
    async close() { throw new Error('DevTools unavailable') },
  } })
  await createAgentModrinthCardRenderer({ launch: rejected.launch }).render(view, context())
  assert.equal(killed, 1)
  const stalled = fixture({ browser: {
    process: () => ({ kill(signal) { assert.equal(signal, 'SIGKILL'); killed++ } }),
    close: async () => new Promise(() => {}),
  } })
  await assert.rejects(createAgentModrinthCardRenderer({ launch: stalled.launch, timeoutMs: 30 }).render(view, context()), /超时/u)
  await delay(270)
  assert.equal(killed, 2)
})

const browserPath = process.env.BL_AGENT_TEST_CHROMIUM || (existsSync(puppeteer.executablePath()) ? puppeteer.executablePath() : '')
test('real Chromium renders complete bilingual PNG with literal untrusted text and no external resources', {
  skip: browserPath ? false : 'Chromium unavailable; set BL_AGENT_TEST_CHROMIUM to verify real rendering',
}, async () => {
  const observed = { requests: [], browserClosed: false }
  const original = 'A & B <img src="http://127.0.0.1:1/icon">\r\n  Exact English spacing.\n<script>fetch("file:///etc/passwd")</script>'
  const renderer = createAgentModrinthCardRenderer({ launch: async options => {
    const browser = await puppeteer.launch({ ...options, executablePath: browserPath })
    const newPage = browser.newPage.bind(browser), close = browser.close.bind(browser)
    browser.newPage = async () => {
      const page = await newPage(), screenshot = page.screenshot.bind(page)
      page.on('request', request => observed.requests.push(request.url()))
      page.screenshot = async options => {
        observed.document = await page.evaluate(() => ({
          english: document.querySelector('[data-field="descriptionEn"]').textContent,
          chinese: document.querySelector('[data-field="descriptionZh"]').textContent,
          name: document.querySelector('[data-field="name"]').textContent,
          unsafeElements: document.querySelectorAll('script,img,iframe,link,object,embed').length,
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }))
        return screenshot(options)
      }
      return page
    }
    browser.close = async () => { await close(); observed.browserClosed = true }
    return browser
  } })
  const image = await renderer.render({ ...view, descriptionEn: original }, context())
  const bytes = Buffer.from(image.base64, 'base64')
  assert.equal(image.mime, 'image/png')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(bytes.readUInt32BE(16), 980)
  assert.ok(bytes.readUInt32BE(20) > 900)
  assert.equal(observed.document.english, original)
  assert.equal(observed.document.chinese, view.descriptionZh)
  assert.equal(observed.document.name, view.name)
  assert.equal(observed.document.unsafeElements, 0)
  assert.match(observed.document.csp, /connect-src 'none'/u)
  assert.equal(observed.document.width, 980)
  assert.ok(observed.document.height <= 8192)
  assert.deepEqual(observed.requests, [])
  assert.equal(observed.browserClosed, true)
  if (process.env.BL_AGENT_TEST_CARD_PNG) await writeFile(process.env.BL_AGENT_TEST_CARD_PNG, bytes)
})
