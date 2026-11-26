import { createHash, randomUUID } from 'node:crypto'
import type { PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { AgentQzoneClaim, AgentQzoneClaimResult, AgentQzoneLedger, AgentQzoneOperation, AgentQzoneOwnPost, AgentQzoneStorage, AgentQzoneVisit } from '../../../contracts/agentQzone.js'
import { normalizeAgentQzoneLimits, qzoneData, qzoneToken, validateAgentQzoneBinding, validateAgentQzoneOperation,
  validateAgentQzoneOwnPost, validateAgentQzoneVisit } from '../../tools/infrastructure/agentQzoneValidation.js'

const PREFIX = 'agent:qzone:v1:'
const invalid = () => new Error('qzone_ledger_invalid')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_639_999_913_600_000
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const accountKey = (account: PlatformAccountRef) => [account.platform, account.namespace, account.id]
const ownKey = (account: PlatformAccountRef, postId: string) => PREFIX + 'own:' + hash([accountKey(account), postId])
const visitKey = (id: string) => PREFIX + 'visit:' + hash(id)

interface StoredClaim {
  readonly version: 1
  readonly state: 'pending' | 'confirmed' | 'failed' | 'unknown'
  readonly token: string
  readonly binding: ReturnType<typeof validateAgentQzoneBinding>
  readonly identity: string
  readonly operationHash: string
  readonly kind: AgentQzoneOperation['kind']
  readonly createdAt: number
  readonly userId?: string
  readonly postId?: string
}
function sourceKey(row: Pick<StoredClaim, 'binding' | 'identity' | 'kind' | 'userId' | 'postId'>) {
  const subject = row.kind === 'like' || row.kind === 'comment' ? [row.userId, row.postId] : row.kind === 'delete' ? [row.postId] : []
  const target = row.binding.target
  // A configuration save/rebind never gives an already attempted source a second external effect.
  return PREFIX + 'source:' + hash([accountKey(target.account), target.kind, target.id, row.identity, row.kind, ...subject])
}
function effectKey(row: Pick<StoredClaim, 'binding' | 'kind' | 'userId' | 'postId' | 'identity'>): string | undefined {
  if (row.kind === 'like' || row.kind === 'comment') return PREFIX + 'effect:' + hash([accountKey(row.binding.target.account), row.kind, row.userId, row.postId])
  if (row.kind === 'delete') return PREFIX + 'effect:' + hash([accountKey(row.binding.target.account), row.kind, row.postId])
  if (row.kind === 'publish' && /^personal:publish:[a-f0-9]{64}$/u.test(row.identity)) {
    return PREFIX + 'effect:' + hash([accountKey(row.binding.target.account), row.identity])
  }
  return undefined
}
function stored(input: unknown): StoredClaim {
  const row = qzoneData(input, ['version', 'state', 'token', 'binding', 'identity', 'operationHash', 'kind', 'createdAt', 'userId', 'postId'])
  if (row.version !== 1 || !['pending', 'confirmed', 'failed', 'unknown'].includes(row.state as string) ||
      !['publish', 'delete', 'read', 'visit', 'like', 'comment'].includes(row.kind as string) || !isHash(row.operationHash) || !isTime(row.createdAt)) throw invalid()
  const kind = row.kind as AgentQzoneOperation['kind'], binding = validateAgentQzoneBinding(row.binding)
  const hasUser = ['read', 'visit', 'like', 'comment'].includes(kind), hasPost = ['delete', 'like', 'comment'].includes(kind)
  if (Object.keys(row).length !== 8 + Number(hasUser) + Number(hasPost) ||
      Object.hasOwn(row, 'userId') !== hasUser || Object.hasOwn(row, 'postId') !== hasPost ||
      (kind === 'read' && binding.target.kind !== 'private' || kind === 'visit' && binding.target.kind !== 'group' ||
        hasUser && binding.target.kind === 'private' && binding.target.id !== row.userId)) throw invalid()
  return Object.freeze({ version: 1, state: row.state as StoredClaim['state'], token: qzoneToken(row.token, 128), binding,
    identity: qzoneToken(row.identity, 4096), operationHash: row.operationHash, kind, createdAt: row.createdAt,
    ...(hasUser ? { userId: qzoneToken(row.userId) } : {}), ...(hasPost ? { postId: qzoneToken(row.postId) } : {}) })
}
function parse(raw: unknown): StoredClaim {
  if (typeof raw !== 'string' || raw.length > 32_768) throw invalid()
  return stored(JSON.parse(raw))
}
function claimToken(input: unknown): AgentQzoneClaim {
  const row = qzoneData(input, ['key', 'token'])
  if (typeof row.key !== 'string' || !/^agent:qzone:v1:source:[a-f0-9]{64}$/u.test(row.key)) throw invalid()
  return { key: row.key, token: qzoneToken(row.token, 128) }
}
function account(input: unknown): PlatformAccountRef {
  const row = qzoneData(input, ['platform', 'namespace', 'id'])
  if (Object.keys(row).length !== 3) throw invalid()
  return Object.freeze({ platform: qzoneToken(row.platform, 64), namespace: qzoneToken(row.namespace), id: qzoneToken(row.id) })
}

const typeGuard = `
for _, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('qzone_ledger_type') end
end
`
const claimScript = typeGuard + `
local old = redis.call('GET', KEYS[1])
if old then return {'source', old} end
if ARGV[2] == '1' then
  old = redis.call('GET', KEYS[2])
  if old then return {'effect', old} end
end
if ARGV[3] == '1' then
  local count = redis.call('GET', KEYS[3])
  if count and (not string.match(count, '^%d+$') or tonumber(count) > 1000000000) then return redis.error_reply('qzone_ledger_counter') end
  if tonumber(count or '0') >= tonumber(ARGV[4]) then return {'quota', ''} end
end
if ARGV[5] == '1' then
  local previous = redis.call('GET', KEYS[4])
  if previous and (not string.match(previous, '^%d+$') or tonumber(previous) > 8639999913600000) then return redis.error_reply('qzone_ledger_cooldown') end
  if previous and tonumber(ARGV[6]) - tonumber(previous) < tonumber(ARGV[7]) then return {'cooldown', ''} end
end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] == '1' then redis.call('SET', KEYS[2], ARGV[1]) end
if ARGV[3] == '1' then
  redis.call('INCR', KEYS[3])
  redis.call('EXPIRE', KEYS[3], 172800)
end
if ARGV[5] == '1' then redis.call('SET', KEYS[4], ARGV[6]) end
return {'claimed', ''}
`
const pendingScript = typeGuard + `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '1' and redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
return 1
`
const settleScript = typeGuard + `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] == '1' and redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if ARGV[4] ~= '' then
  local previous = redis.call('GET', KEYS[3])
  if previous and previous ~= ARGV[4] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] == '1' then redis.call('SET', KEYS[2], ARGV[2]) end
if ARGV[4] ~= '' then
  if ARGV[5] == '0' then redis.call('SET', KEYS[3], ARGV[4])
  else redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5]) end
end
return 1
`

/** Durable claims are deliberately never reclaimed. A failed attempt conservatively consumes its quota/cooldown. */
export function createAgentQzoneLedger(storage: AgentQzoneStorage): AgentQzoneLedger {
  if (!storage || typeof storage.get !== 'function' || typeof storage.eval !== 'function') throw invalid()
  const readClaim = async (claim: AgentQzoneClaim) => {
    const selected = claimToken(claim), raw = await storage.get(selected.key)
    if (raw === null) return undefined
    const row = parse(raw)
    if (row.state !== 'pending' || row.token !== selected.token || sourceKey(row) !== selected.key) return undefined
    return { row, raw, selected }
  }
  const ledger: AgentQzoneLedger = {
    async claim(input): Promise<AgentQzoneClaimResult> {
      try {
        const args = qzoneData(input, ['binding', 'identity', 'operation', 'now', 'limits']), binding = validateAgentQzoneBinding(args.binding),
          identity = qzoneToken(args.identity, 4096), operation = validateAgentQzoneOperation(args.operation), limits = normalizeAgentQzoneLimits(args.limits)
        if (!isTime(args.now)) throw invalid()
        const now = args.now, kind = operation.kind, feedInteraction = kind === 'visit' || kind === 'like' || kind === 'comment'
        if (feedInteraction && !limits.enabled || kind === 'visit' && binding.target.kind !== 'group' ||
            'userId' in operation && binding.target.kind === 'private' && operation.userId !== binding.target.id) return { state: 'failed', code: 'qzone_disabled' }
        if (operation.kind === 'read' && (binding.target.kind !== 'private' || binding.target.id !== operation.userId)) {
          return { state: 'failed', code: 'qzone_disabled' }
        }
        const row: StoredClaim = Object.freeze({ version: 1, state: 'pending', token: randomUUID(), binding, identity,
          operationHash: hash(operation), kind, createdAt: now,
          ...('userId' in operation ? { userId: operation.userId } : {}), ...('postId' in operation ? { postId: operation.postId } : {}) })
        const key = sourceKey(row), effect = effectKey(row), group = hash([accountKey(binding.target.account), binding.target.kind, binding.target.id]),
          day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10), quota = kind === 'like' || kind === 'comment', visit = kind === 'visit',
          quotaKey = PREFIX + 'quota:' + group + ':' + day + ':' + kind, cooldown = PREFIX + 'cooldown:' + group,
          cap = kind === 'like' ? limits.maxLikesPerDay : limits.maxCommentsPerDay
        const result = await storage.eval(claimScript, { keys: [key, effect ?? key, quota ? quotaKey : key, visit ? cooldown : key],
          arguments: [JSON.stringify(row), effect ? '1' : '0', quota ? '1' : '0', String(cap), visit ? '1' : '0', String(now), String(limits.visitCooldownMs)] })
        if (!Array.isArray(result) || result.length !== 2) throw invalid()
        const [status, previous] = result
        if (status === 'claimed' && previous === '') return { state: 'claimed', claim: Object.freeze({ key, token: row.token }) }
        if (status === 'quota' && previous === '') return { state: 'failed', code: 'qzone_daily_limit' }
        if (status === 'cooldown' && previous === '') return { state: 'failed', code: 'qzone_visit_cooldown' }
        if (status !== 'source' && status !== 'effect') throw invalid()
        const saved = parse(previous), uncertain = saved.state === 'pending' || saved.state === 'unknown'
        if ((status === 'source' ? sourceKey(saved) : effectKey(saved)) !== (status === 'source' ? key : effect)) throw invalid()
        return { state: uncertain ? 'unknown' : 'failed', code: status === 'source' && saved.operationHash !== row.operationHash ? 'qzone_claim_conflict'
          : uncertain ? 'qzone_already_unknown' : saved.state === 'confirmed' ? 'qzone_already_confirmed' : 'qzone_already_failed' }
      } catch { return { state: 'failed', code: 'qzone_ledger_unavailable' } }
    },
    async isPending(claim): Promise<boolean> {
      try {
        const current = await readClaim(claim)
        if (!current) return false
        const effect = effectKey(current.row)
        return await storage.eval(pendingScript, { keys: [current.selected.key, effect ?? current.selected.key],
          arguments: [current.raw, effect ? '1' : '0'] }) === 1
      } catch { return false }
    },
    async settle(claim, state, evidence): Promise<boolean> {
      try {
        if (state !== 'confirmed' && state !== 'failed' && state !== 'unknown') throw invalid()
        const current = await readClaim(claim)
        if (!current) return false
        const { row, raw, selected } = current, values = evidence === undefined ? {} : qzoneData(evidence, ['ownPost', 'visit'])
        let evidenceKey = selected.key, serialized = '', ttl = 0
        if (state !== 'confirmed' && Object.keys(values).length) throw invalid()
        if (state === 'confirmed' && row.kind === 'publish') {
          if (Object.keys(values).length !== 1 || !Object.hasOwn(values, 'ownPost')) throw invalid()
          const post = validateAgentQzoneOwnPost(values.ownPost)
          if (!same(post.account, row.binding.target.account) || post.agentId !== row.binding.agentId || !same(post.source, row.binding)) throw invalid()
          evidenceKey = ownKey(post.account, post.postId); serialized = JSON.stringify(post)
        } else if (state === 'confirmed' && (row.kind === 'visit' || row.kind === 'read' && Object.hasOwn(values, 'visit'))) {
          if (Object.keys(values).length !== 1 || !Object.hasOwn(values, 'visit')) throw invalid()
          const visit = validateAgentQzoneVisit(values.visit)
          if (!same(visit.binding, row.binding) || visit.sourceId !== row.identity || visit.userId !== row.userId ||
              visit.observedAt < row.createdAt || visit.observedAt > row.createdAt + 240_000 || visit.expiresAt - visit.observedAt > 15 * 60_000) throw invalid()
          evidenceKey = visitKey(visit.id); serialized = JSON.stringify(visit); ttl = visit.expiresAt - visit.observedAt
          if (ttl <= 0) throw invalid()
        } else if (Object.keys(values).length) throw invalid()
        const effect = effectKey(row), next = JSON.stringify({ ...row, state })
        return await storage.eval(settleScript, { keys: [selected.key, effect ?? selected.key, evidenceKey],
          arguments: [raw, next, effect ? '1' : '0', serialized, String(ttl)] }) === 1
      } catch { return false }
    },
    async readOwnPost(inputAccount, inputPostId): Promise<AgentQzoneOwnPost | undefined> {
      const selected = account(inputAccount), postId = qzoneToken(inputPostId), raw = await storage.get(ownKey(selected, postId))
      if (raw === null) return undefined
      if (typeof raw !== 'string' || raw.length > 32_768) throw invalid()
      const post = validateAgentQzoneOwnPost(JSON.parse(raw))
      if (!same(post.account, selected) || post.postId !== postId || post.source.agentId !== post.agentId || !same(post.source.target.account, selected)) throw invalid()
      return post
    },
    async readVisit(inputId): Promise<AgentQzoneVisit | undefined> {
      const id = qzoneToken(inputId), raw = await storage.get(visitKey(id))
      if (raw === null) return undefined
      if (typeof raw !== 'string' || raw.length > 32_768) throw invalid()
      const visit = validateAgentQzoneVisit(JSON.parse(raw))
      if (visit.id !== id) throw invalid()
      return visit
    },
  }
  return Object.freeze(ledger)
}
