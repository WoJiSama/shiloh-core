import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import type { ResolvedAgentDiceConfig } from '../domain/agentDiceCommand.js'
import { isAgentDiceCommand, parseAgentDiceCommands } from '../domain/agentDiceCommand.js'
import { rollDiceExpression, splitDiceRounds } from '../domain/diceExpression.js'
import { secureDiceRandom } from './diceRandom.js'
import { createAgentDiceLedger, type AgentDiceItem, type AgentDiceRecord } from './agentDiceLedger.js'
import { isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

type Ledger = ReturnType<typeof createAgentDiceLedger>
export interface AgentDiceWorkflowContext {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  archive?(input: { readonly eventId: string; readonly text: string; readonly deliveryMessageId: string }): Promise<void>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = () => new Error('骰子请求已失效')
const safeMessageId = (id: unknown): id is string => isPlatformIdentifier(id) && id !== '0'
function terminal(record: AgentDiceRecord, state: 'confirmed' | 'failed' | 'unknown', completed = record.completed): AgentDiceRecord {
  const { items: _items, ...saved } = record
  return { ...saved, state, completed }
}

/** Only this deterministic Core command producer can create result archive events. */
export function createAgentDiceWorkflow(config: ResolvedAgentDiceConfig, ports: {
  readonly ledger: Ledger
  readonly actions: Pick<MessageActionPort, 'send'>
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  allowsText(text: string): boolean
}) {
  return {
    isCandidate: (message: IncomingMessage) => config.enabled && message.conversation.kind === 'group' && isAgentDiceCommand(message.text),
    async handle(message: IncomingMessage, binding: AgentBindingSnapshot, context: AgentDiceWorkflowContext): Promise<boolean> {
      if (!config.enabled || message.conversation.kind !== 'group' || !isAgentDiceCommand(message.text)) return false
      const emit = (outcome: 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string) => {
        try { ports.diagnostics?.emit({ stage: 'runtime', operation: 'dice_command', outcome, code }) } catch { /* Observers do not own commands. */ }
      }
      if (!safeMessageId(message.messageId) || !context.isCurrent()) { emit('cancelled', 'source_unavailable'); return true }
      if (message.quote || message.mentions.length || !message.parts.length || message.parts.some(part => part.kind !== 'text') ||
          message.parts.map(part => part.kind === 'text' ? part.text : '').join('') !== message.text) {
        emit('cancelled', 'unsupported_source_shape'); return true
      }
      const source = { target: binding.target, agentId: binding.agentId, authorId: message.sender.id, messageId: message.messageId }
      const sourceHash = hash([message.messageId, message.sender, message.occurredAt, message.text, message.parts, message.mentions, message.quote ?? null,
        [config.enabled, config.maxDiceCount, config.maxDiceSides, config.maxRounds]])
      const current = () => !context.signal.aborted && context.isCurrent()
      const ensure = async () => { if (!current()) throw invalid(); await context.ensureCurrent(); if (!current()) throw invalid() }
      let saved: Awaited<ReturnType<Ledger['read']>> = undefined, epochs: Awaited<ReturnType<Ledger['capture']>> | undefined
      try {
        epochs = await ports.ledger.capture(source)
        if (epochs.recalled) return true
        await ensure()
        saved = await ports.ledger.read(source)
        if (saved && (saved.record.bindingHash !== ports.ledger.bindingHash(binding) || saved.record.sourceHash !== sourceHash)) {
          await ports.ledger.revokeSource(binding.target, message.messageId!)
          emit('cancelled', 'frozen_authority_changed'); return true
        }
        if (saved && !['ready', 'pending'].includes(saved.record.state)) return true
        if (saved?.record.state === 'pending') {
          await ports.ledger.change(source, saved, terminal(saved.record, 'unknown'), epochs)
          emit('unknown', 'interrupted_delivery'); return true
        }
        if (!saved) {
          let items: readonly AgentDiceItem[]
          try {
            const name = message.senderName || message.sender.id
            if (name.length > 256 || !ports.allowsText(name)) throw invalid()
            let totalLength = 0
            items = parseAgentDiceCommands(message.text).map((raw, index) => {
              const { rounds, expr } = splitDiceRounds(raw)
              if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > config.maxRounds) throw invalid()
              const lines: string[] = []
              for (let round = 0; round < rounds; round++) {
                const result = rollDiceExpression(expr || '1d100', config, secureDiceRandom)
                lines.push(`${name} 掷骰：${result.expr}=${result.detail}=${result.total}`)
                if (lines.reduce((size, line) => size + line.length, 0) > 8_000) throw invalid()
              }
              const text = lines.join('\n')
              totalLength += text.length
              if (text.length > 8_000 || totalLength > 32_000 || !ports.allowsText(text)) throw invalid()
              return Object.freeze({ eventId: hash([message.messageId, 'dice_result', index]), text, result: true })
            })
          } catch {
            const text = '公开骰子命令需要单独发送纯文字 .r/.roll 表达式；请检查表达式、轮数和骰子限制。'
            if (!ports.allowsText(text)) return true
            items = [{ eventId: hash([message.messageId, 'dice_error']), text, result: false }]
          }
          await ensure()
          saved = await ports.ledger.prepare(source, binding, sourceHash, items, epochs)
          if (!saved) return true
        }
        while (saved.record.state === 'ready' && saved.record.completed < saved.record.requested) {
          await ensure()
          const item = saved.record.items![saved.record.completed]!
          if (!ports.allowsText(item.text)) throw invalid()
          const claimed = await ports.ledger.change(source, saved, { ...saved.record, state: 'pending' }, epochs)
          if (!claimed) return true
          saved = claimed
          await ensure()
          let receipt: Awaited<ReturnType<MessageActionPort['send']>>
          try {
            receipt = await ports.actions.send({ version: 1, kind: 'message.send', target: binding.target, binding,
              replyTo: message.messageId, parts: [{ kind: 'text', text: item.text }] }, { isCurrent: current, ensureCurrent: ensure })
          } catch { receipt = { state: 'unknown' } }
          if (receipt.state !== 'sent' || !safeMessageId(receipt.messageId)) {
            const state = receipt.state === 'failed' ? 'failed' : 'unknown'
            await ports.ledger.change(source, saved, terminal(saved.record, state), epochs)
            emit(state, 'delivery_' + state); return true
          }
          const completed = saved.record.completed + 1
          if (item.result && context.archive) {
            try { await ensure(); await context.archive({ eventId: item.eventId, text: item.text, deliveryMessageId: receipt.messageId }); await ensure() }
            catch {
              await ports.ledger.change(source, saved, terminal(saved.record, 'unknown', completed), epochs)
              emit('unknown', 'archive_unconfirmed'); return true
            }
          }
          const next = completed === saved.record.requested ? terminal(saved.record, 'confirmed', completed) :
            { ...saved.record, state: 'ready' as const, completed, items: saved.record.items!.map((value, index) => index < completed ? { ...value, text: '' } : value) }
          const advanced = await ports.ledger.change(source, saved, next, epochs)
          if (!advanced) { emit('unknown', 'settlement_unconfirmed'); return true }
          saved = advanced
        }
        emit('succeeded', 'command_confirmed')
      } catch {
        if (!saved) try { await ports.ledger.revokeSource(binding.target, message.messageId!) } catch { /* A source read cannot authorize a replay. */ }
        if (saved && epochs) try { await ports.ledger.change(source, saved, terminal(saved.record, saved.record.state === 'pending' ? 'unknown' : 'failed'), epochs) } catch { /* Pending remains a terminal fence on recovery. */ }
        emit(current() ? 'unknown' : 'cancelled', current() ? 'storage_or_source_unconfirmed' : 'source_unavailable')
      }
      return true
    },
  }
}
