/** A person is continuous inside one bot/persona; scenes retain their audience. */
export interface PersonMemoryIdentity { botId: string; personaId: string }
export type PersonMemoryScene =
  | { kind: 'group'; id: string }
  /** Only a trusted host may supply the proven peer when it differs from the conversation ID. */
  | { kind: 'private'; id: string; peerId?: string }
export interface PersonMemorySource {
  scene: PersonMemoryScene
  authorId: string
  messageId: string
  at: number
  /** A real, preferably minimal excerpt, supplied by the message host. */
  excerpt: string
}
export type PersonMemoryCategory = 'name' | 'interest' | 'preference' | 'fact' | 'event' | 'relationship' | 'impression'
export type PersonMemoryEvidence = 'self' | 'reported' | 'inferred'
export type PersonMemorySensitivity = 'ordinary' | 'personal' | 'sensitive'
export interface PersonMemoryDraft {
  identity: PersonMemoryIdentity
  subjectId: string
  text: string
  category: PersonMemoryCategory
  source: PersonMemorySource
  evidenceKind: PersonMemoryEvidence
  sensitivity?: PersonMemorySensitivity
  portable?: boolean
  confidence?: number
  eventAt?: number
  validUntil?: number
  supersedes?: string
  relatedUserIds?: string[]
}
export interface PersonMemoryEntry extends PersonMemoryDraft {
  id: string
  sensitivity: PersonMemorySensitivity
  portable: boolean
  confidence: number
  relatedUserIds: string[]
  createdAt: number
  updatedAt: number
  superseded?: boolean
}
export interface PersonMemoryQuery {
  identity: PersonMemoryIdentity
  subjectId: string
  scene: PersonMemoryScene
  viewerUserId: string
  query?: string
  limit?: number
  offset?: number
  now?: number
  /** A compact cross-scene profile; excludes even local non-portable entries. */
  portableOnly?: boolean
  /** Non-portable facts backed by messages in this exact scene. */
  localOnly?: boolean
}
export interface PersonMemoryIndexEntry {
  id: string
  summary: string
  category: PersonMemoryCategory
  at: number
  eventAt?: number
}
export interface PersonMemoryQueryResult {
  items: PersonMemoryEntry[]
  index: PersonMemoryIndexEntry[]
  hasMore: boolean
  nextOffset?: number
  /** Compare at use time if retaining a projection beyond this call. */
  revision: string
  truncated: boolean
}
export interface PersonMemorySubject { identity: PersonMemoryIdentity; subjectId: string }
export interface PersonMemoryTombstone {
  id?: string
  text?: string
  sourceKey?: string
  excerpt?: string
  before: number
}
export interface PersonMemorySceneRule {
  scene: PersonMemoryScene
  forgottenBefore: number
  disabled: boolean
}
export interface PersonMemoryRedactions {
  identity: PersonMemoryIdentity
  subjectId: string
  revision: string
  disabled: boolean
  forgottenBefore: number
  scenes: PersonMemorySceneRule[]
  revokedSources: string[]
  tombstones: PersonMemoryTombstone[]
}
export interface PersonMemoryForget extends PersonMemorySubject {
  id?: string
  text?: string
  sourceMessageId?: string
  scene?: PersonMemoryScene
  before?: number
}
export interface PersonMemoryStore {
  remember(input: PersonMemoryDraft, isCurrent?:()=>boolean): Promise<{ saved: boolean; entry?: PersonMemoryEntry; reason?: string }>
  registerSource(input: PersonMemorySubject & { source: PersonMemorySource }, isCurrent?:()=>boolean): Promise<boolean>
  query(input: PersonMemoryQuery): Promise<PersonMemoryQueryResult>
  list(input: PersonMemoryQuery): Promise<PersonMemoryQueryResult>
  read(input: PersonMemoryQuery & { ids: string[] }): Promise<PersonMemoryQueryResult>
  getRedactions(input: PersonMemorySubject): Promise<PersonMemoryRedactions>
  getSceneRedactions(input: { identity: PersonMemoryIdentity; scene: PersonMemoryScene }): Promise<{ revision: string; invalidatedAt: number; forgottenBefore: number }>
  forget(input: PersonMemoryForget, isCurrent?:()=>boolean): Promise<number>
  revokeSource(input: { identity: PersonMemoryIdentity; scene: PersonMemoryScene; messageId: string; at?: number }): Promise<void>
  forgetScene(input: { identity: PersonMemoryIdentity; scene: PersonMemoryScene; before?: number }, isCurrent?:()=>boolean): Promise<void>
  setEnabled(input: PersonMemorySubject & { enabled: boolean; scene?: PersonMemoryScene }, isCurrent?:()=>boolean): Promise<void>
  scenes(input: PersonMemoryQuery): Promise<PersonMemoryScene[]>
  identities(): Promise<PersonMemoryIdentity[]>
  listSubjects(identity?: PersonMemoryIdentity): Promise<PersonMemorySubject[]>
}
