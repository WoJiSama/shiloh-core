import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import test from 'node:test'
import { buildAgentBilibiliCardHtml, createAgentBilibiliCardRenderer } from '../dist/backend/modules/media/infrastructure/agentBilibiliCardRenderer.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png, 'base64')
const view = {
  title: '【官方 MV】Never Gonna Give You Up', owner: '索尼音乐中国', durationText: '3:33', partText: '2个分P',
  publishedText: '2019-12-31', pageUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  stats: { '播放': '12,034', '点赞': '567', '投币': '89' }, description: '简介文本\n第二行', episode: false,
}
const context = changes => ({ signal: new AbortController().signal, isCurrent: () => true, ...changes })
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

test('card HTML keeps metadata as text, embeds the cover only as a data URI, and stays offline', () => {
  const html = buildAgentBilibiliCardHtml({ ...view,
    title: '<img src="https://evil.example/x" onerror="alert(1)">',
    description: '<script>alert("secret")</script>\r\nA & B',
    cover: { mime: 'image/png', bytes: pngBytes },
  })
  assert.match(html, /&lt;img src=&quot;https:\/\/evil\.example\/x&quot; onerror=&quot;alert\(1\)&quot;&gt;/u)
  assert.match(html, /&lt;script&gt;alert\(&quot;secret&quot;\)&lt;\/script&gt;&#13;\nA &amp; B/u)
  assert.match(html, /data:image\/png;base64,/u)
  assert.ok(html.includes(view.owner) && html.includes(view.pageUrl))
  for (const label of ['播放', '点赞', '投币']) assert.ok(html.includes(label), label)
  assert.match(html, /Content-Security-Policy/u)
  assert.match(html, /default-src 'none'/u)
  assert.match(html, /script-src 'none'/u)
  assert.match(html, /img-src data:/u)
  assert.doesNotMatch(html, /<script|127\.0\.0\.1|@import|url\(/iu)
  const withoutCover = buildAgentBilibiliCardHtml(view)
  assert.doesNotMatch(withoutCover, /data:image/u)
  assert.doesNotMatch(withoutCover, /class="cover"/u)
})

test('oversize, structured, or network-like card data is refused rather than coerced', () => {
  assert.throws(() => buildAgentBilibiliCardHtml({ ...view, title: 'x'.repeat(16_385) }), /长度上限/u)
  assert.throws(() => buildAgentBilibiliCardHtml({ ...view, owner: { toString: () => '<secret>' } }), /必须是文本/u)
  assert.throws(() => buildAgentBilibiliCardHtml({ ...view, cover: { mime: 'image/png', bytes: Buffer.alloc(9 * 1024 * 1024) } }), /封面数据无效/u)
  assert.throws(() => buildAgentBilibiliCardHtml({ ...view, cover: { mime: 'text/html', bytes: pngBytes } }), /封面数据无效/u)
  for (const timeoutMs of [0, 5001, Infinity, 1.5]) assert.throws(() => createAgentBilibiliCardRenderer({ timeoutMs }), /时限/u)
})

test('each card owns an isolated offline browser, blocks every request, validates PNG, and closes both resources', async () => {
  const rows = [], renderer = createAgentBilibiliCardRenderer({ launch: async options => {
    const row = fixture()
    rows.push(row)
    return row.launch(options)
  } })
  const result = await renderer.render(view, context())
  assert.deepEqual(result, { mime: 'image/png', base64: png })
  await renderer.render({ ...view, title: '第二个' }, context())
  assert.equal(rows.length, 2)
  for (const row of rows) {
    const names = row.calls.map(call => call[0])
    assert.deepEqual(row.calls.find(call => call[0] === 'js'), ['js', false])
    assert.deepEqual(row.calls.find(call => call[0] === 'offline'), ['offline', true])
    assert.ok(['js', 'interception', 'offline'].every(name => names.indexOf(name) < names.indexOf('html')))
    assert.equal(names.filter(name => name === 'pageClose').length, 1)
    assert.equal(names.filter(name => name === 'browserClose').length, 1)
    const launch = row.calls.find(call => call[0] === 'launch')[1]
    assert.equal(launch.headless, true)
    assert.ok(launch.timeout <= 5000)
    const screenshot = row.calls.find(call => call[0] === 'screenshot')[1]
    assert.equal(screenshot.type, 'png')
    assert.equal(screenshot.clip.width, 980)
  }
})

test('a large upstream cover is fitted before it reaches the offline browser', async () => {
  const width = 1600, height = 900
  const bytes = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer()
  assert.ok(bytes.length > 256 * 1024)
  const row = fixture(), renderer = createAgentBilibiliCardRenderer({ launch: row.launch })
  await renderer.render({ ...view, cover: { mime: 'image/png', bytes } }, context())
  const html = row.calls.find(call => call[0] === 'html')[1]
  assert.match(html, /data:image\/jpeg;base64,/u)
  assert.ok(html.length < 256 * 1024)
})

test('cancellation and expiry stop rendering with fixed errors and no late page writes', async () => {
  const controller = new AbortController()
  const gate = (() => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } })()
  const row = fixture({ browser: { async newPage() { await gate.promise; return row.page } } })
  const renderer = createAgentBilibiliCardRenderer({ launch: row.launch })
  const work = renderer.render(view, context({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(work, /已取消/u)
  gate.resolve()
  const renderer2 = createAgentBilibiliCardRenderer({ timeoutMs: 1, launch: async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    return fixture().browser
  } })
  await assert.rejects(renderer2.render(view, context()), /超时/u)
})
