import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentTools } = await load('modules/tools/infrastructure/agentTools.js')
const { createQqMessageActionPort } = await load('adapters/qqMessageDelivery.js')
const { queuedDeliveryAllowed } = await load('modules/messaging/infrastructure/deliveryScope.js')
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', presentation: 'sticker' }
const bundle = [{ parts: [{ kind: 'text', text: '一起开心' }, { kind: 'image', ...image }] }]
const account = { platform: 'qq', namespace: 'global', id: '123456789' }, target = { account, kind: 'group', id: '315320' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const attempt = async action => { try { return { ok: true, value: await action() } } catch { return { ok: false } } }
const settle = promise => Promise.race([promise, delay(1000).then(() => assert.fail('cancelled source must settle without releasing the queue'))])
const inputFor = method => structuredClone(method === 'sendImage' ? image : bundle)
function sourceGuard() {
  const controller = new AbortController(), state = { current: true }
  return { controller, state, guard: { signal: controller.signal, isCurrent: () => state.current, async ensureCurrent() {} } }
}
function fixture(execute, overrides = {}) {
  const controller = new AbortController(), calls = [], scope = { binding: { source: 'configured', id: 'binding', revision: 'v1',
    agentId: 'delivery-agent', personaId: 'default', connectionId: 'qq', target }, actor: { kind: 'user', user: { ...account, id: '30001' } },
    isCurrent: () => true, async ensureCurrent() {},
    async sendImage(owned, current) { calls.push({ method: 'sendImage', owned, current }); assert.equal(current(), true); return { state: 'sent', messageId: 'image-sent' } },
    async sendBundle(owned, current) { calls.push({ method: 'sendBundle', owned, current }); assert.equal(current(), true); return { state: 'sent', messageId: 'bundle-sent' } },
    async sendMessage() { calls.push({ method: 'sendMessage' }); return { state: 'sent', messageId: 'text-sent' } }, ...overrides }
  const definition = { name: 'deliveryGuardProbe', description: '来源撤回的发送边界验证',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute }
  const tools = createAgentTools({ builtIn: [definition] }, { signal: controller.signal, context: () => scope })
  return { controller, calls, scope, run: () => tools.getExtraTools([definition.name])[0].execute({}, {}) }
}

for (const method of ['sendImage', 'sendBundle']) {
  test(`${method} retains the old unguarded call and owns payload before authorization waits`, async () => {
    const entered = deferred(), release = deferred(), mutable = inputFor(method)
    let sending = false
    const f = fixture(async (_input, context) => {
      sending = true
      const pending = context[method](mutable)
      await entered.promise
      if (method === 'sendImage') { mutable.base64 = 'late invalid bytes'; mutable.presentation = 'invalid' }
      else { mutable[0].parts[0].text = 'late mutation'; mutable[0].parts[1].base64 = 'late invalid bytes' }
      release.resolve()
      await pending
      return { status: 'succeeded', content: 'sent' }
    }, { async ensureCurrent() { if (sending) { entered.resolve(); await release.promise } } })
    assert.equal((await f.run()).status, 'success')
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].owned, inputFor(method))
    assert.equal(f.calls[0].current(), false, 'completed tools cannot keep queue permission alive')
  })

  test(`${method} rechecks source after the host authorization await and never dispatches a revoked source`, async () => {
    const source = sourceGuard(), entered = deferred(), release = deferred()
    let sending = false
    const f = fixture(async (_input, context) => {
      sending = true
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    }, { async ensureCurrent() { if (sending) { entered.resolve(); await release.promise } } })
    const pending = f.run(); await entered.promise
    source.state.current = false; release.resolve()
    assert.equal((await pending).status, 'unknown'); assert.equal(f.calls.length, 0)
  })

  test(`${method} awaits fresh source authorization and rejects revocation across that await`, async t => {
    const source = sourceGuard(), entered = deferred(), release = deferred()
    source.guard.ensureCurrent = async () => { entered.resolve(); await release.promise }
    t.after(() => release.resolve())
    const f = fixture(async (_input, context) => {
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    })
    const pending = f.run()
    await Promise.race([entered.promise, pending.then(() => assert.fail('selected source authorization was skipped'))])
    source.state.current = false; release.resolve()
    assert.equal((await pending).status, 'unknown'); assert.equal(f.calls.length, 0)
  })

  test(`${method} carries source revocation through the actual QQ queue callback`, async t => {
    const source = sourceGuard(), entered = deferred(), release = deferred()
    let nativeSends = 0, queueCurrent
    t.after(() => release.resolve())
    const port = createQqMessageActionPort({ async sendApi() {
      entered.resolve(); await release.promise
      if (!queuedDeliveryAllowed()) return { state: 'failed', code: 'source_revoked' }
      nativeSends++; return { message_id: 'must-not-send' }
    } })
    const f = fixture(async (_input, context) => {
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    }, { [method]: async (owned, current) => {
      queueCurrent = current
      return method === 'sendImage' ? port.send({ version: 1, kind: 'message.send', target,
        parts: [{ kind: 'image', resource: { kind: 'reference', value: `base64://${owned.base64}` }, presentation: owned.presentation }] }, { isCurrent: current })
        : port.sendBundle({ version: 1, kind: 'message.bundle.send', target, items: owned }, { isCurrent: current })
    } })
    const pending = f.run(); await entered.promise
    assert.equal(queueCurrent(), true); source.state.current = false; assert.equal(queueCurrent(), false)
    release.resolve()
    assert.equal((await pending).status, 'unknown'); assert.equal(nativeSends, 0)
  })

  test(`${method} source abort cancels an existing queue wait and leaves its final callback false`, async t => {
    const source = sourceGuard(), entered = deferred(), release = deferred(), settled = deferred()
    let nativeSends = 0, queueCurrent
    t.after(() => release.resolve())
    const f = fixture(async (_input, context) => {
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    }, { [method]: async (_owned, current) => {
      queueCurrent = current; entered.resolve(); await release.promise
      if (current()) nativeSends++
      settled.resolve()
      return { state: 'failed', code: 'source_revoked' }
    } })
    const pending = f.run(); await entered.promise
    source.controller.abort()
    assert.equal(queueCurrent(), false)
    assert.equal((await settle(pending)).status, 'unknown')
    release.resolve(); await settled.promise
    assert.equal(nativeSends, 0)
  })

  test(`${method} source abort also bounds an unresponsive source authorization`, async t => {
    const source = sourceGuard(), entered = deferred(), release = deferred()
    source.guard.ensureCurrent = async () => { entered.resolve(); await release.promise }
    t.after(() => release.resolve())
    const f = fixture(async (_input, context) => {
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    })
    const pending = f.run()
    await Promise.race([entered.promise, pending.then(() => assert.fail('selected source authorization was skipped'))])
    source.controller.abort()
    assert.equal((await settle(pending)).status, 'unknown'); assert.equal(f.calls.length, 0)
  })

  test(`${method} observes source proof failure even when the synchronous predicate still returns true`, async () => {
    const source = sourceGuard()
    source.guard.ensureCurrent = async () => { throw Error('source proof unavailable') }
    const f = fixture(async (_input, context) => {
      await context[method](inputFor(method), source.guard)
      return { status: 'succeeded', content: 'must not send' }
    })
    assert.equal((await f.run()).status, 'unknown'); assert.equal(f.calls.length, 0)
  })

  test(`${method} unknown receipt blocks every following image, bundle and text attempt`, async () => {
    const outcomes = []
    const f = fixture(async (_input, context) => {
      assert.deepEqual(await context[method](inputFor(method), sourceGuard().guard), { state: 'unknown' })
      outcomes.push(await attempt(() => context.sendImage(image)))
      outcomes.push(await attempt(() => context.sendBundle(bundle)))
      outcomes.push(await attempt(() => context.sendMessage({ text: 'must not resend' })))
      return { status: 'succeeded', content: 'unknown must not become success' }
    }, { [method]: async () => { f.calls.push({ method }); return { state: 'unknown' } } })
    assert.equal((await f.run()).status, 'unknown')
    assert.deepEqual(outcomes, [{ ok: false }, { ok: false }, { ok: false }]); assert.equal(f.calls.length, 1)
  })

  test(`${method} reauthorizes after native delivery and blocks a caught failure from causing a duplicate`, async t => {
    const source = sourceGuard(), entered = deferred(), release = deferred(), outcomes = []
    let checks = 0
    source.guard.ensureCurrent = async () => { if (++checks === 2) { entered.resolve(); await release.promise } }
    t.after(() => release.resolve())
    const f = fixture(async (_input, context) => {
      outcomes.push(await attempt(() => context[method](inputFor(method), source.guard)))
      outcomes.push(await attempt(() => context[method](inputFor(method))))
      return { status: 'succeeded', content: 'late source failure must not cause a duplicate' }
    })
    const pending = f.run()
    await Promise.race([entered.promise, pending.then(() => assert.fail('post-delivery source authorization was skipped'))])
    source.state.current = false; release.resolve()
    assert.equal((await pending).status, 'unknown'); assert.equal(checks, 2)
    assert.deepEqual(outcomes, [{ ok: false }, { ok: false }]); assert.equal(f.calls.length, 1)
  })
}
