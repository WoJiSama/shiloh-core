import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentBindingDirectory, createAgentRuntime }, { createAgentWebTools }, { WEB_EVIDENCE_KEY }, { personMemoryCommandText },
  { simulationAddressKey }, { simulationSessionKey }] = await Promise.all([
  load('core/index.js'), load('modules/tools/infrastructure/agentWebTools.js'), load('modules/memory/infrastructure/webEvidenceMemory.js'),
  load('modules/memory/domain/personMemoryCommands.js'), load('modules/simulation/infrastructure/simulationAddress.js'),
  load('modules/simulation/infrastructure/simSessionStore.js'),
])
const account = { platform: 'qq', namespace: 'global', id: '50001' }
const alice = { ...account, id: '60001' }, bob = { ...account, id: '60002' }
const group = { account, kind: 'group', id: '70001' }, other = { account, kind: 'group', id: '70002' }, friend = { account, kind: 'private', id: alice.id }
const url = 'https://replay.example.com/programs/ceramics'
const day = 86_400_000
const evidenceTitle = '【曾读到的公开网页】'
const call = (name, args) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const message = content => ({ choices: [{ message: { content } }] })
const answerFrom = text => ['蓝色入口', '红色入口', '绿色入口'].find(value => text.includes(value))

async function waitFor(predicate, label) {
  const until = performance.now() + 7000
  do {
    const result = await predicate()
    if (result) return result
    await delay(15)
  } while (performance.now() < until)
  assert.fail(`timed out waiting for ${label}`)
}

test('Core reuses a sanctioned webpage after restart across group speakers and rechecks time-sensitive questions',
  { skip: !redisAvailable, timeout: 35_000 }, async t => {
    const f = await createAgentRedisFixture(t, 'agent-web-evidence-replay')
    const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
      connections: [{ id: 'fixture', platform: account.platform, namespace: account.namespace, accountId: account.id }],
      bindings: [group, other, friend].map(target => ({ connectionId: 'fixture', kind: target.kind, conversationId: target.id, agentId: 'daily' })),
    }, 'replay-binding')
    let at = Date.now(), receive, host, scenario, enabled = true, content = '蓝色入口', requestCount = 0
    const requests = [], deliveries = [], originals = new Map()
    const webUsage = createAgentWebTools({ web: { enabled: true }, publicWeb: {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }], async request(address) {
        assert.equal(address.href, url)
        requestCount++
        return { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=1209600, immutable' },
          body: `<title>秋日陶艺报名指南</title><p>秋日陶艺报名表在${content}。</p><p>无关正文专用标记。</p>` }
      },
    } })
    const rawIndex = async () => Object.values(await f.reader.hGetAll(f.prefix + WEB_EVIDENCE_KEY)).join('\n')
    const groupHistory = async () => JSON.parse(await f.reader.get(f.prefix + simulationSessionKey(simulationAddressKey(group)))).agentHistory
    const start = async () => {
      let ready = false
      const adapter = { id: 'fixture', account, botUserId: account.id, botName: '希洛',
        async start(handler) { receive = handler; ready = true }, isReady: () => ready, stop() { ready = false },
        resolvePrivatePeer: () => alice, async readMessage(target, id) { return originals.get(`${target.id}:${id}`) },
        actions: { async send(action, guard) {
          await guard.ensureCurrent?.()
          if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
          deliveries.push({ target: action.target, text: action.parts.filter(part => part.kind === 'text').map(part => part.text).join('') })
          return { state: 'sent', messageId: `reply-${deliveries.length}` }
        } },
      }
      host = createAgentRuntime({ storage: f.storage, adapters: [adapter], logger: { info() {}, warn() {}, error() {} },
        now: () => at, isExecutionCurrent: f.isCurrent, unifiedGroupChat: true, privateChatEnabled: true, privateTextTools: ['webParserTool'],
        toolRegistry: webUsage, webEvidence: () => enabled, midtermMemory: { enabled: false }, episodicMemory: { enabled: false },
        resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '希洛' }, systemContent: '测试角色' } },
        getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
          meme: { enabled: false }, personProfile: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
          wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 100 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 100 } }),
        getExecutionConfig: () => ({ useTools: true, providers: 'openai' }),
        async YTapi(request, _config, _signal, _current, ensureCurrent) {
          await ensureCurrent?.()
          if (!scenario) return call('simFinishTurn', { choice: 'silent' })
          const evidence = request.messages.find(row => row.role === 'user' && String(row.content).startsWith(evidenceTitle))?.content ?? ''
          const toolResult = request.messages.findLast(row => row.role === 'tool' && row.name === 'webParserTool')?.content ?? ''
          const groupTurn = request.tools?.some(tool => tool.function.name === 'simFinishTurn')
          requests.push({ id: scenario.id, evidence, toolResult })
          if (scenario.fetch && !toolResult) return call('webParserTool', { url })
          const reply = answerFrom(String(toolResult || evidence)) ?? '本会话暂时无法确认报名入口。'
          if (!groupTurn) return message(reply)
          return scenario.silent ? call('simFinishTurn', { choice: 'silent' }) : call('simFinishTurn', { choice: 'chat', messages: [reply] })
        },
      })
      await host.start()
    }
    const ask = async (target, id, text, { sender = alice, fetch = false, silent = false } = {}) => {
      scenario = { id, fetch, silent }
      at++
      const before = deliveries.length
      const source = { version: 1, conversation: target, sender, senderName: '报名人', messageId: id, occurredAt: at, text,
        parts: [{ kind: 'text', text }], mentions: target.kind === 'group' ? [account] : [], directedToAccount: target.kind === 'group' }
      originals.set(`${target.id}:${id}`, source)
      await receive({ kind: 'message', message: source })
      const request = await waitFor(() => requests.find(row => row.id === id), `${id} first model request`)
      if (silent) await waitFor(() => requests.find(row => row.id === id && row.toolResult), `${id} tool completion`)
      else await waitFor(() => deliveries.length > before, `${id} confirmed send`)
      await host.runtime.drain()
      scenario = undefined
      return { request, delivery: deliveries[before] }
    }
    try {
      await start()
      await ask(group, 'group-first', '请读秋日陶艺的报名指南，报名表在哪？', { fetch: true, silent: true })
      assert.equal(deliveries.length, 0)
      assert.match(await rawIndex(), /蓝色入口/u)
      assert.doesNotMatch(await rawIndex(), /无关正文专用标记/u)
      assert.doesNotMatch(JSON.stringify(await groupHistory()), /蓝色入口|无关正文专用标记/u)
      assert.equal(requestCount, 1)
      await host.stop(); await start()
      at += 7 * day
      const repeated = await ask(group, 'second-speaker', '陶艺活动那个报名表从哪进？', { sender: bob })
      assert.match(repeated.request.evidence, /网页缓存有效/u)
      assert.ok(Buffer.byteLength(repeated.request.evidence) < 2048)
      assert.equal(repeated.delivery.text, '蓝色入口')
      assert.equal(requestCount, 1)
      assert.doesNotMatch(JSON.stringify(await groupHistory()), /蓝色入口|曾读到的公开网页/u)
      assert.equal((await ask(other, 'other-group', '陶艺活动那个报名表从哪进？')).request.evidence, '')
      assert.equal((await ask(friend, 'other-private', '陶艺活动那个报名表从哪进？')).request.evidence, '')
      content = '绿色入口'
      assert.equal((await ask(friend, 'private-first', '请读秋日陶艺报名表网页。', { fetch: true })).delivery.text, '绿色入口')
      assert.equal((await ask(friend, 'private-second', '陶艺活动那个报名表从哪进？')).delivery.text, '绿色入口')
      assert.equal(requestCount, 2)
      content = '红色入口'
      const refreshed = await ask(group, 'group-refresh', '秋日陶艺今天的报名入口改了吗？', { sender: bob, fetch: true })
      assert.match(refreshed.request.evidence, /replay\.example\.com/u)
      assert.doesNotMatch(refreshed.request.evidence, /蓝色入口|绿色入口/u)
      assert.equal(refreshed.delivery.text, '红色入口')
      assert.equal(requestCount, 3)
      assert.doesNotMatch(await rawIndex(), /蓝色入口/u)
      await receive({ kind: 'recall', target: group, messageId: 'group-refresh' })
      assert.doesNotMatch(await rawIndex(), /红色入口/u)
      const afterRecall = await ask(group, 'after-recall', '秋日陶艺报名入口在哪里？')
      assert.equal(afterRecall.request.evidence, '')
      content = '蓝色入口'
      await ask(group, 'group-forget', '陶艺报名表在什么位置？', { fetch: true })
      assert.match(await rawIndex(), /蓝色入口/u)
      const command = { version: 1, conversation: group, sender: alice, messageId: 'forget', occurredAt: ++at,
        text: personMemoryCommandText.forget, parts: [{ kind: 'text', text: personMemoryCommandText.forget }], mentions: [], directedToAccount: false }
      await receive({ kind: 'message', message: command })
      await waitFor(async () => !(await rawIndex())?.includes('蓝色入口'), 'author cleanup')
      await waitFor(() => deliveries.some(delivery => delivery.text.includes('已清空你在本群的记忆')), 'privacy cleanup confirmation')
      enabled = false
      const prior = requestCount
      await ask(group, 'disabled-explicit-read', '请重新读秋日陶艺报名表网页。', { fetch: true })
      assert.equal(requestCount, prior + 1)
      assert.doesNotMatch(await rawIndex(), /蓝色入口/u)
    } finally { await host?.stop() }
  })
