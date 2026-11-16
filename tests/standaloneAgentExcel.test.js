import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const botId = 19000171, userId = 330171, groupId = 311701
const mainKey = 'excel-fixture-model-key', oneBotToken = 'excel-fixture-onebot-key'
const fileId = 'EXCEL-PLATFORM-REFERENCE-DO-NOT-DISCLOSE'
const marker = '临时工作簿专用标记青枫'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const scope = simulationAddressKey(target)
const completion = (name, input, id = name) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
async function waitFor(probe, description, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(25) }
  assert.fail(`timed out: ${description}`)
}

for (const mode of ['recent', 'repository']) test(`actual CLI Excel ${mode}: trusted source, real worker and temporary derived answer`, { timeout: 45_000 }, async t => {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'this acceptance needs real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), `agent-excel-${mode}-`))
  const socketPath = path.join(directory, 'redis.sock')
  const instance = `excel-${mode}`, prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const workbook = await readFile(path.join(repo, 'tests/fixtures/agentWorkbook.xlsx'))
  const requests = [], actions = [], deliveries = [], errors = [], downloaded = []
  const now = Math.floor(Date.now() / 1000)
  const original = { message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId, sender: { user_id: userId, nickname: '文件验收员' }, message_id: 97101, time: now,
    message: [{ type: 'file', data: { name: '验收.xlsx', file_id: fileId, file: 'filename-must-not-shadow-id', busid: 102, url: 'https://unverified.example/ignore' } }], raw_message: '' }
  const requestText = mode === 'recent' ? '请查询我刚上传的 Excel A1:B2' : '请列出群文件 Excel，再查询资料目录的验收.xlsx A1:B2'
  const current = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId, sender: { user_id: userId, nickname: '文件验收员' }, message_id: 97102, time: now + 1,
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: requestText } }], raw_message: requestText }
  let reader, child, exited, websocket, log = '', finished = false, fileUrl
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/workbook.xlsx') { downloaded.push(req.url); res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.end(workbook); return }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      assert.equal(req.url, '/main/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${mainKey}`)
      requests.push(body)
      res.setHeader('Content-Type', 'application/json')
      const sent = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'send')
      const read = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'read')
      const listed = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'list')
      if (sent) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '临时查询已处理，不保存资料' }, 'finish')); return }
      if (read) {
        assert.match(String(read.content), /公式: =2\+3/u)
        assert.match(String(read.content), /值: 5/u)
        assert.ok(String(read.content).includes(marker), 'actual workbook cells reached the model')
        res.end(completion('simSendMessage', { continuation: 'chat', messages: [`${marker}，B2 的缓存结果为 5。`] }, 'send')); return
      }
      if (mode === 'repository' && !listed) { res.end(completion('excelWorkbookTool', { operation: 'list_group_excels' }, 'list')); return }
      if (listed) { assert.match(String(listed.content), /验收.xlsx/u); assert.match(String(listed.content), /资料/u) }
      res.end(completion('excelWorkbookTool', { operation: 'read_range', range: 'A1:B2', ...(mode === 'repository' ? { fileName: '验收.xlsx', folderPath: '/资料' } : {}) }, 'read'))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${oneBotToken}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', message => {
      const { action, params, echo } = JSON.parse(String(message)); actions.push({ action, params })
      let data = {}
      if (action === 'get_login_info') data = { user_id: botId, nickname: '文件验收机器人' }
      else if (action === 'get_msg') data = Number(params.message_id) === original.message_id ? original : current
      else if (action === 'get_group_root_files') data = mode === 'repository' ? { files: [], folders: [{ folder_id: 'folder-verified', folder_name: '资料', total_file_count: 1 }] } : { files: [], folders: [] }
      else if (action === 'get_group_files_by_folder') data = { files: [{ file_id: fileId, busid: 102, file_name: '验收.xlsx', file_size: workbook.length, uploader: userId, upload_time: now }], folders: [] }
      else if (action === 'get_group_file_url') { assert.equal(params.file_id, fileId); assert.equal(Number(params.busid), 102); data = { url: fileUrl } }
      else if (action === 'send_group_msg') { deliveries.push(params); data = { message_id: 97200 + deliveries.length } }
      else errors.push(`unexpected action ${action}`)
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, requests: requests.map(row => row.messages.filter(item => item.role === 'tool')) }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (exited) await exited
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const port = server.address().port
  fileUrl = `http://files.example:${port}/workbook.xlsx`
  // Fixture-only routing: retain the production DNS/pinning guards while routing the synthetic public host to this local server.
  const preload = path.join(directory, 'file-network-fixture.mjs')
  await writeFile(preload, `import dns from 'node:dns/promises'; import http from 'node:http'; import {syncBuiltinESMExports} from 'node:module';\nconst lookup=dns.lookup; dns.lookup=async(host,...args)=>host==='files.example'?[{address:'8.8.8.8',family:4}]:lookup(host,...args);\nconst request=http.request; http.request=function(url,opts,...args){if(url instanceof URL&&url.hostname==='files.example'){const local=new URL(url);local.hostname='127.0.0.1';return request.call(this,local,{...opts,family:4,lookup:(_h,_o,cb)=>cb(null,'127.0.0.1',4)},...args)}return request.call(this,url,opts,...args)};syncBuiltinESMExports();\n`)
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'qq-excel', platform: 'qq', namespace: 'global', accountId: String(botId) }], bindings: [{ connectionId: 'qq-excel', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance, model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'excel-fixture-model', apiKeyEnv: 'EXCEL_MODEL_KEY' }, tools: { excel: { enabled: true } }, memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-excel', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'EXCEL_ONEBOT_KEY' }], simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } }))
  child = spawn(process.execPath, ['--import', preload, entry, '--config', configFile], { cwd: directory, env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, EXCEL_MODEL_KEY: mainKey, EXCEL_ONEBOT_KEY: oneBotToken } })
  exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  await waitFor(() => log.includes('已启动'), 'CLI readiness')
  if (mode === 'recent') {
    websocket.send(JSON.stringify({ post_type: 'message', ...original }))
    await waitFor(async () => (JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null'))?.recent?.some(row => row.messageId === String(original.message_id)), 'pure file ingress')
  }
  websocket.send(JSON.stringify(current))
  await waitFor(() => finished, 'workbook read and derived send')
  await waitFor(async () => { const state = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null'); return state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope)) }, 'turn drains')
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null])
  assert.deepEqual(errors, [])
  assert.equal(deliveries.length, 1)
  assert.equal(downloaded.length, 1, 'source revalidation never redownloads workbook bytes')
  assert.ok(requests[0].tools.some(row => row.function.name === 'excelWorkbookTool'))
  assert.ok(actions.some(row => row.action === 'get_group_file_url'))
  if (mode === 'recent') assert.ok(actions.some(row => row.action === 'get_msg' && Number(row.params.message_id) === original.message_id))
  else assert.ok(actions.filter(row => row.action === 'get_group_files_by_folder').length >= 2, 'repository source is freshly reauthorized')
  const stored = []
  for await (const keys of reader.scanIterator({ MATCH: `${prefix}*` })) for (const key of Array.isArray(keys) ? keys : [keys]) if (await reader.type(key) === 'string') stored.push(await reader.get(key))
  const allStored = stored.join('\n')
  for (const value of [marker, '公式: 2+3', workbook.toString('base64'), fileUrl, fileId]) {
    assert.ok(!allStored.includes(value), 'source bytes, projections and derived answer are not persisted')
    assert.ok(!log.includes(value), 'file body/reference never appears in logs')
  }
  for (const value of [workbook.toString('base64'), fileUrl, fileId, oneBotToken]) assert.ok(!JSON.stringify(requests).includes(value), 'model sees bounded file text without resource identifiers')
})
