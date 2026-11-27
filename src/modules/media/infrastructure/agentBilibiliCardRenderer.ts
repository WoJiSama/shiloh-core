import puppeteer from 'puppeteer'
import type { Browser, LaunchOptions, Page } from 'puppeteer'
import sharp from 'sharp'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'

type RenderContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>

export interface AgentBilibiliCardRendererOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>
  /** Includes launch, rendering and cleanup; never more than five seconds. */
  readonly timeoutMs?: number
}

const WIDTH = 980
const MAX_HEIGHT = 8192
const MAX_FIELD_LENGTH = 16_384
const MAX_HTML_LENGTH = 256 * 1024
const MAX_COVER_BYTES = 8 * 1024 * 1024
const MAX_INLINE_COVER_BYTES = 160 * 1024
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

export interface AgentBilibiliCardView {
  readonly title: string
  readonly owner: string
  readonly durationText: string
  readonly partText: string
  readonly publishedText: string
  readonly pageUrl: string
  readonly stats: Readonly<Record<string, string>>
  readonly description: string
  readonly episode: boolean
  /** Optional in-memory cover bytes rendered as a data URI; never fetched from the network. */
  readonly cover?: Readonly<{ readonly mime: string; readonly bytes: Uint8Array }>
}

export class AgentBilibiliCardError extends Error {
  constructor(readonly code: 'card_cover_invalid' | 'card_browser_failed' | 'card_render_failed' | 'card_render_timeout' | 'card_render_cancelled',
    message: string, cause?: unknown) { super(message, { cause }) }
}

function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new Error('B站卡片字段必须是文本')
  if (value.length > MAX_FIELD_LENGTH) throw new Error('B站卡片字段超过长度上限')
  // Character references preserve literal CR as well as markup characters.
  return value.replace(/[&<>"'\r]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' })[char]!)
}

function validateCover(cover: NonNullable<AgentBilibiliCardView['cover']>) {
  if (typeof cover.mime !== 'string' || !/^image\/(?:png|jpeg|gif|webp)$/u.test(cover.mime) || !(cover.bytes instanceof Uint8Array) || !cover.bytes.byteLength || cover.bytes.byteLength > MAX_COVER_BYTES)
    throw new Error('B站卡片封面数据无效')
}

function coverDataUri(cover: AgentBilibiliCardView['cover']): string {
  if (!cover) return ''
  validateCover(cover)
  return `data:${cover.mime};base64,${Buffer.from(cover.bytes).toString('base64')}`
}

async function fitCover(cover: AgentBilibiliCardView['cover']): Promise<AgentBilibiliCardView['cover']> {
  if (!cover) return
  try {
    validateCover(cover)
    if (cover.bytes.byteLength <= MAX_INLINE_COVER_BYTES) return cover
    const bytes = await sharp(cover.bytes, { limitInputPixels: 16 * 1024 * 1024 }).rotate()
      .resize({ width: 960, height: 520, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#171e26' }).jpeg({ quality: 65 }).toBuffer()
    if (bytes.byteLength > MAX_INLINE_COVER_BYTES) throw new Error('B站卡片封面无法缩小至嵌入上限')
    return { mime: 'image/jpeg', bytes }
  } catch (cause) { throw new AgentBilibiliCardError('card_cover_invalid', 'B站卡片封面处理失败', cause) }
}

/** A self-contained document: no host template, scripts, or network resources. */
export function buildAgentBilibiliCardHtml(view: Readonly<AgentBilibiliCardView>): string {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('B站卡片数据无效')
  const dataUri = coverDataUri(view.cover)
  const stats = Object.entries(view.stats ?? {}).filter(([, value]) => value !== undefined && value !== null && String(value) !== '').slice(0, 6)
    .map(([key, value]) => `<div class="stat"><span class="label">${text(key)}</span><div class="number">${text(value)}</div></div>`).join('')
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=${WIDTH},initial-scale=1"><title>哔哩哔哩</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;background:#101318;color:#e8f2f8;font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif}body{padding:24px}.card{border:1px solid #2b3a47;border-radius:14px;background:#171e26;overflow:hidden}${dataUri ? `.cover{display:block;width:100%;height:auto;min-height:56px;max-height:520px;object-fit:cover;border-bottom:1px solid #2b3a47}` : ''}.head{padding:26px 28px 20px}.eyebrow{display:flex;align-items:center;gap:10px;color:#7fd4f2;font-size:16px;font-weight:700}.brand{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#00aeec;color:#fff;font-size:15px;font-weight:800}.eyebrow .kind{color:#a9c3d4;font-weight:600}h1{margin:12px 0 10px;color:#fff;font-size:32px;line-height:1.3;overflow-wrap:anywhere;white-space:pre-wrap}.owner{font-size:18px;color:#fb7299}.owner .at{color:#a9c3d4}${stats ? `.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#2b3a47;border-top:1px solid #2b3a47}` : ''}.stat{padding:16px 24px;background:#1b2530}.label{display:block;margin-bottom:6px;color:#8fa9bc;font-size:15px;font-weight:600}.number{font-size:24px;font-weight:800;color:#eaf6fc;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.meta{display:flex;flex-wrap:wrap;gap:10px;padding:18px 28px;border-top:1px solid #223140}.chip{padding:8px 14px;border:1px solid #33505f;border-radius:999px;background:#14202b;color:#b7cddc;font-size:15px;overflow-wrap:anywhere}.desc{padding:18px 28px;border-top:1px solid #223140;font-size:17px;line-height:1.65;color:#c4d8e5;white-space:pre-wrap;overflow-wrap:anywhere}.footer{padding:16px 28px 20px;border-top:1px solid #223140;color:#8fa9bc;font-size:14px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
</style></head><body><main class="card">
${dataUri ? `<img class="cover" alt="视频封面" src="${dataUri}">` : ''}<header class="head"><div class="eyebrow"><span class="brand" aria-hidden="true">B</span>哔哩哔哩<span class="kind">· ${view.episode ? '番剧' : '视频'}</span></div><h1>${text(view.title, 'B站视频')}</h1><div class="owner">UP：<span>${text(view.owner, '未知')}</span><span class="at"></span></div></header>
${stats ? `<section class="stats">${stats}</section>` : ''}
<section class="meta"><span class="chip">时长 ${text(view.durationText, '--:--')}</span>${view.partText ? `<span class="chip">${text(view.partText)}</span>` : ''}${view.publishedText ? `<span class="chip">发布 ${text(view.publishedText)}</span>` : ''}</section>
${view.description ? `<section class="desc">${text(view.description)}</section>` : ''}
<footer class="footer">${text(view.pageUrl)}</footer>
</main></body></html>`
  if (html.length > MAX_HTML_LENGTH) throw new Error('B站卡片内容超过大小上限')
  return html
}

/** Each card owns a fresh browser, including late launch/page results after cancellation. */
export function createAgentBilibiliCardRenderer(options: AgentBilibiliCardRendererOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('B站卡片渲染时限须为 1–5000 毫秒')
  const launch = options.launch ?? (config => puppeteer.launch(config))

  async function render(view: Readonly<AgentBilibiliCardView>, context: RenderContext): Promise<{ mime: string; base64: string }> {
    let browser: Browser | undefined, page: Page | undefined
    let closedBrowser: Browser | undefined, closedPage: Page | undefined
    let closeBrowserPromise: Promise<void> | undefined, closePagePromise: Promise<void> | undefined
    let stoppedError: Error | undefined
    const started = Date.now()
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
    const closePage = () => {
      if (page && page !== closedPage) {
        closedPage = page
        const ownedPage = page
        closePagePromise = Promise.resolve().then(() => ownedPage.close()).catch(() => {})
      }
      return closePagePromise ?? Promise.resolve()
    }
    const closeBrowser = () => {
      if (browser && browser !== closedBrowser) {
        closedBrowser = browser
        const ownedBrowser = browser
        // A stalled DevTools close must not leave a Chromium process behind.
        const kill = () => {
          try { ownedBrowser.process()?.kill('SIGKILL') } catch { /* Already closed or injected launcher has no process. */ }
        }
        const forceClose = setTimeout(kill, 250)
        forceClose.unref()
        closeBrowserPromise = Promise.resolve().then(() => ownedBrowser.close()).catch(kill).finally(() => clearTimeout(forceClose))
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
    const onAbort = () => stop(new AgentBilibiliCardError('card_render_cancelled', 'B站卡片渲染已取消'))
    const timer = setTimeout(() => stop(new AgentBilibiliCardError('card_render_timeout', 'B站卡片渲染超时')), timeoutMs)
    context.signal.addEventListener('abort', onAbort, { once: true })
    const checkCurrent = () => {
      if (stoppedError) throw stoppedError
      if (context.signal.aborted || !context.isCurrent()) throw new AgentBilibiliCardError('card_render_cancelled', 'B站卡片渲染授权已失效')
    }
    const ensureCurrent = async () => {
      checkCurrent()
      await context.ensureCurrent?.()
      checkCurrent()
    }
    const work = async () => {
      await ensureCurrent()
      const cover = await fitCover(view.cover)
      const html = buildAgentBilibiliCardHtml({ ...view, ...(cover ? { cover } : {}) })
      await ensureCurrent()
      try { browser = await launch({ headless: true, timeout: remaining(), protocolTimeout: timeoutMs, args: [
        '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
        '--metrics-recording-only', '--no-first-run', '--no-default-browser-check', '--disable-breakpad', '--disable-extensions',
      ] }) } catch (cause) { throw new AgentBilibiliCardError('card_browser_failed', 'B站卡片浏览器启动失败', cause) }
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
      page.on('request', request => { void request.abort('blockedbyclient').catch(() => {}) })
      checkCurrent()
      await page.setOfflineMode(true)
      checkCurrent()
      await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 1 })
      await ensureCurrent()
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: remaining() })
      checkCurrent()
      const height = await page.evaluate(() => Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)))
      checkCurrent()
      if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) throw new Error('B站卡片内容超过画布上限')
      const bytes = await page.screenshot({ type: 'png', encoding: 'binary', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: WIDTH, height }, omitBackground: false })
      await ensureCurrent()
      return validateAgentToolImageBytes(bytes, 'image/png')
    }
    try {
      const image = await Promise.race([work(), stopped])
      await Promise.race([cleanup(), stopped])
      checkCurrent()
      return image
    } catch (cause) {
      if (cause instanceof AgentBilibiliCardError) throw cause
      throw new AgentBilibiliCardError('card_render_failed', 'B站卡片渲染失败', cause)
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
      void cleanup()
    }
  }
  return { render }
}
