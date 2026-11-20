import { createHash } from 'node:crypto'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext, AgentConsoleService } from '../contracts/agentConsole.js'
import type { AgentManagementBindings } from '../contracts/agentManagement.js'
import type { AgentQzoneLedger, AgentQzoneReceipt } from '../contracts/agentQzone.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import { agentBindingToken, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { normalizeAgentQzoneLimits, normalizeAgentQzoneReceipt, prepareAgentQzoneText, qzoneData } from '../modules/tools/infrastructure/agentQzoneValidation.js'

const qqId = /^[1-9]\d{0,19}$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const limits = normalizeAgentQzoneLimits()
const failed = (qq: string, error: string) => ({ qq, ok: false, error })
const uncertain = (qq: string) => failed(qq, '发布回执待确认，请先在 QQ 空间核对。')

export function createStandaloneAgentConsoleQzone(options: {
  readonly bindings: AgentManagementBindings
  readonly adapters: readonly PlatformConnectionAdapter[]
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly ledger: AgentQzoneLedger
  readonly allowsText: (text: string) => boolean
}): readonly AgentConsoleService[] {
  const adapters = options.adapters.filter(adapter => adapter.qzone && adapter.account.platform === 'qq' && adapter.account.namespace === 'global')
  if (!adapters.length) return []

  async function authorized(context: AgentConsoleContext) {
    const result = []
    for (const adapter of adapters) {
      if (!adapter.isReady()) continue
      for (const binding of options.bindings.list()) {
        if (binding.connectionId !== adapter.id || platformAccountKey(binding.target.account) !== platformAccountKey(adapter.account)) continue
        const access = await options.auth.authorize(context.principal, 'qzone.publish', binding, context)
        context.ensureCurrent()
        if (access === 'unavailable') throw new AgentConsoleError('unavailable')
        if (access !== 'allowed') continue
        const bindingToken = agentBindingToken(binding)
        result.push({ adapter, binding, bindingToken })
        break
      }
    }
    return result
  }

  async function publish(context: AgentConsoleContext, selected: Awaited<ReturnType<typeof authorized>>[number], text: string, requestId: string) {
    const { adapter, binding, bindingToken } = selected, qq = adapter.account.id, provider = adapter.qzone!
    const signal = context.signal
    const isCurrent = () => {
      const current = options.bindings.resolve(binding.target)
      return !signal.aborted && context.isCurrent() && adapter.isReady() && !!current &&
        agentBindingToken(current) === bindingToken && options.allowsText(text)
    }
    const ensureCurrent = async () => {
      if (!isCurrent() || await options.auth.authorize(context.principal, 'qzone.publish', binding, context) !== 'allowed' || !isCurrent()) {
        throw new AgentConsoleError('forbidden')
      }
    }
    await ensureCurrent()
    const operation = { kind: 'publish', text } as const
    const identity = 'console:' + createHash('sha256').update(JSON.stringify([context.principal.id, requestId])).digest('hex')
    const result = await options.ledger.claim({ binding, identity, operation, now: Date.now(), limits })
    if (result.state !== 'claimed') {
      if (result.state === 'unknown') return uncertain(qq)
      return result.code === 'qzone_already_confirmed' ? { qq, ok: true } : failed(qq, '该次发布未获平台确认。')
    }
    const { claim } = result
    let receipt: AgentQzoneReceipt = { state: 'failed', code: 'qzone_cancelled' }
    try {
      await ensureCurrent()
      if (await options.ledger.isPending(claim) && isCurrent()) {
        receipt = { state: 'unknown' }
        receipt = normalizeAgentQzoneReceipt(await provider.execute({ version: 1, binding, operation }, {
          signal, isCurrent, async ensureCurrent() {
            await ensureCurrent()
            if (!await options.ledger.isPending(claim) || !isCurrent()) throw new AgentConsoleError('conflict')
          },
        }), operation)
      }
    } catch { /* A provider interruption retains the uncertain receipt. */ }
    if (receipt.state === 'confirmed' && receipt.postId) {
      const saved = await options.ledger.settle(claim, 'confirmed', {
        ownPost: { account: adapter.account, agentId: binding.agentId, source: binding, postId: receipt.postId },
      })
      return saved ? { qq, ok: true, tid: receipt.postId } : uncertain(qq)
    }
    const state = receipt.state === 'failed' ? 'failed' : 'unknown'
    const saved = await options.ledger.settle(claim, state)
    return saved && state === 'failed' ? failed(qq, '平台未确认发布。') : uncertain(qq)
  }

  return AGENT_CONSOLE_SERVICES.flatMap<AgentConsoleService>(service => {
    if (service.operation === 'qzone.accounts') return [{ ...service, async handle(_request, context) {
      const bots = (await authorized(context)).map(({ adapter, bindingToken }) => ({
        qq: adapter.account.id, bindingToken,
        nickname: adapter.botName && adapter.botName.length <= 128 && options.allowsText(adapter.botName) ? adapter.botName : adapter.account.id,
      }))
      return { kind: 'json', value: { bots } }
    } } satisfies AgentConsoleService]
    if (service.operation === 'qzone.publish') return [{ ...service, async handle(request, context) {
      let body: Record<string, unknown>, tokens: Record<string, unknown>, text: string
      try {
        body = qzoneData(request.body, ['botIds', 'content', 'requestId', 'bindingTokens'])
        tokens = qzoneData(body.bindingTokens)
        text = prepareAgentQzoneText(body.content, 'publish')
      } catch { throw new AgentConsoleError('invalid_request') }
      const { botIds, requestId } = body
      if (!Array.isArray(botIds) || !botIds.length || botIds.length > 8 ||
          botIds.some(qq => typeof qq !== 'string' || !qqId.test(qq) || typeof tokens[qq] !== 'string') ||
          new Set(botIds).size !== botIds.length || Object.keys(tokens).length !== botIds.length ||
          typeof requestId !== 'string' || !uuid.test(requestId) || !options.allowsText(String(body.content)) || !options.allowsText(text)) {
        throw new AgentConsoleError('invalid_request')
      }
      const available = await authorized(context)
      const results = await Promise.all(botIds.map(async (qq: string) => {
        const selected = available.find(entry => entry.adapter.account.id === qq && entry.bindingToken === tokens[qq])
        if (!selected) return failed(qq, '账号未连接或授权已变更。')
        try { return await publish(context, selected, text, requestId) }
        catch (error) { return error instanceof AgentConsoleError ? failed(qq, '发布授权已变更。') : uncertain(qq) }
      }))
      return { kind: 'json', value: { results } }
    } } satisfies AgentConsoleService]
    return []
  })
}
