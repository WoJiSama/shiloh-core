import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const { importBilibiliHost: load } = await import('./helpers/bilibiliQualitySource.mjs')
const [{ createStandaloneAgentConsolePersistence: persistence }, { readStandaloneAgentSourceSnapshot: snapshot, inspectStandaloneAgentConfigTransaction: inspectTransaction },
  { createStandaloneAgentConsole }, { createStandaloneAgentConsoleServices }, { AgentConsoleError },
  { createAgentBindingConfig }] = await Promise.all([
  load('bootstrap/standaloneAgentConsolePersistence.js'), load('bootstrap/standaloneAgentConfigSources.js'),
  load('bootstrap/standaloneAgentConsole.js'), load('bootstrap/standaloneAgentConsoleServices.js'), load('contracts/agentConsole.js'),
  load('modules/runtime/infrastructure/agentBindingConfig.js'),
])
const token = 'fixture-console-token-6aac', secret = 'fixture-server-model-secret-cab4'
const slots = ['model', 'vision', 'personMemoryExtraction', 'midtermSummary', 'groupMemoryExtraction', 'textTriggerModel']
const models = () => Object.fromEntries(slots.map(slot => [slot, { baseUrl: 'https://models.example.test/v1/', name: `${slot}-v1`, apiKeyEnv: slot === 'model' ? 'MODEL_KEY' : `${slot.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase()}_KEY` }]))
const bindingsObject = () => ({ version: 1,
  agents: [{ id: 'daily', personaId: 'default' }, { id: 'reader', personaId: 'p-one' }],
  connections: [{ id: 'qq-main', platform: 'qq', namespace: 'global', accountId: '23000101' }],
  bindings: [
    { connectionId: 'qq-main', kind: 'group', conversationId: '310901', agentId: 'daily' },
    { connectionId: 'qq-main', kind: 'private', conversationId: '23000123', agentId: 'reader' },
  ],
})
// The injected validator models the pure startup contract, without model, QQ or Redis I/O.
function validateCandidate(sources) {
  const host = YAML.parse(sources.host)
  if (host.version !== 1 || typeof host.instance !== 'string') throw new Error('fixture invalid host')
  const dice = { enabled: false, maxDiceCount: 100, maxDiceSides: 100000, maxRounds: 20, ...host.dice }
  if (typeof dice.enabled !== 'boolean') throw new Error('fixture invalid dice')
  for (const [key, lower, upper] of [['maxDiceCount', 1, 10000], ['maxDiceSides', 2, 100000000], ['maxRounds', 1, 1000]])
    if (!Number.isSafeInteger(dice[key]) || dice[key] < lower || dice[key] > upper) throw new Error('fixture invalid dice')
  const models = {}
  for (const slot of slots) if (host[slot] !== undefined) {
    const provider = host[slot], url = new URL(provider.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(provider.apiKeyEnv) || !provider.name?.trim()) throw new Error('fixture invalid provider')
    models[slot] = { baseUrl: url.href, name: provider.name.trim(), apiKeyEnv: provider.apiKeyEnv, apiKeyConfigured: true }
  }
  YAML.parse(sources.bindings); if (sources.personas !== undefined) YAML.parse(sources.personas)
  return { dice, persona: host.persona ?? {}, personaGuard: host.personaGuard ?? {}, models }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-console-persist-')), root = fs.realpathSync(directory), hostFile = path.join(root, 'agent-host.yaml')
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = { version: 1, instance: 'fixture', dataDir: './retained-data', ...models(), dice: { enabled: false, maxDiceCount: 100, maxDiceSides: 100000, maxRounds: 20 },
    persona: { name: 'Default persona', identity: 'default identity' }, personaGuard: { enabled: true }, extensionOwned: { preserve: 'this field' } }
  if (options.diceEngine !== undefined) host.dice.engine = options.diceEngine
  await writeFile(hostFile, '# host comment\n' + YAML.stringify(host))
  const bindingData = bindingsObject()
  if (options.noLibrary) bindingData.agents[1].personaId = 'default'
  await writeFile(path.join(root, 'agent-bindings.yaml'), '# topology comment\n' + YAML.stringify(bindingData))
  if (!options.noLibrary) await writeFile(path.join(root, 'persona-library.yaml'), options.librarySource ?? '# library comment\npersonas:\n  - id: p-one\n    name: Library one\n    identity: first identity # identity comment\n    extensionOwned: retained\n  - id: p-two\n    name: Library two\n    identity: second identity\ngroupBindings: {}\naccountBindings: {}\nprivateBinding: ""\nextensionOwned: library-root\n')
  const frontendDir = path.join(root, 'frontend'); await mkdir(frontendDir); await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>fixture</title>')
  const lifetime = new AbortController(), control = { session: true, lease: true, filter: true, forbidden: new Set() }
  const authority = { signal: lifetime.signal, isCurrent: () => control.lease }
  const owned = persistence({ enabled: options.enabled ?? true, hostFile, loaded: snapshot(hostFile), authority, validateCandidate: options.validateCandidate ?? validateCandidate })
  const readBindings = createAgentBindingConfig(path.join(root, 'agent-bindings.yaml'))
  const bindings = { list: () => readBindings().listBindings(), resolve: target => readBindings().resolve(target) }
  const principal = { id: 'fixture-session', username: 'admin', via: 'session' }
  const auth = {
    async state(_credentials, guard) { guard.ensureCurrent(); return { hasUser: true, username: control.session ? 'admin' : null, tokenWorks: false, via: control.session ? 'session' : null } },
    async authenticate(credentials, guard) { guard.ensureCurrent(); return credentials.token === token && control.session ? principal : undefined },
    async authorize(_principal, operation, _binding, guard) { guard.ensureCurrent(); return control.forbidden.has(operation) ? 'denied' : 'allowed' },
    isCurrent: () => control.session,
    async run() { return { username: 'admin' } },
  }
  let services = createStandaloneAgentConsoleServices({ bindings, auth, config: owned.config, persona: owned.persona, providers: owned.providers,
    assignments: owned.assignments, configState: owned.state, commits: owned.commits })
  if (options.wrapServices) services = options.wrapServices(services, { owned, control, principal, root, hostFile })
  const app = createStandaloneAgentConsole({ frontendDir, port: 0, authority, execution: owned.execution, commits: owned.commits, auth, bindings, services,
    allowsResponse: body => control.filter && ![token, secret].some(value => Buffer.from(body).toString().includes(value)) })
  t.after(() => app.close())
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`
  async function request(route, { method = 'GET', body, signal } = {}) {
    const response = await fetch(base + route, { method, headers: { 'x-console-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })
    const text = await response.text()
    return { status: response.status, text, data: JSON.parse(text) }
  }
  async function files() {
    return Object.fromEntries(await Promise.all(['agent-host.yaml', 'persona-library.yaml', 'agent-bindings.yaml'].map(async name => [name, await readFile(path.join(root, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })])))
  }
  return { root, hostFile, owned, control, lifetime, app, request, files, principal, base }
}
const fieldsOf = view => Object.fromEntries(view.groups.flatMap(group => group.fields).map(field => [field.field, field.value]))
const put = (f, path, body, signal) => f.request(path, { method: 'PUT', body, signal })
const waitFor = async predicate => {
  const end = Date.now() + 2000
  while (!predicate()) { if (Date.now() > end) throw new Error('fixture condition did not become true'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('host dice save returns its canonical view, retires execution immediately and reloads on a new process epoch', async t => {
  const f = await fixture(t), before = await f.files(), view = (await f.request('/api/config/dice')).data
  assert.deepEqual(Object.keys(fieldsOf(view)), ['dice.enabled', 'dice.maxDiceCount', 'dice.maxDiceSides', 'dice.maxRounds'])
  let retiredBeforeReply = false
  f.owned.execution.signal.addEventListener('abort', () => { retiredBeforeReply = true }, { once: true })
  const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.enabled': true, 'dice.maxRounds': 42 }, secrets: {} })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.data.changed, 2); assert.equal(result.data.requiresRestart, true)
  assert.equal(retiredBeforeReply, true); assert.equal(f.owned.execution.isCurrent(), false)
  assert.equal(f.owned.execution.signal.aborted, true)
  assert.equal(fieldsOf(result.data.view)['dice.maxRounds'], 42)
  assert.equal(result.data.view.configRevision, result.data.committedRevision)
  const after = await f.files(), parsed = YAML.parse(after['agent-host.yaml'])
  assert.equal(parsed.dice.enabled, true); assert.equal(parsed.dice.maxRounds, 42)
  assert.deepEqual(parsed.extensionOwned, { preserve: 'this field' }); assert.equal(parsed.dataDir, './retained-data')
  assert.match(after['agent-host.yaml'], /# host comment/u)
  assert.equal(after['persona-library.yaml'], before['persona-library.yaml']); assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
  assert.equal((await f.request('/api/config/dice')).status, 409)
  assert.equal((await f.request('/api/ai/config')).status, 409)
  assert.equal((await put(f, '/api/config/dice', { revision: result.data.view.revision, values: { 'dice.maxRounds': 43 } })).status, 409)
  assert.equal((await f.request('/api/auth/state')).status, 200)
  const state = await f.request('/api/config-state')
  assert.equal(state.status, 200); assert.equal(state.data.requiresRestart, true)
  assert.equal(state.data.storedRevision, result.data.committedRevision)
  const fresh = persistence({ enabled: true, hostFile: f.hostFile, loaded: snapshot(f.hostFile), authority: { signal: new AbortController().signal, isCurrent: () => true }, validateCandidate })
  assert.notEqual(fresh.execution.processEpoch, f.owned.execution.processEpoch)
  assert.equal(fresh.execution.loadedRevision, result.data.committedRevision); assert.equal(fresh.execution.isCurrent(), true)
  assert.equal(f.owned.execution.isCurrent(), false)
})

test('root persona and reply guard save targets the host only and exposes no plugin-only fields', async t => {
  const f = await fixture(t), before = await f.files(), view = (await f.request('/api/config/persona')).data
  assert.equal(Object.keys(fieldsOf(view)).some(key => /globalStyleLearning|userProfiles|groupProfiles/u.test(key)), false)
  const result = await put(f, '/api/config/persona', { revision: view.revision, values: { 'persona.identity': 'new identity', 'persona.preferences': ['concise replies'], 'personaGuard.stripSelfDoubt': false } })
  assert.equal(result.status, 200, result.text)
  assert.equal(fieldsOf(result.data.view)['persona.identity'], 'new identity')
  const after = await f.files(), host = YAML.parse(after['agent-host.yaml'])
  assert.equal(host.persona.identity, 'new identity'); assert.deepEqual(host.persona.preferences, ['concise replies']); assert.equal(host.personaGuard.stripSelfDoubt, false)
  assert.equal(after['persona-library.yaml'], before['persona-library.yaml']); assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
  assert.equal(host.pluginSettings, undefined)
})

test('editing an exposed dice field preserves an opaque engine subtree without publishing it in canonical views', async t => {
  const engine = { enabled: false, runner: { path: './dice-private-runner', privateSentinel: 'DICE_ENGINE_PRIVATE_6148' },
    grants: [{ bindingToken: 'opaque-existing-grant', authority: { connectionId: 'qq-main', accountId: '23000101', operations: ['roll', 'sheet.write'] }, extensionOwned: { retained: true } }],
    extra: ['retained', { option: true }] }
  const f = await fixture(t, { diceEngine: engine }), view = await f.request('/api/config/dice')
  assert.equal(view.status, 200, view.text)
  assert.deepEqual(Object.keys(fieldsOf(view.data)), ['dice.enabled', 'dice.maxDiceCount', 'dice.maxDiceSides', 'dice.maxRounds'])
  assert.equal(view.text.includes('DICE_ENGINE_PRIVATE_6148'), false)
  const result = await put(f, '/api/config/dice', { revision: view.data.revision, values: { 'dice.maxRounds': 28 } })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.text.includes('DICE_ENGINE_PRIVATE_6148'), false)
  const stored = YAML.parse((await f.files())['agent-host.yaml'])
  assert.equal(stored.dice.maxRounds, 28); assert.deepEqual(stored.dice.engine, engine)
})

test('each of the six real model slots saves one environment-reference provider in the host', async t => {
  for (const slot of slots) await t.test(slot, async t => {
    const f = await fixture(t), before = await f.files(), view = (await f.request('/api/ai/config')).data
    assert.deepEqual(view.definitions.map(definition => definition.configKey), slots)
    assert.equal(JSON.stringify(view).includes(secret), false)
    assert.equal(view.sections[slot].length, 1)
    const result = await put(f, '/api/ai/config', { revision: view.revisions[slot], configKey: slot,
      providers: [{ baseUrl: 'https://other.example.test/v1', name: `${slot}-v2`, apiKeyEnv: 'SECOND_MODEL_KEY' }] })
    assert.equal(result.status, 200, result.text)
    assert.equal(result.data.requiresRestart, true); assert.equal(result.data.view.sections[slot][0].name, `${slot}-v2`)
    const after = await f.files(), host = YAML.parse(after['agent-host.yaml'])
    assert.deepEqual(host[slot], { baseUrl: 'https://other.example.test/v1', name: `${slot}-v2`, apiKeyEnv: 'SECOND_MODEL_KEY' })
    for (const other of slots.filter(value => value !== slot)) assert.deepEqual(host[other], YAML.parse(before['agent-host.yaml'])[other])
    assert.equal(after['persona-library.yaml'], before['persona-library.yaml']); assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
    assert.equal(result.text.includes('apiKey"'), false); assert.equal(result.text.includes(secret), false)
  })
})

test('template save changes only the library and preserves unrelated YAML nodes and comments', async t => {
  const f = await fixture(t), before = await f.files(), view = (await f.request('/api/persona/library')).data
  const personas = structuredClone(view.personas); personas[0].identity = 'edited identity'; personas.push({ id: 'p-three', name: 'Library three', tone: 'gentle' })
  const result = await put(f, '/api/persona/library', { revision: view.revision, personas })
  assert.equal(result.status, 200, result.text)
  assert.deepEqual(result.data.view.personas, personas); assert.equal(result.data.requiresRestart, true)
  const after = await f.files(), library = YAML.parse(after['persona-library.yaml'])
  assert.equal(after['agent-host.yaml'], before['agent-host.yaml']); assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
  assert.equal(library.personas[0].extensionOwned, 'retained'); assert.equal(library.extensionOwned, 'library-root')
  assert.match(after['persona-library.yaml'], /# library comment/u); assert.match(after['persona-library.yaml'], /# identity comment/u)
})

test('canonical HTTP views explicitly project validator output instead of exposing unknown secret extensions', async t => {
  const privateSentinel = 'SENTINEL_PARENT_VALIDATOR_PRIVATE_4916'
  const extendedValidator = sources => {
    const candidate = validateCandidate(sources)
    candidate.models.model = { ...candidate.models.model, apiKey: privateSentinel, privateSentinel }
    candidate.persona = { ...candidate.persona, privateSentinel, apiKey: privateSentinel }
    candidate.personaGuard = { ...candidate.personaGuard, privateSentinel }
    return candidate
  }
  await t.test('provider GET and committed response', async t => {
    const f = await fixture(t, { validateCandidate: extendedValidator }), view = await f.request('/api/ai/config')
    assert.equal(view.status, 200, view.text)
    assert.equal(view.text.includes(privateSentinel), false)
    assert.deepEqual(Object.keys(view.data.sections.model[0]).sort(), ['apiKeyConfigured', 'apiKeyEnv', 'baseUrl', 'name'])
    const result = await put(f, '/api/ai/config', { revision: view.data.revisions.model, configKey: 'model', providers: [{ baseUrl: 'https://other.example.test/v1', name: 'safe-model', apiKeyEnv: 'MODEL_KEY' }] })
    assert.equal(result.status, 200, result.text)
    assert.equal(result.text.includes(privateSentinel), false)
    assert.deepEqual(Object.keys(result.data.view.sections.model[0]).sort(), ['apiKeyConfigured', 'apiKeyEnv', 'baseUrl', 'name'])
  })
  await t.test('persona GET and committed response', async t => {
    const f = await fixture(t, { validateCandidate: extendedValidator }), view = await f.request('/api/persona/library')
    assert.equal(view.status, 200, view.text)
    assert.equal(view.text.includes(privateSentinel), false)
    assert.equal(view.data.defaultPersona.privateSentinel, undefined); assert.equal(view.data.defaultPersona.apiKey, undefined)
    const personas = structuredClone(view.data.personas); personas[0].identity = 'new safe identity'
    const result = await put(f, '/api/persona/library', { revision: view.data.revision, personas })
    assert.equal(result.status, 200, result.text)
    assert.equal(result.text.includes(privateSentinel), false)
    assert.equal(result.data.view.defaultPersona.privateSentinel, undefined); assert.equal(result.data.view.defaultPersona.apiKey, undefined)
  })
})

test('template GET follows persona normalization and its unchanged resubmission preserves source bytes and epoch', async t => {
  const librarySource = '# raw template formatting must survive no-change\npersonas:\n  - id: p-one\n    name: "  Library one  "\n    identity: "  first identity  "\n    tone: "  warm  "\n    speechStyle: ["  concise  ", "", "  ", "  friendly "]\n    preferences: "  tea, , books，  walks  "\n    boundaries: ["", "   ", "  respect privacy  "]\n    extensionOwned: retained\ngroupBindings: {}\naccountBindings: {}\nprivateBinding: ""\n'
  const f = await fixture(t, { librarySource }), before = await f.files(), view = await f.request('/api/persona/library')
  assert.equal(view.status, 200, view.text)
  assert.deepEqual(view.data.personas, [{ id: 'p-one', name: 'Library one', identity: 'first identity', tone: 'warm',
    speechStyle: ['concise', 'friendly'], preferences: ['tea', 'books', 'walks'], boundaries: ['respect privacy'] }])
  const result = await put(f, '/api/persona/library', { revision: view.data.revision, personas: view.data.personas })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.data.changed, 0); assert.equal(result.data.requiresRestart, false)
  assert.equal(result.data.committedRevision, view.data.configRevision)
  assert.equal(f.owned.execution.isCurrent(), true); assert.equal(f.owned.execution.signal.aborted, false)
  assert.deepEqual(await f.files(), before)
})

test('template mood extensions stay private and survive an unrelated template edit', async t => {
  const sentinel = 'MOOD_PRIVATE_EXTENSION_8402', librarySource = '# moods retain opaque extensions\n' + YAML.stringify({ personas: [
    { id: 'p-one', name: 'Library one', identity: 'old identity', moods: [{ name: 'calm', hint: 'quiet reply', probability: 0.12, privateSentinel: sentinel, opaque: { retained: true } }] },
  ] })
  const f = await fixture(t, { librarySource }), view = await f.request('/api/persona/library')
  assert.equal(view.status, 200, view.text); assert.equal(view.text.includes(sentinel), false)
  assert.deepEqual(view.data.personas[0].moods, [{ name: 'calm', hint: 'quiet reply', probability: 0.12 }])
  const personas = structuredClone(view.data.personas); personas[0].identity = 'edited safe identity'
  const result = await put(f, '/api/persona/library', { revision: view.data.revision, personas })
  assert.equal(result.status, 200, result.text); assert.equal(result.text.includes(sentinel), false)
  assert.deepEqual(result.data.view.personas[0].moods, [{ name: 'calm', hint: 'quiet reply', probability: 0.12 }])
  const stored = YAML.parse((await f.files())['persona-library.yaml'])
  assert.equal(stored.personas[0].identity, 'edited safe identity')
  assert.deepEqual(stored.personas[0].moods, [{ name: 'calm', hint: 'quiet reply', probability: 0.12, privateSentinel: sentinel, opaque: { retained: true } }])
})

test('an absent library is created without modifying the host or binding topology', async t => {
  const f = await fixture(t, { noLibrary: true }), before = await f.files(), view = (await f.request('/api/persona/library')).data
  assert.deepEqual(view.personas, [])
  const result = await put(f, '/api/persona/library', { revision: view.revision, personas: [{ id: 'p-one', name: 'New template', identity: 'new identity' }] })
  assert.equal(result.status, 200, result.text)
  const after = await f.files()
  assert.equal(after['agent-host.yaml'], before['agent-host.yaml']); assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
  assert.equal(YAML.parse(after['persona-library.yaml']).personas[0].id, 'p-one')
})

test('assignment save identifies real agents and writes only their personaId without changing topology', async t => {
  const f = await fixture(t), before = await f.files(), view = (await f.request('/api/persona/assignments')).data
  const agent = view.agents.find(agent => agent.agentId === 'daily')
  assert.equal(agent.targets[0].target.account.id, '23000101'); assert.equal(agent.targets[0].target.id, '310901')
  const native = createAgentBindingConfig(path.join(f.root, 'agent-bindings.yaml'))().listBindings().find(binding => binding.agentId === 'daily')
  const { agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
  assert.equal(agent.targets[0].bindingToken, agentBindingToken(native))
  const result = await put(f, '/api/persona/assignments', { revision: view.revision, agents: [{ agentId: 'daily', personaId: 'p-two' }] })
  assert.equal(result.status, 200, result.text)
  const after = await f.files(), old = YAML.parse(before['agent-bindings.yaml']), next = YAML.parse(after['agent-bindings.yaml'])
  assert.deepEqual(next.connections, old.connections); assert.deepEqual(next.bindings, old.bindings)
  assert.equal(next.agents.find(agent => agent.id === 'daily').personaId, 'p-two')
  assert.equal(after['agent-host.yaml'], before['agent-host.yaml']); assert.equal(after['persona-library.yaml'], before['persona-library.yaml'])
  assert.match(after['agent-bindings.yaml'], /# topology comment/u)
  assert.equal(result.data.view.agents.find(agent => agent.agentId === 'daily').personaId, 'p-two')
})

test('no-change saves keep the same revisions, source bytes and execution authority for every write family', async t => {
  const f = await fixture(t), before = await f.files()
  const dice = (await f.request('/api/config/dice')).data, ai = (await f.request('/api/ai/config')).data,
    library = (await f.request('/api/persona/library')).data, assignments = (await f.request('/api/persona/assignments')).data
  for (const [route, body] of [
    ['/api/config/dice', { revision: dice.revision, values: { 'dice.maxRounds': 20 } }],
    ['/api/ai/config', { revision: ai.revisions.model, configKey: 'model', providers: [Object.fromEntries(Object.entries(ai.sections.model[0]).filter(([key]) => key !== 'apiKeyConfigured'))] }],
    ['/api/persona/library', { revision: library.revision, personas: library.personas }],
    ['/api/persona/assignments', { revision: assignments.revision, agents: assignments.agents.map(({ agentId, personaId }) => ({ agentId, personaId })) }],
  ]) {
    const result = await put(f, route, body)
    assert.equal(result.status, 200, result.text); assert.equal(result.data.changed, 0); assert.equal(result.data.requiresRestart, false)
    assert.equal(result.data.committedRevision, dice.configRevision)
    assert.equal(f.owned.execution.isCurrent(), true); assert.equal(f.owned.execution.signal.aborted, false)
  }
  assert.deepEqual(await f.files(), before)
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('.') && /config/u.test(name)), [])
})

test('unsupported fields, raw keys, multiple providers, mixed files and dangling references never change files', async t => {
  const f = await fixture(t), before = await f.files(), dice = (await f.request('/api/config/dice')).data,
    ai = (await f.request('/api/ai/config')).data, library = (await f.request('/api/persona/library')).data, assignments = (await f.request('/api/persona/assignments')).data
  const provider = { baseUrl: 'https://other.example.test', name: 'new', apiKeyEnv: 'MODEL_KEY' }
  for (const [route, body, expected] of [
    ['/api/config/dice', { revision: dice.revision, values: { 'diceSystem.customRules': [] } }, 400],
    ['/api/config/dice', { revision: dice.revision, values: { 'dice.maxRounds': 0 } }, 400],
    ['/api/config/dice', { revision: dice.revision, values: {}, secrets: { apiKey: { action: 'replace', value: secret } } }, 400],
    ['/api/config/memory', { revision: dice.revision, values: {} }, 404],
    ['/api/ai/config', { revision: ai.revisions.model, configKey: 'model', providers: [{ ...provider, apiKey: secret }] }, 400],
    ['/api/ai/config', { revision: ai.revisions.model, configKey: 'model', providers: [provider, provider] }, 400],
    ['/api/ai/config', { revision: ai.revisions.model, configKey: 'model', providers: [{ ...provider, priority: 1 }] }, 400],
    ['/api/ai/config', { revision: ai.revisions.model, configKey: 'model', providers: [{ ...provider, baseUrl: 'https://user:password@example.test' }] }, 400],
    ['/api/persona/library', { revision: library.revision, personas: library.personas, groupBindings: {} }, 400],
    ['/api/persona/library', { revision: library.revision, personas: [] }, 409],
    ['/api/persona/library', { revision: library.revision, personas: [{ id: 'default', name: 'Forbidden default' }] }, 400],
    ['/api/persona/assignments', { revision: assignments.revision, agents: [{ agentId: 'missing', personaId: 'p-one' }] }, 409],
    ['/api/persona/assignments', { revision: assignments.revision, agents: [{ agentId: 'daily', personaId: 'missing' }] }, 409],
    ['/api/persona/assignments', { revision: assignments.revision, agents: [{ groupId: '310901', personaId: 'p-one' }] }, 400],
    ['/api/persona/assignments', { revision: assignments.revision, agents: [{ agentId: 'daily', personaId: 'p-one' }], personas: library.personas }, 400],
  ]) {
    const result = await put(f, route, body)
    assert.equal(result.status, expected, `${route}: ${result.text}`); assert.equal(result.text.includes(secret), false)
    assert.deepEqual(await f.files(), before)
    assert.equal(f.owned.execution.isCurrent(), true)
  }
})

test('a revision from a different scope and a changed dependency both fail CAS without overwriting files', async t => {
  const f = await fixture(t), view = (await f.request('/api/config/dice')).data, library = (await f.request('/api/persona/library')).data, before = await f.files()
  assert.equal((await put(f, '/api/config/dice', { revision: library.revision, values: { 'dice.maxRounds': 40 } })).status, 409)
  assert.deepEqual(await f.files(), before)
  await writeFile(path.join(f.root, 'persona-library.yaml'), before['persona-library.yaml'] + '# another process changed a dependency\n')
  const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 40 } })
  assert.equal(result.status, 409)
  assert.equal((await f.files())['agent-host.yaml'], before['agent-host.yaml'])
  assert.equal(f.owned.execution.isCurrent(), false)
})

test('session and lease revocation at the transaction fence stop installation while a revoked response filter suppresses its receipt', async t => {
  for (const scenario of ['session', 'lease', 'filter']) await t.test(scenario, async t => {
    const f = await fixture(t), view = (await f.request('/api/config/dice')).data
    f.owned.execution.signal.addEventListener('abort', () => { f.control[scenario] = false }, { once: true })
    const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 44 } })
    assert.notEqual(result.status, 200)
    assert.equal(result.text.includes('committedRevision'), false)
    assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, scenario === 'filter' ? 44 : 20)
    assert.equal(f.owned.execution.signal.aborted, true)
    assert.equal(f.owned.execution.isCurrent(), false)
    const retainedLock = (await readdir(f.root)).includes('.agent-config.write.lock')
    assert.equal(retainedLock, scenario !== 'filter')
    if (scenario === 'session') {
      assert.equal((await f.request('/api/config-state')).status, 401)
      f.control.session = true
    }
    if (scenario === 'filter') f.control.filter = true
    if (scenario !== 'lease') {
      const state = await f.request('/api/config-state')
      assert.equal(state.data.recoveryRequired, scenario !== 'filter')
    }
  })
})

test('secret filtering runs before commit and never echoes a rejected newly submitted value', async t => {
  const f = await fixture(t), before = await f.files(), view = (await f.request('/api/config/persona')).data
  const result = await put(f, '/api/config/persona', { revision: view.revision, values: { 'persona.identity': secret } })
  assert.equal(result.status, 500); assert.equal(result.text.includes(secret), false)
  assert.deepEqual(await f.files(), before); assert.equal(f.owned.execution.isCurrent(), true)
})

test('a disconnected response does not roll back its already committed file or revive the old execution epoch', async t => {
  const f = await fixture(t), view = (await f.request('/api/config/dice')).data, controller = new AbortController()
  f.owned.execution.signal.addEventListener('abort', () => controller.abort(), { once: true })
  await assert.rejects(put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 45 } }, controller.signal), { name: 'AbortError' })
  await waitFor(() => f.owned.execution.signal.aborted)
  assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, 45)
  assert.equal(f.owned.execution.isCurrent(), false)
})

test('unbranded and cloned committed responses do not exempt configuration guards', async t => {
  for (const mode of ['forged', 'cloned']) await t.test(mode, async t => {
    const f = await fixture(t, { wrapServices: services => services.map(service => service.operation === 'config.write' ? { ...service, async handle(request, context) {
      if (mode === 'forged') return { kind: 'committed-json', value: { requiresRestart: true } }
      const result = await service.handle(request, context)
      return { ...result }
    } } : service) })
    const before = await f.files(), view = (await f.request('/api/config/dice')).data
    const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 46 } })
    assert.notEqual(result.status, 200)
    assert.equal(result.text.includes('committedRevision'), false)
    assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, mode === 'forged' ? 20 : 46)
    if (mode === 'forged') assert.deepEqual(await f.files(), before)
  })
})

test('a genuine receipt rejects a foreign request, request-body mutation and replay after completion', async t => {
  let receipt, release, prepared
  const ready = new Promise(resolve => { prepared = resolve }), held = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { wrapServices: services => services.map(service => {
    if (service.operation === 'config.write') return { ...service, async handle(request, context) { receipt = await service.handle(request, context); prepared(); await held; return receipt } }
    if (service.operation === 'config-state.read') return { ...service, async handle() { return receipt } }
    return service
  }) })
  const view = (await f.request('/api/config/dice')).data
  const saving = put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 47 } })
  await ready
  // The second HTTP request also receives a different authenticated principal.
  f.principal.id = 'another-session'
  const foreign = await f.request('/api/config-state')
  assert.equal(foreign.status, 409)
  release()
  assert.equal((await saving).status, 200)
  const replay = await f.request('/api/config-state')
  assert.notEqual(replay.status, 200)
  assert.equal(replay.text.includes('committedRevision'), false)
  await t.test('request digest', async t => {
    const f = await fixture(t, { wrapServices: services => services.map(service => service.operation === 'config.write' ? { ...service, async handle(request, context) {
      const result = await service.handle(request, context)
      request.body.values['dice.maxRounds'] = 999
      return result
    } } : service) })
    const view = (await f.request('/api/config/dice')).data
    const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 48 } })
    assert.equal(result.status, 409)
    assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, 48)
  })
})

test('a dependency changed after fencing requires offline recovery and a published-commit fsync failure remains unknown', async t => {
  await t.test('dependency changed during retirement', async t => {
    const f = await fixture(t), view = (await f.request('/api/config/dice')).data
    f.owned.execution.signal.addEventListener('abort', () => fs.appendFileSync(path.join(f.root, 'agent-bindings.yaml'), '# extra transition\n'), { once: true })
    const result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 49 } })
    assert.equal(result.status, 503); assert.equal(result.data.error, 'configuration_recovery_required'); assert.equal(result.data.requiresRestart, true)
    assert.equal(result.data.recoveryRequired, true)
    assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, 20)
    assert.match((await f.files())['agent-bindings.yaml'], /# extra transition/u)
    assert.equal(f.owned.execution.isCurrent(), false)
  })
  await t.test('directory fsync', async t => {
    const f = await fixture(t), view = (await f.request('/api/config/dice')).data, original = fs.fsyncSync
    let injected = false
    fs.fsyncSync = descriptor => {
      if (!injected && f.owned.execution.signal.aborted && fs.fstatSync(descriptor).isDirectory() && inspectTransaction(f.hostFile).direction === 'redo') {
        injected = true
        throw new Error('fixture commit-directory fsync failure')
      }
      return original(descriptor)
    }
    let result
    try { result = await put(f, '/api/config/dice', { revision: view.revision, values: { 'dice.maxRounds': 50 } }) }
    finally { fs.fsyncSync = original }
    assert.equal(injected, true)
    assert.equal(result.status, 503); assert.equal(result.data.error, 'commit_outcome_unknown')
    assert.equal(result.text.includes('fixture'), false)
    assert.equal(YAML.parse((await f.files())['agent-host.yaml']).dice.maxRounds, 50)
    const state = (await f.request('/api/config-state')).data
    assert.equal(state.phase, 'uncertain'); assert.equal(state.requiresRestart, true); assert.equal(state.recoveryRequired, true)
  })
})

test('persistence remains unavailable unless explicitly enabled', async t => {
  const f = await fixture(t, { enabled: false }), before = await f.files()
  assert.equal((await f.request('/api/config/dice')).status, 503)
  assert.equal((await f.request('/api/config-state')).status, 503)
  assert.deepEqual(await f.files(), before)
  const disabledByDefault = persistence({ hostFile: f.hostFile, loaded: snapshot(f.hostFile), authority: { signal: new AbortController().signal, isCurrent: () => true }, validateCandidate })
  const context = { principal: f.principal, signal: new AbortController().signal, isCurrent: () => true, ensureCurrent() {} }
  assert.throws(() => disabledByDefault.config.read('dice', context), { code: 'unavailable' })
  assert.deepEqual(await f.files(), before)
})
