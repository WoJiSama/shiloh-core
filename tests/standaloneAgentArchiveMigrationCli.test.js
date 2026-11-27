import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { createQzoneRedis, qzoneRedisAvailable } from './helpers/agentQzoneRedis.mjs'

// Run the unmodified CLI from the coordinator's frozen, verified release.
// This file never builds artifacts or imports the repository's source loader.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), runNode = promisify(execFile)
const settings = { timeout: 30_000 }, connectionId = 'qq-main', author = '3308827'
const account = { platform: 'qq', namespace: 'global', id: '19008827' }, target = { account, kind: 'group', id: '3108827' }
const scopeKey = JSON.stringify(['daily', account.platform, account.namespace, account.id, target.kind, target.id])
const historyId = createHash('sha256').update(scopeKey).digest('hex')
const evalCalls = async reader => Number((await reader.info('commandstats')).match(/^cmdstat_eval:calls=(\d+)/mu)?.[1] ?? 0)

async function cli(args, options) {
  try { return { code: 0, ...await runNode(process.execPath, [entry, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024, ...options }) } }
  catch (error) {
    assert.equal(error.killed, false, 'CLI must reject or finish normally, without timing out')
    assert.equal(error.signal, null, 'CLI must not be killed by a signal')
    assert.equal(typeof error.code, 'number', String(error))
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}
function rejected(result) {
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.equal(result.stdout.trim(), '', 'a rejected invocation must not print an applied/preview report')
  assert.match(result.stderr, /\[Agent\]/u)
  assert.doesNotMatch(result.stderr, /Backend output differs|artifacts are unavailable|Backend artifacts are missing/u,
    'artifact failures cannot count as CLI parameter validation')
}
function report(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.stderr.trim(), '')
  return JSON.parse(result.stdout.trim())
}
async function files(root) {
  const result = []
  const visit = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else result.push([path.relative(root, file), (await readFile(file)).toString('base64')])
    }
  }
  await visit(root)
  return result
}

async function fixture(t, name, privateRoom = false) {
  const room = privateRoom ? { ...target, kind: 'private', id: author } : target
  const selectedHistoryId = createHash('sha256').update(JSON.stringify(['daily', account.platform, account.namespace, account.id, room.kind, room.id])).digest('hex')
  assert.equal(qzoneRedisAvailable, true, 'archive CLI verification requires real isolated Redis')
  const { storage: reader } = await createQzoneRedis(t), directory = await mkdtemp(path.join(tmpdir(), 'archive-cli-'))
  const sourceRoot = path.join(directory, 'legacy-plugin'), configRoot = path.join(sourceRoot, 'config'), destinationRoot = path.join(directory, 'standalone')
  const configuredArchive = path.join(sourceRoot, 'custom/old-archive'), selectedArchive = path.join(sourceRoot, 'operator-selected-archive')
  const sourceDataDir = path.join(sourceRoot, 'unrelated-data'), dataDir = path.join(destinationRoot, 'runtime-data')
  const sourceBindings = path.join(configRoot, 'agent-bindings.yaml'), sourceConfig = path.join(configRoot, 'message.yaml')
  const configFile = path.join(destinationRoot, 'agent-host.yaml'), instance = `archive-cli-${name}`, prefix = `bl-agent:${instance}:`
  const actions = [], errors = [], sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  sockets.on('connection', peer => peer.on('message', raw => {
    let echo
    try {
      const request = JSON.parse(String(raw)); echo = request.echo; actions.push(request.action)
      assert.equal(request.action, 'get_login_info', 'offline migration never uses a live QQ connection')
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: Number(account.id), nickname: 'CLI合成验证账号' } }))
    } catch (error) { errors.push(String(error)); if (echo) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
  }))
  t.after(async () => {
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await rm(directory, { recursive: true, force: true })
    assert.deepEqual(errors, [])
  })
  await once(sockets, 'listening')
  await Promise.all([configRoot, destinationRoot, sourceDataDir, path.join(configuredArchive, room.kind, room.id),
    path.join(selectedArchive, room.kind, room.id)].map(directory => mkdir(directory, { recursive: true })))
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: connectionId, platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [target, { ...target, kind: 'private', id: author }].map(room => ({ connectionId, kind: room.kind, conversationId: room.id, agentId: 'daily' })) }
  await Promise.all([writeFile(sourceBindings, JSON.stringify(bindings)), writeFile(path.join(destinationRoot, 'agent-bindings.yaml'), JSON.stringify(bindings)),
    writeFile(sourceConfig, JSON.stringify({ pluginSettings: { simulation: { enabled: false }, messageArchive: { baseDir: 'custom/old-archive' } } })),
    writeFile(configFile, JSON.stringify({ version: 1, instance, dataDir, privateChat: { enabled: true }, history: { enabled: true },
      simulation: { enabled: false }, groupMemory: { enabled: false }, textGroups: [{ connectionId, conversationId: target.id }],
      model: { baseUrl: 'http://127.0.0.1:9/v1', name: 'unused', apiKeyEnv: 'ARCHIVE_CLI_MODEL_KEY' },
      connections: [{ id: connectionId, url: `ws://127.0.0.1:${sockets.address().port}` }] }))])
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${reader.options.socket.path}`, ARCHIVE_CLI_MODEL_KEY: 'synthetic-local-cli-check-key' }
  delete env.BL_CHAT_AGENT_SOURCE_TEST
  const offlineEnv = { ...env }; delete offlineEnv.ARCHIVE_CLI_MODEL_KEY
  const common = ['--config', configFile, '--migrate-qq-state', '--source-bindings', sourceBindings, '--connection', connectionId]
  const group = [...common, '--group', target.id, '--source-config', sourceConfig, '--source-data-dir', sourceDataDir]
  const snapshot = async () => {
    const keys = (await reader.keys('*')).sort()
    return Object.fromEntries(await Promise.all(keys.map(async key => [key, await reader.get(key)])))
  }
  const at = Math.floor(Date.now() / 1000) * 1000 - 60_000
  const original = (mid, text) => ({ version: 1, message_type: room.kind, group_id: privateRoom ? null : target.id, source_bot_id: account.id,
    source_persona_id: 'agent:daily', message_id: mid, user_id: author, sender: { user_id: author, nickname: 'CLI原文作者' },
    timestamp: at, raw_message: text, raw_truncated: false, message: [{ type: 'text', text }], source: null })
  const configured = original('8827', '旧配置目录里的完整原文'), selected = original('-8828', '  显式目录的完整原文。\n保留空白与原始时间。')
  await Promise.all([writeFile(path.join(configuredArchive, room.kind, room.id, '2026-11-17.ndjson'), JSON.stringify(configured) + '\n'),
    writeFile(path.join(selectedArchive, room.kind, room.id, '2026-11-17.ndjson'), JSON.stringify(selected) + '\n')])
  return { reader, directory, sourceRoot, sourceConfig, sourceDataDir, configFile, prefix, dataDir, configuredArchive, selectedArchive, configured, selected, actions, snapshot,
    historyId: selectedHistoryId, target: room,
    run: args => cli(args, { cwd: directory, env }),
    migrate: (extra = [], friend = privateRoom) => cli([...(friend ? [...common, '--friend', author] : group), ...extra], { cwd: directory, env: offlineEnv }),
    async saved() { return JSON.parse(await reader.get(prefix + 'agent:history:v1:state:' + selectedHistoryId) || 'null')?.rows ?? [] },
  }
}

test('actual release CLI help exposes the archive flags without config, credentials or output files', settings, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'archive-cli-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await cli(['--help'], { cwd: directory })
  assert.equal(result.code, 0, result.stderr)
  for (const flag of ['--migrate-qq-state', '--include-message-archive', '--source-archive-dir', '--migrate-legacy-group-archive']) assert.ok(result.stdout.includes(flag), flag)
  assert.equal(result.stderr.trim(), ''); assert.deepEqual(await readdir(directory), [])
})

test('actual release CLI rejects each archive-only flag without migrate before starting a host or running check', settings, async t => {
  const f = await fixture(t, 'requires-migrate')
  // A valid check is the negative control: ignored migration flags would make
  // the same configuration connect successfully and print a check report.
  const control = report(await f.run(['--config', f.configFile, '--check']))
  assert.equal(control.mode, 'check'); assert.deepEqual(f.actions, ['get_login_info'])
  const before = await f.snapshot(), disk = await files(f.sourceRoot), evaluations = await evalCalls(f.reader)
  for (const args of [['--include-message-archive'], ['--source-archive-dir', f.selectedArchive]]) {
    for (const mode of [[], ['--check']]) {
      rejected(await f.run(['--config', f.configFile, ...mode, ...args]))
      assert.deepEqual(await f.snapshot(), before); assert.deepEqual(f.actions, ['get_login_info'])
      assert.equal(await evalCalls(f.reader), evaluations)
    }
  }
  assert.deepEqual(await files(f.sourceRoot), disk); await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('frozen implicit archives require the receiving event, role interval, and both privacy snapshots before atomic continuation', settings, async t => {
  const f = await fixture(t, 'legacy-group')
  const { storage: frozen } = await createQzoneRedis(t)
  const destination = path.dirname(f.configFile)
  const bindingFile = path.join(destination, 'agent-bindings.yaml')
  const bindings = JSON.parse(await readFile(bindingFile, 'utf8'))
  bindings.agents[0].id = 'shiloh'
  for (const binding of bindings.bindings) binding.agentId = 'shiloh'
  await writeFile(bindingFile, JSON.stringify(bindings))
  const config = JSON.parse(await readFile(f.configFile, 'utf8'))
  config.semanticMemory = { enabled: true, groupOnly: true,
    embedding: { baseUrl: 'http://127.0.0.1:9/v1/embeddings', name: 'unused', apiKeyEnv: 'ARCHIVE_CLI_MODEL_KEY' } }
  await writeFile(f.configFile, JSON.stringify(config))
  const source = path.join(f.dataDir, 'legacy-source'), backup = path.join(f.directory, 'backup')
  const archiveDir = path.join(source, 'data/message_archive/group', target.id)
  await Promise.all([archiveDir, path.join(source, 'config'), backup].map(directory => mkdir(directory, { recursive: true })))
  const library = path.join(source, 'config/persona-library.yaml')
  await writeFile(library, JSON.stringify({ personas: [], groupBindings: {}, accountBindings: {} }))
  const at = f.selected.timestamp
  await utimes(library, (at - 1000) / 1000, (at - 1000) / 1000)
  await writeFile(path.join(source, 'config/message.yaml'), JSON.stringify({
    pluginSettings: { enabled: true, enableGroupWhitelist: true, allowedGroups: [target.id] },
  }))
  const original = (id, sender = author, extra = {}) => ({ ...f.selected, message_id: id,
    source_bot_id: undefined, source_persona_id: undefined, user_id: sender,
    sender: { ...f.selected.sender, user_id: sender }, event_id: `v1:${account.id}:message:group:${target.id}:${id}`, ...extra })
  const valid = original('10')
  const rows = [valid, original('11', author, { timestamp: at - 2000 }), original('12', author, { event_id: `v1:19008826:message:group:${target.id}:12` }),
    original('13', '3308828'), original('14', '3308829'), original('15', author, { recalled: true }),
    original('16', '3308830'), original('17', '3308831')]
  const fixtureBytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const archiveFile = path.join(archiveDir, '2026-11-17.ndjson')
  await writeFile(archiveFile, fixtureBytes)
  await runNode('tar', ['-czf', path.join(backup, 'legacy-config-data.tar.gz'), '-C', source, 'config', 'data'])
  await frozen.set(`ytbot:mem:g:${target.id}:meta`, JSON.stringify({ optedOut: ['3308828'] }))
  await frozen.sendCommand(['SAVE'])
  await copyFile(path.join(path.dirname(frozen.options.socket.path), 'dump.rdb'), path.join(backup, 'redis.rdb'))
  const key = JSON.stringify(['shiloh', account.platform, account.namespace, account.id, target.kind, target.id])
  await f.reader.set(`${f.prefix}ytbot:mem:g:agent:${encodeURIComponent(key)}:meta`, JSON.stringify({ optedOut: ['3308829'] }))
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const lastForget = subject => {
    const selector = { agent: digest('shiloh'), account: digest(JSON.stringify([account.platform, account.namespace, account.id])), subject: digest(subject) }
    return JSON.stringify({ version: 1, entries: [{ ...selector, id: digest(selector), through: at }] })
  }
  await f.reader.set(f.prefix + 'agent:history:v1:cleanup', lastForget('3308830'))
  await f.reader.set(f.prefix + 'agent:semantic-memory:v1:cleanup', lastForget('3308831'))
  await f.reader.set(f.prefix + 'agent:host-lease', 'preview-live-lease')
  const flags = ['--config', f.configFile, '--migrate-legacy-group-archive', '--backup-dir', backup, '--connection', connectionId]
  const before = await f.snapshot(), preview = report(await f.run(flags))
  assert.equal(preview.mode, 'preview')
  const [group] = preview.groups
  assert.equal(group.scanned, 8)
  assert.equal(group.imported, 1)
  assert.equal(group.semanticSources, 1)
  assert.equal(group.skipped.identity, 2)
  assert.equal(group.skipped.privacy, 4)
  assert.equal(group.skipped.recalled, 1)
  assert.deepEqual(await f.snapshot(), before)
  rejected(await f.run([...flags, '--apply']))
  assert.deepEqual(await f.snapshot(), before)
  await writeFile(archiveFile, fixtureBytes + '\n')
  rejected(await f.run(flags))
  await writeFile(archiveFile, fixtureBytes)
  await f.reader.del(f.prefix + 'agent:host-lease')
  assert.deepEqual(report(await f.run([...flags, '--apply'])), { ...preview, mode: 'applied' })
  const id = createHash('sha256').update(key).digest('hex')
  const history = JSON.parse(await f.reader.get(f.prefix + 'agent:history:v1:state:' + id))
  const semantic = JSON.parse(await f.reader.get(f.prefix + 'agent:semantic-memory:v1:state:' + id))
  assert.deepEqual(history.rows, [{ messageId: valid.message_id, authorId: author, name: valid.sender.nickname, text: valid.raw_message, at }])
  assert.deepEqual(semantic.rows, history.rows.map(row => ({ ...row, text: row.text.trim() })))
  const applied = await f.snapshot(), again = report(await f.run([...flags, '--apply']))
  assert.equal(again.groups[0].alreadyImported, 1)
  assert.equal(again.groups[0].semanticSources, 0)
  assert.deepEqual(await f.snapshot(), applied)
  assert.equal(await readFile(archiveFile, 'utf8'), fixtureBytes)
  assert.deepEqual(f.actions, [])
})

test('actual release CLI rejects an archive directory without inclusion and private group-only options before writing', settings, async t => {
  const f = await fixture(t, 'scope'), before = await f.snapshot(), disk = await files(f.sourceRoot), evaluations = await evalCalls(f.reader)
  assert.equal(report(await f.migrate([], true)).mode, 'preview', 'the private binding is otherwise valid')
  rejected(await f.migrate(['--source-config', f.sourceConfig], true))
  rejected(await f.migrate(['--include-message-archive', '--source-data-dir', f.sourceDataDir], true))
  rejected(await f.migrate(['--source-archive-dir', f.selectedArchive]))
  assert.deepEqual(await f.snapshot(), before); assert.deepEqual(await files(f.sourceRoot), disk)
  assert.equal(await evalCalls(f.reader), evaluations); assert.deepEqual(f.actions, [])
})

test('actual release CLI previews without writes and applies the explicit archive with one CAS, source retention and idempotence', settings, async t => {
  const f = await fixture(t, 'apply'), delegatedKey = 'bl-chat:delegated:v2:' + encodeURIComponent(scopeKey)
  const delegatedRaw = JSON.stringify([{ id: 'archive-cli-delegated', owner: author, ownerName: 'CLI原文作者', content: '一并交接的托付',
    dueAt: 0, status: 'active', createdAt: f.selected.timestamp, updatedAt: f.selected.timestamp }])
  await f.reader.set(delegatedKey, delegatedRaw)
  const before = await f.snapshot(), disk = await files(f.sourceRoot), evaluations = await evalCalls(f.reader)
  const defaultOff = report(await f.migrate())
  assert.equal(defaultOff.messageArchive, undefined); assert.deepEqual(await f.snapshot(), before)
  const flags = ['--include-message-archive', '--source-archive-dir', f.selectedArchive]
  const preview = report(await f.migrate(flags)), repeatedPreview = report(await f.migrate(flags))
  assert.equal(preview.mode, 'preview'); assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.delegatedMemories, 1)
  assert.deepEqual(repeatedPreview, preview); assert.deepEqual(await f.snapshot(), before)
  assert.equal(await evalCalls(f.reader), evaluations); assert.deepEqual(await files(f.sourceRoot), disk)
  const applied = report(await f.migrate([...flags, '--apply']))
  assert.deepEqual(applied, { ...preview, mode: 'applied' })
  assert.equal(await evalCalls(f.reader), evaluations + 1, 'the real CLI performs one final atomic handover')
  assert.equal(await f.reader.get(delegatedKey), null); assert.equal(await f.reader.get(f.prefix + delegatedKey), delegatedRaw)
  assert.deepEqual(await f.saved(), [{ messageId: f.selected.message_id, authorId: author, name: f.selected.sender.nickname,
    text: f.selected.raw_message, at: f.selected.timestamp }])
  const marker = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + historyId))
  assert.deepEqual(marker.scope, { agentId: 'daily', target }); assert.equal(marker.imported[0].source.file, `group/${target.id}/2026-11-17.ndjson`)
  assert.equal(marker.imported[0].messageId, f.selected.message_id)
  const saved = await f.snapshot(), againPreview = report(await f.migrate(flags)), againApply = report(await f.migrate([...flags, '--apply']))
  assert.equal(againPreview.messageArchive.imported, 0); assert.equal(againPreview.messageArchive.alreadyImported, 1)
  assert.deepEqual(againApply, { ...againPreview, mode: 'applied' }); assert.deepEqual(await f.snapshot(), saved)
  assert.equal(await evalCalls(f.reader), evaluations + 1); assert.deepEqual(await files(f.sourceRoot), disk)
  assert.deepEqual(f.actions, []); await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('actual release CLI explicitly continues only private originals with complete ownership using the configured or selected archive', settings, async t => {
  const f = await fixture(t, 'private-apply', true)
  const file = path.join(f.selectedArchive, 'private', author, '2026-11-17.ndjson')
  const unattributed = { ...f.selected, message_id: '8830' }; delete unattributed.source_persona_id
  await writeFile(file, [f.selected, f.selected, unattributed].map(row => JSON.stringify(row)).join('\n') + '\n')
  const before = await f.snapshot(), disk = await files(f.sourceRoot), evaluations = await evalCalls(f.reader)
  assert.equal(report(await f.migrate()).messageArchive, undefined)
  const configured = report(await f.migrate(['--include-message-archive', '--source-config', f.sourceConfig]))
  assert.equal(configured.friendId, author); assert.equal(configured.messageArchive.imported, 1)
  const flags = ['--include-message-archive', '--source-config', f.sourceConfig, '--source-archive-dir', f.selectedArchive]
  const preview = report(await f.migrate(flags))
  assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.messageArchive.duplicates, 1); assert.equal(preview.messageArchive.skipped.identity, 1)
  assert.deepEqual(await f.snapshot(), before); assert.equal(await evalCalls(f.reader), evaluations)
  assert.deepEqual(report(await f.migrate([...flags, '--apply'])), { ...preview, mode: 'applied' })
  assert.equal(await evalCalls(f.reader), evaluations + 1)
  assert.deepEqual(await f.saved(), [{ messageId: f.selected.message_id, authorId: author, peerId: author, name: f.selected.sender.nickname,
    text: f.selected.raw_message, at: f.selected.timestamp }])
  const marker = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + f.historyId))
  assert.deepEqual(marker.scope, { agentId: 'daily', target: f.target }); assert.equal(marker.imported[0].source.file, `private/${author}/2026-11-17.ndjson`)
  const saved = await f.snapshot(), repeated = report(await f.migrate([...flags, '--apply']))
  assert.equal(repeated.messageArchive.alreadyImported, 1); assert.equal(repeated.messageArchive.imported, 0)
  assert.deepEqual(await f.snapshot(), saved); assert.equal(await evalCalls(f.reader), evaluations + 1)
  assert.deepEqual(await files(f.sourceRoot), disk); assert.deepEqual(f.actions, []); await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})
