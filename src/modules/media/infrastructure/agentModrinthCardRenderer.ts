import puppeteer from 'puppeteer'
import type { Browser, LaunchOptions, Page } from 'puppeteer'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'

type RenderContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>

export interface AgentModrinthCardRendererOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>
  /** Includes launch, rendering and cleanup; never more than five seconds. */
  readonly timeoutMs?: number
}

const WIDTH = 980
const MAX_HEIGHT = 8192
const MAX_FIELD_LENGTH = 16_384
const MAX_HTML_LENGTH = 256 * 1024
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

function field(view: Readonly<Record<string, unknown>>, key: string, fallback = '未提供'): string {
  const value = view[key]
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Modrinth 卡片字段必须是文本或有限数值')
  }
  const text = String(value)
  if (text.length > MAX_FIELD_LENGTH) throw new Error('Modrinth 卡片字段超过长度上限')
  // Character references preserve literal CR as well as markup characters.
  return text.replace(/[&<>"'\r]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' })[char]!)
}

/** A self-contained document: no host template, scripts, URLs or downloaded icon. */
export function buildAgentModrinthCardHtml(view: Readonly<Record<string, unknown>>): string {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('Modrinth 卡片数据无效')
  const row = (key: string, label: string) => `<div class="row"><span class="label">${label}</span><div class="text" data-field="${key}">${field(view, key)}</div></div>`
  const meta = (key: string, label: string) => `<div class="meta"><span class="label">${label}</span><div class="text" data-field="${key}">${field(view, key)}</div></div>`
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=${WIDTH},initial-scale=1"><title>Modrinth</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;background:#151b20;color:#eaf1f7;font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif}body{padding:24px}.card{border:1px solid #3a4954;border-radius:14px;background:#202b33;overflow:hidden}.head{display:flex;gap:22px;align-items:center;padding:28px;background:#293943;border-bottom:1px solid #3f5260}.icon{flex:0 0 78px;height:78px;display:grid;place-items:center;background:#132821;border:1px solid #4d9a74;border-radius:14px;color:#7ae2a3;font-size:42px;font-weight:800}.heading{min-width:0}.eyebrow{color:#a0c2d3;font-size:16px;font-weight:700}h1{margin:7px 0 8px;color:white;font-size:32px;line-height:1.25;overflow-wrap:anywhere;white-space:pre-wrap}.author{font-size:18px;color:#c2d2de;overflow-wrap:anywhere;white-space:pre-wrap}.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#3f5260}.stat{padding:18px 28px;background:#24313a}.label{display:block;margin-bottom:7px;color:#a2b8c7;font-size:16px;font-weight:600}.number{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.content{padding:26px 28px 28px}.row{margin-bottom:20px}.text{font-size:18px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.meta-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:20px}.meta{padding:14px 16px;border:1px solid #405460;border-radius:8px;background:#19252d}.meta .text{font-size:17px}.description{padding:17px 18px;border-left:4px solid #7abbd6;border-radius:0 8px 8px 0;background:#17262f}.description+.description{margin-top:14px;border-left-color:#8fcda3;background:#1b2d28}.footer{padding:17px 28px;border-top:1px solid #3f5260;color:#9cb1bf;font-size:14px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
</style></head><body><main class="card">
<header class="head"><div class="icon" aria-label="Modrinth 图标占位">M</div><div class="heading"><div class="eyebrow">Modrinth 第 ${field(view, 'rank', '?')} 名</div><h1 data-field="name">${field(view, 'name')}</h1><div class="author">作者：<span data-field="author">${field(view, 'author')}</span></div></div></header>
<section class="stats"><div class="stat"><span class="label">下载</span><div class="number" data-field="downloads">${field(view, 'downloads')}</div></div><div class="stat"><span class="label">关注</span><div class="number" data-field="follows">${field(view, 'follows')}</div></div></section>
<section class="content">${row('tagsText', '标签')}${row('versionsText', '支持的 MC 版本')}<div class="meta-grid">${meta('clientSide', '客户端侧')}${meta('serverSide', '服务端侧')}${meta('dateCreated', '创建时间')}${meta('dateModified', '最近更新')}</div>${row('license', '许可证')}
<div class="description"><span class="label">英文简介</span><div class="text" data-field="descriptionEn">${field(view, 'descriptionEn', '暂无官方英文简介')}</div></div><div class="description"><span class="label">中文翻译</span><div class="text" data-field="descriptionZh">${field(view, 'descriptionZh', '翻译暂时不可用')}</div></div></section>
${view.source || view.queryTimeBeijing ? `<footer class="footer">来源：${field(view, 'source', 'Modrinth')}${view.queryTimeBeijing ? ` · 查询时间（北京时间）：${field(view, 'queryTimeBeijing')}` : ''}</footer>` : ''}
</main></body></html>`
  if (html.length > MAX_HTML_LENGTH) throw new Error('Modrinth 卡片内容超过大小上限')
  return html
}

/** Each card owns a fresh browser, including late launch/page results after cancellation. */
export function createAgentModrinthCardRenderer(options: AgentModrinthCardRendererOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Modrinth 渲染时限须为 1–5000 毫秒')
  const launch = options.launch ?? (config => puppeteer.launch(config))

  async function render(view: Readonly<Record<string, unknown>>, context: RenderContext): Promise<{ mime: string; base64: string }> {
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
    const onAbort = () => stop(new Error('Modrinth 卡片渲染已取消'))
    const timer = setTimeout(() => stop(new Error('Modrinth 卡片渲染超时')), timeoutMs)
    context.signal.addEventListener('abort', onAbort, { once: true })
    const checkCurrent = () => {
      if (stoppedError) throw stoppedError
      if (context.signal.aborted || !context.isCurrent()) throw new Error('Modrinth 卡片渲染授权已失效')
    }
    const ensureCurrent = async () => {
      checkCurrent()
      await context.ensureCurrent?.()
      checkCurrent()
    }
    const work = async () => {
      const html = buildAgentModrinthCardHtml(view)
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
      if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) throw new Error('Modrinth 卡片内容超过画布上限')
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
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
      void cleanup()
    }
  }
  return { render }
}
