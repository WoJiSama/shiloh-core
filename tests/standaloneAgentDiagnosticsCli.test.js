import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import { parseAgentDiagnosticEvent } from '../dist/backend/modules/runtime/infrastructure/agentOperationJournal.js'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const BOT = 19000241, USER = 330241, MESSAGE = 974101
const MODEL_KEY = 'diagnostics-cli-model-private-key', QQ_TOKEN = 'diagnostics-cli-onebot-private-token'
const CHAT = 'DIAGNOSTICS_PRIVATE_CHAT_BODY_20261116', RAW_BODY = 'DIAGNOSTICS_PRIVATE_UPSTREAM_BODY_20261116'
const NOTICE = '这一轮没有成功，我暂时无法完成刚才的请求。', ANSWER = '收到这次合成验收消息。'
const FALLBACK = '这次服务暂时异常，暂时无法确认结果。请先核实操作状态。'
const isExplanation = body => body.messages.some(row => row.role === 'system' && String(row.content).includes('你只负责为当前真人请求写一条'))

async function waitFor(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}

async function fixture(t, mode) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'diagnostics CLI verification requires real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-diagnostics-cli-')), socketPath = path.join(directory, 'redis.sock')
  const dataDir = path.join(directory, 'data'), instance = 'diagnostics-cli', prefix = `bl-agent:${instance}:`
  const queueKey = `${prefix}agent:inbox:private-conversation:${JSON.stringify(['qq', 'global', String(BOT), 'private', String(USER)])}`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit'), sockets = new WebSocketServer({ noServer: true })
  const models = [], deliveries = [], actions = [], errors = [], children = []
  let child, exited, reader, websocket, log = '', phase = 'check', connections = 0
  const server = createServer(async (req, res) => {
    try {
      assert.equal(phase, 'run'); assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${MODEL_KEY}`)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.model, 'diagnostics-model'); models.push(body)
      res.setHeader('content-type', 'application/json')
      if (mode === 'persistent-failure' || mode === 'recover' && !isExplanation(body)) {
        res.writeHead(503).end(JSON.stringify({ error: { message: `${RAW_BODY} ${MODEL_KEY} ${QQ_TOKEN} ${CHAT}` } }))
      } else {
        res.end(JSON.stringify({ model: 'diagnostics-model', choices: [{ message: { role: 'assistant', content: mode === 'recover' ? NOTICE : ANSWER }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
      }
    } catch (error) { errors.push(String(error)); if (!res.destroyed) res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer; connections++
    peer.on('message', raw => {
      let echo
      try {
        const request = JSON.parse(String(raw)); echo = request.echo; const { action, params } = request
        actions.push({ action, params }); let data
        if (action === 'get_login_info') data = { user_id: BOT, nickname: '独立诊断验收机器人' }
        else if (action === 'send_private_msg') {
          assert.equal(Number(params.user_id), USER); assert.ok(params.message.every(part => part.type === 'text'))
          const content = params.message.map(part => part.data.text).join('')
          if (mode === 'persistent-failure') assert.match(content, new RegExp(`^${FALLBACK} 查询编号：[a-f0-9-]{36}$`, 'u'))
          else assert.equal(content, mode === 'recover' ? NOTICE : ANSWER)
          deliveries.push(request); data = mode === 'unknown-delivery' ? {} : { message_id: 975000 + deliveries.length }
        } else assert.fail(`unexpected OneBot action ${action}`)
        if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, models: models.length, deliveries: deliveries.length, actions: actions.map(row => row.action) })) }
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL')
      await item.exited
    }
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance, dataDir,
    persona: { name: '独立诊断验收角色', identity: '本地合成测试' },
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, name: 'diagnostics-model', apiKeyEnv: 'DIAGNOSTICS_MODEL_KEY' },
    privateChat: { enabled: true }, memorySystem: { enabled: false }, midtermMemory: { enabled: false },
    episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'DIAGNOSTICS_QQ_TOKEN' }] }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'private', conversationId: String(USER), agentId: 'daily' }] }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, DIAGNOSTICS_MODEL_KEY: MODEL_KEY, DIAGNOSTICS_QQ_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); children.push({ child, exited })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  }
  const start = async () => {
    const before = connections, startAt = log.length
    phase = 'run'; launch(false)
    await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return connections > before && log.slice(startAt).includes('已启动') }, 'CLI readiness')
  }
  const stop = async () => { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) }
  const incoming = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: BOT, user_id: USER,
    message_id: MESSAGE, time: Math.floor(Date.now() / 1000), sender: { user_id: USER, nickname: '合成诊断验收员' },
    message: [{ type: 'text', data: { text: CHAT } }], raw_message: CHAT }
  const send = () => websocket.send(JSON.stringify(incoming))
  const drained = () => waitFor(async () => models.length > 0 && await reader.lLen(queueKey) === 0, 'private inbox drains')
  const journal = async () => {
    const operations = path.join(dataDir, 'operations'), rows = [], texts = []
    assert.equal((await stat(operations)).mode & 0o777, 0o700)
    const names = await readdir(operations); assert.ok(names.length > 0)
    for (const name of names.sort()) {
      assert.match(name, /^\d{4}-\d{2}-\d{2}\.\d{6}\.ndjson$/u)
      const file = path.join(operations, name); assert.equal((await stat(file)).mode & 0o777, 0o600)
      const content = await readFile(file, 'utf8'); assert.ok(content.endsWith('\n'), 'shutdown leaves only complete journal lines')
      texts.push(content); for (const line of content.trimEnd().split('\n')) rows.push(JSON.parse(line))
    }
    for (const row of rows) {
      const approved = JSON.parse(JSON.stringify(parseAgentDiagnosticEvent(row)))
      assert.deepEqual(row, approved, 'journal contains only approved metadata fields')
      assert.match(row.traceId, /^[a-f0-9-]{36}$/u)
      assert.match(row.configurationRevision, /^[a-f0-9]{64}$/u, 'each event identifies the configuration loaded by its process')
      if (row.delivery) {
        assert.ok(Object.keys(row.delivery).every(key => ['state', 'messageId', 'code'].includes(key)), 'native receipts contain only approved metadata')
        assert.ok(['sent', 'unknown'].includes(row.delivery.state))
        if (row.delivery.state === 'sent') assert.equal(row.delivery.messageId, '975001')
        else assert.equal(row.delivery.messageId, undefined, 'an unknown native result cannot acquire a message ID')
      }
    }
    assert.equal(new Set(rows.map(row => row.configurationRevision)).size, 1, 'a restart without source changes preserves the loaded configuration revision')
    for (const value of [MODEL_KEY, QQ_TOKEN, CHAT, RAW_BODY, NOTICE, ANSWER, FALLBACK]) {
      assert.equal((log + texts.join('')).includes(value), false, 'logs exclude credentials, provider body and chat text')
    }
    assert.equal(log.includes('diagnostic_journal_failed'), false); assert.equal(log.includes('JOURNAL_'), false)
    assert.ok(rows.some(row => row.stage === 'host' && row.operation === 'host_stop' && row.outcome === 'succeeded'), 'shutdown flushes its terminal event')
    assert.deepEqual(errors, []); return rows
  }
  return { models, deliveries, send, drained, stop, start, journal,
    async checkAndStart() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(models.length, 0); assert.equal(deliveries.length, 0); assert.ok(actions.every(row => row.action === 'get_login_info'))
      assert.deepEqual(await reader.keys(`${prefix}*`), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' })
      await start()
    },
    async replayAcrossRestart() {
      const before = { models: models.length, deliveries: deliveries.length }
      send(); await delay(1200); await drained()
      assert.deepEqual({ models: models.length, deliveries: deliveries.length }, before, 'duplicate ingress does not rerun the model or send again')
      await stop(); await start(); send(); await delay(1200); await drained()
      assert.deepEqual({ models: models.length, deliveries: deliveries.length }, before, 'restart preserves the no-replay receipt')
    },
  }
}

function turnRows(rows) {
  const turns = rows.filter(row => row.stage === 'inbox' && row.operation === 'text_turn' && row.outcome === 'started')
  assert.equal(turns.length, 1, 'one admitted text turn owns the full operation trace')
  assert.equal(turns[0].scope.kind, 'conversation'); assert.equal(turns[0].scope.messageId, String(MESSAGE))
  assert.equal(turns[0].scope.binding.target.id, String(USER)); return rows.filter(row => row.traceId === turns[0].traceId)
}

test('actual standalone CLI logs redacted HTTP failure, tries one tool-free explanation and sends it once across restart', { timeout: 45000 }, async t => {
  const run = await fixture(t, 'recover'); await run.checkAndStart(); run.send()
  await waitFor(() => run.deliveries.length === 1, 'failure explanation is delivered'); await run.drained()
  assert.equal(run.models.length, 3, 'existing tools-to-chat compatibility fallback is preserved before the explanation')
  const explanations = run.models.filter(isExplanation)
  assert.equal(explanations.length, 1, 'only one failure-explanation model request is allowed')
  assert.equal(run.models.filter(body => body.tools?.length).length, 1, 'the original tools planner is never replayed')
  const explanation = explanations[0]
  assert.ok(!explanation.tools?.length, 'failure explanation has no tools')
  assert.ok(explanation.messages.some(row => row.role === 'system' && String(row.content).includes('你只负责')))
  assert.equal(JSON.stringify(explanation).includes(RAW_BODY), false, 'provider exception body never becomes an explanation prompt')
  assert.equal(JSON.stringify(explanation).includes(CHAT), false, 'explanation uses a safe conclusion without original chat text')
  await run.replayAcrossRestart(); await run.stop()
  const rows = turnRows(await run.journal())
  assert.ok(rows.some(row => row.stage === 'model' && row.operation === 'provider_http' && row.outcome === 'failed' && row.httpStatus === 503 && row.code === 'http_error'))
  assert.ok(rows.some(row => row.stage === 'model' && row.operation === 'failure_notice' && row.outcome === 'succeeded'))
  assert.equal(rows.filter(row => row.operation === 'text_delivery' && row.outcome === 'succeeded').length, 1)
})

test('actual standalone CLI sends one brief default fallback with a query reference after sustained model failure without inbox replay', { timeout: 45000 }, async t => {
  const run = await fixture(t, 'persistent-failure'); await run.checkAndStart(); run.send()
  await waitFor(() => run.deliveries.length === 1, 'default fallback is delivered'); await run.drained()
  assert.equal(run.models.length, 3); assert.equal(run.deliveries.length, 1)
  assert.equal(run.models.filter(isExplanation).length, 1, 'only one tool-free explanation attempt precedes the fallback')
  assert.equal(run.models.filter(body => body.tools?.length).length, 1, 'compatibility fallback does not replay the tools planner')
  assert.ok(!run.models.find(isExplanation).tools?.length)
  await run.replayAcrossRestart(); await run.stop()
  const rows = turnRows(await run.journal())
  assert.equal(rows.filter(row => row.operation === 'provider_http' && row.httpStatus === 503 && row.outcome === 'failed').length, 3)
  assert.ok(rows.some(row => row.operation === 'failure_notice' && row.code === 'explanation_model_failed' && row.outcome === 'failed'))
  assert.ok(rows.some(row => row.operation === 'failure_notice' && row.code === 'fallback_ready' && row.outcome === 'succeeded'))
  const deliveredText = run.deliveries[0].params.message.map(part => part.data.text).join('')
  assert.ok(deliveredText.endsWith(`查询编号：${rows[0].traceId}`), 'user-facing query reference locates the original operation trace')
  assert.equal(rows.filter(row => row.operation === 'text_delivery' && row.outcome === 'succeeded').length, 1)
})

test('actual standalone CLI logs unknown QQ delivery and never explains, resends or reruns after duplicate ingress and restart', { timeout: 45000 }, async t => {
  const run = await fixture(t, 'unknown-delivery'); await run.checkAndStart(); run.send()
  await waitFor(() => run.deliveries.length === 1, 'single unconfirmed QQ send'); await run.drained()
  assert.equal(run.models.length, 1)
  await run.replayAcrossRestart(); await run.stop()
  const rows = turnRows(await run.journal())
  assert.ok(rows.some(row => row.operation === 'provider_http' && row.outcome === 'succeeded' && row.httpStatus === 200))
  assert.equal(rows.some(row => row.operation === 'provider_request' && row.outcome === 'failed'), false, 'a successful model response is not a provider error')
  assert.equal(rows.some(row => row.operation === 'model_request' && row.outcome === 'failed'), false)
  assert.ok(rows.some(row => row.operation === 'text_delivery' && row.outcome === 'unknown'))
  assert.equal(rows.some(row => row.operation === 'failure_notice'), false)
  assert.equal(rows.filter(row => row.operation === 'text_delivery' && row.outcome === 'started').length, 1)
})
