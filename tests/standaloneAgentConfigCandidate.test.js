import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig, createStandaloneAgentCandidateValidator } = await load('bootstrap/standaloneAgentConfig.js')
const { inspectStandaloneAgentSourceSnapshot, acquireStandaloneAgentConfigLock } = await load('bootstrap/standaloneAgentConfigSources.js')
const target = { account: { platform: 'qq', namespace: 'global', id: '19000931' }, kind: 'group', id: '310931' }
const model = { baseUrl: 'https://main.example/v1', name: 'main', apiKeyEnv: 'MAIN_KEY' }
const host = extra => ({ version: 1, instance: 'candidate-config', dataDir: 'uncreated-data', model,
  persona: { name: '默认角色', tone: '自然', speechStyle: ['简洁'] },
  connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...extra })
const bindings = extra => ({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
  connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: target.account.id }],
  bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'daily' }], ...extra })
const sources = ({ config = host(), library, directory = bindings() } = {}) => ({ host: JSON.stringify(config), personas: library === undefined ? undefined : JSON.stringify(library), bindings: JSON.stringify(directory) })
async function fixture(t, values = sources()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-candidate-config-')), file = path.join(directory, 'host.yaml')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(file, values.host); await writeFile(path.join(directory, 'agent-bindings.yaml'), values.bindings)
  if (values.personas !== undefined) await writeFile(path.join(directory, 'persona-library.yaml'), values.personas)
  return { directory, file, values }
}

test('startup decodes the exact three source bytes it exposes and keeps text groups and transport behavior', async t => {
  const f = await fixture(t, sources({ config: host({ textGroups: [{ connectionId: 'main', conversationId: target.id }],
    connections: [{ id: 'main', transport: 'reverse-websocket', url: 'ws://127.0.0.1:31001/onebot', accessTokenEnv: 'QQ_TOKEN' }] }),
    library: { personas: [{ id: 'night', name: '夜巡', tone: '安静' }] }, directory: bindings({ agents: [{ id: 'daily', personaId: 'night' }] }) }))
  const config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-model-key', QQ_TOKEN: 'private-onebot-token' })
  assert.deepEqual(config.sourceSnapshot.sources, f.values)
  assert.equal(config.sourceSnapshot.hostFile, fs.realpathSync(f.file))
  assert.equal(inspectStandaloneAgentSourceSnapshot(config.sourceSnapshot).revision, config.sourceSnapshot.revision)
  assert.equal(config.listBindings()[0].revision, config.sourceSnapshot.versions.bindings)
  assert.equal(config.resolvePersona(target).persona.tone, '安静')
  assert.deepEqual(config.migratedGroupToolNames(target), []); assert.equal(config.checkBindings().get('main').simulationGroups, 1)
  assert.equal(config.connections[0].transport, 'reverse-websocket'); assert.equal(config.connections[0].accessToken, 'private-onebot-token')
  assert.equal(config.isConfigCurrent(), true)
  assert.deepEqual((await readdir(f.directory)).sort(), ['agent-bindings.yaml', 'host.yaml', 'persona-library.yaml'])
})

test('synchronous runtime observations retain live bindings without a console and reject changes during a check', async t => {
  const f = await fixture(t), config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-key' })
  const bindingFile = path.join(f.directory, 'agent-bindings.yaml'), changed = bindings({
    agents: [{ id: 'daily', personaId: 'default' }, { id: 'next', personaId: 'default' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'next' }],
  })
  await writeFile(bindingFile, JSON.stringify(changed))
  assert.equal(config.isConfigCurrent(), true)
  assert.equal(config.observeConfigCurrent(() => config.isConfigCurrent() && config.resolvePersona(target)?.binding.agentId === 'next'), true)
  assert.equal(config.observeConfigCurrent(() => {
    fs.writeFileSync(bindingFile, JSON.stringify(bindings()))
    return config.isConfigCurrent() && config.resolvePersona(target)?.binding.agentId === 'next'
  }), false)
  assert.equal(config.resolvePersona(target)?.binding.agentId, 'daily')
  await writeFile(f.file, f.values.host + '\n')
  assert.equal(config.observeConfigCurrent(() => config.isConfigCurrent()), false)
})

test('cognition requires an explicit boolean rollout boundary and starts disabled', async t => {
  const f = await fixture(t)
  assert.deepEqual(readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-key' }).cognition, { enabled: false })
  await writeFile(f.file, JSON.stringify(host({ cognition: { enabled: true } })))
  assert.deepEqual(readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-key' }).cognition, { enabled: true })
  for (const cognition of [{}, { enabled: 'true' }, { enabled: true, provider: 'third-party' }]) {
    await writeFile(f.file, JSON.stringify(host({ cognition })))
    assert.throws(() => readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-key' }), /cognition/)
  }
})

test('candidate validation needs no existing files and performs no filesystem or network calls', async t => {
  const f = await fixture(t), validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'private-key' })
  await rm(f.directory, { recursive: true, force: true })
  const methods = ['readFileSync', 'statSync', 'lstatSync', 'openSync', 'realpathSync', 'mkdirSync', 'writeFileSync']
  const original = Object.fromEntries(methods.map(key => [key, fs[key]])), fetch = globalThis.fetch
  try {
    for (const key of methods) fs[key] = () => assert.fail(`pure candidate touched fs.${key}`)
    globalThis.fetch = () => assert.fail('pure candidate opened the network')
    const result = validate(sources({ config: host({ dice: { enabled: true, maxRounds: 4 } }) }))
    assert.deepEqual(result.dice, { enabled: true, maxDiceCount: 100, maxDiceSides: 100_000, maxRounds: 4 })
    assert.deepEqual(result.persona, { name: '默认角色', tone: '自然', speechStyle: ['简洁'] })
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.persona)); assert.ok(Object.isFrozen(result.persona.speechStyle))
  } finally { Object.assign(fs, original); globalThis.fetch = fetch }
})

test('candidate resolution uses the original host directory without scratch paths and ignores different current disk bytes', async t => {
  const f = await fixture(t), values = sources({ config: host({ console: { userFile: 'private/users.json', frontendDir: 'web/dist' },
    tools: { mcp: { servers: { worker: { type: 'stdio', command: 'node', cwd: 'workers' } } } } }) })
  await writeFile(f.file, 'invalid current host: [')
  await writeFile(path.join(f.directory, 'agent-bindings.yaml'), 'invalid current binding: [')
  const original = path.resolve, resolutions = []
  try {
    path.resolve = (...args) => { resolutions.push(args); return original(...args) }
    const validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'private-key' })
    assert.equal(validate(values).models.model.name, 'main')
  } finally { path.resolve = original }
  for (const relative of ['workers', 'private/users.json', 'web/dist', 'uncreated-data']) {
    assert.ok(resolutions.some(args => args[0] === f.directory && args[1] === relative), relative)
  }
  assert.equal(await readFile(f.file, 'utf8'), 'invalid current host: [')
  assert.deepEqual((await readdir(f.directory)).sort(), ['agent-bindings.yaml', 'host.yaml'])
})

test('explicit model slots project only environment references and configured flags without exposing credentials', () => {
  const slots = ['model', 'developmentModel', 'vision', 'personMemoryExtraction', 'midtermSummary', 'groupMemoryExtraction', 'textTriggerModel']
  const env = {}, declared = {}, reads = []
  for (const [index, slot] of slots.entries()) {
    env[`KEY_${index}`] = `PRIVATE_CANDIDATE_KEY_${index}_20261117`
    declared[slot] = { baseUrl: `https://provider-${index}.example/v1`, name: `model-${index}`, apiKeyEnv: `KEY_${index}` }
  }
  const watched = new Proxy(env, { get(object, key) { reads.push(key); assert.ok([...Object.keys(env), 'BL_AGENT_REDIS_URL'].includes(key)); return object[key] } })
  const result = createStandaloneAgentCandidateValidator('/uncreated/candidate/host.yaml', watched)(sources({ config: host({ ...declared, personaGuard: { enabled: true, badPatterns: ['坏模式'] } }) }))
  assert.deepEqual(Object.keys(result.models), slots)
  for (const slot of slots) assert.deepEqual(result.models[slot], { ...declared[slot], apiKeyConfigured: true })
  assert.deepEqual(result.personaGuard, { enabled: true, badPatterns: ['坏模式'] })
  assert.equal(new Set(reads).size, slots.length + 1); assert.equal(reads.includes(''), false)
  for (const secret of Object.values(env)) assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('chatApiKey'), false)
})

test('development accepts only a server credential reference and leaves the main model distinct', async t => {
  const developmentModel = { baseUrl: 'https://development.example/v1', name: 'code-model', apiKeyEnv: 'DEVELOPMENT_KEY' }
  const f = await fixture(t, sources({ config: host({ developmentModel }) }))
  const env = { MAIN_KEY: 'test-main', DEVELOPMENT_KEY: 'test-development' }
  assert.throws(() => readStandaloneAgentConfig(f.file, { MAIN_KEY: env.MAIN_KEY }), /DEVELOPMENT_KEY/u)
  const config = readStandaloneAgentConfig(f.file, env)
  assert.equal(config.execution.chatAiConfig.chatApiModel, 'main')
  assert.equal(config.execution.taskAiConfig.development.model, 'code-model')
  assert.equal(config.execution.taskAiConfig.development.apiKey, env.DEVELOPMENT_KEY)
  const validate = createStandaloneAgentCandidateValidator(f.file, env)
  assert.equal(validate(sources()).models.developmentModel, undefined)
  assert.throws(() => validate(sources({ config: host({ developmentModel: { ...developmentModel, apiKey: 'bare-key' } }) })), /仅支持/u)
})

test('candidate credentials retain startup rules while explicit inspection accepts missing declared keys', () => {
  const values = sources({ config: host({ vision: { baseUrl: 'https://vision.example/v1', name: 'vision', apiKeyEnv: 'VISION_KEY' } }) })
  assert.throws(() => createStandaloneAgentCandidateValidator('/absent/host.yaml', {})(values), /MAIN_KEY/u)
  assert.throws(() => createStandaloneAgentCandidateValidator('/absent/host.yaml', { MAIN_KEY: 'main' })(values), /VISION_KEY/u)
  const result = createStandaloneAgentCandidateValidator('/absent/host.yaml', {}, { requireCredentials: false })(values)
  assert.equal(result.models.model.apiKeyConfigured, false); assert.equal(result.models.vision.apiKeyConfigured, false)
})

test('main model reasoning effort is explicit, validated offline and reaches text and tool requests', async t => {
  const f = await fixture(t, sources({ config: host({ model: { ...model, reasoningEffort: 'low' } }) }))
  const config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-key' })
  assert.equal(config.execution.chatAiConfig.chatReasoningEffort, 'low')
  const { modelExecutor } = await import('./helpers/modelExecutor.js')
  const requests = []
  const executor = modelExecutor(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
  })
  const request = { messages: [{ role: 'user', content: 'fixture' }] }
  await executor.YTapi(request, config.execution)
  await executor.YTapi({ ...request, tools: [{ type: 'function', function: { name: 'run' } }], tool_choice: 'required' }, config.execution)
  assert.deepEqual(requests.map(value => value.reasoning_effort), ['low', 'low'])
  const validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'private-key' })
  for (const reasoningEffort of ['', 'auto', 'LOW', 1, true, null]) {
    assert.throws(() => validate(sources({ config: host({ model: { ...model, reasoningEffort } }) })), /model.reasoningEffort/u)
  }
  for (const reasoningEffort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.doesNotThrow(() => validate(sources({ config: host({ model: { ...model, reasoningEffort } }) })))
  }
})

test('candidate and startup reject the same invalid business configuration including unrelated tool and bridge policies', async t => {
  const f = await fixture(t), validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'main' })
  for (const change of [{ dice: { enabled: true, maxRounds: 0 } }, { textTrigger: { mode: 'auto' } },
    { tools: { mcp: { servers: { worker: { type: 'stdio', command: 'node', cwd: 42 } } } } },
    { textGroups: [{ connectionId: 'main', conversationId: '999999' }] },
    { connections: [{ id: 'main', transport: 'unsupported', url: 'ws://127.0.0.1:3001' }] },
    { tools: { pixiv: { enabled: true } } }, { simulation: { consistency: { enabled: true } } },
    { personaGuard: { enabled: 'yes' } }, { privateChat: { enabled: true, allowTools: ['sendGiftTool'] } },
  ]) {
    const values = sources({ config: host(change) })
    assert.throws(() => validate(values))
    await writeFile(f.file, values.host)
    assert.throws(() => readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }))
  }
  assert.equal(validate(sources({ config: host({ extensionOwned: { future: true } }) })).models.model.name, 'main')
})

test('strict template parsing rejects malformed libraries, duplicates, missing references and agent state collisions', async t => {
  const f = await fixture(t), validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'main' })
  const cases = [sources({ library: [] }), sources({ library: { personas: 'invalid' } }),
    sources({ library: { personas: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }] } }),
    sources({ library: { personas: [{ id: 'a', name: 'Same' }, { id: 'b', name: 'same' }] } }),
    sources({ library: { personas: [{ id: 'default', name: 'Reserved' }] } }),
    sources({ library: { personas: [{ id: 'a', name: 'A', moods: [{ name: 'x', hint: '', probability: 2 }] }] } }),
    sources({ library: { personas: [], groupBindings: { '310931': 'missing' } } }),
    sources({ library: { personas: [], accountBindings: { '19000931': 'missing' } } }),
    sources({ library: { personas: [], privateBinding: 'missing' } }),
    sources({ directory: bindings({ agents: [{ id: 'daily', personaId: 'missing' }] }) }),
    sources({ directory: bindings({ agents: [{ id: 'daily', personaId: 'default' }, { id: 'unused', personaId: 'missing' }] }) }),
    sources({ library: { personas: [{ id: 'agent:daily', name: 'Collision' }] } }),
  ]
  cases.push({ ...sources(), personas: 'personas: [' })
  for (const values of cases) {
    assert.throws(() => validate(values))
    await writeFile(f.file, values.host); await writeFile(path.join(f.directory, 'agent-bindings.yaml'), values.bindings)
    if (values.personas === undefined) await rm(path.join(f.directory, 'persona-library.yaml'), { force: true })
    else await writeFile(path.join(f.directory, 'persona-library.yaml'), values.personas)
    assert.throws(() => readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }))
  }
})

test('cross-template assignment validates every role while preserving separate agent state identity', async t => {
  const f = await fixture(t, sources({ library: { personas: [{ id: 'quiet', name: '安静', tone: '克制' }, { id: 'lively', name: '活跃', tone: '轻快' }] },
    directory: bindings({ agents: [{ id: 'daily', personaId: 'quiet' }, { id: 'unused', personaId: 'lively' }] }) }))
  const validate = createStandaloneAgentCandidateValidator(f.file, { MAIN_KEY: 'main' }), result = validate(f.values)
  assert.equal(result.persona.name, '默认角色')
  let config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' })
  assert.equal(config.resolvePersona(target).personaId, 'agent:daily'); assert.equal(config.resolvePersona(target).persona.tone, '克制')
  const next = { ...f.values, bindings: JSON.stringify(bindings({ agents: [{ id: 'daily', personaId: 'lively' }, { id: 'unused', personaId: 'quiet' }] })) }
  validate(next); await writeFile(path.join(f.directory, 'agent-bindings.yaml'), next.bindings)
  assert.equal(config.isConfigCurrent(), true, 'bindings retain their independent hot-reload semantics')
  assert.equal(config.resolvePersona(target).persona.tone, '轻快')
  assert.throws(() => config.checkBindings(), /角色绑定文件已改变/u)
  config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }); assert.equal(config.checkBindings().get('main').simulationGroups, 1)
})

test('host and library source changes revoke the captured startup snapshot and new loads become current', async t => {
  const f = await fixture(t), config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' })
  await writeFile(path.join(f.directory, 'persona-library.yaml'), 'personas: []\n')
  assert.equal(config.isConfigCurrent(), false)
  const created = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }); assert.equal(created.isConfigCurrent(), true)
  await writeFile(f.file, JSON.stringify(host({ dice: { enabled: true } })))
  assert.equal(created.isConfigCurrent(), false)
  const changed = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }); assert.equal(changed.dice.enabled, true); assert.equal(changed.isConfigCurrent(), true)
  await rm(path.join(f.directory, 'persona-library.yaml')); assert.equal(changed.isConfigCurrent(), false)
  assert.equal(readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }).isConfigCurrent(), true)
  assert.deepEqual((await readdir(f.directory)).sort(), ['agent-bindings.yaml', 'host.yaml'])
})

test('a completed binding-only transaction retires captured config even when no reader observed its active fence', async t => {
  const f = await fixture(t), config = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), snapshot = config.sourceSnapshot
  const guard = { signal: new AbortController().signal, ensureCurrent() {} }
  const lock = await acquireStandaloneAgentConfigLock(snapshot, guard)
  const raw = JSON.parse(snapshot.sources.bindings)
  raw.agents.push({ id: 'second', personaId: 'default' })
  try {
    lock.commitSources({ ...snapshot.sources, bindings: JSON.stringify(raw) }, snapshot,
      { ensureActorCurrent() {}, onFenced() {}, onCommitPublished() {} })
  } finally { lock.release() }
  assert.equal(config.isConfigCurrent(), false)
  assert.deepEqual(config.listBindings(), [])
  assert.equal(config.resolvePersona(target), undefined)
  assert.throws(() => config.checkBindings(), /绑定文件已改变/u)
  const fresh = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' })
  assert.equal(fresh.isConfigCurrent(), true)
  assert.equal(fresh.workspaceAgents.some(agent => agent.id === 'second'), true)
})

test('a source edit during startup credential resolution cannot produce a mixed or current configuration', async t => {
  const f = await fixture(t), next = JSON.stringify(host({ dice: { enabled: true } }))
  let changed = false
  const env = new Proxy({ MAIN_KEY: 'main' }, { get(object, key) {
    if (key === 'MAIN_KEY' && !changed) { changed = true; fs.writeFileSync(f.file, next) }
    return object[key]
  } })
  assert.throws(() => readStandaloneAgentConfig(f.file, env), /配置已改变/u)
  const fresh = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' })
  assert.equal(fresh.sourceSnapshot.sources.host, next); assert.equal(fresh.dice.enabled, true); assert.equal(fresh.isConfigCurrent(), true)
})

test('candidate validation reuses the real binding snapshot revision for full Dice grants while preserving the four-field console projection', async t => {
  const f = await fixture(t), initial = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), binding = initial.listBindings()[0]
  const grant = {
    binding: JSON.parse(JSON.stringify(binding)), revision: 'candidate-grant-revision', actorId: 'alice',
    permissions: ['player', 'admin'], subjects: [],
  }
  const configuredHost = host({ dice: {
    enabled: true, maxDiceCount: 40, maxDiceSides: 10000, maxRounds: 10,
    engine: { enabled: true, revision: 'candidate-engine-revision', grants: [grant] },
  } })
  await writeFile(f.file, JSON.stringify(configuredHost))
  const loaded = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), snapshot = loaded.sourceSnapshot
  assert.equal(loaded.listBindings()[0].revision, snapshot.versions.bindings)
  const validate = createStandaloneAgentCandidateValidator(snapshot.hostFile, { MAIN_KEY: 'main' }, { sourceSnapshot: snapshot })
  const changedModel = JSON.parse(JSON.stringify(configuredHost)); changedModel.model.name = 'candidate-model'
  const changedPersona = JSON.parse(JSON.stringify(configuredHost)); changedPersona.persona.tone = '候选语气'
  const methods = ['readFileSync', 'statSync', 'lstatSync', 'openSync', 'realpathSync', 'mkdirSync', 'writeFileSync']
  const original = Object.fromEntries(methods.map(key => [key, fs[key]])), fetch = globalThis.fetch
  try {
    for (const key of methods) fs[key] = () => assert.fail(`baseline candidate touched fs.${key}`)
    globalThis.fetch = () => assert.fail('baseline candidate opened the network')
    const candidateModel = validate(sources({ config: changedModel, directory: JSON.parse(snapshot.sources.bindings) }))
    assert.equal(candidateModel.models.model.name, 'candidate-model')
    assert.deepEqual(candidateModel.dice, { enabled: true, maxDiceCount: 40, maxDiceSides: 10000, maxRounds: 10 })
    assert.deepEqual(Object.keys(candidateModel.dice).sort(), ['enabled', 'maxDiceCount', 'maxDiceSides', 'maxRounds'])
    const candidatePersona = validate(sources({ config: changedPersona, directory: JSON.parse(snapshot.sources.bindings) }))
    assert.equal(candidatePersona.persona.tone, '候选语气')
    assert.deepEqual(candidatePersona.dice, candidateModel.dice)
  } finally { Object.assign(fs, original); globalThis.fetch = fetch }
})

test('changing binding bytes invalidates the old full Dice grant instead of deriving a new binding revision', async t => {
  const f = await fixture(t), initial = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), binding = initial.listBindings()[0]
  const configuredHost = host({ dice: {
    enabled: true, engine: { enabled: true, grants: [{
      binding: JSON.parse(JSON.stringify(binding)), revision: 'candidate-grant-revision', actorId: 'alice', permissions: ['player'], subjects: [],
    }] },
  } })
  await writeFile(f.file, JSON.stringify(configuredHost))
  const loaded = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), validate = createStandaloneAgentCandidateValidator(loaded.sourceSnapshot.hostFile, { MAIN_KEY: 'main' }, { sourceSnapshot: loaded.sourceSnapshot })
  const changedBindings = JSON.parse(loaded.sourceSnapshot.sources.bindings)
  changedBindings.bindings[0].conversationId = '310932'
  const candidate = sources({ config: configuredHost, directory: changedBindings })
  assert.throws(() => validate(candidate), /骰子|绑定|配置/u)
  assert.throws(() => validate({ ...loaded.sourceSnapshot.sources, bindings: loaded.sourceSnapshot.sources.bindings + '\n' }), /骰子|绑定|配置/u,
    'even a whitespace-only binding edit changes authority revision instead of silently rebasing its grant')
  const withoutBaseline = createStandaloneAgentCandidateValidator(loaded.sourceSnapshot.hostFile, { MAIN_KEY: 'main' })
  assert.throws(() => withoutBaseline(loaded.sourceSnapshot.sources), /骰子|绑定|配置/u,
    'a full startup grant cannot be guessed from binding content without its captured baseline')
})

test('candidate snapshot authority belongs only to its captured canonical host path', async t => {
  const f = await fixture(t), loaded = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' }), snapshot = loaded.sourceSnapshot
  assert.throws(() => createStandaloneAgentCandidateValidator(path.join(snapshot.root, 'other-host.yaml'), { MAIN_KEY: 'main' }, { sourceSnapshot: snapshot }), /快照.*宿主/u)
  const validate = createStandaloneAgentCandidateValidator(snapshot.hostFile, { MAIN_KEY: 'main' }, { sourceSnapshot: snapshot })
  assert.equal(validate(snapshot.sources).models.model.name, 'main')
})

test('persona extensions survive in source bytes while runtime resolution and public candidates contain only supported fields', async t => {
  const sentinel = 'SECRET_SENTINEL_PERSONA_EXTENSION_20261117'
  const librarySource = `# Preserve this comment and opaque extension bytes exactly.\nrootExtension:\n  privateSentinel: ${sentinel}_ROOT\npersonas:\n  - id: quiet\n    name: 安静角色\n    identity: 夜间值守\n    tone: 克制\n    speechStyle: [简洁, 温和]\n    templateExtension:\n      privateSentinel: ${sentinel}_TEMPLATE\n    moods:\n      - name: calm\n        hint: 轻声回复\n        probability: 0.25\n        moodExtension:\n          privateSentinel: ${sentinel}_MOOD\n`
  const values = { ...sources({ directory: bindings({ agents: [{ id: 'daily', personaId: 'quiet' }] }) }), personas: librarySource }
  const f = await fixture(t, values), loaded = readStandaloneAgentConfig(f.file, { MAIN_KEY: 'main' })
  const resolved = loaded.resolvePersona(target)
  assert.equal(resolved.personaId, 'agent:daily')
  assert.equal(resolved.persona.name, '安静角色'); assert.equal(resolved.persona.identity, '夜间值守'); assert.equal(resolved.persona.tone, '克制')
  assert.deepEqual(resolved.persona.speechStyle, ['简洁', '温和'])
  assert.deepEqual(resolved.persona.moods, [{ name: 'calm', hint: '轻声回复', probability: 0.25 }])
  assert.equal(JSON.stringify(resolved).includes(sentinel), false)
  const validate = createStandaloneAgentCandidateValidator(loaded.sourceSnapshot.hostFile, { MAIN_KEY: 'main' }, { sourceSnapshot: loaded.sourceSnapshot })
  const candidate = validate(loaded.sourceSnapshot.sources)
  assert.equal(candidate.persona.name, '默认角色'); assert.equal(candidate.persona.tone, '自然')
  assert.deepEqual(candidate.persona.speechStyle, ['简洁'])
  assert.equal(JSON.stringify(candidate).includes(sentinel), false)
  assert.equal(loaded.sourceSnapshot.sources.personas, librarySource)
  assert.equal(await readFile(path.join(f.directory, 'persona-library.yaml'), 'utf8'), librarySource)
})
