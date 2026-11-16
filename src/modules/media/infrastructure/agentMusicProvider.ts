import { createHash } from 'node:crypto'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import type { AgentMusicCard } from '../../../contracts/agentMusic.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentMusicCard } from './agentMusicCard.js'

export interface AgentMusicConfig { enabled: boolean; cookie?: string }
export type AgentMusicContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export interface AgentMusicProviderOptions {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly random?: () => number
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly registerSecrets?: (strings: readonly string[]) => void
  readonly onCookieRefresh?: (cookie: string, context: AgentMusicContext) => Promise<void>
  /** Independent host lifetime/authorization for shared refresh; never the first human caller's context. */
  readonly serviceContext?: AgentMusicContext
  /** May shorten the per-request 15 second deadline. */
  readonly timeoutMs?: number
}
export interface AgentMusicSearchInput { keyword: string; isArtistOnly?: boolean; accountId: string }
export interface AgentMusicSearchResult { readonly music: AgentMusicCard; readonly id: string; readonly poolSize: number }
const ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const MAX_BYTES = 2 * 1024 * 1024
const TEN_MINUTES = 10 * 60 * 1000
const TWELVE_HOURS = 12 * 60 * 60 * 1000
const md5 = (text: string) => createHash('md5').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
class MusicRequestFailure extends Error { constructor() { super('音乐服务未返回可用结果') } }
class UnsafeMusicData extends Error { constructor() { super('音乐参数或服务数据不符合交付要求') } }

export async function abortableMusic<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MusicRequestFailure())
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}
export async function ensureMusicCurrent(context: AgentMusicContext, signal = context.signal): Promise<void> {
  const check = () => { context.signal.throwIfAborted(); signal.throwIfAborted(); if (!context.isCurrent()) throw new MusicRequestFailure() }
  check()
  if (context.ensureCurrent) await abortableMusic(Promise.resolve().then(() => { check(); return context.ensureCurrent!() }), signal)
  check()
}
function cookieMap(cookie: string): Map<string, string> {
  if (typeof cookie !== 'string' || cookie.length > 32768 || /[^\x20-\x7e]/u.test(cookie)) throw new UnsafeMusicData()
  const result = new Map<string, string>()
  for (const part of cookie.split(';')) {
    if (!part.trim()) continue
    const index = part.indexOf('='), key = part.slice(0, index).trim(), value = part.slice(index + 1).trim()
    if (index < 1 || !/^[A-Za-z0-9_]{1,100}$/u.test(key) || value.length > 8192 || /\s/u.test(value)) throw new UnsafeMusicData()
    result.set(key, value)
  }
  return result
}
function cookieSecrets(cookie: string): string[] {
  return cookie ? [cookie, ...[...cookieMap(cookie)].filter(([key]) => !['uin', 'wxuin', 'login_type', 'tmeLoginType', 'psrf_musickey_createtime'].includes(key)).map(([, value]) => value)] : []
}
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++visited > 40000 || item.depth > 16) throw new UnsafeMusicData()
    if (typeof item.value === 'string' && item.value.length > 32768) throw new UnsafeMusicData()
    if (Array.isArray(item.value)) for (const value of item.value) pending.push({ value, depth: item.depth + 1 })
    else if (record(item.value)) for (const [key, value] of Object.entries(item.value!)) {
      if (key.length > 256) throw new UnsafeMusicData()
      pending.push({ value, depth: item.depth + 1 })
    }
  }
}
function text(value: unknown, maximum: number, optional = false): string {
  if (typeof value !== 'string' || value.length > maximum || !optional && !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new UnsafeMusicData()
  return value.trim()
}
function identifier(value: unknown, optional = false): string {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,80}$/u.test(value)) throw new UnsafeMusicData()
  return value
}
interface Song { mid: string; title: string; artist: string; albumMid: string; singerMid: string; videoMid: string; file: Record<string, unknown> }
function song(value: unknown): Song | undefined {
  const raw = record(value)
  if (!raw || typeof raw.mid !== 'string' || typeof raw.title !== 'string') return undefined
  if (raw.singer !== undefined && !Array.isArray(raw.singer) || Array.isArray(raw.singer) && raw.singer.length > 32 || raw.vs !== undefined && !Array.isArray(raw.vs)) throw new UnsafeMusicData()
  const singers = Array.isArray(raw.singer) ? raw.singer.map(item => {
    const data = record(item)
    if (!data) throw new UnsafeMusicData()
    return { name: text(data.name ?? '', 256, true), mid: identifier(data.mid, true) }
  }) : []
  const file = record(raw.file) ?? {}
  if (file.media_mid !== undefined) identifier(file.media_mid)
  return { mid: identifier(raw.mid), title: text(raw.title.replace(/<\/?em>/gu, ''), 300), artist: text(singers.map(item => item.name).join('/'), 512, true),
    albumMid: identifier(record(raw.album)?.mid, true), singerMid: singers[0]?.mid ?? '', videoMid: identifier(Array.isArray(raw.vs) ? raw.vs[1] : undefined, true), file }
}

/** Fixed QQ Music protocol with one explicitly supplied host credential, independent of message targets. */
export function createAgentMusicProvider(config: AgentMusicConfig, options: AgentMusicProviderOptions = {}) {
  let cookie = config.cookie ?? ''
  cookieMap(cookie)
  const secrets = new Set((options.secrets ?? []).filter(Boolean))
  const musicSecrets = new Set<string>()
  let allowsSecretText = createAgentSecretTextCheck([...secrets])
  function register(values: readonly string[]) {
    for (const value of values) if (value) { secrets.add(value); musicSecrets.add(value) }
    allowsSecretText = createAgentSecretTextCheck([...secrets])
    options.registerSecrets?.(values)
  }
  register(cookieSecrets(cookie))
  const safeText = (value: string) => allowsSecretText(value) && options.allowsText?.(value) !== false
  const safeResponse = (value: unknown, check = allowsSecretText): boolean => {
    const pending = [value]
    while (pending.length) {
      const next = pending.pop()
      if (typeof next === 'string' && !check(next)) return false
      if (Array.isArray(next)) pending.push(...next)
      else if (record(next)) for (const [key, item] of Object.entries(next!)) { if (!check(key)) return false; pending.push(item) }
    }
    return true
  }
  async function post(body: unknown, context: AgentMusicContext, requestCookie = '', refresh = false): Promise<Record<string, unknown>> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, context.signal])
    const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15000, Math.floor(options.timeoutMs!))) : 15000
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.()
    try {
      await ensureMusicCurrent(context, signal)
      let response: Response
      try {
        response = await abortableMusic((options.fetchImpl ?? globalThis.fetch)(ENDPOINT, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': refresh ? 'application/x-www-form-urlencoded' : 'application/json',
            ...(!refresh ? { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)' } : {}),
            ...(requestCookie ? { Cookie: requestCookie } : {}) }, body: JSON.stringify(body) }), signal)
      } catch { throw new MusicRequestFailure() }
      const length = response.headers.get('content-length')
      if (!response.ok || response.redirected || !response.body || length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
        void response.body?.cancel().catch(() => {})
        if (!response.ok) throw new MusicRequestFailure()
        throw new UnsafeMusicData()
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0, raw: string
      try {
        for (;;) {
          const part = await abortableMusic(reader.read(), signal)
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_BYTES) throw new UnsafeMusicData()
          chunks.push(part.value)
        }
        raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      await ensureMusicCurrent(context, signal)
      // Login may echo this music credential; unrelated host secrets must never become refreshed tokens.
      const responseCheck = refresh ? createAgentSecretTextCheck([...new Set([...secrets, ...(options.secrets ?? [])])].filter(value => !musicSecrets.has(value))) : allowsSecretText
      if (!responseCheck(raw)) throw new UnsafeMusicData()
      let value: Record<string, unknown> | undefined
      try { value = record(JSON.parse(raw)) } catch { throw new MusicRequestFailure() }
      if (!value) throw new MusicRequestFailure()
      boundedJson(value)
      if (!safeResponse(value, responseCheck)) throw new UnsafeMusicData()
      return value
    } finally { clearTimeout(timer) }
  }
  let lastCheck: number | undefined, pendingRefresh: Promise<void> | undefined
  const clock = () => { const value = (options.now ?? Date.now)(); if (!Number.isFinite(value) || value < 0) throw new UnsafeMusicData(); return value }
  async function update(context: AgentMusicContext, force: boolean): Promise<void> {
    await ensureMusicCurrent(context)
    const now = clock(), original = cookie
    if (!force && lastCheck !== undefined && now - lastCheck >= 0 && now - lastCheck < TEN_MINUTES) return
    // An attempted Login may already have rotated the remote token, even when its response or local persistence fails.
    lastCheck = now
    const map = cookieMap(original), type = map.get('wxunionid') ? 1 : map.get('psrf_qqunionid') ? 0 : -1
    if (type === -1) { lastCheck = now; return }
    const created = Number(map.get('psrf_musickey_createtime') ?? 0) * 1000
    if (!force && (map.get('qqmusic_key') || map.get('qm_keyst')) && Number.isFinite(created) && now - created >= 0 && now - created <= TWELVE_HOURS) {
      lastCheck = now; return
    }
    const param: Record<string, unknown> = { access_token: '', expired_in: 0, forceRefreshToken: 0, musicid: 0, musickey: map.get('qqmusic_key') || map.get('qm_keyst') || '',
      onlyNeedAccessToken: 0, openid: '', refresh_token: '', unionid: '' }
    if (type === 0) Object.assign(param, { appid: 100497308, access_token: map.get('psrf_qqaccess_token') ?? '', musicid: Number(map.get('uin') ?? '0'),
      openid: map.get('psrf_qqopenid') ?? '', refresh_token: map.get('psrf_qqrefresh_token') ?? '', unionid: map.get('psrf_qqunionid') ?? '' })
    else Object.assign(param, { strAppid: 'wx48db31d50e334801', access_token: map.get('wxaccess_token') ?? '', str_musicid: map.get('wxuin') ?? '0',
      openid: map.get('wxopenid') ?? '', refresh_token: map.get('wxrefresh_token') ?? '', unionid: map.get('wxunionid') ?? '' })
    const response = await post({ comm: { _channelid: '19', _os_version: '6.2.9200-2', authst: '', ct: '19', cv: '1891',
      guid: md5(String(map.get('uin') || map.get('wxuin')) + 'music'), patch: '118', psrf_access_token_expiresAt: 0, psrf_qqaccess_token: '', psrf_qqopenid: '',
      psrf_qqunionid: '', tmeAppID: 'qqmusic', tmeLoginType: 2, uin: '0', wid: '0' }, req_0: { method: 'Login', module: 'music.login.LoginServer', param } }, context, '', true)
    const request = record(response.req_0), data = record(request?.data)
    if (response.code !== undefined && response.code !== 0 || request?.code !== 0 || !data) throw new MusicRequestFailure()
    const required = (key: string) => {
      const value = data[key]
      if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(value) || value.includes(';')) throw new UnsafeMusicData()
      return value
    }
    const id = String(data.str_musicid || data.musicid || '')
    const createdAt = String(data.musickeyCreateTime ?? '')
    if (!/^\d{1,20}$/u.test(id) || !/^\d{1,15}$/u.test(createdAt)) throw new UnsafeMusicData()
    const values = { open: required('openid'), refresh: required('refresh_token'), access: required('access_token'), key: required('musickey'), union: required('unionid'), encrypted: required('encryptUin') }
    const parts = type === 0 ? [`psrf_qqopenid=${values.open}`, `psrf_qqrefresh_token=${values.refresh}`, `psrf_qqaccess_token=${values.access}`, `uin=${id}`] :
      [`wxopenid=${values.open}`, `wxrefresh_token=${values.refresh}`, `wxaccess_token=${values.access}`, `wxuin=${id}`]
    parts.push(`qqmusic_key=${values.key}`, `qm_keyst=${values.key}`, `psrf_musickey_createtime=${createdAt}`, `${type === 0 ? 'psrf_qqunionid' : 'wxunionid'}=${values.union}`,
      `euin=${values.encrypted}`, `login_type=${type === 0 ? 1 : 2}`, `tmeLoginType=${type === 0 ? 2 : 1}`)
    const candidate = parts.join(';')
    cookieMap(candidate)
    await ensureMusicCurrent(context)
    if (cookie !== original) return
    register(cookieSecrets(candidate))
    if (options.onCookieRefresh) await abortableMusic(options.onCookieRefresh(candidate, context), context.signal)
    await ensureMusicCurrent(context)
    if (cookie !== original) return
    cookie = candidate; lastCheck = now
  }
  async function refresh(context: AgentMusicContext, settings: { force?: boolean } = {}): Promise<void> {
    if (config.enabled !== true) return
    try {
      await ensureMusicCurrent(context)
      if (options.serviceContext) {
        if (!pendingRefresh) pendingRefresh = update(options.serviceContext, settings.force === true).finally(() => { pendingRefresh = undefined })
        await abortableMusic(pendingRefresh, context.signal)
      } else await update(context, settings.force === true)
      await ensureMusicCurrent(context)
    } catch (error) { throw error instanceof UnsafeMusicData ? error : new MusicRequestFailure() }
  }
  async function search(input: AgentMusicSearchInput, context: AgentMusicContext): Promise<AgentMusicSearchResult | undefined> {
    if (config.enabled !== true || !/^[1-9]\d{0,19}$/u.test(input.accountId) || typeof input.keyword !== 'string' || input.keyword.length > 200 ||
        !input.keyword.trim() || /[\u0000-\u001f\u007f]/u.test(input.keyword) || !safeText(input.keyword)) throw new UnsafeMusicData()
    await ensureMusicCurrent(context)
    try { await refresh(context) } catch (error) { if (error instanceof UnsafeMusicData) throw error; await ensureMusicCurrent(context) }
    const limit = input.isArtistOnly === true ? 20 : 1
    const response = await post({ comm: { uin: '0', authst: '', ct: 29 }, search: { method: 'DoSearchForQQMusicMobile', module: 'music.search.SearchCgiService',
      param: { grp: 1, num_per_page: limit, page_num: 1, query: input.keyword, remoteplace: 'miniapp.1109523715', search_type: 0, searchid: String(clock()) } } }, context, cookie)
    const searchData = record(response.search)
    if (response.code !== 0 || searchData?.code !== undefined && searchData.code !== 0) return undefined
    const body = record(record(searchData?.data)?.body), raw = record(body?.song)?.list ?? body?.item_song
    if (!Array.isArray(raw)) return undefined
    if (raw.length > 200) throw new UnsafeMusicData()
    const songs = raw.flatMap(value => { const parsed = song(value); return parsed ? [parsed] : [] }).slice(0, limit)
    if (!songs.length) return undefined
    const random = input.isArtistOnly && songs.length > 1 ? (options.random ?? Math.random)() : 0
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new UnsafeMusicData()
    const selected = songs[Math.floor(random * songs.length)]!
    if (!safeText(selected.title) || !safeText(selected.artist)) throw new UnsafeMusicData()
    const picture = selected.videoMid ? `T062R150x150M000${selected.videoMid}` : selected.albumMid ? `T002R150x150M000${selected.albumMid}` : selected.singerMid ? `T001R150x150M000${selected.singerMid}` : ''
    if (!picture) throw new UnsafeMusicData()
    const code = md5(`${selected.mid}q;z(&l~sdf2!nK`).slice(0, 5).toUpperCase()
    let audioUrl = `http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songid=&songmid=${selected.mid}&songtype=1&fromtag=50&uin=${input.accountId}&code=${code}`
    const map = cookieMap(cookie), songmid: string[] = [], songtype: number[] = [], filename: string[] = []
    for (const [key, prefix, extension] of [['size_flac', 'F000', 'flac'], ['size_hires', 'RS01', 'flac'], ['size_96ogg', 'O800', 'ogg'],
      ['size_320mp3', 'M800', 'mp3'], ['size_192ogg', 'O600', 'ogg'], ['size_128mp3', 'M500', 'mp3'], ['size_96aac', 'C400', 'm4a']] as const) {
      if (Number(selected.file[key]) > 0 && selected.file.media_mid) { songmid.push(selected.mid); songtype.push(0); filename.push(`${prefix}${selected.file.media_mid}.${extension}`) }
    }
    if (!songmid.length) songmid.push(selected.mid)
    try {
      const vkey = await post({ comm: { _channelid: '19', _os_version: '6.2.9200-2', authst: map.get('qm_keyst') || map.get('music_key') || '', ct: '19', cv: '1891',
        guid: md5(input.accountId + 'music'), patch: '118', psrf_access_token_expiresAt: 0, psrf_qqaccess_token: '', psrf_qqopenid: '',
        psrf_qqunionid: map.get('psrf_qqunionid') ?? '', tmeAppID: 'qqmusic', tmeLoginType: 2, uin: map.get('uin') ?? '', wid: '0' },
      req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid: md5(String(clock())), songmid, songtype: songtype.length ? songtype : [0], uin: '0', ctx: 1, ...(filename.length ? { filename } : {}) } } }, context)
      const request = record(vkey.req_0)
      if ((vkey.code === undefined || vkey.code === 0) && (request?.code === undefined || request.code === 0)) {
        const urls = record(request?.data)?.midurlinfo
        if (urls !== undefined && (!Array.isArray(urls) || urls.length > 100)) throw new UnsafeMusicData()
        if (Array.isArray(urls)) {
          const purl = urls.map(record).find(item => typeof item?.purl === 'string' && item.purl)?.purl
          if (purl !== undefined) {
            if (typeof purl !== 'string' || purl.length > 4096 || !/^[A-Za-z0-9_-][A-Za-z0-9_./?&=%+~-]*$/u.test(purl) || purl.includes('..') || /%0[ad]|%5c/iu.test(purl)) throw new UnsafeMusicData()
            audioUrl = `http://ws.stream.qqmusic.qq.com/${purl}`
          }
        }
      }
    } catch (error) { if (error instanceof UnsafeMusicData) throw error; await ensureMusicCurrent(context) }
    const music = validateAgentMusicCard({ title: selected.title, ...(selected.artist ? { artist: selected.artist } : {}), pageUrl: `https://y.qq.com/n/yqq/song/${selected.mid}.html`,
      audioUrl, coverUrl: `http://y.gtimg.cn/music/photo_new/${picture}.jpg` })
    if (!safeResponse(music) || !safeText(music.title) || music.artist && !safeText(music.artist)) throw new UnsafeMusicData()
    await ensureMusicCurrent(context)
    return { music, id: selected.mid, poolSize: songs.length }
  }
  return { search: async (input: AgentMusicSearchInput, context: AgentMusicContext) => {
    try { return await search(input, context) } catch (error) { throw error instanceof UnsafeMusicData ? error : new MusicRequestFailure() }
  }, refresh, getSecrets: (): readonly string[] => [...secrets] }
}
export type AgentMusicProvider = ReturnType<typeof createAgentMusicProvider>
