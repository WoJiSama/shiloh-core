import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentTurtleSoup, agentTurtleSoupDirectory } = await load('modules/games/infrastructure/agentTurtleSoup.js')
const { TurtleSoupStore, resolveTurtleSoupConfig } = await load('modules/games/infrastructure/turtleSoup/TurtleSoupStore.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const SOLUTION = '男人是盲人，把伞当作拐杖探路'
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function puzzle(id = 'p1') { return { id, title: '雨夜的伞', surface: '雨夜，他撑着伞仍然撞上了树，为什么？', solution: SOLUTION,
  keyPoints: ['男人是盲人', '伞用来探路'], hints: ['注意伞的用途', '他看不见'], difficulty: 'normal', tags: [], source: 'manual', createdAt: 1, status: 'active', ratingSum: 0, ratingCount: 0 } }
function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turtle-soup-'))
  const account = { platform: 'qq', namespace: 'test', id: '19009991' }
  const target = { account, kind: 'group', id: '3109991' }
  const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'r1', agentId: 'daily', personaId: 'default', connectionId: 'qq-main', target }
  let at = 1800000000000, message = 0, enabled = true, model = async messages => String(messages[0]?.content).includes('判题员') ? JSON.stringify({ coveredIds: ['kp1', 'kp2'], contradictedIds: [], correct: true, reason: '事实吻合' }) : '是', backgroundBudget = 0, beforeSend, privateSend, ensure
  const sends = [], privateSends = [], modelCalls = [], backgroundOrigins = [], handlers = []
  const config = () => ({ ...resolveTurtleSoupConfig({}), minPlayers: 2, baseDir: 'must-not-read-legacy', enabled, ...overrides.config })
  const source = (text, user = 'alice', selected = binding) => ({ version: 1, conversation: structuredClone(selected.target),
    sender: { platform: selected.target.account.platform, namespace: selected.target.account.namespace, id: user },
    senderName: user, messageId: 'game-' + (++message), occurredAt: at, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false })
  const context = (text, user = 'alice', role = 'member', selected = binding, original) => {
    let current = true
    const s = original ?? source(text, user, selected), signal = new AbortController().signal
    const value = { source: s, binding: structuredClone(selected), member: { id: s.sender.id, name: s.senderName ?? s.sender.id, role },
      signal, isCurrent: () => current, async ensureCurrent() { if (!current) throw Error('revoked'); await ensure?.(value); if (!current) throw Error('revoked') },
      async sendText(text, guard) { await beforeSend?.(text, guard, value); await guard?.ensureCurrent(); await value.ensureCurrent(); sends.push({ text, source: s.messageId, binding: selected }) },
      async sendImage() { assert.fail('Turtle soup must use its existing text response protocol') },
      async sendPrivate(userId, text, guard) { assert.equal(userId, value.member.id); await guard?.ensureCurrent(); await value.ensureCurrent(); privateSends.push({ userId, text }); await privateSend?.(userId, text) },
      revoke() { current = false },
    }
    return value
  }
  const options = { dataDir, config,
    async callModel(messages, options, authority) { modelCalls.push({ messages, options, authority }); await authority.ensureCurrent(); return model(messages, options, authority) },
    async authorizeBackground(origin) {
      backgroundOrigins.push(structuredClone(origin))
      if (backgroundBudget-- <= 0) return undefined
      return context(origin.source.text, origin.source.sender.id, 'member', origin.binding, origin.source)
    },
    now: () => at, sweepIntervalMs: 60000,
  }
  const make = () => { const handler = createAgentTurtleSoup(options); handlers.push(handler); return handler }
  let handler = make()
  const store = (selected = binding) => new TurtleSoupStore({ cwd: dataDir, baseDir: agentTurtleSoupDirectory(dataDir, selected.target.account, selected.agentId) })
  t.after(async () => { for (const item of handlers) await item.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { dataDir, account, target, binding, source, context, config, options, sends, privateSends, modelCalls, backgroundOrigins, store,
    get handler() { return handler }, set handler(value) { handler = value },
    make, async send(text, user, role, selected) { return handler.handle(context(text, user, role, selected)) },
    setModel(value) { model = value }, setEnabled(value) { enabled = value }, setBeforeSend(value) { beforeSend = value },
    setPrivateSend(value) { privateSend = value }, setEnsure(value) { ensure = value },
    advance(ms) { at += ms }, allowBackground(count = 1) { backgroundBudget = count },
  }
}
async function playing(f) {
  await f.store().savePuzzle(puzzle())
  await f.send('.游戏 海龟汤 开局')
  await f.send('.游戏 海龟汤 加入', 'bob')
  await f.send('.游戏 海龟汤 开始')
  assert.equal(Object.values(f.store().readSessions().sessions)[0].phase, 'playing')
}
async function until(probe) {
  for (let count = 0; count < 100; count++) { if (await probe()) return; await delay(10) }
  assert.fail('game fixture did not reach expected boundary')
}

test('standalone adapter reuses commands, host Q&A, hint, current-member surrender, reveal and persistent rating', async t => {
  const f = fixture(t)
  await playing(f)
  assert.equal(f.handler.isActive(f.binding), true)
  assert.equal(f.handler.isCandidate(f.source('他是盲人吗？'), f.binding), true)
  await f.send('他是盲人吗？')
  assert.equal(f.sends.at(-1).text, '是')
  assert.equal(f.modelCalls.length, 1)
  await f.send('.游戏 海龟汤 提示', 'bob')
  assert.match(f.sends.at(-1).text, /伞的用途/u)
  await f.send('.游戏 海龟汤 投降', 'bob')
  assert.equal(f.privateSends.length, 1)
  assert.equal(f.privateSends[0].userId, 'bob')
  assert.match(f.privateSends[0].text, /男人是盲人/u)
  await f.send('.游戏 海龟汤 猜 ' + SOLUTION)
  assert.match(f.sends.at(-1).text, /猜中汤底/u)
  assert.equal(f.handler.isActive(f.binding), false)
  await f.send('.游戏 海龟汤 评分 5')
  await f.send('.游戏 海龟汤 排行')
  assert.match(f.sends.at(-1).text, /5\.0星/u)
  const state = f.store().readState()
  assert.equal(state.plays[0].solved, true)
  assert.equal(state.plays[0].groupId, conversationAddressKey(f.target))
  assert.equal(state.plays[0].ratings[0].score, 5)
  assert.equal(state.sessions[conversationAddressKey(f.target)].qaLog.length, 1)
})

test('full account, namespace, Agent and target ownership isolate equal group IDs and disabled handlers stay silent', async t => {
  const f = fixture(t)
  await f.send('.游戏 海龟汤 开局')
  for (const changed of [
    { ...f.binding, agentId: 'another' },
    { ...f.binding, target: { ...f.target, account: { ...f.account, id: '19009992' } } },
    { ...f.binding, target: { ...f.target, account: { ...f.account, namespace: 'other' } } },
    { ...f.binding, target: { ...f.target, id: '3109992' } },
  ]) {
    assert.equal(f.handler.isActive(changed), false)
    await f.send('.游戏 海龟汤 状态', 'alice', 'member', changed)
    assert.match(f.sends.at(-1).text, /没有进行中/u)
  }
  f.setEnabled(false)
  const before = f.sends.length
  assert.equal(f.handler.isCandidate(f.source('.游戏 海龟汤 开局'), f.binding), false)
  assert.equal(await f.send('.游戏 海龟汤 开局'), false)
  assert.equal(f.sends.length, before)
})

test('deadline sweep restores original source and binding after restart, then starts and reveals the persisted session', async t => {
  const f = fixture(t)
  await f.store().savePuzzle(puzzle())
  await f.send('.游戏 海龟汤 开局')
  await f.send('.游戏 海龟汤 加入', 'bob')
  const initial = Object.values(f.store().readSessions().sessions)[0]
  const openingId = f.sends[0].source
  await f.handler.stop()
  f.handler = f.make()
  f.advance(5 * 60000 + 1)
  f.allowBackground()
  await f.handler.sweep()
  assert.equal(Object.values(f.store().readSessions().sessions)[0].phase, 'playing')
  assert.equal(Object.values(f.store().readSessions().sessions)[0].sessionId, initial.sessionId)
  assert.match(f.sends.at(-1).text, /雨夜/u)
  assert.equal(f.backgroundOrigins[0].source.messageId, openingId)
  assert.equal(f.backgroundOrigins[0].source.text, '.游戏 海龟汤 开局')
  await delay(10) // Drain the independently scheduled refill authorization before granting this deadline.
  f.advance(5 * 60000 + 1)
  f.allowBackground()
  await f.handler.sweep()
  assert.equal(Object.values(f.store().readSessions().sessions)[0].phase, 'reveal')
  assert.equal(f.store().readPlays().plays[0].endReason, 'idle_timeout')
})

test('an unavailable or mismatched original authority cannot sweep using a later group member', async t => {
  const f = fixture(t)
  await f.send('.游戏 海龟汤 开局')
  f.advance(6 * 60000)
  await f.handler.sweep()
  assert.equal(Object.values(f.store().readSessions().sessions)[0].phase, 'joining')
  await f.handler.stop()
  f.options.authorizeBackground = async origin => f.context('.游戏 海龟汤 状态', 'bob', 'member', origin.binding)
  f.handler = f.make()
  await f.handler.sweep()
  assert.equal(Object.values(f.store().readSessions().sessions)[0].phase, 'joining')
})

test('withdrawn model authority rejects late output and cannot append or send the old question', async t => {
  const f = fixture(t)
  await playing(f)
  const entered = gate(), result = gate()
  f.setModel(async () => { entered.resolve(); return result.promise })
  const context = f.context('他看不见吗？'), before = f.sends.length
  const pending = f.handler.handle(context)
  await entered.promise
  context.revoke()
  result.resolve('是')
  await assert.rejects(pending, /revoked|失效/u)
  assert.equal(Object.values(f.store().readSessions().sessions)[0].qaLog.length, 0)
  assert.equal(f.sends.length, before)
  await f.send('.游戏 海龟汤 状态', 'bob')
  assert.match(f.sends.at(-1).text, /问答中/u)
})

test('stopping rejects in-flight models even when the injected provider ignores cancellation', async t => {
  const f = fixture(t)
  await playing(f)
  const entered = gate(), result = gate()
  f.setModel(async () => { entered.resolve(); return result.promise })
  const before = f.sends.length
  const pending = f.handler.handle(f.context('他看不见吗？'))
  await entered.promise
  const rejected = assert.rejects(pending, /失效|停止/u)
  await f.handler.stop()
  await rejected
  result.resolve('是')
  assert.equal(f.sends.length, before)
  assert.equal(Object.values(f.store().readSessions().sessions)[0].qaLog.length, 0)
  assert.equal(f.handler.isCandidate(f.source('.游戏 海龟汤 开局'), f.binding), false)
})

test('fresh authorization failure before persistent commit leaves no mutated session or occupied group', async t => {
  const f = fixture(t)
  const context = f.context('.游戏 海龟汤 开局')
  let checks = 0
  f.setEnsure(value => { if (value === context && ++checks === 4) context.revoke() })
  await assert.rejects(f.handler.handle(context), /revoked|失效/u)
  assert.deepEqual(f.store().readSessions().sessions, {})
  f.setEnsure(undefined)
  await f.send('.游戏 海龟汤 开局')
  assert.match(f.sends.at(-1).text, /报名开始/u)
})

test('unknown private delivery is durably fenced across a new request and restart', async t => {
  const f = fixture(t)
  await playing(f)
  f.setPrivateSend(async () => { throw Error('delivery unknown') })
  const before = f.sends.length
  await assert.rejects(f.send('.游戏 海龟汤 投降', 'bob'), /失效/u)
  assert.equal(f.privateSends.length, 1)
  assert.equal(f.sends.length, before, 'unknown private delivery must not produce a group fallback')
  await f.handler.stop()
  f.handler = f.make()
  await f.send('.游戏 海龟汤 投降', 'bob')
  assert.equal(f.privateSends.length, 1)
  assert.match(f.sends.at(-1).text, /结果未确认时不重复/u)
})

test('queue delivery guard rejects a late answer after another authorized participant ends the room', async t => {
  const f = fixture(t)
  await playing(f)
  const queued = gate(), release = gate()
  let captured
  f.setBeforeSend(async (text, guard) => { if (text === '是') { captured = guard; queued.resolve(); await release.promise } })
  const pending = f.handler.handle(f.context('他看不见吗？'))
  await queued.promise
  await f.send('.游戏 海龟汤 结束')
  assert.equal(captured.isCurrent(), false)
  const rejected = assert.rejects(pending, /失效/u)
  release.resolve()
  await rejected
  assert.equal(f.sends.filter(item => item.text === '是').length, 0)
  assert.match(f.sends.at(-1).text, /汤底/u)
})

test('real deadline timer follows the same original-source authorization and restored state path', async t => {
  const f = fixture(t, { config: { minPlayers: 1 } })
  await f.store().savePuzzle(puzzle())
  await f.send('.游戏 海龟汤 开局')
  await f.handler.stop()
  f.advance(5 * 60000 + 1)
  f.allowBackground()
  f.options.sweepIntervalMs = 10
  f.handler = f.make()
  await until(() => Object.values(f.store().readSessions().sessions)[0]?.phase === 'playing')
  assert.equal(f.backgroundOrigins[0].source.text, '.游戏 海龟汤 开局')
  assert.match(f.sends.at(-1).text, /雨夜/u)
})

test('post-game model work reauthorizes its own triggering source instead of borrowing the opening command', async t => {
  const f = fixture(t)
  await playing(f)
  await f.send('他是盲人吗？')
  await delay(10)
  f.allowBackground()
  await f.send('.游戏 海龟汤 结束')
  await until(() => f.modelCalls.some(call => String(call.messages[0]?.content).includes('赛后解说')))
  const award = f.modelCalls.find(call => String(call.messages[0]?.content).includes('赛后解说'))
  assert.equal(award.authority.source.text, '.游戏 海龟汤 结束')
  assert.notEqual(award.authority.source.messageId, f.sends[0].source)
})
