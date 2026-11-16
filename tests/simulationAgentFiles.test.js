import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimulationAgentFiles, normalizeSimulationMessageFiles, simulationFileMetadata } from '../dist/backend/modules/simulation/infrastructure/simulationAgentFiles.js'
import { compactSimMessage } from '../dist/backend/modules/simulation/domain/messageView.js'

const at = 1_800_000_000_000
const account = { platform: 'fixture', namespace: 'files', id: 'robot' }
const target = { account, kind: 'group', id: 'room' }
const sender = { ...account, id: 'human' }
const bytes = { name: 'budget.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: 'ZmlsZQ==' }
const row = (seq, names = [], extra = {}) => ({ seq, messageId: `message-${seq}`, userId: sender.id, name: '本人', text: '请查看文件', at: at - 1000 + seq,
  atSelf: true, quoteToSelf: false, imageCount: 0, kind: 'text', ...(names.length ? { files: names.map(name => ({ name })) } : {}), ...extra })
const incoming = (message, names = message.files?.map(file => file.name) ?? []) => ({ version: 1, conversation: target, sender: { ...sender, id: message.userId },
  messageId: String(message.messageId), occurredAt: message.at, text: message.text, parts: names.map(name => ({ kind: 'file', name })), mentions: [], directedToAccount: true })

function fixture(options = {}) {
  const request = options.request ?? row(40, options.names ?? ['budget.xlsx'])
  const messages = options.messages ?? [request]
  const reads = [], projections = [], blocked = new Set()
  let current = true, ephemeral = 0
  let catalog = { target, observedAt: at, files: options.catalog ?? [], truncated: false }
  const context = {
    target, actorId: sender.id, request, now: () => at, messages: () => messages,
    isVisible: seq => (options.visible ?? [request.seq]).includes(seq), isCurrent: () => current,
    async ensureCurrent() { if (!current) throw new Error('revoked') }, markEphemeral() { ephemeral++ }, registerProjection(p) { projections.push(p) },
    async loadMessage(source) {
      if (blocked.has(source.messageId) || !messages.includes(source.wrapper)) return undefined
      if (source.quoted) return { ...incoming(source.wrapper, source.files.map(file => file.name)), messageId: source.messageId,
        sender: { ...sender, id: source.authorId }, occurredAt: source.occurredAt }
      return incoming(source.wrapper)
    },
    async allowsSource(source, original) { return !blocked.has(source.messageId) && original.messageId === source.messageId },
    async allowsRepositoryFile(entry) { return !blocked.has(entry.reference) },
    async readMessageFile(_target, source, fileIndex, guard) {
      reads.push({ kind: 'message', source, fileIndex })
      await guard.ensureCurrent?.()
      const original = { messageId: source.quotedMessageId ?? source.messageId }
      assert.equal(await guard.allowsSource(original), true)
      await options.afterRead?.({ blocked, source })
      return bytes
    },
    async listConversationFiles(_target, guard) { await guard.ensureCurrent?.(); return structuredClone(catalog) },
    async readConversationFile(_target, entry, guard) {
      reads.push({ kind: 'repository', entry: structuredClone(entry) })
      assert.equal(await guard.allowsFile(entry), true)
      return bytes
    },
    async readPublicFile(url, guard) { await guard.ensureCurrent?.(); reads.push({ kind: 'public', url }); return bytes },
  }
  const resolver = createSimulationAgentFiles(context)
  const read = (input = {}, controller = new AbortController()) => resolver.readFile(input, () => true, controller.signal)
  return { ...resolver, read, reads, projections, blocked, messages, request, context,
    catalog(value) { catalog = { ...catalog, ...value } }, revoke() { current = false }, get ephemeral() { return ephemeral } }
}

test('file metadata and views retain bounded names without provider resources, including quoted files', () => {
  const parts = [{ kind: 'file', name: ' budget.xlsx\n', resource: { kind: 'url', value: 'https://provider/secret' } },
    { kind: 'file', name: 'https://provider/token' }, ...Array.from({ length: 25 }, () => ({ kind: 'file' }))]
  const metadata = simulationFileMetadata(parts)
  assert.equal(metadata.length, 20); assert.deepEqual(metadata.slice(0, 2), [{ name: 'budget.xlsx' }, { name: '文件2' }])
  assert.doesNotMatch(JSON.stringify(metadata), /provider|secret|resource/u)
  const message = row(1, ['direct.xlsx'], { quoteAuthor: '引用作者', quoteSource: { messageId: 'quoted', invalidatedAt: 0,
    file: { files: [{ name: 'quoted.xlsx', resource: 'must-not-persist' }], authorId: 'other', occurredAt: at - 2000 } } })
  message.files[0].base64 = 'must-not-persist'
  const normalized = normalizeSimulationMessageFiles(message)
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-persist/u)
  const view = compactSimMessage(normalized, at)
  assert.match(view, /1.direct.xlsx/u); assert.match(view, /引用文件：1.quoted.xlsx/u); assert.match(view, /本条序号仅读直接文件/u)
})

test('explicit URLs require an exact token in freshly verified current human text', async () => {
  const url = 'https://public.example/budget.xlsx'
  const f = fixture({ request: row(40, ['current.xlsx'], { text: `查看 ${url}，帮我计算。` }) })
  assert.equal((await f.read({ fileUrl: url })).origin, 'explicit')
  assert.deepEqual(f.reads, [{ kind: 'public', url }])
  assert.equal((await f.read({ fileUrl: url, fileName: 'chosen.xlsx' })).name, 'chosen.xlsx')
  await assert.rejects(f.read({ fileUrl: 'https://public.example/budget' }), /原文明确提供/u)
  await assert.rejects(f.read({ fileUrl: 'https://other.example/a.xlsx' }), /原文明确提供/u)
  await assert.rejects(f.read({ fileUrl: url, sourceSeq: 40 }), /一种文件来源/u)
  f.request.text = '现在没有链接'
  assert.equal(await f.projections[0].isCurrent(), false)
})

test('automatic resolution uses current, then verified reply, then only the human recent files', async () => {
  const current = fixture()
  assert.equal((await current.read()).origin, 'current')
  const request = row(40, [], { quoteSource: { messageId: 'quoted', invalidatedAt: 0,
    file: { files: [{ name: 'quoted.xlsx' }], authorId: 'other-human', occurredAt: at - 2000 } } })
  const quoted = fixture({ request })
  assert.equal((await quoted.read()).origin, 'reply')
  assert.deepEqual(quoted.reads[0].source, { messageId: request.messageId, quotedMessageId: 'quoted' })
  const trigger = row(40)
  const recent = fixture({ request: trigger, messages: [row(1, ['too-old.xlsx'], { at: at - 31 * 60_000 }),
    row(2, ['someone-else.xlsx'], { userId: 'other' }), row(3, ['mine.xlsx']), trigger] })
  assert.equal((await recent.read()).origin, 'recent')
  assert.equal(recent.reads[0].source.messageId, 'message-3')
})

test('automatic recent lookup is bounded to thirty own messages and thirty minutes', async () => {
  const trigger = row(40), old = row(1, ['old.xlsx'])
  const messages = [old, ...Array.from({ length: 30 }, (_, index) => row(index + 2)), trigger]
  const f = fixture({ request: trigger, messages })
  await assert.rejects(f.read(), /没有找到|没有.*文件/u)
  assert.deepEqual(f.reads, [])
})

test('sourceSeq requires current visibility and fixes the direct source without quote fallback', async () => {
  const request = row(40, ['direct.xlsx'], { quoteSource: { messageId: 'quoted', invalidatedAt: 0,
    file: { files: [{ name: 'quoted.xlsx' }], authorId: 'other-human', occurredAt: at - 2000 } } })
  const f = fixture({ request, messages: [row(2, ['hidden.xlsx']), request] })
  await assert.rejects(f.read({ sourceSeq: 2 }), /本轮可见/u)
  await assert.rejects(f.read({ sourceSeq: 40, fileName: 'quoted.xlsx' }), /未切换/u)
  await assert.rejects(f.read({ sourceSeq: 40, fileIndex: 2 }), /附件序号/u)
  assert.deepEqual(f.reads, [])
  assert.equal((await f.read({ sourceSeq: 40, fileIndex: 1 })).origin, 'current')
  assert.equal(f.reads[0].source.quotedMessageId, undefined)
})

test('ambiguous current, own recent, and repository names fail without guessing', async () => {
  await assert.rejects(fixture({ names: ['a.xlsx', 'b.xlsx'] }).read(), /多个/u)
  const request = row(40)
  const recent = fixture({ request, messages: [row(1, ['same.xlsx']), row(2, ['same.xlsx']), request] })
  await assert.rejects(recent.read({ fileName: 'same.xlsx' }), /多个/u)
  const entries = ['one', 'two'].map((reference, index) => ({ reference, name: 'same.xlsx', folderPath: `/folder${index}`, size: 4 }))
  const repo = fixture({ names: [], catalog: entries })
  await assert.rejects(repo.read({ fileName: 'same.xlsx' }), /歧义/u)
  assert.equal((await repo.read({ fileName: 'same.xlsx', folderPath: '/folder1' })).origin, 'group_file')
})

test('new uploads can be found by verified uploader and time; another user upload is never implicit', async () => {
  const entry = { reference: 'opaque-file', name: 'uploaded.xlsx', folderPath: '/', size: 4, uploadedBy: sender, uploadedAt: at - 2000 }
  const f = fixture({ names: [], catalog: [entry] })
  assert.equal((await f.read()).origin, 'group_file')
  const other = fixture({ names: [], catalog: [{ ...entry, uploadedBy: { ...sender, id: 'other' } }] })
  await assert.rejects(other.read(), /没有找到/u)
  const stale = fixture({ names: [], catalog: [{ ...entry, uploadedAt: at - 31 * 60_000 }] })
  await assert.rejects(stale.read(), /没有找到/u)
})

test('message projections survive tool timeout but reject source removal before bytes return or later use', async () => {
  const controller = new AbortController(), f = fixture()
  await f.read({}, controller)
  controller.abort()
  assert.equal(await f.projections[0].isCurrent(), true, 'the projection uses turn lifetime, not a completed tool signal')
  f.blocked.add(f.request.messageId)
  assert.equal(await f.projections[0].isCurrent(), false)
  const late = fixture({ async afterRead({ blocked, source }) { blocked.add(source.messageId) } })
  await assert.rejects(late.read(), /已改变|已撤回/u)
  assert.equal(late.ephemeral, 1)
})

test('repository projections re-list the exact entry and reject replacement or new name ambiguity', async () => {
  const entry = { reference: 'opaque-file', name: 'budget.xlsx', folderPath: '/', size: 4 }
  for (const mode of ['replace', 'duplicate', 'truncated']) {
    const f = fixture({ names: [], catalog: [entry] }), controller = new AbortController()
    await f.read({ fileName: entry.name }, controller); controller.abort()
    assert.equal(await f.projections[0].isCurrent(), true)
    f.catalog(mode === 'replace' ? { files: [{ ...entry, reference: 'new-file' }] } : mode === 'duplicate'
      ? { files: [entry, { ...entry, reference: 'second-file' }] } : { truncated: true })
    assert.equal(await f.projections[0].isCurrent(), false, mode)
  }
})

test('listing exposes only temporary display metadata and rechecks catalog changes', async () => {
  const entry = { reference: 'private-provider-id', name: 'budget.xlsx', folderPath: '/reports', size: 4, uploadedBy: sender, uploadedAt: at - 2000 }
  const f = fixture({ names: [], catalog: [entry] }), controller = new AbortController()
  const result = await f.listFiles({ query: 'budget' }, () => true, controller.signal)
  assert.deepEqual(result, { files: [{ name: entry.name, folderPath: entry.folderPath, size: 4 }], totalFiles: 1, truncated: false })
  assert.doesNotMatch(JSON.stringify(result), /private-provider|uploadedBy|uploadedAt/u)
  controller.abort(); assert.equal(await f.projections[0].isCurrent(), true)
  f.catalog({ files: [] }); assert.equal(await f.projections[0].isCurrent(), false)
})

test('malformed source selectors are rejected and all failed reads are marked ephemeral first', async () => {
  const f = fixture()
  for (const input of [{ sourceSeq: 0 }, { sourceSeq: '40' }, { sourceSeq: 1.1 }, { fileIndex: 0 }, { fileIndex: 1.5 }, { fileIndex: '1' }, { fileName: '' }, { unexpected: true }]) await assert.rejects(f.read(input))
  assert.equal(f.ephemeral, 8); assert.deepEqual(f.reads, [])
  f.revoke(); await assert.rejects(f.read(), /失效/u)
})

test('tool extension hints filter candidates before source priority and preserve true attachment indices', async () => {
  const request = row(40, ['notes.pdf'], { quoteSource: { messageId: 'quoted', invalidatedAt: 0,
    file: { files: [{ name: 'picture.png' }, { name: 'quoted.XLSX' }], authorId: 'other-human', occurredAt: at - 2000 } } })
  const f = fixture({ request })
  assert.equal((await f.read({ extensions: ['.xlsx'] })).origin, 'reply')
  assert.equal(f.reads[0].fileIndex, 2)
  await assert.rejects(f.read({ sourceSeq: request.seq, extensions: ['.xlsx'] }), /未切换/u)
  const trigger = row(40), recent = fixture({ request: trigger, messages: [row(1, ['a.png']), row(2, ['mine.xlsx']), trigger] })
  assert.equal((await recent.read({ extensions: ['.xlsx'] })).origin, 'recent')
  assert.equal(recent.reads[0].source.messageId, 'message-2')
})

test('directory filtering honors uploader privacy and retains all bounded names for downstream format totals', async () => {
  const entries = Array.from({ length: 150 }, (_, index) => ({ reference: `file-${index}`, name: `${'long'.repeat(45)}-${index}.xlsx`, folderPath: '/', size: 4 }))
  const f = fixture({ names: [], catalog: entries })
  f.blocked.add('file-2')
  const listing = await f.listFiles({}, () => true, new AbortController().signal)
  assert.equal(listing.files.length, 149); assert.equal(listing.totalFiles, 149)
  assert.equal(listing.files[0].name, entries[0].name)
  assert.equal(listing.files.some(entry => entry.name === entries[2].name), false)
  f.blocked.add('file-3'); assert.equal(await f.projections[0].isCurrent(), false)
})

test('repository directory selection accepts optional root/trailing slashes and case without broadening to sibling paths', async () => {
  const entry = { reference: 'report', name: 'budget.xlsx', folderPath: '/资料/Reports/', size: 4 }
  for (const path of ['/资料/Reports', '资料/reports/', '//资料//REPORTS//']) {
    const f = fixture({ names: [], catalog: [entry, { ...entry, reference: 'sibling', folderPath: '/资料/Reports-Other/' }] })
    assert.equal((await f.read({ fileName: entry.name, folderPath: path })).origin, 'group_file')
    assert.equal(f.reads[0].entry.reference, 'report')
    const listing = await f.listFiles({ folderPath: path }, () => true, new AbortController().signal)
    assert.equal(listing.files.length, 1); assert.equal(listing.files[0].folderPath, entry.folderPath)
  }
  const wrong = fixture({ names: [], catalog: [entry] })
  await assert.rejects(wrong.read({ fileName: entry.name, folderPath: '/资料/Reports-Other' }), /没有找到/u)
  const root = fixture({ names: [], catalog: [{ ...entry, folderPath: '/' }] })
  assert.equal((await root.read({ fileName: entry.name, folderPath: '///' })).origin, 'group_file')
})

test('canonical path collisions are rejected and later duplicate directories revoke an existing projection', async () => {
  const entry = { reference: 'one', name: 'budget.xlsx', folderPath: '/资料/', size: 4 }
  const duplicate = { ...entry, reference: 'two', folderPath: '资料' }
  await assert.rejects(fixture({ names: [], catalog: [entry, duplicate] }).read({ fileName: entry.name, folderPath: '/资料' }), /歧义/u)
  const f = fixture({ names: [], catalog: [entry] })
  await f.read({ fileName: entry.name, folderPath: '资料' })
  f.catalog({ files: [{ ...entry, folderPath: '资料' }] })
  assert.equal(await f.projections[0].isCurrent(), true, 'only path spelling changed')
  f.catalog({ files: [entry, duplicate] })
  assert.equal(await f.projections[0].isCurrent(), false)
})
