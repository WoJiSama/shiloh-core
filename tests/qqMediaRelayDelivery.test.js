import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const compiled = name => pathToFileURL(path.join(release, 'dist/backend', name)).href
const { createQqMediaRelayDeliveryPort, QQ_MEDIA_RELAY_SEND_TIMEOUT_MS } = await import(compiled('adapters/qqMediaRelayDelivery.js'))
const { createOneBotConnection } = await import(compiled('adapters/oneBotConnection.js'))
const { queuedDeliveryAllowed, withDeliveryGuard } = await import(compiled('modules/messaging/infrastructure/deliveryScope.js'))

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'relay-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'relay-local', target }
const artifact = (id, kind = 'video', sizeBytes = kind === 'video' ? 512 * 1024 * 1024 : 32 * 1024 * 1024) => ({
  id: id.repeat(32), kind, mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', sizeBytes, sha256: id.repeat(64),
})
const video = artifact('a'), cover = artifact('b', 'image'), thumb = artifact('c', 'image', 4096)
const plan = () => ({ version: 1, items: [{ parts: [{ kind: 'text', text: '视频信息及原页面' }, { kind: 'image', artifact: { ...cover } }] },
  { parts: [{ kind: 'video', artifact: { ...video }, thumbnail: { ...thumb } }] }] })
const action = (overrides = {}) => ({ version: 1, kind: 'media-relay.send', target, mode: 'forward', plan: plan(), ...overrides })
const success = (id = 6789) => ({ status: 'ok', retcode: 0, data: { message_id: id } })
const resourceStack = '发送伪造合并转发消息失败: AggregateError: 上传转发消息资源失败：1/3\n' +
  '    at iY (file:///app/napcat.mjs:32695:11)\n' +
  '    at async oY.UploadResources (file:///app/napcat.mjs:32745:5)\n' +
  '    at async Promise.all (index 0)\n' +
  '    at async oY.UploadForwardMsgV2 (file:///app/napcat.mjs:32822:5)'
const resourceError = (message = resourceStack) => ({ status: 'failed', retcode: 1200, data: null, message, wording: message })
async function waitFor(probe) {
  const until = Date.now() + 2000
  while (Date.now() < until) { if (await probe()) return; await delay(5) }
  assert.fail('Timed out waiting for media relay fixture')
}
function bridgeFixture(stage) {
  const staged = [], released = [], contexts = []
  const bridge = { async stage(value, context) {
    staged.push(value); contexts.push(context)
    if (stage) return stage(value, context, staged.length)
    return { nativeUrl: `http://127.0.0.1:4242/resource/${value.id}`, async release() { released.push(value.id) } }
  }, async close() {} }
  return { bridge, staged, released, contexts }
}
function direct(response = success(), options = {}) {
  const calls = [], b = options.fixture || bridgeFixture()
  const sendMediaRelay = createQqMediaRelayDeliveryPort({ account, connectionId: 'relay-local', bridge: b.bridge,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.allowsText ? { allowsText: options.allowsText } : {}),
    ...(options.account ? { account: options.account } : {}), async sendApi(action, params, scope) {
      calls.push({ action, params, scope })
      return typeof response === 'function' ? response(action, params, scope) : response
    },
  })
  return { ...b, calls, sendMediaRelay }
}

test('512 MiB opaque video and 32 MiB cover preserve all native forward nodes and stage before one dispatch', async () => {
  const d = direct((_action, _params, scope) => {
    assert.equal(d.staged.length, 3)
    assert.equal(scope.isCurrent(), true)
    assert.equal(queuedDeliveryAllowed(), true)
    assert.equal(scope.timeoutMs, 90 * 60 * 1000)
    return success()
  })
  assert.deepEqual(await d.sendMediaRelay(action({ binding })), { state: 'sent', messageId: '6789' })
  assert.equal(d.calls.length, 1)
  const sent = d.calls[0]
  assert.equal(sent.action, 'send_group_forward_msg')
  assert.deepEqual(sent.params, { group_id: target.id, messages: [
    { type: 'node', data: { name: 'Agent', uin: account.id, content: [
      { type: 'text', data: { text: '视频信息及原页面' } }, { type: 'image', data: { file: `http://127.0.0.1:4242/resource/${cover.id}` } },
    ] } },
    { type: 'node', data: { name: 'Agent', uin: account.id, content: [
      { type: 'video', data: { file: `http://127.0.0.1:4242/resource/${video.id}`, thumb: `http://127.0.0.1:4242/resource/${thumb.id}` } },
    ] } },
  ] })
  assert.equal(d.staged.find(row => row.id === video.id).sizeBytes, 512 * 1024 * 1024)
  assert.equal(Object.isFrozen(sent.params.messages[1].data.content[0].data), true)
  assert.equal(JSON.stringify(sent.params).includes('base64'), false)
  assert.equal(d.released.length, 3)
  assert.ok(d.contexts.every(context => context.signal.aborted && !context.isCurrent()))
})

test('private forward has one fixed private peer and bot authors; direct-video sends multiple videos once without text or fallback', async () => {
  const address = { ...target, kind: 'private' }, d = direct()
  assert.equal((await d.sendMediaRelay(action({ target: address, binding: { ...binding, target: address } }))).state, 'sent')
  assert.equal(d.calls[0].action, 'send_private_forward_msg')
  assert.equal(d.calls[0].params.user_id, target.id)
  const v = { kind: 'video', artifact: video, thumbnail: thumb }
  assert.equal((await d.sendMediaRelay(action({ target: address, mode: 'direct-video', plan: { version: 1, items: [{ parts: [v] }, { parts: [v] }] } }))).state, 'sent')
  assert.equal(d.calls[1].action, 'send_private_msg')
  assert.equal(d.calls[1].params.message.length, 2)
  assert.ok(d.calls[1].params.message.every(part => part.type === 'video'))
  assert.equal(d.staged.length, 5, 'repeated video and thumbnail stage only once per invocation')
})

test('distinct IDs are staged once in first-use order across repeated cover, thumbnail and video references', async () => {
  const d = direct(), v = { kind: 'video', artifact: video, thumbnail: cover }
  const input = action({ plan: { version: 1, items: [{ parts: [{ kind: 'image', artifact: cover }, v, v] }] } })
  assert.equal((await d.sendMediaRelay(input)).state, 'sent')
  assert.deepEqual(d.staged.map(row => row.id), [cover.id, video.id])
  assert.deepEqual(d.released, [cover.id, video.id])
})

test('missing video thumbnail and direct-video mixed content reject before staging or native dispatch', async () => {
  const d = direct()
  assert.deepEqual(await d.sendMediaRelay(action({ plan: { version: 1, items: [{ parts: [{ kind: 'video', artifact: video }] }] } })), { state: 'failed', code: 'video_thumbnail_missing' })
  assert.deepEqual(await d.sendMediaRelay(action({ mode: 'direct-video' })), { state: 'failed', code: 'invalid_direct_video' })
  assert.equal(d.staged.length, 0); assert.equal(d.calls.length, 0)
})

test('closed plan rejects URLs, local paths, credentials, getter fields, conflicting opaque metadata and invalid MIME/limits', async () => {
  const d = direct(); let accessed = 0
  const getter = { ...video }; Object.defineProperty(getter, 'id', { get() { accessed++; throw Error('secret path') } })
  for (const invalid of [getter, { ...video, path: '/private/secret' }, { ...video, url: 'https://provider.example/secret' },
    { ...video, cookie: 'SESSDATA=secret' }, { ...video, mime: 'image/jpeg' }, { ...video, sizeBytes: video.sizeBytes + 1 },
    { ...video, sha256: 'bad' }, { ...video, id: 'file:///private' }, { ...video, kind: 'audio' },
  ]) {
    assert.equal((await d.sendMediaRelay(action({ plan: { version: 1, items: [{ parts: [{ kind: 'video', artifact: invalid, thumbnail: thumb }] }] } }))).state, 'failed')
  }
  for (const invalidPlan of [{ ...plan(), target }, { ...plan(), [Symbol('secret')]: 1 },
    { version: 1, items: [{ parts: [{ kind: 'image', artifact: cover }, { kind: 'image', artifact: { ...cover, sizeBytes: 1024 } }] }] },
    { version: 1, items: [{ parts: [{ kind: 'image', artifact: { ...cover, mime: 'video/mp4' } }] }] },
    { version: 1, items: [{ parts: [{ kind: 'text', text: 'text', user_id: account.id }] }] },
  ]) assert.equal((await d.sendMediaRelay(action({ plan: invalidPlan }))).state, 'failed')
  assert.equal(accessed, 0); assert.equal(d.staged.length, 0); assert.equal(d.calls.length, 0)
})

test('fixed global QQ account, canonical target and complete optional binding reject cross-account/namespace/connection routing', async () => {
  const d = direct()
  for (const address of [{ ...target, account: { ...account, id: '999999' } }, { ...target, account: { ...account, namespace: 'tenant' } },
    { ...target, account: { ...account, platform: 'telegram' } }, { ...target, account: { ...account, id: 123456789 } },
    { ...target, kind: 'channel' }, { ...target, id: '0315320' }, { ...target, id: 315320 }, { ...target, extra: true },
  ]) assert.equal((await d.sendMediaRelay(action({ target: address }))).state, 'failed')
  for (const bound of [{ ...binding, connectionId: 'other' }, { ...binding, agentId: '' }, { ...binding, source: 'untrusted' },
    { ...binding, target: { ...target, id: '999999' } }, { ...binding, revision: 'r1\nsecret' }, { ...binding, extra: 'secret' },
  ]) assert.equal((await d.sendMediaRelay(action({ binding: bound }))).state, 'failed')
  assert.equal(d.staged.length, 0); assert.equal(d.calls.length, 0)
})

test('successful receipts require exact numeric zero and genuine native integer IDs and matching target evidence', async () => {
  for (const response of [null, {}, { status: 'ok', retcode: 0 }, success(null), success(0), success(''), success('0007'),
    success('file-uuid'), success('echo-request-id'), success(Number.MAX_SAFE_INTEGER + 1), success('17\n'),
    { ...success(), retcode: '0' }, { ...success(), self_id: '999999' }, { ...success(), group_id: '999999' },
    { ...success(), user_id: target.id }, { ...success(), data: { message_id: 17, self_id: '999999' } },
  ]) {
    const d = direct(response)
    assert.deepEqual(await d.sendMediaRelay(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1); assert.equal(d.released.length, 3)
  }
  for (const id of [-42, '-42', '42']) assert.deepEqual(await direct(success(id)).sendMediaRelay(action()), { state: 'sent', messageId: String(id) })
})

test('schema failures and transport pre-dispatch markers remain failed while ordinary handler/transport failures are unknown', async () => {
  for (const retcode of [400, 1400]) {
    assert.deepEqual(await direct({ status: 'failed', retcode }).sendMediaRelay(action()), { state: 'failed', code: String(retcode) })
  }
  for (const retcode of [200, 1200, 500, 1]) {
    const d = direct({ status: 'failed', retcode, message: 'possibly sent', wording: 'possibly sent', data: null })
    assert.deepEqual(await d.sendMediaRelay(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
  }
  assert.deepEqual(await direct({ state: 'failed', code: 'onebot_disconnected' }).sendMediaRelay(action()), { state: 'failed', code: 'onebot_disconnected' })
  assert.deepEqual(await direct(() => { throw Error('http://secret/private-path') }).sendMediaRelay(action()), { state: 'unknown' })
})

test('only inspected NapCat packet resource AggregateError proves final forward was not sent', async () => {
  const d = direct(resourceError())
  assert.deepEqual(await d.sendMediaRelay(action()), { state: 'failed', code: 'media_resource_preprocessing_failed' })
  assert.equal(d.calls.length, 1, 'the port never retries or sends fallback text/video')
  assert.equal(d.released.length, 3)
  const v = { kind: 'video', artifact: video, thumbnail: thumb }
  assert.deepEqual(await direct(resourceError()).sendMediaRelay(action({ mode: 'direct-video', plan: { version: 1, items: [{ parts: [v] }] } })), { state: 'unknown' })
  assert.deepEqual(await direct(resourceError()).sendMediaRelay(action({ plan: { version: 1, items: [{ parts: [{ kind: 'text', text: 'only text' }] }] } })), { state: 'unknown' })
  for (const response of [resourceError(resourceStack.replace('1/3', '4/3')), resourceError(resourceStack.replace('1/3', '0/3')),
    resourceError(resourceStack.replace('1/3', '1/513')), resourceError(resourceStack.replace('伪造', '')),
    resourceError(resourceStack.split('\n')[0]), resourceError(resourceStack + '\ncaused by send succeeded'),
    resourceError('nested error: ' + resourceStack), resourceError('[Highway] 视频文件过大: 512.00 MB > 100 MB，请使用文件上传！'),
    resourceError(resourceStack.replace('    at iY', '    at spoof\n    at iY')),
    { ...resourceError(), wording: 'different' }, { ...resourceError(), data: {} }, { ...resourceError(), retcode: 200 },
  ]) assert.deepEqual(await direct(response).sendMediaRelay(action()), { state: 'unknown' })
})

test('preparation failure releases already staged resources and exposes no source URL/path/error', async () => {
  const released = [], f = bridgeFixture(async (value, _context, index) => {
    if (index === 2) throw Error('/private/secret Cookie=secret https://signed.example/a?token=secret')
    return { nativeUrl: 'http://127.0.0.1:4242/opaque', async release() { released.push(value.id) } }
  })
  const d = direct(success(), { fixture: f })
  assert.deepEqual(await d.sendMediaRelay(action()), { state: 'failed', code: 'media_relay_preparation_failed' })
  assert.equal(d.calls.length, 0); assert.deepEqual(released, [cover.id])
})

test('pre-dispatch cancellation sends nothing and timeout override cannot extend the finite 90 minute ceiling', async () => {
  const d = direct(), controller = new AbortController(); controller.abort()
  assert.equal((await d.sendMediaRelay(action(), { signal: controller.signal })).state, 'failed')
  assert.equal((await d.sendMediaRelay(action(), { isCurrent: () => false })).state, 'failed')
  assert.equal(d.staged.length, 0); assert.equal(d.calls.length, 0)
  assert.equal(QQ_MEDIA_RELAY_SEND_TIMEOUT_MS, 5400000)
  for (const timeoutMs of [0, -1, Infinity, 5400001]) assert.throws(() => createQqMediaRelayDeliveryPort({ account, bridge: d.bridge, timeoutMs, async sendApi() { return success() } }))
})

test('Proxy AbortSignal composition and throwing guard getters return bounded failures without exposing raw secrets', async () => {
  const d = direct(), secret = '/private/secret Cookie=raw-secret https://signed.example/?token=secret'
  const signal = new Proxy(new AbortController().signal, { get() { throw Error(secret) } })
  assert.equal(signal instanceof AbortSignal, true)
  assert.deepEqual(await d.sendMediaRelay(action(), { signal }), { state: 'failed', code: 'invalid_media_relay_guard' })
  for (const key of ['signal', 'isCurrent']) {
    const guard = {}; Object.defineProperty(guard, key, { get() { throw Error(secret) } })
    const result = await d.sendMediaRelay(action(), guard)
    assert.equal(result.state, 'failed'); assert.equal(JSON.stringify(result).includes('secret'), false)
  }
  assert.equal(d.staged.length, 0); assert.equal(d.calls.length, 0)
})

test('uncooperative native send reaches shortened deadline as unknown and releases every staged lease', { timeout: 2000 }, async () => {
  const d = direct(() => new Promise(() => {}), { timeoutMs: 60 }), started = Date.now()
  assert.deepEqual(await d.sendMediaRelay(action()), { state: 'unknown' })
  assert.ok(Date.now() - started >= 50)
  assert.equal(d.calls.length, 1); assert.equal(d.calls[0].scope.timeoutMs, 60)
  assert.equal(d.calls[0].scope.signal.aborted, true); assert.equal(d.released.length, 3)
})

for (const reason of ['signal', 'guard', 'target', 'binding', 'account', 'text-policy']) {
  test(`dispatched relay losing ${reason} stops as unknown, revokes HTTP context and ignores late success`, async () => {
    let finish, current = true, textAllowed = true
    const ownAccount = { ...account }, ownTarget = { ...target, account: ownAccount }, ownBinding = { ...binding, target: ownTarget }
    const controller = new AbortController(), d = direct(() => new Promise(resolve => { finish = resolve }), { account: ownAccount, allowsText: () => textAllowed })
    const pending = d.sendMediaRelay(action({ target: ownTarget, binding: ownBinding }), { signal: controller.signal, isCurrent: () => current })
    await waitFor(() => finish)
    if (reason === 'signal') controller.abort()
    else if (reason === 'guard') current = false
    else if (reason === 'target') ownTarget.id = '999999'
    else if (reason === 'binding') ownBinding.revision = 'r2'
    else if (reason === 'account') ownAccount.id = '999999'
    else textAllowed = false
    assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
    assert.ok(d.contexts.every(context => context.signal.aborted && !context.isCurrent()))
    assert.equal(d.released.length, 3)
    finish(success(9999)); await delay(5); assert.equal(d.calls.length, 1)
  })
}

test('dynamic text rule revokes queued/preparing sends and plan content is an immutable entry snapshot', async () => {
  let firstDone, textAllowed = true
  const d = direct((_action, _params) => new Promise(resolve => { firstDone = resolve }), { allowsText: () => textAllowed })
  const first = d.sendMediaRelay(action())
  await waitFor(() => firstDone)
  const input = action(), queued = d.sendMediaRelay(input)
  input.plan.items[0].parts[0].text = 'mutated text must never be sent'
  textAllowed = false
  assert.equal((await queued).state, 'failed')
  assert.deepEqual(await first, { state: 'unknown' })
  firstDone(success()); assert.equal(d.calls.length, 1)

  let releaseStage
  const f = bridgeFixture(async value => {
    if (!releaseStage) await new Promise(resolve => { releaseStage = resolve })
    return { nativeUrl: `http://127.0.0.1:4242/${value.id}`, async release() {} }
  })
  const owned = action(), captured = direct(success(), { fixture: f }), pending = captured.sendMediaRelay(owned)
  await waitFor(() => releaseStage)
  owned.plan.items[0].parts[0].text = 'replacement'; owned.plan.items[0].parts[1].artifact.id = 'd'.repeat(32)
  releaseStage()
  assert.equal((await pending).state, 'sent')
  assert.equal(captured.calls[0].params.messages[0].data.content[0].data.text, '视频信息及原页面')
  assert.equal(captured.staged[0].id, cover.id)
})

test('one native upload per connection and at most four waiting calls; cancelled queued work frees its slot', async () => {
  let finish
  const d = direct(() => new Promise(resolve => { finish = resolve }))
  const first = d.sendMediaRelay(action()); await waitFor(() => finish)
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const pending = controllers.map(controller => d.sendMediaRelay(action(), { signal: controller.signal }))
  assert.deepEqual(await d.sendMediaRelay(action()), { state: 'failed', code: 'media_relay_busy' })
  assert.equal(d.calls.length, 1); assert.equal(d.staged.length, 3)
  controllers[0].abort(); assert.equal((await pending[0]).state, 'failed')
  const extra = new AbortController(), replacement = d.sendMediaRelay(action(), { signal: extra.signal })
  for (const controller of controllers.slice(1)) controller.abort()
  extra.abort()
  assert.ok((await Promise.all(pending.slice(1))).every(value => value.state === 'failed'))
  assert.equal((await replacement).state, 'failed')
  finish(success()); assert.equal((await first).state, 'sent')
  assert.equal(d.calls.length, 1); assert.equal(d.staged.length, 3)
})

test('cancelled uncooperative preparation releases late lease without native dispatch or unhandled secret error', async () => {
  let finish, released = 0
  const f = bridgeFixture(() => new Promise(resolve => { finish = resolve })), controller = new AbortController(), d = direct(success(), { fixture: f })
  const pending = d.sendMediaRelay(action(), { signal: controller.signal })
  await waitFor(() => finish); controller.abort()
  assert.equal((await pending).state, 'failed'); assert.equal(d.calls.length, 0)
  finish({ nativeUrl: 'http://127.0.0.1:4242/late-secret', async release() { released++; throw Error('/private/secret') } })
  await waitFor(() => released === 1)
  assert.equal(d.calls.length, 0)
})

test('each queued relay retains its caller authorization without inheriting the previous revoked delivery scope', async () => {
  let firstDone, firstCurrent = true, secondCurrent = true
  const d = direct((_action, _params, scope) => {
    assert.equal(scope.isCurrent(), true); assert.equal(queuedDeliveryAllowed(), true)
    return d.calls.length === 1 ? new Promise(resolve => { firstDone = resolve }) : success(7777)
  })
  const first = withDeliveryGuard(() => firstCurrent, () => d.sendMediaRelay(action()))
  await waitFor(() => firstDone)
  const second = withDeliveryGuard(() => secondCurrent, () => d.sendMediaRelay(action()))
  firstCurrent = false
  assert.deepEqual(await first, { state: 'unknown' })
  assert.deepEqual(await second, { state: 'sent', messageId: '7777' })
  assert.equal(d.calls.length, 2); assert.equal(d.released.length, 6)
  firstDone(success())
})

test('a captured caller delivery scope revokes bridge context even when evaluated outside its async scope', async () => {
  let finish, current = true
  const d = direct(() => new Promise(resolve => { finish = resolve }))
  const pending = withDeliveryGuard(() => current, () => d.sendMediaRelay(action()))
  await waitFor(() => finish)
  current = false
  assert.equal(d.contexts[0].isCurrent(), false)
  assert.deepEqual(await pending, { state: 'unknown' })
  assert.equal(d.released.length, 3); finish(success())
})

test('release failures never replace native receipt or skip remaining resource cleanup', async () => {
  const releases = [], f = bridgeFixture(async value => ({ nativeUrl: `http://127.0.0.1:4242/${value.id}`, async release() {
    releases.push(value.id); throw Error('/private/secret')
  } })), d = direct(success(), { fixture: f })
  assert.deepEqual(await d.sendMediaRelay(action()), { state: 'sent', messageId: '6789' })
  assert.equal(releases.length, 3)
})

test('OneBot keeps media relay capability absent by default and exposes it only for a supplied bridge', async () => {
  const options = { connection: { id: 'relay-local', account }, url: 'ws://127.0.0.1:31415',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {}, }
  const plain = createOneBotConnection(options), d = direct(), configured = createOneBotConnection({ ...options, mediaRelay: { bridge: d.bridge } })
  try {
    assert.equal(Object.hasOwn(plain.actions, 'sendMediaRelay'), false)
    assert.equal(typeof configured.actions.sendMediaRelay, 'function')
    assert.deepEqual(await configured.actions.sendMediaRelay(action()), { state: 'failed', code: 'onebot_disconnected' })
    assert.equal(d.staged.length, 0)
  } finally { plain.stop(); configured.stop() }
})
