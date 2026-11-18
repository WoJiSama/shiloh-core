/** Export presentation only: no platform identity, files, storage or dice runtime. */
export interface LogExportSession {
  readonly file?: string
  readonly title?: string
  readonly startedAt?: string
  readonly endedAt?: string
}

export interface LogExportLine {
  readonly at?: string
  readonly name?: string
  readonly userId?: string
  readonly content?: string
  readonly type?: string
}

export interface LogExportGroup<T extends LogExportSession = LogExportSession> {
  readonly log?: T
  readonly logs?: readonly T[]
}

export interface LogExportOptions {
  /** UTF-8 output bytes, from 1 MiB through 100 MiB. Omission preserves legacy rendering. */
  readonly maxBytes?: number
}

const MiB = 1024 * 1024
const CHUNK_CHARACTERS = 8192
const invalidBudget = () => new Error('团录导出字节上限必须为1至100MiB的整数')
const overBudget = () => new Error('团录导出超过完整文件字节上限')

/** Count UTF-8 replacement semantics without allocating another encoded copy. */
function utf8Bytes(value: string): number {
  let bytes = 0
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length && value.charCodeAt(at + 1) >= 0xdc00 && value.charCodeAt(at + 1) <= 0xdfff) { bytes += 4; at++ }
    else bytes += 3
  }
  return bytes
}

function chunks(value: string, append: (value: string) => void): void {
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + CHUNK_CHARACTERS, value.length)
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    append(value.slice(at, end)); at = end
  }
}

function writer(options: LogExportOptions) {
  const maximum = options.maxBytes
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < MiB || maximum > 100 * MiB)) throw invalidBudget()
  const output: string[] = []; let size = 0, pending = ''
  const append = (value: string): void => chunks(value, chunk => {
    size += utf8Bytes(chunk)
    if (maximum !== undefined && size > maximum) throw overBudget()
    if (pending.length + chunk.length > CHUNK_CHARACTERS) { output.push(pending); pending = '' }
    pending += chunk
  })
  return {
    append,
    text(value: unknown): void { append(String(value)) },
    escaped(value: unknown): void {
      chunks(String(value ?? ''), chunk => append(chunk.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')))
    },
    finish(): string { output.push(pending); return output.join('') },
  }
}

/** Current first; newest historical index next; exact titles prefer current, then newest history. */
export function resolveLogForExport<T extends LogExportSession>(group: LogExportGroup<T> = {}, raw = ''): T | null {
  const selector = String(raw || '').trim()
  const current = group.log?.file ? group.log : null
  const history = [...(group.logs || [])].filter(item => item?.file && item.file !== current?.file).reverse()
  if (!selector || /^(current|当前)$/i.test(selector)) return current
  if (/^\d+$/.test(selector)) return history[Number(selector) - 1] || null
  return [current, ...history].filter((item): item is T => item !== null).find(item => String(item.title || '') === selector) || null
}

/** Complete TXT, preserving the original header/body bytes and final newline. */
export function renderLogText(log: LogExportSession, lines: readonly LogExportLine[], options: LogExportOptions = {}): string {
  const out = writer(options)
  out.append('# '); out.text(log.title || 'COC Log'); out.append('\n开始：'); out.text(log.startedAt || '')
  if (log.endedAt) { out.append('\n结束：'); out.text(log.endedAt) }
  for (let index = 0; index < lines.length; index++) {
    if (index) out.append('\n')
    if (!(index in lines)) continue
    const item = lines[index]!, time = item.at ? item.at.replace('T', ' ').slice(0, 19) : ''
    out.append('['); out.append(time); out.append('] '); out.text(item.name || item.userId)
    out.append('('); out.text(item.userId); out.append('): '); out.text(item.content)
  }
  out.append('\n'); return out.finish()
}

function diceClass(content: unknown): string {
  const text = String(content || '')
  if (text.includes('大成功')) return 'dice-crit'
  if (text.includes('大失败')) return 'dice-fumble'
  if (/极难成功|困难成功|成功/.test(text)) return 'dice-pass'
  if (/失败/.test(text)) return 'dice-fail'
  return 'dice-roll'
}

/** Escaped offline HTML; each escaped field and row is checked before the final bounded join. */
export function renderLogHtml(log: LogExportSession, lines: readonly LogExportLine[], options: LogExportOptions = {}): string {
  const out = writer(options)
  out.append(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>`)
  out.escaped(log.title || 'COC Log')
  out.append(`</title>
<style>
  body { margin: 0; background: #16171f; color: #d7d9e0; font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  header { border-bottom: 1px solid #2c2e3d; padding-bottom: 14px; margin-bottom: 18px; }
  h1 { margin: 0 0 6px; font-size: 20px; color: #f0f1f5; }
  .info { color: #8b8fa3; font-size: 13px; }
  .msg { background: #1f2130; border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
  .meta { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; margin-bottom: 4px; }
  .name { color: #8ab4f8; font-weight: 600; }
  .time { color: #6b6f84; }
  .content { white-space: pre-wrap; word-break: break-word; }
  .dice { border-left: 3px solid #6b7280; }
  .dice-crit { border-left-color: #34d399; background: #17251f; }
  .dice-crit .content { color: #6ee7b7; }
  .dice-fumble { border-left-color: #f87171; background: #2a1c1e; }
  .dice-fumble .content { color: #fca5a5; }
  .dice-pass { border-left-color: #4ade80; }
  .dice-fail { border-left-color: #fb923c; }
  .dice-roll { border-left-color: #818cf8; }
  footer { margin-top: 22px; color: #565a6e; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>🎲 `)
  out.escaped(log.title || 'COC Log'); out.append('</h1>\n  <div class="info">开始：'); out.escaped(log.startedAt || '未知')
  if (log.endedAt) { out.append(' ｜ 结束：'); out.escaped(log.endedAt) }
  out.append(' ｜ 共 '); out.text(lines.length); out.append(' 条记录</div>\n</header>\n')
  for (let index = 0; index < lines.length; index++) {
    if (index) out.append('\n')
    if (!(index in lines)) continue
    const item = lines[index]!, time = item.at ? item.at.replace('T', ' ').slice(0, 19) : '', isDice = item.type === 'dice_result'
    out.append('<div class="msg'); if (isDice) { out.append(' dice '); out.append(diceClass(item.content)) }
    out.append('">\n  <div class="meta"><span class="name">'); if (isDice) out.append('🎲 ')
    out.escaped(item.name || item.userId); out.append('</span><span class="time">'); out.escaped(time)
    out.append('</span></div>\n  <div class="content">'); out.escaped(item.content); out.append('</div>\n</div>')
  }
  out.append('\n<footer>由跑团骰娘导出</footer>\n</div>\n</body>\n</html>')
  return out.finish()
}
