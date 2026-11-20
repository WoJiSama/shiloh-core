import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createAgentAlertWebhook, parseAgentAlertWebhookUrl }, { createAgentDiagnostics }, { createAgentFailureAlerts },
  { resolveStandaloneQqAlertOwner, formatQqOwnerAlerts }] = await Promise.all([
  load('modules/runtime/infrastructure/agentAlertWebhook.js'), load('modules/runtime/infrastructure/agentDiagnostics.js'),
  load('modules/runtime/infrastructure/agentFailureAlerts.js'), load('bootstrap/standaloneQqAlerts.js'),
])
const quiet = { info() {}, warn() {}, error() {} }
const toolFailure = { stage: 'tool', operation: 'lookupTool', outcome: 'failed', code: 'returned_failed' }
const modelFailure = { stage: 'model', operation: 'provider_http', outcome: 'failed', code: 'http_error', httpStatus: 503 }

async function receiver(t) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ method: request.method, key: request.headers['idempotency-key'], payload: JSON.parse(Buffer.concat(chunks)) })
    response.writeHead(204).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { requests, url: new URL(`http://127.0.0.1:${server.address().port}/diagnostics?secret=PRIVATE_ROUTE_TOKEN`) }
}

test('the live failure observer posts bounded metadata for tool failures, HTTP errors, unknown delivery and a failed journal', async t => {
  const { requests, url } = await receiver(t)
  const webhook = createAgentAlertWebhook({ url, logger: quiet, allowsLabel: label => !label.includes('PRIVATE') })
  const diagnostics = createAgentDiagnostics({ logger: quiet, onFailure: webhook.report, configurationRevision: 'PRIVATE_REVISION',
    sink: { async append(event) { return event.operation !== 'disk' } } })
  const scope = { kind: 'account', account: { platform: 'qq', namespace: 'global', id: 'PRIVATE_ACCOUNT' } }
  let traceId
  await diagnostics.run(scope, 'turn', async () => {
    traceId = diagnostics.traceId()
    diagnostics.emit({ ...toolFailure, operation: 'tool_PRIVATE_KEY', error: new Error('PRIVATE_TOOL_ARGUMENTS') })
    diagnostics.emit(modelFailure)
    await diagnostics.run(scope, 'message_send', async () => ({ state: 'unknown', messageId: 'PRIVATE_MESSAGE', code: 'receipt_missing' }), 'delivery')
    diagnostics.emit({ stage: 'runtime', operation: 'disk', outcome: 'succeeded' })
    diagnostics.emit({ stage: 'model', operation: 'revoked', outcome: 'cancelled' })
  })
  await diagnostics.flush()
  await webhook.close()

  assert.ok(requests.every(({ method, key, payload }) => method === 'POST' && key === payload.id && payload.version === 1))
  const alerts = requests.flatMap(({ payload }) => payload.alerts)
  assert.deepEqual(alerts.map(({ stage, operation, outcome, code }) => ({ stage, operation, outcome, code })), [
    { stage: 'tool', operation: 'redacted', outcome: 'failed', code: 'returned_failed' },
    { stage: 'model', operation: 'provider_http', outcome: 'failed', code: 'http_error' },
    { stage: 'delivery', operation: 'message_send', outcome: 'unknown', code: 'receipt_missing' },
    { stage: 'host', operation: 'operation_journal', outcome: 'failed', code: 'diagnostic_journal_failed' },
  ])
  assert.equal(alerts.find(alert => alert.stage === 'model').httpStatus, 503)
  assert.ok(alerts.every(alert => alert.traceId === traceId && alert.count === 1))
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|scope|messageId|configurationRevision/)
})

function clockFixture(t, statuses = []) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const requests = [], logs = []
  const webhook = createAgentAlertWebhook({ url: new URL('https://alert.test/webhook'),
    logger: { error: line => logs.push(line) }, async fetchImpl(_url, init) {
      requests.push({ payload: JSON.parse(init.body), key: init.headers['idempotency-key'] })
      assert.equal(init.redirect, 'error')
      return new Response(null, { status: statuses.shift() ?? 204 })
    } })
  t.after(() => webhook.close())
  const diagnostics = createAgentDiagnostics({ logger: quiet, onFailure: webhook.report })
  async function tick(ms) {
    t.mock.timers.tick(ms)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { requests, logs, tick, report: diagnostics.emit, close: webhook.close }
}

test('a new error pushes immediately and repeats flush after the cooldown even when no new error arrives', async t => {
  const f = clockFixture(t)
  f.report(toolFailure)
  await f.tick(1)
  assert.equal(f.requests.length, 1)
  await f.tick(6_000)
  f.report(toolFailure)
  await f.tick(4_000)
  f.report(toolFailure)
  f.report(modelFailure)
  await f.tick(1)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].payload.alerts[0].operation, 'provider_http')
  await f.tick(49_998)
  assert.equal(f.requests.length, 2)
  await f.tick(1)
  const [summary] = f.requests[2].payload.alerts
  assert.deepEqual([summary.operation, summary.count, summary.firstAt, summary.lastAt], ['lookupTool', 2, 7_001, 11_001])
})

test('webhook failures back off and retry the same batch while new events remain queued', async t => {
  const f = clockFixture(t, [503, 429, 204])
  f.report(toolFailure)
  await f.tick(1)
  f.report(modelFailure)
  await f.tick(4_999)
  assert.equal(f.requests.length, 1)
  await f.tick(1)
  assert.deepEqual(f.requests[0], f.requests[1])
  await f.tick(9_999)
  assert.equal(f.requests.length, 2)
  await f.tick(1)
  assert.deepEqual(f.requests[1], f.requests[2])
  assert.deepEqual(f.logs, [
    '[AgentAlerts] webhook_delivery_failed http=503 retry_in_ms=5000',
    '[AgentAlerts] webhook_delivery_failed http=429 retry_in_ms=10000',
  ])
  await f.tick(1)
  assert.equal(f.requests[3].payload.alerts[0].operation, 'provider_http')
})

test('distinct alert overflow remains visible and graceful shutdown drains bounded batches', async t => {
  const f = clockFixture(t)
  for (let i = 0; i < 300; i++) f.report({ ...toolFailure, operation: `tool_${i}` })
  await f.close()
  const alerts = f.requests.flatMap(request => request.payload.alerts)
  assert.equal(alerts.length, 257)
  assert.equal(alerts.find(alert => alert.code === 'alert_group_overflow').count, 44)
  assert.ok(f.requests.every(request => request.payload.alerts.length <= 32))
  assert.deepEqual(f.logs, ['[AgentAlerts] alert_group_overflow'])
})

test('invalid destinations reject with a safe message', () => {
  for (const url of ['https://user:PRIVATE@example.test', 'ftp://PRIVATE', 'http://PRIVATE.example.test', 'https://example.test/#PRIVATE']) {
    assert.throws(() => parseAgentAlertWebhookUrl(url), error => /BL_AGENT_ALERT_WEBHOOK_URL/.test(error.message) && !error.message.includes('PRIVATE'))
  }
})

test('QQ selects the unique configured owner on the selected bot connection', () => {
  const account = id => ({ platform: 'qq', namespace: 'global', id })
  const owner = account('330001'), connections = [{ id: 'qq-main', account: account('450001') }]
  assert.equal(resolveStandaloneQqAlertOwner('qq-main', connections, [owner]), owner)
  for (const masters of [[], [owner, account('330002')], [connections[0].account]]) {
    assert.throws(() => resolveStandaloneQqAlertOwner('qq-main', connections, masters), /唯一/)
  }
  assert.throws(() => resolveStandaloneQqAlertOwner('unbound', connections, [owner]), /有效 QQ 连接/)
})

test('QQ retries a definite failure, logs unknown delivery and does not replay it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const batches = [], logs = []
  const queue = createAgentFailureAlerts({ channel: 'qq', logger: { error: line => logs.push(line) },
    async deliver(batch) {
      batches.push(batch)
      return batches.length === 1 ? { state: 'failed', code: 'owner_alert_unavailable' } : { state: 'unknown' }
    } })
  t.after(() => queue.close())
  const diagnostics = createAgentDiagnostics({ logger: quiet, onFailure: queue.report })
  diagnostics.emit({ ...modelFailure, error: new Error('private model response') })
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(5_000)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(batches.length, 2)
  assert.deepEqual(batches[0], batches[1])
  assert.match(formatQqOwnerAlerts(batches[1]), /请求模型服务失败，共 1 次\n外部服务暂时不可用。\n错误码 http_error · HTTP 状态 503 · 操作标识 provider_http\n追踪编号 /)
  assert.doesNotMatch(formatQqOwnerAlerts(batches[1]), /private model response/)
  assert.match(logs[0], /qq_delivery_failed owner_alert_unavailable/)
  assert.match(logs[1], /qq_delivery_unknown batch=/)
})

test('QQ alerts explain known failures and handle unknown or redacted diagnostics in Chinese', () => {
  const common = { firstAt: 1000, lastAt: 1000, count: 1 }
  const text = formatQqOwnerAlerts({ version: 1, id: 'batch', alerts: [
    { ...common, stage: 'model', operation: 'simulation_wake_gate', outcome: 'failed', code: 'wake_gate_timeout', traceId: 'wake-trace', count: 2 },
    { ...common, stage: 'model', operation: 'conversation_summary', outcome: 'failed', code: 'http_error', httpStatus: 429 },
    { ...common, stage: 'delivery', operation: 'send_send', outcome: 'unknown' },
    { ...common, stage: 'runtime', operation: 'host_log', outcome: 'failed', code: 'runtime_warning' },
    { ...common, stage: 'tool', operation: 'toString', outcome: 'failed', code: 'constructor', errorKind: 'TimeoutError' },
    { ...common, stage: 'runtime', operation: 'redacted', outcome: 'failed', code: 'redacted' },
  ] })
  assert.match(text, /^【助手运行告警】\n\n唤醒预判失败，共 2 次\n唤醒预判未在规定时间内完成。\n错误码 wake_gate_timeout · 操作标识 simulation_wake_gate\n追踪编号 wake-trace/u)
  assert.match(text, /会话摘要失败，共 1 次\n服务限制了请求频率或额度。\n错误码 http_error · HTTP 状态 429/u)
  assert.match(text, /发送消息结果待确认，共 1 次\n暂时无法确认操作是否完成。/u)
  assert.match(text, /后台运行出现警告，共 1 次\n后台报告了警告，详情见运行日志。/u)
  assert.match(text, /工具执行失败，共 1 次\n等待操作完成超时。\n错误码 constructor · 操作标识 toString/u)
  assert.doesNotMatch(text, /TimeoutError|redacted/u)
})

test('a full QQ batch keeps explanations and trace identifiers within the transport limit', async () => {
  const { QQ_OWNER_ALERT_MAX_LENGTH } = await load('contracts/agentDiagnostics.js')
  const alerts = Array.from({ length: 8 }, (_, i) => ({
    stage: 'runtime', operation: 'a'.repeat(128), outcome: 'failed', code: 'b'.repeat(128),
    traceId: String(i) + 'c'.repeat(127), count: Number.MAX_SAFE_INTEGER, httpStatus: 503, firstAt: 0, lastAt: 1,
  }))
  const text = formatQqOwnerAlerts({ version: 1, id: 'batch', alerts })
  assert.ok(text.length <= QQ_OWNER_ALERT_MAX_LENGTH)
  for (const alert of alerts) {
    assert.ok(text.includes(`追踪编号 ${alert.traceId}`))
    assert.ok(text.includes(`错误码 ${alert.code}`))
  }
  assert.equal(text.match(/外部服务暂时不可用。/gu).length, alerts.length)
  assert.ok(!text.includes(alerts[0].operation))
})

test('standalone startup sends a configuration error before Redis opens, and check mode only validates the destination', async t => {
  const { requests, url } = await receiver(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-alert-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.BL_AGENT_ALERT_WEBHOOK_URL
  process.env.BL_AGENT_ALERT_WEBHOOK_URL = url.href
  t.after(() => { if (previous === undefined) delete process.env.BL_AGENT_ALERT_WEBHOOK_URL; else process.env.BL_AGENT_ALERT_WEBHOOK_URL = previous })
  const { main } = await load('bootstrap/standaloneAgent.js')
  const args = ['--config', path.join(directory, 'PRIVATE_MISSING_CONFIGURATION.yaml')]
  await assert.rejects(main(args))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].payload.alerts[0].code, 'configuration_unavailable')
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE/)
  await assert.rejects(main([...args, '--check']))
  assert.equal(requests.length, 1)
})
