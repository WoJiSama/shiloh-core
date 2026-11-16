import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const producerName = 'generatedFileFixtureTool', readerName = 'temporaryFileFixtureTool', externalName = 'externalActionFixtureTool'
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
const file = { name: 'result.txt', mime: 'text/plain', base64: Buffer.from('本次生成的有效文字文件。').toString('base64') }
const anotherFile = { ...file, name: 'another-result.txt' }
const temporary = '本轮临时文件资料不得再生成上传文件'
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `${name}-call`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '本轮验证已完成' })
let fixtureId = 0

async function waitFor(check, message, timeout = 7000) {
  const end = performance.now() + timeout
  while (performance.now() < end) { if (await check()) return; await delay(15) }
  assert.fail(typeof message === 'function' ? message() : message)
}

async function attempt(operation) {
  try { return { status: 'fulfilled', value: await operation() } }
  catch (error) { return { status: 'rejected', reason: String(error) } }
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'file-send-runtime'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `file-send-${++fixtureId}`, id: 'robot' }
  const target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'human' }
  const now = Date.now()
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'file-send-initial'), accept, terminal = false
  const binding = directory.resolve(target), key = simulationAddressKey(target)
  const initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.personaId = agentPersonaScopeId(binding.agentId); initial.bindingToken = agentBindingToken(binding)
  initial.nextProactiveCheckAt = now + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const requests = [], contexts = [], uploadAttempts = [], uploads = [], messages = [], observed = [], diagnostics = [], outputs = []
  let producerCalls = 0, externalCalls = 0, reads = 0
  const original = { version: 1, conversation: target, sender, messageId: 'file-send-trigger', occurredAt: now,
    text: options.temporary ? '请只在本轮查看当前附件。' : '请完成本轮生成文件并发送给我。',
    parts: options.temporary ? [{ kind: 'file', name: 'source.txt', resource: { kind: 'url', value: 'https://provider.example/private-file-reference' } }] : [],
    mentions: [account], directedToAccount: true }
  let f
  const producer = { name: producerName, description: 'Generate owned file bytes in the current conversation', parameters,
    async execute(input, context) {
      producerCalls++; contexts.push(context)
      return options.execute ? options.execute(input, context, f) : { status: 'succeeded', content: '生成器已执行' }
    } }
  const ephemeral = { name: readerName, description: 'Read temporary source evidence only', dataPolicy: 'ephemeral', parameters,
    async execute(_input, context) {
      contexts.push(context)
      outputs.push({ absentBeforeRead: !Object.hasOwn(context, 'sendFile') && context.sendFile === undefined })
      const result = await context.readFile({})
      outputs.push({ result, absentAfterRead: !Object.hasOwn(context, 'sendFile') && context.sendFile === undefined })
      return { status: 'succeeded', content: temporary }
    } }
  const external = { name: externalName, description: 'External side effect fixture', parameters,
    async execute() { externalCalls++; return { status: 'succeeded', content: '外部动作已发生' } } }
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
    personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
    turn: { maxToolRounds: 12, maxSendsPerTurn: options.maxSends ?? 1, minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, messageId, guard) { return messageId === original.messageId && guard?.isCurrent?.() !== false ? structuredClone(original) : undefined },
      async readMessageFile(selected, messageId, index, guard) {
        await guard.ensureCurrent?.()
        if (messageId !== original.messageId || index !== 1 || !await guard.allowsSource(structuredClone(original))) return undefined
        assert.deepEqual(selected, target); reads++
        return { name: 'source.txt', mime: 'text/plain', base64: Buffer.from(temporary).toString('base64') }
      },
      async listConversationFiles() { return { target, observedAt: now, files: [], truncated: false } },
      actions: {
        async send(action, guard) {
          if (!guard.isCurrent()) return { state: 'failed', code: 'stale_fixture_send' }
          messages.push(structuredClone(action)); return { state: 'sent', messageId: `out-${messages.length}` }
        },
        async sendFile(action, guard) {
          uploadAttempts.push({ action: structuredClone(action), guard })
          if (options.upload) return options.upload(action, guard, f)
          if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'stale_fixture_file' }
          uploads.push(structuredClone(action)); return { state: 'uploaded', fileId: `uploaded-file-${uploads.length}` }
        },
      },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(selected) { const selectedBinding = directory.resolve(selected); return selectedBinding && { binding: selectedBinding, persona: { name: 'fixture' }, systemContent: '' } },
    toolRegistry: { builtIn: [producer, ephemeral, external] }, recordToolResult: result => observed.push(result),
    ...(options.allowsText ? { allowsText: options.allowsText } : {}),
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      await ensureCurrent?.(); requests.push(structuredClone(request))
      if (options.model) {
        const next = await options.model(requests.length, request, f)
        if (next) return next
      } else if (requests.length === 1) return call(producerName)
      terminal = true
      return finish()
    },
  })
  t.after(async () => { options.release?.(); await host.stop() })
  const session = async () => JSON.parse(await storage.get(simulationSessionKey(key)) || 'null')
  const settled = async () => {
    const state = await session()
    return state && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(key)) &&
      !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`)
  }
  f = { ...redis, host, target, sender, account, binding, key, now, original, requests, contexts, uploadAttempts, uploads, messages, observed, diagnostics, outputs, session, settled,
    get producerCalls() { return producerCalls }, get externalCalls() { return externalCalls }, get reads() { return reads },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'file-send-rebound') },
    async recall() { await accept({ kind: 'recall', target, messageId: original.messageId }) },
    async emit() { await accept({ kind: 'message', message: structuredClone(original) }) },
    async run() {
      await f.emit()
      await waitFor(async () => terminal && await settled(), () => `file send turn did not drain: ${JSON.stringify({ diagnostics, requests: requests.map(row => row.messages.filter(message => message.role === 'tool')) })}`)
      await host.runtime.drain()
    },
    async receipts() {
      const receipts = []
      for (const redisKey of await reader.keys(prefix + 'shiloh:character:v1:*')) if (await reader.type(redisKey) === 'string') {
        receipts.push(...(JSON.parse(await reader.get(redisKey)).receipts ?? []))
      }
      return receipts
    },
  }
  await host.start()
  return f
}

test('public file upload fixes target/binding/bytes, deduplicates, charges a no-message-ID upload and revokes its completed port', redisTest, async t => {
  let context, first, duplicate, textAfterFile, anotherAfterFile, forgedTarget
  const f = await fixture(t, { async execute(_input, selected) {
    context = selected
    first = await selected.sendFile(file)
    duplicate = await selected.sendFile({ ...file })
    textAfterFile = await attempt(() => selected.sendMessage({ text: '上传之后尝试额外普通消息' }))
    anotherAfterFile = await attempt(() => selected.sendFile(anotherFile))
    forgedTarget = await attempt(() => selected.sendFile({ ...file, target: { kind: 'private', id: 'somebody-else' } }))
    return { status: 'succeeded', content: '已收到明确的文件上传回执' }
  } })
  await f.run()
  assert.deepEqual(first, { state: 'uploaded', fileId: 'uploaded-file-1' })
  assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_file' })
  assert.equal(textAfterFile.status, 'rejected'); assert.match(textAfterFile.reason, /上限/u)
  assert.equal(anotherAfterFile.status, 'rejected'); assert.match(anotherAfterFile.reason, /上限/u)
  assert.equal(forgedTarget.status, 'rejected'); assert.match(forgedTarget.reason, /参数无效/u)
  assert.equal(f.uploadAttempts.length, 1); assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 0)
  assert.deepEqual(f.uploads[0], { version: 1, kind: 'file.upload', target: f.target, file, binding: f.binding })
  assert.ok(f.uploadAttempts[0].guard.signal instanceof AbortSignal)
  const state = await f.session()
  assert.deepEqual(state.sendTimes, [f.now]); assert.equal(state.lastAiSendAt, f.now)
  assert.deepEqual(state.confirmedMessageIds ?? [], [], 'file evidence cannot become an ordinary reply ID')
  assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false)
  await assert.rejects(context.sendFile(anotherFile), /失效/u)
  assert.equal(f.uploadAttempts.length, 1)
})

test('ordinary messages and generated files share the same per-turn send allowance', redisTest, async t => {
  let sent, upload
  const f = await fixture(t, { async execute(_input, context) {
    sent = await context.sendMessage({ text: '普通消息先占用本轮发送配额。' })
    upload = await attempt(() => context.sendFile(file))
    return { status: 'succeeded', content: '普通回复已确认，未额外上传' }
  } })
  await f.run()
  assert.deepEqual(sent, { state: 'sent', messageId: 'out-1' })
  assert.equal(upload.status, 'rejected'); assert.match(upload.reason, /上限/u)
  assert.equal(f.messages.length, 1); assert.equal(f.uploadAttempts.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [f.now])
})

test('an unknown upload cannot be relabeled successful or followed by another file, message or external tool, and is never retried', redisTest, async t => {
  let first, fileAfterUnknown, textAfterUnknown
  const f = await fixture(t, {
    maxSends: 4,
    async upload(action, guard, selected) {
      assert.equal(guard.isCurrent(), true); selected.uploads.push(structuredClone(action)); return { state: 'unknown' }
    },
    async execute(_input, context) {
      first = await context.sendFile(file)
      fileAfterUnknown = await attempt(() => context.sendFile(anotherFile))
      textAfterUnknown = await attempt(() => context.sendMessage({ text: '未知上传后的额外发送' }))
      return { status: 'succeeded', content: '生成器试图声称上传已经成功' }
    },
    model(round) {
      if (round === 1 || round === 3) return call(producerName)
      if (round === 2) return call(externalName)
      if (round === 4) return call('simSendMessage', { continuation: 'chat', messages: ['未知上传后的额外普通发送'] })
    },
  })
  await f.run()
  assert.deepEqual(first, { state: 'unknown' })
  for (const outcome of [fileAfterUnknown, textAfterUnknown]) { assert.equal(outcome.status, 'rejected'); assert.match(outcome.reason, /未知/u) }
  assert.equal(f.producerCalls, 1); assert.equal(f.externalCalls, 0)
  assert.equal(f.uploadAttempts.length, 1); assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [], 'unconfirmed upload never becomes a confirmed send')
  const receipts = await f.receipts()
  assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
  assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
  assert.match(f.observed.find(row => row.name === producerName).content, /未知/u)
})

test('a confirmed upload whose send-accounting save fails becomes unknown even when its producer catches errors and reports success', redisTest, async t => {
  let first, second, injected = false, failedSaves = 0, restoreStorage
  const f = await fixture(t, {
    maxSends: 4,
    async upload(action, guard, selected) {
      assert.equal(guard.isCurrent(), true)
      selected.uploads.push(structuredClone(action))
      if (!injected) {
        injected = true
        const save = selected.storage.set
        restoreStorage = () => { selected.storage.set = save }
        selected.storage.set = (name, value, ...args) => {
          if (name === simulationSessionKey(selected.key) && failedSaves === 0) {
            failedSaves++
            throw new Error('fixture post-upload send-accounting write failed')
          }
          return save(name, value, ...args)
        }
      }
      return { state: 'uploaded', fileId: `confirmed-before-save-${selected.uploads.length}` }
    },
    async execute(_input, context) {
      first = await attempt(() => context.sendFile(file))
      second = await attempt(() => context.sendFile(anotherFile))
      return { status: 'succeeded', content: '生成器捕获了异常并错误声称本轮上传成功' }
    },
    model(round) {
      if (round === 1) return call(producerName)
      if (round === 2) return call(externalName)
      if (round === 3) return call('simSendMessage', { continuation: 'chat', messages: ['本地保存失败后的额外消息'] })
    },
  })
  t.after(() => restoreStorage?.())
  await f.run()
  assert.equal(failedSaves, 1, 'the injected failure occurs after confirmed native upload')
  assert.deepEqual(first, { status: 'fulfilled', value: { state: 'unknown' } }, 'do not expose an ambiguous post-upload write as a catchable ordinary failure')
  assert.equal(second.status, 'rejected'); assert.match(second.reason, /未知/u)
  assert.equal(f.uploadAttempts.length, 1); assert.equal(f.uploads.length, 1)
  assert.equal(f.messages.length, 0); assert.equal(f.externalCalls, 0)
  const receipts = await f.receipts()
  assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
  assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
})

test('binding replacement and source recall cancel queued uploads before adapter dispatch', redisTest, async t => {
  for (const mode of ['binding', 'recall']) await t.test(mode, async t => {
    let release, context, adapterWaiting = false, outcomes
    const gate = new Promise(resolve => { release = resolve })
    const f = await fixture(t, {
      maxSends: 3, release: () => release(),
      async upload(action, guard, selected) {
        adapterWaiting = true
        await gate
        if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'cancelled_before_dispatch' }
        selected.uploads.push(structuredClone(action)); return { state: 'uploaded', fileId: 'late-file-must-not-upload' }
      },
      async execute(_input, selected) {
        context = selected
        outcomes = await Promise.allSettled([selected.sendFile(file), selected.sendFile(anotherFile)])
        return { status: 'succeeded', content: '排队上传已结束' }
      },
    })
    await f.emit()
    await waitFor(() => adapterWaiting, () => `file did not reach the adapter queue: ${f.diagnostics.join('|')}`)
    assert.equal(f.uploadAttempts.length, 1); assert.equal(f.uploads.length, 0)
    if (mode === 'binding') f.rebind()
    else await f.recall()
    await waitFor(() => context.signal.aborted, 'queued tool cancellation')
    assert.equal(context.isCurrent(), false)
    assert.equal(f.uploadAttempts[0].guard.isCurrent(), false, 'adapter queue receives a live binding/recall fence')
    assert.equal(f.uploadAttempts[0].guard.signal.aborted, true)
    release()
    await waitFor(async () => outcomes && await f.settled(), () => `cancelled file queue did not drain: ${f.diagnostics.join('|')}`)
    await f.host.runtime.drain()
    assert.equal(f.uploadAttempts.length, 1, 'second queued upload never reaches the adapter')
    assert.equal(f.uploads.length, 0); assert.equal(f.messages.length, 0)
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected'))
  })
})

test('temporary file tools receive no sendFile port and subsequent file producers cannot upload derived data', redisTest, async t => {
  const f = await fixture(t, {
    temporary: true,
    async execute(_input, context) { await context.sendFile(file); return { status: 'succeeded', content: '不应执行的派生文件生成' } },
    model(round) {
      if (round === 1) return call(readerName)
      if (round === 2) return call(producerName)
    },
  })
  await f.run()
  assert.equal(f.reads, 1); assert.equal(f.producerCalls, 0)
  assert.equal(f.outputs[0].absentBeforeRead, true); assert.equal(f.outputs[1].absentAfterRead, true)
  assert.equal(Buffer.from(f.outputs[1].result.base64, 'base64').toString(), temporary)
  assert.equal(f.uploadAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.equal((await f.receipts()).some(receipt => [readerName, producerName].includes(receipt.toolName)), false)
  assert.deepEqual(f.observed, [])
  for (const redisKey of await f.reader.keys(f.prefix + '*')) if (await f.reader.type(redisKey) === 'string') {
    assert.ok(!(await f.reader.get(redisKey)).includes(temporary), 'temporary body is never persisted')
  }
})

test('Core output rules inspect generated filenames, decoded text and known credential material before file transport', redisTest, async t => {
  const forbiddenName = 'blocked-title.txt', forbiddenText = 'blocked-content-in-file', credential = 'HOST_CREDENTIAL_VALUE_782436'
  const inspected = [], receipts = []
  const candidates = [
    { ...file, name: forbiddenName },
    { ...file, name: 'content.txt', base64: Buffer.from(forbiddenText).toString('base64') },
    { ...file, name: 'credential.txt', base64: Buffer.from(`记录：${credential}`).toString('base64') },
  ]
  const f = await fixture(t, {
    allowsText(text, direction) { inspected.push({ text, direction }); return ![forbiddenName, forbiddenText, credential].some(value => text.includes(value)) },
    async execute(_input, context) {
      for (const candidate of candidates) receipts.push(await context.sendFile(candidate))
      return { status: 'succeeded', content: '输出策略已拒绝不允许的文件' }
    },
  })
  await f.run()
  assert.deepEqual(receipts, candidates.map(() => ({ state: 'failed', code: 'forbidden_text' })))
  for (const marker of [forbiddenName, forbiddenText, credential]) assert.ok(inspected.some(row => row.direction === 'outgoing' && row.text.includes(marker)))
  assert.equal(f.uploadAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [], 'rejected files do not consume confirmed send allowance')
})
