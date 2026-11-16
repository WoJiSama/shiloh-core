import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'

const repo = fileURLToPath(new URL('../', import.meta.url))
const { createAgentMindMapRenderer } = await import(pathToFileURL(path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo,
  'dist/backend/modules/media/infrastructure/agentMindMapRenderer.js')).href)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png, 'base64')
const context = changes => ({ signal: new AbortController().signal, isCurrent: () => true, ...changes })
const input = { markdown: '# 学习路线 **Plan**\n## 基础 *概念*\n### 行内 `code`\n## 练习与反馈' }
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
    async setBypassServiceWorker(value) { calls.push(['serviceWorker', value]) },
    async setRequestInterception(value) { calls.push(['interception', value]) },
    on(event, handler) { handlers.set(event, handler) },
    async setOfflineMode(value) { calls.push(['offline', value]) },
    async setViewport(value) { calls.push(['viewport', value]) },
    async setContent(html, options) { calls.push(['html', html, options]) },
    async addScriptTag(options) { calls.push(['script', options]) },
    async evaluate(_expression, tree) { if (tree === undefined) return 'fixture visible labels'; calls.push(['layout', tree]) },
    async waitForFunction(expression, options) { calls.push(['ready', expression, options]) },
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

test('renderer uses actual Transformer with safe formatting and owns an offline fixed-size browser per render', async () => {
  const rows = [], renderer = createAgentMindMapRenderer({ launch: async options => {
    const row = fixture(); rows.push(row); return row.launch(options)
  } })
  assert.deepEqual(await renderer.render(input, context()), { mime: 'image/png', base64: png })
  await renderer.render({ ...input, width: 99999, height: -1, waitTime: 99999 }, context())
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].calls.find(call => call[0] === 'viewport')[1], { width: 2400, height: 1600, deviceScaleFactor: 1 })
  assert.deepEqual(rows[1].calls.find(call => call[0] === 'viewport')[1], { width: 4096, height: 240, deviceScaleFactor: 1 })
  for (const row of rows) {
    const tree = row.calls.find(call => call[0] === 'layout')[1], serialized = JSON.stringify(tree)
    assert.match(serialized, /<strong>Plan<\/strong>/u)
    assert.match(serialized, /<em>[^<]+<\/em>/u)
    assert.match(serialized, /<code>code<\/code>/u)
    assert.ok(!serialized.includes('payload'))
    assert.equal(row.calls.filter(call => call[0] === 'script').length, 2, 'only installed d3 and markmap-view assets are injected')
    const html = row.calls.find(call => call[0] === 'html')[1]
    assert.match(html, /connect-src 'none'/u)
    assert.doesNotMatch(html, /<script|https?:|file:|iframe|@import/iu)
    assert.deepEqual(row.calls.find(call => call[0] === 'serviceWorker'), ['serviceWorker', true])
    assert.deepEqual(row.calls.find(call => call[0] === 'interception'), ['interception', true])
    assert.deepEqual(row.calls.find(call => call[0] === 'offline'), ['offline', true])
    const launch = row.calls.find(call => call[0] === 'launch')[1]
    assert.equal(launch.headless, true)
    assert.ok(launch.timeout <= 20000)
    assert.ok(!launch.args.includes('--no-sandbox'))
    const viewport = row.calls.find(call => call[0] === 'viewport')[1]
    const shot = row.calls.find(call => call[0] === 'screenshot')[1]
    assert.deepEqual(shot.clip, { x: 0, y: 0, width: viewport.width, height: viewport.height })
    assert.equal(shot.captureBeyondViewport, false)
    assert.ok(row.calls.find(call => call[0] === 'ready')[2].timeout <= 20000)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    const blocked = []
    row.handlers.get('request')({ abort: async reason => blocked.push(reason) })
    await delay(0)
    assert.deepEqual(blocked, ['blockedbyclient'])
  }
})

test('untrusted Markdown is independently bounded and raw active HTML is rejected before browser launch', async () => {
  let launches = 0
  const renderer = createAgentMindMapRenderer({ launch: async () => { launches++; throw new Error('unexpected launch') } })
  for (const markdown of ['', 'ordinary text', '# '.concat('字'.repeat(24000)), '# Root\n```js\nalert(1)\n```', '# Root\n~~~\ncode\n~~~',
    '# Root\n###### too deep', '# Root\n' + Array.from({ length: 256 }, (_, index) => `## Node ${index}`).join('\n'),
    '# Root\n## A\n### B\n#### C\n##### D\n- sixth level', '# Root\n<img src="http://127.0.0.1/private" onerror="alert(1)">',
    '# Root <iframe src="file:///etc/passwd"></iframe>', '# Root\n<script>fetch("https://evil.test")</script>',
    '# Root <svg/onload=alert(1)>', '# Root\n<!-- markmap: fold -->', '# Root\u0000bad',
  ]) await assert.rejects(renderer.render({ markdown }, context()), /Markdown|标题|节点|HTML|5级/u)
  await assert.rejects(renderer.render({ ...input, path: '/etc/passwd' }, context()), /参数/u)
  for (const timeoutMs of [0, 20001, Infinity, NaN, 0.5]) assert.throws(() => createAgentMindMapRenderer({ timeoutMs }), /时限/u)
  assert.equal(launches, 0)
})

test('stale authority, async revocation and an already aborted request never launch Chromium', async () => {
  let launches = 0
  const renderer = createAgentMindMapRenderer({ launch: async () => { launches++; throw new Error('unexpected launch') } })
  await assert.rejects(renderer.render(input, context({ isCurrent: () => false })), /授权/u)
  await assert.rejects(renderer.render(input, context({ ensureCurrent: async () => { throw new Error('source revoked') } })), /source revoked/u)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(renderer.render(input, context({ signal: controller.signal })), /授权/u)
  assert.equal(launches, 0)
})

test('canceled and timed-out launches close late browsers without admitting a page', async t => {
  for (const kind of ['cancel', 'timeout']) await t.test(kind, async () => {
    const controller = new AbortController(), gate = deferred(), started = deferred(), row = fixture()
    const renderer = createAgentMindMapRenderer({ timeoutMs: kind === 'timeout' ? 30 : 20000,
      launch: async () => { started.resolve(); return gate.promise } })
    const rendering = renderer.render(input, context({ signal: controller.signal }))
    await started.promise
    if (kind === 'cancel') controller.abort()
    await assert.rejects(rendering, kind === 'cancel' ? /已取消/u : /超时/u)
    gate.resolve(row.browser)
    await delay(0)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    assert.ok(!row.calls.some(call => call[0] === 'newPage'))
  })
})

test('a page arriving after cancellation is closed without receiving Markdown or scripts', async () => {
  const controller = new AbortController(), gate = deferred(), started = deferred()
  const row = fixture({ browser: { newPage: async () => { started.resolve(); return gate.promise } } })
  const rendering = createAgentMindMapRenderer({ launch: row.launch }).render(input, context({ signal: controller.signal }))
  await started.promise; controller.abort()
  await assert.rejects(rendering, /已取消/u)
  gate.resolve(row.page); await delay(0)
  assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
  assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
  assert.ok(!row.calls.some(call => ['html', 'script', 'layout'].includes(call[0])))
})

test('hung layout, image validation failure and permission loss after screenshot close all owned resources', async t => {
  for (const [name, changes, expected] of [
    ['hung layout', { page: { evaluate: async () => new Promise(() => {}) } }, /超时/u],
    ['invalid bytes', { page: { screenshot: async () => Buffer.from('<html>not png</html>') } }, /图片数据无效/u],
    ['screenshot failure', { page: { screenshot: async () => { throw new Error('shot failed') } } }, /shot failed/u],
  ]) await t.test(name, async () => {
    const row = fixture(changes)
    await assert.rejects(createAgentMindMapRenderer({ launch: row.launch, timeoutMs: 80 }).render(input, context()), expected)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
  })
  let active = true
  const row = fixture({ page: { screenshot: async () => { active = false; return pngBytes } } })
  await assert.rejects(createAgentMindMapRenderer({ launch: row.launch }).render(input, context({ isCurrent: () => active })), /授权/u)
  assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
})

test('failed or stalled DevTools cleanup force-kills the owned Chromium process', async () => {
  let killed = 0
  const process = () => ({ kill(signal) { assert.equal(signal, 'SIGKILL'); killed++ } })
  const failed = fixture({ browser: { process, close: async () => { throw new Error('DevTools failed') } } })
  await createAgentMindMapRenderer({ launch: failed.launch }).render(input, context())
  assert.equal(killed, 1)
  const stalled = fixture({ browser: { process, close: async () => new Promise(() => {}) } })
  await assert.rejects(createAgentMindMapRenderer({ launch: stalled.launch, timeoutMs: 40 }).render(input, context()), /超时/u)
  await delay(270)
  assert.equal(killed, 2)
})

const browserPath = [process.env.BL_AGENT_TEST_CHROMIUM, puppeteer.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => value && existsSync(value))

test('real Chromium renders local Markmap nodes, safe inline formatting and hostile entity text with zero network requests', {
  timeout: 30000,
}, async t => {
  assert.ok(browserPath, 'Chromium is required; set BL_AGENT_TEST_CHROMIUM rather than skipping real rendering')
  const observed = { requests: [], closed: false }
  const markdown = '# 思维导图 **Plan**\n## a < b & c\n### 行内 `code` 与 *强调*\n## &lt;img src="http://127.0.0.1/private" onerror="alert(1)"&gt;\n## [链接](https://evil.example/steal)\n## ![图片](file:///etc/passwd)\n## &lt;/script&gt;&lt;script&gt;fetch("https://evil.example")&lt;/script&gt;'
  const renderer = createAgentMindMapRenderer({ launch: async options => {
    const browser = await puppeteer.launch({ ...options, executablePath: browserPath })
    const newPage = browser.newPage.bind(browser), close = browser.close.bind(browser)
    browser.newPage = async () => {
      const page = await newPage(), screenshot = page.screenshot.bind(page)
      page.on('request', request => observed.requests.push(request.url()))
      page.screenshot = async options => {
        observed.document = await page.evaluate(() => ({
          labels: [...document.querySelectorAll('foreignObject')].map(node => node.textContent),
          nodes: document.querySelectorAll('g.markmap-node').length,
          bold: document.querySelectorAll('foreignObject strong').length,
          code: document.querySelectorAll('foreignObject code').length,
          emphasis: document.querySelectorAll('foreignObject em').length,
          unsafeElements: document.querySelectorAll('img,a,iframe,link,object,embed,video,audio').length,
          unsafeAttributes: [...document.querySelectorAll('*')].flatMap(node => [...node.attributes]).filter(attr => /^(?:on|src|href)/i.test(attr.name)).map(attr => attr.name),
          scripts: [...document.scripts].map(script => ({ src: script.src, localAsset: script.textContent.length > 10000 })),
          ready: window.__mindmapReady,
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
          viewport: [innerWidth, innerHeight],
          links: document.querySelectorAll('path.markmap-link').length,
          withinCanvas: [...document.querySelectorAll('foreignObject')].every(node => {
            const rect = node.getBoundingClientRect()
            return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
          }),
        }))
        return screenshot(options)
      }
      return page
    }
    browser.close = async () => { await close(); observed.closed = true }
    return browser
  } })
  const image = await renderer.render({ markdown, width: 1200, height: 800, waitTime: 1000 }, context())
  const bytes = Buffer.from(image.base64, 'base64')
  assert.equal(image.mime, 'image/png')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 800])
  assert.equal(observed.document.nodes, 7)
  assert.equal(observed.document.links, 6)
  assert.equal(observed.document.bold, 1)
  assert.equal(observed.document.code, 1)
  assert.equal(observed.document.emphasis, 1)
  assert.ok(observed.document.labels.includes('a < b & c'))
  assert.ok(observed.document.labels.some(text => text.includes('<img src="http://127.0.0.1/private" onerror="alert(1)">')))
  assert.ok(observed.document.labels.some(text => text.includes('</script><script>fetch("https://evil.example")</script>')))
  assert.equal(observed.document.unsafeElements, 0)
  assert.deepEqual(observed.document.unsafeAttributes, [])
  assert.deepEqual(observed.document.scripts, [{ src: '', localAsset: true }, { src: '', localAsset: true }])
  assert.equal(observed.document.ready, true)
  assert.equal(observed.document.withinCanvas, true, 'all finished, fitted node boxes remain inside the fixed canvas')
  assert.deepEqual(observed.document.viewport, [1200, 800])
  assert.match(observed.document.csp, /connect-src 'none'/u)
  assert.deepEqual(observed.requests, [])
  assert.equal(observed.closed, true)
  t.diagnostic(JSON.stringify({ nodes: observed.document.nodes, links: observed.document.links, scripts: observed.document.scripts,
    unsafeElements: observed.document.unsafeElements, unsafeAttributes: observed.document.unsafeAttributes,
    viewport: observed.document.viewport, withinCanvas: observed.document.withinCanvas, ready: observed.document.ready,
    externalRequests: observed.requests.length, browserClosed: observed.closed }))
  if (process.env.BL_AGENT_TEST_MINDMAP_PNG) await writeFile(process.env.BL_AGENT_TEST_MINDMAP_PNG, bytes)
})

test('real Chromium cancellation during page admission closes its page and browser without a screenshot', {
  timeout: 30000,
}, async () => {
  assert.ok(browserPath, 'Chromium is required for cancellation acceptance')
  const controller = new AbortController(), observed = { screenshots: 0, closed: false, pageClosed: false }
  const renderer = createAgentMindMapRenderer({ launch: async options => {
    const browser = await puppeteer.launch({ ...options, executablePath: browserPath })
    const newPage = browser.newPage.bind(browser), close = browser.close.bind(browser)
    browser.newPage = async () => {
      const page = await newPage(), screenshot = page.screenshot.bind(page)
      page.on('close', () => { observed.pageClosed = true })
      page.screenshot = async options => { observed.screenshots++; return screenshot(options) }
      controller.abort()
      return page
    }
    browser.close = async () => { await close(); observed.closed = true }
    return browser
  } })
  await assert.rejects(renderer.render(input, context({ signal: controller.signal })), /取消|授权/u)
  for (let attempt = 0; attempt < 200 && (!observed.closed || !observed.pageClosed); attempt++) await delay(10)
  assert.equal(observed.screenshots, 0)
  assert.equal(observed.pageClosed, true)
  assert.equal(observed.closed, true)
})

test('real Chromium visible-text policy rejects formatting and entities before screenshot', { timeout: 30000 }, async t => {
  for (const [markdown, forbidden] of [['# blo**ck**ed', 'blocked'], ['# blo&#99;ked', 'blocked'], ['# sec`ret`', 'secret']]) await t.test(markdown, async () => {
    let screenshots = 0, checked = '', closed = false
    const renderer = createAgentMindMapRenderer({ launch: async options => {
      const browser = await puppeteer.launch({ ...options, executablePath: browserPath })
      const newPage = browser.newPage.bind(browser), close = browser.close.bind(browser)
      browser.newPage = async () => {
        const page = await newPage(), screenshot = page.screenshot.bind(page)
        page.screenshot = async options => { screenshots++; return screenshot(options) }
        return page
      }
      browser.close = async () => { await close(); closed = true }
      return browser
    } })
    await assert.rejects(renderer.render({ markdown }, context({ assertText(visible) {
      checked = visible
      if (visible.includes(forbidden)) throw new Error('visible text is forbidden')
    } })), /visible text is forbidden/u)
    assert.ok(checked.includes(forbidden))
    assert.equal(screenshots, 0)
    assert.equal(closed, true)
  })
})
