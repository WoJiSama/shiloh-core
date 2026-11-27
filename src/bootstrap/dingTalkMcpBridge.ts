import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export interface DingTalkPublishedTool {
  readonly command: string
  readonly profile: string
  readonly corpId: string
  readonly userId: string
  readonly mcpId: string
  readonly tool: string
  readonly fixed: Readonly<Record<string, string | boolean | number>>
  readonly queryParameter?: string
  readonly resultFields: readonly string[]
}

const record = (value: unknown): Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function payload(value: unknown): Record<string, unknown> {
  const row = record(value)
  if (row.success === false || row.ok === false) throw new Error('DWS 调用未完成')
  const inner = record(row.data)
  return Object.keys(inner).length ? inner : row
}

function runDws(tool: DingTalkPublishedTool, args: string[], signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(tool.command, [...args, '--profile', tool.profile, '--format', 'json', '--timeout', '12'], {
      windowsHide: true, signal, timeout: 15_000, maxBuffer: 512 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { reject(new Error('DWS 凭据或 MCP 服务暂不可用')); return }
      try { resolve(payload(JSON.parse(stdout))) } catch { reject(new Error('DWS 返回格式无效')) }
    })
  })
}

export async function openDingTalkMcpBridge(tool: DingTalkPublishedTool, transport: Transport, run = runDws) {
  const server = new Server({ name: 'shiloh-dingtalk', version: '1.0.0' }, { capabilities: { tools: {} } })
  async function verify(signal: AbortSignal) {
    const identity = await run(tool, ['auth', 'status', '--readonly'], signal)
    if (identity.authenticated !== true || identity.corp_id !== tool.corpId || identity.user_id !== tool.userId) {
      throw new Error('DWS 登录身份与当前钉钉授权不一致')
    }
  }
  async function getTool(signal: AbortSignal) {
    await verify(signal)
    const result = await run({ ...tool, profile: tool.corpId + ':' + tool.userId }, ['mcp', 'published', 'tools', tool.mcpId], signal)
    const native = Array.isArray(result.tools) ? result.tools.map(record).find(item => item.name === tool.tool) : undefined
    const schema = record(native?.inputSchema)
    if (!native || schema.type !== 'object' || record(native.annotations).readOnlyHint === false) throw new Error('已发布钉钉工具未通过只读校验')
    const properties = record(schema.properties)
    if (tool.queryParameter && record(properties[tool.queryParameter]).type !== 'string' ||
        Object.keys(tool.fixed).some(key => !Object.hasOwn(properties, key))) throw new Error('已发布钉钉工具的参数定义已改变')
    return schema
  }
  server.setRequestHandler(ListToolsRequestSchema, async (_, extra) => {
    const schema = await getTool(extra.signal)
    return { tools: [{ name: tool.tool, inputSchema: { type: 'object', properties: tool.queryParameter ?
      { [tool.queryParameter]: { ...record(record(schema.properties)[tool.queryParameter]), type: 'string', maxLength: 200 } } : {},
    required: tool.queryParameter ? [tool.queryParameter] : [], additionalProperties: false }, annotations: { readOnlyHint: true } }] }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== tool.tool) throw new Error('钉钉工具未获授权')
    await getTool(extra.signal)
    const incoming = request.params.arguments ?? {}
    const query = tool.queryParameter ? incoming[tool.queryParameter] : undefined
    if (Object.keys(incoming).length !== (tool.queryParameter ? 1 : 0) || tool.queryParameter &&
        (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query))) throw new Error('钉钉工具参数无效')
    const params = { ...tool.fixed, ...(tool.queryParameter ? { [tool.queryParameter]: query } : {}) }
    const native = await run({ ...tool, profile: tool.corpId + ':' + tool.userId },
      ['mcp', 'published', 'invoke', tool.mcpId, tool.tool, '--params', JSON.stringify(params)], extra.signal)
    const result = record(native.result)
    if (native.mcpId !== tool.mcpId || native.tool !== tool.tool || result.isError === true) throw new Error('已发布钉钉工具调用失败')
    const candidates: Record<string, unknown>[] = [record(result.structuredContent)]
    for (const item of Array.isArray(result.content) ? result.content.slice(0, 8) : []) {
      const row = record(item)
      if (row.type !== 'text' || typeof row.text !== 'string' || row.text.length > 60_000) continue
      try { candidates.push(record(JSON.parse(row.text))) }
      catch { candidates.push({ text: row.text }) }
    }
    const output: Record<string, unknown> = Object.create(null)
    for (const key of tool.resultFields) {
      for (const candidate of candidates) {
        const data = key.split('.').reduce<unknown>((value, part) => record(value)[part], candidate)
        if (typeof data === 'string' || typeof data === 'number' && Number.isFinite(data) || typeof data === 'boolean') {
          output[key] = typeof data === 'string' ? data.slice(0, 5000) : data
          break
        }
      }
    }
    if (!Object.keys(output).length) throw new Error('钉钉 MCP 没有返回已授权字段')
    return { content: [{ type: 'text', text: JSON.stringify(output) }] }
  })
  await server.connect(transport)
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const serialized = process.env.SHILOH_DINGTALK_PUBLISHED_TOOL
  if (!serialized || serialized.length > 16_000) process.exitCode = 1
  else void openDingTalkMcpBridge(JSON.parse(serialized) as DingTalkPublishedTool, new StdioServerTransport())
    .catch(() => { process.exitCode = 1 })
}
