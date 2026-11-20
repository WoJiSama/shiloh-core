import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createStandaloneAgentConsoleGames } from '../dist/backend/bootstrap/standaloneAgentConsoleGames.js'
import { createStandaloneAgentConsoleDirectory } from '../dist/backend/bootstrap/standaloneAgentConsoleDirectory.js'
import { createStandaloneAgentConsoleImages } from '../dist/backend/bootstrap/standaloneAgentConsoleImages.js'
import { createStandaloneAgentConsoleSemantic } from '../dist/backend/bootstrap/standaloneAgentConsoleSemantic.js'
import { createStandaloneAgentConsoleStyle } from '../dist/backend/bootstrap/standaloneAgentConsoleStyle.js'
import { agentTurtleSoupDirectory } from '../dist/backend/modules/games/infrastructure/agentTurtleSoup.js'
import { TurtleSoupStore, resolveTurtleSoupConfig } from '../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import { puzzleContentHash } from '../dist/backend/modules/games/domain/turtleSoup/turtleSoupQuality.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const allowed = () => true
const binding = (id = '2001') => ({
  source: 'configured', id: 'test', revision: 'r1', connectionId: 'test', agentId: 'a', personaId: 'a',
  target: { account: { platform: 'qq', namespace: 'global', id }, kind: 'group', id: '3011' },
})
function context(selected) {
  return {
    principal: { id: 'operator', username: 'operator', via: 'session' },
    signal: new AbortController().signal, isCurrent: allowed, ensureCurrent() {},
    ...(selected ? { binding: selected } : {}),
  }
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-core-legacy-console-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function save(directory, name, value) {
  const filename = path.join(directory, name)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value))
}
function invoke(services, operation, actor = context(), options = {}) {
  const service = services.find(item => item.operation === operation)
  assert.ok(service?.handle, operation)
  return service.handle({ method: service.method, pathname: service.path, params: {}, query: {}, body: {}, ...options }, actor)
}

test('the restored directory projects only current authorized bindings and the original cached group names', async t => {
  const dataDir = temp(t)
  save(dataDir, 'legacy-source/data/group_names.json', { 3011: '原群名', 3012: '未绑定群' })
  const visible = binding('2001')
  const hidden = binding('2002')
  const directory = createStandaloneAgentConsoleDirectory({
    dataDir, bindings: { list: () => [visible, hidden], resolve: () => visible },
    adapters: [visible, hidden].map(row => ({
      account: row.target.account, id: 'qq-' + row.target.account.id, botName: '机器人', isReady: () => true,
    })),
    auth: { authorize: async (_principal, _operation, selected) => selected === visible ? 'allowed' : 'denied' },
    allowsText: allowed,
  })
  const result = await directory.read(context())
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].name, '原群名')
  assert.equal(result.groups[0].account.id, '2001')
  assert.deepEqual(result.bots.map(bot => bot.id), ['2001'])
})

test('the image console saves real Core output, serves its bytes and keeps the history across process construction', async t => {
  const dataDir = temp(t)
  const backend = { baseUrl: 'https://fixture.example/v1', name: 'Fixture', apiKey: 'private-fixture-provider-key' }
  const requests = []
  const options = {
    dataDir, generation: backend,
    async fetchImpl(url, request) {
      assert.equal(url, 'https://fixture.example/v1/images/generations')
      const input = JSON.parse(request.body)
      requests.push(input)
      return Response.json({ data: [{ b64_json: png }, { b64_json: png }] })
    },
  }
  const services = createStandaloneAgentConsoleImages(options)
  const providers = await invoke(services, 'images.providers')
  assert.equal(providers.value.generation[0].label, 'Fixture')
  assert.ok(!JSON.stringify(providers.value).includes(backend.apiKey))
  const result = await invoke(services, 'images.generate', context(), {
    contentType: 'application/json',
    bytes: Buffer.from(JSON.stringify({ prompt: 'A small watercolour', n: 2 })),
  })
  assert.equal(result.value.count, 2)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].n, 2)
  const reopened = createStandaloneAgentConsoleImages(options)
  const history = await invoke(reopened, 'images.history')
  assert.equal(history.value.length, 1)
  assert.equal(history.value[0].count, 2)
  assert.equal(history.value[0].prompt, 'A small watercolour')
  const asset = await invoke(reopened, 'images.read', context(), { params: { name: result.value.images[0].file } })
  assert.deepEqual(asset.value, Buffer.from(png, 'base64'))
  await assert.rejects(invoke(reopened, 'images.read', context(), { params: { name: '../fixture.png' } }))
})

test('the console reads and edits the migrated game partition and rejects a stale puzzle update', async t => {
  const dataDir = temp(t)
  const selected = binding()
  const directory = agentTurtleSoupDirectory(path.join(dataDir, 'games'), selected.target.account, selected.agentId)
  const store = new TurtleSoupStore({ baseDir: directory })
  const puzzle = { id: 'migrated', title: '雨夜的伞', surface: '雨夜，他撑着伞仍然撞上了树，为什么？',
    solution: '他用伞探路', keyPoints: ['探路'], hints: [], difficulty: 'normal', tags: [],
    source: 'manual', createdAt: 1, status: 'pending', ratingSum: 0, ratingCount: 0 }
  await store.savePuzzle(puzzle)
  const services = createStandaloneAgentConsoleGames({
    config: { turtleSoup: { ...resolveTurtleSoupConfig({}), enabled: true }, operatorIds: [] }, dataDir,
    execution: { chatAiConfig: {} }, executionSignal: new AbortController().signal, isCurrent: allowed,
    allowsText: allowed, async execute() { assert.fail('Reading or changing a status never calls a model') },
  })
  const read = await invoke(services, 'turtle-soup.read', context(selected))
  assert.deepEqual(read.value.puzzles.map(item => item.id), ['migrated'])
  const other = binding('2002')
  const untouched = agentTurtleSoupDirectory(path.join(dataDir, 'games'), other.target.account, other.agentId)
  assert.equal((await invoke(services, 'turtle-soup.read', context(other))).value.puzzles.length, 0)
  assert.equal(fs.existsSync(untouched), false)
  const change = { params: { id: 'migrated' }, body: { status: 'retired', reason: 'test', contentHash: 'stale' } }
  await assert.rejects(invoke(services, 'turtle-soup.status', context(selected), change))
  change.body.contentHash = puzzleContentHash(store.readPuzzles().puzzles[0])
  await invoke(services, 'turtle-soup.status', context(selected), change)
  assert.equal(store.readPuzzles().puzzles[0].status, 'retired')
})

test('archived expression preferences trim the displayed copy and preserve the original snapshot', async t => {
  const dataDir = temp(t)
  const root = path.join(dataDir, 'legacy-console')
  save(root, 'manifest.json', { version: 1, legacyAccount: '2001' })
  save(root, 'style/style_memory.json', {
    totalSamples: 12, aiRules: { absorb: [{ key: 'rule1', label: '简短', rule: '保留简短回答', confidence: 0.8 }], avoid: [] },
  })
  save(root, 'style/groups/3011.json', { words: { 测试词: 5, 其他词: 4 } })
  const selected = binding()
  const options = {
    dataDir, bindings: { list: () => [selected, binding('2002')], resolve: () => selected },
    auth: { authorize: async () => 'allowed' }, allowsText: allowed,
  }
  const services = createStandaloneAgentConsoleStyle(options)
  const initial = (await invoke(services, 'style.read')).value
  assert.equal(initial.totalSamples, 12)
  assert.equal(initial.aiRules.absorb.length, 1)
  assert.equal(initial.groups.length, 1)
  await invoke(services, 'style.remove-rule', context(), { body: { kind: 'absorb', key: initial.aiRules.absorb[0].key } })
  await invoke(services, 'style.block-word', context(selected), { body: { word: '测试词' } })
  const revised = (await invoke(createStandaloneAgentConsoleStyle(options), 'style.read')).value
  assert.equal(revised.aiRules.absorb.length, 0)
  assert.deepEqual(revised.groups[0].expressions.words.map(row => row.word), ['其他词'])
  assert.match(fs.readFileSync(path.join(root, 'style/style_memory.json'), 'utf8'), /保留简短回答/u)
})

test('the imported semantic index respects account ownership, forgotten messages and the current privacy state', async t => {
  const dataDir = temp(t)
  const root = path.join(dataDir, 'legacy-console')
  save(root, 'manifest.json', { version: 1, legacyAccount: '2001' })
  const rows = [
    { id: 'kept', group_id: '3011', text: '可见记录', start_ts: 21, message_ids: ['1'], emb: [0.1] },
    { id: 'withdrawn', group_id: '3011', text: '已撤回记录', start_ts: 22, message_ids: ['2'], emb: [0.2] },
  ]
  save(root, 'semantic/group/3011.ndjson', rows.map(row => JSON.stringify(row)).join('\n'))
  save(root, 'semantic/redactions/3011.json', { ids: [], messages: ['2'] })
  let cutoff = 0
  const services = createStandaloneAgentConsoleSemantic({
    dataDir, enabled: false, admin: { cutoff: async () => cutoff }, allowsText: allowed,
  })
  const request = { query: { source: 'legacy' } }
  const match = (await invoke(services, 'semantic.records', context(binding()), request)).value
  assert.equal(match.total, 1)
  assert.deepEqual(match.rows, [{ id: 'kept', text: '可见记录', at: 21, indexed: true }])
  const other = (await invoke(services, 'semantic.records', context(binding('2002')), request)).value
  assert.equal(other.archived, false)
  assert.equal(other.total, 0)
  cutoff = 11
  const restricted = (await invoke(services, 'semantic.records', context(binding()), request)).value
  assert.equal(restricted.privacyRestricted, true)
  assert.equal(restricted.total, 0)
})
