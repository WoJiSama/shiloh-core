import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createQqQzoneProvider, QQ_QZONE_TIMEOUT_MS, QQ_QZONE_HTTP_TIMEOUT_MS, QQ_QZONE_MAX_RESPONSE_BYTES } = await importBilibiliHost('adapters/qqQzoneProvider.js')
const { queuedDeliveryAllowed } = await importBilibiliHost('modules/messaging/infrastructure/deliveryScope.js')
const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '987654321' }
const binding = { source: 'configured', id: 'bound', revision: 'r1', agentId: 'alice', personaId: 'default', connectionId: 'qq-main', target }
const op = kind => kind === 'publish' ? { kind, text: '今天风很好。' } : kind === 'delete' ? { kind, postId: 'stable-post_1' }
  : kind === 'visit' ? { kind, userId: '333333333' } : { kind, userId: '333333333', postId: 'stable-post_1', visitId: 'trusted-visit', ...(kind === 'comment' ? { text: '真好看。' } : {}) }
const action = (kind = 'publish', extra = {}) => ({ version: 1, binding: structuredClone(binding), operation: op(kind), ...extra })
const ok = (data = null, extra = {}) => ({ status: 'ok', retcode: 0, data, ...extra })
const creds = () => ok({ cookies: 'p_skey=SECRET; skey=DIFFERENT_SECRET;', token: 0 })
const ownership = () => ({ account: structuredClone(account), agentId: binding.agentId, postId: 'stable-post_1', source: structuredClone(binding) })
const feed = (extra = {}) => ({ tid: 'stable-post_1', content: '在公园散步。', uin: '333333333', created_time: 12345, fwd: { cntlike: 2 }, ...extra })
const json = value => new Response(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(overrides = {}) {
  const calls = [], http = [], guards = [], controller = new AbortController()
  let current = true, ready = true, checks = 0
  const guard = { signal: controller.signal, isCurrent: () => current, async ensureCurrent() { checks++ } }
  const provider = createQqQzoneProvider({ account, connectionId: binding.connectionId, isReady: () => ready,
    async callApi(name, params, scope) {
      assert.equal(queuedDeliveryAllowed(), true); calls.push({ name, params, scope }); guards.push(scope)
      return name === 'get_credentials' ? creds() : name === 'send_qzone_msg' ? ok({ tid: 'stable-post_1' }) : ok()
    }, async readOwnPost() { return ownership() },
    async fetch(url, options) {
      assert.equal(queuedDeliveryAllowed(), true); http.push({ url, options })
      return String(url).includes('emotion_cgi_msglist_v6') ? json({ code: 0, msglist: [feed()] })
        : String(url).includes('emotion_cgi_re_feeds') ? new Response(' sharrpCallback ( {"code":0} ); ') : json({ ret: 0 })
    }, ...overrides })
  return { provider, calls, http, guards, guard, controller, checks: () => checks, revoke() { current = false }, offline() { ready = false },
    execute(kind, extra) { return provider.execute(action(kind, extra), guard) } }
}

test('QQ Qzone native publication is pure text and returns only a stable post ID', async () => {
  const f = fixture(), result = await f.execute('publish')
  assert.deepEqual(result, { state: 'confirmed', postId: 'stable-post_1' })
  assert.deepEqual(f.calls.map(({ name, params }) => ({ name, params })), [{ name: 'send_qzone_msg', params: { content: '今天风很好。' } }])
  assert.equal(f.http.length, 0); assert.ok(f.checks() >= 2)
  assert.equal(QQ_QZONE_TIMEOUT_MS, 30000); assert.equal(QQ_QZONE_HTTP_TIMEOUT_MS, 15000); assert.equal(QQ_QZONE_MAX_RESPONSE_BYTES, 262144)
  const scope = f.guards[0]
  assert.ok(scope.timeoutMs > 0 && scope.timeoutMs <= 30000); assert.ok(scope.signal instanceof AbortSignal); assert.ok(Object.isFrozen(f.calls[0].params))
})

test('QQ Qzone native deletion requires independently stored matching account, agent and stable post ID', async () => {
  let lookups = 0
  const f = fixture({ async readOwnPost(selected, id) { lookups++; assert.deepEqual(selected, account); assert.equal(id, 'stable-post_1'); return ownership() } })
  assert.deepEqual(await f.execute('delete'), { state: 'confirmed' }); assert.equal(lookups, 1)
  assert.deepEqual(f.calls.map(({ name, params }) => ({ name, params })), [{ name: 'delete_qzone_msg', params: { tid: 'stable-post_1' } }])
  const invalid = [undefined, { ...ownership(), postId: 'other' }, { ...ownership(), agentId: 'bob' }, { ...ownership(), account: { ...account, id: '999' } },
    { ...ownership(), source: { ...binding, agentId: 'bob' } }, { ...ownership(), source: { ...binding, target: { ...target, account: { ...account, id: '999' } } } }]
  for (const value of invalid) {
    const denied = fixture({ async readOwnPost() { return value } })
    assert.equal((await denied.execute('delete')).state, 'failed'); assert.equal(denied.calls.length, 0)
  }
  const missing = fixture({ readOwnPost: undefined }); assert.equal((await missing.execute('delete')).state, 'failed'); assert.equal(missing.calls.length, 0)
})

test('QQ Qzone rejects positions, image/visibility options, changed accounts/connections and untrusted identity before dispatch', async () => {
  const f = fixture()
  const invalid = [action('publish', { extra: true }), action('publish', { version: 2 }), action('publish', { operation: { ...op('publish'), images: [] } }),
    action('publish', { operation: { ...op('publish'), ugc_right: 64 } }), action('delete', { operation: { kind: 'delete', pos: 1 } }),
    action('delete', { operation: { kind: 'delete', postId: '../foreign' } }), action('publish', { operation: { kind: 'publish', text: '\u0000' } }),
    action('publish', { operation: { kind: 'publish', text: 'x'.repeat(2001) } }),
    action('publish', { binding: { ...binding, connectionId: 'foreign' } }), action('publish', { binding: { ...binding, target: { ...target, account: { ...account, id: '999' } } } }),
    action('publish', { binding: { ...binding, source: 'legacy' } }),
    action('publish', { binding: { ...binding, target: { ...target, account: { ...account, platform: 'other' } } } }),
    action('publish', { binding: { ...binding, target: { ...target, account: { ...account, namespace: 'other' } } } }),
    action('like', { operation: { ...op('like'), userId: '0333333333' } }), action('comment', { operation: { ...op('comment'), text: 'x'.repeat(121) } }),
    action('visit', { binding: { ...binding, target: { ...target, kind: 'private' } } })]
  for (const value of invalid) assert.deepEqual(await f.provider.execute(value, f.guard), { state: 'failed', code: 'qzone_invalid_request' })
  assert.equal(f.calls.length, 0); assert.equal(f.http.length, 0)
})

test('QQ Qzone request/native ownership decoding does not execute getters, proxies or implicit conversion', async () => {
  let touched = 0
  const getter = { ...op('publish') }; Object.defineProperty(getter, 'text', { get() { touched++; return 'secret' } })
  const proxy = value => new Proxy(value, { get() { touched++; throw Error('SECRET') }, getPrototypeOf() { touched++; throw Error('SECRET') }, ownKeys() { touched++; throw Error('SECRET') } })
  const f = fixture()
  for (const value of [proxy(action()), action('publish', { operation: getter }), action('publish', { binding: proxy(binding) })]) assert.equal((await f.provider.execute(value, f.guard)).state, 'failed')
  for (const value of [ok({ get tid() { touched++; return 'fake' } }), ok({ tid: { toString() { touched++; return 'fake' } } }), ok(proxy({ tid: 'fake' }))]) {
    const d = fixture({ async callApi() { return value } }); assert.deepEqual(await d.execute('publish'), { state: 'unknown' })
  }
  const d = fixture({ async readOwnPost() { return { ...ownership(), get agentId() { touched++; return 'alice' } } } }); assert.equal((await d.execute('delete')).state, 'failed')
  assert.equal(touched, 0)
})

test('QQ Qzone malformed native and conflicting receipt fields remain unknown without retry', async () => {
  const invalid = [ok(), ok({}), ok({ tid: '' }), ok({ tid: 'fake', message_id: '42' }), ok({ tid: 'fake' }, { messageId: '42' }),
    ok({ tid: 'fake' }, { self_id: '999' }), { status: 'ok', retcode: 1, data: { tid: 'fake' } }, { state: 'confirmed', postId: 'fake' },
    { status: 'failed', retcode: 0, data: { tid: 'fake' } }]
  for (const response of invalid) {
    let calls = 0; const f = fixture({ async callApi() { calls++; return response } })
    assert.deepEqual(await f.execute('publish'), { state: 'unknown' }); assert.equal(calls, 1)
  }
  for (const response of [ok({}), { status: 'ok', retcode: 0, data: undefined }, { status: 'ok', retcode: 0 }]) {
    const f = fixture({ async callApi() { return response } }); assert.deepEqual(await f.execute('delete'), { state: 'unknown' })
  }
  const rejected = fixture({ async callApi() { return { status: 'failed', retcode: 1400, data: { tid: 'forged' } } } })
  assert.deepEqual(await rejected.execute('publish'), { state: 'failed', code: 'qzone_native_rejected' })
})

test('QQ Qzone recognizes only exact trusted pre-dispatch transport failure markers', async () => {
  for (const kind of ['publish', 'delete']) for (const code of ['qq_action_cancelled', 'onebot_disconnected']) {
    let calls = 0, dispatched = 0, checks = 0
    const f = fixture({ async callApi(name, params, scope) {
      calls++
      // The trusted transport's last authorization/readiness check refused before its native dispatch.
      try { await scope.ensureCurrent() } catch { return { state: 'failed', code: 'qq_action_cancelled' } }
      if (code === 'onebot_disconnected') return { state: 'failed', code }
      dispatched++
      return ok(name === 'send_qzone_msg' ? { tid: 'unexpected-dispatch' } : null)
    } })
    f.guard.ensureCurrent = async () => { checks++; if (checks === (kind === 'delete' ? 4 : 3) && code === 'qq_action_cancelled') throw Error('source_withdrawn_before_dispatch') }
    assert.deepEqual(await f.execute(kind), { state: 'failed', code: 'qzone_native_rejected' })
    assert.equal(calls, 1); assert.equal(dispatched, 0); assert.equal(f.http.length, 0)
  }
  for (const response of [{ state: 'failed' }, { state: 'failed', code: 'other' }, { state: 'failed', code: 'qq_action_cancelled', data: null },
    { state: 'failed', code: 'onebot_disconnected', message_id: 'forged' }, { state: 'failed', code: 'qq_action_cancelled', status: 'ok', retcode: 0 }]) {
    const f = fixture({ async callApi() { return response } })
    assert.deepEqual(await f.execute('publish'), { state: 'unknown' })
  }
  let calls = 0
  const afterDispatch = fixture({ async callApi() { calls++; throw Error('disconnected_after_dispatch') } })
  assert.deepEqual(await afterDispatch.execute('publish'), { state: 'unknown' }); assert.equal(calls, 1)
})

test('QQ Qzone visit credentials are account-bound, token zero is retained and compact data is credential-free', async () => {
  const f = fixture(), result = await f.execute('visit')
  assert.deepEqual(result, { state: 'confirmed', feeds: [{ postId: 'stable-post_1', userId: '333333333', text: '在公园散步。', createdAt: 12345000, likes: 2 }] })
  assert.deepEqual(f.calls.map(({ name, params }) => ({ name, params })), [{ name: 'get_credentials', params: { domain: 'qzone.qq.com' } }])
  const request = f.http[0], url = new URL(request.url)
  assert.equal(url.origin, 'https://user.qzone.qq.com'); assert.equal(url.pathname, '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6')
  assert.equal(url.searchParams.get('g_tk'), '0'); assert.equal(url.searchParams.get('uin'), account.id); assert.equal(url.searchParams.get('hostUin'), '333333333')
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.headers.Cookie, 'p_skey=SECRET; skey=DIFFERENT_SECRET;')
  assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.ok(Object.isFrozen(result.feeds)); assert.ok(Object.isFrozen(result.feeds[0]))
})

test('QQ Qzone visit requires an explicit valid list and never treats missing evidence as an empty space', async () => {
  const invalid = [{ code: 0 }, { code: 0, msglist: null }, { code: 0, msglist: '[]' }, { msglist: [] }, { code: '0', msglist: [] },
    { ret: 0, code: 1, msglist: [] }, { code: 0, msglist: [{}] }, { code: 0, msglist: [feed({ uin: 'other' })] },
    { code: 0, msglist: [feed(), feed()] }, { code: 0, msglist: [feed({ fwd: { cntlike: -1 } })] },
    { code: 0, msglist: Array.from({ length: 9 }, (_, i) => feed({ tid: 'post-' + i })) }]
  for (const body of invalid) {
    let calls = 0; const f = fixture({ async fetch() { calls++; return json(body) } })
    assert.equal((await f.execute('visit')).state, 'failed'); assert.equal(calls, 1)
  }
  const empty = fixture({ async fetch() { return json({ ret: 0, msglist: [] }) } })
  assert.deepEqual(await empty.execute('visit'), { state: 'confirmed', feeds: [] })
})

test('QQ Qzone like and comment use controlled forms with one HTTP effect and retain ret:0 correctly', async () => {
  for (const kind of ['like', 'comment']) {
    const f = fixture(); assert.deepEqual(await f.execute(kind), { state: 'confirmed' }); assert.equal(f.http.length, 1); assert.equal(f.calls.length, 1)
    const request = f.http[0], url = new URL(request.url), form = new URLSearchParams(request.options.body)
    assert.equal(request.options.method, 'POST'); assert.equal(url.origin, 'https://user.qzone.qq.com'); assert.equal(request.options.redirect, 'error')
    if (kind === 'like') {
      assert.equal(url.pathname, '/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_appbar')
      assert.equal(form.get('curkey'), 'https://user.qzone.qq.com/333333333/mood/stable-post_1'); assert.equal(form.get('opuin'), account.id)
    } else {
      assert.equal(url.pathname, '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_re_feeds'); assert.equal(form.get('content'), '真好看。')
      assert.equal(form.get('hostuin'), '333333333'); assert.equal(form.get('cb'), 'sharrpCallback'); assert.equal(form.get('format'), 'fs')
    }
    assert.equal(JSON.stringify(request.options).includes('trusted-visit'), false)
  }
})

test('QQ Qzone fs comment callback is strict JSON and rejects strings, alternate callbacks and appended script', async () => {
  const invalid = ['{"code":0}', 'fs({"code":0})', 'sharrpCallback({"text":"code=0"})', 'sharrpCallback({"code":"0"})',
    'sharrpCallback({"code":0});evil()', '<script>sharrpCallback({"code":0})</script>', 'sharrpCallback({"code":1,"msg":"\\\"code\\\":0"})',
    'sharrpCallback({"ret":0,"code":1})', 'sharrpCallback({"code":0,"message_id":"fake"})']
  for (const body of invalid) {
    let calls = 0; const f = fixture({ async fetch() { calls++; return new Response(body) } })
    const result = await f.execute('comment'); assert.notEqual(result.state, 'confirmed', body); assert.equal(calls, 1)
  }
  const rejected = fixture({ async fetch() { return new Response('sharrpCallback({"ret":-1})') } })
  assert.deepEqual(await rejected.execute('comment'), { state: 'failed', code: 'qzone_remote_rejected' })
  const ret = fixture({ async fetch() { return new Response('sharrpCallback({"ret":0})') } })
  assert.deepEqual(await ret.execute('comment'), { state: 'confirmed' })
})

test('QQ Qzone credentials must be a strictly valid envelope and never reach HTTP when invalid', async () => {
  const invalid = [ok({ cookies: '', token: 1 }), ok({ cookies: 'skey=x\r\nInjected: yes', token: 1 }), ok({ cookies: 'safe', token: -1 }),
    ok({ cookies: 'safe', token: 'invalid' }), ok({ cookies: 'safe', token: 2147483648 }), ok({ cookies: 'safe', token: 1 }, { self_id: '999' }),
    { data: { cookies: 'safe', token: 1 } }, ok({ cookies: 'safe', token: 1, skey: 'other' })]
  for (const response of invalid) {
    let http = 0; const f = fixture({ async callApi() { return response }, async fetch() { http++; return json({ ret: 0 }) } })
    assert.equal((await f.execute('like')).state, 'failed'); assert.equal(http, 0)
  }
})

test('QQ Qzone source/connection revocation after credentials or own-post lookup stops the following external call', async () => {
  for (const kind of ['visit', 'like', 'comment']) {
    let f, http = 0
    f = fixture({ async callApi() { f.revoke(); return creds() }, async fetch() { http++; return json({ code: 0, msglist: [] }) } })
    assert.equal((await f.execute(kind)).state, 'failed'); assert.equal(http, 0)
  }
  let f, writes = 0
  f = fixture({ async readOwnPost() { f.offline(); return ownership() }, async callApi() { writes++; return ok() } })
  assert.equal((await f.execute('delete')).state, 'failed'); assert.equal(writes, 0)
  const stale = fixture(); stale.revoke(); assert.equal((await stale.execute('publish')).state, 'failed'); assert.equal(stale.calls.length, 0)
})

test('QQ Qzone abort fences hung credentials and native writes, with unknown only after write dispatch', async () => {
  for (const kind of ['visit', 'publish']) {
    const pending = deferred(), started = deferred(); let calls = 0, scope
    const f = fixture({ async callApi(name, params, value) { calls++; scope = value; started.resolve(); return pending.promise } })
    const result = f.execute(kind); await started.promise; f.controller.abort()
    assert.equal((await result).state, kind === 'publish' ? 'unknown' : 'failed'); assert.equal(scope.signal.aborted, true); assert.equal(calls, 1)
    pending.resolve(ok())
  }
})

test('QQ Qzone HTTP body overflow, redirects and malformed write responses cannot confirm or retry', async () => {
  const cases = [() => new Response('x', { status: 302, headers: { location: 'https://foreign.invalid/' } }),
    () => new Response('x', { headers: { 'content-length': String(QQ_QZONE_MAX_RESPONSE_BYTES + 1) } }),
    () => new Response('x'.repeat(QQ_QZONE_MAX_RESPONSE_BYTES + 1)), () => new Response('not-json'),
    () => { const r = new Response('{"ret":0}'); Object.defineProperty(r, 'redirected', { value: true }); return r }]
  for (const response of cases) for (const kind of ['visit', 'like']) {
    let count = 0; const f = fixture({ async fetch() { count++; return response() } })
    assert.equal((await f.execute(kind)).state, kind === 'visit' ? 'failed' : 'unknown'); assert.equal(count, 1)
  }
})

test('QQ Qzone cancellation propagates through fetch and a hung stream without awaiting cancellation', async () => {
  for (const kind of ['visit', 'comment']) {
    const started = deferred(); let cancelled = 0, requestSignal
    const f = fixture({ async fetch(url, options) {
      requestSignal = options.signal
      return new Response(new ReadableStream({ pull() { started.resolve(); return new Promise(() => {}) }, cancel() { cancelled++; return new Promise(() => {}) } }))
    } })
    const execution = f.execute(kind); await started.promise; f.controller.abort()
    const result = await Promise.race([execution, delay(1000).then(() => 'hung')])
    assert.notEqual(result, 'hung'); assert.equal(result.state, kind === 'visit' ? 'failed' : 'unknown'); assert.equal(requestSignal.aborted, true); assert.equal(cancelled, 1)
  }
})

test('QQ Qzone detects source mutation across asynchronous credentials work before HTTP', async () => {
  const pending = deferred(), started = deferred(); let requests = 0
  const f = fixture({ async callApi() { started.resolve(); return pending.promise }, async fetch() { requests++; return json({ ret: 0 }) } })
  const selected = action('like'), execution = f.provider.execute(selected, f.guard)
  await started.promise; selected.operation.postId = 'changed'; pending.resolve(creds())
  assert.equal((await execution).state, 'failed'); assert.equal(requests, 0)
})

test('QQ Qzone invokes live authorization immediately before HTTP and stops when that recheck withdraws its source', async () => {
  const f = fixture(); let checks = 0
  const guard = { ...f.guard, async ensureCurrent() { if (++checks === 4) f.revoke() } }
  assert.equal((await f.provider.execute(action('like'), guard)).state, 'failed')
  assert.equal(checks, 4); assert.equal(f.calls.length, 1); assert.equal(f.http.length, 0)
})

test('QQ Qzone readiness watcher aborts a pending write and preserves the unknown result', async () => {
  const pending = deferred(), started = deferred(); let signal, calls = 0
  const f = fixture({ async fetch(url, options) { calls++; signal = options.signal; started.resolve(); return pending.promise } })
  const execution = f.execute('like'); await started.promise; f.offline()
  const result = await Promise.race([execution, delay(1000).then(() => 'hung')])
  assert.deepEqual(result, { state: 'unknown' }); assert.equal(signal.aborted, true); assert.equal(calls, 1)
  pending.resolve(json({ ret: 0 }))
})
