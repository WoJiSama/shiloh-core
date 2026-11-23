import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const user = { platform: 'qq', namespace: 'global', id: '324152' }
const token = 'local-member-test-token'
const member = { group_id: Number(target.id), user_id: Number(user.id), card: '小林', nickname: '林', role: 'admin' }
const options = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const response = (data, extra = {}) => ({ status: 'ok', retcode: 0, data, ...extra })
function reply(peer, request, result) { peer.send(JSON.stringify({ ...result, echo: request.echo })) }

async function waitFor(probe, description, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, { transport = 'forward-websocket', holdLogin = false, onApiFailure, alertOwner } = {}) {
  const server = createServer((_request, outgoing) => outgoing.writeHead(404).end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}/onebot`
  const reverse = transport === 'reverse-websocket'
  const sockets = reverse ? undefined : new WebSocketServer({ noServer: true })
  const peers = [], requests = [], errors = []
  let currentPeer, handler = request => response(request.action === 'get_group_member_list' ? [member] : member)
  let disconnected = 0, reconnected = 0, fatal = 0
  const attach = peer => {
    currentPeer = peer
    peers.push(peer)
    peer.on('error', () => {})
    peer.on('message', frame => {
      try {
        const request = JSON.parse(String(frame))
        requests.push({ peer, ...request })
        if (request.action === 'get_login_info') {
          if (!holdLogin) reply(peer, request, response({ user_id: account.id, nickname: '可信成员测试' }))
          return
        }
        const result = handler(request, peer)
        if (result !== undefined) reply(peer, request, result)
      } catch (error) { errors.push(error) }
    })
  }
  if (reverse) await new Promise(resolve => server.close(resolve))
  else {
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return }
      sockets.handleUpgrade(request, socket, head, attach)
    })
  }
  const adapter = createOneBotConnection({ connection: { id: 'members-fixture', account: { ...account } }, url, transport, accessToken: token,
    onDisconnect() { disconnected++ }, onReconnect() { reconnected++ }, onError() { fatal++ }, onEventError(error) { errors.push(error) },
    onApiFailure, alertOwner,
  })
  t.after(async () => {
    adapter.stop()
    for (const peer of peers) peer.terminate()
    if (sockets) await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    assert.deepEqual(errors, [])
  })
  async function connectPeer() {
    if (!reverse) return
    await waitFor(async () => {
      const peer = new WebSocket(url, { handshakeTimeout: 500, headers: {
        Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal',
      } })
      attach(peer)
      try { await once(peer, 'open'); return true }
      catch { peer.terminate(); return false }
    }, 'reverse listener')
  }
  const started = adapter.start(async () => {})
  void started.catch(() => {})
  await connectPeer()
  await waitFor(() => requests.find(row => row.action === 'get_login_info'), 'login request')
  if (!holdLogin) await started
  return {
    adapter, started, requests, connectPeer,
    setHandler(value) { handler = value },
    peer: () => currentPeer,
    memberRequests: () => requests.filter(row => row.action.startsWith('get_group_member_')),
    status: () => ({ disconnected, reconnected, fatal }),
  }
}

test('OneBot reports native rejection and unknown timeout without leaking API parameters or responses', { timeout: 10000 }, async t => {
  const events = [], traces = new AsyncLocalStorage()
  const f = await fixture(t, { onApiFailure: (...event) => events.push([traces.getStore(), ...event]) })
  f.setHandler(() => ({ status: 'failed', retcode: 123, wording: 'private_response' }))
  assert.equal(await traces.run('read', () => f.adapter.readConversationMember(target, user, options())), undefined)
  f.setHandler(() => undefined)
  for (const [index, reason] of ['TimeoutError', 'AbortError'].entries()) {
    const controller = new AbortController()
    const pending = traces.run('list', () => f.adapter.listConversationMembers(target, options({ signal: controller.signal })))
    await waitFor(() => f.memberRequests().length === index + 2, 'pending member list')
    controller.abort(new DOMException('private_error', reason))
    assert.equal(await pending, undefined)
  }
  assert.deepEqual(events, [
    ['read', 'get_group_member_info', 'failed', 'onebot_rejected', { dispatched: true, nativeCode: 123 }],
    ['list', 'get_group_member_list', 'unknown', 'onebot_timeout', { dispatched: true, result: 'confirmation_pending' }],
  ])
})

test('owner alerts verify friendship and send plain text to the fixed private recipient', async t => {
  const faults = []
  const f = await fixture(t, { alertOwner: user, onApiFailure: (...row) => faults.push(row) })
  f.setHandler(() => response([{ user_id: 111111 }]))
  assert.deepEqual(await f.adapter.sendOwnerAlert('告警', options()), { state: 'failed', code: 'owner_friend_unconfirmed' })
  assert.equal(f.requests.filter(row => row.action === 'send_private_msg').length, 0)

  let current = true
  f.setHandler(() => { current = false; return response([{ user_id: user.id }]) })
  assert.equal((await f.adapter.sendOwnerAlert('告警', options({ isCurrent: () => current }))).state, 'failed')
  assert.equal(f.requests.filter(row => row.action === 'send_private_msg').length, 0)

  f.setHandler(({ action }) => action === 'get_friend_list' ? response([{ user_id: user.id }]) : response({ message_id: 99 }))
  assert.deepEqual(await f.adapter.sendOwnerAlert('告警', options()), { state: 'sent', messageId: '99' })
  assert.deepEqual(f.requests.filter(row => row.action === 'send_private_msg').map(row => row.params), [
    { user_id: Number(user.id), message: [{ type: 'text', data: { text: '告警' } }] },
  ])
  f.setHandler(({ action }) => action === 'get_friend_list' ? response([{ user_id: user.id }]) : { status: 'failed', retcode: 1200 })
  assert.deepEqual(await f.adapter.sendOwnerAlert('告警', options()), { state: 'unknown' })
  assert.deepEqual(faults, [], 'failures from the alert transport cannot create recursive alerts')
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} shutdown lets queued owner alerts finish on the verified socket`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport, alertOwner: user })
    f.setHandler(({ action }) => action === 'get_friend_list' ? response([{ user_id: user.id }]) : undefined)
    const ordinary = f.adapter.readConversationMember(target, user, options())
    const inFlight = f.adapter.sendOwnerAlert('退出前的告警', options())
    await waitFor(() => f.requests.some(row => row.action === 'send_private_msg') && f.memberRequests().length === 1, 'pending calls')
    const finish = f.adapter.beginOwnerAlertDrain()
    assert.equal(typeof finish, 'function')
    try {
      f.adapter.stop()
      assert.equal(f.adapter.isReady(), false)
      assert.equal(await ordinary, undefined)
      assert.equal(await f.adapter.readConversationMember(target, user, options()), undefined)
      await assert.rejects(f.adapter.start(), /正在退出/)
      const first = f.requests.find(row => row.action === 'send_private_msg')
      reply(f.peer(), first, response({ message_id: 80 }))
      assert.deepEqual(await inFlight, { state: 'sent', messageId: '80' })
      f.setHandler(({ action }) => action === 'get_friend_list' ? response([{ user_id: user.id }]) : response({ message_id: 81 }))
      assert.deepEqual(await f.adapter.sendOwnerAlert('待发送的告警', options()), { state: 'sent', messageId: '81' })
      const disconnected = once(f.peer(), 'close')
      finish()
      await disconnected
      assert.deepEqual(await f.adapter.sendOwnerAlert('新告警', options()), { state: 'failed', code: 'owner_alert_unavailable' })
    } finally { finish() }
  })

  test(`${transport} reads fresh scoped member evidence and a complete member list over real WebSocket`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    const began = Date.now()
    const found = await f.adapter.readConversationMember(target, user, options())
    assert.deepEqual(found.target, target)
    assert.ok(found.observedAt >= began && found.observedAt <= Date.now())
    assert.deepEqual(found.member, { user, displayName: '小林', role: 'admin', profile: { nickname: '林', conversationName: '小林' } })
    f.setHandler(() => response([member, { ...member }, { group_id: target.id, user_id: '324153', nickname: '小吴', role: 'member' }]))
    const listed = await f.adapter.listConversationMembers(target, options())
    assert.deepEqual(listed.target, target)
    assert.equal(listed.complete, true)
    assert.equal(listed.members.length, 2, 'identical duplicate rows are deduplicated')
    assert.deepEqual(listed.members[1], { user: { ...user, id: '324153' }, displayName: '小吴', role: 'member', profile: { nickname: '小吴' } })
    assert.notEqual(found.target, target)
    assert.notEqual(found.target.account, account)
    assert.deepEqual(f.memberRequests().map(({ action, params }) => ({ action, params })), [
      { action: 'get_group_member_info', params: { group_id: target.id, user_id: user.id, no_cache: true } },
      { action: 'get_group_member_list', params: { group_id: target.id } },
    ])
  })

  test(`${transport} maps frozen bounded member details while complete lists expose only exact names`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    const profileRow = { ...member, nickname: ' 林 ', card: ' 小林 ', title: '管理员头衔', level: 0,
      join_time: 1_600_000_000, last_sent_time: 1_700_000_000, shut_up_timestamp: 1_800_000_000,
      sex: 'female', age: 28, area: '上海', unexpected_private_field: 'must-not-escape' }
    f.setHandler(request => response(request.action === 'get_group_member_list' ? [profileRow, { ...profileRow }] : profileRow))
    const found = await f.adapter.readConversationMember(target, user, options())
    assert.equal(found.member.displayName, '小林')
    assert.deepEqual(found.member.profile, { nickname: ' 林 ', conversationName: ' 小林 ', title: '管理员头衔', level: '0',
      joinedAt: 1_600_000_000_000, lastSpokeAt: 1_700_000_000_000, mutedUntil: 1_800_000_000_000,
      gender: 'female', age: 28, region: '上海' })
    assert.equal(Object.isFrozen(found.member), true)
    assert.equal(Object.isFrozen(found.member.user), true)
    assert.equal(Object.isFrozen(found.member.profile), true)
    assert.throws(() => { found.member.profile.nickname = 'mutation' }, TypeError)
    assert.throws(() => { found.member.profile.age = 99 }, TypeError)
    const listed = await f.adapter.listConversationMembers(target, options())
    assert.equal(listed.members.length, 1)
    assert.deepEqual(listed.members[0].profile, { nickname: ' 林 ', conversationName: ' 小林 ' })
    assert.equal(Object.isFrozen(listed.members), true)
    assert.equal(Object.isFrozen(listed.members[0].profile), true)
    assert.doesNotMatch(JSON.stringify(listed.members), /管理员头衔|joinedAt|lastSpokeAt|mutedUntil|gender|age|region|上海|must-not-escape/u)
  })

  test(`${transport} cancels pending member reads on abort and ignores their late responses`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    f.setHandler(() => undefined)
    for (const kind of ['member', 'list']) {
      const controller = new AbortController()
      const before = f.memberRequests().length
      const pending = kind === 'member'
        ? f.adapter.readConversationMember(target, user, options({ signal: controller.signal }))
        : f.adapter.listConversationMembers(target, options({ signal: controller.signal }))
      const request = await waitFor(() => f.memberRequests()[before], 'pending member request')
      controller.abort()
      assert.equal(await pending, undefined)
      reply(f.peer(), request, response(kind === 'member' ? member : [member]))
      await delay(20)
      assert.equal(f.memberRequests().length, before + 1, 'cancelled reads are never retried')
    }
    f.setHandler(() => response(member))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.role, 'admin')
    assert.equal(f.adapter.isReady(), true)
  })

  test(`${transport} stop settles pending lookups and blocks further reads`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    f.setHandler(() => undefined)
    const pending = f.adapter.listConversationMembers(target, options())
    await waitFor(() => f.memberRequests().length === 1, 'pending list before stop')
    f.adapter.stop()
    assert.equal(await pending, undefined)
    assert.equal(await f.adapter.readConversationMember(target, user, options()), undefined)
    assert.equal(await f.adapter.listConversationMembers(target, options()), undefined)
    assert.equal(f.memberRequests().length, 1)
  })

  test(`${transport} reconnect retires old member requests and requires a newly verified socket`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { transport })
    f.setHandler(() => undefined)
    const pending = f.adapter.readConversationMember(target, user, options())
    const oldRequest = await waitFor(() => f.memberRequests()[0], 'pending member before disconnect')
    f.peer().terminate()
    assert.equal(await pending, undefined)
    await waitFor(() => f.status().disconnected === 1, 'retired socket')
    assert.equal(await f.adapter.listConversationMembers(target, options()), undefined)
    await f.connectPeer()
    await waitFor(() => f.adapter.isReady() && f.status().reconnected === 1, 'reverified member connection')
    assert.equal(f.requests.filter(row => row.action === 'get_login_info').length, 2)
    let settled = false
    const next = f.adapter.readConversationMember(target, user, options()).then(value => { settled = true; return value })
    const nextRequest = await waitFor(() => f.memberRequests()[1], 'new member request')
    reply(f.peer(), oldRequest, response({ ...member, role: 'owner' }))
    await delay(20)
    assert.equal(settled, false, 'a response for a retired echo grants no current authority')
    reply(f.peer(), nextRequest, response(member))
    assert.equal((await next).member.role, 'admin')
    assert.equal(f.memberRequests().length, 2)
    assert.equal(f.status().fatal, 0)
  })
}

test('member queries require login, canonical QQ group/user scope, a signal and current authority before dispatch', { timeout: 10000 }, async t => {
  const f = await fixture(t, { holdLogin: true })
  assert.equal(await f.adapter.readConversationMember(target, user, options()), undefined)
  assert.equal(await f.adapter.listConversationMembers(target, options()), undefined)
  const login = f.requests.find(row => row.action === 'get_login_info')
  reply(f.peer(), login, response({ user_id: account.id }))
  await f.started
  for (const candidate of [null, { ...target, kind: 'private' }, { ...target, kind: 'channel' },
    { ...target, id: '0315320' }, { ...target, id: 315320 }, { ...target, account: { ...account, id: '123456780' } },
    { ...target, account: { ...account, platform: 'other' } }, { ...target, account: { ...account, namespace: 'other' } },
  ]) {
    assert.equal(await f.adapter.readConversationMember(candidate, user, options()), undefined)
    assert.equal(await f.adapter.listConversationMembers(candidate, options()), undefined)
  }
  for (const candidate of [null, { ...user, id: '0324152' }, { ...user, id: ' 324152' },
    { ...user, platform: 'other' }, { ...user, namespace: 'other' }, { ...user, id: 324152 },
  ]) assert.equal(await f.adapter.readConversationMember(target, candidate, options()), undefined)
  for (const guard of [undefined, {}, { signal: AbortSignal.abort() }, options({ isCurrent: () => false }),
    options({ isCurrent: () => { throw new Error('private-guard-detail') } }),
  ]) {
    assert.equal(await f.adapter.readConversationMember(target, user, guard), undefined)
    assert.equal(await f.adapter.listConversationMembers(target, guard), undefined)
  }
  assert.deepEqual(f.memberRequests(), [])
})

test('member results reject mismatched identities and malformed responses without promoting unknown roles', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const result of [
    response({ ...member, group_id: 9 }), response({ ...member, user_id: 9 }),
    response({ ...member, group_id: '0315320' }), response({ ...member, user_id: '0324152' }),
    response({ ...member, user_id: ' 324152 ' }), response({ ...member, user_id: 9007199254740992 }),
    response({ ...member, self_id: 9 }), response({ ...member, self_id: null }),
    response(member, { self_id: 9 }), response(member, { self_id: null }),
    response({ ...member, group_id: undefined }), response({ ...member, user_id: undefined }),
    response([member]), response(null), response('owner'), response(member, { status: 'failed' }),
    response(member, { retcode: '0' }), response(member, { retcode: undefined }),
  ]) {
    f.setHandler(() => result)
    assert.equal(await f.adapter.readConversationMember(target, user, options()), undefined)
  }
  for (const [role, expected] of [['owner', 'owner'], ['admin', 'admin'], ['member', 'member'], ['OWNER', 'unknown'],
    ['administrator', 'unknown'], ['unknown', 'unknown'], [null, 'unknown'], [42, 'unknown'], [{ role: 'owner' }, 'unknown'],
  ]) {
    f.setHandler(() => response({ ...member, role, self_id: account.id }, { self_id: account.id }))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.role, expected)
  }
})

test('member lists refuse malformed rows, cross-group/account records, conflicting duplicates and overflow', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const data of [null, {}, { members: [member] }, [null], ['member'], [[member]],
    [member, { ...member, group_id: 9 }], [{ ...member, user_id: '0324152' }],
    [{ ...member, group_id: undefined }], [{ ...member, user_id: undefined }], [{ ...member, self_id: 9 }],
    [member, { ...member, role: 'owner' }], [member, { ...member, card: '另一个人' }],
    [member, { ...member, nickname: '相同名片下的另一个昵称' }], [member, { ...member, nickname: undefined }],
    [{ ...member, card: '林' }, { ...member, card: undefined }],
    Array.from({ length: 5001 }, (_, index) => ({ ...member, user_id: 400000 + index })),
  ]) {
    f.setHandler(() => response(data))
    assert.equal(await f.adapter.listConversationMembers(target, options()), undefined)
  }
  f.setHandler(() => response([member], { self_id: 9 }))
  assert.equal(await f.adapter.listConversationMembers(target, options()), undefined)
  f.setHandler(() => response([]))
  assert.deepEqual((await f.adapter.listConversationMembers(target, options())).members, [])
  f.setHandler(() => response(Array.from({ length: 5000 }, (_, index) => ({ ...member, user_id: 400000 + index }))))
  const maximum = await f.adapter.listConversationMembers(target, options())
  assert.equal(maximum.complete, true)
  assert.equal(maximum.members.length, 5000)
})

test('optional member details reject coercion, oversized strings, unsafe seconds and invalid demographic fields without fabricating defaults', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const absentNames = { ...member, card: undefined, nickname: undefined }
  const invalidText = [undefined, null, '', '   ', 0, false, {}, [], 'x'.repeat(241), 'bad\u0000text', 'bad\ntext', 'bad\u007ftext']
  for (const value of invalidText) {
    f.setHandler(() => response({ ...absentNames, nickname: value, card: value, title: value, area: value }))
    const found = await f.adapter.readConversationMember(target, user, options())
    assert.equal(found.member.profile, undefined, JSON.stringify(value))
  }
  for (const value of [undefined, null, 0, -1, 1.5, '1700000000', false, {}, [], 9_007_199_254_740_992, 8_640_000_000_001]) {
    f.setHandler(() => response({ ...absentNames, join_time: value, last_sent_time: value, shut_up_timestamp: value }))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.profile, undefined, JSON.stringify(value))
  }
  for (const value of [undefined, null, 0, -1, 151, 20.5, '20', false, {}, []]) {
    f.setHandler(() => response({ ...absentNames, age: value }))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.profile, undefined, JSON.stringify(value))
  }
  for (const value of [undefined, null, -1, 1.5, '01', '-1', '1.5', '', ' ', 'Infinity', '9'.repeat(241), 9_007_199_254_740_992, false, {}, []]) {
    f.setHandler(() => response({ ...absentNames, level: value }))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.profile, undefined, JSON.stringify(value))
  }
  for (const value of [undefined, null, 'Female', 'other', 1, false, {}, []]) {
    f.setHandler(() => response({ ...absentNames, sex: value }))
    assert.equal((await f.adapter.readConversationMember(target, user, options())).member.profile, undefined, JSON.stringify(value))
  }
})

test('valid profile boundary values survive exactly, including level zero and the maximum valid platform timestamp', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const [level, gender, age, seconds] of [[0, 'male', 1, 1], ['0', 'unknown', 150, 8_640_000_000_000],
    ['99', 'female', 28, 1_700_000_000], [9_007_199_254_740_991, 'unknown', 100, 8_640_000_000_000]]) {
    const text = '名'.repeat(240)
    f.setHandler(() => response({ ...member, nickname: text, card: text, title: text, area: text, level, sex: gender, age,
      join_time: seconds, last_sent_time: seconds, shut_up_timestamp: seconds }))
    const found = await f.adapter.readConversationMember(target, user, options())
    assert.deepEqual(found.member.profile, { nickname: text, conversationName: text, title: text, level: String(level),
      joinedAt: seconds * 1000, lastSpokeAt: seconds * 1000, mutedUntil: seconds * 1000, gender, age, region: text })
    assert.equal(found.member.displayName, '名'.repeat(128))
  }
})

test('member lookup captures its guard and refuses target, subject or authority changes while awaiting a response', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.setHandler(() => undefined)
  for (const mode of ['guard', 'target', 'user', 'abort-in-guard']) {
    let current = true, abortOnCheck = false
    const controller = new AbortController()
    const mutableTarget = structuredClone(target), mutableUser = { ...user }
    const guard = options({ signal: controller.signal, isCurrent: () => {
      if (abortOnCheck) controller.abort()
      return current
    } })
    const index = f.memberRequests().length
    const pending = f.adapter.readConversationMember(mutableTarget, mutableUser, guard)
    const request = await waitFor(() => f.memberRequests()[index], 'held member response')
    if (mode === 'guard') { current = false; guard.isCurrent = () => true }
    if (mode === 'target') mutableTarget.id = '315321'
    if (mode === 'user') mutableUser.id = '324153'
    if (mode === 'abort-in-guard') abortOnCheck = true
    reply(f.peer(), request, response(member))
    assert.equal(await pending, undefined)
  }
})

test('member requests have a bounded timeout and ignore late results without retrying', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.setHandler(() => undefined)
  const started = Date.now()
  const pending = f.adapter.readConversationMember(target, user, options())
  const request = await waitFor(() => f.memberRequests()[0], 'member timeout request')
  assert.equal(await pending, undefined)
  assert.ok(Date.now() - started < 4000)
  reply(f.peer(), request, response(member))
  await delay(50)
  assert.equal(f.memberRequests().length, 1)
  f.setHandler(() => response(member))
  assert.equal((await f.adapter.readConversationMember(target, user, options())).member.role, 'admin')
})
