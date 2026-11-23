import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import YAML from 'yaml'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleCommittedResponse, AgentConsoleContext, AgentConsoleJson } from '../contracts/agentConsole.js'
import type { StandaloneAgentConsoleAssignmentPort, StandaloneAgentConsoleConfigPort, StandaloneAgentConsoleConfigurationPort, StandaloneAgentConsolePersonaPort, StandaloneAgentConsoleProviderPort } from './standaloneAgentConsoleServices.js'
import { acquireStandaloneAgentConfigLock, inspectStandaloneAgentConfigTransaction, inspectStandaloneAgentSourceSnapshot, isStandaloneAgentSourceSnapshotCurrent, observeStandaloneAgentSourceSnapshot } from './standaloneAgentConfigSources.js'
import { standalonePolicyView, updateStandalonePolicy } from './standaloneAgentConsolePolicies.js'
import { standaloneDiceConsoleView, updateStandaloneDiceConsole } from './standaloneAgentConsoleDice.js'
import { defaultAgentGroupPolicy, readAgentGroupPolicy, readAgentGroupPolicyValues } from '../modules/groupAdmin/domain/agentGroupPolicy.js'
import type { ConfigSourceName, ConfigSources, SourceSnapshot } from './standaloneAgentConfigSources.js'
import { createStandaloneAgentConsoleCommitCoordinator } from './standaloneAgentConsoleCommit.js'
import { agentBindingToken, agentConversationKey, createAgentBindingDirectory } from '../modules/runtime/domain/agentBindings.js'
import { validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { normalizePersonaEntry, PERSONA_ENTRY_FIELDS } from '../modules/conversation/infrastructure/personaLibrary.js'
import { createPersonaReplyGuard } from '../modules/conversation/domain/personaReplyGuard.js'
import { describeStandaloneAgentTopology, prepareStandaloneAgentTopologyChange } from './standaloneAgentConsoleTopology.js'
import { deltaForceSchema, turtleSoupSchema, umaRaceSchema } from '../modules/config/domain/schemas/shared/games.js'
import { resolveTurtleSoupConfig } from '../modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import { DEFAULT_CONFIG as UMA_DEFAULTS } from '../modules/games/infrastructure/uma/umaConstants.js'
import { TURTLE_NUMBERS, UMA_NUMBERS } from './standaloneGamesConfig.js'
import { createStandaloneAgentConsoleProviderProbe } from './standaloneAgentConsoleProviderProbe.js'
import type { createStandaloneAgentConsoleAccounts } from './standaloneAgentConsoleAccounts.js'

export type ConsoleModelSlot = 'model' | 'developmentModel' | 'vision' | 'personMemoryExtraction' | 'midtermSummary' | 'groupMemoryExtraction' | 'textTriggerModel'
export interface ConsoleModelView { readonly baseUrl: string; readonly name: string; readonly apiKeyEnv: string; readonly apiKeyConfigured: boolean }
export interface ValidatedConsoleCandidate {
  readonly dice: Readonly<{ enabled: boolean; maxDiceCount: number; maxDiceSides: number; maxRounds: number }>
  readonly persona: Readonly<Record<string, AgentConsoleJson>>
  readonly personaGuard: Readonly<Record<string, AgentConsoleJson>>
  readonly models: Readonly<Partial<Record<ConsoleModelSlot, ConsoleModelView>>>
}
export interface StandaloneConsolePersistenceOptions {
  readonly enabled?: boolean
  readonly hostFile: string
  readonly loaded: SourceSnapshot
  readonly authority: { readonly signal: AbortSignal; isCurrent(): boolean }
  readonly providerEnv?: NodeJS.ProcessEnv
  validateCandidate(sources: ConfigSources): ValidatedConsoleCandidate
}
type Data = Record<string, unknown>
const gameSettings = {
  turtleSoup: { prefix: 'games.turtleSoup', title: '海龟汤参数', fields: turtleSoupSchema, ranges: TURTLE_NUMBERS,
    defaults: { ...resolveTurtleSoupConfig({ miniGames: { enabled: false } }), enabled: false } },
  umaRace: { prefix: 'games.umaRace', title: '赛马娘参数', fields: umaRaceSchema, ranges: UMA_NUMBERS,
    defaults: { ...UMA_DEFAULTS, enabled: false } },
  deltaForce: { prefix: 'tools.deltaForce', title: '三角洲参数', fields: deltaForceSchema, ranges: {},
    defaults: { enabled: false, apiBaseUrl: '', apiKeyEnv: '', timeoutMs: 10_000, objectCacheEnabled: true, objectCacheRefreshMinutes: 360 } },
}
function gameSettingsFor(kind: string) {
  return kind === 'turtleSoup' || kind === 'umaRace' || kind === 'deltaForce' ? gameSettings[kind] : undefined
}
const slots: readonly ConsoleModelSlot[] = ['model', 'developmentModel', 'vision', 'personMemoryExtraction', 'midtermSummary', 'groupMemoryExtraction', 'textTriggerModel']
const slotTitles: Record<ConsoleModelSlot, string> = { model: '主对话', developmentModel: '开发', vision: '图片理解',
  personMemoryExtraction: '个人记忆提取', midtermSummary: '对话摘要', groupMemoryExtraction: '群记忆提取', textTriggerModel: '主动发言判断' }
const { normalizeConfig: normalizePersonaGuard } = createPersonaReplyGuard({ isToneCorrectionMessage: () => false })
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0] = 'invalid_request'): never => { throw new AgentConsoleError(code) }
const record = (value: unknown): Data => { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(); return value as Data }
const fields = (value: Data, allowed: readonly string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) fail() }
function text(value: unknown, max = 32768, empty = true): string {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return fail()
  return value
}
function id(value: unknown) { const result = text(value, 128, false); if (result.trim() !== result || /[\r\n\t]/u.test(result)) return fail(); return result }
const json = (value: unknown): AgentConsoleJson => JSON.parse(JSON.stringify(value)) as AgentConsoleJson
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
function document(source: string | undefined) {
  const doc: YAML.Document = YAML.parseDocument(source ?? '')
  if (doc.errors.length) return fail()
  if (doc.contents === null) doc.contents = doc.createNode({})
  record(doc.toJS())
  return doc
}
function personaField(key: string, value: unknown, input = true): AgentConsoleJson {
  if (['speechStyle', 'preferences', 'boundaries', 'badPatterns'].includes(key)) {
    if (!Array.isArray(value) || value.length > (key === 'badPatterns' ? 100 : 256)) return fail()
    return value.map(item => text(item, key === 'badPatterns' ? 300 : 1000))
  }
  if (key === 'moods') {
    if (!Array.isArray(value) || value.length > 100) return fail()
    return value.map(item => {
      const mood = record(item)
      if (input) fields(mood, ['name', 'hint', 'probability'])
      const result: Record<string, AgentConsoleJson> = { name: text(mood.name, 200, false), hint: text(mood.hint, 2000) }
      if (mood.probability !== undefined) {
        if (typeof mood.probability !== 'number' || !Number.isFinite(mood.probability) || mood.probability < 0 || mood.probability > 1) return fail()
        result.probability = mood.probability
      }
      return result
    })
  }
  return text(value, key === 'name' ? 200 : 32768, !input || key !== 'name')
}
function templates(value: unknown, input = false): Data[] {
  if (!Array.isArray(value) || value.length > 500) return fail()
  const seenIds = new Set<string>(), seenNames = new Set<string>()
  return value.map(item => {
    const raw = record(item)
    if (input) fields(raw, ['id', ...PERSONA_ENTRY_FIELDS])
    const key = id(raw.id), name = text(raw.name, 200, false).trim(), normalizedName = name.toLowerCase()
    if (key === 'default' || seenIds.has(key) || seenNames.has(normalizedName)) return fail()
    seenIds.add(key); seenNames.add(normalizedName)
    const cleaned: Data = { id: key }, normalized = input ? raw : normalizePersonaEntry(raw)
    for (const field of PERSONA_ENTRY_FIELDS) if (Object.hasOwn(normalized, field)) cleaned[field] = personaField(field, normalized[field], input)
    cleaned.name = name
    return { id: key, ...normalizePersonaEntry(cleaned) }
  })
}
function parsed(sources: ConfigSources, revision: string) {
  const host = document(sources.host), library = document(sources.personas), bindings = document(sources.bindings)
  const rawLibrary = record(library.toJS()), rawBindings = record(bindings.toJS())
  const personas = templates(rawLibrary.personas ?? [])
  const directory = createAgentBindingDirectory(rawBindings, revision, validateQqBindingAddress)
  const agents = (rawBindings.agents as Data[]).map(agent => ({ agentId: id(agent.id), personaId: id(agent.personaId) }))
  const ids = new Set(['default', ...personas.map(persona => String(persona.id))])
  if (agents.some(agent => !ids.has(agent.personaId))) return fail('conflict')
  return { host, library, bindings, rawLibrary, personas, agents, directory }
}
function replaceTemplates(doc: ReturnType<typeof document>, next: Data[]) {
  const current = doc.get('personas', true), sequence = YAML.isSeq(current) ? current : doc.createNode([])
  if (!YAML.isSeq(sequence)) return fail()
  const existing = new Map(sequence.items.filter(YAML.isMap).map(node => [String(node.get('id')), node]))
  sequence.items = next.map(persona => {
    const node = (existing.get(String(persona.id))?.clone() ?? doc.createNode({ id: persona.id })) as YAML.YAMLMap<unknown, unknown>
    if (!YAML.isMap(node)) return fail()
    const existingPersona = normalizePersonaEntry(record(node.toJSON()))
    for (const key of PERSONA_ENTRY_FIELDS) {
      if (Object.hasOwn(persona, key)) {
        if (Object.hasOwn(existingPersona, key) && equal(personaField(key, existingPersona[key], false), persona[key])) continue
        node.set(key, persona[key])
      }
      else node.delete(key)
    }
    return node
  })
  doc.set('personas', sequence)
}
interface Field { field: string; label: string; component: string; props?: Data; subFields?: Field[]; value: AgentConsoleJson; applyHint: string }
function field(key: string, label: string, component: string, value: unknown, props?: Data, subFields?: Field[]): Field {
  return { field: key, label, component, value: json(value), applyHint: '保存后重启服务生效', ...(props ? { props } : {}), ...(subFields ? { subFields } : {}) }
}
/** Explicitly installed only by the standalone host. No plugin globals or fallback configuration is used. */
export function createStandaloneAgentConsolePersistence(options: StandaloneConsolePersistenceOptions) {
  if (path.join(fs.realpathSync(path.dirname(path.resolve(options.hostFile))), path.basename(options.hostFile)) !== options.loaded.hostFile || !isStandaloneAgentSourceSnapshotCurrent(options.loaded)) return fail('conflict')
  const loaded = options.loaded, processEpoch = randomUUID(), retirement = new AbortController()
  const signal = AbortSignal.any([options.authority.signal, retirement.signal]), { port: commits, writer } = createStandaloneAgentConsoleCommitCoordinator()
  let retired = false, phase: 'active' | 'restart-required' | 'uncertain' = 'active', ownTransition: object | undefined
  const previews = new Map<string, { principal: string; revision: string; candidateDigest: string; expiresAt: number;
    deadline: number; bytes: number; readSet: SourceSnapshot['versions']; sources: ConfigSources; changed: number }>()
  const retire = (next: typeof phase, owner?: object) => {
    if (!retired) { retired = true; phase = next; ownTransition = owner; previews.clear(); retirement.abort() }
    else if (next === 'uncertain') phase = next
  }
  const hostCurrent = () => { try { return !options.authority.signal.aborted && options.authority.isCurrent() === true } catch { return false } }
  const execution = Object.freeze({ signal, processEpoch, loadedRevision: loaded.revision,
    isCurrent() {
      if (retired) return false
      if (!hostCurrent()) { retire('uncertain'); return false }
      if (!isStandaloneAgentSourceSnapshotCurrent(loaded)) { retire('restart-required'); return false }
      return true
    },
    observeCurrent(check: () => boolean): boolean {
      if (retired) return false
      if (!hostCurrent()) { retire('uncertain'); return false }
      const result = observeStandaloneAgentSourceSnapshot(loaded, () => {
        if (!execution.isCurrent()) return false
        const accepted = check()
        return accepted === true ? execution.isCurrent() : accepted
      })
      if (!result.current) retire('restart-required')
      return !retired && result.accepted
    },
  })
  function ensure(context: AgentConsoleContext) {
    context.ensureCurrent()
    if (options.enabled !== true) return fail('unavailable')
    if (!execution.isCurrent()) return fail('conflict')
  }
  function validate(sources: ConfigSources) {
    try {
      const result = options.validateCandidate(sources)
      if (!result || typeof result !== 'object' || typeof (result as { then?: unknown }).then === 'function') return fail()
      return clone(result)
    } catch (error) { if (error instanceof AgentConsoleError) throw error; return fail() }
  }
  const loadedCandidate = validate(loaded.sources)
  const probeModel = options.providerEnv && createStandaloneAgentConsoleProviderProbe(options.providerEnv, signal)
  if (options.enabled === true) parsed(loaded.sources, loaded.versions.bindings)
  function version(snapshot: SourceSnapshot, scope: string) { return createHash('sha256').update(JSON.stringify([snapshot.root, snapshot.revision, scope])).digest('hex') }
  const base = (snapshot: SourceSnapshot, scope: string) => ({ mode: 'standalone', revision: version(snapshot, scope), processEpoch, configRevision: snapshot.revision,
    capabilities: { requiresRestart: true, atomicMultiFile: true } })
  function schema(snapshot: SourceSnapshot, candidate: ValidatedConsoleCandidate, kind: string): Data {
    let selected: Field[]
    const hostDocument = document(snapshot.sources.host)
    const policy = standalonePolicyView(hostDocument, kind) ?? standaloneDiceConsoleView(hostDocument, kind)
    if (policy) return { ...base(snapshot, 'config:' + kind), key: kind, title: policy.title,
      groups: [{ label: '当前设置', fields: policy.fields }], ...('packages' in policy ? { packages: policy.packages } : {}) }
    const settings = gameSettingsFor(kind)
    if (settings) {
      const host = document(snapshot.sources.host)
      const defaults = settings.defaults as unknown as Data
      const ranges = settings.ranges as Readonly<Record<string, readonly [number, number]>>
      selected = settings.fields.flatMap(item => {
        const name = item.field?.split('.').at(-1)
        if (!name || item.field === 'miniGames.enabled' || kind === 'umaRace' && ['minPlayers', 'maxPlayers'].includes(name)) return []
        const key = name === 'apiKey' ? 'apiKeyEnv' : name
        const setting = settings.prefix + '.' + key
        const current = host.getIn(setting.split('.')) ?? defaults[key] ?? ''
        const range = ranges[key]
        const props = range ? { ...item.componentProps, min: range[0], max: range[1] } : item.componentProps
        return [field(setting, key === 'apiKeyEnv' ? '凭据环境变量名' : item.label ?? key,
          key === 'apiKeyEnv' ? 'Input' : item.component, current, props)]
      })
      return { ...base(snapshot, 'config:' + kind), key: kind, title: settings.title,
        groups: [{ label: '独立宿主配置', fields: selected }] }
    }
    if (kind === 'dice') selected = [field('dice.enabled', '启用骰子指令', 'Switch', candidate.dice.enabled),
      field('dice.maxDiceCount', '最大骰子数量', 'InputNumber', candidate.dice.maxDiceCount, { min: 1, max: 10000, step: 1 }),
      field('dice.maxDiceSides', '最大骰子面数', 'InputNumber', candidate.dice.maxDiceSides, { min: 2, max: 100000000, step: 1 }),
      field('dice.maxRounds', '最大轮数', 'InputNumber', candidate.dice.maxRounds, { min: 1, max: 1000, step: 1 })]
    else if (kind === 'persona') {
      const guard = normalizePersonaGuard(candidate.personaGuard)
      selected = PERSONA_ENTRY_FIELDS.map(key => field('persona.' + key, ({ name: '名字', identity: '身份定位', tone: '语气', speechStyle: '说话风格', preferences: '偏好', boundaries: '边界', notes: '备注', moods: '心情', reactions: '情境反应', samples: '回复示例', blacklist: '措辞黑名单' } as Record<string, string>)[key]!,
        key === 'moods' ? 'GSubForm' : ['speechStyle', 'preferences', 'boundaries'].includes(key) ? 'GTags' : key === 'name' ? 'Input' : 'InputTextArea',
        candidate.persona[key] === undefined ? (['speechStyle', 'preferences', 'boundaries', 'moods'].includes(key) ? [] : '') : personaField(key, candidate.persona[key], false), undefined,
        key === 'moods' ? [field('name', '心情名', 'Input', ''), field('hint', '提示', 'InputTextArea', ''), field('probability', '概率', 'InputNumber', 0.12, { min: 0, max: 1, step: 0.01 })] : undefined))
      for (const [key, label] of [['enabled', '启用回复守卫'], ['stripSelfDoubt', '移除自我怀疑'], ['stripCustomerTone', '弱化客服腔'], ['avoidUnpromptedIntimacy', '避免主动亲密称谓']] as const) selected.push(field('personaGuard.' + key, label, 'Switch', guard[key]))
      selected.push(field('personaGuard.maxPromptItems', '反馈注入条数', 'InputNumber', candidate.personaGuard.maxPromptItems ?? 4, { min: 0, max: 8, step: 1 }))
      selected.push(field('personaGuard.badPatterns', '坏模式', 'GTags', guard.badPatterns))
    } else return fail('not_found')
    return { ...base(snapshot, 'config:' + kind), key: kind, title: kind === 'dice' ? '骰子配置' : '默认人设与回复守卫', groups: [{ label: '独立宿主配置', fields: selected }] }
  }
  function ai(snapshot: SourceSnapshot, candidate: ValidatedConsoleCandidate): Data {
    const present = slots.filter(slot => slot === 'developmentModel' || candidate.models[slot] !== undefined)
    return { ...base(snapshot, 'providers'), definitions: present.map(configKey => ({ configKey, title: slotTitles[configKey], protocol: 'openai',
      ...(configKey === 'developmentModel' ? { fallbackConfigKey: 'model' } : {}),
      capabilities: { maxProviders: 1, credentialMode: 'env-ref', probe: !!probeModel } })), sections: Object.fromEntries(present.map(slot => {
        const model = candidate.models[slot]
        return [slot, model ? [{ baseUrl: model.baseUrl, name: model.name, apiKeyEnv: model.apiKeyEnv, apiKeyConfigured: model.apiKeyConfigured }] : []]
      })),
      revisions: Object.fromEntries(present.map(slot => [slot, version(snapshot, 'provider:' + slot)])) }
  }
  function library(snapshot: SourceSnapshot, candidate: ValidatedConsoleCandidate): Data {
    const data = parsed(snapshot.sources, snapshot.versions.bindings)
    return { ...base(snapshot, 'templates'), personas: data.personas, defaultPersona: Object.fromEntries(PERSONA_ENTRY_FIELDS.filter(key => Object.hasOwn(candidate.persona, key)).map(key => [key, personaField(key, candidate.persona[key], false)])),
      capabilities: { templates: true, assignmentsSeparate: true, atomicMultiFile: true, requiresRestart: true } }
  }
  function assignments(snapshot: SourceSnapshot): Data {
    const data = parsed(snapshot.sources, snapshot.versions.bindings)
    return { ...base(snapshot, 'assignments'), personas: [{ id: 'default', name: '默认人设' }, ...data.personas.map(persona => ({ id: persona.id, name: persona.name }))],
      agents: data.agents.map(agent => ({ ...agent, targets: data.directory.listBindings().filter(binding => binding.agentId === agent.agentId).map(binding => ({ connectionId: binding.connectionId, target: binding.target, scopeKey: agentConversationKey(binding), bindingToken: agentBindingToken(binding) })) })) }
  }
  async function saveSources(context: AgentConsoleContext, payload: Readonly<Data>, operation: string, scope: string,
    update: (snapshot: SourceSnapshot) => { sources: ConfigSources; changed: number }, project: (snapshot: SourceSnapshot, candidate: ValidatedConsoleCandidate) => Data): Promise<Data | AgentConsoleCommittedResponse> {
    ensure(context)
    const lock = await acquireStandaloneAgentConfigLock(loaded, context)
    let held = false, committed = false, fenced = false
    try {
      ensure(context)
      const before = lock.read()
      if (before.revision !== loaded.revision || payload.revision !== version(before, scope)) return fail(operation === 'configuration.commit' ? 'candidate_stale' : 'conflict')
      const receipt = writer.begin(context, operation, scope, before.revision, payload, lock.release)
      const next = update(before), candidateSources = next.changed === 0 ? before.sources : next.sources
      const normalized = validate(candidateSources)
      // Also validate IDs and all template references against the complete candidate read set.
      parsed(candidateSources, before.versions.bindings)
      const output = (snapshot: SourceSnapshot, transactionId?: string) => ({ changed: next.changed, requiresRestart: next.changed > 0, committedRevision: snapshot.revision,
        processEpoch, view: project(snapshot, normalized), ...(transactionId ? { transactionId } : {}) })
      // All secret checks and semantic projection run before a durable change.
      receipt.preflight(json(output({ ...before, sources: candidateSources })))
      if (next.changed === 0) { ensure(context); return output(before) }
      const transition = Object.freeze({})
      const transaction = lock.commitSources(candidateSources, before, {
        ensureActorCurrent() {
          if (!hostCurrent()) return fail('conflict')
          receipt.ensureAuthority(); lock.ensureCurrent()
          if (!fenced) ensure(context)
        },
        onFenced() { fenced = true; retire('restart-required', transition) },
        onCommitPublished() { committed = true; receipt.markCommitted() },
      })
      const after = transaction.snapshot
      held = true
      return receipt.complete(after.revision, processEpoch, json(output(after, transaction.txId)), () => {
        try { lock.ensureCurrent(); return ownTransition === transition && retired && phase === 'restart-required' && lock.read().revision === after.revision } catch { return false }
      })
    } catch (error) {
      if (fenced || committed) { retire('uncertain'); return fail(committed ? 'commit_outcome_unknown' : 'configuration_recovery_required') }
      // A failed publication may have retained a lease before onFenced was
      // reached. Release only what the journal permits, then inspect its gate.
      lock.release()
      if (inspectStandaloneAgentConfigTransaction(loaded.hostFile).phase !== 'clean') {
        retire('uncertain'); return fail('configuration_recovery_required')
      }
      if (error instanceof AgentConsoleError) throw error
      return fail('request_failed')
    } finally { if (!held) lock.release() }
  }
  async function save(context: AgentConsoleContext, payload: Readonly<Data>, operation: string, scope: string, target: ConfigSourceName,
    update: (state: ReturnType<typeof parsed>, candidate: ValidatedConsoleCandidate) => { source: string; changed: number }, project: (snapshot: SourceSnapshot, candidate: ValidatedConsoleCandidate) => Data): Promise<Data | AgentConsoleCommittedResponse> {
    return saveSources(context, payload, operation, scope, before => {
      const next = update(parsed(before.sources, before.versions.bindings), validate(before.sources))
      return { changed: next.changed, sources: next.changed === 0 ? before.sources : Object.freeze({ ...before.sources, [target]: next.source }) }
    }, project)
  }
  const config: StandaloneAgentConsoleConfigPort = {
    read(kind, context) { ensure(context); return schema(loaded, loadedCandidate, kind) },
    write(kind, payload, context) {
      fields(payload as Data, ['revision', 'values', 'secrets'])
      if (Object.keys(record(payload.secrets ?? {})).length) return fail()
      const values = record(payload.values ?? {})
      const view = schema(loaded, loadedCandidate, kind), defined = ((view.groups as Data[])[0]!.fields as Field[])
      if (Object.keys(values).some(key => !defined.some(item => item.field === key))) return fail()
      return save(context, payload, 'config.write', 'config:' + kind, 'host', (state, candidate) => {
        const policyChanges = updateStandalonePolicy(state.host, kind, values) ?? updateStandaloneDiceConsole(state.host, kind, values)
        if (policyChanges !== undefined) return { changed: policyChanges, source: String(state.host) }
        let changed = 0
        const current = schema(loaded, candidate, kind), existing = ((current.groups as Data[])[0]!.fields as Field[])
        for (const [key, value] of Object.entries(values)) {
          if (equal(value, existing.find(item => item.field === key)!.value)) continue
          const resource = gameSettingsFor(kind)
          if (resource) {
            const defined = existing.find(item => item.field === key)!
            if (defined.component === 'Switch' ? typeof value !== 'boolean'
              : defined.component === 'InputNumber' ? typeof value !== 'number' || !Number.isFinite(value)
                : typeof value !== 'string') return fail()
            if (state.host.getIn(resource.prefix.split('.')) === undefined) state.host.setIn(resource.prefix.split('.'), { enabled: false })
            state.host.setIn(key.split('.'), value)
            changed++
            continue
          }
          const [section, name] = key.split('.') as [string, string]
          let next: unknown = value
          if (section === 'dice') {
            if (name === 'enabled') { if (typeof value !== 'boolean') return fail() }
            else { const range = ({ maxDiceCount: [1, 10000], maxDiceSides: [2, 100000000], maxRounds: [1, 1000] } as Record<string, number[]>)[name]!; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range[0]! || value > range[1]!) return fail() }
          } else if (section === 'persona') next = name === 'name' ? text(value, 200).trim() : personaField(name, value)
          else if (name === 'badPatterns') next = personaField(name, value)
          else if (name === 'maxPromptItems') { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8) return fail() }
          else if (typeof value !== 'boolean') return fail()
          state.host.setIn([section, name], next); changed++
        }
        return { source: changed ? state.host.toString() : loaded.sources.host, changed }
      }, (snapshot, candidate) => schema(snapshot, candidate, kind))
    },
  }
  function groupAdminView(snapshot: SourceSnapshot, context: AgentConsoleContext) {
    const binding = context.binding!
    const host = document(snapshot.sources.host)
    const policy = readAgentGroupPolicy(host.toJS()?.groupAdmin)
    const row = policy.groups.find(item => item.connectionId === binding.connectionId && item.groupId === binding.target.id)
    const { connectionId: _connection, groupId: _group, ...overrides } = row ?? {}
    return { ...base(snapshot, 'group-admin:' + agentConversationKey(binding)), defaults: policy.defaults,
      values: policy.effective(binding.connectionId, binding.target.id), overrides }
  }
  const groupAdmin = {
    read(context: AgentConsoleContext) {
      ensure(context)
      if (context.binding?.target.kind !== 'group') return fail()
      return groupAdminView(loaded, context)
    },
    write(payload: Readonly<Data>, context: AgentConsoleContext) {
      const binding = context.binding
      if (binding?.target.kind !== 'group') return fail()
      fields(payload as Data, ['revision', 'values', 'resets'])
      let values: ReturnType<typeof readAgentGroupPolicyValues>
      try { values = readAgentGroupPolicyValues(payload.values ?? {}) } catch { return fail() }
      const resets = payload.resets ?? []
      if (!Array.isArray(resets) || resets.some(key => typeof key !== 'string' || !Object.hasOwn(defaultAgentGroupPolicy, key))) return fail()
      const scope = 'group-admin:' + agentConversationKey(binding)
      return save(context, payload, 'group-admin.write', scope, 'host', state => {
        const { groups } = readAgentGroupPolicy(state.host.toJS()?.groupAdmin)
        const index = groups.findIndex(row => row.connectionId === binding.connectionId && row.groupId === binding.target.id)
        const previous = index < 0 ? undefined : groups[index]
        const next = { ...previous, ...values, connectionId: binding.connectionId, groupId: binding.target.id }
        for (const key of resets) delete next[key as keyof typeof defaultAgentGroupPolicy]
        if (equal(next, previous) || !previous && Object.keys(next).length === 2) return { changed: 0, source: String(state.host) }
        const at = ['groupAdmin', 'groups']
        if (index < 0) {
          if (!state.host.hasIn(at)) state.host.setIn(at, [])
          state.host.addIn(at, next)
        } else if (Object.keys(next).length === 2) state.host.deleteIn([...at, index])
        else state.host.setIn([...at, index], next)
        return { changed: 1, source: String(state.host) }
      }, snapshot => groupAdminView(snapshot, context))
    },
  }
  const persona: StandaloneAgentConsolePersonaPort = {
    read(context) { ensure(context); return library(loaded, loadedCandidate) },
    write(payload, context) {
      fields(payload as Data, ['revision', 'personas'])
      const next = templates(payload.personas, true)
      return save(context, payload, 'persona.write', 'templates', 'personas', state => {
        const ids = new Set(['default', ...next.map(persona => String(persona.id))])
        if (state.agents.some(agent => !ids.has(agent.personaId))) return fail('conflict')
        for (const key of ['groupBindings', 'accountBindings']) for (const value of Object.values(record(state.rawLibrary[key] ?? {}))) if (typeof value === 'string' && value && !ids.has(value)) return fail('conflict')
        if (state.rawLibrary.privateBinding && !ids.has(String(state.rawLibrary.privateBinding))) return fail('conflict')
        if (equal(state.personas, next)) return { source: loaded.sources.personas ?? '', changed: 0 }
        replaceTemplates(state.library, next)
        return { source: state.library.toString(), changed: 1 }
      }, library)
    },
  }
  const savedModel = (value: unknown) => {
    const slot = id(value) as ConsoleModelSlot
    const model = slots.includes(slot) && (loadedCandidate.models[slot] ??
      (slot === 'developmentModel' ? loadedCandidate.models.model : undefined))
    if (!model) return fail('not_found')
    return model
  }
  const providers: StandaloneAgentConsoleProviderPort = {
    read(context) { ensure(context); return ai(loaded, loadedCandidate) },
    ...(probeModel ? {
      probe(payload: Readonly<Data>, context: AgentConsoleContext) {
        fields(payload as Data, ['configKey'])
        const model = savedModel(payload.configKey)
        return probeModel(model, model.name, context, () => ensure(context))
      },
      probeProvider(payload: Readonly<Data>, context: AgentConsoleContext) {
        const model = savedModel(payload.configKey), draft = record(payload.provider)
        fields(draft, ['baseUrl', 'name', 'apiKeyEnv'])
        let url: URL
        try { url = new URL(text(draft.baseUrl, 4096, false)) } catch { return fail() }
        if (url.href !== model.baseUrl || draft.apiKeyEnv !== model.apiKeyEnv) return fail('conflict')
        const name = text(draft.name, 200, false).trim()
        if (/[\r\n\t]/u.test(name)) return fail()
        return probeModel(model, name, context, () => ensure(context))
      },
    } : {}),
    write(payload, context) {
      fields(payload as Data, ['revision', 'configKey', 'providers'])
      const slot = id(payload.configKey) as ConsoleModelSlot
      if (!slots.includes(slot) || slot !== 'developmentModel' && !loadedCandidate.models[slot] || !Array.isArray(payload.providers)) return fail()
      if (slot === 'developmentModel' && payload.providers.length === 0) {
        return save(context, payload, 'providers.write', 'provider:' + slot, 'host', state => {
          if (!state.host.delete(slot)) return { source: loaded.sources.host, changed: 0 }
          return { source: state.host.toString(), changed: 1 }
        }, ai)
      }
      if (payload.providers.length !== 1) return fail()
      const provider = record(payload.providers[0]); fields(provider, ['baseUrl', 'name', 'apiKeyEnv'])
      const name = text(provider.name, 200, false).trim(), baseUrl = text(provider.baseUrl, 4096, false), apiKeyEnv = id(provider.apiKeyEnv)
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(apiKeyEnv)) return fail()
      let url: URL
      try { url = new URL(baseUrl) } catch { return fail() }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail()
      return save(context, payload, 'providers.write', 'provider:' + slot, 'host', (state, candidate) => {
        const next = { baseUrl: url.href, name, apiKeyEnv }, current = candidate.models[slot]
        if (current && equal(next, { baseUrl: current.baseUrl, name: current.name, apiKeyEnv: current.apiKeyEnv })) return { source: loaded.sources.host, changed: 0 }
        for (const [key, value] of Object.entries(next)) state.host.setIn([slot, key], value)
        return { source: state.host.toString(), changed: 1 }
      }, ai)
    },
  }
  const assignmentPort: StandaloneAgentConsoleAssignmentPort = {
    read(context) { ensure(context); return assignments(loaded) },
    write(payload, context) {
      fields(payload as Data, ['revision', 'agents'])
      if (!Array.isArray(payload.agents) || payload.agents.length > 10000) return fail()
      const seen = new Set<string>(), updates = payload.agents.map(value => {
        const agent = record(value); fields(agent, ['agentId', 'personaId'])
        const agentId = id(agent.agentId), personaId = id(agent.personaId)
        if (seen.has(agentId)) return fail(); seen.add(agentId)
        return { agentId, personaId }
      })
      return save(context, payload, 'persona-assignments.write', 'assignments', 'bindings', state => {
        const available = new Set(['default', ...state.personas.map(persona => String(persona.id))])
        let changed = 0
        const seq = state.bindings.get('agents', true)
        if (!YAML.isSeq(seq)) return fail()
        for (const update of updates) {
          const index = state.agents.findIndex(agent => agent.agentId === update.agentId)
          if (index < 0 || !available.has(update.personaId)) return fail('conflict')
          if (state.agents[index]!.personaId !== update.personaId) { state.bindings.setIn(['agents', index, 'personaId'], update.personaId); changed++ }
        }
        return { source: changed ? state.bindings.toString() : loaded.sources.bindings, changed }
      }, snapshot => assignments(snapshot))
    },
  }
  function catalog(snapshot: SourceSnapshot): Data {
    return { ...base(snapshot, 'configuration'), readSet: snapshot.versions, ...describeStandaloneAgentTopology(snapshot.sources) }
  }
  const configuration: StandaloneAgentConsoleConfigurationPort = {
    read(context) { ensure(context); return catalog(loaded) },
    preview(payload, context) {
      ensure(context); fields(payload as Data, ['revision', 'change'])
      if (payload.revision !== version(loaded, 'configuration')) return fail('conflict')
      const plan = prepareStandaloneAgentTopologyChange(loaded.sources, payload.change)
      validate(plan.sources); parsed(plan.sources, loaded.versions.bindings)
      ensure(context)
      const now = Date.now(), monotonic = performance.now()
      let retained = 0
      for (const [key, preview] of previews) {
        if (preview.expiresAt <= now || preview.deadline <= monotonic) previews.delete(key)
        else retained += preview.bytes
      }
      const bytes = Buffer.byteLength(plan.sources.host) + Buffer.byteLength(plan.sources.personas ?? '') + Buffer.byteLength(plan.sources.bindings)
      if (previews.size >= 32 || retained + bytes > 16 * 1024 * 1024) return fail('unavailable')
      const previewId = randomUUID(), candidateDigest = createHash('sha256')
        .update(JSON.stringify([processEpoch, loaded.revision, plan.sources.host, plan.sources.personas ?? null, plan.sources.bindings])).digest('hex')
      const expiresAt = now + 10 * 60_000
      previews.set(previewId, { principal: JSON.stringify(context.principal), revision: loaded.revision, candidateDigest,
        expiresAt, deadline: monotonic + 10 * 60_000, bytes, readSet: loaded.versions, sources: Object.freeze({ ...plan.sources }), changed: plan.changes.length })
      // Candidate bytes remain server-local; the browser receives only the safe projection.
      return { ...base(loaded, 'configuration'), previewId, candidateDigest, expiresAt, readSet: loaded.versions,
        requiresRestart: true, changes: plan.changes, affected: plan.affected, permissions: plan.permissions }
    },
    commit(payload, context) {
      fields(payload as Data, ['previewId', 'revision', 'candidateDigest', 'readSet'])
      const previewId = id(payload.previewId), candidateDigest = id(payload.candidateDigest), readSet = record(payload.readSet)
      fields(readSet, ['host', 'personas', 'bindings'])
      return saveSources(context, payload, 'configuration.commit', 'configuration', before => {
        const preview = previews.get(previewId)
        if (!preview || preview.principal !== JSON.stringify(context.principal) || preview.revision !== before.revision ||
            preview.candidateDigest !== candidateDigest || preview.expiresAt <= Date.now() || preview.deadline <= performance.now() ||
            !equal(readSet, before.versions) || !equal(readSet, preview.readSet)) return fail('candidate_stale')
        previews.delete(previewId)
        return { sources: preview.sources, changed: preview.changed }
      }, snapshot => catalog(snapshot))
    },
  }
  function state(context: AgentConsoleContext): Record<string, AgentConsoleJson> {
    context.ensureCurrent()
    if (options.enabled !== true || !hostCurrent()) return fail('unavailable')
    execution.isCurrent()
    const transaction = inspectStandaloneAgentConfigTransaction(loaded.hostFile)
    let storedRevision = ''
    try { storedRevision = inspectStandaloneAgentSourceSnapshot(loaded).revision } catch { /* Unknown disk state is never presented as active. */ }
    return { processEpoch, loadedRevision: loaded.revision, storedRevision, requiresRestart: retired || storedRevision !== loaded.revision,
      phase: storedRevision === '' || transaction.phase !== 'clean' ? 'uncertain' : phase, recoveryRequired: transaction.phase !== 'clean', transaction: json(transaction) }
  }
  function enrollmentState(context: AgentConsoleContext) {
    ensure(context)
    return base(loaded, 'accounts:add')
  }
  async function enrollAccount(payload: Data, context: AgentConsoleContext,
    provision: ReturnType<typeof createStandaloneAgentConsoleAccounts>['provision']) {
    ensure(context)
    fields(payload, ['accountId', 'revision'])
    const accountId = id(payload.accountId)
    if (!/^[1-9]\d{4,11}$/u.test(accountId)) return fail()
    if (payload.revision !== version(loaded, 'accounts:add')) return fail('conflict')
    const state = parsed(loaded.sources, loaded.versions.bindings)
    const existing = (state.bindings.toJS()?.connections ?? []) as Data[]
    if (existing.some(row => row.accountId === accountId || row.id === 'qq-' + accountId)) return fail('conflict')
    const { login, url } = await provision(accountId, context)
    return saveSources(context, payload, 'accounts.add', 'accounts:add', snapshot => {
      const next = parsed(snapshot.sources, snapshot.versions.bindings)
      next.host.addIn(['connections'], { id: login.connectionId, url, transport: 'forward-websocket', accessTokenEnv: login.tokenEnv })
      if (!next.host.hasIn(['console', 'qqLogin'])) next.host.setIn(['console', 'qqLogin'], [])
      next.host.addIn(['console', 'qqLogin'], login)
      next.bindings.addIn(['connections'], { id: login.connectionId, platform: 'qq', namespace: 'global', accountId })
      return { changed: 3, sources: { host: String(next.host), personas: snapshot.sources.personas, bindings: String(next.bindings) } }
    }, snapshot => ({ ...base(snapshot, 'accounts:add'), id: login.connectionId, accountId }))
  }
  return { execution, commits, config, groupAdmin, persona, providers, assignments: assignmentPort, configuration, state, enrollmentState, enrollAccount }
}
