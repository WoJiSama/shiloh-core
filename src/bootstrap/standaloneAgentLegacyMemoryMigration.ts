import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { copyFile, mkdtemp, chmod, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createClient } from '@redis/client'
import YAML from 'yaml'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import type { CharacterMemory, CharacterReceipt } from '../contracts/character.js'
import { validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { agentBindingToken, agentConversationKey, agentPersonaScopeId, conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { activeCharacterMemories, characterKey, createEmptyCharacterState, validateCharacterState } from '../modules/simulation/domain/characterState.js'
import { projectCharacterTransfer } from '../modules/simulation/domain/characterTransfer.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey } from '../modules/simulation/infrastructure/simSessionStore.js'
import { agentRedisPrefix, connectAgentRedis } from '../modules/runtime/infrastructure/agentRedis.js'
import { createAgentSecretTextCheck } from '../modules/messaging/infrastructure/agentSecretText.js'
import { createForbiddenWordGuard } from '../modules/conversation/domain/forbiddenWordGuard.js'
import type { readStandaloneAgentConfig } from './standaloneAgentConfig.js'

type RecordValue = Record<string, unknown>
type Artifact = { readonly file: string; readonly sha256: string }
/** Host-captured evidence, not a caller-authored substitute for agent-bindings.yaml.
 * Acquisition must read both original files and their exact backup members, and
 * obtain backupSourceRaw from the named RDB in an isolated read-only snapshot.
 * The file/Redis acquisition owner must recheck these captures before its CAS.
 */
export interface StandaloneLegacyMemoryEvidence {
  readonly configRaw: string
  readonly personasRaw: string
  readonly sourceBindingsAbsent: true
  readonly sourceKey: string
  readonly sourceRaw: string
  readonly backupSourceRaw: string
  readonly resolver: Artifact & { readonly kind: 'persona-library-v1' }
  readonly backup: {
    readonly id: string
    readonly configData: Artifact
    readonly redis: Artifact
    readonly configSha256: string
    readonly personasSha256: string
  }
}
export interface StandaloneLegacyMemorySourceProof {
  readonly version: 1
  readonly kind: 'qq-implicit-default-memory'
  readonly source: {
    readonly scope: { readonly botId: string; readonly personaId: 'default'; readonly groupId: string }
    readonly key: string
    readonly sha256: string
    readonly revision: number
    readonly configSha256: string
    readonly personasSha256: string
    readonly sourceBindings: 'absent'
    readonly resolver: Artifact & { readonly kind: 'persona-library-v1' }
  }
  readonly backup: StandaloneLegacyMemoryEvidence['backup']
  readonly destination: { readonly scopeKey: string; readonly bindingToken: string }
}
const failure = (detail: string): never => { throw new Error(`旧默认人格记忆来源：${detail}`) }
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex')
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return failure('证据对象无效')
  return value as RecordValue
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  return value
}
const fingerprint = (value: unknown) => sha(JSON.stringify(canonical(value)))
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return failure('证据标识无效')
  return value
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return failure('证据指纹无效')
  return value
}
function artifact(input: Artifact): Artifact {
  const row = record(input), file = text(row.file)
  if (!path.isAbsolute(file) || Object.keys(row).some(key => !['file', 'sha256', 'kind'].includes(key))) return failure('备份或解析器材料无效')
  return { file, sha256: hash(row.sha256) }
}
function document(raw: string): RecordValue {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * 1024 * 1024) return failure('配置快照超过上限')
  try {
    const parsed = YAML.parseDocument(raw)
    if (parsed.errors.length) return failure('配置快照无效')
    return record(parsed.toJS({ maxAliasCount: 100 }))
  } catch { return failure('配置快照无效') }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
type ProofInput = { readonly evidence: StandaloneLegacyMemoryEvidence; readonly binding: AgentBindingSnapshot }

/** Recompute the legacy fallback from actual settings/library bytes. No legacy
 * AgentBindingSnapshot is invented, and no source route is copied from proof JSON.
 * This deliberately supports one approved mapping: default -> shiloh/default.
 */
export function buildStandaloneLegacyMemorySourceProof({ evidence, binding }: ProofInput): StandaloneLegacyMemorySourceProof {
  try {
    if (!evidence || evidence.sourceBindingsAbsent !== true || binding.source !== 'configured' || binding.agentId !== 'shiloh' || binding.personaId !== 'default' ||
        binding.target.kind !== 'group' || binding.target.account.platform !== 'qq' || binding.target.account.namespace !== 'global' ||
        binding.id !== conversationAddressKey(binding.target) || !text(binding.revision) || !text(binding.connectionId)) return failure('仅接受同QQ账号同群的已配置shiloh/default目标')
    validateQqBindingAddress(binding.target)
    const configSha256 = sha(evidence.configRaw), personasSha256 = sha(evidence.personasRaw), backup = record(evidence.backup)
    if (hash(backup.configSha256) !== configSha256 || hash(backup.personasSha256) !== personasSha256 ||
        typeof evidence.sourceRaw !== 'string' || Buffer.byteLength(evidence.sourceRaw) > 8 * 1024 * 1024 || evidence.sourceRaw !== evidence.backupSourceRaw) return failure('源内容与冻结备份不一致')
    const settings = record(document(evidence.configRaw).pluginSettings), library = document(evidence.personasRaw), accountId = binding.target.account.id, groupId = binding.target.id
    if (settings.enabled !== true || settings.enableGroupWhitelist !== true || !Array.isArray(settings.allowedGroups) || !settings.allowedGroups.every(id => typeof id === 'string') ||
        !settings.allowedGroups.includes(groupId)) return failure('旧配置未证明该账号群路由')
    const groups = record(library.groupBindings), accounts = record(library.accountBindings)
    // A nonempty route, even to a now-missing persona, is ambiguous evidence.
    // Do not turn a damaged library into a new default identity assertion.
    if (groups[groupId] !== undefined && groups[groupId] !== '' || accounts[accountId] !== undefined && accounts[accountId] !== '' ||
        !Array.isArray(library.personas) || library.privateBinding !== undefined && typeof library.privateBinding !== 'string') return failure('旧解析器没有选择default')
    const scope = { botId: accountId, personaId: 'default' as const, groupId }
    if (evidence.sourceKey !== characterKey(scope)) return failure('来源键与账号、群、人格不符')
    const source = validateCharacterState(JSON.parse(evidence.sourceRaw), scope), resolver = record(evidence.resolver)
    if (resolver.kind !== 'persona-library-v1') return failure('旧解析器版本未核验')
    return freeze({ version: 1, kind: 'qq-implicit-default-memory', source: { scope, key: evidence.sourceKey,
      sha256: sha(evidence.sourceRaw), revision: source.revision, configSha256, personasSha256, sourceBindings: 'absent',
      resolver: { ...artifact(evidence.resolver), kind: 'persona-library-v1' } },
    backup: { id: text(backup.id, 128), configData: artifact(evidence.backup.configData), redis: artifact(evidence.backup.redis), configSha256, personasSha256 },
    destination: { scopeKey: agentConversationKey(binding), bindingToken: agentBindingToken(binding) } })
  } catch { return failure('配置、源scope或备份证据无效') }
}

export function validateStandaloneLegacyMemorySourceProof(proof: unknown, input: ProofInput): proof is StandaloneLegacyMemorySourceProof {
  try { return JSON.stringify(canonical(proof)) === JSON.stringify(canonical(buildStandaloneLegacyMemorySourceProof(input))) } catch { return false }
}

/** Pure projection for a later offline, source-read-only CAS. It never carries
 * session queues/sequence numbers, decisions, active goals or execution grants.
 * Receipts are only the closed, settled dependencies of admitted memories.
 */
export function projectStandaloneLegacyMemoryMigration(input: ProofInput & {
  readonly proof: StandaloneLegacyMemorySourceProof
  readonly targetRaw: string | null
  readonly now: number
  allowsText(text: string): boolean
}) {
  const { evidence, binding, targetRaw, now } = input
  if (!Number.isSafeInteger(now) || now <= 0 || typeof input.allowsText !== 'function' || !validateStandaloneLegacyMemorySourceProof(input.proof, input)) return failure('来源证明或目标绑定已改变')
  const proof = buildStandaloneLegacyMemorySourceProof(input), source = validateCharacterState(JSON.parse(evidence.sourceRaw), proof.source.scope)
  const scope = { ...proof.source.scope, personaId: agentPersonaScopeId(binding.agentId) }
  const target = targetRaw === null ? createEmptyCharacterState(scope) : validateCharacterState(JSON.parse(targetRaw), scope)
  // projectCharacterTransfer recovers interrupted pending receipts as unknown.
  // Recovery is not evidence that an old external attempt ever settled.
  const originallySettled = new Set(source.receipts.filter(row => row.status !== 'pending' && !row.goalId).map(row => row.id))
  const projected = projectCharacterTransfer(source, now), receipts = new Map(projected.receipts.filter(row => originallySettled.has(row.id) && row.status !== 'pending' && !row.goalId).map(row => [row.id, row]))
  const eligible = new Map<string, CharacterMemory>()
  let previous = -1
  while (previous !== eligible.size) {
    previous = eligible.size
    for (const memory of projected.memories) {
      if (eligible.has(memory.id) || memory.supersedes && !eligible.has(memory.supersedes)) continue
      if (memory.evidenceRefs.every(ref => ref.startsWith('receipt:') ? receipts.has(ref.slice(8)) : ref.startsWith('memory:') && eligible.has(ref.slice(7)))) eligible.set(memory.id, memory)
    }
  }
  const structuralCount = eligible.size
  for (const memory of [...eligible.values()]) {
    try { if (input.allowsText(memory.content) !== true) eligible.delete(memory.id) } catch { eligible.delete(memory.id) }
  }
  previous = -1
  while (previous !== eligible.size) {
    previous = eligible.size
    for (const memory of eligible.values()) if (memory.supersedes && !eligible.has(memory.supersedes) ||
        memory.evidenceRefs.some(ref => ref.startsWith('memory:') && !eligible.has(ref.slice(7)))) eligible.delete(memory.id)
  }
  // A superseded ancestor remains hidden unless its admitted replacement is
  // present. Dropping an unsafe replacement must never resurrect the old view.
  const active = new Set(activeCharacterMemories(source).map(memory => memory.id)), selected = new Set<string>()
  const include = (id: string) => {
    if (selected.has(id)) return
    const memory = eligible.get(id)
    if (!memory) return
    selected.add(id)
    if (memory.supersedes) include(memory.supersedes)
    for (const ref of memory.evidenceRefs) if (ref.startsWith('memory:')) include(ref.slice(7))
  }
  for (const memory of projected.memories) if (active.has(memory.id) && eligible.has(memory.id)) include(memory.id)
  const memories = projected.memories.filter(memory => selected.has(memory.id)), neededReceipts = new Set(memories.flatMap(memory => memory.evidenceRefs.filter(ref => ref.startsWith('receipt:')).map(ref => ref.slice(8))))
  const settled = [...receipts.values()].filter(row => neededReceipts.has(row.id))
  const report = { sourceMemories: source.memories.length, importedMemories: 0, alreadyImportedMemories: 0,
    retainedMemories: source.memories.length - memories.length, importedReceipts: 0,
    skipped: { unportableEvidence: source.memories.length - projected.memories.length, unsettledEvidence: projected.memories.length - structuralCount,
      policy: structuralCount - memories.length } }
  const merge = <T extends CharacterMemory | CharacterReceipt>(existing: T[], incoming: T[], kind: 'memory' | 'receipt'): T[] => {
    const rows = new Map(existing.map(row => [row.id, row]))
    for (const row of incoming) {
      const current = rows.get(row.id)
      if (current && fingerprint(current) !== fingerprint(row)) return failure('目标已有不同内容的同编号记忆或回执')
      if (current) { if (kind === 'memory') report.alreadyImportedMemories++; continue }
      rows.set(row.id, row); if (kind === 'memory') report.importedMemories++; else report.importedReceipts++
    }
    return [...rows.values()]
  }
  const mergedMemories = merge(target.memories, memories, 'memory'), mergedReceipts = merge(target.receipts, settled, 'receipt')
  const changed = report.importedMemories + report.importedReceipts > 0
  const state = validateCharacterState({ ...target, memories: mergedMemories, receipts: mergedReceipts, revision: target.revision + (changed ? 1 : 0) }, scope)
  return { changed, state, report, expectedTargetSha256: targetRaw === null ? null : sha(targetRaw),
    receipt: freeze({ version: 1, kind: 'qq-implicit-default-memory', proof, at: now,
      memories: memories.map(row => ({ id: row.id, sha256: fingerprint(row) })),
      receipts: settled.map(row => ({ id: row.id, sha256: fingerprint(row), status: row.status })) }) }
}

// These complete files were inspected for group -> account -> default fallback.
// Unknown deployments must be reviewed rather than trusting a claimed resolver ID.
const reviewedResolvers = new Set([
  '3e615710b0add19192155f3c8ede815b94e3246e8844dc94c546ad7c8cba0935',
  '5ce1e3677c594b0723b47523ac4de9fa033d45783e8a9422ca6389f00bacfbdc',
])
const execute = promisify(execFile)
function safeFile(file: string, maximum: number) {
  const absolute = path.resolve(file), root = path.parse(absolute).root
  let current = root
  for (const piece of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, piece)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) return failure('来源材料含符号链接')
  }
  const stat = fs.statSync(absolute, { bigint: true })
  if (!stat.isFile() || stat.size > BigInt(maximum)) return failure('来源材料类型或大小无效')
  return { file: absolute, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') }
}
async function captureFile(file: string, maximum: number) {
  const snapshot = safeFile(file, maximum), digest = createHash('sha256')
  for await (const bytes of fs.createReadStream(snapshot.file)) digest.update(bytes)
  const sha256 = digest.digest('hex')
  const isCurrent = () => { try { return safeFile(file, maximum).stamp === snapshot.stamp } catch { return false } }
  if (!isCurrent()) return failure('来源材料读取期间改变')
  return { ...snapshot, sha256, isCurrent }
}
function absent(file: string): boolean {
  try { fs.lstatSync(file); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}
async function archiveMember(archive: string, name: string): Promise<string> {
  const options = { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const }
  const details = (await execute('tar', ['-tvzf', archive, name], options)).stdout.trim().split('\n')
  if (details.length !== 1 || !details[0]?.startsWith('-')) return failure('备份成员不是唯一普通文件')
  return (await execute('tar', ['-xOzf', archive, name], options)).stdout
}
export async function withFrozenLegacyRedis<T>(rdbFile: string, expectedHash: string,
  run: (client: NonNullable<ReturnType<typeof createClient>>) => Promise<T>): Promise<T> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'bl-legacy-'))), socket = path.join(directory, 's'), file = path.join(directory, 'snapshot.rdb')
  let child: ReturnType<typeof spawn> | undefined, client: ReturnType<typeof createClient> | undefined, exited: Promise<unknown> | undefined
  try {
    await chmod(directory, 0o700); await copyFile(rdbFile, file); await chmod(file, 0o600)
    if ((await captureFile(file, 512 * 1024 * 1024)).sha256 !== expectedHash) return failure('RDB读取期间改变')
    child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--dir', directory,
      '--dbfilename', 'snapshot.rdb', '--save', '', '--appendonly', 'no', '--daemonize', 'no', '--protected-mode', 'yes'], { stdio: 'ignore' })
    exited = once(child, 'exit').catch(() => {})
    const deadline = Date.now() + 15_000
    while (!fs.existsSync(socket)) {
      if (Date.now() >= deadline || child.exitCode !== null || child.signalCode !== null) return failure('隔离RDB快照无法打开')
      await delay(25)
    }
    client = createClient({ socket: { path: socket, reconnectStrategy: false, connectTimeout: 3000 }, disableOfflineQueue: true, commandOptions: { timeout: 3000 } })
    client.on('error', () => {}); await client.connect()
    let ready = false
    while (Date.now() < deadline) {
      try { ready = await client.ping() === 'PONG'; if (ready) break } catch { /* RDB loading still owns the same bounded deadline. */ }
      await delay(25)
    }
    if (!ready) return failure('隔离RDB快照尚未就绪')
    return await run(client)
  } finally {
    if (client?.isOpen) await client.close().catch(() => client?.destroy())
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (exited) await Promise.race([exited, delay(2000)])
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    await rm(directory, { recursive: true, force: true })
  }
}

async function readBackupCharacter(rdbFile: string, expectedHash: string, key: string): Promise<string> {
  return withFrozenLegacyRedis(rdbFile, expectedHash, async client => {
    if (await client.type(key) !== 'string') return failure('冻结RDB缺少来源角色状态')
    const raw = await client.get(key)
    if (raw === null || Buffer.byteLength(raw) > 8 * 1024 * 1024) return failure('冻结RDB来源状态无效')
    return raw
  })
}

/** Acquisition owns filesystem and RDB authenticity. Callers cannot supply a
 * proof JSON, resolver digest, absent-bindings flag or invented backup values.
 */
export async function acquireStandaloneLegacyMemoryEvidence(options: {
  readonly sourceRoot: string
  readonly backupDir: string
  readonly binding: AgentBindingSnapshot
  readonly redis: { get(key: string): Promise<string | null> }
}) {
  try {
    const sourceRoot = path.resolve(text(options.sourceRoot)), backupDir = path.resolve(text(options.backupDir))
    const configFile = path.join(sourceRoot, 'config/message.yaml'), personasFile = path.join(sourceRoot, 'config/persona-library.yaml'), bindingsFile = path.join(sourceRoot, 'config/agent-bindings.yaml')
    if (!absent(bindingsFile)) return failure('旧宿主具有显式绑定，不能按隐式来源接续')
    const [config, personas, resolver, configData, redisArtifact] = await Promise.all([
      captureFile(configFile, 2 * 1024 * 1024), captureFile(personasFile, 2 * 1024 * 1024),
      captureFile(path.join(sourceRoot, 'dist/backend/modules/conversation/infrastructure/personaLibrary.js'), 256 * 1024),
      captureFile(path.join(backupDir, 'legacy-config-data.tar.gz'), 512 * 1024 * 1024), captureFile(path.join(backupDir, 'redis.rdb'), 512 * 1024 * 1024),
    ])
    if (!reviewedResolvers.has(resolver.sha256)) return failure('旧解析器完整实现尚未核验')
    const [configRaw, personasRaw, names] = await Promise.all([
      archiveMember(configData.file, 'config/message.yaml'), archiveMember(configData.file, 'config/persona-library.yaml'),
      execute('tar', ['-tzf', configData.file], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout.split('\n')),
    ])
    if (names.some(name => name.replace(/^\.\//u, '') === 'config/agent-bindings.yaml') ||
        sha(configRaw) !== config.sha256 || sha(personasRaw) !== personas.sha256 || fs.readFileSync(configFile, 'utf8') !== configRaw || fs.readFileSync(personasFile, 'utf8') !== personasRaw) return failure('旧配置与归档快照不一致')
    const scope = { botId: options.binding.target.account.id, personaId: 'default', groupId: options.binding.target.id }, sourceKey = characterKey(scope)
    const sourceRaw = await options.redis.get(sourceKey)
    if (sourceRaw === null) return failure('旧来源角色状态不存在')
    const backupSourceRaw = await readBackupCharacter(redisArtifact.file, redisArtifact.sha256, sourceKey)
    const evidence: StandaloneLegacyMemoryEvidence = { configRaw, personasRaw, sourceBindingsAbsent: true, sourceKey, sourceRaw, backupSourceRaw,
      resolver: { kind: 'persona-library-v1', file: resolver.file, sha256: resolver.sha256 },
      backup: { id: path.basename(backupDir), configData: { file: configData.file, sha256: configData.sha256 },
        redis: { file: redisArtifact.file, sha256: redisArtifact.sha256 }, configSha256: config.sha256, personasSha256: personas.sha256 } }
    const proof = buildStandaloneLegacyMemorySourceProof({ evidence, binding: options.binding })
    const isCurrent = () => {
      try { return absent(bindingsFile) && [config, personas, resolver, configData, redisArtifact].every(row => row.isCurrent()) &&
        fs.readFileSync(configFile, 'utf8') === configRaw && fs.readFileSync(personasFile, 'utf8') === personasRaw } catch { return false }
    }
    if (!isCurrent()) return failure('来源材料读取期间改变')
    return { evidence, proof, isCurrent }
  } catch { return failure('无法核验旧配置、已审解析器、归档或隔离RDB证据') }
}

type MigrationRedis = { mGet(keys: string[]): Promise<(string | null)[]>; eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
// Same compare-all-before-write discipline as the explicit-binding migrator.
// Only destination state and its provenance receipt are writable here.
const legacyMemoryCas = `
if redis.acl_check_cmd then
  for i = 1, 2 do
    if not redis.acl_check_cmd('SET', KEYS[i], ARGV[2+i]) then return -1 end
  end
end
for i, key in ipairs(KEYS) do
  local j = 5 + (i-1)*2
  local value = redis.call('GET', key)
  if ARGV[j] == 'missing' then
    if value then return 0 end
  elseif value ~= ARGV[j+1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[4])
return 1`

/** The caller owns fresh file/config observations; Redis source bytes, target
 * bytes, receipt, idle locks and the host lease are compared in one EVAL.
 */
export async function migrateStandaloneLegacyMemoryState(input: ProofInput & {
  readonly redis: MigrationRedis
  readonly instance: string
  readonly apply: boolean
  readonly now: number
  isCurrent(): boolean
  allowsText(text: string): boolean
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.instance) || typeof input.apply !== 'boolean' || input.isCurrent() !== true) return failure('宿主或来源配置已改变')
  const proof = buildStandaloneLegacyMemorySourceProof(input), prefix = agentRedisPrefix(input.instance), { binding } = input
  const sourceKey = proof.source.key, targetKey = prefix + characterKey({ ...proof.source.scope, personaId: agentPersonaScopeId(binding.agentId) })
  const markerKey = prefix + 'agent:migration:qq-legacy-memory:v1:' + encodeURIComponent(agentConversationKey(binding))
  const address = simulationAddressKey(binding.target), locks = [prefix + 'agent:host-lease', sourceKey + ':lock', targetKey + ':lock',
    simulationBusyKey(binding.target.id), simulationBusyKey(address), prefix + simulationBusyKey(address)]
  const keys = [targetKey, markerKey, sourceKey, ...locks], values = await input.redis.mGet(keys)
  if (values.length !== keys.length || values.some(value => value !== null && typeof value !== 'string') || values[2] !== input.evidence.sourceRaw || input.isCurrent() !== true) return failure('来源或目标读取期间改变')
  const requiresOffline = values.slice(3).some(value => value !== null)
  if (input.apply && requiresOffline) return failure('应用接续前须停止Core并等待旧新角色锁与执行租约释放')
  const targetRaw = values[0] ?? null, priorMarker = values[1] ?? null
  const projected = projectStandaloneLegacyMemoryMigration({ ...input, proof, targetRaw })
  const base = { mode: input.apply ? 'applied' as const : 'preview' as const, requiresOffline }
  if (priorMarker !== null) {
    let marker: unknown
    try { marker = JSON.parse(priorMarker) } catch { return failure('已有迁移回执无效') }
    const row = record(marker), previousProof = record(row.proof), previousSource = record(previousProof.source), destination = record(previousProof.destination)
    if (row.version !== 1 || row.kind !== 'qq-implicit-default-memory' || previousSource.sha256 !== proof.source.sha256 ||
        JSON.stringify(canonical(previousSource.scope)) !== JSON.stringify(canonical(proof.source.scope)) || destination.scopeKey !== proof.destination.scopeKey) return failure('已有迁移回执与来源不符')
    // A later deletion/edit of imported data is authoritative; rerunning an
    // import must never resurrect it from the old immutable source partition.
    return { ...base, ...projected.report, importedMemories: 0, importedReceipts: 0,
      alreadyImportedMemories: Array.isArray(row.memories) ? row.memories.length : 0, alreadyApplied: true }
  }
  if (!input.isCurrent()) return failure('迁移期间来源或目标配置改变')
  if (input.apply && projected.receipt.memories.length) {
    const args = ['', '', JSON.stringify(projected.state), JSON.stringify(projected.receipt),
      ...values.flatMap(value => [value === null ? 'missing' : 'value', value ?? ''])]
    const result = Number(await input.redis.eval(legacyMemoryCas, { keys, arguments: args }))
    if (result === -1) return failure('Redis缺少目标迁移写入权限')
    if (result !== 1) return failure('来源、目标、锁或租约已改变，请重新预览')
  }
  return { ...base, ...projected.report, alreadyApplied: false }
}

export async function runStandaloneLegacyQqMemoryMigration(config: ReturnType<typeof readStandaloneAgentConfig>, options: {
  readonly sourceRoot: string
  readonly backupDir: string
  readonly connectionId: string
  readonly groupId: string
  readonly apply: boolean
}) {
  try {
    if (Object.keys(options).some(key => !['sourceRoot', 'backupDir', 'connectionId', 'groupId', 'apply'].includes(key)) || typeof options.apply !== 'boolean') return failure('显式迁移参数无效')
    text(options.sourceRoot); text(options.backupDir); text(options.connectionId); text(options.groupId)
    const connection = config.connections.find(row => row.connection.id === options.connectionId)?.connection
    if (!connection || !config.isConfigCurrent()) return failure('连接或当前宿主配置无效')
    const target = { account: connection.account, kind: 'group' as const, id: options.groupId }, resolved = config.resolvePersona(target), binding = resolved?.binding
    if (!binding || binding.connectionId !== options.connectionId) return failure('目标不是已配置仿真群')
    const expectedToken = agentBindingToken(binding), redis = await connectAgentRedis(config.redisUrl)
    try {
      const captured = await acquireStandaloneLegacyMemoryEvidence({ sourceRoot: options.sourceRoot, backupDir: options.backupDir, binding, redis })
      const current = () => {
        try { const live = config.resolvePersona(target)?.binding; return config.isConfigCurrent() && !!live && agentBindingToken(live) === expectedToken && captured.isCurrent() } catch { return false }
      }
      const secrets: string[] = [], collectSecrets = (value: unknown, depth = 0): void => {
        if (!value || typeof value !== 'object' || depth > 12) return
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === 'string' && child && /(?:apikey|token|secret|password|authorization|cookie)$/iu.test(key)) secrets.push(child)
          else if (child && typeof child === 'object') collectSecrets(child, depth + 1)
        }
      }
      collectSecrets(config); collectSecrets(document(captured.evidence.configRaw))
      if (config.console.tokenEnv && process.env[config.console.tokenEnv]) secrets.push(process.env[config.console.tokenEnv]!)
      const words = createForbiddenWordGuard({ warn() {} }), secretCheck = createAgentSecretTextCheck(secrets)
      const result = await migrateStandaloneLegacyMemoryState({ evidence: captured.evidence, binding, redis, instance: config.instance,
        apply: options.apply, now: Date.now(), isCurrent: current, allowsText: value => secretCheck(value) && !words.findForbiddenWord(value, config.forbiddenWords) })
      return { instance: config.instance, connectionId: options.connectionId, groupId: options.groupId, ...result }
    } finally { await redis.close() }
  } catch { return failure('接续失败；请核验来源材料、目标绑定、离线状态及冲突后重新预览') }
}
