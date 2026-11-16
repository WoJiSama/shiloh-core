import assert from 'node:assert/strict'
import {mkdtemp, readdir, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import {createAgentTextImageRenderer} from '../dist/backend/modules/media/infrastructure/agentTextImageRenderer.js'
import {buildTextImageChatSvg, prepareTextImageContent} from '../dist/backend/modules/rendering/infrastructure/textImageTemplates.js'
import {markdownToDocumentHtml, markdownToKnowledgeHtml} from '../dist/backend/modules/rendering/infrastructure/TextImageTool.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png, 'base64')
const context = changes => ({signal: new AbortController().signal, isCurrent: () => true, ...changes})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return {promise, resolve} }
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
    async evaluate(callback) {
      if (callback.toString().includes('document.fonts')) return undefined
      return callback.toString().includes('innerText') ? 'fixture visible text' : 1400
    },
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
  return {calls, handlers, page, browser, launch}
}

test('shared legacy template selection, code highlighting, tables, knowledge sections and Unicode truncation remain complete', () => {
  assert.equal(prepareTextImageContent('短文本').template, 'chat')
  assert.equal(prepareTextImageContent('##无空格标题', 'chat').template, 'document')
  assert.equal(prepareTextImageContent('```java\nclass Demo {}\n```', 'chat').template, 'document')
  assert.equal(prepareTextImageContent('公式 \\(E=mc^2\\)', 'chat').template, 'document')
  assert.equal(prepareTextImageContent('##标题', 'knowledge').template, 'knowledge')
  assert.equal(Array.from(prepareTextImageContent('😀'.repeat(5001)).text).length, 5000)
  const doc = prepareTextImageContent('# 标题\n' + '😀'.repeat(12001), 'document')
  assert.equal(Array.from(doc.text).length, 12000)
  assert.ok(!/[\uD800-\uDBFF]$/u.test(doc.text))
  const html = markdownToDocumentHtml('##无空格标题\n\n| 名称 | 值 |\n| -- | -- |\n| a | 1 |\n\njava\npublic class Demo {\n  int value = 1;\n}')
  assert.match(html, /<h2>无空格标题<\/h2>/u)
  assert.match(html, /md-table/u)
  assert.match(html, /code-label">java/u)
  assert.match(html, /token keyword/u)
  const knowledge = markdownToKnowledgeHtml('# 入门\n\n一句结论。\n\n## 配置\n版本: 1\n加载器: Fabric\n\n1. 安装工具\n2. 运行例子\n\n- 检查环境\n- 编译项目\n\n> 注意事项\n\n```js\nconst a = 1\n```')
  for (const name of ['knowledge-header', 'knowledge-lead', 'knowledge-facts', 'knowledge-steps', 'knowledge-checklist', 'knowledge-note', 'code-block']) assert.ok(knowledge.includes(name), name)
})

test('renderer validates its public parameters before starting a browser', async () => {
  for (const timeoutMs of [0, 20001, Infinity, 1.5]) assert.throws(() => createAgentTextImageRenderer({timeoutMs}), /时限/u)
  let launches = 0
  const renderer = createAgentTextImageRenderer({launch: async () => { launches++; throw Error('unexpected') }})
  for (const input of [{text: ''}, {text: 'x'.repeat(48001)}, {text: 'a', nickname: 'x'.repeat(101)}, {text: 'a', template: 'html'}, {text: 'a', avatarUrl: 'https://example.invalid'}]) {
    await assert.rejects(renderer.render(input, context()), /参数无效/u)
  }
  assert.equal(launches, 0)
})

test('document renderer uses complete local templates, embeds all formula fonts, blocks external and file resources, and owns cleanup', async () => {
  const row = fixture(), renderer = createAgentTextImageRenderer({launch: row.launch})
  assert.deepEqual(await renderer.render({text: '# 文档\n\n\\(E=mc^2\\)\n\n<img src="https://example.invalid" onerror="alert(1)">', template: 'document'}, context()), {mime: 'image/png', base64: png})
  const html = row.calls.find(call => call[0] === 'html')[1]
  assert.match(html, /class="document"/u)
  assert.match(html, /class="katex"/u)
  assert.match(html, /data-katex-inline/u)
  assert.match(html, /url\(data:font\/woff2;base64,/u)
  assert.match(html, /&lt;img src=&quot;https:\/\/example\.invalid/u)
  assert.doesNotMatch(html, /<script|<img|<iframe|<link|file:\/\/|url\(fonts\//iu)
  const names = row.calls.map(call => call[0])
  for (const name of ['js', 'interception', 'offline']) assert.ok(names.indexOf(name) < names.indexOf('html'))
  assert.deepEqual(row.calls.find(call => call[0] === 'js'), ['js', false])
  assert.deepEqual(row.calls.find(call => call[0] === 'offline'), ['offline', true])
  assert.deepEqual(row.calls.find(call => call[0] === 'viewport')[1], {width: 980, height: 1200, deviceScaleFactor: 2})
  assert.deepEqual(row.calls.find(call => call[0] === 'screenshot')[1].clip, {x: 0, y: 0, width: 980, height: 1400})
  assert.equal(names.filter(name => name === 'pageClose').length, 1)
  assert.equal(names.filter(name => name === 'browserClose').length, 1)
  assert.ok(!row.calls.find(call => call[0] === 'launch')[1].args.includes('--no-sandbox'))
  const handled = []
  for (const url of ['https://example.invalid/a', 'http://127.0.0.1/a', 'file:///etc/passwd', 'data:image/svg+xml,x', 'data:font/woff2;base64,YQ==']) {
    row.handlers.get('request')({url: () => url, abort: async () => handled.push(['abort', url]), continue: async () => handled.push(['continue', url])})
  }
  await delay(0)
  assert.deepEqual(handled.map(item => item[0]), ['abort', 'abort', 'abort', 'abort', 'continue'])
})

test('chat renders the complete SVG layout with a decoded raster avatar, without browser or network access', async () => {
  const avatar = await sharp({create: {width: 24, height: 16, channels: 3, background: '#33aa66'}}).jpeg().toBuffer()
  const renderer = createAgentTextImageRenderer({launch: async () => { throw Error('chat must not launch Chromium') }})
  const result = await renderer.render({text: '聊天内容\n第二行', nickname: '机器人 <script>', avatar: {mime: 'image/jpeg', base64: avatar.toString('base64')}}, context())
  const image = Buffer.from(result.base64, 'base64'), metadata = await sharp(image).metadata()
  assert.equal(result.mime, 'image/png')
  assert.equal(metadata.format, 'png')
  assert.ok(metadata.width > 300)
  assert.ok(metadata.height > 150)
  await assert.rejects(renderer.render({text: 'hello', avatar: {mime: 'image/png', base64: Buffer.from('<svg><image href="http://127.0.0.1"/></svg>').toString('base64')}}, context()), /图片数据无效/u)
})

test('chat visible text includes the actual nickname, decoded literal glyphs, code labels and preserved line boundaries', async () => {
  const layout = buildTextImageChatSvg({text: 'first **bold**\nsecond `line`', nickname: '名称 <&>'})
  assert.equal(layout.visibleText, '名称 <&>\nfirst bold\nsecond line')
  const code = buildTextImageChatSvg({text: '```java\npublic class Demo {}\n```', nickname: '名称'})
  assert.match(code.visibleText, /^名称\njava\npublic class Demo \{\}/u)
  assert.doesNotMatch(layout.visibleText, /tspan|&lt;|font-size/u)
  let checked = ''
  const renderer = createAgentTextImageRenderer()
  await renderer.render({text: '普通**中文**与 & 字符', nickname: '昵称 <&>'}, context({assertText: visible => { checked = visible }}))
  assert.equal(checked, '昵称 <&>\n普通中文与 & 字符')
})

test('authority is rechecked after visible-text policy execution and before either raster path', async () => {
  for (const template of ['chat', 'document']) {
    let active = true
    const row = fixture()
    await assert.rejects(createAgentTextImageRenderer({launch: row.launch}).render({text: 'ordinary', template}, context({
      isCurrent: () => active, assertText: () => { active = false },
    })), /授权已失效/u)
    assert.ok(!row.calls.some(call => call[0] === 'screenshot'))
  }
})

test('canvas budgets reject excessive chat and document heights before rasterization or screenshot', async () => {
  const renderer = createAgentTextImageRenderer({launch: async () => { throw Error('chat must not launch') }})
  await assert.rejects(renderer.render({text: 'x\n'.repeat(2499) + 'x'}, context()), /画布或像素上限/u)
  for (const height of [8193, Infinity, NaN, 1.5, 0]) {
    const row = fixture({page: {async evaluate(callback) { return callback.toString().includes('document.fonts') ? undefined : height }}})
    await assert.rejects(createAgentTextImageRenderer({launch: row.launch}).render({text: 'document', template: 'document'}, context()), /画布或像素上限/u)
    assert.ok(!row.calls.some(call => call[0] === 'screenshot'))
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
  }
})

test('stale, aborted and asynchronously revoked authority do not start rendering', async () => {
  let launches = 0
  const renderer = createAgentTextImageRenderer({launch: async () => { launches++; throw Error('unexpected launch') }})
  const controller = new AbortController(); controller.abort()
  for (const ctx of [context({isCurrent: () => false}), context({signal: controller.signal}), context({ensureCurrent: async () => { throw Error('source revoked') }})]) {
    await assert.rejects(renderer.render({text: 'document', template: 'document'}, ctx), /授权已失效|source revoked/u)
  }
  assert.equal(launches, 0)
})

test('cancellation, deadline and revocation clean browsers or pages that arrive late', async t => {
  for (const kind of ['cancel-launch', 'timeout-launch', 'revoke-launch', 'cancel-page']) await t.test(kind, async () => {
    const gate = deferred(), started = deferred(), controller = new AbortController()
    let active = true
    const row = fixture(kind === 'cancel-page' ? {browser: {async newPage() { started.resolve(); return gate.promise }}} : {})
    const renderer = createAgentTextImageRenderer({timeoutMs: kind === 'timeout-launch' ? 50 : 2000, launch: kind === 'cancel-page' ? row.launch : async () => { started.resolve(); return gate.promise }})
    const rendering = renderer.render({text: 'document', template: 'document'}, context({signal: controller.signal, isCurrent: () => active}))
    await started.promise
    if (kind.startsWith('cancel')) controller.abort()
    if (kind === 'revoke-launch') active = false
    await assert.rejects(rendering, /已取消|超时|授权已失效/u)
    gate.resolve(kind === 'cancel-page' ? row.page : row.browser)
    await delay(0)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, kind === 'cancel-page' ? 1 : 0)
    assert.ok(!row.calls.some(call => call[0] === 'html'))
  })
})

test('hung content, font waits, bad bytes and authority loss release resources without returning an image', async t => {
  for (const [name, changes, expected] of [
    ['content', {setContent: async () => new Promise(() => {})}, /超时/u],
    ['fonts', {evaluate: async () => new Promise(() => {})}, /超时/u],
    ['bad bytes', {screenshot: async () => Buffer.from('not PNG')}, /图片数据无效/u],
    ['screenshot exception', {screenshot: async () => { throw Error('screenshot unavailable') }}, /screenshot unavailable/u],
  ]) await t.test(name, async () => {
    const row = fixture({page: changes})
    await assert.rejects(createAgentTextImageRenderer({launch: row.launch, timeoutMs: 70}).render({text: 'document', template: 'document'}, context()), expected)
    assert.equal(row.calls.filter(call => call[0] === 'browserClose').length, 1)
    assert.equal(row.calls.filter(call => call[0] === 'pageClose').length, 1)
  })
  let active = true
  const row = fixture({page: {async screenshot() { active = false; return pngBytes }}})
  await assert.rejects(createAgentTextImageRenderer({launch: row.launch}).render({text: 'document', template: 'document'}, context({isCurrent: () => active})), /授权已失效/u)
})

test('failed or hung browser cleanup terminates the owned process within the renderer deadline', async () => {
  let killed = 0
  const row = fixture({browser: {process: () => ({kill() { killed++ }}), close: async () => { throw Error('unavailable') }}})
  await createAgentTextImageRenderer({launch: row.launch}).render({text: 'document', template: 'document'}, context())
  assert.equal(killed, 1)
  const stalled = fixture({browser: {process: () => ({kill() { killed++ }}), close: async () => new Promise(() => {})}})
  await assert.rejects(createAgentTextImageRenderer({launch: stalled.launch, timeoutMs: 50}).render({text: 'document', template: 'document'}, context()), /超时/u)
  await delay(270)
  assert.equal(killed, 2)
})

test('real Chromium renders complete document and knowledge PNGs with local formula fonts and zero external resources or output files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-text-images-')), originalCwd = process.cwd()
  const observed = [], requests = [], checkedTexts = []
  const renderer = createAgentTextImageRenderer({launch: async options => {
    const browser = await puppeteer.launch({...options, ...(process.env.BL_AGENT_TEST_CHROMIUM ? {executablePath: process.env.BL_AGENT_TEST_CHROMIUM} : {})})
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async () => {
      const page = await newPage(), screenshot = page.screenshot.bind(page)
      page.on('request', request => requests.push(request.url()))
      page.screenshot = async options => {
        observed.push(await page.evaluate(() => ({
          text: document.body.textContent,
          unsafe: document.querySelectorAll('script,img,iframe,object,embed,link').length,
          math: document.querySelectorAll('.katex').length,
          loadedFonts: [...document.fonts].filter(font => font.status === 'loaded').length,
          table: document.querySelectorAll('.md-table').length,
          code: document.querySelectorAll('.code-block .token.keyword').length,
          classes: ['knowledge-header', 'knowledge-lead', 'knowledge-facts', 'knowledge-steps', 'knowledge-checklist', 'knowledge-note'].filter(name => document.querySelector('.' + name)),
          height: document.body.getBoundingClientRect().height,
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        })))
        return screenshot(options)
      }
      return page
    }
    return browser
  }})
  const document = '# 文档与公式\n\n这是中文段落。\n\n##无空格标题\n\n| 名称 | 值 |\n| -- | -- |\n| 示例 | 1 |\n\n```java\npublic class Demo {\n  int value = 1;\n}\n```\n\n\\[E=mc^2\\]\n\n<img src="http://127.0.0.1:1/probe" onerror="fetch(\'file:///etc/passwd\')">\n\n![remote](https://example.invalid/probe)\n<iframe src="file:///etc/passwd"></iframe>'
  const knowledge = '# 知识卡\n\n这里是结论。\n\n## 必备配置\n版本: 1\n加载器: Fabric\n\n## 操作步骤\n1. 安装工具\n2. 运行例子\n\n- 检查环境\n- 编译项目\n\n> 注意事项。\n\n```js\nconst value = 1\n```\n\n\\(F=ma\\)'
  try {
    process.chdir(directory)
    for (const [template, text] of [['document', document], ['knowledge', knowledge]]) {
      const result = await renderer.render({text, template}, context({assertText: visible => {
        checkedTexts.push(visible)
        assert.equal(typeof visible, 'string')
        assert.doesNotMatch(visible, /@font-face|data:font\/|font-family:|\.knowledge-lead/u)
        assert.ok(visible.includes(template === 'document' ? '这是中文段落。' : '这里是结论。'))
      }}))
      const metadata = await sharp(Buffer.from(result.base64, 'base64')).metadata()
      assert.equal(metadata.format, 'png')
      assert.equal(metadata.width, 1960)
      assert.ok(metadata.height > 1000 && metadata.height <= 16384)
    }
    await assert.rejects(renderer.render({text: '# 超长文档\n\n' + '段落。\n\n'.repeat(2000), template: 'document'}, context()), /画布或像素上限/u)
    assert.equal(observed.length, 2, 'real oversize layout must be refused before screenshot')
    assert.deepEqual(await readdir(directory), [])
  } finally { process.chdir(originalCwd); await rm(directory, {recursive: true, force: true}) }
  assert.equal(observed.length, 2)
  assert.equal(checkedTexts.length, 2)
  for (const result of observed) {
    assert.equal(result.unsafe, 0)
    assert.ok(result.math >= 1)
    assert.ok(result.loadedFonts > 0, 'formula font data must load offline')
    assert.ok(result.code > 0)
    assert.match(result.csp, /connect-src 'none'/u)
  }
  assert.equal(observed[0].table, 1)
  assert.ok(observed[0].text.includes('<img src="http://127.0.0.1:1/probe"'))
  assert.equal(observed[1].classes.length, 6)
  assert.ok(requests.every(url => /^data:font\/(?:woff2?|ttf);base64,/u.test(url)), 'rendering must never request HTTP, file or other resources')
})

test('real Chromium cancellation closes a page returned after the abort and releases its browser', async () => {
  const controller = new AbortController()
  let ownedBrowser, ownedPage, receivedContent = false
  const renderer = createAgentTextImageRenderer({launch: async options => {
    const browser = await puppeteer.launch({...options, ...(process.env.BL_AGENT_TEST_CHROMIUM ? {executablePath: process.env.BL_AGENT_TEST_CHROMIUM} : {})})
    ownedBrowser = browser
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async () => {
      const page = await newPage()
      ownedPage = page
      page.setContent = async () => { receivedContent = true; throw Error('cancelled page must not receive content') }
      controller.abort()
      return page
    }
    return browser
  }})
  await assert.rejects(renderer.render({text: 'document', template: 'document'}, context({signal: controller.signal})), /已取消/u)
  for (let attempt = 0; attempt < 100 && (ownedBrowser?.connected || !ownedPage?.isClosed()); attempt++) await delay(20)
  assert.equal(ownedPage.isClosed(), true)
  assert.equal(ownedBrowser.connected, false)
  assert.equal(receivedContent, false)
})

test('formatted visible text is checked before rasterization in chat, document and knowledge', async t => {
  for (const template of ['chat', 'document', 'knowledge']) {
    for (const [text, forbidden] of [['blo**ck**ed', 'blocked'], ['sec`ret`', 'secret']]) await t.test(`${template}: ${forbidden}`, async () => {
      let screenshots = 0, checked = ''
      assert.ok(!text.includes(forbidden), 'the original text must reproduce formatting concatenation')
      const renderer = createAgentTextImageRenderer({launch: async options => {
        const browser = await puppeteer.launch({...options, ...(process.env.BL_AGENT_TEST_CHROMIUM ? {executablePath: process.env.BL_AGENT_TEST_CHROMIUM} : {})})
        const newPage = browser.newPage.bind(browser)
        browser.newPage = async () => {
          const page = await newPage(), screenshot = page.screenshot.bind(page)
          page.screenshot = async options => { screenshots++; return screenshot(options) }
          return page
        }
        return browser
      }})
      await assert.rejects(renderer.render({text, template}, context({assertText: visible => {
        checked = visible
        if (visible.includes(forbidden)) throw Error('visible text is forbidden')
      }})), /visible text is forbidden/u)
      assert.ok(checked.includes(forbidden))
      assert.equal(screenshots, 0)
    })
  }
})
