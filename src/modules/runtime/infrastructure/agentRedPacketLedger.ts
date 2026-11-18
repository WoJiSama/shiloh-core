import { randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { AgentRedPacketPhase, AgentRedPacketResult, AgentRedPacketSnapshot, AgentRedPacketStorage } from '../../../contracts/agentQqRedPacket.js'
import { conversationAddressKey, platformAccountKey } from '../domain/agentBindings.js'
import { redPacketAccount, redPacketBinding, redPacketData, redPacketError, redPacketHash, redPacketText, validateAgentRedPacketSnapshot } from './agentRedPacketValidation.js'

export const AGENT_RED_PACKET_RETENTION_SECONDS = 7 * 86_400
const prefix = 'agent:red-packet:v1:'
const typeCheck = `local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='string' then return redis.error_reply('invalid red packet key') end\n`
const claimScript = typeCheck + `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return '' end return redis.call('GET',KEYS[1])`
const compareScript = typeCheck + `if redis.call('GET',KEYS[1])==ARGV[1] then return 1 end return 0`
const settleScript = typeCheck + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`
const cooldownScript = typeCheck + `if redis.call('SET',KEYS[1],'1','NX','PX','60000') then return 1 end return 0`

export interface AgentRedPacketRecord {
  readonly version: 1
  readonly tokenHash: string
  readonly bindingHash: string
  readonly sourceHash: string
  readonly state: 'active' | 'confirmed' | 'failed' | 'unknown' | 'cancelled'
  readonly phase: AgentRedPacketPhase
  readonly passwordConfirmed: boolean
  readonly grabbed: boolean
  readonly passwordMessageId?: string
  readonly amountFen?: number
}
function parse(input: unknown): AgentRedPacketRecord {
  const row = redPacketData(input, ['version', 'tokenHash', 'bindingHash', 'sourceHash', 'state', 'phase', 'passwordConfirmed', 'grabbed', 'passwordMessageId', 'amountFen'])
  if (row.version !== 1 || ![row.tokenHash, row.bindingHash, row.sourceHash].every(value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value)) ||
      !['active', 'confirmed', 'failed', 'unknown', 'cancelled'].includes(row.state as string) ||
      !['claimed', 'password_pending', 'password_confirmed', 'grab_pending', 'finished'].includes(row.phase as string) ||
      typeof row.passwordConfirmed !== 'boolean' || typeof row.grabbed !== 'boolean' ||
      row.passwordConfirmed !== (row.passwordMessageId !== undefined) ||
      row.grabbed !== (row.amountFen !== undefined) || row.amountFen !== undefined && (!Number.isSafeInteger(row.amountFen) || Number(row.amountFen) < 1) ||
      row.state === 'confirmed' && (!row.grabbed || row.phase !== 'finished') || row.grabbed && row.state !== 'confirmed') throw redPacketError()
  if (row.passwordMessageId !== undefined) redPacketText(row.passwordMessageId)
  if ((row.phase === 'claimed' || row.phase === 'password_pending') && row.passwordConfirmed || row.phase === 'password_confirmed' && !row.passwordConfirmed ||
      row.phase === 'finished' && row.state !== 'confirmed' || row.phase !== 'finished' && row.grabbed) throw redPacketError()
  return Object.freeze(row as unknown as AgentRedPacketRecord)
}
function packetKey(account: PlatformAccountRef, identity: string): string {
  if (!/^[a-f\d]{64}$/u.test(identity)) throw redPacketError()
  return prefix + redPacketHash(JSON.stringify([platformAccountKey(redPacketAccount(account)), identity]))
}

export interface AgentRedPacketSession {
  readonly record: AgentRedPacketRecord
  isCurrent(): Promise<boolean>
  begin(phase: 'password_pending' | 'grab_pending'): Promise<void>
  confirmPassword(messageId: string): Promise<void>
  finish(result: AgentRedPacketResult): Promise<void>
}
export type AgentRedPacketClaim = { readonly state: 'claimed'; readonly session: AgentRedPacketSession } |
  { readonly state: 'duplicate'; readonly record: AgentRedPacketRecord }

/** Seven-day packet claim is scoped to the receiving robot, not the command or binding revision.
 * All active records (including a confirmed password) are frozen on replay; no automatic resume. */
export function createAgentRedPacketLedger(storage: AgentRedPacketStorage) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.eval !== 'function') throw redPacketError()
  return {
    async claim(binding: AgentBindingSnapshot, packet: AgentRedPacketSnapshot): Promise<AgentRedPacketClaim> {
      const selected = redPacketBinding(binding), safe = validateAgentRedPacketSnapshot(packet)
      if (conversationAddressKey(selected.target) !== conversationAddressKey(safe.target)) throw redPacketError()
      const key = packetKey(selected.target.account, safe.packetIdentity)
      let record: AgentRedPacketRecord = Object.freeze({ version: 1, tokenHash: redPacketHash(randomUUID()), bindingHash: redPacketHash(JSON.stringify(selected)),
        sourceHash: redPacketHash(JSON.stringify(safe.source)), state: 'active', phase: 'claimed', passwordConfirmed: false, grabbed: false })
      let serialized = JSON.stringify(record), frozen = false
      const previous = await storage.eval(claimScript, { keys: [key], arguments: [serialized, String(AGENT_RED_PACKET_RETENTION_SECONDS)] })
      if (previous !== '') {
        if (typeof previous !== 'string' || previous.length > 2048) throw redPacketError()
        return { state: 'duplicate', record: parse(JSON.parse(previous)) }
      }
      const write = async (next: AgentRedPacketRecord) => {
        if (frozen || record.state !== 'active') throw redPacketError()
        const safe = parse(next), value = JSON.stringify(safe)
        try {
          if (Number(await storage.eval(settleScript, { keys: [key], arguments: [serialized, value] })) !== 1) throw redPacketError()
          record = safe; serialized = value
        } catch { frozen = true; throw redPacketError() }
      }
      const session: AgentRedPacketSession = {
        get record() { return record },
        async isCurrent() {
          if (frozen || record.state !== 'active') return false
          try { return Number(await storage.eval(compareScript, { keys: [key], arguments: [serialized] })) === 1 }
          catch { frozen = true; return false }
        },
        async begin(phase) {
          if (phase === 'password_pending' ? record.phase !== 'claimed' : phase !== 'grab_pending' || !['claimed', 'password_confirmed'].includes(record.phase)) throw redPacketError()
          await write({ ...record, phase })
        },
        async confirmPassword(messageId) {
          if (record.phase !== 'password_pending' || messageId === '0') throw redPacketError()
          await write({ ...record, phase: 'password_confirmed', passwordConfirmed: true, passwordMessageId: redPacketText(messageId) })
        },
        async finish(result) {
          if (result.state === 'skipped' || !['confirmed', 'failed', 'unknown', 'cancelled'].includes(result.state) || result.passwordConfirmed !== record.passwordConfirmed) throw redPacketError()
          if (result.state === 'confirmed') {
            if (record.phase !== 'grab_pending' || result.grabbed !== true || !Number.isSafeInteger(result.amountFen) || Number(result.amountFen) < 1) throw redPacketError()
            await write({ ...record, state: 'confirmed', phase: 'finished', grabbed: true, amountFen: result.amountFen as number })
          } else await write({ ...record, state: result.state, grabbed: false })
        },
      }
      return { state: 'claimed', session }
    },
    async inspect(account: PlatformAccountRef, packetIdentity: string): Promise<AgentRedPacketRecord | undefined> {
      const value = await storage.get(packetKey(account, packetIdentity))
      if (value === null) return undefined
      if (value.length > 2048) throw redPacketError()
      return parse(JSON.parse(value))
    },
    async claimAutomaticCooldown(binding: AgentBindingSnapshot): Promise<boolean> {
      const selected = redPacketBinding(binding)
      const key = prefix + 'cooldown:' + redPacketHash(JSON.stringify([platformAccountKey(selected.target.account), selected.target.id]))
      return Number(await storage.eval(cooldownScript, { keys: [key], arguments: [] })) === 1
    },
  }
}
