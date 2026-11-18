import assert from 'node:assert/strict'
import { mkdtemp, lstat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneMagnetSearchConfig: read } = await load('bootstrap/standaloneMagnetSearch.js')
const { readStandaloneAgentConfig } = await load('bootstrap/standaloneAgentConfig.js')
const { createAgentMagnetSearchProvider: provider } = await load('modules/media/infrastructure/agentMagnetSearchProvider.js')
const { createAgentMagnetSearchTools: tools } = await load('modules/tools/infrastructure/agentMagnetSearchTools.js')
const { parseAgentMagnetSearchCommand: parse } = await load('modules/media/domain/agentMagnetSearchCommand.js')
const hash = 'a'.repeat(40), otherHash = 'b'.repeat(40)
const guard = signal => ({ signal: signal ?? new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const response = body => ({ status: 200, headers: {}, body: JSON.stringify(body) })
const csv = [{ infohash: hash, name: 'Ubuntu ISO', size_bytes: 1024, seeders: 4 }]
const html = `<div class="search-result"><a href="/torrent/ubuntu">Ubuntu mirror</a><a href="magnet:?xt=urn:btih:${otherHash}">Magnet</a></div>`

test('magnet config is explicit, pure and closed; command aliases retain default and maximum limits', () => {
  assert.equal(read(undefined).enabled, false); assert.equal(read({ enabled: false }).proxyUrl, '')
  assert.equal(read({ enabled: true }).proxyUrl, ''); assert.ok(Object.isFrozen(read({ enabled: true })))
  let touched = false
  for (const input of [null, [], {}, { enabled: 'true' }, { enabled: true, token: 'secret' }, { enabled: true, proxyUrl: true },
    { enabled: true, timeoutMs: 999 }, { enabled: true, searchUrl: 'https://127.0.0.1/search' }, { enabled: true, searchUrl: 'https://private:secret@index.example/search' },
    { get enabled() { touched = true; return true } }, new Proxy({}, { ownKeys() { touched = true; return [] } })]) assert.throws(() => read(input))
  assert.equal(touched, false)
  assert.deepEqual(parse('.磁力 ubuntu'), { keyword: 'ubuntu', limit: 10 })
  assert.deepEqual(parse(' 。磁链搜索 ubuntu linux 99 '), { keyword: 'ubuntu linux', limit: 20 })
  assert.deepEqual(parse('.磁力搜索'), { help: true }); assert.equal(parse('磁力 ubuntu'), undefined)
})

test('standalone config registers search explicitly and accepts scoped text tools without opening its data dir', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-magnet-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), raw = { version: 1, instance: 'magnet-config', dataDir: 'untouched-data',
    model: { baseUrl: 'https://main.example/v1', name: 'main', apiKeyEnv: 'MODEL_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
    tools: { magnetSearch: { enabled: true } }, textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['searchMagnetTool'] }] }
  await writeFile(file, JSON.stringify(raw))
  const config = readStandaloneAgentConfig(file, { MODEL_KEY: 'fixture-model-key' })
  assert.equal(config.tools.magnetSearch.enabled, true); assert.equal(config.isConfigCurrent(), true)
  assert.equal(config.torrentDownload.enabled, false)
  await assert.rejects(lstat(path.join(directory, 'untouched-data')), { code: 'ENOENT' })
  await writeFile(file, JSON.stringify({ ...raw, tools: { magnetSearch: { enabled: false } } }))
  assert.equal(config.isConfigCurrent(), false); assert.equal(readStandaloneAgentConfig(file, { MODEL_KEY: 'fixture-model-key' }).tools.magnetSearch, undefined)
})

test('CSV stays direct, only configured supplementary sources use proxy, partial failures keep successful results', async () => {
  const direct = [], proxied = []
  const service = provider(read({ enabled: true, proxyUrl: 'http://127.0.0.1:7890' }), { lookup,
    request: async url => { direct.push(url); return response(csv) },
    proxyFetchImpl: async url => { proxied.push(new URL(url)); throw Error('optional index unavailable') } })
  const text = await service.search({ keyword: 'ubuntu' }, guard())
  assert.match(text, /Ubuntu ISO/u); assert.match(text, new RegExp(`magnet:\\?xt=urn:btih:${hash}`))
  assert.equal(direct.length, 1); assert.equal(direct[0].hostname, 'torrents-csv.com')
  assert.deepEqual(proxied.map(url => url.hostname).sort(), ['bitsearch.eu', 'solidtorrents.to'])
  assert.equal(text.includes('optional index unavailable'), false)
  const noProxy = provider(read({ enabled: true }), { lookup, request: async () => response(csv), proxyFetchImpl: async () => assert.fail('proxy not declared') })
  assert.match(await noProxy.search({ keyword: 'ubuntu' }, guard()), /Ubuntu ISO/u)
})

test('one source timing out still returns a completed sibling rather than cancelling the merge', async t => {
  // Use fake timers only for Client source timeouts, after proxy content has settled.
  const timers = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => { const timer = original(fn, ms === 1000 ? 25 : ms, ...args); timers.push(timer); return timer }
  t.after(() => { globalThis.setTimeout = original; for (const timer of timers) clearTimeout(timer) })
  const service = provider(read({ enabled: true, timeoutMs: 1000, proxyTimeoutMs: 1000, proxyUrl: 'http://127.0.0.1:7890' }), {
    lookup, request: () => new Promise(() => {}),
    proxyFetchImpl: async url => new URL(url).hostname === 'solidtorrents.to' ? new Response(JSON.stringify({ results: csv })) : new Response(html),
  })
  assert.match(await service.search({ keyword: 'ubuntu' }, guard()), /Ubuntu/u)
})

test('provider cancellation and disable stop external work and responses cannot return secrets', async () => {
  let requests = 0, start
  const started = new Promise(resolve => { start = resolve })
  const disabled = provider(read({ enabled: false }), { lookup, request: async () => { requests++; return response(csv) } })
  await assert.rejects(disabled.search({ keyword: 'ubuntu' }, guard())); assert.equal(requests, 0)
  const service = provider(read({ enabled: true }), { lookup, request: () => { requests++; start(); return new Promise(() => {}) } })
  const cancel = new AbortController(), pending = service.search({ keyword: 'ubuntu' }, guard(cancel.signal))
  await started; cancel.abort(); await assert.rejects(pending)
  const secret = 'private-fixture-token', leaked = provider(read({ enabled: true }), { lookup, secrets: [secret], request: async () => response([{ ...csv[0], name: secret }]) })
  await assert.rejects(leaked.search({ keyword: 'ubuntu' }, guard()), error => !String(error).includes(secret))
  await assert.rejects(leaked.search({ keyword: secret }, guard()), error => !String(error).includes(secret))
})

test('Core tool uses the same cancellable provider, validates bounded inputs and exposes no identity or destination arguments', async () => {
  const calls = [], { builtIn: [tool] } = tools({ enabled: true }, { provider: { async search(input, scope) { calls.push({ input, scope }); return '公开结果，不下载' } } })
  assert.deepEqual(tools({ enabled: false }, { provider: {} }).builtIn, [])
  const context = { ...guard(), binding: { agentId: 'role' }, actor: { kind: 'user' } }
  assert.equal((await tool.execute({ keyword: 'ubuntu', limit: 5 }, context)).status, 'succeeded')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].input, { keyword: 'ubuntu', limit: 5 }); assert.equal(calls[0].scope, context)
  for (const input of [{ keyword: 'ubuntu', target: 'other' }, { keyword: 'ubuntu', limit: 21 }, { keyword: '' }]) assert.equal((await tool.execute(input, context)).status, 'failed')
  assert.equal(calls.length, 1)
})
