import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentLocalEmojiIngress } = await load('modules/emoji/infrastructure/agentLocalEmojiIngress.js')
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3hUAAAAASUVORK5CYII=' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick() } assert.fail('fixture did not reach its expected boundary') }
function input({ id = 'message-1', account = '10001', group = '20001', read, images = [image] } = {}) {
  const controller = new AbortController(), done = deferred()
  let current = true, released = 0, reads = 0, checks = 0
  const binding = { source: 'configured', id: 'binding-' + account + '-' + group, revision: 'v1', agentId: 'alice', personaId: 'shared', connectionId: 'connection-' + account,
    target: { account: { platform: 'qq', namespace: 'global', id: account }, kind: 'group', id: group } }
  const source = { version: 1, binding, conversation: structuredClone(binding.target), sender: { platform: 'qq', namespace: 'global', id: '30001' },
    messageId: id, occurredAt: 1795000000000, text: '', parts: images.map(() => ({ kind: 'image', resource: { kind: 'reference', value: 'owned-opaque-image' } })), mentions: [], directedToAccount: false }
  const value = { binding, source, guard: { signal: controller.signal, isCurrent() { return current }, async ensureCurrent() { checks++; if (!current) throw Error('revoked fixture') } },
    async read(guard) { reads++; return read ? read(guard) : images }, release() { released++; done.resolve() } }
  return { value, controller, done: done.promise, revoke() { current = false }, get released() { return released }, get reads() { return reads }, get checks() { return checks } }
}
function ingress(t, options = {}) {
  const collected = []
  const runtime = createAgentLocalEmojiIngress({ enabled: () => true, async collect(image, context) { collected.push({ image, context }); return { ok: true } }, ...options })
  t.after(() => runtime.stop())
  return { runtime, collected }
}

test('verified ingress reads only its host closure, preserves source guards and collects at most two inline images', async t => {
  let readGuard
  const f = ingress(t), source = input({ images: [{ ...image, presentation: 'sticker' }, image, image], read(guard) { readGuard = guard; return [image, { ...image, presentation: 'sticker' }, image] } })
  assert.equal(f.runtime.enqueue(source.value), undefined)
  await source.done
  assert.equal(source.released, 1); assert.equal(source.reads, 1); assert.equal(f.collected.length, 2)
  for (const call of f.collected) {
    assert.deepEqual(call.image, image)
    assert.deepEqual(call.context.binding, source.value.binding); assert.notEqual(call.context.binding, source.value.binding)
    assert.deepEqual(call.context.source, { messageId: 'message-1', author: source.value.source.sender, occurredAt: source.value.source.occurredAt })
    assert.equal(call.context.signal, readGuard.signal); assert.equal(call.context.ensureCurrent, readGuard.ensureCurrent)
    assert.equal(call.context.isCurrent(), false)
  }
})

test('global work is limited to two, same conversations serialize, and separate accounts with the same bare group stay independent', async t => {
  const gate = deferred(), reads = [], collected = []
  let working = 0, maximum = 0
  const f = ingress(t, { async collect(_image, context) { collected.push(context.source.messageId); return { ok: true } } })
  const make = (id, account = '10001') => input({ id, account, async read() { reads.push(id); working++; maximum = Math.max(maximum, working); await gate.promise; working--; return [image] } })
  const a = make('a'), b = make('b', '10002'), c = make('c', '10003')
  f.runtime.enqueue(a.value); f.runtime.enqueue(b.value); f.runtime.enqueue(c.value)
  const pending = ['old-1', 'old-2', 'new-1', 'new-2'].map(id => make(id))
  pending.forEach(source => f.runtime.enqueue(source.value))
  await Promise.all(pending.slice(0, 2).map(source => source.done)); await until(() => reads.length === 2)
  assert.deepEqual(reads, ['a', 'b']); assert.equal(pending[2].checks, 0); assert.equal(pending[3].checks, 0)
  gate.resolve(); await Promise.all([a, b, c, ...pending].map(source => source.done))
  assert.equal(maximum, 2); assert.deepEqual(new Set(collected), new Set(['a', 'b', 'c', 'new-1', 'new-2']))
  assert.equal(pending[0].reads, 0); assert.equal(pending[1].reads, 0)
  for (const source of [a, b, c, ...pending]) assert.equal(source.released, 1)
})

test('the total pending queue remains bounded and stop releases every retained source exactly once', async t => {
  const gate = deferred(), f = ingress(t)
  const first = input({ id: 'active-1', group: 'active-1', read: () => gate.promise }), second = input({ id: 'active-2', group: 'active-2', read: () => gate.promise })
  f.runtime.enqueue(first.value); f.runtime.enqueue(second.value); await until(() => first.reads + second.reads === 2)
  const pending = Array.from({ length: 65 }, (_, i) => input({ id: 'pending-' + i, group: 'group-' + i }))
  pending.forEach(source => f.runtime.enqueue(source.value)); await pending[0].done
  assert.equal(pending[0].reads, 0); assert.equal(pending.filter(source => source.released).length, 1)
  await f.runtime.stop(); gate.resolve([image]); await tick()
  assert.equal(f.collected.length, 0)
  for (const source of [first, second, ...pending]) { await source.done; assert.equal(source.released, 1) }
  const after = input(); f.runtime.enqueue(after.value); await after.done; assert.equal(after.reads, 0); assert.equal(after.released, 1)
})

test('queued abort and current changes discard sources before reading or acquiring asynchronous fences', async t => {
  const gate = deferred(), f = ingress(t), first = input({ id: 'active', read: () => gate.promise })
  f.runtime.enqueue(first.value); await until(() => first.reads === 1)
  const aborted = input({ id: 'abort' }), revoked = input({ id: 'revoke' }), later = input({ id: 'later' })
  f.runtime.enqueue(aborted.value); f.runtime.enqueue(revoked.value)
  aborted.controller.abort(); revoked.revoke(); f.runtime.enqueue(later.value)
  await Promise.all([aborted.done, revoked.done])
  assert.equal(aborted.reads + revoked.reads + aborted.checks + revoked.checks, 0)
  gate.resolve([image]); await Promise.all([first.done, later.done])
  assert.deepEqual(f.collected.map(call => call.context.source.messageId), ['active', 'later'])
})

test('abort fences a late reader and releases without waiting for an uncooperative transport', async t => {
  const gate = deferred(), f = ingress(t), source = input({ read: () => gate.promise })
  f.runtime.enqueue(source.value); await until(() => source.reads === 1)
  source.controller.abort(); await source.done
  gate.resolve([image]); await tick(); await tick()
  assert.equal(f.collected.length, 0); assert.equal(source.released, 1)
})

test('stop during lazy fence acquisition never invokes a later reader', async t => {
  const gate = deferred(), f = ingress(t), source = input()
  let acquiring = false
  source.value.guard.ensureCurrent = async () => { acquiring = true; await gate.promise }
  f.runtime.enqueue(source.value); await until(() => acquiring)
  await f.runtime.stop(); gate.resolve(); await source.done; await tick()
  assert.equal(source.reads, 0); assert.equal(source.released, 1); assert.equal(f.collected.length, 0)
})

test('active collection retains the original source fence so a late collector cannot commit after revocation', async t => {
  const gate = deferred(); let context, writes = 0
  const f = ingress(t, { async collect(_image, guard) { context = guard; await gate.promise; if (guard.isCurrent()) writes++; return { ok: true } } }), source = input()
  f.runtime.enqueue(source.value); await until(() => context)
  source.revoke(); source.controller.abort(); await source.done
  gate.resolve(); await tick()
  assert.equal(writes, 0); assert.equal(context.isCurrent(), false); assert.equal(source.released, 1)
  await assert.rejects(() => context.ensureCurrent())
})

test('mutating source identity, binding, media, timestamp, target or text during a read prevents collection', async t => {
  const mutations = [
    source => { source.value.source.messageId = 'different' }, source => { source.value.binding.revision = 'v2' },
    source => { source.value.source.parts[0].resource.value = 'different-image' }, source => { source.value.source.occurredAt++ },
    source => { source.value.source.sender.id = 'different-author' }, source => { source.value.source.conversation.id = 'different-target' },
    source => { source.value.source.text = 'changed body' },
  ]
  for (const mutate of mutations) {
    const gate = deferred(), f = ingress(t), source = input({ read: () => gate.promise })
    f.runtime.enqueue(source.value); await until(() => source.reads === 1)
    mutate(source); gate.resolve([image]); await source.done
    assert.equal(f.collected.length, 0); assert.equal(source.released, 1)
  }
})

test('only fully bound same-conversation human image sources are admitted', async t => {
  const invalid = [
    source => { delete source.value.source.messageId }, source => { delete source.value.source.binding },
    source => { source.value.source.binding = { ...source.value.binding, agentId: 'bob' } },
    source => { source.value.source.conversation.id = 'other' }, source => { source.value.source.sender.id = '10001' },
    source => { source.value.source.sender.namespace = 'other' }, source => { source.value.source.occurredAt = NaN },
    source => { source.value.source.occurredAt = -1 }, source => { source.value.source.parts = [{ kind: 'text', text: '[image]' }] },
    source => { source.value.source.parts = []; source.value.source.quote = { parts: [{ kind: 'image' }] } },
  ]
  const f = ingress(t)
  for (const mutate of invalid) {
    const source = input(); mutate(source); assert.doesNotThrow(() => f.runtime.enqueue(source.value)); await source.done
    assert.equal(source.reads, 0); assert.equal(source.checks, 0); assert.equal(source.released, 1)
  }
  assert.equal(f.collected.length, 0)
})

test('disabled configuration, duplicate sources and throwing background dependencies release without escaping enqueue', async t => {
  let enabled = false
  const gate = deferred(), f = ingress(t, { enabled: () => enabled })
  const disabled = input(); f.runtime.enqueue(disabled.value); await disabled.done; assert.equal(disabled.reads, 0)
  enabled = true
  const first = input({ read: () => gate.promise }), duplicate = input()
  f.runtime.enqueue(first.value); f.runtime.enqueue(duplicate.value); await duplicate.done
  assert.equal(duplicate.reads, 0)
  await until(() => first.reads === 1); enabled = false; gate.resolve([image]); await first.done
  assert.equal(f.collected.length, 0)
  const error = ingress(t, { async collect() { throw Error('unavailable') } }), rejected = input({ read() { throw Error('source disappeared') } }), collectorError = input()
  error.runtime.enqueue(rejected.value); await rejected.done; error.runtime.enqueue(collectorError.value); await collectorError.done
  assert.equal(rejected.released, 1); assert.equal(collectorError.released, 1)
})

test('secrets and denied source text never reach readers, and invalid or secret image bytes never reach collectors', async t => {
  const secret = 'fixture-emoji-ingress-secret', f = ingress(t, { secrets: [secret], allowsText: text => !text.includes('private-body') })
  for (const body of [secret, 'private-body']) {
    const source = input(); source.value.source.text = body; f.runtime.enqueue(source.value); await source.done; assert.equal(source.reads, 0)
  }
  const bad = [
    { mime: image.mime, base64: 'https://untrusted.test/image.png' },
    { ...image, url: 'https://untrusted.test/image.png' },
    { mime: image.mime, base64: Buffer.concat([Buffer.from(image.base64, 'base64'), Buffer.from(secret)]).toString('base64') },
    { mime: image.mime, base64: 'A'.repeat(7_000_000) },
  ]
  for (let i = 0; i < bad.length; i++) {
    const source = input({ id: 'bad-' + i, read: () => [bad[i]] }); f.runtime.enqueue(source.value); await source.done; assert.equal(source.released, 1)
  }
  assert.equal(f.collected.length, 0)
})
