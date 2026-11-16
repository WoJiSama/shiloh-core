import { createHash } from 'node:crypto'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { PersonMemoryEntry,PersonMemoryIdentity,PersonMemoryScene,PersonMemorySource,PersonMemoryStore } from '../../../contracts/personMemory.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { sanitizeUntrustedText } from '../../simulation/domain/safety.js'
import { isQqSimulationAddress, simulationAddressKey } from '../../simulation/infrastructure/simulationAddress.js'
import { isPersonMemoryRedacted } from '../domain/personMemory.js'

export function personMemoryAddress(target: ConversationAddress, privatePeerId?: string): { botId: string; scene: PersonMemoryScene } {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const { account } = target
  const botId = account.platform === 'qq' && account.namespace === 'global' ? account.id : `account-${digest(platformAccountKey(account))}`
  if (target.kind === 'private') return { botId, scene: { kind: 'private', id: target.id,
    ...(privatePeerId !== undefined && privatePeerId !== target.id ? { peerId: privatePeerId } : {}) } }
  return { botId, scene: { kind: 'group', id: isQqSimulationAddress(target) ? target.id : `conversation-${digest(simulationAddressKey(target))}` } }
}

export async function revokePersonMemorySourceForAccount(store: PersonMemoryStore, botId: string, scene: PersonMemoryScene, messageId: string, personaId?: string) {
  const personas = new Set((await store.identities()).filter(identity => identity.botId === botId).map(identity => identity.personaId))
  if (personaId) personas.add(personaId)
  for (const id of personas) await store.revokeSource({ identity: { botId, personaId: id }, scene, messageId })
}

export function formatPersonMemoryFacts(entries: readonly PersonMemoryEntry[]) {
  const labels = { self: '本人陈述', reported: '他人转述', inferred: '推测' }
  return entries.map(entry => {
    const text = safeTruncateUnicode(sanitizeUntrustedText(entry.text).replace(/\s+/gu, ' '), 160)
    return `- ${labels[entry.evidenceKind]}：${text}`
  }).join('\n')
}

/** Cache only within one retrieval phase; callers refresh before model I/O and delivery. */
export function createPersonMemorySourceFilter(store:PersonMemoryStore,identity:PersonMemoryIdentity) {
  const snapshots = new Map<string,Promise<Awaited<ReturnType<PersonMemoryStore['getRedactions']>>>>()
  const filter = async (source:PersonMemorySource,text:string) => {
    let snapshot = snapshots.get(source.authorId)
    if (!snapshot) {snapshot = store.getRedactions({identity,subjectId:source.authorId});snapshots.set(source.authorId,snapshot)}
    return !isPersonMemoryRedacted(source,text,await snapshot)
  }
  return Object.assign(filter,{refresh:() => {snapshots.clear()}})
}

export async function canReadUnattributedMemory(store:PersonMemoryStore,identity:PersonMemoryIdentity,scene:PersonMemoryScene) {
  for (const subject of await store.listSubjects(identity)) {
    const state = await store.getRedactions(subject)
    if (state.disabled || state.scenes.some(rule => rule.disabled && rule.scene.kind === scene.kind && rule.scene.id === scene.id)) return false
  }
  return true
}

export function memoryMessageTime(value:unknown):number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return 0
  if (/^\d+(?:\.\d+)?$/.test(value)) return memoryMessageTime(Number(value))
  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  const parsed = Date.parse(local ? `${local[1]}-${local[2]!.padStart(2,'0')}-${local[3]!.padStart(2,'0')}T${local[4]}:${local[5]}:${local[6] || '00'}+08:00` : value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Old generated replies have no fact lineage. Discard them after an erasure;
 * original user messages can still be checked against their exact sources. */
export async function filterPersonMemoryHistory<T extends {message_id?:unknown;source?:string;content?:string;at?:unknown;time?:unknown;sender:{user_id?:unknown}}>(
  store:PersonMemoryStore,identity:PersonMemoryIdentity,scene:PersonMemoryScene,messages:T[]
):Promise<T[]> {
  const scope = await store.getSceneRedactions({identity,scene})
  const snapshots = new Map<string,Awaited<ReturnType<PersonMemoryStore['getRedactions']>>>()
  const visible:T[] = []
  for (const message of messages) {
    const authorId = String(message.sender?.user_id || '')
    const at = memoryMessageTime(message.at) || memoryMessageTime(message.time)
    if ((message.source === 'send' || authorId === identity.botId) && scope.invalidatedAt > 0 && at <= scope.invalidatedAt) continue
    if (!authorId || !at || message.message_id === undefined) {
      if (!scope.invalidatedAt) visible.push(message)
      continue
    }
    let snapshot = snapshots.get(authorId)
    if (!snapshot) {snapshot = await store.getRedactions({identity,subjectId:authorId});snapshots.set(authorId,snapshot)}
    const text = message.content || ''
    const source = {scene,authorId,messageId:String(message.message_id),at,excerpt:text}
    if (!isPersonMemoryRedacted(source,text,snapshot)) visible.push(message)
  }
  return visible
}
