import type { AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import type { DeltaForceConfig } from '../../../contracts/deltaForce.js'
import type { DeltaReport } from '../../../contracts/deltaForceReport.js'
import type { MessageImage } from '../../../contracts/platformConnection.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { abortableAgentWeb, ensureAgentWebCurrent } from '../../tools/infrastructure/agentPublicWeb.js'
import { normalizeDeltaForceObjects } from './DeltaForceObjectCache.js'
import {
  DeltaForceClient, buildObjectValueReportData, buildPlaceProfitReportData, buildPriceHistoryReportData,
  buildProfitRankReportData, buildSolutionListReportData, formatDailyKeywordResponse,
  formatObjectValueSearchResponse, formatPlaceProfitResponse, formatPriceHistoryResponse,
  formatProfitRankResponse, formatSolutionListResponse, getDeltaForceHelp, normalizeDeltaForcePlace,
} from './DeltaForceClient.js'

export type AgentDeltaForceConfig = Readonly<Omit<DeltaForceConfig, 'enabled'> & { enabled: true }>
export interface AgentDeltaForceToolsOptions {
  readonly deltaForce?: AgentDeltaForceConfig
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly fetchImpl?: typeof fetch
  readonly renderReport?: (report: DeltaReport, context: Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>) => Promise<MessageImage>
}
const OPERATIONS = ['help', 'daily_keyword', 'object_value', 'price_history', 'solution_list', 'place_profit', 'profit_rank'] as const
const MAX_RESPONSE = 1024 * 1024
const MAX_TOTAL = 4 * 1024 * 1024
const failed = (): AgentToolResult => ({ status: 'failed', content: '三角洲查询未完成，请核对参数、服务配置或稍后再试。' })
const uncertain = (): AgentToolResult => ({ status: 'unknown', content: '三角洲报表发送结果尚未确认，请先核实当前会话，不会自动重发。' })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' &&
  value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)

/** Only the administrator's fixed API receives query fields; no event, filesystem or native bot escapes. */
export function createAgentDeltaForceTools(options: AgentDeltaForceToolsOptions = {}): AgentToolRegistry {
  const config = options.deltaForce
  if (config?.enabled !== true) return { builtIn: [] }
  const base = new URL(config.apiBaseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      !/^[\x21-\x7e]{1,8192}$/u.test(config.apiKey) || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60_000 ||
      typeof config.objectCacheEnabled !== 'boolean' || !Number.isInteger(config.objectCacheRefreshMinutes) || config.objectCacheRefreshMinutes < 10 || config.objectCacheRefreshMinutes > 1440) throw new Error('三角洲工具配置无效')
  const prefix = base.href.replace(/\/+$/u, '') + '/api/v1/df/'
  const safe = createAgentSecretTextCheck([config.apiKey, ...(options.secrets ?? [])])
  let names = new Map<string, string>(), namesAt = 0
  return { builtIn: [{
    name: 'deltaForceTool', dataPolicy: 'ephemeral', timeoutMs: 90_000,
    description: '查询三角洲行动每日密码、物品价值、价格历史图、改枪方案、特勤处制造利润与排行。只使用管理员配置的第三方资料服务，资料未经核实。默认发送一张报表；output=text 返回文字。未知投递不得重发。',
    parameters: { type: 'object', properties: {
      operation: { type: 'string', enum: OPERATIONS }, keyword: { type: 'string', maxLength: 256 },
      place: { type: 'string', maxLength: 40, description: '工作台、技术中心、制药台、防具台，或对应英文标识' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }, days: { type: 'integer', minimum: 1, maximum: 90 },
      output: { type: 'string', enum: ['image', 'text'] }, prompt: { type: 'string', maxLength: 1000 },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, context): Promise<AgentToolResult> {
      if (!object(input) || Object.keys(input).some(key => !['operation', 'keyword', 'place', 'limit', 'days', 'output', 'prompt'].includes(key)) ||
          !OPERATIONS.some(value => value === input.operation) ||
          ['keyword', 'place', 'prompt'].some(key => input[key] !== undefined && !boundedText(input[key], key === 'prompt' ? 1000 : key === 'place' ? 40 : 256)) ||
          input.output !== undefined && (typeof input.output !== 'string' || !['image', 'text'].includes(input.output)) ||
          input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 20) ||
          input.days !== undefined && (!Number.isInteger(input.days) || Number(input.days) < 1 || Number(input.days) > 90) || !safe(JSON.stringify(input))) return failed()
      const keyword = String(input.keyword ?? '').trim(), placeText = String(input.place ?? '').trim()
      const place = placeText ? normalizeDeltaForcePlace(placeText) : null
      if (placeText && !place || ['object_value', 'price_history'].includes(String(input.operation)) && !keyword) return failed()
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(90_000)])
      const scoped = { ...context, signal }
      const ensure = () => ensureAgentWebCurrent(scoped)
      let total = 0, sending = false
      const request: typeof fetch = async (url, init) => {
        const target = String(url)
        if (!target.startsWith(prefix)) throw new Error('unexpected endpoint')
        const stepSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
        await ensureAgentWebCurrent(scoped, stepSignal)
        let response: Response | undefined
        try {
          response = await abortableAgentWeb(Promise.resolve().then(async () => {
            await ensureAgentWebCurrent(scoped, stepSignal)
            const result = await (options.fetchImpl ?? fetch)(target, { ...init, redirect: 'error', signal: stepSignal })
            if (stepSignal.aborted || !scoped.isCurrent()) { void result.body?.cancel().catch(() => {}); throw new Error('stale response') }
            return result
          }), stepSignal)
          if (!response || !response.ok || response.redirected || response.url && response.url !== target || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('invalid response')
          const reader = response.body.getReader(), chunks: Uint8Array[] = []
          let size = 0
          try {
            for (;;) {
              const chunk = await abortableAgentWeb(reader.read(), stepSignal)
              if (chunk.done) break
              size += chunk.value.byteLength; total += chunk.value.byteLength
              if (size > MAX_RESPONSE || total > MAX_TOTAL) throw new Error('response too large')
              chunks.push(chunk.value)
            }
          } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
          await ensureAgentWebCurrent(scoped, stepSignal)
          const text = Buffer.concat(chunks, size).toString('utf8')
          if (!safe(text)) throw new Error('unsafe response')
          const data: unknown = JSON.parse(text)
          if (!object(data)) throw new Error('invalid response')
          return new Response(text, { headers: { 'Content-Type': 'application/json' } })
        } finally { void response?.body?.cancel().catch(() => {}) }
      }
      const client = new DeltaForceClient(config, { fetchImpl: request })
      try {
        await ensure()
        let text: string, report: DeltaReport | undefined
        const limit = Number(input.limit ?? (input.operation === 'price_history' ? 5 : 10)), days = Number(input.days ?? 30)
        const query = { keyword, limit, days }
        switch (input.operation) {
          case 'help': text = getDeltaForceHelp(); break
          case 'daily_keyword': text = formatDailyKeywordResponse(await client.getDailyKeyword()); break
          case 'object_value': { const body = await client.searchObjectValue(query); text = formatObjectValueSearchResponse(body, query); report = buildObjectValueReportData(body, query); break }
          case 'price_history': { const body = await client.searchPriceHistory(query); text = formatPriceHistoryResponse(body, query); report = buildPriceHistoryReportData(body, query); break }
          case 'solution_list': { const body = await client.getSolutionList(query); text = formatSolutionListResponse(body, query); report = buildSolutionListReportData(body, query); break }
          default: {
            if (config.objectCacheEnabled && Date.now() - namesAt > config.objectCacheRefreshMinutes * 60_000) {
              try {
                const objects = normalizeDeltaForceObjects(await client.getAllObjectList({ limit: 1000, maxPages: 10 }))
                if (objects.length > 10_000) throw new Error('object list too large')
                await ensure(); names = new Map(objects.map(value => [value.objectID, value.objectName])); namesAt = Date.now()
              } catch { await ensure() /* A failed optional public-name cache does not fabricate values. */ }
            }
            const params = { placeType: place?.type ?? '', limit, objectNameResolver: config.objectCacheEnabled ? names : null }
            if (input.operation === 'place_profit') { const body = await client.getPlaceProfit(); text = formatPlaceProfitResponse(body, params); report = buildPlaceProfitReportData(body, params) }
            else { const body = await client.getPlaceProfitRank(params); text = formatProfitRankResponse(body, params); report = buildProfitRankReportData(body, params) }
          }
        }
        await ensure()
        const visible = JSON.stringify({ text, report })
        if (!safe(visible) || visible.length > 192 * 1024 || options.allowsText?.(visible) === false) return failed()
        const plain = `${text}\n（三角洲第三方资料，未经核实）`
        if (plain.length > 16_000) return failed()
        const textOnly = input.output === 'text' || /(?:用|发|给).{0,6}(?:文字|文本)|不要(?:发)?图|别(?:发)?图|纯文字/u.test(String(input.prompt ?? ''))
        if (!report || textOnly || !context.sendImage || !options.renderReport) return { status: 'succeeded', content: plain }
        let image: MessageImage
        try { image = validateAgentToolImage(await abortableAgentWeb(options.renderReport(report, scoped), signal)); await ensure() }
        catch { await ensure(); return { status: 'succeeded', content: `${plain}\n（报表图片未生成，以上为文字结果）` } }
        await ensure(); sending = true
        const receipt = normalizeDeliveryReceipt(await abortableAgentWeb(context.sendImage(image), signal))
        if (receipt.state === 'failed') { sending = false; return failed() }
        if (receipt.state !== 'sent') return uncertain()
        await ensure()
        return { status: 'succeeded', content: '已发送三角洲资料报表，第三方数据未经核实。' }
      } catch { return sending ? uncertain() : failed() }
    },
  }] }
}
