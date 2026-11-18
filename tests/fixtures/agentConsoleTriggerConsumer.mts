import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  compileAgentDiceRulePackage, createAgentBindingDirectory, createAgentDiceEngine,
  createAgentDiceRulePackages, createAgentDiceState, createAgentTextTrigger,
  createAgentTextTriggerState, evaluateAgentTextTrigger, recordAgentTextTriggerGate,
  recordAgentTextTriggerReply, resolveAgentTextTriggerConfig,
  type AgentBindingSnapshot, type AgentDiceCompiledRulePackage, type AgentDiceConfig,
  type AgentDiceEffectReceipt, type AgentDiceEngineAuthorization, type AgentDiceEngineConfig,
  type AgentDiceEngineContext, type AgentDiceEngineEffect, type AgentDiceEngineEvent,
  type AgentDiceEnginePermission, type AgentDiceEnginePorts, type AgentDiceRulePackageInput,
  type AgentDiceStateClaim, type AgentDiceStateGuard, type AgentDiceStateOperation,
  type AgentDiceStateRedis, type AgentDiceStateSnapshot, type AgentDiceTrustedPackage,
  type AgentTextTriggerConfig, type AgentTextTriggerContext, type AgentTextTriggerDecision,
  type AgentTextTriggerGuard, type AgentTextTriggerHistory, type AgentTextTriggerInput,
  type AgentTextTriggerPhase, type AgentTextTriggerPorts, type AgentTextTriggerPrefilter,
  type AgentTextTriggerReceipt, type AgentTextTriggerReply, type AgentTextTriggerRun,
  type AgentTextTriggerSelected, type AgentTextTriggerSmartConfig, type AgentTextTriggerStats,
  type AgentTextTriggerTalkOverride, type IncomingMessage, type ResolvedAgentTextTriggerConfig,
} from 'bl-chat-agent'
import { createStandaloneAgentConsole } from 'bl-chat-agent/console'
import {
  createStandaloneAgentConsoleAuth, openStandaloneAgentConsoleAuth,
  type StandaloneAgentConsoleAuth, type StandaloneAgentConsoleAuthOptions,
} from 'bl-chat-agent/console-auth'
import {
  createStandaloneAgentConsoleServices, type StandaloneAgentConsoleRuntime,
  type StandaloneAgentConsoleServicesPorts,
} from 'bl-chat-agent/console-services'
import {
  createStandaloneAgentConsoleRuntime, type StandaloneAgentConsoleRuntimePorts,
} from 'bl-chat-agent/console-runtime'

// Copy this file into a package consumer and compile with strict,
// exactOptionalPropertyTypes and noUncheckedIndexedAccess. No repository imports,
// environment credentials, native platform connections or model are required.
type ConsoleOptions = Parameters<typeof createStandaloneAgentConsole>[0]
type ConsoleGuard = Parameters<StandaloneAgentConsoleAuth['authenticate']>[1]

const directory = createAgentBindingDirectory({
  version: 1,
  agents: [{ id: 'consumer', personaId: 'default' }],
  connections: [{ id: 'consumer-qq', platform: 'qq', namespace: 'consumer', accountId: '23000101' }],
  bindings: [{ connectionId: 'consumer-qq', kind: 'group', conversationId: '310901', agentId: 'consumer' }],
}, 'consumer-revision-1')
const binding = directory.listBindings()[0]
assert.ok(binding, 'the public binding directory must resolve the configured conversation')
const bindings: ConsoleOptions['bindings'] = { list: directory.listBindings, resolve: directory.resolve }
const runtimeFactory: (ports: StandaloneAgentConsoleRuntimePorts) => StandaloneAgentConsoleRuntime = createStandaloneAgentConsoleRuntime
assert.equal(typeof runtimeFactory, 'function')
assert.equal(createStandaloneAgentConsoleAuth, openStandaloneAgentConsoleAuth)

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function checkConsole(selected: AgentBindingSnapshot): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-console-trigger-consumer-')))
  const frontendDir = path.join(root, 'frontend')
  const controller = new AbortController()
  const authority: ConsoleOptions['authority'] = { signal: controller.signal, isCurrent: () => !controller.signal.aborted }
  const guard: ConsoleGuard = {
    ...authority,
    ensureCurrent() { assert.equal(authority.isCurrent(), true) },
  }
  const token = randomBytes(32).toString('hex')
  const options: StandaloneAgentConsoleAuthOptions = {
    userFile: path.join(root, 'private', 'users.json'), authority,
    tokenEnv: 'CONSUMER_CONSOLE_TOKEN', env: { CONSUMER_CONSOLE_TOKEN: token },
    policy: {
      operations: ['bindings.list', 'bindings.read', 'providers.read'],
      async authorize(_principal, operation, candidate, lease) {
        lease.ensureCurrent()
        if (operation === 'bindings.read') return candidate?.id === selected.id ? 'allowed' : 'denied'
        return 'allowed'
      },
    },
  }
  let auth: StandaloneAgentConsoleAuth | undefined
  let app: ReturnType<typeof createStandaloneAgentConsole> | undefined
  try {
    await mkdir(frontendDir, { mode: 0o700 })
    await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Public consumer</title>')
    auth = await openStandaloneAgentConsoleAuth(options)
    const ports: StandaloneAgentConsoleServicesPorts = { bindings, auth }
    const services = createStandaloneAgentConsoleServices(ports)
    app = createStandaloneAgentConsole({
      frontendDir, host: '127.0.0.1', port: 0, auth, bindings, services, authority,
      allowsResponse: body => !Buffer.from(body).toString('utf8').includes(token),
    })
    const address = await app.listen()
    const base = `http://127.0.0.1:${address.port}`
    const request = (pathname: string, authenticated = true) => fetch(base + pathname, {
      headers: { connection: 'close', ...(authenticated ? { 'x-console-token': token } : {}) },
      signal: AbortSignal.timeout(5000),
    })
    const unauthenticated = await request('/api/bindings', false)
    assert.equal(unauthenticated.status, 401)
    assert.deepEqual(await unauthenticated.json(), { error: 'unauthorized' })

    const response = await request('/api/bindings')
    assert.equal(response.status, 200)
    const payload = object(await response.json())
    assert.ok(Array.isArray(payload.bindings))
    assert.equal(payload.bindings.length, 1)
    const row = object(payload.bindings[0])
    assert.deepEqual(row.binding, selected)
    assert.equal(typeof row.scopeKey, 'string')
    assert.equal(typeof row.bindingToken, 'string')
    const bindingToken = row.bindingToken
    assert.ok(typeof bindingToken === 'string' && bindingToken.length > 0)
    assert.equal(JSON.stringify(payload).includes(token), false)

    // The service mapper has no provider/config implementation in this consumer.
    const unavailable = await request('/api/ai/config')
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { error: 'unavailable' })

    const principal = await auth.authenticate({ token, cookie: '' }, guard)
    assert.ok(principal)
    assert.equal(auth.isCurrent(principal), true)
    await app.close()
    await app.close()
    assert.equal(app.server.listening, false)
    assert.equal(app.server.address(), null)
    await auth.close()
    await auth.close()
    assert.equal(auth.isCurrent(principal), false)

    // Rebinding the exact port proves close released the actual listening socket.
    const replacement = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject)
        replacement.listen(address.port, '127.0.0.1', resolve)
      })
      assert.equal(replacement.listening, true)
    } finally {
      if (replacement.listening) await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
    }
    return bindingToken
  } finally {
    controller.abort()
    await app?.close()
    await auth?.close()
    await rm(root, { recursive: true, force: true })
  }
}

function incoming(selected: AgentBindingSnapshot, messageId: string): IncomingMessage {
  return {
    version: 1, conversation: selected.target,
    sender: { platform: selected.target.account.platform, namespace: selected.target.account.namespace, id: '22000101' },
    messageId, occurredAt: Date.now(), text: 'Please acknowledge this direct message.',
    parts: [{ kind: 'text', text: 'Please acknowledge this direct message.' }], mentions: [], directedToAccount: true,
  }
}

async function checkTextTrigger(selected: AgentBindingSnapshot, bindingToken: string): Promise<void> {
  const override: AgentTextTriggerTalkOverride = { target: selected.target, value: 0.2 }
  const smart: AgentTextTriggerSmartConfig = {
    directTriggerMergeMs: 0, toolRequestMergeMs: 0, replyDebounceMs: 0,
    groupTalkValues: [override], repeatJoinEnabled: false, deferredGateEnabled: false,
  }
  const config: AgentTextTriggerConfig = { mode: 'strict', tracking: { enabled: false }, smart }
  const resolved: ResolvedAgentTextTriggerConfig = resolveAgentTextTriggerConfig(config)
  assert.equal(resolved.mode, 'strict')
  assert.equal(resolved.smart.directTriggerMergeMs, 0)
  assert.equal(resolved.smart.groupTalkValues.length, 1)
  const state = createAgentTextTriggerState()
  const message = incoming(selected, 'consumer-policy-1')
  const input: AgentTextTriggerInput = { binding: selected, bindingToken, message, state, config: resolved, now: message.occurredAt }
  const decision: AgentTextTriggerDecision = evaluateAgentTextTrigger(input)
  const prefilter: AgentTextTriggerPrefilter = decision.prefilter
  const stats: AgentTextTriggerStats = decision.stats
  const phase: AgentTextTriggerPhase = decision.phase
  assert.equal(decision.kind, 'forced')
  assert.equal(typeof prefilter.reason, 'string')
  assert.equal(typeof stats.hourMinute, 'string')
  assert.equal(phase, 'cold')
  recordAgentTextTriggerGate(state, 'continue', message.occurredAt, resolved)
  const reply: AgentTextTriggerReply = {
    message, bindingToken, text: 'Acknowledged.', now: message.occurredAt + 1, forced: true, latencyMs: 1,
  }
  assert.equal(recordAgentTextTriggerReply(state, reply, resolved), true)
  assert.equal(state.lastBotReplyToUserId, message.sender.id)
  assert.equal(state.recentReplyTimestamps.length, 1)

  const runs: AgentTextTriggerRun[] = []
  const history: readonly AgentTextTriggerHistory[] = []
  let releases = 0, gateCalls = 0, trackingCalls = 0
  const ports: AgentTextTriggerPorts<AgentTextTriggerSelected> = {
    config: () => config,
    async gate(_run, guard: AgentTextTriggerGuard) { await guard.ensureCurrent(); gateCalls++; return { decision: 'no_action', reason: 'unused-direct-path' } },
    async tracking(_run, guard) { await guard.ensureCurrent(); trackingCalls++; return false },
    async readHistory(_run, guard) { await guard.ensureCurrent(); return history },
    async reply(run, guard): Promise<AgentTextTriggerReceipt> {
      await guard.ensureCurrent()
      runs.push(run)
      return { state: 'sent', text: 'Acknowledged.', messageId: 'consumer-reply-1' }
    },
  }
  const scheduler = createAgentTextTrigger(ports)
  const controller = new AbortController()
  const context: AgentTextTriggerContext = {
    incoming: incoming(selected, 'consumer-scheduler-1'), selected: { binding: selected }, signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    async ensureCurrent() { assert.equal(controller.signal.aborted, false) },
    release() { releases++ },
  }
  try {
    scheduler.admit(context)
    await scheduler.drain()
    assert.equal(runs.length, 1)
    const run = runs[0]
    assert.ok(run)
    assert.equal(run.reason, 'direct')
    assert.equal(run.sources[0], context.incoming)
    assert.equal(run.selected.binding, selected)
    assert.equal(releases, 1)
    assert.equal(gateCalls, 0)
    assert.equal(trackingCalls, 0)
    scheduler.invalidate(selected.target)
    scheduler.invalidateAccount(selected.target.account)
  } finally {
    await scheduler.stop()
    controller.abort()
  }
  assert.equal(releases, 1)
}

async function checkDiceSurface(selected: AgentBindingSnapshot): Promise<void> {
  // JSON is a YAML subset: compilation validates the public package contract.
  // No JS/Seal source is supplied or instantiated, and no dice command executes.
  const source = JSON.stringify({
    version: 1, id: 'consumer-rules', name: 'Public consumer rules', aliases: ['consumer'],
    character: { fields: {} }, commands: [{ id: 'hello', aliases: ['hello'], output: 'Hello.' }],
  })
  const input: AgentDiceRulePackageInput = {
    kind: 'yaml', source, revision: 'consumer-v1', sourceHash: createHash('sha256').update(source).digest('hex'),
  }
  const trusted: AgentDiceTrustedPackage = { id: 'consumer-rules', revision: input.revision, sourceHash: input.sourceHash }
  const compiled: AgentDiceCompiledRulePackage = await compileAgentDiceRulePackage(input)
  const packages = await createAgentDiceRulePackages([input])
  assert.equal(compiled.id, trusted.id)
  assert.equal(compiled.kind, 'yaml')
  assert.deepEqual(compiled.commands, ['hello'])
  assert.equal(packages.packages[0]?.definitionId, compiled.definitionId)

  let storageCalls = 0, legacyCalls = 0, authorizationCalls = 0, deliveryCalls = 0
  const redis: AgentDiceStateRedis = {
    async get() { storageCalls++; throw new Error('consumer must not access dice storage') },
    async eval() { storageCalls++; throw new Error('consumer must not evaluate a dice transaction') },
  }
  const state = createAgentDiceState(redis)
  const permission: AgentDiceEnginePermission = 'player'
  const authorization: AgentDiceEngineAuthorization = {
    revision: 'consumer-v1', actor: { id: '22000101', name: 'Consumer' }, permissions: [permission], members: [],
  }
  const receipt: AgentDiceEffectReceipt = { state: 'unknown' }
  const enginePorts: AgentDiceEnginePorts = {
    state,
    legacyLedger: {
      async capture() { legacyCalls++; return { global: '0', scene: '0', recalled: false } },
      async read() { legacyCalls++; return undefined },
    },
    async authorize() { authorizationCalls++; return authorization },
    async deliver() { deliveryCalls++; return receipt },
    allowsText: () => true,
  }
  const legacyConfig: AgentDiceConfig = { enabled: true, maxDiceCount: 10, maxDiceSides: 100, maxRounds: 3 }
  const engineConfig: AgentDiceEngineConfig = { enabled: legacyConfig.enabled, revision: 'consumer-v1', rulePackages: packages.packages }
  const engine = createAgentDiceEngine(engineConfig, enginePorts)
  assert.equal(engine.isCandidate({ ...incoming(selected, 'consumer-dice-1'), text: '.r 1d6' }), true)
  assert.equal(engine.isCandidate({ ...incoming(selected, 'consumer-dice-2'), text: 'ordinary text' }), false)
  assert.equal(typeof engine.definitionId, 'string')

  // Exercise exported state types against their real method signatures without
  // claiming an external Redis transaction or executing business effects.
  const typedState: {
    begin: (binding: AgentBindingSnapshot, source: AgentDiceStateClaim['source'], guard?: AgentDiceStateGuard) => ReturnType<typeof state.begin>
    read: (binding: AgentBindingSnapshot, guard?: AgentDiceStateGuard) => Promise<AgentDiceStateSnapshot | null>
    commit: (binding: AgentBindingSnapshot, claim: AgentDiceStateClaim, payload: Parameters<typeof state.commit>[2], guard?: AgentDiceStateGuard) => Promise<AgentDiceStateOperation | undefined>
  } = state
  const controller = new AbortController()
  const context: AgentDiceEngineContext = {
    signal: controller.signal, isCurrent: () => !controller.signal.aborted,
    async ensureCurrent() { assert.equal(controller.signal.aborted, false) },
    async record(event: AgentDiceEngineEvent) { assert.equal(event.producer, 'agent-dice-engine') },
  }
  const effect: AgentDiceEngineEffect = { kind: 'public', text: 'compiled surface only' }
  assert.equal(typeof typedState.begin, 'function')
  assert.equal(typeof typedState.read, 'function')
  assert.equal(typeof typedState.commit, 'function')
  assert.equal(typeof context.record, 'function')
  assert.equal(effect.kind, 'public')
  controller.abort()
  assert.deepEqual([storageCalls, legacyCalls, authorizationCalls, deliveryCalls], [0, 0, 0, 0])
}

const bindingToken = await checkConsole(binding)
await checkTextTrigger(binding, bindingToken)
await checkDiceSurface(binding)
console.log('Public consumer passed: trigger policy/scheduler, dice compile/types, console auth/HTTP shutdown.')
