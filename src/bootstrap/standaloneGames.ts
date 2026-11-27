import path from 'node:path'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import type { AgentGroupGameContext, AgentGroupGameHandler, AgentGroupGameSendGuard } from '../contracts/agentGames.js'
import type { ChatRequestData, ChatResponse } from '../contracts/modelGateway.js'
import type { ExecutionConfig, ExecutionOptions } from '../contracts/modelExecution.js'
import type { IncomingMessage } from '../contracts/platformMessage.js'
import type { TurtleSoupLogger } from '../contracts/turtleSoup.js'
import { createAgentTurtleSoup } from '../modules/games/infrastructure/agentTurtleSoup.js'
import type { AgentTurtleSoupOptions } from '../modules/games/infrastructure/agentTurtleSoup.js'
import { createAgentUmaRaceHandler } from '../modules/games/infrastructure/agentUmaRace.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import type { StandaloneGamesConfig } from './standaloneGamesConfig.js'

export interface StandaloneGroupGamesOptions {
  readonly config: StandaloneGamesConfig
  /** Host data root, not an adapter-selected or legacy working directory. */
  readonly dataDir: string
  readonly execution: ExecutionConfig
  readonly executionSignal: AbortSignal
  readonly isCurrent: () => boolean
  /** Host secrets and forbidden words, for both model input and output. */
  readonly allowsText: (text: string) => boolean
  readonly execute: (request: ChatRequestData, execution: ExecutionConfig, options: ExecutionOptions) => Promise<ChatResponse | undefined>
  /** Raw ledger port: this factory records both global/api and the complete conversation scope. */
  readonly recordTokens?: (input: { scope: string; stage: string; model?: string; usage?: unknown; ms?: number }) => void
  readonly authorizeBackground?: (origin: { source: IncomingMessage; binding: AgentBindingSnapshot }, game: AgentGroupGameHandler['id']) => Promise<AgentGroupGameContext | undefined>
  readonly logger?: TurtleSoupLogger
}

const failed = () => new Error('海龟汤模型请求未完成')
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(failed()) }
    signal.addEventListener('abort', aborted, { once: true })
    work.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, error => { signal.removeEventListener('abort', aborted); reject(error) })
    if (signal.aborted) aborted()
  })
}

/** Fixed main-chat provider; game configuration may select only its model name. */
export function createStandaloneTurtleSoupModel(options: StandaloneGroupGamesOptions): AgentTurtleSoupOptions['callModel'] {
  const main = { ...options.execution, chatAiConfig: { ...options.execution.chatAiConfig } }
  return async (messages, modelOptions, context) => {
    const signal = AbortSignal.any([options.executionSignal, context.signal, AbortSignal.timeout(45_000), ...(modelOptions.signal ? [modelOptions.signal] : [])])
    const isCurrent = () => {
      try { return !signal.aborted && options.isCurrent() && context.isCurrent() } catch { return false }
    }
    const ensureCurrent = async () => {
      if (!isCurrent()) throw failed()
      await abortable(context.ensureCurrent(), signal)
      if (!isCurrent()) throw failed()
    }
    try {
      await ensureCurrent()
      const model = modelOptions.model?.trim() || main.chatAiConfig.chatApiModel
      if (!model || !options.allowsText(JSON.stringify({ messages, model }))) throw failed()
      const execution: ExecutionConfig = { ...main, useTools: false, chatAiConfig: { ...main.chatAiConfig, chatApiModel: model } }
      const started = Date.now()
      // The executor repeats ensureCurrent immediately before every actual provider dispatch,
      // including compatibility retries, rather than trusting this initial admission check.
      const response = await abortable(Promise.resolve().then(async () => {
        await ensureCurrent()
        return options.execute({ messages, temperature: modelOptions.temperature ?? 0.7, top_p: 0.9 }, execution,
          { signal, isCurrent, ensureCurrent, forceChatBackend: true, routeLabel: '海龟汤' })
      }), signal)
      if (response) {
        const actual = typeof response.model === 'string' && response.model.length <= 256 && options.allowsText(response.model) ? response.model : model
        const usage = { model: actual, usage: response.usage, ms: Date.now() - started }
        options.recordTokens?.({ ...usage, scope: 'global', stage: 'api' })
        options.recordTokens?.({ ...usage, scope: simulationAddressKey(context.binding.target), stage: 'turtle-soup' })
      }
      await ensureCurrent()
      const message = response?.choices?.[0]?.message, content = message?.content
      if (!response || response.error || message?.tool_calls?.length || typeof content !== 'string' || !content.trim() || !options.allowsText(content)) throw failed()
      return content
    } catch {
      // Provider failures may contain credentials, prompts and upstream response bodies.
      throw failed()
    }
  }
}

export function createStandaloneGroupGames(options: StandaloneGroupGamesOptions): AgentGroupGameHandler[] {
  if (!path.isAbsolute(options.dataDir)) throw new Error('游戏需要宿主持有的绝对数据根目录')
  const dataDir = path.join(options.dataDir, 'games'), operators = new Set(options.config.operatorIds)
  const isCurrent = () => {
    try { return !options.executionSignal.aborted && options.isCurrent() } catch { return false }
  }
  function guarded(context: AgentGroupGameContext): AgentGroupGameContext {
    const signal = AbortSignal.any([options.executionSignal, context.signal])
    const current = () => !signal.aborted && isCurrent() && context.isCurrent()
    const ensureCurrent = async () => {
      if (!current()) throw new Error('游戏宿主授权已失效')
      await abortable(context.ensureCurrent(), signal)
      if (!current()) throw new Error('游戏宿主授权已失效')
    }
    const guardFor = (guard?: AgentGroupGameSendGuard): AgentGroupGameSendGuard => ({
      signal: guard?.signal ? AbortSignal.any([signal, guard.signal]) : signal,
      isCurrent: () => current() && (!guard || guard.isCurrent()),
      ensureCurrent: async () => { await ensureCurrent(); await guard?.ensureCurrent(); await ensureCurrent() },
    })
    return { ...context, signal, isCurrent: current, ensureCurrent,
      sendText: async (text, guard) => { const selected = guardFor(guard); await selected.ensureCurrent(); await context.sendText(text, selected) },
      sendImage: async (image, guard) => { const selected = guardFor(guard); await selected.ensureCurrent(); await context.sendImage(image, selected) },
      sendPrivate: async (userId, text, guard) => { const selected = guardFor(guard); await selected.ensureCurrent(); await context.sendPrivate(userId, text, selected) },
    }
  }
  const authorizeBackground: NonNullable<StandaloneGroupGamesOptions['authorizeBackground']> = async (origin, game) => {
    if (!isCurrent()) return undefined
    const context = await options.authorizeBackground?.(origin, game)
    if (!context || !isCurrent()) return undefined
    const selected = guarded(context)
    await selected.ensureCurrent()
    return selected
  }
  const handlers: AgentGroupGameHandler[] = []
  if (options.config.turtleSoup?.enabled) {
    const config = options.config.turtleSoup
    handlers.push(createAgentTurtleSoup({ dataDir, config: () => config, callModel: createStandaloneTurtleSoupModel(options),
      authorizeBackground: origin => authorizeBackground(origin, 'turtle-soup'),
      ...(options.logger ? { logger: options.logger } : {}) }))
  }
  if (options.config.umaRace?.enabled) {
    handlers.push(createAgentUmaRaceHandler({ dataDir, config: options.config.umaRace,
      authorizeBackground: origin => authorizeBackground(origin, 'uma-race'),
      canAdjustPoints: context => context.source.sender.platform === 'qq' && context.source.sender.namespace === 'global' &&
        context.binding.target.account.platform === 'qq' && context.binding.target.account.namespace === 'global' &&
        context.member.id === context.source.sender.id && operators.has(context.source.sender.id),
      ...(options.logger ? { logger: options.logger } : {}) }))
  }
  return handlers.map(handler => {
    let stopped = false
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => {
      if (stopping) return stopping
      stopped = true
      options.executionSignal.removeEventListener('abort', onAbort)
      try { stopping = Promise.resolve(handler.stop()) } catch (error) { stopping = Promise.reject(error) }
      return stopping
    }
    const onAbort = () => { void stop().catch(() => options.logger?.warn?.('[游戏] 停止未完成')) }
    options.executionSignal.addEventListener('abort', onAbort, { once: true })
    if (options.executionSignal.aborted) onAbort()
    return { id: handler.id,
      isCandidate: (source, binding) => !stopped && isCurrent() && handler.isCandidate(source, binding),
      ...(handler.isActive ? { isActive: (binding: AgentBindingSnapshot) => !stopped && isCurrent() && handler.isActive!(binding) } : {}),
      handle: async context => !stopped && isCurrent() ? handler.handle(guarded(context)) : false,
      stop,
    }
  })
}
