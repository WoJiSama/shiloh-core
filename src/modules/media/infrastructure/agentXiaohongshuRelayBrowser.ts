import type { HTTPRequest } from 'puppeteer'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { openAgentDouyinBrowserSession } from './agentDouyinRelayBrowser.js'
import { xiaohongshuFailure, xiaohongshuGuard, xiaohongshuOfficialUrl, xiaohongshuFeedUrl, xiaohongshuBrowserCookieUrl, XIAOHONGSHU_MOBILE_UA } from './agentXiaohongshuRelayHttp.js'
import type { createXiaohongshuHttp } from './agentXiaohongshuRelayHttp.js'
import { xiaohongshuDisplay, xiaohongshuDocumentMetadata, xiaohongshuMetadata, xiaohongshuPageIdentity } from './agentXiaohongshuRelayMetadata.js'
import type { AgentXiaohongshuResolvedMedia } from './agentXiaohongshuRelayMetadata.js'

export interface AgentXiaohongshuBrowserInput {
  readonly id: string
  readonly mediaKind?: 'image' | 'video'
  /** Bounded first-party note URL with only the transient access query. */
  readonly pageUrl: string
  readonly directory: string
}
export type AgentXiaohongshuBrowserRead = ReturnType<typeof createXiaohongshuHttp>
export type AgentXiaohongshuBrowser = (input: AgentXiaohongshuBrowserInput, context: AgentMediaResourceContext, read: AgentXiaohongshuBrowserRead) => Promise<AgentXiaohongshuResolvedMedia | undefined>
// Reuse only the audited anonymous engine: fresh private profile, disabled direct DNS,
// loopback-deny proxy, QUIC off and actual per-profile WebRTC policy. No shared host browser.
export const openAgentXiaohongshuBrowserSession = openAgentDouyinBrowserSession

export const nativeAgentXiaohongshuBrowser: AgentXiaohongshuBrowser = async (input, context, read) => {
  const guard = xiaohongshuGuard(context, 25_000)
  let session: Awaited<ReturnType<typeof openAgentXiaohongshuBrowserSession>> | undefined, matched: AgentXiaohongshuResolvedMedia | undefined, total = 0, requests = 0, active = 0
  const work = new Set<Promise<void>>(), waiting: (() => void)[] = []
  try {
    if (xiaohongshuPageIdentity(xiaohongshuOfficialUrl(input.pageUrl, 'page')) !== input.id) throw xiaohongshuFailure()
    session = await openAgentXiaohongshuBrowserSession(guard, input.directory)
    const page = await guard.wait(session.browser.newPage(), late => late.close())
    await guard.wait(page.setBypassServiceWorker(true))
    await guard.wait(page.setUserAgent(XIAOHONGSHU_MOBILE_UA))
    await guard.wait(page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true }))
    await guard.wait(page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      const deny = () => { throw new DOMException('媒体解析不提供此浏览器能力', 'SecurityError') }
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceGatherer', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(globalThis, name, { value: deny, writable: false, configurable: false })
      }
      if (typeof ServiceWorkerContainer !== 'undefined') Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { value: deny, writable: false, configurable: false })
    }))
    await guard.wait(page.setRequestInterception(true))
    const handle = async (request: HTTPRequest) => {
      let acquired = false
      try {
        await guard.ensure()
        if (++requests > 128) throw xiaohongshuFailure()
        const url = xiaohongshuOfficialUrl(request.url(), 'browser'), method = request.method(), headers = request.headers()
        // CORS preflight is answered locally. It grants no HTTP capability: the subsequent
        // intercepted POST is independently checked for URL, body, source, headers and cookies.
        if (method === 'OPTIONS') {
          const names = [...new Set((headers['access-control-request-headers'] ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))]
          if (!xiaohongshuFeedUrl(url) || headers.origin !== 'https://www.xiaohongshu.com' || headers['access-control-request-method'] !== 'POST' || names.length > 4 || names.some(name => !['content-type', 'x-s', 'x-t', 'x-s-common'].includes(name))) throw xiaohongshuFailure()
          await guard.wait(request.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': 'https://www.xiaohongshu.com', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': names.join(', ') } }))
          return
        }
        if (!['GET', 'POST'].includes(method) || method === 'POST' && !xiaohongshuFeedUrl(url) || ['media', 'font', 'websocket', 'eventsource', 'other', 'image'].includes(request.resourceType())) throw xiaohongshuFailure()
        const signed: Record<string, string> = {}
        if (method === 'POST') for (const name of ['x-s', 'x-t', 'x-s-common']) if (headers[name] !== undefined) signed[name] = headers[name]!
        if (request.isNavigationRequest() && xiaohongshuPageIdentity(url) !== input.id) throw xiaohongshuFailure()
        if (/\/(?:log|collect|beacon|applog|webmssdk|slardar|mcs|tnc)(?:\/|\?|$)/iu.test(url.pathname) || /\.(?:mp4|m4s|ts)(?:\?|$)/iu.test(url.href) || total >= 64 * 1024 * 1024) throw xiaohongshuFailure()
        if (active >= 4) await guard.wait(new Promise<void>(resolve => waiting.push(resolve))); else active++
        acquired = true; await guard.ensure()
        const cookies = xiaohongshuBrowserCookieUrl(url) ? await guard.wait(page.cookies(url.href)) : []
        const cookie = cookies.filter(value => [url.hostname, `.${url.hostname}`, '.xiaohongshu.com'].includes(value.domain)).map(value => `${value.name}=${value.value}`).join('; ')
        const response = await read(url.href, 'browser', guard, request.isNavigationRequest() ? 2 * 1024 * 1024 : 8 * 1024 * 1024, method === 'POST' ? { ...(cookie ? { cookie } : {}), method: 'POST', body: request.postData() ?? '', headers: signed } : cookie ? { cookie } : undefined)
        const chunks: Buffer[] = []
        try { for await (const bytes of response.chunks) { total += bytes.length; if (total > 64 * 1024 * 1024) { guard.close(); throw xiaohongshuFailure() }; chunks.push(Buffer.from(bytes)) } } finally { await response.close() }
        const body = Buffer.concat(chunks)
        if (request.isNavigationRequest() && xiaohongshuPageIdentity(response.url) !== input.id) throw xiaohongshuFailure()
        if (xiaohongshuBrowserCookieUrl(url) && response.url.hostname === url.hostname) {
          for (const raw of response.setCookies) {
            const [pair, ...attributes] = raw.split(';'), equals = pair?.indexOf('=') ?? -1
            if (equals < 1 || !pair || !/^[A-Za-z0-9_-]+$/u.test(pair.slice(0, equals))) continue
            const domain = attributes.find(value => /^\s*domain=/iu.test(value))?.split('=').slice(1).join('=').trim().toLowerCase()
            if (domain && ![url.hostname, `.${url.hostname}`, 'xiaohongshu.com', '.xiaohongshu.com'].includes(domain)) continue
            const rawPath = attributes.find(value => /^\s*path=/iu.test(value))?.split('=').slice(1).join('=').trim()
            const path = rawPath && rawPath.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(rawPath) ? rawPath : url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
            const rawSameSite = attributes.find(value => /^\s*samesite=/iu.test(value))?.split('=').slice(1).join('=').trim().toLowerCase()
            const sameSite = rawSameSite === 'none' ? 'None' as const : rawSameSite === 'strict' ? 'Strict' as const : rawSameSite === 'lax' ? 'Lax' as const : undefined
            const rawMaxAge = attributes.find(value => /^\s*max-age=/iu.test(value))?.split('=').slice(1).join('=').trim()
            const expires = rawMaxAge && /^-?\d{1,10}$/u.test(rawMaxAge) ? Math.max(1, Date.now() / 1000 + Number(rawMaxAge)) : undefined
            await guard.wait(page.setCookie({ name: pair.slice(0, equals), value: pair.slice(equals + 1), url: `${url.origin}${path}`, ...(domain ? { domain } : {}), path, secure: true,
              httpOnly: attributes.some(value => /^\s*httponly\s*$/iu.test(value)), ...(sameSite ? { sameSite } : {}), ...(expires !== undefined ? { expires } : {}) }))
          }
        }
        try {
          const candidate = request.isNavigationRequest() ? xiaohongshuDocumentMetadata(body.toString('utf8'), input.id, input.mediaKind)
            : response.mime === 'application/json' ? xiaohongshuMetadata(JSON.parse(body.toString('utf8')), input.id, input.mediaKind) : undefined
          if (candidate) matched = candidate
        } catch { /* Only the explicit target note becomes metadata. */ }
        await guard.ensure()
        await request.respond({ status: 200, contentType: response.mime || 'application/octet-stream', body, headers: {
          'Access-Control-Allow-Origin': 'https://www.xiaohongshu.com', 'Access-Control-Allow-Credentials': 'true',
          'Content-Security-Policy': "sandbox allow-scripts allow-same-origin; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'",
        } })
      } catch { await request.abort('blockedbyclient').catch(() => {}) }
      finally { if (acquired) { const next = waiting.shift(); if (next) next(); else active-- } }
    }
    page.on('request', request => { const task = handle(request); work.add(task); void task.finally(() => work.delete(task)).catch(() => {}) })
    await guard.wait(page.goto(input.pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }))
    if (!matched) await guard.wait(page.waitForFunction(id => {
      const state = (window as Window & { __INITIAL_STATE__?: { note?: { noteDetailMap?: Record<string, unknown> } } }).__INITIAL_STATE__
      return Boolean(state?.note?.noteDetailMap?.[id] || [...document.querySelectorAll('[data-note-id], [data-noteid]')].some(node => node.getAttribute('data-note-id') === id || node.getAttribute('data-noteid') === id))
    }, { timeout: 8000, polling: 150 }, input.id).catch(() => undefined))
    await guard.ensure()
    const payload = await guard.wait(page.evaluate(id => {
      const state = (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__
      const raw = JSON.stringify(state ?? null)
      const scope = [...document.querySelectorAll('[data-note-id], [data-noteid]')].find(node => node.getAttribute('data-note-id') === id || node.getAttribute('data-noteid') === id)
      if (!scope) return { state: raw.length <= 2 * 1024 * 1024 ? raw : '', dom: undefined }
      const video = scope.querySelector('video')
      return { state: raw.length <= 2 * 1024 * 1024 ? raw : '', dom: {
        title: scope.querySelector('h1, .title, #detail-title')?.textContent || '',
        description: scope.querySelector('#detail-desc, .desc, .note-content')?.textContent || '',
        author: scope.querySelector('.author .name, .author-name, [data-author-name]')?.textContent || '',
        images: [...scope.querySelectorAll<HTMLImageElement>('img')].map(image => image.src || image.getAttribute('data-src') || '').filter(url => /^https?:\/\/sns-(?:webpic|img|video)[^/]*\.xhscdn\.com\//iu.test(url) && !/\/avatar\//iu.test(url)),
        video: video?.src || video?.currentSrc || '', cover: video?.poster || '', duration: Number(video?.duration || 0),
      } }
    }, input.id))
    if (payload.state) { try { const candidate = xiaohongshuMetadata(JSON.parse(payload.state), input.id, input.mediaKind); if (candidate) matched = candidate } catch {} }
    if (!matched && payload.dom) {
      const dom = payload.dom, kind = input.mediaKind ?? (dom.video && dom.duration >= 10 ? 'video' : 'image')
      matched = { id: input.id, kind, title: xiaohongshuDisplay(dom.title, 300) || '小红书笔记', description: xiaohongshuDisplay(dom.description, 2000), author: xiaohongshuDisplay(dom.author, 120),
        images: dom.images, livePhotos: dom.images.map(() => ''), video: kind === 'video' ? dom.video : '', duration: Number.isFinite(dom.duration) && dom.duration > 0 ? dom.duration : 0, cover: dom.images[0] || dom.cover, stats: {} }
    }
    await guard.ensure()
    if (xiaohongshuPageIdentity(new URL(page.url())) !== input.id) throw xiaohongshuFailure()
    return matched
  } catch { await guard.ensure(); return undefined }
  finally { guard.close(); await session?.close().catch(() => {}); await Promise.allSettled([...work]) }
}
