import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { AgentGroupGameContext, AgentGroupGameHandler, AgentGroupGameSendGuard } from '../../../contracts/agentGames.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import type { ChatMessage } from '../../../contracts/modelGateway.js'
import type { TurtleSoupConfig, TurtleSoupEvent, TurtleSoupLogger } from '../../../contracts/turtleSoup.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount } from '../../runtime/domain/agentBindings.js'
import { writeAtomicJson } from './gameFiles.js'
import { TurtleSoupManager } from './turtleSoup/TurtleSoupManager.js'
import { TurtleSoupGenerator, type TurtleSoupModelCallOptions } from './turtleSoup/TurtleSoupGenerator.js'
import { createTurtleSoupModelHost } from './turtleSoup/TurtleSoupModelHost.js'
import { TurtleSoupStore, type TurtleSoupStoreGuard } from './turtleSoup/TurtleSoupStore.js'

export interface AgentTurtleSoupOrigin {
  readonly source: IncomingMessage
  readonly binding: AgentBindingSnapshot
}
export interface AgentTurtleSoupOptions {
  /** Games root owned by this standalone host; legacy cwd/config is never consulted. */
  readonly dataDir: string
  readonly config: () => TurtleSoupConfig
  readonly callModel: (messages: ChatMessage[], options: TurtleSoupModelCallOptions, context: AgentGroupGameContext) => Promise<string>
  readonly authorizeBackground?: (origin: AgentTurtleSoupOrigin) => Promise<AgentGroupGameContext | undefined>
  readonly logger?: TurtleSoupLogger
  readonly now?: () => number
  readonly sweepIntervalMs?: number
}
export interface AgentTurtleSoup extends AgentGroupGameHandler {
  /** Also used by deterministic deadline/restart acceptance; actual timers use the same path. */
  sweep(): Promise<void>
}
interface Authority { readonly context: AgentGroupGameContext; readonly signal: AbortSignal; active: boolean; deliveryBlocked:boolean }
interface Runtime {
  readonly manager: TurtleSoupManager
  readonly directory: string
  readonly origins: Record<string, AgentTurtleSoupOrigin>
  readonly privateAttempts: Record<string, 'pending' | 'sent'>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function scopeRoot(dataDir: string, account: PlatformAccountRef, agentId: string): string {
  if (!path.isAbsolute(dataDir) || !isPlatformAccount(account) || !agentId || agentId.length > 128) throw new Error('海龟汤存储归属无效')
  return path.join(dataDir, hash(JSON.stringify([account.platform, account.namespace, account.id, agentId])))
}
export function agentTurtleSoupDirectory(dataDir: string, account: PlatformAccountRef, agentId: string): string {
  return path.join(scopeRoot(dataDir, account, agentId), 'turtle-soup')
}
function readMap<T>(filename: string): Record<string, T> {
  let bytes: Buffer
  try { bytes = fs.readFileSync(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  if (bytes.length > 2 * 1024 * 1024) throw new Error('海龟汤来源记录超过上限')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 4096) throw new Error('海龟汤来源记录无效')
  return value as Record<string, T>
}
function validOrigin(origin: AgentTurtleSoupOrigin): boolean {
  try {
    return !!origin && isConversationAddress(origin.binding.target) && origin.binding.target.kind === 'group' &&
      isConversationAddress(origin.source.conversation) && origin.source.conversation.kind === 'group' &&
      conversationAddressKey(origin.binding.target) === conversationAddressKey(origin.source.conversation) &&
      typeof origin.source.messageId === 'string' && !!origin.source.messageId && typeof origin.source.text === 'string' &&
      Number.isSafeInteger(origin.source.occurredAt) && origin.source.occurredAt > 0 && !!origin.source.sender?.id &&
      origin.source.sender.platform === origin.source.conversation.account.platform &&
      origin.source.sender.namespace === origin.source.conversation.account.namespace
  } catch { return false }
}
const commands = [
  [/^[.。]游戏\s*(?:帮助|help)?\s*$/u, 'hub'],
  [/^[.。]游戏\s+海龟汤\s*(?:帮助|help|玩法)?\s*$/u, 'help'],
  [/^[.。]游戏\s+海龟汤\s*(?:开局|开一局)\s*$/u, 'openGame'],
  [/^[.。]游戏\s+海龟汤\s*(?:加入|报名|参加)\s*$/u, 'joinGame'],
  [/^[.。]游戏\s+海龟汤\s*(?:开始|出题)\s*$/u, 'startGame'],
  [/^[.。]游戏\s+海龟汤\s*选\s*(?:随机|1|2|3|一|二|三)?\s*$/u, 'choosePuzzle'],
  [/^[.。]游戏\s+海龟汤\s*(?:取消|取消报名|取消开局)\s*$/u, 'cancelGame'],
  [/^[.。]游戏\s+海龟汤\s*(?:猜|猜汤底|答案)[\s\S]+$/u, 'guessSoup'],
  [/^[.。]游戏\s+海龟汤\s*(?:提示|线索)\s*$/u, 'useHint'],
  [/^[.。]游戏\s+海龟汤\s*(?:投降|认输)\s*$/u, 'surrender'],
  [/^[.。]游戏\s+海龟汤\s*换汤(?:\s+[\s\S]*)?\s*$/u, 'switchPuzzle'],
  [/^[.。]游戏\s+海龟汤\s*(?:排行|榜单|汤榜)\s*$/u, 'rankings'],
  [/^[.。]游戏\s+海龟汤\s*(?:状态|进度)\s*$/u, 'showStatus'],
  [/^[.。]游戏\s+海龟汤\s*(?:结束|终止|收局)\s*$/u, 'endGame'],
  [/^[.。]游戏\s+海龟汤\s*评分\s+(?:(?:上一局|pl_[\w-]+)\s+)?[1-5](?:\s+[\s\S]*)?\s*$/u, 'rateGame'],
  [/^[.。]游戏\s+海龟汤\s*(?:库存|题库)\s*$/u, 'inventory'],
  [/^[.。]游戏\s+海龟汤\s*生成(?:\s+\d+)?\s*$/u, 'generateMore'],
  [/^[.。]游戏\s+海龟汤\s*待审\s*$/u, 'listPending'],
  [/^[.。]游戏\s+海龟汤\s*过审\s+\S+\s*$/u, 'approve'],
  [/^[.。]游戏\s+海龟汤\s*淘汰\s+\S+\s*$/u, 'reject'],
] as const
const commandFor = (text: string) => commands.find(([pattern]) => pattern.test(text))?.[1]

export function createAgentTurtleSoup(options: AgentTurtleSoupOptions): AgentTurtleSoup {
  if (!path.isAbsolute(options.dataDir)) throw new Error('海龟汤需要独立绝对数据目录')
  const authorities = new AsyncLocalStorage<Authority>()
  const runtimes = new Map<string, Runtime>()
  const pending = new Set<Promise<unknown>>()
  const stopped = new AbortController()
  let running = true, sweeping = false
  function authority(): Authority {
    const selected = authorities.getStore()
    if (!running || !selected?.active || selected.deliveryBlocked || selected.signal.aborted || !options.config().enabled || !selected.context.isCurrent()) throw new Error('海龟汤操作权限已失效')
    return selected
  }
  const guard: TurtleSoupStoreGuard = {
    async ensureCurrent() {
      const selected = authority()
      await selected.context.ensureCurrent()
      if (authority() !== selected) throw new Error('海龟汤操作权限已失效')
    },
    isCurrent() { try { authority(); return true } catch { return false } },
  }
  async function withAuthority<T>(context: AgentGroupGameContext, action: () => Promise<T>): Promise<T> {
    if (!validOrigin(context) || context.member.id !== context.source.sender.id) throw new Error('海龟汤来源归属无效')
    const selected: Authority = { context, signal: AbortSignal.any([context.signal, stopped.signal]), active: true, deliveryBlocked:false }
    return authorities.run(selected, async () => {
      try {
        await guard.ensureCurrent()
        const result = await action()
        await guard.ensureCurrent()
        return result
      } finally { selected.active = false }
    })
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  async function runBackground(runtime: Runtime, groupId: string, action: () => Promise<void>, triggeredBy?:AgentTurtleSoupOrigin) {
    const origin = triggeredBy ?? runtime.origins[groupId]
    if (!origin || !options.authorizeBackground || !running) return
    // Release the original command so the Core can settle its persistent attempt first.
    await delay(0, undefined, { signal: stopped.signal })
    const context = await options.authorizeBackground(structuredClone(origin))
    if (!context || !running || conversationAddressKey(context.binding.target) !== groupId ||
      agentBindingToken(context.binding) !== agentBindingToken(origin.binding) ||
      context.source.messageId !== origin.source.messageId || context.source.occurredAt !== origin.source.occurredAt ||
      context.source.sender.id !== origin.source.sender.id || context.source.text !== origin.source.text) return
    await withAuthority(context, action)
  }
  function runtimeFor(binding: AgentBindingSnapshot): Runtime {
    const root = scopeRoot(options.dataDir, binding.target.account, binding.agentId)
    const cached = runtimes.get(root)
    if (cached) return cached
    const directory = agentTurtleSoupDirectory(options.dataDir, binding.target.account, binding.agentId)
    const origins = readMap<AgentTurtleSoupOrigin>(path.join(directory, 'deadline-origins.json'))
    for (const [key, origin] of Object.entries(origins)) {
      if (!validOrigin(origin) || conversationAddressKey(origin.binding.target) !== key ||
        scopeRoot(options.dataDir, origin.binding.target.account, origin.binding.agentId) !== root) throw new Error('海龟汤恢复来源归属无效')
    }
    const privateAttempts = readMap<'pending' | 'sent'>(path.join(directory, 'private-attempts.json'))
    if (Object.values(privateAttempts).some(value => value !== 'pending' && value !== 'sent')) throw new Error('海龟汤私发回执无效')
    const config = () => ({ ...options.config(), baseDir: directory })
    const store = new TurtleSoupStore({ cwd: root, baseDir: directory, guard })
    const callModel = async (messages: ChatMessage[], modelOptions: TurtleSoupModelCallOptions = {}) => {
      await guard.ensureCurrent()
      const selected = authority(), signal = AbortSignal.any([selected.signal, ...(modelOptions.signal ? [modelOptions.signal] : [])])
      const content = await Promise.race([
        options.callModel(messages, { ...modelOptions, signal }, selected.context),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      ])
      await guard.ensureCurrent()
      if (signal.aborted) throw signal.reason
      return content
    }
    const generator = new TurtleSoupGenerator({ store, config, callModel, ...(options.logger ? { logger: options.logger } : {}), ...(options.now ? { now: options.now } : {}) })
    let runtime: Runtime
    const manager:TurtleSoupManager = new TurtleSoupManager({
      cwd: root, config, store, guard, generator, host: createTurtleSoupModelHost({ callModel, ...(options.logger ? { logger: options.logger } : {}) }),
      ...(options.logger ? { logger: options.logger } : {}), ...(options.now ? { now: options.now } : {}),
      async sendSmartReply(_event, message) { await sendText(String(message)) },
      async replyGroup(groupId, message) {
        if (conversationAddressKey(authority().context.binding.target) !== groupId) throw new Error('海龟汤播报会话不符')
        await sendText(message)
      },
      async sendPrivate(userId, message, groupId) {
        await guard.ensureCurrent()
        const selected = authority(), context = selected.context
        if (context.member.id !== userId || conversationAddressKey(context.binding.target) !== groupId) throw new Error('海龟汤仅向当前群内投降者私发')
        const session = manager.getSession(groupId)
        if (!session?.sessionId) throw new Error('海龟汤对局已失效')
        const key = hash(JSON.stringify([groupId, session.sessionId, userId]))
        if (runtime.privateAttempts[key]) throw new Error('海龟汤私发已尝试，请核对原结果')
        if (Object.keys(runtime.privateAttempts).length >= 4096) throw new Error('海龟汤私发回执已满')
        runtime.privateAttempts[key] = 'pending'
        writeAtomicJson(path.join(directory, 'private-attempts.json'), runtime.privateAttempts)
        await guard.ensureCurrent()
        try { await context.sendPrivate(userId, message, deliveryGuard(selected)) }
        catch (error) { selected.deliveryBlocked = true; throw error }
        await guard.ensureCurrent()
        runtime.privateAttempts[key] = 'sent'
        writeAtomicJson(path.join(directory, 'private-attempts.json'), runtime.privateAttempts)
      },
      runBackground(task, groupId) {
        const context = authority().context
        return track(runBackground(runtime, groupId, task, structuredClone({source:context.source,binding:context.binding})))
      },
    })
    runtime = { manager, directory, origins, privateAttempts }
    runtimes.set(root, runtime)
    return runtime
  }
  function deliveryGuard(selected:Authority):AgentGroupGameSendGuard {
    const context = selected.context, groupId = conversationAddressKey(context.binding.target)
    const manager = runtimeFor(context.binding).manager
    const state = () => { const room = manager.getSession(groupId); return JSON.stringify(room && [room.sessionId, room.revision ?? 0, room.phase, room.playId]) }
    const original = state()
    const isCurrent = () => running && selected.active && !selected.deliveryBlocked && !selected.signal.aborted && options.config().enabled && context.isCurrent() && state() === original
    return { signal:selected.signal, isCurrent, async ensureCurrent() { if (!isCurrent()) throw new Error('海龟汤投递已失效'); await context.ensureCurrent(); if (!isCurrent()) throw new Error('海龟汤投递已失效') } }
  }
  async function sendText(text: string) {
    await guard.ensureCurrent()
    const selected = authority()
    try { await selected.context.sendText(text, deliveryGuard(selected)) }
    catch (error) { selected.deliveryBlocked = true; throw error }
    await guard.ensureCurrent()
  }
  function matches(source: IncomingMessage, binding: AgentBindingSnapshot) {
    return running && options.config().enabled && validOrigin({ source, binding })
  }
  function privateAttempt(runtime: Runtime, groupId: string, userId: string): boolean {
    const session = runtime.manager.getSession(groupId)
    return !!session?.sessionId && !!runtime.privateAttempts[hash(JSON.stringify([groupId, session.sessionId, userId]))]
  }
  async function sweep() {
    if (!running || sweeping || !options.config().enabled || !options.authorizeBackground) return
    sweeping = true
    try {
      for (const runtime of runtimes.values()) for (const [groupId, origin] of Object.entries(runtime.origins)) {
        if (!runtime.manager.getSession(groupId) || !validOrigin(origin)) continue
        await runBackground(runtime, groupId, () => runtime.manager.sweep(groupId))
      }
    } finally { sweeping = false }
  }
  // Only locally persisted, canonical origins can re-open a deadline authority after restart.
  if (fs.existsSync(options.dataDir)) for (const entry of fs.readdirSync(options.dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue
    const origins = readMap<AgentTurtleSoupOrigin>(path.join(options.dataDir, entry.name, 'turtle-soup/deadline-origins.json'))
    for (const origin of Object.values(origins)) {
      if (!validOrigin(origin) || path.basename(scopeRoot(options.dataDir, origin.binding.target.account, origin.binding.agentId)) !== entry.name) throw new Error('海龟汤恢复分区无效')
      runtimeFor(origin.binding)
    }
  }
  const timer = setInterval(() => {
    void track(sweep()).catch(() => options.logger?.warn?.('海龟汤定时检查未完成'))
  }, Math.max(10, options.sweepIntervalMs ?? 30_000))
  timer.unref?.()
  return Object.freeze({
    id: 'turtle-soup' as const,
    isActive(binding:AgentBindingSnapshot) {
      if (!running || !options.config().enabled || binding.target.kind !== 'group') return false
      const session = runtimeFor(binding).manager.getSession(conversationAddressKey(binding.target))
      return session?.phase === 'joining' || session?.phase === 'choosing' || session?.phase === 'playing'
    },
    isCandidate(source:IncomingMessage, binding:AgentBindingSnapshot) {
      if (!matches(source, binding)) return false
      if (commandFor(source.text)) return true
      const session = runtimeFor(binding).manager.getSession(conversationAddressKey(binding.target))
      return session?.phase === 'playing' && !/^[.。]/u.test(source.text)
    },
    async handle(context:AgentGroupGameContext) {
      if (!matches(context.source, context.binding)) return false
      return withAuthority(context, async () => {
        const runtime = runtimeFor(context.binding), manager = runtime.manager
        const groupId = conversationAddressKey(context.binding.target), command = commandFor(context.source.text)
        const session = manager.getSession(groupId)
        if (!command && session?.phase !== 'playing') return false
        const event: TurtleSoupEvent = { group_id: groupId, user_id: context.member.id, msg: context.source.text,
          sender: { user_id: context.member.id, card: context.member.name, role: context.member.role } }
        if (command === 'openGame' && (!session || session.phase === 'reveal')) {
          if (!Object.hasOwn(runtime.origins, groupId) && Object.keys(runtime.origins).length >= 4096) throw new Error('海龟汤场景来源已满')
          await guard.ensureCurrent()
          runtime.origins[groupId] = structuredClone({ source: context.source, binding: context.binding })
          writeAtomicJson(path.join(runtime.directory, 'deadline-origins.json'), runtime.origins)
        }
        if (command === 'surrender' && privateAttempt(runtime, groupId, context.member.id)) {
          await sendText('本局汤底私发已尝试，请核对私聊结果；结果未确认时不重复发送。')
          return true
        }
        let output: string | undefined
        if (command === 'hub') output = manager.showHub()
        else if (command === 'help') output = manager.showHelp()
        else if (command === 'rankings') output = manager.rankings()
        else if (command === 'approve' || command === 'reject') output = await manager.reviewPuzzle(event, command === 'approve' ? 'approve' : 'reject')
        else if (command) output = await manager[command](event)
        else {
          const answer = await manager.handleChat(event)
          if (answer) output = [answer.reply, answer.recap].filter(Boolean).join('\n')
        }
        await guard.ensureCurrent()
        if (output) await sendText(output)
        return true
      })
    },
    sweep,
    async stop() {
      if (!running) return
      running = false
      stopped.abort(new Error('海龟汤已停止'))
      clearInterval(timer)
      for (const runtime of runtimes.values()) runtime.manager.stop()
      await Promise.allSettled([...pending])
    },
  })
}
