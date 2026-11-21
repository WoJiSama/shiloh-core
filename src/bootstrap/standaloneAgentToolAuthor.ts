import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ChatRequestData, ChatResponse } from '../contracts/modelGateway.js'
import { decodePersonalTool } from '../modules/simulation/domain/agentPersonalTools.js'
import { parseAgentToolArguments } from '../modules/tools/infrastructure/agentToolSchema.js'

export function createStandaloneAgentToolAuthor(options: {
  model(agentId: string, request: ChatRequestData, signal: AbortSignal): Promise<ChatResponse>
  allowsText(text: string): boolean
}) {
  const script = fileURLToPath(new URL('standaloneAgentToolPublisher.js', import.meta.url))
  const backend = fileURLToPath(new URL('../', import.meta.url))
  return async (agentId: string, name: string, task: string, signal: AbortSignal) => {
    if (!options.allowsText(task)) throw new Error('文字工具任务含受限内容')
    const result = await options.model(agentId, { messages: [
      { role: 'system', content: [
        '为你自己的任务编写一个纯文字分析工具。返回 JSON，其中 definition 有 name、description、steps，examples 是 1 到 4 条 {before,after,expected}。',
        '输入是两段换行分隔的文字。从 after 的非空、已修剪行开始。steps 最多 8 项。',
        '支持 {"kind":"added"} 保留 before 中没有的行，{"kind":"include","text":"某字面量"}、{"kind":"exclude","text":"某字面量"}、{"kind":"unique"}、{"kind":"sort"}、{"kind":"count"}。count 只能最后一步。',
        '输出是用 LF 连接的至多 20 行，或者 count 的十进制文字。名称必须与任务中的 name 完全相同。用能区分正确和错误行为的合成例子。',
      ].join('\n') },
      { role: 'user', content: JSON.stringify({ name, task }) },
    ] }, signal)
    const raw = result.choices?.[0]?.message?.content
    const candidate = typeof raw === 'string' && !result.error
      ? parseAgentToolArguments(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/giu, ''), 60_000) : undefined
    if (!candidate || !options.allowsText(JSON.stringify(candidate))) throw new Error('文字工具作者未返回有效候选')
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ['--permission', '--allow-fs-read=' + backend, script], {
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
        windowsHide: true, signal, timeout: 8_000, maxBuffer: 32 * 1024,
      }, (error, stdout) => error ? reject(new Error('文字工具发布检查未通过')) : resolve(stdout))
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(candidate))
    })
    signal.throwIfAborted()
    const tool = decodePersonalTool(JSON.parse(output))
    if (tool.name !== name) throw new Error('文字工具名称与任务不一致')
    return tool
  }
}
