import puppeteer from 'puppeteer'
import type {Browser, LaunchOptions, Page} from 'puppeteer'
import sharp from 'sharp'
import type {Sharp} from 'sharp'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import type {AgentToolContext} from '../../../contracts/agentTool.js'
import {validateAgentToolImage, validateAgentToolImageBytes} from '../../image/infrastructure/agentToolImage.js'
import {buildDocumentHtml, buildKnowledgeHtml, buildTextImageChatSvg, hasLatexMath, prepareTextImageContent} from '../../rendering/infrastructure/textImageTemplates.js'

export interface AgentTextImageRendererOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>
  /** Includes asset loading, rasterization and cleanup; never more than twenty seconds. */
  readonly timeoutMs?: number
}
export interface AgentTextImageRenderInput {
  readonly text: string
  readonly template?: 'chat' | 'document' | 'knowledge'
  readonly nickname?: string
  readonly avatar?: {readonly mime: string; readonly base64: string}
}
type RenderContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'> & {
  readonly assertText?: (visibleText: string) => void
}

const WIDTH = 980
const SCALE = 2
const MAX_SIDE = 16_384
const MAX_PIXELS = 64 * 1024 * 1024
const MAX_HTML = 8 * 1024 * 1024
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
const requireFromHere = createRequire(import.meta.url)
let mathStyles: Promise<string> | undefined

/** Only the package-owned KaTeX stylesheet and its font files are read from disk. */
function inlineMathStyles(): Promise<string> {
  if (!mathStyles) {
    mathStyles = (async () => {
      const cssFile = requireFromHere.resolve('katex/dist/katex.min.css')
      let css = await readFile(cssFile, 'utf8')
      const sources = [...new Set([...css.matchAll(/url\(([^)]+)\)/gu)].map(match => match[1]!))]
      const replacements = await Promise.all(sources.map(async source => {
        const name = source.replace(/^["']|["']$/gu, '')
        if (!/^fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/u.test(name)) throw new Error('KaTeX 字体资源路径无效')
        const extension = name.split('.').at(-1)!
        const bytes = await readFile(path.join(path.dirname(cssFile), name))
        return [source, `data:font/${extension};base64,${bytes.toString('base64')}`] as const
      }))
      const urls = new Map(replacements)
      css = css.replace(/url\(([^)]+)\)/gu, (_match, source: string) => `url(${urls.get(source)!})`)
      if (css.length > MAX_HTML / 2 || /<\/style/iu.test(css)) throw new Error('KaTeX 样式超过大小上限')
      return `<style data-katex-inline>${css}</style>`
    })().catch(error => { mathStyles = undefined; throw error })
  }
  return mathStyles
}

function assertCanvas(width: number, height: number, scale = 1) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * scale > MAX_SIDE || height * scale > MAX_SIDE || width * height * scale * scale > MAX_PIXELS) {
    throw new Error('文字图片内容超过画布或像素上限，请缩短内容后重试')
  }
}

/** The legacy layouts rendered without a platform event, remote resource or filesystem output. */
export function createAgentTextImageRenderer(options: AgentTextImageRendererOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error('文字图片渲染时限须为 1–20000 毫秒')
  const launch = options.launch ?? (config => puppeteer.launch(config))

  async function render(input: AgentTextImageRenderInput, context: RenderContext): Promise<{mime: string; base64: string}> {
    let browser: Browser | undefined, page: Page | undefined
    let closedBrowser: Browser | undefined, closedPage: Page | undefined
    let closeBrowserPromise: Promise<void> | undefined, closePagePromise: Promise<void> | undefined
    const rasters = new Set<Sharp>()
    let stoppedError: Error | undefined
    const started = Date.now(), remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
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
        const kill = () => { try { owned.process()?.kill('SIGKILL') } catch { /* Already closed. */ } }
        const forceClose = setTimeout(kill, 250)
        forceClose.unref()
        closeBrowserPromise = Promise.resolve().then(() => owned.close()).catch(kill).finally(() => clearTimeout(forceClose))
      }
      return closeBrowserPromise ?? Promise.resolve()
    }
    const cleanup = () => Promise.all([closePage(), closeBrowser()]).then(() => {})
    let rejectStopped!: (error: Error) => void
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
    const stop = (error: Error) => {
      if (stoppedError) return
      stoppedError = error
      rejectStopped(error)
      for (const raster of rasters) raster.destroy()
      void cleanup()
    }
    const isCurrent = () => { try { return context.isCurrent() } catch { return false } }
    const onAbort = () => stop(new Error('文字图片渲染已取消'))
    const timer = setTimeout(() => stop(new Error('文字图片渲染超时')), timeoutMs)
    const authorityTimer = setInterval(() => { if (!isCurrent()) stop(new Error('文字图片渲染授权已失效')) }, 25)
    context.signal.addEventListener('abort', onAbort, {once: true})
    const checkCurrent = () => {
      if (stoppedError) throw stoppedError
      if (context.signal.aborted || !isCurrent()) throw new Error('文字图片渲染授权已失效')
    }
    const ensureCurrent = async () => { checkCurrent(); await context.ensureCurrent?.(); checkCurrent() }
    const rasterize = async (raster: Sharp) => {
      rasters.add(raster)
      try { return await raster.timeout({seconds: Math.max(1, Math.ceil(remaining() / 1000))}).toBuffer() }
      finally { rasters.delete(raster) }
    }

    const work = async () => {
      await ensureCurrent()
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['text', 'template', 'nickname', 'avatar'].includes(key)) ||
          typeof input.text !== 'string' || !input.text.trim() || input.text.length > 48_000 ||
          input.template !== undefined && !['chat', 'document', 'knowledge'].includes(input.template) ||
          input.nickname !== undefined && (typeof input.nickname !== 'string' || input.nickname.length > 100)) {
        throw new Error('文字图片参数无效或内容超过长度上限')
      }
      const prepared = prepareTextImageContent(input.text.trim(), input.template)
      if (prepared.template === 'chat') {
        let avatarDataUrl = ''
        if (input.avatar !== undefined) {
          const image = validateAgentToolImage(input.avatar)
          // Decode raster formats and strip metadata before embedding. Never embed SVG, URLs or original bytes.
          const png = await rasterize(sharp(Buffer.from(image.base64, 'base64'), {limitInputPixels: MAX_PIXELS, animated: false})
            .rotate().resize(64, 64, {fit: 'cover'}).png())
          await ensureCurrent()
          avatarDataUrl = `data:image/png;base64,${png.toString('base64')}`
        }
        const {svg, width, height, visibleText} = buildTextImageChatSvg({text: prepared.text, nickname: input.nickname?.trim() ?? '', avatarDataUrl})
        assertCanvas(width, height)
        await ensureCurrent()
        context.assertText?.(visibleText)
        await ensureCurrent()
        const bytes = await rasterize(sharp(Buffer.from(svg), {limitInputPixels: MAX_PIXELS}).png())
        await ensureCurrent()
        return validateAgentToolImageBytes(bytes, 'image/png')
      }

      const styles = hasLatexMath(prepared.text) ? await inlineMathStyles() : ''
      await ensureCurrent()
      const html = (prepared.template === 'knowledge' ? buildKnowledgeHtml(prepared.text, styles) : buildDocumentHtml(prepared.text, styles))
        .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`)
      if (html.length > MAX_HTML) throw new Error('文字图片文档超过大小上限')
      browser = await launch({headless: true, timeout: remaining(), protocolTimeout: timeoutMs, args: [
        '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
        '--metrics-recording-only', '--no-first-run', '--no-default-browser-check', '--disable-breakpad', '--disable-extensions',
      ]})
      if (stoppedError) { void cleanup(); throw stoppedError }
      await ensureCurrent()
      page = await browser.newPage()
      if (stoppedError) { void cleanup(); throw stoppedError }
      checkCurrent()
      page.setDefaultTimeout(remaining())
      page.setDefaultNavigationTimeout(remaining())
      await page.setJavaScriptEnabled(false)
      checkCurrent()
      await page.setBypassServiceWorker(true)
      checkCurrent()
      await page.setRequestInterception(true)
      page.on('request', request => {
        // Package-owned font data is the only allowed resource; all network and file requests are rejected.
        void (/^data:font\/(?:woff2?|ttf);base64,[A-Za-z0-9+/]+=*$/u.test(request.url())
          ? request.continue() : request.abort('blockedbyclient')).catch(() => {})
      })
      checkCurrent()
      await page.setOfflineMode(true)
      checkCurrent()
      await page.setViewport({width: WIDTH, height: 1200, deviceScaleFactor: SCALE})
      await ensureCurrent()
      await page.setContent(html, {waitUntil: 'domcontentloaded', timeout: remaining()})
      checkCurrent()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      checkCurrent()
      const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height))
      assertCanvas(WIDTH, height, SCALE)
      await ensureCurrent()
      const visibleText = await page.evaluate(() => document.body.innerText)
      checkCurrent()
      context.assertText?.(visibleText)
      await ensureCurrent()
      const bytes = await page.screenshot({type: 'png', encoding: 'binary', captureBeyondViewport: true,
        clip: {x: 0, y: 0, width: WIDTH, height}, omitBackground: false})
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
      clearTimeout(timer)
      clearInterval(authorityTimer)
      context.signal.removeEventListener('abort', onAbort)
      void cleanup()
    }
  }
  return {render}
}
