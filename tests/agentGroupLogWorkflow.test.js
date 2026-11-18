import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createAgentGroupLogWorkflow } from '../dist/backend/modules/dice/infrastructure/agentGroupLogWorkflow.js'
import { createAgentGroupLogStore } from '../dist/backend/modules/dice/infrastructure/agentGroupLogStore.js'
import { createAgentGroupLogRenderer } from '../dist/backend/modules/dice/infrastructure/agentGroupLog.js'
import { conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 12_000 }
const account = { platform: 'qq', namespace: 'global', id: '10001' }
const target = { account, kind: 'group', id: '20001' }
const binding = { target, agentId: 'daily', personaId: 'default', connectionId: 'main', source: 'configured', id: conversationAddressKey(target), revision: 'rev1' }
const owner = { target, agentId: 'daily' }
const now = Date.now()
const deferred = () => Promise.withResolvers()
const message = (id, text, extra = {}) => ({ version: 1, conversation: target, sender: { ...account, id: '30001' },
  senderName: '群友', messageId: id, occurredAt: now, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...extra })

async function harness(t, overrides = {}) {
  const fixture = await createAgentRedisFixture(t, 'group-log-workflow')
  const store = createAgentGroupLogStore(fixture.storage), sent = [], uploaded = [], notices = [], diagnostics = [], gates = [], authCalls = []
  let currentBinding = binding, running = true
  const ports = {
    store, render: createAgentGroupLogRenderer(), isRunning: () => running,
    resolveBinding: () => currentBinding, isBindingCurrent: candidate => candidate.revision === currentBinding.revision,
    async authorized(...args) { authCalls.push(args); return true },
    async sourceAllowed() { return true }, async canReply() { return true },
    allowsText: text => !text.includes('PRIVATE_SECRET'),
    diagnostics: { emit: row => diagnostics.push(row), traceId: () => 'safe-trace' },
    setAI: (_target, allowed) => gates.push(allowed),
    async failureNotice(input) { notices.push(input); return '团录没有完成，请核对后再发起新的命令。' },
    actions: {
      async send(action, options) { if (options?.isCurrent?.() === false) return { state: 'failed', code: 'stale' }; sent.push(action); return { state: 'sent', messageId: `receipt-${sent.length}` } },
      async sendGroupLog(action, options) { if (options?.isCurrent?.() === false) return { state: 'failed', code: 'stale' }; uploaded.push(action); return { state: 'uploaded', fileId: `file-${uploaded.length}` } },
    }, now: () => now,
    ...overrides,
  }
  const workflow = createAgentGroupLogWorkflow(ports)
  const handle = async input => workflow.handle(input, currentBinding, await store.capture({ target: currentBinding.target, agentId: currentBinding.agentId }, input.sender.id))
  return { ...fixture, store, ports, workflow, handle, sent, uploaded, notices, diagnostics, gates, authCalls,
    setBinding: value => { currentBinding = value }, stop: () => { running = false } }
}

test('recording owns ordinary sources before AI mode filters and uses fixed media placeholders without resource references', redisTest, async t => {
  const h = await harness(t)
  assert.equal((await h.workflow.restore(target, binding)).active, false)
  assert.equal(h.gates.at(-1), true)
  assert.deepEqual(await h.handle(message('start', '.log on 周末团')), { consumed: true, aiAllowed: false })
  const source = message('ordinary', '正文', { occurredAt: now - 5_000, parts: [
    { kind: 'text', text: '正文' }, { kind: 'image', resource: { kind: 'url', value: 'https://private.invalid/token' } },
    { kind: 'audio', resource: { kind: 'reference', value: '/private/audio' } },
    { kind: 'video', resource: { kind: 'url', value: 'https://private.invalid/video' } },
    { kind: 'file', name: '团本.pdf', resource: { kind: 'reference', value: 'secret-file-ref' } },
    { kind: 'forward', id: 'private-forward-ref' }, { kind: 'extension', platform: 'PRIVATE_SECRET', type: 'PRIVATE_SECRET' },
  ] })
  assert.deepEqual(await h.handle(source), { consumed: true, aiAllowed: false })
  await h.handle(message('image-only', '', { parts: [{ kind: 'image', resource: { kind: 'url', value: 'PRIVATE_SECRET' } }] }))
  const state = await h.store.read(owner), snapshot = await h.store.snapshot(owner, state.currentId)
  assert.equal(snapshot.sourceRows.length, 2)
  assert.equal(snapshot.sourceRows[0].messageId, 'ordinary')
  assert.equal(snapshot.sourceRows[0].occurredAt, now - 5_000)
  assert.equal(snapshot.sourceRows[0].content, '正文[图片][语音][视频][文件：团本.pdf][合并转发][平台扩展]')
  assert.equal(snapshot.sourceRows[1].content, '[图片]')
  assert.ok(!/private|secret-file|forward-ref|PRIVATE_SECRET/u.test(JSON.stringify(snapshot)))
  assert.deepEqual(await h.handle(message('ai-on', '.骰娘 跑团AI 开')), { consumed: true, aiAllowed: true })
  assert.deepEqual(await h.handle(message('ai-ordinary', '继续聊天')), { consumed: false, aiAllowed: true })
  assert.equal((await h.store.read(owner)).log.count, 3)
  assert.deepEqual(await h.handle(message('stop', '.log off')), { consumed: true, aiAllowed: true })
  await h.handle(message('not-recorded', '结束后不再录制'))
  assert.equal((await h.store.read(owner)).log.count, 3)
})

test('invalid, quoted, mentioned and unauthorized commands are consumed and their static replies are durably sent once', redisTest, async t => {
  const h = await harness(t)
  for (const input of [message('invalid', '.log unknown'), message('quoted', '.log on', { quote: { messageId: 'old', parts: [] } }),
    message('mentioned', '.log on', { mentions: [{ ...account, id: 'someone' }] }),
    message('mixed', '.log on', { parts: [{ kind: 'text', text: '.log on' }, { kind: 'image' }] })]) {
    assert.equal((await h.handle(input)).consumed, true)
    await h.handle(input)
  }
  assert.equal(h.sent.length, 4)
  assert.equal(h.authCalls.length, 0)
  assert.equal((await h.store.read(owner)).active, false)
  h.ports.authorized = async () => false
  await h.handle(message('denied', '.log on'))
  assert.match(h.sent.at(-1).parts[0].text, /主人|管理员/u)
  assert.equal((await h.store.read(owner)).active, false)
  h.ports.authorized = async () => true
  await h.handle(message('denied', '.log on'))
  assert.equal((await h.store.read(owner)).active, false)
  assert.equal(h.sent.length, 5)
  await h.handle(message('new-authorized', '.log on'))
  assert.equal((await h.store.read(owner)).active, true)
})

test('export persists a historical selection, sends complete owned HTML, and end always closes with TXT', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start-old', '.log on 旧团'))
  await h.handle(message('old-body', '旧团完整正文'))
  await h.handle(message('stop-old', '.log off'))
  await h.handle(message('start-new', '.log on 新团'))
  await h.handle(message('new-body', '新团正文'))
  const exportMessage = message('export-old', '.log export 1 html')
  await h.handle(exportMessage)
  assert.equal(h.uploaded.length, 1)
  const action = h.uploaded[0], html = Buffer.from(action.log.base64, 'base64').toString('utf8')
  assert.equal(action.log.mime, 'text/html')
  assert.ok(html.includes('旧团完整正文'))
  assert.ok(!html.includes('新团正文'))
  assert.deepEqual(action.target, target)
  assert.equal(action.source.messageId, 'export-old')
  assert.equal(action.source.occurredAt, now)
  assert.equal(action.source.textSha256, createHash('sha256').update(exportMessage.text).digest('hex'))
  await h.handle(exportMessage)
  assert.equal(h.uploaded.length, 1)
  assert.deepEqual(await h.handle(message('end-new', '.log end html')), { consumed: true, aiAllowed: true })
  assert.equal(h.uploaded.length, 2)
  assert.equal(h.uploaded[1].log.mime, 'text/plain')
  assert.ok(Buffer.from(h.uploaded[1].log.base64, 'base64').toString('utf8').includes('新团正文'))
  assert.equal((await h.store.read(owner)).active, false)
})

test('source denial refuses the entire export and emits one failure explanation without filtering the file', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source-one', '允许的正文'))
  await h.handle(message('source-two', '后来撤销的正文'))
  h.ports.sourceAllowed = async row => row.messageId !== 'source-two'
  await h.handle(message('export', '.log export'))
  assert.equal(h.uploaded.length, 0)
  assert.equal(h.notices.length, 1)
  assert.equal((await h.store.command(owner, 'export', { kind: 'export' }, now)).delivery, 'failed')
  await h.handle(message('export', '.log export'))
  assert.equal(h.notices.length, 1)
  assert.equal(h.uploaded.length, 0)
  assert.ok(h.diagnostics.some(row => row.code === 'operation_failed'))
})

test('privacy revision changes during source verification block the old artifact before transport', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source', '即将被物理删除的正文'))
  let erased = false
  h.ports.sourceAllowed = async () => {
    if (!erased) { erased = true; await h.store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }) }
    return true
  }
  await h.handle(message('export', '.log export'))
  assert.equal(h.uploaded.length, 0)
  assert.equal(h.notices.length, 1)
  assert.equal((await h.store.read(owner)).log.count, 0)
})

test('synchronous conversation invalidation stops an export waiting for source authority and prevents a late send', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source', '完整正文'))
  const reached = deferred(), release = deferred()
  h.ports.sourceAllowed = async () => { reached.resolve(); await release.promise; return true }
  const exporting = h.handle(message('export', '.log export'))
  await reached.promise
  h.workflow.invalidate(target)
  release.resolve()
  await exporting
  assert.equal(h.uploaded.length, 0)
  assert.equal(h.notices.length, 0)
  assert.equal((await h.store.command(owner, 'export', { kind: 'export' }, now)).delivery, 'failed')
})

test('fresh authority and binding checks reject a delayed administrative response after rebind', redisTest, async t => {
  const h = await harness(t), reached = deferred(), release = deferred()
  h.ports.authorized = async (_message, _binding, signal, current) => {
    reached.resolve(); await release.promise
    assert.equal(current(), false)
    return !signal.aborted
  }
  const pending = h.handle(message('start', '.log on'))
  await reached.promise
  h.setBinding({ ...binding, revision: 'rev2' })
  release.resolve()
  assert.equal((await pending).consumed, true)
  assert.equal((await h.store.read(owner)).active, false)
  assert.equal(h.sent.length, 0)
})

test('unknown and thrown upload results freeze delivery without a text fallback or replay', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source', '完整正文'))
  const ordinaryReplies = h.sent.length
  let calls = 0
  h.ports.actions.sendGroupLog = async () => { calls++; return { state: 'unknown' } }
  await h.handle(message('unknown', '.log export'))
  await h.handle(message('unknown', '.log export'))
  assert.equal(calls, 1)
  assert.equal(h.sent.length, ordinaryReplies)
  assert.equal(h.notices.length, 0)
  h.ports.actions.sendGroupLog = async () => { calls++; throw new Error('PRIVATE_SECRET upstream text') }
  await h.handle(message('threw', '.log export'))
  await h.handle(message('threw', '.log export'))
  assert.equal(calls, 2)
  assert.equal(h.sent.length, ordinaryReplies)
  assert.equal(h.notices.length, 0)
  assert.equal((await h.store.command(owner, 'threw', { kind: 'export' }, now)).delivery, 'unknown')
})

test('a definite upload failure or renderer failure explains once and never retries the original command', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source', '完整正文'))
  let attempts = 0
  h.ports.actions.sendGroupLog = async () => { attempts++; return { state: 'failed', code: 'rejected' } }
  await h.handle(message('rejected', '.log export'))
  await h.handle(message('rejected', '.log export'))
  assert.equal(attempts, 1)
  assert.equal(h.notices.length, 1)
  h.ports.render = () => { throw new Error('PRIVATE_SECRET renderer path') }
  await h.handle(message('render-failed', '.log export'))
  await h.handle(message('render-failed', '.log export'))
  assert.equal(attempts, 1)
  assert.equal(h.notices.length, 2)
  assert.equal((await h.store.command(owner, 'render-failed', { kind: 'export' }, now)).delivery, 'failed')
  assert.ok(h.sent.every(action => !JSON.stringify(action).includes('PRIVATE_SECRET')))
})

test('pre-effect storage failures remain thrown for inbox retry while the separate explanation receipt prevents duplicate notices', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  const original = h.ports.store.append
  let reject = true
  h.ports.store.append = async (...args) => { if (reject) throw new Error('PRIVATE_SECRET storage failure'); return original(...args) }
  const input = message('retained', '不能丢失的正文')
  await assert.rejects(h.handle(input), /storage failure/u)
  assert.equal(h.notices.length, 1)
  assert.equal((await h.store.read(owner)).log.count, 0)
  await assert.rejects(h.handle(input), /storage failure/u)
  assert.equal(h.notices.length, 1)
  reject = false
  await h.handle(input)
  assert.equal((await h.store.read(owner)).log.count, 1)
  assert.ok(h.sent.every(action => !JSON.stringify(action).includes('PRIVATE_SECRET')))
})

test('gate refresh uses current durable state instead of an old command effect snapshot', redisTest, async t => {
  const h = await harness(t), original = h.store.command
  h.ports.store.command = async (...args) => {
    const effect = await original(...args)
    if (args[1] === 'start') await original(owner, 'newer-stop', { kind: 'stop' }, now)
    return effect
  }
  const result = await h.handle(message('start', '.log on'))
  assert.deepEqual(result, { consumed: true, aiAllowed: true })
  assert.equal(h.gates.at(-1), true)
  assert.equal((await h.store.read(owner)).active, false)
})

test('text and filename guards suppress sensitive records while account invalidation reaches transport queue guards', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('secret-title', '.log on PRIVATE_SECRET'))
  assert.equal((await h.store.read(owner)).active, false)
  assert.ok(!(await h.store.read(owner)).logs.length)
  await h.handle(message('start', '.log on'))
  await h.handle(message('secret-text', 'PRIVATE_SECRET'))
  await h.handle(message('secret-filename', '', { parts: [{ kind: 'file', name: 'PRIVATE_SECRET.pdf' }] }))
  await h.handle(message('path-filename', '', { parts: [{ kind: 'file', name: '/private/local/path.pdf', resource: { kind: 'url', value: 'PRIVATE_SECRET' } }] }))
  const state = await h.store.read(owner), snapshot = await h.store.snapshot(owner, state.currentId)
  assert.equal(snapshot.sourceRows.length, 1)
  assert.equal(snapshot.sourceRows[0].content, '[文件]')
  const reached = deferred(), release = deferred()
  let transferred = 0
  h.ports.actions.sendGroupLog = async (_action, options) => {
    reached.resolve(); await release.promise
    if (options.isCurrent() === false) return { state: 'failed', code: 'stale' }
    transferred++; return { state: 'uploaded', fileId: 'file' }
  }
  const exporting = h.handle(message('export', '.log export'))
  await reached.promise
  h.workflow.invalidateAccount(account)
  release.resolve()
  await exporting
  assert.equal(transferred, 0)
  assert.equal(h.notices.length, 0)
})

test('old admission epochs and privacy changes at command dispatch cannot execute or permanently retry a command', redisTest, async t => {
  const h = await harness(t), epochs = await h.store.capture(owner, '30001')
  await h.store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' })
  assert.equal((await h.workflow.handle(message('old', '.log on'), binding, epochs)).consumed, true)
  assert.equal((await h.store.read(owner)).active, false)
  const currentEpochs = await h.store.capture(owner, '30001'), original = h.store.command
  let delayed = true
  h.ports.store.command = async (...args) => {
    if (args[1] === 'dispatch' && delayed) {
      delayed = false
      await h.store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' })
    }
    return original(...args)
  }
  await assert.rejects(h.workflow.handle(message('dispatch', '.log on'), binding, currentEpochs), /epoch/u)
  assert.equal((await h.store.read(owner)).active, false)
  assert.equal((await h.workflow.handle(message('dispatch', '.log on'), binding, currentEpochs)).consumed, true)
  assert.equal(h.sent.length, 0)
})

test('unavailable failure explanations use one guarded fallback with the safe diagnostic query reference', redisTest, async t => {
  const h = await harness(t)
  await h.handle(message('start', '.log on'))
  await h.handle(message('source', '完整正文'))
  h.ports.render = () => { throw new Error('PRIVATE_SECRET renderer failure') }
  h.ports.failureNotice = async () => { throw new Error('PRIVATE_SECRET unavailable model') }
  const before = h.sent.length
  await h.handle(message('export-fallback', '.log export'))
  await h.handle(message('export-fallback', '.log export'))
  assert.equal(h.sent.length, before + 1)
  assert.match(h.sent.at(-1).parts[0].text, /查询编号：safe-trace/u)
  assert.ok(!h.sent.at(-1).parts[0].text.includes('PRIVATE_SECRET'))
  assert.equal(h.uploaded.length, 0)
})
