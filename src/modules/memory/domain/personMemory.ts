import type { PersonMemoryDraft, PersonMemoryEntry, PersonMemoryIdentity, PersonMemoryQuery, PersonMemoryRedactions, PersonMemoryScene, PersonMemorySource } from '../../../contracts/personMemory.js'

export const PERSON_MEMORY_CATEGORIES = ['name', 'interest', 'preference', 'fact', 'event', 'relationship', 'impression'] as const
const PORTABLE_CATEGORIES = new Set(['name', 'interest', 'preference'])
const id = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value)

export function validPersonMemoryIdentity(value: PersonMemoryIdentity): boolean {
  return Boolean(value && id(value.botId) && id(value.personaId))
}
export function validPersonMemoryScene(value: PersonMemoryScene): boolean {
  return Boolean(value && id(value.id) && (value.kind === 'group' ? !Object.hasOwn(value, 'peerId') :
    value.kind === 'private' && (value.peerId === undefined || id(value.peerId))))
}
export function privateScenePeer(scene: PersonMemoryScene): string | undefined {
  return scene.kind === 'private' ? scene.peerId ?? scene.id : undefined
}
export function personMemorySceneKey(scene: PersonMemoryScene): string {
  return JSON.stringify([scene.kind, scene.id])
}
export function personMemorySourceKey(source: Pick<PersonMemorySource, 'scene' | 'messageId'>): string {
  return JSON.stringify([source.scene.kind, source.scene.id, source.messageId])
}
export function samePersonMemoryScene(left: PersonMemoryScene, right: PersonMemoryScene): boolean {
  return left.kind === right.kind && left.id === right.id
}
export function normalizePersonMemoryText(value: string): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}
export function validPersonMemorySource(source: PersonMemorySource): boolean {
  return Boolean(source && validPersonMemoryScene(source.scene) && id(source.authorId) && id(source.messageId)
    && Number.isSafeInteger(source.at) && source.at > 0 && typeof source.excerpt === 'string' && source.excerpt.trim()
    && source.excerpt.length <= 4000 && (source.scene.kind !== 'private' || privateScenePeer(source.scene) === source.authorId))
}

/** A semantic extractor proposes portability; this validates the narrow allowed contract. */
export function isPortablePersonMemory(entry: PersonMemoryDraft): boolean {
  return entry.portable === true && entry.sensitivity === 'ordinary' && PORTABLE_CATEGORIES.has(entry.category)
    && entry.evidenceKind === 'self' && entry.source.authorId === entry.subjectId && entry.source.scene.kind === 'group'
    && !(entry.relatedUserIds || []).some(value => value !== entry.subjectId)
}

export function personMemoryDraftError(input: PersonMemoryDraft): string | undefined {
  if (!validPersonMemoryIdentity(input.identity) || !id(input.subjectId)) return 'invalid_identity'
  if (!validPersonMemorySource(input.source)) return 'missing_source'
  if (!PERSON_MEMORY_CATEGORIES.includes(input.category)) return 'invalid_category'
  if (!['self', 'reported', 'inferred'].includes(input.evidenceKind)) return 'invalid_evidence'
  if (input.evidenceKind === 'self' && input.source.authorId !== input.subjectId) return 'self_author_mismatch'
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1200) return 'invalid_text'
  if (input.sensitivity !== undefined && !['ordinary', 'personal', 'sensitive'].includes(input.sensitivity)) return 'invalid_sensitivity'
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) return 'invalid_confidence'
  if (input.eventAt !== undefined && (!Number.isSafeInteger(input.eventAt) || input.eventAt <= 0)) return 'invalid_event_time'
  if (input.validUntil !== undefined && (!Number.isSafeInteger(input.validUntil) || input.validUntil <= input.source.at)) return 'invalid_expiration'
  if (input.relatedUserIds !== undefined && (!Array.isArray(input.relatedUserIds) || input.relatedUserIds.some(value => !id(value)))) return 'invalid_related_people'
  return undefined
}

/** Scene filtering runs before scoring, rendering, embedding, or index exposure. */
export function canUsePersonMemory(entry: PersonMemoryEntry, query: PersonMemoryQuery, now: number): boolean {
  if (!validPersonMemoryIdentity(query.identity) || !validPersonMemoryScene(query.scene) || !validPersonMemorySource(entry.source)) return false
  if (entry.identity.botId !== query.identity.botId || entry.identity.personaId !== query.identity.personaId || entry.subjectId !== query.subjectId) return false
  if (entry.superseded || (entry.validUntil !== undefined && entry.validUntil <= now)) return false
  if (query.portableOnly && !isPortablePersonMemory(entry)) return false
  if (query.localOnly && (!samePersonMemoryScene(entry.source.scene, query.scene) || isPortablePersonMemory(entry))) return false
  if (query.scene.kind === 'private') {
    if (query.viewerUserId !== query.subjectId || privateScenePeer(query.scene) !== query.viewerUserId) return false
    if (entry.source.scene.kind === 'private' && !samePersonMemoryScene(entry.source.scene, query.scene)) return false
    // A mention about this person does not grant them access to somebody else's utterance.
    return entry.source.authorId === query.subjectId && entry.evidenceKind === 'self'
  }
  if (samePersonMemoryScene(entry.source.scene, query.scene)) return true
  return isPortablePersonMemory(entry)
}

/** Applies equally to structured facts and to source-backed archive rows. */
export function isPersonMemoryRedacted(source: PersonMemorySource, text: string, snapshot: PersonMemoryRedactions): boolean {
  // Stored evidence is bounded, but archive and recent-history readers check the
  // entire captured utterance. Validate its structure without truncating the
  // evidence later compared with erasure tombstones.
  const readSource = source && typeof source.excerpt === 'string'
    ? {...source,excerpt:source.excerpt.trim().slice(0,4000)} : source
  if (!validPersonMemorySource(readSource) || snapshot.disabled || source.at <= snapshot.forgottenBefore) return true
  const sceneRule = snapshot.scenes.find(rule => samePersonMemoryScene(rule.scene, source.scene))
  if (sceneRule?.disabled || source.at <= (sceneRule?.forgottenBefore || 0)) return true
  const sourceKey = personMemorySourceKey(source)
  if (snapshot.revokedSources.includes(sourceKey)) return true
  const normalized = normalizePersonMemoryText(text)
  const excerpt = normalizePersonMemoryText(source.excerpt)
  return snapshot.tombstones.some(tombstone => {
    if (source.at > tombstone.before) return false
    if (tombstone.sourceKey && tombstone.sourceKey !== sourceKey) return false
    const target = tombstone.text ? normalizePersonMemoryText(tombstone.text) : ''
    const evidence = tombstone.excerpt ? normalizePersonMemoryText(tombstone.excerpt) : ''
    if (target && normalized === target) return true
    // Raw archive rows may include several facts; suppress a row containing a forgotten excerpt.
    if (evidence && (excerpt.includes(evidence) || normalized.includes(evidence))) return true
    return Boolean(tombstone.sourceKey && !target && !evidence)
  })
}

export function filterRedacted<T extends { source: PersonMemorySource; text: string }>(items: T[], snapshot: PersonMemoryRedactions): T[] {
  return items.filter(item => !isPersonMemoryRedacted(item.source, item.text, snapshot))
}

export function rankPersonMemories<T extends { text: string; source: PersonMemorySource; confidence: number }>(items: T[], query: string): T[] {
  const normalized = normalizePersonMemoryText(query)
  const terms = new Set(normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2}/g) || [])
  // CJK bigrams also match inside a longer query without requiring a tokenizer.
  for (let i = 0; i + 1 < normalized.length; i++) if (/[\u3400-\u9fff]{2}/.test(normalized.slice(i, i + 2))) terms.add(normalized.slice(i, i + 2))
  const score = (entry: T) => {
    const text = normalizePersonMemoryText(entry.text)
    let match = normalized && text.includes(normalized) ? 8 : 0
    for (const term of terms) if (text.includes(term)) match += 1
    return match
  }
  return [...items].sort((a, b) => score(b) - score(a) || b.source.at - a.source.at || b.confidence - a.confidence)
}
