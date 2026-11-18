import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@redis/client'
export { importBilibiliHost as loadGift } from './bilibiliQualitySource.mjs'
export const account = { platform: 'qq', namespace: 'global', id: '19000501' }
export const user = id => ({ ...account, id })
export const target = { account, kind: 'group', id: '312501' }
export const binding = { source: 'configured', id: 'gift-room', revision: 'revision-gift-1', agentId: 'daily', personaId: 'default', connectionId: 'qq', target }
export const giftAction = () => ({ version: 1, kind: 'qq.gift-display', binding: structuredClone(binding), source: { messageId: '501', author: user('20000101') }, plan: { version: 1, recipient: user('30000101'), giftType: 'champagne' } })
export function giftGuard() {
  let current = true
  const controller = new AbortController()
  return { signal: controller.signal, isCurrent: () => current, async ensureCurrent() { assert.ok(current && !controller.signal.aborted) }, revoke() { current = false }, abort() { controller.abort() } }
}
export async function giftRedis(t) {
  // A fresh real local Redis instance; no existing service or built dist is used.
  const directory = await mkdtemp(path.join(tmpdir(), 'agft-')), socket = path.join(directory, 'r.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  let client, exited = false
  const ended = once(server, 'exit').then(() => { exited = true }, () => {})
  t.after(async () => {
    try { if (client?.isOpen) await client.close() }
    finally { if (!exited) server.kill('SIGTERM'); await ended; await rm(directory, { recursive: true, force: true }) }
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) {
      client = createClient({ socket: { path: socket, reconnectStrategy: false }, disableOfflineQueue: true })
      client.on('error', () => {})
      await client.connect()
      return { storage: { get: key => client.get(key), eval: (script, options) => client.eval(script, options) }, client }
    }
    if (exited) break
    await delay(10)
  }
  throw new Error('local gift Redis did not start')
}
export function nativeGift() {
  const calls = [], guard = giftGuard()
  const f = { calls, guard, ready: true, response: { status: 'ok', retcode: 0, data: {} }, before: undefined,
    async callApi(name, params, options) {
      await options.ensureCurrent(); assert.equal(options.isCurrent(), true); assert.equal(options.signal.aborted, false)
      calls.push({ name, params }); await f.before?.(name, params, options)
      if (name === 'get_msg') return { status: 'ok', retcode: 0, data: { message_id: 501, message_type: 'group', group_id: target.id, user_id: '20000101', self_id: account.id } }
      if (name === 'get_group_member_info') return { status: 'ok', retcode: 0, data: { group_id: target.id, user_id: params.user_id, card: params.user_id === account.id ? '真实机器人名' : '真实目标名', nickname: 'native-nickname' } }
      if (f.response instanceof Error) throw f.response
      return f.response
    },
  }
  f.options = { account, connectionId: 'qq', supportsGiftPacket: true, isReady: () => f.ready, callApi: f.callApi.bind(f) }
  return f
}
