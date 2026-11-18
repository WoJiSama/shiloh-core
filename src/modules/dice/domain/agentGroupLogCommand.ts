export type AgentGroupLogCommand =
  | { kind: 'start'; title: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'list' }
  | { kind: 'export'; selector: string; format: 'txt' | 'html' }
  | { kind: 'end' }
  | { kind: 'ai'; enabled?: boolean }
  | { kind: 'invalid' }

const controls = /[\u0000-\u001f\u007f-\u009f]/u
const logHead = /^[.。]\s*log(?=[\s\u0000-\u001f\u007f-\u009f]|$)/iu
const aiHead = /^[.。]\s*(?:骰娘|dice)\s+跑团ai(?=[\s\u0000-\u001f\u007f-\u009f]|$)/iu

/** Parse only local group-log commands; selectors are opaque local titles or history indices. */
export function parseAgentGroupLogCommand(text: unknown): AgentGroupLogCommand | undefined {
  if (typeof text !== 'string') return undefined
  const input = text.trim()
  const log = input.match(logHead), ai = input.match(aiHead)
  if (!log && !ai) return undefined
  if (text.length > 4096 || controls.test(text)) return { kind: 'invalid' }
  if (ai) {
    const action = input.slice(ai[0].length).trim().toLowerCase()
    if (!action || action === '状态' || action === 'status') return { kind: 'ai' }
    if (action === '开' || action === '开启' || action === 'on') return { kind: 'ai', enabled: true }
    if (action === '关' || action === '关闭' || action === 'off') return { kind: 'ai', enabled: false }
    return { kind: 'invalid' }
  }
  const body = input.slice(log![0].length).trim()
  const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/u)
  if (!match) return { kind: 'invalid' }
  const action = match[1]!.toLowerCase(), argument = (match[2] ?? '').trim()
  if (['new', 'on', 'start', 'create', '新建', '开始', '开启'].includes(action)) {
    if (argument.length > 80) return { kind: 'invalid' }
    return { kind: 'start', title: argument }
  }
  // The legacy stop/end handlers ignore trailing text; end always exports the current TXT log.
  if (['off', 'stop', '结束', '关闭'].includes(action)) return { kind: 'stop' }
  if (action === 'end' || action === '结束并导出') return { kind: 'end' }
  if (action === 'status' || action === '状态') return argument ? { kind: 'invalid' } : { kind: 'status' }
  if (['list', '列表', '历史', '团录'].includes(action)) return argument ? { kind: 'invalid' } : { kind: 'list' }
  if (['export', 'get', '导出', '获取'].includes(action)) {
    const tokens = argument.split(/\s+/u).filter(Boolean)
    if (/^(?:html|htm|网页版?)$/iu.test(tokens.at(-1) ?? '')) {
      tokens.pop()
      return { kind: 'export', selector: tokens.join(' '), format: 'html' }
    }
    return { kind: 'export', selector: argument, format: 'txt' }
  }
  return { kind: 'invalid' }
}
