import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import type { AgentMediaArtifact, AgentMediaArtifactLease, AgentMediaResourceContext, AgentMediaResourcePort } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'

interface CardView {
  readonly platform: AgentMediaShare['provider']
  readonly kind: '视频' | '番剧' | '图文' | '插画' | '漫画' | '作品'
  readonly title: string
  readonly author?: string
  readonly detail?: string
  readonly description?: string
  readonly stats?: readonly (readonly [label: string, count: number])[]
  readonly notice?: string
  readonly pageUrl: string
}

const WIDTH = 920, INSET = 38, CONTENT = WIDTH - 2 * INSET, COVER_HEIGHT = 416
const themes = {
  bilibili: { name: '哔哩哔哩', accent: '#71d8ff', background: '#122d40', shadow: '#0b1727' },
  douyin: { name: '抖音', accent: '#ff93a5', background: '#3b2337', shadow: '#161322' },
  xiaohongshu: { name: '小红书', accent: '#ff9b9c', background: '#41262a', shadow: '#23171d' },
  youtube: { name: 'YouTube', accent: '#ff9890', background: '#352725', shadow: '#19181d' },
  pixiv: { name: 'Pixiv', accent: '#83caff', background: '#25294b', shadow: '#121a2d' },
}
const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const graphemes = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
function excerpt(value: string, limit: number) {
  const characters = Array.from(graphemes.segment(value.trim()), part => part.segment)
  return characters.length > limit ? characters.slice(0, limit).join('') + '…' : characters.join('')
}
const escapeMarkup = (value: string) => value.replace(/[&<>]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)

async function coverPanel(artifact: AgentMediaArtifact, resources: AgentMediaResourcePort, context: AgentMediaResourceContext) {
  const reader = await resources.open(artifact, context)
  const chunks: Buffer[] = []
  try {
    for await (const bytes of reader.chunks) chunks.push(Buffer.from(bytes))
  } finally { await reader.close?.() }
  const photo = await sharp(Buffer.concat(chunks), { limitInputPixels: 16 * 1024 * 1024 })
    .timeout({ seconds: 5 }).rotate().resize(CONTENT, COVER_HEIGHT, { fit: 'inside' })
    .flatten({ background: '#111a28' }).png().toBuffer()
  const backdrop = await sharp(photo).timeout({ seconds: 5 }).resize(CONTENT, COVER_HEIGHT, { fit: 'cover' })
    .blur(26).modulate({ brightness: 0.5 }).png().toBuffer()
  const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + CONTENT + '" height="' + COVER_HEIGHT +
    '"><rect width="100%" height="100%" rx="20" fill="white"/></svg>')
  return sharp(backdrop).composite([{ input: photo, gravity: 'centre' }, { input: mask, blend: 'dest-in' }]).png().toBuffer()
}

/** Only validated, already staged cover bytes are drawn. The card renderer opens no network connections. */
export async function renderAgentMediaRelayCard(view: CardView, options: {
  readonly covers: readonly (AgentMediaArtifact | undefined)[]
  readonly resources: AgentMediaResourcePort
  readonly context: AgentMediaResourceContext
  readonly allowsText: (value: string) => boolean
  readonly onCoverError: (error: unknown) => void
}): Promise<Buffer> {
  const { context, allowsText } = options
  const check = () => {
    if (context.signal.aborted || !context.isCurrent()) throw new Error('搬运卡面授权已失效')
  }
  check()
  const theme = themes[view.platform]
  const fields = {
    platform: theme.name,
    kind: view.kind,
    title: excerpt(view.title, 72),
    byline: [excerpt(view.author ?? '', 38), view.detail].filter(Boolean).join(' · '),
    description: view.description === view.title ? '' : excerpt(view.description ?? '', 104),
    stats: view.stats?.slice(0, 3).map(([label, count]) => label + ' ' + compactNumber.format(count)).join(' · ') ?? '',
    notice: excerpt(view.notice ?? '', 140),
    url: view.pageUrl,
  }
  if (!allowsText(Object.values(fields).filter(Boolean).join('\n'))) throw new Error('搬运卡面未通过出站校验')

  let cover: Buffer | undefined
  for (const artifact of options.covers) {
    if (!artifact) continue
    check()
    try { cover = await coverPanel(artifact, options.resources, context); break }
    catch (error) { check(); options.onCoverError(error) }
  }
  check()
  const text = async (value: string, size: number, color: string, bold = false) =>
    value ? await sharp({ text: {
      text: '<span foreground="' + color + '">' + escapeMarkup(value) + '</span>',
      font: 'sans-serif ' + (bold ? 'Bold ' : '') + size, width: CONTENT, rgba: true, wrap: 'word-char',
    } }).timeout({ seconds: 5 }).png().toBuffer({ resolveWithObject: true }) : undefined
  const [platform, kind, title, byline, description, stats, notice, url] = await Promise.all([
    text(fields.platform, 24, theme.accent, true), text(fields.kind, 19, '#d5ddeb', true),
    text(fields.title, 40, '#f7f9ff', true), text(fields.byline, 22, '#c5d4e8'),
    text(fields.description, 21, '#c5d4e8'), text(fields.stats, 22, theme.accent, true),
    text(fields.notice, 20, '#f8d29d'), text(fields.url, 18, '#aabed5'),
  ])
  check()

  const layers: OverlayOptions[] = []
  let top = 82
  if (platform) layers.push({ input: platform.data, left: INSET + 14, top: 30 })
  if (kind) layers.push({ input: kind.data, left: WIDTH - INSET - kind.info.width, top: 33 })
  if (cover) {
    layers.push({ input: cover, left: INSET, top })
    top += COVER_HEIGHT + 27
  }
  for (const [line, gap] of [[title, 16], [byline, 19], [description, 19], [stats, 18], [notice, 18]] as const) {
    if (!line) continue
    layers.push({ input: line.data, left: INSET, top })
    top += line.info.height + gap
  }
  const divider = top + 1
  if (url) {
    layers.push({ input: url.data, left: INSET, top: divider + 19 })
    top = divider + 19 + url.info.height
  }
  const height = top + 30
  const backdrop = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + height + '">' +
    '<defs><linearGradient id="card" x2="1" y2="1"><stop stop-color="' + theme.background + '"/>' +
    '<stop offset="1" stop-color="' + theme.shadow + '"/></linearGradient></defs>' +
    '<rect width="100%" height="100%" rx="25" fill="url(#card)"/>' +
    '<rect x="' + INSET + '" y="30" width="4" height="24" rx="2" fill="' + theme.accent + '"/>' +
    '<path d="M' + INSET + ' ' + divider + 'h' + CONTENT + '" stroke="#ffffff" opacity=".18"/></svg>',
  )
  const bytes = await sharp(backdrop).timeout({ seconds: 5 }).composite(layers).png().toBuffer()
  check()
  return bytes
}

/** Stage a rendered card under the same resource authority and lifetime as its media. */
export async function stageAgentMediaRelayCard(view: CardView, options: {
  readonly artifacts: AgentMediaArtifactStore
  readonly covers: readonly (AgentMediaArtifact | undefined)[]
  readonly allowsText: (value: string) => boolean
  readonly diagnostics: Pick<AgentDiagnostics, 'emit'> | undefined
  readonly guard: {
    readonly context: AgentMediaResourceContext
    ensure(): Promise<void>
    wait<T>(operation: Promise<T>, late?: (value: T) => unknown): Promise<T>
  }
}): Promise<AgentMediaArtifactLease | undefined> {
  const { guard, artifacts } = options
  const report = (step: 'media_card_cover' | 'media_card_render' | 'media_card_store', error: unknown) => {
    try {
      options.diagnostics?.emit({ stage: 'runtime', operation: `${view.platform}_provider_card`, outcome: 'failed',
        code: step === 'media_card_cover' ? 'relay_card_cover_failed' : 'relay_card_render_failed', details: { step }, error })
    } catch { /* Diagnostics cannot prevent a valid fallback. */ }
  }
  let step: 'media_card_render' | 'media_card_store' = 'media_card_render'
  try {
    await guard.ensure()
    const bytes = await guard.wait(renderAgentMediaRelayCard(view, {
      covers: options.covers, resources: artifacts, context: guard.context, allowsText: options.allowsText,
      onCoverError: error => report('media_card_cover', error),
    }))
    step = 'media_card_store'
    await guard.ensure()
    return await guard.wait(artifacts.stage({ kind: 'image', mime: 'image/png',
      chunks: (async function* () { yield bytes })() }, guard.context), late => late.release())
  } catch (error) {
    await guard.ensure()
    report(step, error)
    return undefined
  }
}
