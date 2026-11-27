import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { agentRedisPrefix } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'

const root = process.env.BL_CHAT_AGENT_RELEASE_DIR || fileURLToPath(new URL('../', import.meta.url))
const users = ['coder', 'author']
const accountId = '985300001'
const developerKey = 'fixture-development-key'
const mainKey = 'fixture-main-key'

test('standalone coding and tool author use the development slot with a main-model default', {
  skip: !redisAvailable, timeout: 45_000,
}, async t => {
  for (const configured of [true, false]) await t.test(configured ? 'development' : 'main default', async t => {
    const { reader, url } = await createAgentRedisFixture(t)
    const instance = 'model-route', prefix = agentRedisPrefix(instance)
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'standalone-dev-model-')))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'snapshot')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await writeFile(path.join(source, 'src', 'fixture.ts'), 'export const enabled = true\n')
    await writeFile(path.join(source, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(source, 'tsconfig.backend.json'), '{"compilerOptions":{"types":[]},"include":["src/**/*.ts"]}')
    await symlink(await realpath('node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const cases = []
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) body += chunk
        const modelRequest = JSON.parse(body), instructions = modelRequest.messages[0].content
        let stage, payload
        if (instructions.includes('你自己的工作回合') && modelRequest.messages.length > 2) {
          stage = 'receipt'
          assert.match(modelRequest.messages.at(-1).content, /Core 能力执行回执.*queued/su)
          payload = { action: 'rest' }
        } else if (instructions.includes('你自己的工作回合')) {
          stage = 'work'
          const { goals } = JSON.parse(modelRequest.messages[1].content)
          payload = goals[0].id === 'coder' ? { action: 'capability', name: 'engineering.submit',
            input: { title: '检查测试源码', task: '读取测试源码 fixture.ts 的 enabled 常量', mode: 'investigate' } }
            : { action: 'make-tool', name: '计数', task: '统计行数' }
        } else if (instructions.includes('这是只读调查')) {
          stage = 'code'
          if (modelRequest.messages.length > 2) assert.match(modelRequest.messages.at(-1).content, /enabled = true/u)
          payload = modelRequest.messages.length === 2 ? { op: 'read', path: 'src/fixture.ts', start: 1, count: 1 }
            : { op: 'done', summary: 'src/fixture.ts:1 的 enabled 为 true' }
        } else if (instructions.includes('编写一个纯文字分析工具')) {
          stage = 'author'
          payload = { definition: { name: '计数', description: '统计行数', steps: [{ kind: 'count' }] },
            examples: [{ before: '', after: '甲\n乙', expected: '2' }] }
        } else {
          response.writeHead(400).end()
          return
        }
        cases.push({ stage, path: request.url, model: modelRequest.model, credential: request.headers.authorization })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }],
        }))
      } catch { response.writeHead(500).end() }
    })
    const sockets = new WebSocketServer({ server })
    sockets.on('connection', socket => socket.on('message', frame => {
      const call = JSON.parse(frame)
      const data = call.action === 'get_login_info' ? { user_id: accountId, nickname: '测试 QQ' } : {}
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: call.echo, data }))
    }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise(resolve => sockets.close(resolve))
      await new Promise(resolve => server.close(resolve))
    })
    const address = '127.0.0.1:' + server.address().port
    const main = { name: 'chat-model', baseUrl: 'http://' + address + '/main/v1', apiKeyEnv: 'FIXTURE_MAIN_MODEL_KEY' }
    const development = { name: 'code-model', baseUrl: 'http://' + address + '/development/v1', apiKeyEnv: 'FIXTURE_DEVELOPMENT_MODEL_KEY' }
    const file = path.join(directory, 'agent-host.yaml')
    await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
      agents: users.map(id => ({ id, personaId: 'default' })),
      connections: [{ id: 'qq', platform: 'qq', namespace: 'global', accountId }],
      bindings: users.map((agentId, index) => ({ connectionId: 'qq', kind: 'group', conversationId: String(984220001 + index), agentId })),
    }))
    await writeFile(file, JSON.stringify({ version: 1, instance, model: main,
      ...(configured ? { developmentModel: development } : {}), connections: [{ id: 'qq', url: 'ws://' + address }],
    }))
    const now = Date.now()
    for (const id of users) await reader.set(prefix + 'bl-chat:agent-personal:v1:' + id, JSON.stringify({
      profiles: [{ name: '测试', aliases: [], introduction: '', identity: '测试角色', reason: '初始', revision: 0, changedAt: 0 }],
      goals: [{ id, title: '工作', draft: '', nextAt: now + 900_000, state: 'active' }], receipts: [], tools: [],
      nextReviewAt: now + 900_000, nextWorkAt: now - 1,
    }))
    const child = spawn(process.execPath, [path.join(root, 'scripts/start-agent.mjs'), '--config', file], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, BL_AGENT_REDIS_URL: url, BL_AGENT_CODING_SOURCE: source,
        FIXTURE_MAIN_MODEL_KEY: mainKey, FIXTURE_DEVELOPMENT_MODEL_KEY: developerKey,
      },
    })
    const exited = once(child, 'exit')
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    try {
      const deadline = Date.now() + 12_000
      let saved
      while (child.exitCode === null && Date.now() < deadline) {
        const state = JSON.parse(await reader.get(prefix + 'bl-chat:agent-personal:v1:coder'))
        saved = state.goals.find(goal => goal.engineering?.status === 'confirmed')
        if (cases.length >= 6 && saved) break
        await delay(25)
      }
      assert.ok(saved?.engineering.result?.includes('src/fixture.ts:1'), log)
      assert.equal(cases.filter(call => call.stage === 'work').length, 2, log)
      assert.deepEqual(cases.filter(call => call.stage !== 'work').map(call => call.stage).sort(), ['author', 'code', 'code', 'receipt'], log)
      for (const call of cases) {
        const developmentRoute = configured && ['author', 'code'].includes(call.stage)
        const expected = developmentRoute ? development : main
        assert.equal(call.model, expected.name)
        assert.equal(call.path, (developmentRoute ? '/development' : '/main') + '/v1/chat/completions')
        assert.equal(call.credential, 'Bearer ' + (developmentRoute ? developerKey : mainKey))
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    }
  })
})
