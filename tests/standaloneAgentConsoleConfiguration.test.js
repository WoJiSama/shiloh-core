import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ readStandaloneAgentConfig, createStandaloneAgentCandidateValidator },
  { createStandaloneAgentConsolePersistence }, { createStandaloneAgentConsole },
  { createStandaloneAgentConsoleServices }, sources, { openStandaloneAgentConsoleAuth }] = await Promise.all([
  load('bootstrap/standaloneAgentConfig.js'), load('bootstrap/standaloneAgentConsolePersistence.js'),
  load('bootstrap/standaloneAgentConsole.js'), load('bootstrap/standaloneAgentConsoleServices.js'),
  load('bootstrap/standaloneAgentConfigSources.js'),
  load('bootstrap/standaloneAgentConsoleAuth.js'),
])

const tokens = { admin: 'configuration-admin-token-4918', second: 'configuration-second-token-5921' }
const env = { MAIN_KEY: 'configuration-model-private-6143', QQ_MAIN_TOKEN: 'configuration-qq-main-private-8196',
  QQ_SECOND_TOKEN: 'configuration-qq-second-private-8207' }
const target = { account: { platform: 'qq', namespace: 'global', id: '19002911' }, kind: 'group', id: '310911' }
const addConnection = () => ({ kind: 'connection.add', agentId: 'daily',
  connection: { id: 'qq-second', accountId: '19002912', transport: 'forward-websocket', url: 'ws://127.0.0.1:3002/onebot', accessTokenEnv: 'QQ_SECOND_TOKEN' },
  conversations: [{ kind: 'group', conversationId: target.id }, { kind: 'private', conversationId: '23002911' }] })
const createAgent = (newTemplate = true) => ({ kind: 'agent.create', agentId: 'research', personaId: newTemplate ? 'p-research' : 'p-shared',
  ...(newTemplate ? { newPersona: { id: 'p-research', name: 'Research persona', identity: 'A separate researcher', tone: 'calm' } } : {}) })
const commitPayload = preview => Object.fromEntries(['previewId', 'revision', 'candidateDigest', 'readSet'].map(key => [key, structuredClone(preview[key])]))
const post = (f, route, body, options) => f.request(route, { method: 'POST', body, ...options })
const reloadEntry = `const { importBilibiliHost: load } = await import(${JSON.stringify(new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href)});
const [{ readStandaloneAgentConfig, createStandaloneAgentCandidateValidator }, { createStandaloneAgentConsolePersistence }] = await Promise.all([
  load('bootstrap/standaloneAgentConfig.js'), load('bootstrap/standaloneAgentConsolePersistence.js')]);
const hostFile = process.argv[1], config = readStandaloneAgentConfig(hostFile, process.env);
const persistence = createStandaloneAgentConsolePersistence({ enabled: true, hostFile, loaded: config.sourceSnapshot,
  authority: { signal: new AbortController().signal, isCurrent: () => true },
  validateCandidate: createStandaloneAgentCandidateValidator(hostFile, process.env, { sourceSnapshot: config.sourceSnapshot }) });
console.log(JSON.stringify({ revision: config.sourceSnapshot.revision, processEpoch: persistence.execution.processEpoch,
  current: persistence.execution.isCurrent(), counts: [...config.checkBindings()],
  agents: config.workspaceAgents, bindings: config.listBindings() }));`
function readInFreshProcess(f) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', reloadEntry, f.hostFile], {
    cwd: f.root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.equal(child.signal, null)
  return JSON.parse(child.stdout)
}

function diskTree(root) {
  const result = {}
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const key = prefix + name, absolute = path.join(directory, name), stat = fs.lstatSync(absolute, { bigint: true })
      if (stat.isDirectory()) { result[key + '/'] = 'directory'; visit(absolute, key + '/') }
      else result[key] = { mode: String(stat.mode), inode: String(stat.dev) + ':' + String(stat.ino),
        modified: String(stat.mtimeNs), changed: String(stat.ctimeNs), bytes: fs.readFileSync(absolute).toString('base64') }
    }
  }
  visit(root)
  return result
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-console-configuration-')), root = fs.realpathSync(directory)
  t.after(() => rm(root, { recursive: true, force: true }))
  const hostFile = path.join(root, 'agent-host.yaml'), bindingFile = path.join(root, 'agent-bindings.yaml'), personaFile = path.join(root, 'persona-library.yaml')
  const host = { version: 1, instance: 'configuration-integration', dataDir: './unopened-data',
    model: { baseUrl: 'https://models.example.test/v1', name: 'fixture-main', apiKeyEnv: 'MAIN_KEY' },
    persona: { name: 'Default persona', identity: 'A single daily self' },
    connections: [{ id: 'qq-main', url: 'ws://127.0.0.1:3001/onebot', accessTokenEnv: 'QQ_MAIN_TOKEN' }],
    textGroups: [{ connectionId: 'qq-main', conversationId: target.id, tools: ['commitmentTool'] }],
    simulation: { enabled: false, extraTools: [], toolPolicy: { mode: 'legacy', allowTools: [], denyTools: [] } },
    privateChat: { enabled: false, allowTools: ['likeTool'] },
    extensionOwned: { privateSentinel: 'HOST_PRIVATE_EXTENSION_2964', preserved: true } }
  await writeFile(hostFile, '# keep host comment\n' + YAML.stringify(host))
  await writeFile(bindingFile, '# keep bindings comment\n' + YAML.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }, { id: 'reader', personaId: options.noLibrary ? 'default' : 'p-shared' }],
    connections: [{ id: 'qq-main', platform: 'qq', namespace: 'global', accountId: target.account.id }],
    bindings: [{ connectionId: 'qq-main', kind: 'group', conversationId: target.id, agentId: 'daily' }] }))
  if (!options.noLibrary) await writeFile(personaFile, '# keep library comment\npersonas:\n  - id: p-shared\n    name: Shared persona\n    tone: warm\n    extensionOwned: LIBRARY_PRIVATE_EXTENSION_2964\n')
  const retainedDirectory = path.join(root, 'preserved-growth')
  await mkdir(retainedDirectory)
  await writeFile(path.join(retainedDirectory, 'daily.json'), '{"agentId":"daily","memories":["preserve this daily life"]}\n')
  await writeFile(path.join(retainedDirectory, 'reader.json'), '{"agentId":"reader","memories":["a different life"]}\n')
  const frontendDir = path.join(root, 'frontend'); await mkdir(frontendDir)
  await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>configuration fixture</title>')
  const loadedConfig = readStandaloneAgentConfig(hostFile, env), lifetime = new AbortController()
  const control = { session: true, lease: true, filter: true, forbidden: new Set(), authorizations: [], beforeAuthorize: undefined }
  const authority = { signal: lifetime.signal, isCurrent: () => control.lease }
  const persistence = createStandaloneAgentConsolePersistence({ enabled: true, hostFile, loaded: loadedConfig.sourceSnapshot,
    listToolNames: () => options.toolNames ?? [],
    authority, validateCandidate: createStandaloneAgentCandidateValidator(hostFile, env, { sourceSnapshot: loadedConfig.sourceSnapshot }) })
  const bindings = { list: () => loadedConfig.listBindings(), resolve: selected => loadedConfig.resolvePersona(selected)?.binding }
  const authorize = async (principal, operation, binding, guard) => {
    guard.ensureCurrent(); control.authorizations.push({ principal: principal.id, operation, binding })
    await control.beforeAuthorize?.(operation, { persistence, control })
    return control.forbidden.has(operation) ? 'denied' : 'allowed'
  }
  const authEnv = { CONFIGURATION_TEST_TOKEN: tokens.admin }
  const auth = options.realAuth ? await openStandaloneAgentConsoleAuth({
    userFile: path.join(root, 'auth', 'users.json'), authority, env: authEnv, tokenEnv: 'CONFIGURATION_TEST_TOKEN',
    policy: { operations: ['configuration.read', 'configuration.preview', 'configuration.commit', 'config-state.read'], authorize },
  }) : {
    async state(_credentials, guard) { guard.ensureCurrent(); return { hasUser: true, username: control.session ? 'admin' : null, tokenWorks: control.session, via: control.session ? 'session' : null } },
    async authenticate(credentials, guard) {
      guard.ensureCurrent()
      const who = Object.keys(tokens).find(key => tokens[key] === credentials.token)
      return control.session && who ? { id: `configuration-${who}`, username: who, via: 'session' } : undefined
    },
    authorize,
    isCurrent: () => control.session,
    async run() { return { username: 'admin' } },
  }
  if (options.realAuth) t.after(() => auth.close())
  let services = createStandaloneAgentConsoleServices({ bindings, auth, configuration: persistence.configuration, config: persistence.config,
    configState: persistence.state, commits: persistence.commits })
  if (options.wrapServices) services = options.wrapServices(services, { persistence, control, root, hostFile })
  const privateValues = [...Object.values(tokens), ...Object.values(env), 'HOST_PRIVATE_EXTENSION_2964', 'LIBRARY_PRIVATE_EXTENSION_2964']
  const app = createStandaloneAgentConsole({ frontendDir, port: 0, authority, execution: persistence.execution, commits: persistence.commits,
    auth, bindings, services, allowsResponse: body => control.filter && privateValues.every(value => !Buffer.from(body).toString().includes(value)) })
  t.after(() => app.close())
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`
  async function request(route, { method = 'GET', body, who = 'admin', suppliedToken, signal } = {}) {
    const response = await fetch(base + route, { method, headers: { 'x-console-token': suppliedToken ?? tokens[who] ?? '',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })
    const text = await response.text()
    return { status: response.status, text, data: JSON.parse(text) }
  }
  async function files() { return Object.fromEntries(await Promise.all([hostFile, personaFile, bindingFile].map(async name => [path.basename(name),
    await readFile(name, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })]))) }
  async function preview(change = addConnection(), options) {
    const catalog = await request('/api/configuration/catalog', options)
    assert.equal(catalog.status, 200, catalog.text)
    const result = await post({ request }, '/api/configuration/preview', { revision: catalog.data.revision, change }, options)
    assert.equal(result.status, 200, result.text)
    return result.data
  }
  return { root, hostFile, bindingFile, personaFile, loadedConfig, persistence, control, lifetime, app, request, files, preview, authEnv,
    privateValues, retainedDirectory, tree: () => diskTree(root), growth: () => diskTree(retainedDirectory) }
}

test('feature switches list bound groups and live tools and atomically persist only the host policy', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { toolNames: ['mcp_fixture_catalog'] })
  const route = '/api/config/feature-switches', before = await f.files()
  const view = await f.request(route)
  assert.equal(view.status, 200, view.text)
  assert.deepEqual(view.data.groups, [target.id])
  assert.deepEqual(view.data.policy, { default: 'all', features: {}, tools: {} })
  assert.ok(view.data.items.some(item => item.kind === 'tools' && item.name === 'mcp_fixture_catalog'))
  const put = (values, revision = view.data.revision) => f.request(route, { method: 'PUT', body: { revision, values } })
  assert.equal((await put({ features: { mediaRelay: { mode: 'groups', groups: [Number(target.id)] } } })).status, 400)
  const values = { default: 'off', features: { mediaRelay: { mode: 'groups', groups: [target.id] } }, tools: { mcp_fixture_catalog: { mode: 'all' } } }
  assert.equal((await put(values, '0'.repeat(64))).status, 409)
  assert.deepEqual(await f.files(), before)
  const saved = await put(values)
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.data.requiresRestart, true)
  assert.deepEqual(saved.data.view.policy, values)
  assert.equal(f.persistence.execution.isCurrent(), false)
  const after = await f.files()
  assert.equal(after['agent-bindings.yaml'], before['agent-bindings.yaml'])
  assert.equal(after['persona-library.yaml'], before['persona-library.yaml'])
  assert.match(after['agent-host.yaml'], /^# keep host comment/u)
  assert.deepEqual(YAML.parse(after['agent-host.yaml']), { ...YAML.parse(before['agent-host.yaml']), featureSwitches: values })
  assert.deepEqual(JSON.parse(JSON.stringify(readStandaloneAgentConfig(f.hostFile, env).featureSwitches)), values)
})

test('real token auth keeps preview ownership across HTTP requests through a complete second QQ commit', async t => {
  const f = await fixture(t, { realAuth: true }), growth = f.growth(), preview = await f.preview()
  const result = await post(f, '/api/configuration/commit', commitPayload(preview))
  assert.equal(result.status, 200, result.text)
  assert.equal(result.data.requiresRestart, true)
  assert.equal(result.data.view.configRevision, result.data.committedRevision)
  const actors = new Set(f.control.authorizations.map(row => row.principal))
  assert.equal(actors.size, 1, 'real auth must keep one current actor through read, preview and commit')
  assert.equal(f.persistence.execution.isCurrent(), false)
  assert.equal((await f.request('/api/configuration/catalog')).status, 409)
  const state = await f.request('/api/config-state')
  assert.equal(state.status, 200, state.text)
  assert.equal(state.data.requiresRestart, true); assert.equal(state.data.recoveryRequired, false)
  const reloaded = readStandaloneAgentConfig(f.hostFile, env)
  assert.equal(reloaded.sourceSnapshot.revision, result.data.committedRevision)
  assert.equal(reloaded.listBindings().filter(row => row.connectionId === 'qq-second').length, 2)
  assert.deepEqual(f.growth(), growth)
  for (const secret of f.privateValues) assert.equal(result.text.includes(secret), false)
})

test('real token logout and rotation revoke candidate ownership without writing configuration or retiring execution', async t => {
  for (const action of ['logout', 'rotate-and-restore']) await t.test(action, async t => {
    const f = await fixture(t, { realAuth: true }), preview = await f.preview(), before = await f.files(), growth = f.growth()
    if (action === 'logout') {
      const logout = await post(f, '/api/auth/logout', {})
      assert.equal(logout.status, 200, logout.text)
    } else {
      f.authEnv.CONFIGURATION_TEST_TOKEN = tokens.second
      assert.equal((await f.request('/api/configuration/catalog')).status, 401)
      const rotated = await post(f, '/api/configuration/commit', commitPayload(preview), { suppliedToken: tokens.second })
      assert.equal(rotated.status, 409, rotated.text); assert.equal(rotated.data.error, 'candidate_stale')
      f.authEnv.CONFIGURATION_TEST_TOKEN = tokens.admin
    }
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.equal(result.status, 409, result.text); assert.equal(result.data.error, 'candidate_stale')
    assert.deepEqual(await f.files(), before); assert.deepEqual(f.growth(), growth)
    assert.equal(f.persistence.execution.isCurrent(), true)
    const state = await f.request('/api/config-state')
    assert.equal(state.status, 200, state.text); assert.equal(state.data.requiresRestart, false)
    assert.equal(state.data.recoveryRequired, false)
  })
})

test('real validator previews a second QQ with full sources without writing files, exposing secrets or copying text and private permissions', async t => {
  const f = await fixture(t), before = f.tree(), catalog = await f.request('/api/configuration/catalog'), preview = await f.preview()
  assert.equal(catalog.status, 200, catalog.text)
  assert.deepEqual(catalog.data.capabilities, { requiresRestart: true, atomicMultiFile: true })
  assert.deepEqual(catalog.data.connections, [{ id: 'qq-main', account: target.account, transport: 'forward-websocket' }])
  assert.deepEqual(preview.readSet, catalog.data.readSet)
  assert.equal(preview.configRevision, f.loadedConfig.sourceSnapshot.revision)
  assert.equal(preview.processEpoch, catalog.data.processEpoch)
  assert.equal(preview.requiresRestart, true)
  assert.match(preview.previewId, /^[0-9a-f-]{36}$/u); assert.match(preview.candidateDigest, /^[0-9a-f]{64}$/u)
  assert.ok(preview.expiresAt > Date.now())
  assert.deepEqual(new Set(preview.changes.map(change => change.file)), new Set(['host', 'bindings']))
  // The commit retires the whole host, so unchanged current selves and scenes
  // are also part of the server's impact list.
  assert.deepEqual(preview.affected.agents, ['daily', 'reader'])
  assert.deepEqual(preview.affected.connections, [{ id: 'qq-main', account: target.account }, { id: 'qq-second', account: { ...target.account, id: '19002912' } }])
  assert.deepEqual(preview.affected.conversations.map(row => ({ agentId: row.agentId, connectionId: row.connectionId, target: row.target })), [
    { agentId: 'daily', connectionId: 'qq-main', target },
    { agentId: 'daily', connectionId: 'qq-second', target: { ...target, account: { ...target.account, id: '19002912' } } },
    { agentId: 'daily', connectionId: 'qq-second', target: { ...target, account: { ...target.account, id: '19002912' }, kind: 'private', id: '23002911' } },
  ])
  assert.deepEqual(preview.permissions.map(row => ({ scopeKey: row.scopeKey, mode: row.mode, tools: row.tools })), [
    { scopeKey: JSON.stringify(['daily', 'qq', 'global', '19002912', 'group', target.id]), mode: 'simulation', tools: [] },
    { scopeKey: JSON.stringify(['daily', 'qq', 'global', '19002912', 'private', '23002911']), mode: 'private-disabled', tools: [] },
  ])
  assert.ok(preview.permissions.every(row => typeof row.note === 'string' && row.note.length > 0))
  const publicText = JSON.stringify({ catalog: catalog.data, preview })
  for (const value of f.privateValues) assert.equal(publicText.includes(value), false, value)
  for (const key of ['sources', 'host', 'bindings', 'personas']) assert.equal(Object.hasOwn(preview, key), false, key)
  assert.equal(publicText.includes('# keep'), false); assert.equal(publicText.includes('ws://127.0.0.1:3001'), false)
  assert.deepEqual(f.tree(), before); assert.equal(f.persistence.execution.isCurrent(), true)
})

test('second QQ commits host and bindings once and a fresh process configuration loads both complete scenes for the same daily self', async t => {
  const f = await fixture(t), before = await f.files(), growth = f.growth(), preview = await f.preview()
  let atRetirement
  f.persistence.execution.signal.addEventListener('abort', () => {
    atRetirement = { host: fs.readFileSync(f.hostFile, 'utf8'), bindings: fs.readFileSync(f.bindingFile, 'utf8') }
  }, { once: true })
  const result = await post(f, '/api/configuration/commit', commitPayload(preview))
  assert.equal(result.status, 200, result.text)
  assert.deepEqual(atRetirement, { host: before['agent-host.yaml'], bindings: before['agent-bindings.yaml'] })
  assert.equal(result.data.requiresRestart, true)
  assert.ok(result.data.changed > 0); assert.equal(result.data.processEpoch, preview.processEpoch)
  assert.match(result.data.transactionId, /^[0-9a-f-]{36}$/u)
  assert.equal(result.data.view.configRevision, result.data.committedRevision)
  assert.equal(f.persistence.execution.isCurrent(), false)
  assert.equal((await f.request('/api/configuration/catalog')).status, 409)
  const state = await f.request('/api/config-state')
  assert.equal(state.status, 200, state.text); assert.equal(state.data.storedRevision, result.data.committedRevision)
  assert.equal(state.data.requiresRestart, true); assert.equal(state.data.recoveryRequired, false)
  assert.equal(state.data.transaction.phase, 'clean')
  const after = await f.files(), storedHost = YAML.parse(after['agent-host.yaml']), storedBindings = YAML.parse(after['agent-bindings.yaml'])
  assert.equal(after['persona-library.yaml'], before['persona-library.yaml'])
  assert.match(after['agent-host.yaml'], /# keep host comment/u); assert.match(after['agent-bindings.yaml'], /# keep bindings comment/u)
  assert.deepEqual(storedHost.textGroups, YAML.parse(before['agent-host.yaml']).textGroups)
  assert.deepEqual(storedHost.privateChat, YAML.parse(before['agent-host.yaml']).privateChat)
  assert.equal(storedHost.connections.length, 2); assert.equal(storedBindings.connections.length, 2)
  const reloaded = readStandaloneAgentConfig(f.hostFile, env)
  assert.equal(reloaded.sourceSnapshot.revision, result.data.committedRevision)
  assert.equal(reloaded.checkBindings().get('qq-second').simulationGroups, 1)
  assert.equal(reloaded.checkBindings().get('qq-second').friends, 1)
  const extraTarget = { ...target, account: { ...target.account, id: '19002912' } }
  assert.equal(reloaded.resolvePersona(extraTarget).binding.agentId, 'daily')
  assert.equal(reloaded.resolvePersona({ ...extraTarget, kind: 'private', id: '23002911' }).binding.agentId, 'daily')
  assert.equal(reloaded.useTextGroup(extraTarget), false)
  assert.equal(reloaded.privateChatEnabled, false)
  const fresh = createStandaloneAgentConsolePersistence({ enabled: true, hostFile: f.hostFile, loaded: reloaded.sourceSnapshot,
    authority: { signal: new AbortController().signal, isCurrent: () => true },
    validateCandidate: createStandaloneAgentCandidateValidator(f.hostFile, env, { sourceSnapshot: reloaded.sourceSnapshot }) })
  assert.notEqual(fresh.execution.processEpoch, f.persistence.execution.processEpoch); assert.equal(fresh.execution.isCurrent(), true)
  const newProcess = readInFreshProcess(f)
  assert.notEqual(newProcess.processEpoch, f.persistence.execution.processEpoch); assert.equal(newProcess.current, true)
  assert.equal(newProcess.revision, result.data.committedRevision)
  assert.deepEqual(newProcess.bindings.filter(binding => binding.connectionId === 'qq-second').map(binding => ({ agentId: binding.agentId, target: binding.target })), [
    { agentId: 'daily', target: extraTarget }, { agentId: 'daily', target: { ...extraTarget, kind: 'private', id: '23002911' } },
  ])
  assert.deepEqual(f.growth(), growth); assert.equal(fs.existsSync(path.join(f.root, 'unopened-data')), false)
  const once = await f.files()
  assert.notEqual((await post(f, '/api/configuration/commit', commitPayload(preview))).status, 200)
  assert.deepEqual(await f.files(), once)
})

test('a new template and new self commit together while existing lives, connections and host remain unchanged', async t => {
  for (const noLibrary of [false, true]) await t.test(noLibrary ? 'first template library' : 'existing template library', async t => {
    const f = await fixture(t, { noLibrary }), before = await f.files(), growth = f.growth(), preview = await f.preview(createAgent())
    assert.deepEqual(new Set(preview.changes.map(change => change.file)), new Set(['personas', 'bindings']))
    assert.deepEqual(preview.affected.agents, ['daily', 'reader', 'research'])
    assert.deepEqual(preview.affected.connections, [{ id: 'qq-main', account: target.account }])
    assert.deepEqual(preview.affected.conversations, [{ agentId: 'daily', connectionId: 'qq-main', target }])
    assert.equal(preview.affected.conversations.some(row => row.agentId === 'research'), false)
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.equal(result.status, 200, result.text)
    const after = await f.files(), host = YAML.parse(after['agent-host.yaml']), bindingData = YAML.parse(after['agent-bindings.yaml']), library = YAML.parse(after['persona-library.yaml'])
    assert.equal(after['agent-host.yaml'], before['agent-host.yaml'])
    assert.deepEqual(bindingData.connections, YAML.parse(before['agent-bindings.yaml']).connections)
    assert.deepEqual(bindingData.bindings, YAML.parse(before['agent-bindings.yaml']).bindings)
    assert.deepEqual(bindingData.agents.at(-1), { id: 'research', personaId: 'p-research' })
    assert.equal(library.personas.at(-1).id, 'p-research'); assert.equal(library.personas.at(-1).name, 'Research persona')
    assert.deepEqual(host.connections, YAML.parse(before['agent-host.yaml']).connections)
    const reloaded = readStandaloneAgentConfig(f.hostFile, env)
    assert.equal(reloaded.workspaceAgents.some(agent => agent.agentId === 'research' || agent.id === 'research'), true)
    assert.equal(reloaded.listBindings().some(binding => binding.agentId === 'research'), false)
    const newProcess = readInFreshProcess(f)
    assert.equal(newProcess.revision, result.data.committedRevision)
    assert.notEqual(newProcess.processEpoch, preview.processEpoch)
    assert.equal(newProcess.agents.some(agent => agent.id === 'research' && agent.personaId === 'p-research'), true)
    assert.deepEqual(f.growth(), growth); assert.equal(fs.existsSync(path.join(f.root, 'unopened-data')), false)
  })
})

test('a second self can reuse an existing template without copying bindings or rewriting the template library', async t => {
  const f = await fixture(t), before = await f.files(), growth = f.growth(), preview = await f.preview(createAgent(false))
  assert.deepEqual(new Set(preview.changes.map(change => change.file)), new Set(['bindings']))
  const result = await post(f, '/api/configuration/commit', commitPayload(preview))
  assert.equal(result.status, 200, result.text)
  const after = await f.files(), bindings = YAML.parse(after['agent-bindings.yaml'])
  assert.equal(after['persona-library.yaml'], before['persona-library.yaml']); assert.equal(after['agent-host.yaml'], before['agent-host.yaml'])
  assert.deepEqual(bindings.agents.filter(agent => agent.personaId === 'p-shared').map(agent => agent.id), ['reader', 'research'])
  assert.deepEqual(bindings.bindings, YAML.parse(before['agent-bindings.yaml']).bindings)
  assert.deepEqual(f.growth(), growth)
})

test('every source in the preview read set rejects later edits and same-byte inode replacements before materializing another file', async t => {
  for (const name of ['agent-host.yaml', 'persona-library.yaml', 'agent-bindings.yaml']) for (const replacement of [false, true])
    await t.test(name + (replacement ? ' same bytes, new inode' : ' edited'), async t => {
      const f = await fixture(t), preview = await f.preview(), targetFile = path.join(f.root, name), original = fs.readFileSync(targetFile, 'utf8')
      if (replacement) {
        const temporary = path.join(f.root, 'external-replacement'); fs.writeFileSync(temporary, original); fs.renameSync(temporary, targetFile)
      } else fs.appendFileSync(targetFile, '# externally changed after preview\n')
      const edited = await f.files(), result = await post(f, '/api/configuration/commit', commitPayload(preview))
      assert.equal(result.status, 409, result.text); assert.deepEqual(await f.files(), edited)
      assert.equal(result.text.includes('committedRevision'), false)
      assert.equal(sources.inspectStandaloneAgentConfigTransaction(f.hostFile).phase, 'clean')
    })
})

test('candidate identity, read set, principal, expiry and replay checks reject unreviewed changes without writes or retirement', async t => {
  const scenarios = [
    ['digest', payload => { payload.candidateDigest = 'f'.repeat(64) }],
    ['host read set', payload => { payload.readSet.host = '0'.repeat(64) }],
    ['missing read set', payload => { delete payload.readSet.personas }],
    ['foreign preview', payload => { payload.previewId = '00000000-0000-4000-8000-000000000000' }],
    ['unreviewed change', payload => { payload.change = createAgent() }],
    ['raw YAML replacement', payload => { payload.sources = { host: 'model: attacker-owned' } }],
    ['foreign principal', undefined, { who: 'second' }],
  ]
  for (const [name, mutate, options] of scenarios) await t.test(name, async t => {
    const f = await fixture(t), preview = await f.preview(), before = f.tree(), payload = commitPayload(preview)
    mutate?.(payload)
    const result = await post(f, '/api/configuration/commit', payload, options)
    assert.ok([400, 409].includes(result.status), result.text)
    if (result.status === 409) assert.equal(result.data.error, 'candidate_stale')
    assert.deepEqual(f.tree(), before); assert.equal(f.persistence.execution.isCurrent(), true)
  })
  await t.test('expired preview', async t => {
    let expiredAt
    const f = await fixture(t, { wrapServices: services => services.map(service => service.operation === 'configuration.commit' ? { ...service,
      async handle(request, context) {
        const original = Date.now
        Date.now = () => expiredAt
        try { return await service.handle(request, context) } finally { Date.now = original }
      } } : service) })
    const preview = await f.preview(), before = f.tree(); expiredAt = preview.expiresAt + 1
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.equal(result.status, 409, result.text); assert.equal(result.data.error, 'candidate_stale')
    assert.deepEqual(f.tree(), before); assert.equal(f.persistence.execution.isCurrent(), true)
  })
})

test('preview and commit grants are rechecked independently and revoked authority before fencing causes no file or execution transition', async t => {
  for (const operation of ['configuration.preview', 'configuration.commit']) await t.test(operation, async t => {
    const f = await fixture(t), preview = await f.preview(), before = f.tree()
    f.control.forbidden.add(operation)
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.equal(result.status, 403, result.text); assert.deepEqual(f.tree(), before)
    assert.equal(f.persistence.execution.isCurrent(), true); assert.equal(f.persistence.execution.signal.aborted, false)
  })
  await t.test('request principal withdrawn during authorization', async t => {
    const f = await fixture(t), preview = await f.preview(), before = f.tree()
    f.control.beforeAuthorize = operation => { if (operation === 'configuration.commit') f.control.session = false }
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.notEqual(result.status, 200); assert.deepEqual(f.tree(), before)
    assert.equal(f.persistence.execution.signal.aborted, false)
  })
})

test('fencing retires execution before a revoked session or host can materialize config and exposes only recovery status', async t => {
  for (const scenario of ['session', 'lease']) await t.test(scenario, async t => {
    const f = await fixture(t), preview = await f.preview(), before = await f.files()
    f.persistence.execution.signal.addEventListener('abort', () => { f.control[scenario] = false }, { once: true })
    const result = await post(f, '/api/configuration/commit', commitPayload(preview))
    assert.notEqual(result.status, 200); assert.equal(result.text.includes('committedRevision'), false)
    assert.deepEqual(await f.files(), before); assert.equal(f.persistence.execution.signal.aborted, true)
    assert.equal(sources.inspectStandaloneAgentConfigTransaction(f.hostFile).phase, 'recovery-required')
    const rejectedState = await f.request('/api/config-state')
    assert.notEqual(rejectedState.status, 200)
    f.control[scenario] = true
    const state = await f.request('/api/config-state')
    assert.equal(state.status, 200, state.text); assert.equal(state.data.recoveryRequired, true)
    assert.equal(state.data.phase, 'uncertain'); assert.equal(state.data.transaction.phase, 'recovery-required')
    assert.equal((await f.request('/api/configuration/catalog')).status, 409)
    for (const value of f.privateValues) assert.equal(state.text.includes(value), false)
    const once = await f.files()
    assert.notEqual((await post(f, '/api/configuration/commit', commitPayload(preview))).status, 200)
    assert.deepEqual(await f.files(), once)
  })
})

test('durability failures preserve the decision boundary and never return a success receipt or permit an implicit retry', async t => {
  await t.test('before a transaction fence', async t => {
    const f = await fixture(t), preview = await f.preview(), before = await f.files(), original = fs.fsyncSync
    let injected = false, result
    fs.fsyncSync = descriptor => {
      if (!injected) { injected = true; throw new Error('PRIVATE_FIXTURE_PREPARE_FSYNC_7124') }
      return original(descriptor)
    }
    try { result = await post(f, '/api/configuration/commit', commitPayload(preview)) } finally { fs.fsyncSync = original }
    assert.equal(injected, true)
    assert.notEqual(result.status, 200, result.text); assert.equal(result.text.includes('PRIVATE_FIXTURE'), false)
    assert.equal(result.text.includes('committedRevision'), false); assert.deepEqual(await f.files(), before)
    assert.equal(f.persistence.execution.signal.aborted, false)
  })
  for (const direction of ['undo', 'redo']) await t.test(direction === 'undo' ? 'active before commit decision' : 'commit decision published before directory fsync', async t => {
    const f = await fixture(t), preview = await f.preview(), before = await f.files(), original = fs.fsyncSync
    let injected = false, result
    fs.fsyncSync = descriptor => {
      if (!injected && fs.fstatSync(descriptor).isDirectory() && f.persistence.execution.signal.aborted) {
        const inspection = sources.inspectStandaloneAgentConfigTransaction(f.hostFile)
        if (inspection.phase === 'recovery-required' && inspection.direction === direction) {
          injected = true
          throw new Error('PRIVATE_FIXTURE_TRANSACTION_FSYNC_7124')
        }
      }
      return original(descriptor)
    }
    try { result = await post(f, '/api/configuration/commit', commitPayload(preview)) } finally { fs.fsyncSync = original }
    assert.equal(injected, true, 'The fsync failure must target an observed active transaction and its actual commit decision')
    assert.equal(result.status, 503, result.text)
    assert.equal(result.data.error, direction === 'undo' ? 'configuration_recovery_required' : 'commit_outcome_unknown')
    assert.equal(result.text.includes('PRIVATE_FIXTURE'), false); assert.equal(result.text.includes('committedRevision'), false)
    assert.equal(f.persistence.execution.isCurrent(), false)
    const inspection = sources.inspectStandaloneAgentConfigTransaction(f.hostFile)
    assert.equal(inspection.phase, 'recovery-required'); assert.equal(inspection.direction, direction)
    const state = await f.request('/api/config-state')
    assert.equal(state.status, 200, state.text); assert.equal(state.data.recoveryRequired, true)
    assert.equal(state.data.phase, 'uncertain'); assert.equal(state.data.transaction.direction, direction)
    if (direction === 'undo') assert.deepEqual(await f.files(), before)
    else {
      const after = await f.files()
      assert.equal(YAML.parse(after['agent-host.yaml']).connections.length, 2)
      assert.equal(YAML.parse(after['agent-bindings.yaml']).connections.length, 2)
    }
    const once = await f.files()
    assert.notEqual((await post(f, '/api/configuration/commit', commitPayload(preview))).status, 200)
    assert.deepEqual(await f.files(), once)
  })
})
