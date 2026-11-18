import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const runNode = promisify(execFile)

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-group-memory-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_GROUP_MAIN_KEY: 'main-key', TEST_GROUP_MEMORY_KEY: 'group-extraction-key' }
  const backend = { baseUrl: 'https://group-memory.example/v1', name: 'group-memory-extractor', apiKeyEnv: 'TEST_GROUP_MEMORY_KEY' }
  function read(sections = {}, { credentials = env, options } = {}) {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, instance: 'group-memory-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_GROUP_MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...sections,
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read, backend, env, file, directory }
}

test('standalone group memory configuration defaults off and requires an explicit extraction backend', t => {
  const { read, backend } = fixture(t)
  const absent = read()
  assert.deepEqual(absent.groupMemory, {})
  assert.equal(absent.groupMemory.enabled === true, false)
  assert.equal(absent.groupMemoryExtraction, undefined)
  assert.equal(Object.hasOwn(absent, 'groupMemoryExtraction'), false)
  assert.equal(read({ groupMemory: { enabled: true } }).groupMemoryExtraction, undefined)
  const configured = read({ groupMemoryExtraction: backend })
  assert.deepEqual(configured.groupMemoryExtraction, {
    apiUrl: 'https://group-memory.example/v1', model: 'group-memory-extractor', apiKey: 'group-extraction-key', apiKeyEnv: 'TEST_GROUP_MEMORY_KEY',
  })
  assert.deepEqual(configured.groupMemory, {}, 'declaring a backend does not enable automatic group learning')
  assert.equal(configured.execution.chatAiConfig.chatApiModel, 'main-model')
  assert.equal(configured.execution.chatAiConfig.chatApiKey, 'main-key')
  const otherBackends = {
    midtermSummary: { ...backend, name: 'summary-model' },
    personMemoryExtraction: { ...backend, name: 'person-model' },
  }
  assert.equal(read({ ...otherBackends, groupMemory: { enabled: true } }).groupMemoryExtraction, undefined,
    'neither person extraction nor summaries become a fallback group extraction model')
})

test('standalone group memory configuration accepts explicit group knowledge tools only on the bound group', t => {
  const { read } = fixture(t)
  const configured = read({ textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['groupKnowledgeTool'] }] })
  const target = { account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001' }
  assert.deepEqual(configured.groupTextTools(target), ['groupKnowledgeTool'])
  assert.deepEqual(configured.groupTextTools({ ...target, id: '90002' }), [])
  assert.throws(() => read({ textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['groupKnowledgeTool', 'groupKnowledgeTool'] }] }),
    /textGroups\.tools 只接受.*groupKnowledgeTool.*工具名不能重复/u)
  assert.throws(() => read({ textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['groupKnowledgeOtherTool'] }] }), /工具名不能重复/u)
})

test('group memory configuration preserves strict controls and the legacy ten minute twelve message values', t => {
  const { read } = fixture(t)
  for (const groupMemory of [
    { enabled: true }, { enabled: false },
    { enabled: true, groupExtractMinIntervalMinutes: 0, groupExtractMaxBatchMessages: 1 },
    { enabled: true, groupExtractMinIntervalMinutes: 1440, groupExtractMaxBatchMessages: 40 },
    { enabled: true, groupExtractMinIntervalMinutes: 10, groupExtractMaxBatchMessages: 12 },
  ]) assert.deepEqual(read({ groupMemory }).groupMemory, groupMemory)
  for (const groupMemory of [null, false, [], 'enabled', 1, { unknown: true }, { enabled: 'true' },
    { enabled: null }, { enabled: 0 }, { apiKey: 'raw-group-key' }, { model: 'main-model' },
    ...[-1, 1441, 0.5, '10', null, true, [], {}, NaN, Infinity].map(groupExtractMinIntervalMinutes => ({ groupExtractMinIntervalMinutes })),
    ...[0, 41, 1.5, '12', null, true, [], {}, NaN, Infinity].map(groupExtractMaxBatchMessages => ({ groupExtractMaxBatchMessages })),
  ]) assert.throws(() => read({ groupMemory }), error => !error.message.includes('raw-group-key'))
})

test('declared group extraction configuration requires its key even when disabled and supports migration preview without credentials', t => {
  const { read, backend } = fixture(t)
  const credentials = { TEST_GROUP_MAIN_KEY: 'main-key' }
  assert.throws(() => read({ groupMemoryExtraction: backend }, { credentials }), /环境变量 TEST_GROUP_MEMORY_KEY 缺少模型 API Key/u)
  assert.throws(() => read({ groupMemoryExtraction: backend, groupMemory: { enabled: false } }, { credentials }), /TEST_GROUP_MEMORY_KEY/u)
  assert.throws(() => read({ groupMemoryExtraction: {} }), /groupMemoryExtraction.baseUrl/u)
  const preview = read({ groupMemoryExtraction: backend }, { credentials: {}, options: { requireCredentials: false } })
  assert.equal(preview.groupMemoryExtraction.apiKey, '')
  assert.equal(preview.groupMemoryExtraction.model, 'group-memory-extractor')
  assert.equal(preview.execution.chatAiConfig.chatApiKey, '')
  assert.equal(read({}, { credentials: {}, options: { requireCredentials: false } }).groupMemoryExtraction, undefined)
})

test('group extraction configuration validates only its three declared model fields and safe endpoint format', t => {
  const { read, backend } = fixture(t)
  const preview = { credentials: {}, options: { requireCredentials: false } }
  for (const invalid of [null, false, [], 'group', 42,
    { ...backend, apiKey: 'raw-group-extraction-key' }, { ...backend, enabled: true },
    { ...backend, timeoutMs: 1000 }, { ...backend, maxTokens: 1000 },
    { ...backend, name: '' }, { ...backend, name: ' ' },
    { ...backend, apiKeyEnv: '' }, { ...backend, apiKeyEnv: 'bad-name' }, { ...backend, apiKeyEnv: 42 },
  ]) {
    assert.throws(() => read({ groupMemoryExtraction: invalid }), error => !error.message.includes('raw-group-extraction-key'))
    assert.throws(() => read({ groupMemoryExtraction: invalid }, preview))
  }
  for (const baseUrl of ['file:///tmp/private-secret', 'not-a-url', 'https://user:private-secret@group-memory.example/v1',
    'https://group-memory.example/v1?api_key=private-secret', 'https://group-memory.example/v1#private-secret']) {
    assert.throws(() => read({ groupMemoryExtraction: { ...backend, baseUrl } }), error => !error.message.includes('private-secret'))
    assert.throws(() => read({ groupMemoryExtraction: { ...backend, baseUrl } }, preview))
  }
  assert.equal(read({ groupMemoryExtraction: { ...backend, baseUrl: 'https://group-memory.example/custom/chat/completions' } }).groupMemoryExtraction.apiUrl,
    'https://group-memory.example/custom/chat/completions')
  assert.throws(() => read({ groupMemoryExtraction: { ...backend, apiKey: 'raw-group-extraction-key' } }),
    /groupMemoryExtraction 仅支持 baseUrl、name 和 apiKeyEnv/u)
})

test('standalone group memory --check validates the declared key and makes no model or member request', {
  skip: !redisAvailable, timeout: 20000,
}, async t => {
  const { read, backend, file, directory } = fixture(t)
  const { url: redisUrl } = await createAgentRedisFixture(t, 'group-memory-check')
  const requests = [], apiCalls = []
  const sockets = new WebSocketServer({ noServer: true })
  const server = createServer((request, outgoing) => { requests.push(request.url); outgoing.writeHead(500).end('{}') })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== 'Bearer group-onebot-token') { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => {
      peer.on('message', frame => {
        const call = JSON.parse(String(frame))
        apiCalls.push(call.action)
        peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: call.echo, data: { user_id: '123456001' } }))
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const port = server.address().port
  read({
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'main-model', apiKeyEnv: 'TEST_GROUP_MAIN_KEY' },
    groupMemoryExtraction: { ...backend, baseUrl: `http://127.0.0.1:${port}/group/v1` },
    groupMemory: { enabled: true, groupExtractMinIntervalMinutes: 0, groupExtractMaxBatchMessages: 1 },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_GROUP_ONEBOT_TOKEN' }],
  }, { credentials: { TEST_GROUP_MAIN_KEY: 'main-key', TEST_GROUP_MEMORY_KEY: 'group-key', TEST_GROUP_ONEBOT_TOKEN: 'group-onebot-token' } })
  const credentials = { ...process.env, BL_AGENT_REDIS_URL: redisUrl, TEST_GROUP_MAIN_KEY: 'main-key', TEST_GROUP_ONEBOT_TOKEN: 'group-onebot-token' }
  delete credentials.TEST_GROUP_MEMORY_KEY
  await assert.rejects(runNode(process.execPath, [entry, '--config', file, '--check'], { cwd: directory, env: credentials, timeout: 8000 }),
    error => error.code === 1 && /独立宿主启动或检查失败/u.test(error.stderr) && !/group-onebot-token|main-key|group-key/u.test(error.stderr))
  assert.deepEqual(apiCalls, [])
  const checked = await runNode(process.execPath, [entry, '--config', file, '--check'], {
    cwd: directory, env: { ...credentials, TEST_GROUP_MEMORY_KEY: 'group-key' }, timeout: 8000,
  })
  assert.equal(JSON.parse(checked.stdout.trim().split('\n').at(-1)).mode, 'check')
  assert.deepEqual(apiCalls, ['get_login_info'])
  assert.deepEqual(requests, [])
  for (const secret of ['main-key', 'group-key', 'group-onebot-token']) assert.ok(!`${checked.stdout}${checked.stderr}`.includes(secret))
})
