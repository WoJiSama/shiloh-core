import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost } from './bilibiliQualitySource.mjs'

export const loadRedPacketSource = importBilibiliHost
/** Isolated real Redis; all application modules use the selected current-source loader. */
export async function redPacketRedis(t, instance = 'red-packet-source') {
  const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await loadRedPacketSource('modules/runtime/infrastructure/agentRedis.js')
  const dir = await mkdtemp(join(tmpdir(), 'rp-')), socket = join(dir, 'r.sock'), url = `unix://${socket}`
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit').catch(() => {})
  let reader, host
  t.after(async () => {
    try { await host?.close(); if (reader?.isOpen) await reader.close() }
    finally { if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); await exited; await rm(dir, { recursive: true, force: true }) }
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) {
      reader = await connectAgentRedis(url)
      host = await openAgentRedis({ url, instance, onLost() {} })
      return { reader, storage: host.storage, isCurrent: host.isCurrent, prefix: agentRedisPrefix(instance) }
    }
    if (server.exitCode !== null) break
    await delay(10)
  }
  throw new Error('Isolated red packet Redis did not start')
}

/** Deterministic transaction seam for stage failures; durable semantics are separately tested on real Redis. */
export function redPacketMemoryStorage() {
  const rows = new Map(), ttl = new Map()
  return {
    rows, ttl,
    async get(key) { return rows.get(key) ?? null },
    async eval(script, { keys: [key], arguments: args }) {
      if (script.includes("'PX','60000'")) { if (rows.has(key)) return 0; rows.set(key, '1'); ttl.set(key, 60); return 1 }
      if (script.includes("'NX','EX'")) { if (rows.has(key)) return rows.get(key); rows.set(key, args[0]); ttl.set(key, Number(args[1])); return '' }
      if (script.includes('KEEPTTL')) { if (rows.get(key) !== args[0]) return 0; rows.set(key, args[1]); return 1 }
      if (script.includes("==ARGV[1] then return 1")) return rows.get(key) === args[0] ? 1 : 0
      throw new Error('Unexpected red packet transaction')
    },
  }
}
