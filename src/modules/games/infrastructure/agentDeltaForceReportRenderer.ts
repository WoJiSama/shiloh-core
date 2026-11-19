import puppeteer from 'puppeteer'
import type { Browser, LaunchOptions, Page } from 'puppeteer'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import type { DeltaReport } from '../../../contracts/deltaForceReport.js'
import { validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'
import { buildDeltaForceReportView } from './DeltaForceReportRenderer.js'

type RenderContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export interface AgentDeltaForceReportRendererOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>
  readonly timeoutMs?: number
}
const WIDTH = 1100
const MAX_HEIGHT = 8192
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

/** The legacy report builder supplies escaped cells and locally generated price charts. */
export function buildAgentDeltaForceReportHtml(report: DeltaReport): string {
  if (!report || typeof report !== 'object' || !Array.isArray(report.rows) || report.rows.length > 20 ||
      !Array.isArray(report.columns) || report.columns.length > 12 || JSON.stringify(report).length > 192 * 1024) throw new Error('三角洲报表超出上限')
  // SVG is only accepted from the package-owned price chart builder, never remote markup.
  for (const row of report.rows) if (row.chartSvg && (report.kind !== 'price-history' || row.chartSvg.length > 128 * 1024 ||
      /<(?!\/?(?:svg|text|defs|linearGradient|stop|rect|line|path|circle)\b)|\bon[a-z]+\s*=|(?:href|src)\s*=|url\(\s*[^#]/iu.test(row.chartSvg))) throw new Error('三角洲图表格式无效')
  const view = buildDeltaForceReportView(report)
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>三角洲行动</title><style>
*{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;background:#151b24;color:#e6edf5;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}body{padding:26px}h1{margin:0 0 10px;font-size:30px}.meta{color:#b3c3d7;font-size:16px;margin-bottom:20px;white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:auto;background:#1b2634}th,td{padding:13px 10px;border:1px solid #3a485c;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap;font-size:17px;line-height:1.5}th{background:#28394d;color:#bde6d1}.number,.rank{font-variant-numeric:tabular-nums}.strong,.name{font-weight:700}.tag{color:#a4dbb4}.muted{color:#97aac2}.price-chart{display:block;width:100%;height:330px}.history-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px}.history-name{font-size:24px;font-weight:700}.history-stats{text-align:right}.history-meta,.history-samples{color:#a3b4c8}.history-price{font-size:26px;font-weight:700}.history-change{color:#a5ddbb}.solution-code{font-family:monospace;overflow-wrap:anywhere}.empty{padding:32px;text-align:center}
</style></head><body><h1>${view.title}</h1><div class="meta">${view.subtitle} · ${view.generatedAt}（北京时间）\n第三方资料，未经核实</div><table><thead><tr>${view.columnsHtml}</tr></thead><tbody>${view.rowsHtml}</tbody></table></body></html>`
  if (html.length > 256 * 1024) throw new Error('三角洲报表超出上限')
  return html
}

/** Each card owns a fresh browser, including late launch/page results after cancellation. */
export function createAgentDeltaForceReportRenderer(options: AgentDeltaForceReportRendererOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('三角洲渲染时限须为 1–5000 毫秒')
  const launch = options.launch ?? (config => puppeteer.launch(config))

  async function render(view: DeltaReport, context: RenderContext): Promise<{ mime: string; base64: string }> {
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
    const onAbort = () => stop(new Error('三角洲报表渲染已取消'))
    const timer = setTimeout(() => stop(new Error('三角洲报表渲染超时')), timeoutMs)
    context.signal.addEventListener('abort', onAbort, { once: true })
    const checkCurrent = () => {
      if (stoppedError) throw stoppedError
      if (context.signal.aborted || !context.isCurrent()) throw new Error('三角洲报表渲染授权已失效')
    }
    const ensureCurrent = async () => {
      checkCurrent()
      await context.ensureCurrent?.()
      checkCurrent()
    }
    const work = async () => {
      const html = buildAgentDeltaForceReportHtml(view)
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
      if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) throw new Error('三角洲报表内容超过画布上限')
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
