import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { agentRedisPrefix, connectAgentRedis, openAgentRedis } from '../../dist/backend/modules/runtime/infrastructure/agentRedis.js'

export const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0

export async function createAgentRedisFixture(t, instance = 'agent-core-test') {
  const directory = await mkdtemp(join(tmpdir(), 'agent-redis-'))
  const socket = join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit').catch(() => {})
  const url = `unix://${socket}`
  let reader
  let fixture
  t.after(async () => {
    try {
      await fixture?.close()
      if (reader?.isOpen) await reader.close()
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
      await exited
      await rm(directory, { recursive: true, force: true })
    }
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) {
      reader = await connectAgentRedis(url)
      fixture = await openAgentRedis({ url, instance, onLost: () => {} })
      return { reader, url, storage: fixture.storage, isCurrent: fixture.isCurrent, prefix: agentRedisPrefix(instance) }
    }
    if (server.exitCode !== null) break
    await delay(20)
  }
  throw new Error('测试 Redis 未启动')
}
