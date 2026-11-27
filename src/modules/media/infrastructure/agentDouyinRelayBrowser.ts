import type { Browser, HTTPRequest } from 'puppeteer'
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { douyinFailure, douyinGuard, douyinOfficialUrl } from './agentDouyinRelayHttp.js'
import type { createDouyinHttp } from './agentDouyinRelayHttp.js'
import { douyinCanonicalPage, douyinDisplay, douyinDocumentMetadata, douyinMetadata } from './agentDouyinRelayMetadata.js'
import type { AgentDouyinResolvedMedia } from './agentDouyinRelayMetadata.js'

export interface AgentDouyinBrowserInput {
  readonly id: string
  readonly kind: 'video' | 'note'
  readonly pageUrl: string
  /** Core-created private job directory; never a model-supplied path. */
  readonly directory: string
}
export type AgentDouyinBrowserRead = ReturnType<typeof createDouyinHttp>
/** Host-only testing hook. Production always uses a fresh anonymous browser and the supplied pinned HTTP port. */
export type AgentDouyinBrowser = (input: AgentDouyinBrowserInput, context: AgentMediaResourceContext, read: AgentDouyinBrowserRead) => Promise<AgentDouyinResolvedMedia | undefined>

/** Internal launcher shared by production and the real-browser isolation regression. */
export async function openAgentDouyinBrowserSession(guard: ReturnType<typeof douyinGuard>, directory: string) {
  await guard.ensure()
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || await realpath(directory) !== directory) throw douyinFailure()
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw douyinFailure()
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  const privilegedLauncher = process.platform === 'linux' && process.getuid?.() === 0 &&
    !!executablePath && process.env.BL_AGENT_CHROMIUM_UID !== undefined
  const profile = privilegedLauncher ? undefined : path.join(directory, 'browser-profile')
  if (profile) await mkdir(profile, { mode: 0o700 })
  let pending: Promise<Browser> | undefined, closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      const browser = await pending
      if (browser) {
        const kill = setTimeout(() => { try { browser.process()?.kill('SIGKILL') } catch {} }, 5000); kill.unref()
        try { await browser.close() } finally { clearTimeout(kill) }
      }
    } catch { /* A failed or cancelled launch still owns its profile. */ }
    if (profile) await rm(profile, { recursive: true, force: true })
  })()
  try {
    // Recent Chromium versions can ignore the historical command-line switch.
    // The root launcher seeds Puppeteer's temporary profile before handing it to the browser user.
    if (profile) {
      await mkdir(path.join(profile, 'Default'), { mode: 0o700 })
      await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ webrtc: {
        ip_handling_policy: 'disable_non_proxied_udp', multiple_routes_enabled: false, nonproxied_udp_enabled: false,
      } }), { mode: 0o600, flag: 'wx' })
    }
    const puppeteer = await guard.wait(import('puppeteer'))
    await guard.ensure()
    pending = puppeteer.default.launch({ headless: true, ...(profile ? { userDataDir: profile } : {}),
      ...(executablePath ? { executablePath } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-dev-shm-usage', '--no-first-run',
        '--disable-features=MediaRouter,OptimizationHints,DnsOverHttps', '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ...(privilegedLauncher ? ['--bl-agent-douyin-profile'] : []),
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND'] })
    const browser = await guard.wait(pending)
    await guard.ensure()
    return Object.freeze({ browser, close })
  } catch { await close(); throw douyinFailure() }
}

export const nativeAgentDouyinBrowser: AgentDouyinBrowser = async (input, context, read) => {
  const guard = douyinGuard(context, 25_000)
  let session: Awaited<ReturnType<typeof openAgentDouyinBrowserSession>> | undefined, matched: AgentDouyinResolvedMedia | undefined, total = 0, requests = 0
  const work = new Set<Promise<void>>()
  let active = 0
  const waiting: (() => void)[] = []
  try {
    await guard.ensure()
    // HTTP is fulfilled only through the pinned port. Engine policy separately blocks
    // non-proxied WebRTC UDP and QUIC, which page request interception cannot observe.
    session = await openAgentDouyinBrowserSession(guard, input.directory)
    const page = await guard.wait(session.browser.newPage(), late => late.close())
    await guard.wait(page.setBypassServiceWorker(true))
    await guard.wait(page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'))
    await guard.wait(page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      const deny = () => { throw new DOMException('媒体解析不提供此浏览器能力', 'SecurityError') }
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceGatherer', 'RTCIceTransport', 'RTCDtlsTransport',
        'RTCSctpTransport', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(globalThis, name, { value: deny, writable: false, configurable: false })
      }
      if (typeof ServiceWorkerContainer !== 'undefined') Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
        value: deny, writable: false, configurable: false,
      })
    }))
    await guard.wait(page.setRequestInterception(true))
    const handle = async (request: HTTPRequest) => {
      let acquired = false
      try {
        if (requests >= 128 || request.method() !== 'GET' || ['media', 'font', 'websocket', 'eventsource', 'other'].includes(request.resourceType())) throw douyinFailure()
        const url = douyinOfficialUrl(request.url(), 'browser')
        if (/\/(?:log|collect|beacon|applog|webmssdk|slardar|mcs|tnc)(?:\/|\?|$)/iu.test(url.pathname)) throw douyinFailure()
        // Image src attributes are enough for scoped gallery extraction; never spend the
        // browser's memory on decoded source images or media streams.
        if (request.resourceType() === 'image') throw douyinFailure()
        if (total >= 64 * 1024 * 1024) throw douyinFailure()
        // Denied requests never use the budget reserved for the pinned HTTP port.
        requests++
        if (active >= 4) await guard.wait(new Promise<void>(resolve => waiting.push(resolve)))
        else active++
        acquired = true; await guard.ensure()
        const cookies = url.hostname === 'www.douyin.com' ? await guard.wait(page.cookies(url.href)) : []
        const cookie = cookies.filter(value => value.domain === 'www.douyin.com' || value.domain === '.www.douyin.com' || value.domain === '.douyin.com')
          .map(value => `${value.name}=${value.value}`).join('; ')
        const response = await read(url.href, 'browser', guard, request.isNavigationRequest() ? 2 * 1024 * 1024 : 8 * 1024 * 1024, cookie ? { cookie } : undefined)
        const chunks: Buffer[] = []
        try {
          for await (const bytes of response.chunks) { total += bytes.length; if (total > 64 * 1024 * 1024) { guard.close(); throw douyinFailure() }; chunks.push(Buffer.from(bytes)) }
        } finally { await response.close() }
        const body = Buffer.concat(chunks)
        if (url.hostname === 'www.douyin.com' && response.url.hostname === 'www.douyin.com') {
          for (const raw of response.setCookies) {
            const [pair, ...attributes] = raw.split(';'), equals = pair?.indexOf('=') ?? -1
            if (equals < 1 || !pair || !/^[A-Za-z0-9_-]+$/u.test(pair.slice(0, equals))) continue
            const domain = attributes.find(value => /^\s*domain=/iu.test(value))?.split('=').slice(1).join('=').trim().toLowerCase()
            if (domain && !['www.douyin.com', '.www.douyin.com', 'douyin.com', '.douyin.com'].includes(domain)) continue
            await guard.wait(page.setCookie({ name: pair.slice(0, equals), value: pair.slice(equals + 1), url: 'https://www.douyin.com/',
              path: '/', secure: true, httpOnly: attributes.some(value => /^\s*httponly\s*$/iu.test(value)) }))
          }
        }
        if (url.pathname === '/aweme/v1/web/aweme/detail/') {
          try { const candidate = douyinMetadata(JSON.parse(body.toString('utf8')), input.id, input.kind); if (candidate) matched = candidate } catch { /* Ignore unrelated or malformed responses. */ }
        }
        if (request.isNavigationRequest()) {
          const candidate = douyinDocumentMetadata(body.toString('utf8'), input.id, input.kind)
          if (candidate) matched = candidate
        }
        await guard.ensure()
        await request.respond({ status: 200, contentType: response.mime || 'application/octet-stream', body, headers: {
          'Access-Control-Allow-Origin': 'https://www.douyin.com',
          'Content-Security-Policy': "sandbox allow-scripts allow-same-origin; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'",
        } })
      } catch { await request.abort('blockedbyclient').catch(() => {}) }
      finally { if (acquired) { const next = waiting.shift(); if (next) next(); else active-- } }
    }
    page.on('request', request => {
      const task = handle(request); work.add(task); void task.finally(() => work.delete(task)).catch(() => {})
    })
    await guard.wait(page.goto(input.pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }))
    if (!matched || matched.kind === 'note' && !matched.images.length || matched.kind === 'video' && !matched.video) await guard.wait(page.waitForFunction((id, kind) => {
      const nodes = document.querySelectorAll('[data-aweme-id], [data-video-id]')
      const scope = [...nodes].find(node => node.getAttribute('data-aweme-id') === id || node.getAttribute('data-video-id') === id)
      return Boolean(scope && (kind === 'note' ? scope.querySelector('img') : scope.querySelector('video')?.src))
    }, { timeout: 8000, polling: 150 }, input.id, input.kind).catch(() => undefined))
    await guard.ensure()
    const dom = await guard.wait(page.evaluate((id, kind) => {
      const nodes = document.querySelectorAll('[data-aweme-id], [data-video-id]')
      const scope = [...nodes].find(node => node.getAttribute('data-aweme-id') === id || node.getAttribute('data-video-id') === id)
      // Loose global selectors can collect recommended works. DOM fallbacks must carry
      // an explicit target identity; JSON-only fallbacks are already scoped by aweme_id.
      if (!scope) return undefined
      const video = scope.querySelector('video')
      const images = kind === 'note' ? [...scope.querySelectorAll<HTMLImageElement>('img[src*="douyinpic"], img[src*="byteimg"]')].map(image => image.src) : []
      return { video: video?.src || video?.currentSrc || '', duration: Number(video?.duration || 0), cover: video?.poster || '', images,
        title: scope.querySelector('h1')?.textContent || document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title }
    }, input.id, input.kind))
    if (!matched || matched.kind === 'video' && !matched.video || matched.kind === 'note' && !matched.images.length) {
      if (dom) matched = { id: input.id, kind: input.kind, title: douyinDisplay(dom.title, 300) || '抖音作品', author: matched?.author || '', description: matched?.description || '',
        duration: Number.isFinite(dom.duration) && dom.duration > 0 ? dom.duration : matched?.duration || 0,
        video: dom.video, images: [...new Set(dom.images)], cover: dom.cover || matched?.cover || '', music: matched?.music || '', stats: matched?.stats || {} }
    }
    await guard.ensure()
    if (page.url().split('?')[0] !== douyinCanonicalPage(input.id, input.kind)) throw douyinFailure()
    return matched
  } catch { await guard.ensure(); return undefined }
  finally { guard.close(); await session?.close().catch(() => {}); await Promise.allSettled([...work]) }
}
