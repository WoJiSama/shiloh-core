import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentRedPacketRequest, AgentRedPacketSnapshot } from '../../../contracts/agentQqRedPacket.js'
import { isPlatformIdentifier, samePlatformNamespace } from '../domain/agentBindings.js'

export const redPacketError = () => new Error('Red packet operation unavailable')
export const redPacketHash = (value: string): string => createHash('sha256').update(value).digest('hex')
export function redPacketData(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw redPacketError()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw redPacketError()
    result[key] = field.value
  }
  return result
}
export function redPacketText(input: unknown, maximum = 128): string {
  if (typeof input !== 'string' || !input || input.length > maximum || input !== input.trim() ||
      /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input)) throw redPacketError()
  return input
}
export function redPacketArray(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum ||
      Reflect.ownKeys(input).length !== input.length + 1) throw redPacketError()
  return Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw redPacketError()
    return field.value
  })
}
export function redPacketAccount(input: unknown): Readonly<PlatformAccountRef> {
  const row = redPacketData(input, ['platform', 'namespace', 'id'])
  const platform = redPacketText(row.platform, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(platform)) throw redPacketError()
  return Object.freeze({ platform, namespace: redPacketText(row.namespace), id: redPacketText(row.id) })
}
export function redPacketTarget(input: unknown): Readonly<ConversationAddress> {
  const row = redPacketData(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group') throw redPacketError()
  return Object.freeze({ account: redPacketAccount(row.account), kind: 'group', id: redPacketText(row.id) })
}
export function redPacketBinding(input: unknown): Readonly<AgentBindingSnapshot> {
  const row = redPacketData(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  if (row.source !== 'configured' && row.source !== 'legacy') throw redPacketError()
  const agentId = redPacketText(row.agentId, 64), connectionId = redPacketText(row.connectionId, 64)
  if (![agentId, connectionId].every(value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))) throw redPacketError()
  return Object.freeze({ source: row.source, id: redPacketText(row.id, 4096), revision: redPacketText(row.revision, 512),
    agentId, personaId: redPacketText(row.personaId), connectionId, target: redPacketTarget(row.target) })
}
export function validateAgentRedPacketSnapshot(input: unknown, now = Date.now()): Readonly<AgentRedPacketSnapshot> {
  const row = redPacketData(input, ['version', 'target', 'source', 'observedAt', 'packetRef', 'packetIdentity', 'kind', 'title', 'exclusiveForBot'])
  const source = redPacketData(row.source, ['messageId', 'author', 'at']), target = redPacketTarget(row.target), author: PlatformUserRef = redPacketAccount(source.author)
  if (row.version !== 1 || !samePlatformNamespace(author, target.account) || !Number.isSafeInteger(source.at) ||
      Number(source.at) < 1 || Number(source.at) > now + 60_000 || !Number.isSafeInteger(row.observedAt) ||
      Number(row.observedAt) > now + 1500 || Number(row.observedAt) < now - 30_000 ||
      typeof row.packetIdentity !== 'string' || !/^[a-f\d]{64}$/u.test(row.packetIdentity) ||
      typeof row.kind !== 'string' || !['normal', 'lucky', 'password', 'exclusive', 'unknown'].includes(row.kind) ||
      typeof row.exclusiveForBot !== 'boolean' || typeof row.title !== 'string' || row.title.length > 1024 ||
      [...row.title].length > 256 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(row.title)) throw redPacketError()
  const packetRef = redPacketText(row.packetRef)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(packetRef) || row.kind === 'password' && !row.title.trim()) throw redPacketError()
  if (source.messageId === '0') throw redPacketError()
  return Object.freeze({ version: 1, target, source: Object.freeze({ messageId: redPacketText(source.messageId), author, at: source.at as number }),
    observedAt: row.observedAt as number, packetIdentity: row.packetIdentity, packetRef,
    kind: row.kind as AgentRedPacketSnapshot['kind'], title: row.title, exclusiveForBot: row.exclusiveForBot })
}
export function validateAgentRedPacketRequest(input: unknown): Readonly<AgentRedPacketRequest> {
  const row = redPacketData(input, ['confirm', 'messageId', 'packetRef'])
  if (row.confirm !== undefined && typeof row.confirm !== 'boolean' || row.messageId !== undefined && row.packetRef !== undefined) throw redPacketError()
  if (row.messageId !== undefined && !isPlatformIdentifier(row.messageId)) throw redPacketError()
  return Object.freeze({ ...(row.confirm === undefined ? {} : { confirm: row.confirm as boolean }),
    ...(row.messageId === undefined ? {} : { messageId: redPacketText(row.messageId) }),
    ...(row.packetRef === undefined ? {} : { packetRef: redPacketText(row.packetRef) }) })
}
