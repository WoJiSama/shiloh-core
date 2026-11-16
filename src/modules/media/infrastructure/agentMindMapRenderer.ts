import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import puppeteer from 'puppeteer'
import type { Browser, LaunchOptions, Page } from 'puppeteer'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'

type RenderContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'> & {
  /** Check parsed visible labels, before screenshot; policy rejection stops delivery. */
  readonly assertText?: (visibleText: string) => void
}
interface MindMapNode { content: string; children: MindMapNode[] }
export interface AgentMindMapRendererOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>
  /** Includes launch, layout, screenshot and cleanup; may only shorten 20 seconds. */
  readonly timeoutMs?: number
}
export interface AgentMindMapRenderInput {
  readonly markdown: string
  readonly width?: number
  readonly height?: number
  readonly waitTime?: number
}

const MAX_MARKDOWN = 24_000
const MAX_NODES = 256
const MAX_TREE_BYTES = 192_000
const MAX_PIXELS = 4096 * 4096
const requireFromHere = createRequire(import.meta.url)
// Narrow the runtime boundary rather than exporting the package's broken NodeNext declarations.
const { Transformer } = requireFromHere('markmap-lib/no-plugins') as {
  Transformer: new (plugins: never[]) => {
    md: { set(options: { html: boolean; linkify: boolean; breaks: boolean }): void; disable(rules: string[]): void }
    transform(markdown: string): { root: unknown }
  }
}
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
let localAssets: Promise<{ d3: string; view: string }> | undefined

function assets() {
  localAssets ??= (async () => {
    // Only installed, lockfile-pinned package assets are read, never input paths.
    const d3Path = path.resolve(path.dirname(requireFromHere.resolve('d3')), '../dist/d3.min.js')
    const viewPath = path.join(path.dirname(requireFromHere.resolve('markmap-view')), 'browser/index.js')
    const [d3, view] = await Promise.all([readFile(d3Path, 'utf8'), readFile(viewPath, 'utf8')])
    if (!d3 || !view || d3.length + view.length > 1024 * 1024) throw new Error('本地思维导图资源缺失或超过大小上限')
    return { d3, view }
  })().catch(error => { localAssets = undefined; throw error })
  return localAssets
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback
}

/** Keep only parser-produced formatting tags; all other markup becomes text. */
function safeContent(content: string): string {
  return content.split(/(<[^>]*>)/gu).map(piece => {
    if (/^<\/?(?:strong|em|code|s|del|ins|mark|sub|sup)>$/u.test(piece) || /^<br\s*\/?\s*>$/u.test(piece)) return piece
    return piece.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,8}|#x[\da-fA-F]{1,6});)/gu, '&amp;')
      .replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  }).join('')
}

function safeTree(markdown: unknown): MindMapNode {
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > MAX_MARKDOWN ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(markdown)) throw new Error('思维导图 Markdown 必须为不超过24000字符的有效文本')
  if (!/^ {0,3}#{1,5}[\t ]+\S/mu.test(markdown) || /^ {0,3}#{6,}[\t ]+/mu.test(markdown) ||
      markdown.includes('```') || /^\s*~{3,}/mu.test(markdown)) throw new Error('思维导图需要标题，最多5级且不能包含代码围栏')
  // Literal mathematical comparisons such as "a < b" remain ordinary text.
  if (/<\/?[a-zA-Z][a-zA-Z\d:-]*(?=[\s/>])[^<>]*>|<!--|<!DOCTYPE|<\?|<!\[CDATA\[/iu.test(markdown)) {
    throw new Error('思维导图不接受原始HTML、嵌入元素或事件属性')
  }
  const transformer = new Transformer([])
  transformer.md.set({ html: false, linkify: false, breaks: true })
  transformer.md.disable(['html_block', 'html_inline', 'image', 'link', 'autolink', 'fence', 'code'])
  const transformed = transformer.transform(markdown)
  let count = 0
  const copy = (value: unknown, depth: number): MindMapNode => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5 || ++count > MAX_NODES) {
      throw new Error('思维导图最多5级和256个节点')
    }
    const node = value as Record<string, unknown>
    if (typeof node.content !== 'string' || !Array.isArray(node.children)) throw new Error('思维导图节点无效')
    // Discard payload, style, folding directives and all plugin metadata.
    return { content: safeContent(node.content), children: node.children.map(child => copy(child, depth + 1)) }
  }
  const root = copy(transformed.root, 1)
  if (!root.content.trim() || Buffer.byteLength(JSON.stringify(root)) > MAX_TREE_BYTES) throw new Error('思维导图节点内容无效或超过大小上限')
  return root
}

/** Pure Markdown renderer with offline local assets and per-render browser ownership. */
export function createAgentMindMapRenderer(options: AgentMindMapRendererOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error('思维导图渲染时限须为1–20000毫秒')
  const launch = options.launch ?? (config => puppeteer.launch(config))

  async function render(input: AgentMindMapRenderInput, context: RenderContext): Promise<{ mime: string; base64: string }> {
    const started = Date.now(), remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
    let browser: Browser | undefined, page: Page | undefined
    let closedBrowser: Browser | undefined, closedPage: Page | undefined
    let closeBrowserPromise: Promise<void> | undefined, closePagePromise: Promise<void> | undefined
    let stoppedError: Error | undefined
    const closePage = () => {
      if (page && page !== closedPage) {
        closedPage = page
        const owned = page
        closePagePromise = Promise.resolve().then(() => owned.close()).catch(() => {})
      }
      return closePagePromise ?? Promise.resolve()
    }
    const closeBrowser = () => {
      if (browser && browser !== closedBrowser) {
        closedBrowser = browser
        const owned = browser
        const kill = () => { try { owned.process()?.kill('SIGKILL') } catch { /* Already exited or an injected launcher. */ } }
        const forceClose = setTimeout(kill, 250)
        forceClose.unref()
        closeBrowserPromise = Promise.resolve().then(() => owned.close()).catch(kill).finally(() => clearTimeout(forceClose))
      }
      return closeBrowserPromise ?? Promise.resolve()
    }
    const cleanup = () => Promise.all([closePage(), closeBrowser()]).then(() => {})
    let rejectStopped!: (reason: Error) => void
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
    const stop = (error: Error) => {
      if (stoppedError) return
      stoppedError = error
      rejectStopped(error)
      void cleanup()
    }
    const onAbort = () => stop(new Error('思维导图渲染已取消'))
    const timer = setTimeout(() => stop(new Error('思维导图渲染超时')), timeoutMs)
    const poll = setInterval(() => {
      try { if (!context.isCurrent()) stop(new Error('思维导图渲染授权已失效')) }
      catch { stop(new Error('思维导图渲染授权已失效')) }
    }, 25)
    poll.unref()
    context.signal.addEventListener('abort', onAbort, { once: true })
    const checkCurrent = () => {
      if (stoppedError) throw stoppedError
      if (context.signal.aborted || !context.isCurrent()) throw new Error('思维导图渲染授权已失效')
    }
    const ensureCurrent = async () => { checkCurrent(); await context.ensureCurrent?.(); checkCurrent() }
    const work = async () => {
      checkCurrent()
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['markdown', 'width', 'height', 'waitTime'].includes(key))) throw new Error('思维导图参数无效')
      const root = safeTree(input.markdown)
      const width = bounded(input.width, 2400, 320, 4096), height = bounded(input.height, 1600, 240, 4096)
      const waitTime = bounded(input.waitTime, 8000, 1000, 30_000)
      if (width * height > MAX_PIXELS) throw new Error('思维导图超过固定画布预算')
      await ensureCurrent()
      const scripts = await assets()
      await ensureCurrent()
      browser = await launch({ headless: true, timeout: remaining(), protocolTimeout: timeoutMs, args: [
        '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
        '--metrics-recording-only', '--no-first-run', '--no-default-browser-check', '--disable-breakpad', '--disable-extensions',
      ] })
      if (stoppedError) { void cleanup(); throw stoppedError }
      await ensureCurrent()
      page = await browser.newPage()
      if (stoppedError) { void cleanup(); throw stoppedError }
      checkCurrent()
      page.setDefaultTimeout(remaining())
      page.setDefaultNavigationTimeout(remaining())
      await page.setBypassServiceWorker(true)
      checkCurrent()
      await page.setRequestInterception(true)
      page.on('request', request => { void request.abort('blockedbyclient').catch(() => {}) })
      checkCurrent()
      await page.setOfflineMode(true)
      await page.setViewport({ width, height, deviceScaleFactor: 1 })
      await ensureCurrent()
      await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}svg{display:block;width:100%;height:100%}.markmap{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:20px}*{animation:none!important;transition:none!important}</style></head><body><svg id="mindmap" width="${width}" height="${height}"></svg></body></html>`, { waitUntil: 'domcontentloaded', timeout: remaining() })
      await ensureCurrent()
      await page.addScriptTag({ content: scripts.d3 })
      checkCurrent()
      await page.addScriptTag({ content: scripts.view })
      await ensureCurrent()
      await page.evaluate(async tree => {
        type MapView = { setData(data: MindMapNode): Promise<void>; fit(): Promise<void> }
        const runtime = window as unknown as { markmap: { Markmap: { create(element: Element, options: Record<string, unknown>): MapView } }; __mindmapReady?: boolean }
        const svg = document.getElementById('mindmap')!
        const map = runtime.markmap.Markmap.create(svg, { duration: 0, autoFit: false, pan: false, zoom: false,
          initialExpandLevel: -1, maxWidth: 480, fitRatio: 0.92 })
        await map.setData(tree)
        await document.fonts.ready
        await map.fit()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const labels = svg.querySelectorAll('foreignObject')
        if (!labels.length || svg.querySelector('a,img,iframe,object,embed,video,audio,link,script')) throw new Error('思维导图包含不安全或空的节点')
        for (const element of labels) for (const child of element.querySelectorAll('*')) {
          if ([...child.attributes].some(attribute => /^(?:on|src|href|style)/iu.test(attribute.name))) throw new Error('思维导图节点含不安全属性')
        }
        runtime.__mindmapReady = true
      }, root)
      await page.waitForFunction('window.__mindmapReady === true', { timeout: Math.min(waitTime, remaining()) })
      await ensureCurrent()
      const visibleText = await page.evaluate(() => [...document.querySelectorAll('foreignObject')]
        .map(node => (node.firstElementChild as HTMLElement | null)?.innerText ?? node.textContent ?? '').join('\n'))
      checkCurrent()
      context.assertText?.(visibleText)
      await ensureCurrent()
      const bytes = await page.screenshot({ type: 'png', encoding: 'binary', captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height }, omitBackground: false })
      await ensureCurrent()
      return validateAgentToolImageBytes(bytes, 'image/png')
    }
    try {
      const image = await Promise.race([work(), stopped])
      await Promise.race([cleanup(), stopped])
      checkCurrent()
      return image
    } catch (error) {
      await Promise.race([cleanup(), stopped]).catch(() => {})
      throw error
    } finally {
      clearTimeout(timer); clearInterval(poll)
      context.signal.removeEventListener('abort', onAbort)
      void cleanup()
    }
  }
  return { render }
}
