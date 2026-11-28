import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis } from './helpers/agentQzoneRedis.mjs'
const { createAgentQzoneLedger } = await importBilibiliHost('modules/runtime/infrastructure/agentQzoneLedger.js')
const { createAgentQzoneRuntime } = await importBilibiliHost('modules/runtime/infrastructure/agentQzoneRuntime.js')
const { createQqQzoneProvider } = await importBilibiliHost('adapters/qqQzoneProvider.js')
const { createAgentQzoneTools } = await importBilibiliHost('modules/tools/infrastructure/agentQzoneTools.js')
const account = { platform: 'qq', namespace: 'global', id: '111111111' }, target = { account, kind: 'group', id: '222222222' }
const userId = '333333333', peerId = '444444444'
const binding = { source: 'configured', id: 'group-bound', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'qq-main', target }
const post = 'stable-post-1', ownPost = 'own-post-1', secret = 'p_skey=PRIVATE_TEST_SECRET; skey=OTHER_SECRET;'
const tools = createAgentQzoneTools({ enabled: true, simulationEnabled: true })
async function fixture(t) {
  const redis = await createQzoneRedis(t), nativeCalls = [], http = [], memberReads = [], emitted = [], controller = new AbortController()
  let current = true, granted = true, member = true, enabled = true, nativeResponse, httpResponse, onCredentials, onMember, onHttp, onSettle
  const actualLedger = createAgentQzoneLedger(redis.storage)
  const ledger = { ...actualLedger, async settle(...args) { const value = await actualLedger.settle(...args); await onSettle?.(); return value } }
  const provider = createQqQzoneProvider({ account, connectionId: 'qq-main', isReady: () => current,
    readOwnPost: ledger.readOwnPost,
    async callApi(name, params, scope) {
      await scope.ensureCurrent(); assert.equal(scope.isCurrent(), true); assert.equal(scope.signal.aborted, false)
      nativeCalls.push({ name, params })
      if (name === 'get_credentials') { await onCredentials?.(); return { status: 'ok', retcode: 0, data: { cookies: secret, token: 0 } } }
      if (nativeResponse) return nativeResponse(name, params, scope)
      return { status: 'ok', retcode: 0, data: name === 'send_qzone_msg' ? { tid: ownPost } : null }
    }, async fetch(url, options) {
      assert.equal(options.signal.aborted, false); assert.equal(options.headers.Cookie, secret); assert.equal(new URL(url).origin, 'https://user.qzone.qq.com')
      http.push({ url, method: options.method, body: options.body })
      await onHttp?.()
      if (httpResponse) return httpResponse(url, options)
      if (options.method === 'GET') return new Response(JSON.stringify({ ret: 0, msglist: [{
        tid: post, uin: new URL(url).searchParams.get('uin'), content: 'PRIVATE_FEED_BODY', fwd: { cntlike: 0 },
      }] }))
      return String(url).includes('emotion_cgi_re_feeds') ? new Response('sharrpCallback({"code":0});') : new Response('{"ret":0}')
    } })
  const diagnostics = { emit(event) { emitted.push(event) } }, runtime = createAgentQzoneRuntime({ ledger, provider, enabled: true, getLimits: () => ({ enabled }), diagnostics })
  const context = { binding: structuredClone(binding), actor: { kind: 'user', user: { ...account, id: userId } }, signal: controller.signal, isCurrent: () => current,
    async ensureCurrent() { if (!current) throw Error('source_withdrawn') }, request: { messageId: '101', text: '请发一条说说', mentions: [] },
    async qzone(operation) { return runtime.execute({ binding: context.binding, actor: context.actor, identity: context.request.messageId, operation,
      signal: controller.signal, isCurrent: context.isCurrent, ensureCurrent: context.ensureCurrent, async authorize() { return granted },
      async allowsText(text) { return !text.includes('冒充') }, affinity: () => 55,
      async readMember(id, guard) { await guard.ensureCurrent(); memberReads.push(id); await onMember?.(); return member ? { target: context.binding.target, observedAt: Date.now(), member: { user: { ...account, id }, displayName: id, role: 'member' } } : undefined },
    }) }, async qzoneCandidates() { return [peerId] } }
  return { redis, actualLedger, ledger, provider, runtime, context, nativeCalls, http, memberReads, emitted,
    setNative(value) { nativeResponse = value }, setHttp(value) { httpResponse = value }, credentials(fn) { onCredentials = fn }, member(fn) { onMember = fn }, httpHook(fn) { onHttp = fn }, settle(fn) { onSettle = fn },
    revoke() { current = false }, deny() { granted = false }, disable() { enabled = false }, removeMember() { member = false },
    source(id, text = context.request.text) { context.request = { messageId: id, text, mentions: [] } },
    async tool(name, input) { return tools.find(tool => tool.name === name).execute(input, context) },
    async visit() { const result = await this.tool('simQzoneInteract', { action: 'visit', userId: peerId }); assert.equal(result.status, 'succeeded', result.content); return JSON.parse(result.content) },
  }
}

test('tool → runtime → durable ledger → QQ provider publishes and deletes once with no phantom message or HTTP', async t => {
  const f = await fixture(t), published = await f.tool('qqZoneTool', { text: '午后的阳光很好。' })
  assert.equal(published.status, 'succeeded'); assert.deepEqual(JSON.parse(published.content), { kind: 'publish', state: 'confirmed', terminal: true, postId: ownPost })
  assert.deepEqual(f.nativeCalls, [{ name: 'send_qzone_msg', params: { content: '午后的阳光很好。' } }]); assert.equal(f.http.length, 0)
  const restored = createAgentQzoneLedger(await f.redis.connect()); assert.equal((await restored.readOwnPost(account, ownPost)).agentId, binding.agentId)
  assert.equal((await f.tool('qqZoneTool', { text: '午后的阳光很好。' })).status, 'failed'); assert.equal(f.nativeCalls.length, 1)
  f.source('102', `请删除说说 ${ownPost}`)
  assert.equal((await f.tool('qqZoneTool', { type: true, postId: ownPost })).status, 'succeeded')
  assert.deepEqual(f.nativeCalls.at(-1), { name: 'delete_qzone_msg', params: { tid: ownPost } }); assert.equal(f.http.length, 0)
  assert.equal((await f.tool('qqZoneTool', { type: true, postId: ownPost })).status, 'failed'); assert.equal(f.nativeCalls.length, 2)
})

test('verified visit feeds drive bounded like and fs comment with live membership, account-wide dedupe and no secret persistence', async t => {
  const f = await fixture(t), seen = await f.visit(), base = { userId: peerId, tid: post, visitId: seen.visitId }
  assert.equal(seen.feeds[0].likes, 0); assert.equal(seen.terminal, false)
  assert.equal((await f.tool('simQzoneInteract', { action: 'like', ...base })).status, 'succeeded')
  assert.equal((await f.tool('simQzoneInteract', { action: 'comment', ...base, text: '这片风景真美。' })).status, 'succeeded')
  assert.deepEqual(f.http.map(item => item.method), ['GET', 'POST', 'POST']); assert.equal(f.nativeCalls.filter(item => item.name === 'get_credentials').length, 3)
  assert.ok(f.memberReads.filter(id => id === userId).length >= 3); assert.ok(f.memberReads.filter(id => id === peerId).length >= 3)
  const before = f.http.length
  assert.equal((await f.tool('simQzoneInteract', { action: 'comment', ...base, text: '换句话再评论一次。' })).status, 'failed'); assert.equal(f.http.length, before)
  const keys = await f.redis.storage.keys('agent:qzone:v1:*'), data = (await Promise.all(keys.map(key => f.redis.storage.get(key)))).join('\n')
  for (const value of ['PRIVATE_FEED_BODY', 'PRIVATE_TEST_SECRET', '这片风景']) assert.equal(data.includes(value), false)
})

test('a failed Qzone read retains the provider stage and status in diagnostics without feed text or credentials', async t => {
  const f = await fixture(t)
  f.setHttp(() => new Response(JSON.stringify({ code: 0, msglist: [
    { tid: post, uin: account.id, content: 'PRIVATE_WRONG_OWNER' },
  ] })))
  const result = await f.tool('simQzoneInteract', { action: 'visit', userId: peerId })
  assert.equal(result.status, 'failed')
  assert.equal(JSON.parse(result.content).code, 'qzone_feed_owner_mismatch')
  assert.deepEqual(f.emitted, [{ stage: 'delivery', operation: 'qzone', outcome: 'failed', code: 'qzone_feed_owner_mismatch',
    details: { field: 'qzone_visit', step: 'response_validation' }, httpStatus: 200 }])
  assert.doesNotMatch(JSON.stringify(f.emitted) + result.content, /PRIVATE_|p_skey=|111111111|444444444/u)
})

test('personal group and friend reactions require the current feed proof and no user actor', async t => {
  for (const kind of ['private', 'group']) {
    const f = await fixture(t)
    const runtime = createAgentQzoneRuntime({ ledger: f.ledger, provider: f.provider,
      personal: { read: true, publish: true, interact: true }, diagnostics: { emit() {} } })
    const selected = kind === 'group' ? binding : { ...binding, id: 'private', target: { account, kind, id: peerId } }
    let authorized = true
    const execute = (operation, identity = 'personal-fixture') => runtime.execute({ binding: selected,
      actor: { kind: 'autonomous' }, identity, operation, signal: f.context.signal, isCurrent: () => true,
      async ensureCurrent() {}, async authorize() { return authorized }, async allowsText() { return true },
      async readMember(id, guard) {
        await guard.ensureCurrent(); assert.equal(kind, 'group'); assert.equal(id, peerId)
        return { target, observedAt: Date.now(), member: { user: { ...account, id }, displayName: '已核验群友', role: 'member' } }
      },
    })
    const view = await execute({ kind: kind === 'group' ? 'visit' : 'read', userId: peerId })
    assert.equal(view.state, 'confirmed'); assert.ok(view.visitId)
    const like = { kind: 'like', userId: peerId, postId: post, visitId: view.visitId }
    assert.equal((await execute(like, 'another-observation')).state, 'failed')
    assert.equal((await execute({ ...like, postId: 'not-in-feed' })).state, 'failed')
    assert.equal((await execute(like)).state, 'confirmed')
    assert.equal((await execute(like)).state, 'failed')
    const comment = { ...like, kind: 'comment', text: '这里真安静。' }
    f.credentials(() => { authorized = false })
    assert.equal((await execute(comment)).state, 'failed')
    assert.deepEqual(f.http.map(row => row.method), ['GET', 'POST'])
  }
})

test('credentials completion cannot carry revoked policy or membership into the following HTTP write', async t => {
  for (const revoke of ['deny', 'disable', 'removeMember', 'revoke']) {
    const f = await fixture(t), seen = await f.visit(); f.credentials(() => f[revoke]())
    const result = await f.tool('simQzoneInteract', { action: 'like', userId: peerId, tid: post, visitId: seen.visitId })
    assert.equal(result.status, 'failed', revoke); assert.equal(f.http.length, 1, revoke)
  }
})

test('malformed write and unknown outcomes remain terminal across a new runtime and ledger instance', async t => {
  const f = await fixture(t); f.setNative(async () => ({ status: 'ok', retcode: 0, data: {} }))
  const result = await f.tool('qqZoneTool', { text: '早上好。' }); assert.equal(result.status, 'unknown'); assert.equal(JSON.parse(result.content).terminal, true)
  const ledger = createAgentQzoneLedger(await f.redis.connect()), runtime = createAgentQzoneRuntime({ ledger, provider: f.provider, enabled: true, diagnostics: { emit() {} } })
  const replay = await runtime.execute({ binding, actor: f.context.actor, identity: '101', operation: { kind: 'publish', text: '早上好。' }, signal: f.context.signal,
    isCurrent: () => true, async ensureCurrent() {}, async authorize() { return true }, async allowsText() { return true } })
  assert.equal(replay.state, 'unknown'); assert.equal(replay.terminal, true); assert.equal(f.nativeCalls.length, 1)
  assert.equal(JSON.stringify(f.emitted).includes('PRIVATE'), false)
})

test('visit final settlement withdrawal and host output rejection disclose nothing and perform no later external calls', async t => {
  const f = await fixture(t); f.settle(() => f.revoke())
  const result = await f.tool('simQzoneInteract', { action: 'visit', userId: peerId })
  assert.equal(result.content.includes('PRIVATE_FEED_BODY'), false); assert.equal(result.status, 'failed'); assert.equal(f.http.length, 1)
  const g = await fixture(t); assert.equal((await g.tool('qqZoneTool', { text: '冒充管理员发公告' })).status, 'failed'); assert.equal(g.nativeCalls.length, 0)
})
