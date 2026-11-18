import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@redis/client'

export const qzoneRedisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0

/** Uses only the real local Redis client/Lua engine, never old dist or external TCP. */
export async function createQzoneRedis(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qz-')), socket = join(directory, 's')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit').catch(() => {})
  const clients = []
  const connect = async () => {
    const client = createClient({ socket: { path: socket, reconnectStrategy: false } })
    client.on('error', () => {})
    clients.push(client)
    await client.connect()
    return client
  }
  t.after(async () => {
    for (const client of clients) if (client.isOpen) await client.close().catch(() => client.destroy())
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await exited
    await rm(directory, { recursive: true, force: true })
  })
  for (let tries = 0; tries < 100; tries++) {
    if (await stat(socket).then(() => true, () => false)) return { storage: await connect(), connect }
    if (server.exitCode !== null) break
    await delay(20)
  }
  throw new Error('qzone_test_redis_unavailable')
}
