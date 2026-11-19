import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentToolSourceGuard, captureAgentToolSourceGuard } = await load('modules/runtime/infrastructure/agentToolSourceGuard.js')
const user = id => ({ platform: 'qq', namespace: 'global', id })
function fixture() {
  const controller = new AbortController(), f = { controller, reads: 0, available: true, beforeRead: undefined }
  f.context = createAgentToolSourceGuard({
    binding: { source: 'configured', id: 'room', revision: 'r1', agentId: 'daily', personaId: 'default', connectionId: 'qq',
      target: { account: user('10001'), kind: 'group', id: '20001' } },
    actor: { kind: 'user', user: user('30001') }, request: { messageId: '40001', text: '合成工具请求', mentions: [user('10001')] },
    signal: controller.signal, isCurrent: () => !controller.signal.aborted,
  }, async () => { f.reads++; await f.beforeRead?.(); assert.equal(f.available, true) })
  return f
}

test('source ownership capture invokes no validator or predicate and accepts intact context copies', async () => {
  const f = fixture(), copy = { ...f.context, binding: structuredClone(f.context.binding), actor: structuredClone(f.context.actor),
    request: structuredClone(f.context.request) }
  const proof = captureAgentToolSourceGuard(copy)
  assert.equal(typeof proof, 'function'); assert.equal(f.reads, 0)
  await proof(); await proof(); assert.equal(f.reads, 2)
  f.available = false; await assert.rejects(proof); assert.equal(f.reads, 3)
  f.available = true; await proof(); assert.equal(f.reads, 4)
})

test('source ownership rejects foreign methods, wrappers, signals and changed identity', () => {
  for (const field of ['signal', 'isCurrent', 'ensureCurrent', 'binding', 'actor', 'request', 'mentions', 'replyAuthor']) {
    const f = fixture(), copy = { ...f.context }
    if (field === 'signal') copy.signal = new AbortController().signal
    else if (field === 'isCurrent') copy.isCurrent = () => f.context.isCurrent()
    else if (field === 'ensureCurrent') copy.ensureCurrent = () => f.context.ensureCurrent()
    else if (field === 'binding') copy.binding = { ...copy.binding, revision: 'r2' }
    else if (field === 'actor') copy.actor = { ...copy.actor, user: user('30002') }
    else if (field === 'request') copy.request = { ...copy.request, text: '改变后的请求' }
    else if (field === 'mentions') copy.request = { ...copy.request, mentions: [user('10002')] }
    else copy.request = { ...copy.request, replyAuthor: user('30002') }
    assert.equal(captureAgentToolSourceGuard(copy), undefined, field); assert.equal(f.reads, 0)
  }
  const f = fixture()
  assert.equal(captureAgentToolSourceGuard(Object.create(f.context)), undefined)
})

test('source ownership inspects descriptors without invoking accessors or proxy traps', () => {
  for (const field of ['signal', 'isCurrent', 'ensureCurrent', 'binding', 'actor', 'request', 'nested']) {
    const f = fixture(), copy = { ...f.context }; let accesses = 0
    if (field === 'nested') {
      copy.request = { ...copy.request }
      Object.defineProperty(copy.request, 'text', { get() { accesses++; return f.context.request.text } })
    } else Object.defineProperty(copy, field, { get() { accesses++; return f.context[field] } })
    assert.equal(captureAgentToolSourceGuard(copy), undefined, field); assert.equal(accesses, 0); assert.equal(f.reads, 0)
  }
  const f = fixture(); let traps = 0
  const proxy = new Proxy(f.context, { get() { traps++; throw Error('unexpected proxy read') },
    ownKeys() { traps++; throw Error('unexpected proxy keys') }, getOwnPropertyDescriptor() { traps++; throw Error('unexpected proxy descriptor') } })
  assert.equal(captureAgentToolSourceGuard(proxy), undefined)
  assert.equal(captureAgentToolSourceGuard({ ...f.context, request: proxy }), undefined)
  assert.equal(traps, 0); assert.equal(f.reads, 0)
})

test('source ownership preserves optional own fields and array shape in its identity', () => {
  const f = fixture(), copy = { ...f.context, request: { ...f.context.request, occurredAt: undefined } }
  assert.equal(captureAgentToolSourceGuard(copy), undefined)
  const sparse = { ...f.context, request: { ...f.context.request, mentions: [...f.context.request.mentions] } }
  sparse.request.mentions.length++
  assert.equal(captureAgentToolSourceGuard(sparse), undefined)
})

test('captured source proof rejects method, identity or abort changes across its await', async () => {
  for (const phase of ['signal', 'isCurrent', 'ensureCurrent', 'binding', 'request', 'abort']) {
    const f = fixture(), copy = { ...f.context, request: structuredClone(f.context.request) }
    const proof = captureAgentToolSourceGuard(copy); assert.equal(typeof proof, 'function')
    let release, entered
    const enteredPromise = new Promise(resolve => { entered = resolve })
    f.beforeRead = () => { entered(); return new Promise(resolve => { release = resolve }) }
    const pending = proof(); await enteredPromise
    if (phase === 'signal') copy.signal = new AbortController().signal
    else if (phase === 'isCurrent') copy.isCurrent = () => true
    else if (phase === 'ensureCurrent') copy.ensureCurrent = async () => {}
    else if (phase === 'binding') copy.binding = { ...copy.binding, revision: 'changed' }
    else if (phase === 'request') copy.request.text = 'await期间替换'
    else f.controller.abort()
    release(); await assert.rejects(pending, undefined, phase); assert.equal(f.reads, 1)
  }
})

test('captured source proof rejects revocation on later calls without caching successful reads', async () => {
  const f = fixture(), proof = captureAgentToolSourceGuard(f.context)
  await proof(); f.available = false; await assert.rejects(proof); assert.equal(f.reads, 2)
  const aborted = fixture(), abortedProof = captureAgentToolSourceGuard(aborted.context)
  aborted.controller.abort(); await assert.rejects(abortedProof); assert.equal(aborted.reads, 0)
})

test('source ownership matches only its original plain human source without invoking input callbacks', () => {
  const f = fixture(), proof = captureAgentToolSourceGuard(f.context)
  const source = { messageId: f.context.request.messageId, author: structuredClone(f.context.actor.user) }
  assert.equal(proof.matchesSource(source), true); assert.equal(f.reads, 0)
  assert.equal(proof.matchesSource({ ...source, messageId: 'wallet-1' }), false)
  assert.equal(proof.matchesSource({ ...source, author: user('30002') }), false)
  assert.equal(proof.matchesSource({ ...source, extra: true }), false)
  let accesses = 0
  assert.equal(proof.matchesSource({ get messageId() { accesses++; return source.messageId }, author: source.author }), false)
  assert.equal(proof.matchesSource({ ...source, author: { ...source.author, get id() { accesses++; return source.author.id } } }), false)
  assert.equal(proof.matchesSource(new Proxy(source, { get() { accesses++; throw Error('unexpected read') } })), false)
  assert.equal(accesses, 0); assert.equal(f.reads, 0)
  f.context.request.text = '改变后的请求'; assert.equal(proof.matchesSource(source), false)
})
