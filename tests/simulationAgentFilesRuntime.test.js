import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { characterKey } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
let fixtureId = 0
const marker = '文件正文只限本轮使用'
const derived = '文件查证派生答复只限本轮'
const file = { name: 'budget.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: Buffer.from(marker).toString('base64') }
const call = (name, args = {}, id = name) => ({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const finish = (send = false) => call('simFinishTurn', { choice: send ? 'chat' : 'silent', reason: derived, ...(send ? { messages: [derived] } : {}) })
const section = () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
  personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
  wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { maxToolRounds: 12, minSendGapMs: 0, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } })
async function waitFor(probe, diagnostic) {
  const until = performance.now() + 7000
  while (performance.now() < until) { if (await probe()) return; await delay(15) }
  assert.fail(diagnostic())
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'simulation-files'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `files-runtime-${++fixtureId}`, id: 'robot' }, target = { account, kind: 'group', id: 'room' }
  const sender = { ...account, id: 'human' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'files-initial'), clock = Date.now(), attempts = 0, externalActions = 0, catalog = []
  const initialBinding = directory.resolve(target), key = simulationAddressKey(target), address = personMemoryAddress(target)
  const identity = { botId: address.botId, personaId: agentPersonaScopeId(initialBinding.agentId) }
  const memory = createPersonMemoryStore({ redis: storage, now: () => clock })
  const state = createDefaultSimSession(clock)
  state.bootstrapSent = true; state.botId = account.id; state.personaId = identity.personaId; state.bindingToken = agentBindingToken(initialBinding)
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  state.nextProactiveCheckAt = clock + 86_400_000
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const originals = new Map(), recalled = new Set(), requests = [], sends = [], observed = [], reads = [], toolCalls = [], diagnostics = [], records = []
  const f = { ...redis, account, target, sender, key, address, identity, initialBinding, originals, recalled, requests, sends, observed, reads, toolCalls, diagnostics, memory, records,
    get attempts() { return attempts }, get externalActions() { return externalActions }, get now() { return clock },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'files-rebound') },
    catalog(entries) { catalog = structuredClone(entries) },
    async emit(id, { text = '', names = [], quoteId, author = sender.id, at = clock, directed = false } = {}) {
      const incoming = { version: 1, conversation: target, sender: { ...sender, id: author }, senderName: author,
        messageId: id, occurredAt: at, text, parts: [...(text ? [{ kind: 'text', text }] : []), ...names.map(name => ({ kind: 'file', name, resource: { kind: 'url', value: 'https://provider.example/private-token' } }))],
        mentions: directed ? [account] : [], directedToAccount: directed, ...(quoteId ? { quote: { messageId: quoteId, parts: [] } } : {}) }
      originals.set(id, structuredClone(incoming)); await runtime.ingest(incoming)
    },
    async trigger(extra = {}) { clock++; await f.emit('trigger', { text: '请查看这个文件', directed: true, ...extra }) },
    async session() { return JSON.parse(await storage.get(simulationSessionKey(key))) },
    async wait() { await waitFor(async () => toolCalls.length > 0 && !await reader.exists(prefix + simulationBusyKey(key)), () => `file turn did not settle: ${diagnostics.join('|')}`); await runtime.drain() },
    async assertEphemeral() {
      const session = await f.session()
      assert.doesNotMatch(JSON.stringify(session.agentHistory), new RegExp(`${marker}|${derived}`)); assert.equal(session.lastConfirmedChat, undefined)
      const character = JSON.parse(await storage.get(characterKey({ ...identity, groupId: address.scene.id })) || 'null')
      if (character) {
        assert.deepEqual(character.memories, []); assert.deepEqual(character.goals, [])
        assert.doesNotMatch(JSON.stringify(character), new RegExp(`${marker}|${derived}`))
        assert.equal(character.receipts.some(receipt => ['excelWorkbookTool', 'chatHistoryTool'].includes(receipt.toolName)), false)
      }
      assert.deepEqual(observed, []); assert.deepEqual(records, [])
      for (const redisKey of await reader.keys(prefix + '*')) if (await reader.type(redisKey) === 'string') assert.doesNotMatch(await reader.get(redisKey), new RegExp(`${marker}|${derived}`), redisKey)
    },
  }
  const excel = { name: 'excelWorkbookTool', description: 'Scoped file reader fixture', parameters: { type: 'object', properties: {}, required: [] },
    async execute(input, event) {
      toolCalls.push(structuredClone(input))
      if (input.action === 'list') return JSON.stringify(await event._listAgentFiles({}, () => true, new AbortController().signal))
      const result = await event._readAgentFile(input.selection ?? {}, () => true, new AbortController().signal)
      return JSON.stringify({ text: marker, origin: result.origin, name: result.name })
    } }
  const history = { name: 'chatHistoryTool', description: 'Read-only history fixture', parameters: { type: 'object', properties: {}, required: [] },
    async execute(input, event) { return event._readAgentHistory(input, () => true, new AbortController().signal) } }
  const external = { name: 'externalFixtureTool', description: 'Forbidden external action', parameters: { type: 'object', properties: {}, required: [] },
    async execute() { externalActions++; return derived } }
  const runtime = createSimulationRuntime({ redis: storage, logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    now: () => clock, random: () => 0.99, handlesTarget: () => true, isAccountReady: () => true,
    getSelf: () => ({ id: account.id, name: 'fixture' }), getPersona: () => ({ binding: directory.resolve(target), persona: { name: 'fixture' }, systemContent: '' }),
    getSection: section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }), extraToolsPlatformNeutral: true,
    listRegistryToolNames: () => ({ builtIn: [excel.name, history.name, external.name], all: [excel.name, history.name, external.name] }), getExtraTools: () => [excel, history, external],
    async readQuotedMessage(_target, id, guard) { return guard.isCurrent() && originals.has(id) ? structuredClone(originals.get(id)) : undefined },
    async isMessageRecalled(_target, id) { return recalled.has(id) },
    async readMessageFile(_target, source, index, guard) {
      reads.push({ source, index }); await guard.ensureCurrent?.()
      const original = originals.get(source.quotedMessageId ?? source.messageId)
      if (!original || !await guard.allowsSource(structuredClone(original))) return undefined
      await options.duringRead?.(f)
      return file
    },
    async listConversationFiles(_target, guard) { await guard.ensureCurrent?.(); return { target, observedAt: clock, files: structuredClone(catalog), truncated: false } },
    async readConversationFile(_target, entry, guard) { reads.push({ entry }); return await guard.allowsFile(entry) ? file : undefined },
    async readPublicFile() { reads.push({ public: true }); return file },
    readHistory: async () => ({ text: marker, isCurrent: async () => true }),
    recordToolResult: result => observed.push(result), recordGroupReply: () => records.push('group'), recordEpisode: () => records.push('episode'),
    messageActions: { async send(action, guard) { if (!guard.isCurrent()) return { state: 'failed', code: 'cancelled' }; sends.push(structuredClone(action)); return { state: 'sent', messageId: 'file-reply' } } },
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      attempts++
      await options.beforeModel?.(f, attempts, request)
      await ensureCurrent?.()
      requests.push(structuredClone(request))
      if (options.script) return options.script(f, requests.length, request)
      return requests.length === 1 ? call('excelWorkbookTool', options.input ?? {}) : finish(options.send ?? false)
    },
  })
  f.runtime = runtime
  t.after(async () => { runtime.stop(); await runtime.drain() })
  return f
}

test('pure file, text+file and verified quote enter recent with bounded display metadata, without resource URLs', redisTest, async t => {
  const f = await fixture(t)
  await f.emit('pure-file', { names: ['pure.xlsx'] }); await f.emit('with-text', { text: '附件在这里', names: ['text.xlsx'] })
  await f.emit('quote-file', { quoteId: 'pure-file' })
  const session = await f.session()
  assert.deepEqual(session.recent.map(message => message.messageId), ['pure-file', 'with-text', 'quote-file'])
  assert.deepEqual(session.recent[0].files, [{ name: 'pure.xlsx' }]); assert.deepEqual(session.recent[2].quoteSource.file.files, [{ name: 'pure.xlsx' }])
  assert.doesNotMatch(JSON.stringify(session), /provider.example|private-token|resource/u)
})

test('file reads and their derived safe reply remain ephemeral, while durable and external actions are denied', redisTest, async t => {
  const f = await fixture(t, { async script(f, round, request) {
    if (round === 1 || round === 7) return call('excelWorkbookTool')
    if (round === 2) { assert.match(request.messages.findLast(row => row.name === 'excelWorkbookTool').content, new RegExp(marker)); return call('simRemember', { kind: 'pendingEvent', content: derived, aboutUser: f.sender.id }) }
    if (round === 3) return call('externalFixtureTool')
    if (round === 4) return call('simFinishTurn', { choice: 'chat', reason: derived, memories: [{ text: derived }], messages: [derived] })
    if (round === 5) return call('simFinishTurn', { choice: 'schedule', reason: derived, goal: { title: derived } })
    if (round === 6) return call('chatHistoryTool', {})
    return finish(true)
  } })
  await f.trigger({ names: ['budget.xlsx'] }); await f.wait()
  assert.equal(f.requests.length, 8); assert.equal(f.reads.length, 2); assert.equal(f.externalActions, 0); assert.equal(f.sends.length, 1)
  assert.match(JSON.stringify(f.sends), new RegExp(derived)); await f.assertEphemeral()
})

test('failed file reads are also ephemeral and do not create file action receipts or observer output', redisTest, async t => {
  const f = await fixture(t, { input: { selection: { sourceSeq: 9999 } }, send: true })
  await f.trigger({ names: ['budget.xlsx'] }); await f.wait()
  assert.equal(f.requests.length, 2); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 1)
  await f.assertEphemeral()
})

test('message projection rejects fresh source identity changes at model and send boundaries', redisTest, async t => {
  for (const mode of ['author', 'time', 'target', 'files', 'request-text', 'recall', 'binding', 'privacy']) await t.test(mode, async t => {
    const f = await fixture(t, { send: true, async beforeModel(f, attempt) {
      if (attempt !== 2) return
      const original = f.originals.get('trigger')
      if (mode === 'author') original.sender.id = 'other-human'
      if (mode === 'time') original.occurredAt--
      if (mode === 'target') original.conversation.id = 'other-room'
      if (mode === 'files') original.parts = [{ kind: 'file', name: 'replacement.xlsx' }]
      if (mode === 'request-text') original.text = '现在不要读取这个文件'
      if (mode === 'recall') f.recalled.add('trigger')
      if (mode === 'binding') f.rebind()
      if (mode === 'privacy') await f.memory.setEnabled({ identity: f.identity, subjectId: f.sender.id, scene: f.address.scene, enabled: false })
    } })
    await f.trigger({ names: ['budget.xlsx'] }); await f.wait()
    assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); await f.assertEphemeral()
  })
})

test('quoted file provenance is rechecked against its live wrapper and original before sending', redisTest, async t => {
  for (const mode of ['quote-wrapper', 'quote-wrapper-text', 'original-recall']) await t.test(mode, async t => {
    const f = await fixture(t, { async script(f, round) {
      if (round === 1) return call('excelWorkbookTool')
      if (mode === 'quote-wrapper') f.originals.get('trigger').quote.messageId = 'different-quote'
      else if (mode === 'quote-wrapper-text') f.originals.get('trigger').text = '现在不要读取引用文件'
      else f.recalled.add('quoted-file')
      return finish(true)
    } })
    await f.emit('quoted-file', { names: ['quoted.xlsx'], author: 'other-human', at: f.now - 1000 })
    await f.trigger({ quoteId: 'quoted-file' }); await f.wait()
    assert.equal(f.reads.length, 1); assert.equal(f.sends.length, 0); await f.assertEphemeral()
  })
})

test('current human request normalization accepts equivalent whitespace without accepting edited text', redisTest, async t => {
  const f = await fixture(t, { send: true })
  await f.trigger({ names: ['budget.xlsx'], text: '请  查看\n  这个文件' }); await f.wait()
  assert.equal(f.reads.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  await f.assertEphemeral()
})

test('repository listings and bytes honor uploader privacy before the turn and remain temporary', redisTest, async t => {
  const f = await fixture(t, { input: { action: 'list' } })
  await f.memory.setEnabled({ identity: f.identity, subjectId: 'uploader', scene: f.address.scene, enabled: false })
  f.catalog([{ reference: 'disabled-file', name: 'secret.xlsx', folderPath: '/', size: 4, uploadedBy: { ...f.sender, id: 'uploader' }, uploadedAt: f.now - 1000 },
    { reference: 'unattributed-file', name: 'unknown.xlsx', folderPath: '/', size: 4 }])
  await f.trigger(); await f.wait()
  const result = f.requests[1].messages.findLast(row => row.name === 'excelWorkbookTool')
  assert.deepEqual(JSON.parse(result.content).files, []); assert.doesNotMatch(result.content, /secret.xlsx|unknown.xlsx/u)
  await f.assertEphemeral()
})

test('new authorized repository uploads after a prior forgetting cutoff can be read and later directory replacement revokes the result', redisTest, async t => {
  const f = await fixture(t, { input: { selection: { fileName: 'new.xlsx' } }, async script(f, round) {
    if (round === 1) return call('excelWorkbookTool', { selection: { fileName: 'new.xlsx' } })
    f.catalog([]); return finish(true)
  } })
  await f.memory.forget({ identity: f.identity, subjectId: 'uploader', scene: f.address.scene, before: f.now - 2000 })
  f.catalog([{ reference: 'new-file', name: 'new.xlsx', folderPath: '/', size: 4, uploadedBy: { ...f.sender, id: 'uploader' }, uploadedAt: f.now - 1000 }])
  await f.trigger(); await f.wait()
  assert.equal(f.reads.length, 1); assert.equal(f.sends.length, 0); await f.assertEphemeral()
})
