import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import puppeteer from 'puppeteer'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const chromium = [process.env.BL_AGENT_TEST_CHROMIUM, process.env.PUPPETEER_EXECUTABLE_PATH, puppeteer.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  .find(value => value && existsSync(value))
const browserTest = { skip: !redisAvailable ? 'Redis unavailable' : !chromium ? 'Chromium unavailable; set BL_AGENT_TEST_CHROMIUM' : false, timeout: 60_000 }
const botId = 19000131, userId = 330139, groups = [311301, 311302], unboundGroup = 311399
const mainKey = 'rendering-fixture-main-private-key'
const auxiliaryKey = 'rendering-fixture-mindmap-private-key'
const oneBotToken = 'rendering-fixture-onebot-private-token'
const auxiliaryModel = 'rendering-fixture-independent-mindmap'
const mindPrompt = '为纸鹤工作室规划材料准备、折叠练习和成果展示三个阶段'
const auxiliaryMarkdown = '# 纸鹤工作室\n## 材料准备\n### 彩纸与裁纸刀\n## 折叠练习\n### 基础折痕\n### 翅膀成形\n## 成果展示\n### 作品墙'
const blockedFollowup = 'UNKNOWN-RENDER-FOLLOWUP：这条补充消息不得发送。'
const completion = message => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
const toolCall = (id, name, input) => ({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] })
const documentText = marker => `# 独立文档渲染验收 ${marker}\n\n中文说明：下面的代码与公式应当按文档格式排版。\n\n\`\`\`javascript\nfunction square(value) {\n  return value * value\n}\nconsole.log(square(12))\n\`\`\`\n\n能量公式：$E = mc^2$。\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n末尾完整性标记：文档正文已经结束。`

async function waitFor(probe, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(25)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function pngInfo(encoded) {
  assert.equal(typeof encoded, 'string')
  assert.ok(encoded.startsWith('base64://'), 'the adapter receives owned inline bytes, never a local path or URL')
  const base64 = encoded.slice(9)
  assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/u)
  const bytes = Buffer.from(base64, 'base64')
  assert.equal(bytes.toString('base64'), base64)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
  assert.ok(bytes.length > 2000, 'a real document or mind map is larger than a placeholder PNG')
  return { bytes, base64, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Real CLI, Redis, HTTP, WebSocket and Chromium. Only the model's prose is synthetic. */
async function fixture(t, { kind, receipt = 'sent', twoTargets = false }) {
  const instance = `rendering-${kind}-${receipt}`
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-agent-rendering-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], auxiliaryRequests = [], deliveries = [], errors = [], unexpected = []
  const phases = new Map()
  const toolName = kind === 'document' ? 'textImageTool' : 'aiMindMapTool'
  let reader, child, childExit, websocket, log = ''
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/mindmap/v1/chat/completions') {
        auxiliaryRequests.push({ auth: request.headers.authorization, body })
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: auxiliaryMarkdown } }],
          usage: { prompt_tokens: 33, completion_tokens: 11, total_tokens: 44 } }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ auth: request.headers.authorization, body })
        const wakes = body.messages.filter(row => row.role === 'user').map(row => String(row.content))
        const marker = wakes.findLast(text => /CURRENT-RENDER-TARGET-[AB]/u.test(text))?.match(/CURRENT-RENDER-TARGET-([AB])/u)?.[1]
        if (!marker) throw new Error('The main request did not retain its fixed conversation marker')
        const phase = phases.get(marker) ?? { chose: false, followup: false, finished: false }
        phases.set(marker, phase)
        const renderCallId = `rendering-${marker}-${toolName}`
        const result = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === renderCallId)
        if (result && receipt === 'unknown' && !phase.followup) {
          phase.followup = true
          response.end(completion(toolCall(`rendering-${marker}-forbidden-followup`, 'simSendMessage', { continuation: 'chat', messages: [blockedFollowup] })))
        } else if (result && !phase.finished) {
          phase.finished = true
          response.end(completion(toolCall(`rendering-${marker}-finish`, 'simFinishTurn', { choice: 'silent', reason: '本轮渲染工具已尝试发送，不追加或重复发送' })))
        } else if (phase.finished || phase.chose) {
          response.end(completion(toolCall(`rendering-${marker}-done`, 'simDecide', { decision: 'silent', reason: '本轮已经完成或无法继续' })))
        } else {
          phase.chose = true
          response.end(completion(toolCall(renderCallId, toolName, kind === 'document'
            ? { text: documentText(marker), template: 'document', nickname: `渲染验收${marker}` }
            : { prompt: mindPrompt, width: 960, height: 640, waitTime: 1000 })))
        }
        return
      }
      unexpected.push(request.url)
      response.writeHead(404).end('{}')
    } catch (error) { errors.push(String(error)); response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, connection, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${oneBotToken}`) { connection.destroy(); return }
    sockets.handleUpgrade(request, connection, head, client => sockets.emit('connection', client))
  })
  sockets.on('connection', client => {
    websocket = client
    client.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message))
        let data = {}
        if (action === 'get_login_info') data = { user_id: botId, nickname: '独立渲染工具合成验收账号' }
        else if (action === 'send_group_msg') {
          deliveries.push({ action, params })
          data = receipt === 'sent' ? { message_id: 991300 + deliveries.length } : {}
        } else unexpected.push(action)
        client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    if (t.error) {
      t.diagnostic(log)
      t.diagnostic(JSON.stringify({ errors, unexpected, auxiliaryRequests: auxiliaryRequests.length,
        deliveries: deliveries.map(item => ({ action: item.action, group: item.params.group_id, parts: item.params.message.map(part => part.type) })),
        results: mainRequests.flatMap(item => item.body.messages.filter(row => row.role === 'tool')) }))
    }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (childExit) await childExit
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated rendering Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'render-a', personaId: 'default' }, { id: 'render-b', personaId: 'default' }],
    connections: [{ id: 'qq-rendering', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: groups.map((id, index) => ({ connectionId: 'qq-rendering', kind: 'group', conversationId: String(id), agentId: index ? 'render-b' : 'render-a' })),
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'rendering-fixture-main', apiKeyEnv: 'TEST_RENDERING_MAIN_KEY' },
    tools: { rendering: kind === 'document' ? { textImage: { enabled: true } }
      : { mindMap: { baseUrl: `http://127.0.0.1:${port}/mindmap/v1`, name: auxiliaryModel, apiKeyEnv: 'TEST_RENDERING_AUXILIARY_KEY' } } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-rendering', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_RENDERING_ONEBOT_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false },
      personProfile: { enabled: false }, turn: { minSendGapMs: 0 } },
  }))
  child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory, env: { ...process.env,
    BL_AGENT_REDIS_URL: `unix://${socketPath}`, PUPPETEER_EXECUTABLE_PATH: chromium,
    TEST_RENDERING_MAIN_KEY: mainKey, TEST_RENDERING_AUXILIARY_KEY: auxiliaryKey, TEST_RENDERING_ONEBOT_TOKEN: oneBotToken },
  })
  childExit = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  await waitFor(() => {
    if (child.exitCode !== null) assert.fail(`standalone rendering exited before readiness: ${log}`)
    return log.includes('已启动') && websocket
  }, 'standalone rendering host readiness')
  const send = (id, marker, messageId) => websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
    group_id: id, user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: 'PRIVATE-RENDERING-USER' },
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: `${marker}：请使用渲染工具完成本轮请求。本群线索 PRIVATE-GROUP-ONLY 不交给导图模型。` } }],
  }))
  const prefix = `bl-agent:${instance}:`
  const settled = async () => (await reader.keys(`${prefix}shiloh:sim:busy:*`)).length === 0
  // An incoming message in an unbound target cannot acquire either a model or a renderer.
  send(unboundGroup, 'UNBOUND-RENDER-TARGET', 91300)
  for (const [index, id] of groups.slice(0, twoTargets ? 2 : 1).entries()) {
    const marker = index ? 'B' : 'A'
    send(id, `CURRENT-RENDER-TARGET-${marker}`, 91301 + index)
    await waitFor(() => phases.get(marker)?.finished, `rendering ${marker} result consumed by model`)
    await waitFor(settled, `rendering ${marker} turn settled`)
  }
  child.kill('SIGTERM')
  assert.deepEqual(await childExit, [0, null], log)
  child = undefined; childExit = undefined
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpected, [])
  assert.equal(deliveries.length, twoTargets ? 2 : 1, 'unknown receipts, silent finish and unbound events never produce extra sends')
  assert.deepEqual(deliveries.map(item => item.params.group_id), groups.slice(0, twoTargets ? 2 : 1))
  const images = deliveries.map(item => {
    assert.equal(item.action, 'send_group_msg')
    assert.equal(item.params.message.length, 1)
    assert.equal(item.params.message[0].type, 'image')
    return pngInfo(item.params.message[0].data.file)
  })
  for (const image of images) {
    if (kind === 'mindmap') assert.deepEqual([image.width, image.height], [960, 640])
    else { assert.ok(image.width >= 640 && image.width <= 4096); assert.ok(image.height >= 320 && image.height <= 8192) }
  }
  if (twoTargets) assert.notDeepEqual(images[0].bytes, images[1].bytes, 'each target renders its own requested document')
  if (process.env.BL_AGENT_RENDERING_PROOF_DIR) {
    await mkdir(process.env.BL_AGENT_RENDERING_PROOF_DIR, { recursive: true })
    for (const [index, image] of images.entries()) await writeFile(path.join(process.env.BL_AGENT_RENDERING_PROOF_DIR, `${instance}-${index ? 'B' : 'A'}.png`), image.bytes)
  }
  const toolResults = mainRequests.flatMap(item => item.body.messages.filter(row => row.role === 'tool' && row.name === toolName))
  assert.ok(toolResults.length > 0, 'the model consumes the actual host rendering tool result')
  for (const item of toolResults) {
    if (receipt === 'sent') assert.match(String(item.content), /已确认发送|已确认投递|已发送到|投递完成/u)
    else { assert.match(String(item.content), /尚未确认|没有确认|未能确认|未确认|核实前|结果未知/u); assert.doesNotMatch(String(item.content), /已确认发送|已确认投递|已发送到/u) }
  }
  for (const item of mainRequests) {
    assert.equal(item.auth, `Bearer ${mainKey}`)
    assert.equal(item.body.model, 'rendering-fixture-main')
    assert.ok(!item.body.tools.some(tool => tool.function.name === (kind === 'document' ? 'aiMindMapTool' : 'textImageTool')))
    assert.ok(!JSON.stringify(item.body).includes('UNBOUND-RENDER-TARGET'))
  }
  assert.ok(mainRequests[0].body.tools.some(tool => tool.function.name === toolName), 'the configured rendering capability is exposed on the acting round')
  if (receipt === 'unknown') assert.equal(phases.get('A').followup, true, 'the unknown-receipt fixture actually attempts a forbidden follow-up')
  assert.equal(auxiliaryRequests.length, kind === 'mindmap' ? 1 : 0)
  for (const item of auxiliaryRequests) {
    assert.equal(item.auth, `Bearer ${auxiliaryKey}`)
    assert.equal(item.body.model, auxiliaryModel)
    assert.equal(item.body.messages.length, 2)
    assert.ok(item.body.messages.some(message => message.role === 'user' && String(message.content).includes(mindPrompt)))
    assert.ok(!JSON.stringify(item.body).includes('PRIVATE-GROUP-ONLY'))
    assert.ok(!JSON.stringify(item.body).includes('PRIVATE-RENDERING-USER'))
    assert.ok(!JSON.stringify(item.body).includes('CURRENT-RENDER-TARGET'))
  }
  const ledgerDirectory = path.join(directory, 'data', instance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDirectory)).map(file => readFile(path.join(ledgerDirectory, file), 'utf8')))).join('')
  const ledger = ledgerText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(ledger.filter(row => row.stage === 'agent-tool' && row.model === auxiliaryModel).map(row => row.u.total), kind === 'mindmap' ? [44] : [])
  const stored = await Promise.all((await reader.keys(`${prefix}*`)).map(async key => {
    if (await reader.type(key) !== 'string') return ''
    return await reader.get(key) ?? ''
  }))
  const observed = [log, ledgerText, ...stored, ...mainRequests.map(item => JSON.stringify(item.body))]
  for (const value of observed) {
    for (const secret of [mainKey, auxiliaryKey, oneBotToken]) assert.ok(!value.includes(secret), 'secrets never enter logs, history or ledgers')
    for (const image of images) assert.ok(!value.includes(image.base64), 'rendered image bytes never enter model or persisted history')
  }
  return { images, auxiliaryRequests, deliveries }
}

test('actual standalone CLI renders code and formulas as document PNGs in two independently bound targets', browserTest,
  async t => { await fixture(t, { kind: 'document', twoTargets: true }) })

test('actual standalone CLI uses the explicitly configured mind-map model, records its usage and delivers a real Chromium PNG', browserTest,
  async t => { await fixture(t, { kind: 'mindmap' }) })

test('actual standalone CLI attempts an unknown mind-map delivery once and blocks the model subsequent send', browserTest,
  async t => { await fixture(t, { kind: 'mindmap', receipt: 'unknown' }) })
