import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
if (sourceTest) {
  const ts = (await import('typescript')).default, sourceRoot = path.join(repo, 'src') + path.sep
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(sourceRoot).href)) {
        const url = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(url.href, context)
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
      return next(url, context)
    },
  })
}
const load = relative => import(pathToFileURL(path.join(sourceTest ? repo : release, sourceTest ? 'src' : 'dist/backend', sourceTest ? relative.replace(/\.js$/u, '.ts') : relative)).href)
const { createAgentDeferredActionExecutor, createAgentDeferredToolDefinition, createAgentDeferredMcpDefinition } = await load('modules/tools/infrastructure/agentDeferredActionExecutor.js')
const { createAgentDeferredActionPolicy } = await load('modules/tools/infrastructure/agentDeferredActionPolicy.js')
const { freezeDeferredAction } = await load('modules/commitments/infrastructure/agentDeferredActionData.js')
const { agentBindingIdentity, agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')

const at = 1_800_000_000_000
const binding = { source: 'configured', id: 'bind-a', revision: 'rev-a', agentId: 'daily', personaId: 'default', connectionId: 'qq-a',
  target: { account: { platform: 'qq', namespace: 'global', id: '90001' }, kind: 'group', id: '80001' } }
const creator = { platform: 'qq', namespace: 'global', id: '70001' }
function fixture(changes = {}) {
  const values = { enabled: true, mode: 'simulation', visible: true, authority: 'allowed', current: true, definitions: [], now: at, fresh: [], ...changes }
  const action = freezeDeferredAction({ tool: 'local_lookup', executor: 'builtin', definitionId: 'definition-1', params: { key: 'frozen-value' } })
  const definition = { name: action.tool, executor: action.executor, definitionId: action.definitionId, timeoutMs: 100,
    isCurrent: () => values.current, validate: input => typeof input.key === 'string', execute: async () => ({ status: 'succeeded', content: 'discard provider data' }) }
  values.definitions = [definition]
  const rule = { id: 'allow-one', revision: 'policy-1', bindingIdentity: agentBindingIdentity(binding), scopeKey: agentConversationKey(binding), creatorIds: [creator.id], tool: action.tool,
    executor: action.executor, definitionId: action.definitionId, maxDelayMs: 3600_000 }
  const executor = createAgentDeferredActionExecutor({ getDefinitions: () => values.definitions })
  const policy = createAgentDeferredActionPolicy({ getConfig: () => ({ enabled: values.enabled, rules: [rule] }), resolveDefinition: executor.resolve,
    mode: () => values.mode, isToolAllowed: () => values.visible, now: () => values.now,
    async verifyAuthority(input) { values.fresh.push(input); return values.authority } })
  const request = { binding, creator, action, source: { kind: 'message', messageId: 'source-msg', at }, dueAt: at + 60_000, requestText: '一分钟后查 key 并提醒我' }
  async function context(extra = {}) {
    const delegation = await policy.issue(request)
    assert.ok(delegation)
    const controller = new AbortController()
    return { kind: 'deferred', taskId: 'task-one', binding, creator, delegation, signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && policy.isCurrent(delegation, request),
      async ensureCurrent() { if (await policy.check(delegation, request) !== 'allowed') throw Error('revoked') }, ...extra }
  }
  return { values, action, definition, rule, executor, policy, request, context }
}

test('deferred policy defaults closed and never turns extraTools into delegation', async () => {
  for (const changes of [{ enabled: undefined }, { enabled: false }, { mode: 'text' }, { mode: 'private' }, { visible: false }]) {
    const f = fixture(changes)
    assert.equal(await f.policy.issue(f.request), undefined)
    assert.deepEqual(f.values.fresh, [])
  }
})

test('grant binds exact creator, source, schedule, frozen parameters and revocable rule revision', async () => {
  const f = fixture(), grant = await f.policy.issue(f.request)
  assert.equal(await f.policy.check(grant, f.request), 'allowed')
  assert.equal(f.policy.isCurrent(grant, { ...f.request, creator: { ...creator, id: 'other' } }), false)
  assert.equal(f.policy.isCurrent(grant, { ...f.request, binding: { ...binding, target: { ...binding.target, id: 'other-group' } } }), false)
  assert.equal(f.policy.isCurrent(grant, { ...f.request, dueAt: f.request.dueAt + 1 }), false)
  assert.equal(f.policy.isCurrent(grant, { ...f.request, source: { ...f.request.source, messageId: 'other' } }), false)
  assert.equal(f.policy.isCurrent(grant, { ...f.request, action: { ...f.action, params: { key: 'different' } } }), false)
  f.rule.revision = 'policy-2'
  assert.equal(await f.policy.check(grant, f.request), 'denied')
})

test('rule refuses new grants for another account or group sharing the binding identity', async () => {
  const f = fixture()
  for (const target of [{ ...binding.target, id: 'another-group' }, { ...binding.target, account: { ...binding.target.account, id: 'another-account' } }]) {
    const changed = { ...f.request, binding: { ...binding, target } }
    assert.equal(agentBindingIdentity(changed.binding), agentBindingIdentity(binding))
    assert.equal(await f.policy.issue(changed), undefined)
  }
  assert.deepEqual(f.values.fresh, [])
})

test('maximum scheduling delay retains an independent execution window and expires after it', async () => {
  const f = fixture()
  f.rule.maxDelayMs = 60_000
  const grant = await f.policy.issue(f.request)
  assert.ok(grant)
  assert.equal(grant.expiresAt, f.request.dueAt + 300_000)
  f.values.now = f.request.dueAt
  assert.equal(await f.policy.check(grant, f.request), 'allowed')
  f.values.now = grant.expiresAt - 1
  assert.equal(await f.policy.check(grant, f.request), 'allowed')
  f.values.now = grant.expiresAt
  assert.equal(await f.policy.check(grant, f.request), 'denied')
})

test('execution-window changes revoke existing grants and malformed bounds never issue', async () => {
  const f = fixture(), grant = await f.policy.issue(f.request)
  f.rule.executionWindowMs = 1000
  assert.equal(await f.policy.check(grant, f.request), 'denied')
  const shortGrant = await f.policy.issue(f.request)
  assert.equal(shortGrant.expiresAt, f.request.dueAt + 1000)
  for (const value of [0, 999, NaN, 86_400_001]) {
    f.rule.executionWindowMs = value
    assert.equal(await f.policy.issue(f.request), undefined)
  }
})

test('explicit migration approval gets a short execution window without changing an overdue schedule', async () => {
  const f = fixture()
  f.request.source = { kind: 'migration', id: 'old-1', sourceHash: 'a'.repeat(64), authorizedBy: 'operator', at }
  f.request.dueAt = at - 86_400_000
  const grant = await f.policy.issue(f.request)
  assert.ok(grant)
  assert.equal(grant.dueAt, f.request.dueAt)
  assert.equal(grant.expiresAt, at + 300_000)
  assert.equal(await f.policy.check(grant, f.request), 'allowed')
})

test('fresh identity and source checks are repeated, with unavailable distinct from revoked', async () => {
  const f = fixture(), grant = await f.policy.issue(f.request)
  f.values.authority = 'unavailable'
  assert.equal(await f.policy.check(grant, f.request), 'unavailable')
  f.values.authority = 'denied'
  assert.equal(await f.policy.check(grant, f.request), 'denied')
  assert.deepEqual(f.values.fresh.map(value => value.phase), ['create', 'execute', 'execute'])
  assert.equal(f.values.fresh[1].grant.id, grant.id)
})

test('revocation during async fresh authorization cannot issue or revive a grant', async () => {
  for (const revoke of [f => { f.values.enabled = false }, f => { f.rule.revision = 'policy-2' }]) {
    const f = fixture()
    let release, entered
    const started = new Promise(resolve => { entered = resolve })
    const policy = createAgentDeferredActionPolicy({ getConfig: () => ({ enabled: f.values.enabled, rules: [f.rule] }), resolveDefinition: f.executor.resolve,
      mode: () => 'simulation', isToolAllowed: () => true, now: () => at,
      verifyAuthority: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
    const issuance = policy.issue(f.request)
    await started
    revoke(f)
    release('allowed')
    assert.equal(await issuance, undefined)
  }
})

test('cancelling fresh authority prevents its second external query during issue and check', async () => {
  for (const phase of ['create', 'execute']) {
    const f = fixture(), grant = await f.policy.issue(f.request), controller = new AbortController()
    let release, entered, secondQueries = 0, capture
    const started = new Promise(resolve => { entered = resolve })
    const policy = createAgentDeferredActionPolicy({ getConfig: () => ({ enabled: true, rules: [f.rule] }), resolveDefinition: f.executor.resolve,
      mode: () => 'simulation', isToolAllowed: () => true, now: () => at,
      async verifyAuthority(input) {
        capture = input
        assert.equal(input.phase, phase)
        assert.equal(input.isCurrent(), true)
        entered()
        await new Promise(resolve => { release = resolve })
        if (input.signal.aborted || !input.isCurrent()) return 'denied'
        secondQueries++
        return 'allowed'
      } })
    const guard = { signal: controller.signal, isCurrent: () => !controller.signal.aborted }
    const operation = phase === 'create' ? policy.issue(f.request, guard) : policy.check(grant, f.request, guard)
    await started
    controller.abort()
    release()
    assert.equal(await operation, phase === 'create' ? undefined : 'denied')
    assert.equal(secondQueries, 0)
    assert.equal(capture.signal.aborted, true)
    assert.equal(capture.isCurrent(), false)
  }
})

test('offline authority guard tracks rule revocation without a supplied guard and closes on return', async () => {
  const f = fixture()
  let captured, secondQueries = 0
  const policy = createAgentDeferredActionPolicy({ getConfig: () => ({ enabled: f.values.enabled, rules: [f.rule] }), resolveDefinition: f.executor.resolve,
    mode: () => 'simulation', isToolAllowed: () => true, now: () => at,
    async verifyAuthority(input) {
      captured = input
      assert.equal(input.signal.aborted, false)
      assert.equal(input.isCurrent(), true)
      f.values.enabled = false
      if (!input.isCurrent()) return 'denied'
      secondQueries++
      return 'allowed'
    } })
  assert.equal(await policy.issue(f.request), undefined)
  assert.equal(secondQueries, 0)
  assert.equal(captured.signal.aborted, true)
  assert.equal(captured.isCurrent(), false)
  f.values.enabled = true
  assert.equal(captured.isCurrent(), false)
})

test('executor rejects changed generation, duplicate names and invalid schema before dispatch', async () => {
  for (const change of [f => { f.values.definitions = [{ ...f.definition, definitionId: 'definition-2' }] },
    f => { f.values.definitions = [f.definition, f.definition] }, f => { f.definition.validate = () => false }]) {
    const f = fixture(), context = await f.context()
    let calls = 0
    f.definition.execute = async () => { calls++; return { status: 'succeeded', content: '' } }
    change(f)
    assert.equal((await f.executor.execute(f.action, context)).status, 'failed')
    assert.equal(calls, 0)
  }
})

test('executor drops provider output and treats throws, timeout and malformed receipts as unknown without retry', async () => {
  for (const behavior of ['succeeded', 'failed', 'unknown', 'throw', 'timeout', 'malformed']) {
    const f = fixture(), context = await f.context()
    let calls = 0, operationSignal
    f.definition.timeoutMs = 10
    f.definition.execute = async (_params, selected) => {
      calls++; operationSignal = selected.signal
      if (behavior === 'throw') throw Error('private transport detail')
      if (behavior === 'timeout') return new Promise((_resolve, reject) => selected.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
      if (behavior === 'malformed') return { content: 'private provider result' }
      return { status: behavior, content: 'private provider result' }
    }
    const result = await f.executor.execute(f.action, context)
    assert.equal(result.status, ['succeeded', 'failed'].includes(behavior) ? behavior : 'unknown')
    assert.equal(calls, 1)
    assert.doesNotMatch(result.content, /private/)
    assert.equal(operationSignal.aborted, true)
  }
})

test('pre-dispatch authorization timeout is bounded and cannot call the tool later', async () => {
  const f = fixture(), selected = await f.context()
  let calls = 0, release
  f.definition.timeoutMs = 10
  f.definition.execute = async () => { calls++; return { status: 'succeeded', content: '' } }
  selected.ensureCurrent = () => new Promise(resolve => { release = resolve })
  assert.equal((await f.executor.execute(f.action, selected)).status, 'failed')
  release()
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('builtin bridge keeps a commitment actor and rejects injected old human identity or request', async () => {
  const f = fixture()
  let selected
  const tool = { name: f.action.tool, description: '', parameters: { type: 'object', properties: {}, required: [] },
    async execute(input, context) { selected = context; assert.deepEqual(input, f.action.params); return { status: 'succeeded', content: '' } } }
  f.values.definitions = [createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
    isCurrent: () => true, validate: () => true, capabilities: () => ({ actor: { kind: 'user', user: creator }, request: { messageId: 'cached', text: 'cached master' }, botUserId: '90001', isMaster: true }) })]
  assert.equal((await f.executor.execute(f.action, await f.context())).status, 'succeeded')
  assert.deepEqual(selected.actor, { kind: 'commitment' })
  assert.equal(selected.request, undefined)
  assert.equal(selected.isMaster, undefined)
  assert.equal(selected.botUserId, '90001')
})

test('builtin deferred schemas are strict when issuing a grant and when dispatching an existing grant', async () => {
  const f = fixture()
  const context = await f.context()
  let calls = 0
  const tool = { name: f.action.tool, description: '', parameters: { type: 'object',
    properties: { key: { type: 'string', minLength: 20 } }, required: ['key'], additionalProperties: false },
  async execute() { calls++; return { status: 'succeeded', content: '' } } }
  const definition = createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
    isCurrent: () => true, validate: () => true })
  f.values.definitions = [definition]
  assert.equal(await f.policy.issue(f.request), undefined)
  assert.equal((await f.executor.execute(f.action, context)).status, 'failed')
  assert.equal((await definition.execute(f.action.params, context)).status, 'failed')
  assert.equal(calls, 0)
})

test('builtin deferred authorization projects the selected action before executing with a commitment actor', async () => {
  for (const effect of [input => ({ required: input.key === 'frozen-value' ? ['sendMessage'] : [] }),
    { conversation: 'private' }, { actor: 'user' }, 'read']) {
    const f = fixture()
    let executions = 0
    const tool = { name: f.action.tool, description: '', effect, parameters: { type: 'object', properties: {}, required: [] },
      async execute(_input, context) {
        executions++
        assert.deepEqual(context.actor, { kind: 'commitment' })
        assert.equal(context.request, undefined)
        assert.equal(context.readMember, undefined)
        return { status: 'succeeded', content: '' }
      } }
    f.values.definitions = [createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
      isCurrent: () => true, validate: () => true, capabilities: () => ({
        actor: { kind: 'user', user: creator }, request: { messageId: 'stale', text: 'stale', mentions: [] },
        readMember: async () => assert.fail('unselected capability invoked'),
      }) })]
    const result = await f.executor.execute(f.action, await f.context())
    assert.equal(result.status, effect === 'read' ? 'succeeded' : 'failed')
    assert.equal(executions, effect === 'read' ? 1 : 0)
  }
})

test('builtin bridge rechecks before each native capability and stops after revocation', async () => {
  const f = fixture()
  let sends = 0
  const tool = { name: f.action.tool, description: '', effect: { required: ['sendMessage'] }, parameters: { type: 'object', properties: {}, required: [] },
    async execute(_input, context) { await context.sendMessage({ text: 'one' }); await context.sendMessage({ text: 'two' }); return { status: 'succeeded', content: '' } } }
  f.values.definitions = [createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
    isCurrent: () => true, validate: () => true, capabilities: () => ({ sendMessage: async () => { sends++; f.values.authority = 'denied'; return { state: 'sent', messageId: 'one' } } }) })]
  assert.equal((await f.executor.execute(f.action, await f.context())).status, 'unknown')
  assert.equal(sends, 1)
})

test('unknown native results latch even when a builtin ignores them, catches errors and reports success', async () => {
  for (const first of ['sendMessage', 'interact', 'throw', 'malformed']) {
    const f = fixture()
    let messages = 0, interactions = 0, checks = 0
    const tool = { name: f.action.tool, description: '', parameters: { type: 'object', properties: {}, required: [] },
      async execute(_input, context) {
        try { if (first === 'interact') await context.interact({}); else await context.sendMessage({ text: 'first' }) } catch {}
        assert.equal(context.isCurrent(), false)
        assert.equal(context.signal.aborted, true)
        try { await context.sendMessage({ text: 'second' }) } catch {}
        try { await context.interact({}) } catch {}
        try { await context.readFile({}) } catch {}
        return { status: 'succeeded', content: 'ignored native unknown' }
      } }
    f.values.definitions = [createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
      isCurrent: () => true, validate: () => true, capabilities: () => ({
        sendMessage: async () => { messages++; if (first === 'throw') throw Error('possibly sent'); return first === 'malformed' ? undefined : { state: 'unknown' } },
        interact: async () => { interactions++; return { state: 'unknown', completed: 0, requested: 1 } },
        readFile: async () => { checks++; return {} },
      }) })]
    assert.equal((await f.executor.execute(f.action, await f.context())).status, 'unknown')
    assert.equal(messages, first === 'interact' ? 0 : 1)
    assert.equal(interactions, first === 'interact' ? 1 : 0)
    assert.equal(checks, 0)
  }
})

test('ordinary read results containing state unknown do not become delivery receipts', async () => {
  const f = fixture()
  let reads = 0, sends = 0
  const tool = { name: f.action.tool, description: '', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_input, context) { await context.readHistory({}); assert.equal(context.isCurrent(), true); await context.sendMessage({ text: 'one' }); return { status: 'succeeded', content: '' } } }
  f.values.definitions = [createAgentDeferredToolDefinition({ tool, executor: 'builtin', definitionId: f.action.definitionId,
    isCurrent: () => true, validate: () => true, capabilities: () => ({
      readHistory: async () => { reads++; return { state: 'unknown', external: 'ordinary data' } },
      sendMessage: async () => { sends++; return { state: 'sent', messageId: 'confirmed' } },
    }) })]
  assert.equal((await f.executor.execute(f.action, await f.context())).status, 'succeeded')
  assert.equal(reads, 1); assert.equal(sends, 1)
})

test('MCP bridge uses frozen original params and real result status without a user actor or output disclosure', async () => {
  for (const [reply, status] of [[{ content: [] }, 'succeeded'], [{ isError: true, content: [{ type: 'text', text: 'private-error' }] }, 'failed'],
    [undefined, 'unknown'], [{ content: [42] }, 'unknown'], [{ content: [{ type: 'text', text: 'HOST_PRIVATE_SECRET' }] }, 'unknown']]) {
    const f = fixture(), calls = []
    const mcp = createAgentDeferredMcpDefinition({ name: 'mcp_notes_lookup', remoteName: 'lookup', definitionId: 'mcp-generation-1',
      isCurrent: () => true, validate: value => value.key === 'frozen-value', secrets: ['HOST_PRIVATE_SECRET'],
      callTool: async (request, options) => { calls.push({ request, options }); return reply } })
    f.values.definitions = [mcp]
    const action = freezeDeferredAction({ ...f.action, tool: mcp.name, executor: 'mcp', definitionId: mcp.definitionId })
    Object.assign(f.rule, { tool: action.tool, executor: action.executor, definitionId: action.definitionId })
    Object.assign(f.request, { action })
    const result = await f.executor.execute(action, await f.context())
    assert.equal(result.status, status)
    assert.deepEqual(calls[0].request, { name: 'lookup', arguments: { key: 'frozen-value' } })
    assert.equal(Object.hasOwn(calls[0].request, 'actor'), false)
    assert.ok(calls[0].options.signal instanceof AbortSignal)
    assert.doesNotMatch(result.content, /private|HOST_PRIVATE_SECRET/)
    assert.equal(calls.length, 1)
  }
})

test('MCP generation revocation during response is unknown and does not retry', async () => {
  const f = fixture()
  let calls = 0, current = true
  const mcp = createAgentDeferredMcpDefinition({ name: 'mcp_notes_lookup', remoteName: 'lookup', definitionId: 'mcp-generation-1',
    isCurrent: () => current, validate: () => true, callTool: async () => { calls++; current = false; return { content: [] } } })
  f.values.definitions = [mcp]
  const action = freezeDeferredAction({ ...f.action, tool: mcp.name, executor: 'mcp', definitionId: mcp.definitionId })
  Object.assign(f.rule, { tool: action.tool, executor: action.executor, definitionId: action.definitionId })
  Object.assign(f.request, { action })
  assert.equal((await f.executor.execute(action, await f.context())).status, 'unknown')
  assert.equal(calls, 1)
})
