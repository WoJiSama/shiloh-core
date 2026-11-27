import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createCommitmentStore, encodeCommitment, commitmentDetailKey, COMMITMENT_PENDING_KEY } from '../dist/backend/modules/commitments/infrastructure/commitmentStore.js'
import { agentBindingIdentity } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { agentRedisPrefix } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const logger = { info() {}, warn() {}, error() {} }
const accounts = ['19000001', '19000002'].map(id => ({ platform: 'qq', namespace: 'global', id }))
const targets = accounts.map(account => ({ account, kind: 'group', id: '310001' }))
const connections = accounts.map((account, index) => ({ id: `qq-${index}`, platform: account.platform,
  namespace: account.namespace, accountId: account.id }))
const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections,
  bindings: connections.map(connection => ({ connectionId: connection.id, kind: 'group', conversationId: targets[0].id, agentId: 'daily' })) }

async function waitFor(condition, description, timeout = 5_000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (await condition()) return
    await delay(15)
  }
  assert.fail(description)
}

for (const blockRenewal of [false, true]) {
  test(`standalone QQ schedules the other account while one ${blockRenewal ? 'renewal' : 'delivery'} is pending`, {
    skip: !redisAvailable, timeout: 20_000,
  }, async t => {
    const { storage, isCurrent } = await createAgentRedisFixture(t)
    const directory = createAgentBindingDirectory(bindings, 'fixture')
    const store = createCommitmentStore({ redis: storage, logger })
    const release = Promise.withResolvers()
    const deliveries = [[], []]
    const attempts = [[], []]
    const at = Date.now()
    let now = at
    let entered = false
    const adapters = accounts.map((account, index) => ({
      id: connections[index].id, account, botUserId: account.id, botName: '测试 QQ',
      isReady: () => true, start: async () => {}, stop() {},
      actions: { async send(action, guard) {
        assert.deepEqual(action.target, targets[index])
        const text = action.parts.find(part => part.kind === 'text').text.trim()
        attempts[index].push(text)
        if (index === 0 && !entered) {
          entered = true
          await release.promise
        }
        if (!guard?.isCurrent?.()) return { state: 'failed', code: 'binding_changed' }
        deliveries[index].push(text)
        return { state: 'sent', messageId: `received-${index}-${deliveries[index].length}` }
      } },
    }))
    const host = createAgentRuntime({ storage, adapters, logger, now: () => now, isExecutionCurrent: isCurrent,
      getSection: () => ({ wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false } }),
      getExecutionConfig: () => ({}), YTapi: async () => assert.fail('fixed reminders use no model'),
      resolvePersona(target) {
        const binding = directory.resolve(target)
        return binding && { binding, persona: { name: '测试角色' }, systemContent: '' }
      },
    })
    async function schedule(accountIndex, id, text, next, expiry = 0) {
      const target = targets[accountIndex]
      const scope = directory.resolve(target)
      await store.createCommitment({ id, group_id: target.id, creator_id: '331221', creator_name: '测试成员', intent: text,
        schedule: { kind: 'once', time: next }, deliver: 'static', static_message: text, expiry_at: expiry,
        next_run_at: next, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: at - 1000,
        bot_id: target.account.id, scope, bindingIdentity: agentBindingIdentity(scope),
      })
    }
    try {
      if (blockRenewal) await schedule(0, 'slow-renewal', '甲的续约事项', at + 86_400_000, at + 2 * 86_400_000)
      await schedule(0, 'first-on-a', '甲的第一条', at - 100)
      await schedule(0, 'second-on-a', '甲的第二条', at - 50)
      await schedule(1, 'first-on-b', '乙的第一条', at - 10)
      await schedule(1, 'next-tick-on-b', '乙的下一条', at + 10_000)
      await store.createCommitment({ ...await store.getCommitment('first-on-b'), id: 'without-binding',
        scope: undefined, bindingIdentity: undefined, intent: '归属不明的旧记录' })
      await host.start()
      await waitFor(() => entered, 'first account entered a pending transport')
      await waitFor(async () => (await store.getCommitment('first-on-b')).status === 'completed', 'first B reminder blocked by A')
      assert.deepEqual(deliveries, [[], ['乙的第一条']])

      now = at + 10_001
      await host.resumePendingWork()
      await waitFor(async () => (await store.getCommitment('next-tick-on-b')).status === 'completed', 'next B reminder blocked by A')
      assert.deepEqual(deliveries, [[], ['乙的第一条', '乙的下一条']])
      assert.equal(attempts[0].length, 1)
      assert.equal((await store.getCommitment('second-on-a')).status, 'active')
      const old = await store.getCommitment('without-binding')
      assert.equal(old.status, 'active')
      assert.equal(old.run_id, undefined)
      release.resolve()
      await waitFor(async () => (await store.getCommitment('second-on-a')).status === 'completed', 'same account resumed in order')
      assert.deepEqual(deliveries[0].slice(-2), ['甲的第一条', '甲的第二条'])
      if (blockRenewal) {
        assert.match(deliveries[0][0], /甲的续约事项/u)
        assert.equal((await store.getCommitment('slow-renewal')).renewal_asked_at, at)
      }
      assert.deepEqual(attempts, deliveries)
    } finally {
      release.resolve()
      await host.stop()
    }
  })
}

test('two verified OneBot accounts in the same host settle reminders in the same group independently', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const instance = 'commitment-onebot-accounts'
  const { reader, url } = await createAgentRedisFixture(t)
  const childPrefix = agentRedisPrefix(instance)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-commitment-accounts-'))
  const server = createServer((_request, response) => { modelCalls++; response.writeHead(500).end() })
  const sockets = new WebSocketServer({ server })
  let modelCalls = 0
  let child
  let exited
  const replyPending = Promise.withResolvers()
  const sends = [[], []]
  t.after(async () => {
    replyPending.resolve()
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    try { if (exited) await exited } finally {
      for (const client of sockets.clients) client.terminate()
      await new Promise(resolve => sockets.close(resolve))
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  })
  sockets.on('connection', (socket, upgrade) => {
    const index = connections.findIndex(connection => upgrade.url === `/${connection.id}`)
    if (index < 0) { socket.close(); return }
    socket.on('message', async frame => {
      const request = JSON.parse(frame)
      let data
      if (request.action === 'get_login_info') {
        data = { user_id: accounts[index].id, nickname: `QQ ${index}` }
      } else {
        sends[index].push(request)
        if (index === 0) await replyPending.promise
        data = { message_id: 314100 + index }
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `127.0.0.1:${server.address().port}`
  const file = path.join(directory, 'agent-host.yaml')
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings))
  await writeFile(file, JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://${base}/v1`, name: 'fixture', apiKeyEnv: 'FIXTURE_QQ_ACCOUNTS_MODEL' },
    connections: connections.map(({ id }) => ({ id, url: `ws://${base}/${id}` })),
  }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: url, FIXTURE_QQ_ACCOUNTS_MODEL: 'fixture-key' }
  const config = readStandaloneAgentConfig(file, env)
  const at = Date.now() - 1_000
  const pending = []
  for (const [index, target] of targets.entries()) {
    const { binding } = config.resolvePersona(target)
    const id = `queued-onebot-${index}`
    const text = `第${index + 1}个账号的提醒`
    const next = at + index
    await reader.set(childPrefix + commitmentDetailKey(id), encodeCommitment({ id,
      group_id: target.id, creator_id: '331221', creator_name: '测试成员', intent: text, deliver: 'static', static_message: text,
      schedule: { kind: 'once', time: next }, status: 'active', expiry_at: 0, next_run_at: next, last_run_at: 0,
      last_result: '', retry_count: 0, created_at: at - 1_000, bot_id: target.account.id,
      scope: { agentId: binding.agentId, target }, bindingIdentity: agentBindingIdentity(binding), revision: 1,
    }))
    pending.push({ id, next_run_at: next })
  }
  await reader.set(childPrefix + COMMITMENT_PENDING_KEY, JSON.stringify(pending))
  const root = process.env.BL_CHAT_AGENT_RELEASE_DIR || fileURLToPath(new URL('../', import.meta.url))
  child = spawn(process.execPath, [path.join(root, 'scripts/start-agent.mjs'), '--config', file], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  const detail = async index => JSON.parse(await reader.get(childPrefix + commitmentDetailKey(`queued-onebot-${index}`)))
  try {
    await waitFor(() => child.exitCode !== null || sends[0].length >= 1, 'first OneBot account awaits its send receipt', 10_000)
    assert.equal(sends[0].length, 1, log)
  } catch (error) {
    t.diagnostic(log)
    throw error
  }
  await waitFor(async () => (await detail(1)).status === 'completed', 'the second OneBot account was blocked by another account')
  assert.equal((await detail(0)).execution_state, 'executing')
  replyPending.resolve()
  await waitFor(async () => (await detail(0)).status === 'completed', 'first receipt was not settled')
  assert.deepEqual(sends.map(rows => rows.map(({ action, params }) => ({ action, group: params.group_id, text: params.message.at(-1).data.text.trim() }))),
    targets.map((target, i) => [{ action: 'send_group_msg', group: Number(target.id), text: `第${i + 1}个账号的提醒` }]))
  assert.equal(modelCalls, 0)
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null], log)
})
