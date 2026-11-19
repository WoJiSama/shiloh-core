import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { migrateAgentEmoji } from '../scripts/migrate-agent-emoji.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const archiveSha256 = 'a'.repeat(64)
const encoded = rows => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n'
const png = (red = 1) => sharp({ create: { width: 8, height: 8, channels: 4, background: { r: red, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
function record(bytes, extra = {}) {
  const hash = sha(bytes)
  return { hash, file: `emoji_files/${hash}.png`, tags: ['private-tag-fixture'], useCases: ['private-use-case-fixture'],
    description: 'private-description-fixture', embedding: [0.25, 0.5], usedCount: 7,
    lastUsedAt: '2026-08-10T08:00:00.000Z', registeredAt: '2026-07-10T08:00:00.000Z',
    source: 'auto', isBanned: false, noFileFlag: false, ...extra }
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'bl-emoji-migration-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'database'), images = path.join(source, 'emoji_files')
  fs.mkdirSync(images, { recursive: true, mode: 0o700 })
  const options = { source, dataDir: path.join(directory, 'candidate'), agentId: 'fixture-agent', archiveSha256,
    indexSha256: '', receipt: path.join(directory, 'receipt.json') }
  return { directory, source, images, options,
    index(rows) { const bytes = Buffer.from(encoded(rows)); fs.writeFileSync(path.join(source, 'emoji-packs.ndjson'), bytes); options.indexSha256 = sha(bytes) },
    image(row, bytes) { fs.writeFileSync(path.join(images, path.basename(row.file)), bytes) },
    partition() { return path.join(options.dataDir, 'emoji/agents', sha(options.agentId)) } }
}
function assertNoTemporary(f) {
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.migrate-agent-emoji-')), false)
}
function cliArgs(options) {
  return Object.entries({ '--source': options.source, '--data-dir': options.dataDir, '--agent-id': options.agentId,
    '--archive-sha256': options.archiveSha256, '--index-sha256': options.indexSha256, '--receipt': options.receipt }).flat()
}

test('offline candidate preserves metadata and safety flags, clears embeddings, and separates usable images from retained missing records', async t => {
  const f = fixture(t), first = await png(), second = await png(2), orphan = await png(3)
  const available = record(first), banned = record(second, { isBanned: true, source: 'manual', usedCount: 29 }), missing = record(await png(4), { source: 'maintenance' })
  f.index([available, banned, missing]); f.image(available, first); f.image(banned, second); f.image(record(orphan), orphan)
  const result = await migrateAgentEmoji(f.options)
  assert.deepEqual(result.counts, { inputRecords: 3, invalidRecords: 0, duplicateRecords: 0, duplicateHashes: 0,
    outputRecords: 3, copiedImages: 2, availableRecords: 1, bannedRecords: 1, disabledRecords: 2,
    missingImages: 1, invalidImages: 0, hashMismatches: 0, orphanImages: 1, invalidFiles: 0, embeddingsCleared: 3,
    bytesCopied: first.length + second.length })
  assert.equal(result.candidateOnly, true); assert.equal(result.deliveryAttempted, false)
  assert.equal(result.archiveDigestVerification, 'caller-supplied'); assert.equal(result.indexDigestVerified, true)
  const index = fs.readFileSync(path.join(f.partition(), 'emoji-packs.ndjson'))
  const rows = index.toString().trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows[0], { ...available, embedding: null, source: `legacy-archive:${archiveSha256}` })
  assert.deepEqual(rows[1], { ...banned, embedding: null, source: `legacy-archive:${archiveSha256}` })
  assert.deepEqual(rows[2], { ...missing, embedding: null, source: `legacy-archive:${archiveSha256}`, noFileFlag: true })
  assert.deepEqual(fs.readdirSync(path.join(f.partition(), 'emoji_files')).sort(), [path.basename(available.file), path.basename(banned.file)].sort())
  assert.deepEqual(fs.readFileSync(path.join(f.partition(), available.file)), first)
  const provenanceBytes = fs.readFileSync(path.join(f.partition(), 'legacy-provenance.json'))
  const provenance = JSON.parse(provenanceBytes)
  assert.deepEqual(provenance.records.map(row => row.originalSource), ['auto', 'manual', 'maintenance'])
  assert.deepEqual(provenance.records.map(row => row.imageStatus), ['verified', 'verified', 'missing'])
  for (const bytes of [provenanceBytes, fs.readFileSync(f.options.receipt)]) {
    assert.doesNotMatch(bytes.toString(), /private-tag-fixture|private-use-case-fixture|private-description-fixture|messageId|authorId/u)
  }
  assert.equal(result.outputIndexSha256, sha(index)); assert.equal(result.provenanceSha256, sha(provenanceBytes))
  assert.deepEqual(JSON.parse(fs.readFileSync(f.options.receipt)), result)
  for (const name of ['emoji-packs.ndjson', 'legacy-provenance.json']) assert.equal(fs.statSync(path.join(f.partition(), name)).mode & 0o777, 0o600)
  assert.equal(fs.statSync(f.options.dataDir).mode & 0o777, 0o700)
  assertNoTemporary(f)
})

test('duplicate hashes are excluded as a group; alternate extensions never fill a missing path and mismatched bytes never copy', async t => {
  const f = fixture(t), duplicate = await png(10), alternate = await png(11), wrong = await png(12)
  const dupe = record(duplicate), dupeOther = { ...dupe, file: `emoji_files/${dupe.hash}.jpg`, isBanned: true }
  const missing = record(alternate, { file: `emoji_files/${sha(alternate)}.gif` }), mismatch = record(await png(13))
  f.image(dupe, duplicate); f.image(dupeOther, duplicate); f.image(record(alternate), alternate); f.image(mismatch, wrong)
  f.index([dupe, dupeOther, missing, mismatch, '{not-json', { ...record(await png(14)), file: '../../private-file.png' }, { ...record(await png(15)), isBanned: 'true' }])
  const result = await migrateAgentEmoji(f.options)
  assert.equal(result.counts.inputRecords, 7); assert.equal(result.counts.invalidRecords, 3)
  assert.equal(result.counts.duplicateRecords, 2); assert.equal(result.counts.duplicateHashes, 1)
  assert.equal(result.counts.outputRecords, 2); assert.equal(result.counts.copiedImages, 0)
  assert.equal(result.counts.missingImages, 1); assert.equal(result.counts.invalidImages, 1); assert.equal(result.counts.hashMismatches, 1)
  assert.equal(result.counts.orphanImages, 3); assert.equal(result.counts.availableRecords, 0)
  const rows = fs.readFileSync(path.join(f.partition(), 'emoji-packs.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.every(row => row.noFileFlag === true), true)
  assert.deepEqual(fs.readdirSync(path.join(f.partition(), 'emoji_files')), [])
})

test('correct content hashes do not admit corrupt, oversized, MIME-mismatched, or unsafe-dimension images', async t => {
  const f = fixture(t), valid = await png(20)
  const wide = await sharp({ create: { width: 16_385, height: 1, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const images = [Buffer.from('not an image'), valid.subarray(0, 40), Buffer.alloc(5 * 1024 * 1024 + 1), wide, valid]
  const rows = images.map((bytes, index) => record(bytes, index === 4 ? { file: `emoji_files/${sha(bytes)}.jpg` } : {}))
  f.index(rows); rows.forEach((row, index) => f.image(row, images[index]))
  const result = await migrateAgentEmoji(f.options)
  assert.equal(result.counts.outputRecords, 5); assert.equal(result.counts.invalidImages, 5)
  assert.equal(result.counts.hashMismatches, 0); assert.equal(result.counts.copiedImages, 0)
  assert.equal(result.counts.availableRecords, 0); assert.equal(result.counts.disabledRecords, 5)
})

test('malformed metadata in a duplicate cannot reactivate another row for the same hash', async t => {
  const f = fixture(t), bytes = await png(25), row = record(bytes)
  f.index([row, { ...row, isBanned: true, tags: ['tag', 123] }]); f.image(row, bytes)
  const result = await migrateAgentEmoji(f.options)
  assert.equal(result.counts.inputRecords, 2); assert.equal(result.counts.invalidRecords, 1)
  assert.equal(result.counts.duplicateRecords, 1); assert.equal(result.counts.duplicateHashes, 1)
  assert.equal(result.counts.outputRecords, 0); assert.equal(result.counts.copiedImages, 0)
  assert.equal(result.counts.availableRecords, 0); assert.equal(result.counts.orphanImages, 1)
})

test('image symlinks and hardlinks are not read and unknown source text cannot enter provenance', async t => {
  const f = fixture(t), bytes = await png(30), other = await png(31)
  const linked = record(bytes, { source: 'private-source-body-fixture' }), hardlinked = record(other)
  const outside = path.join(f.directory, 'outside.png'), outsideHard = path.join(f.directory, 'outside-hard.png')
  fs.writeFileSync(outside, bytes); fs.writeFileSync(outsideHard, other)
  fs.symlinkSync(outside, path.join(f.images, path.basename(linked.file)))
  fs.linkSync(outsideHard, path.join(f.images, path.basename(hardlinked.file)))
  fs.writeFileSync(path.join(f.images, 'free-path.txt'), 'private-extra-file-fixture')
  f.index([linked, hardlinked])
  const result = await migrateAgentEmoji(f.options)
  assert.equal(result.counts.invalidFiles, 3); assert.equal(result.counts.invalidImages, 2)
  assert.equal(result.counts.copiedImages, 0)
  const provenance = fs.readFileSync(path.join(f.partition(), 'legacy-provenance.json'), 'utf8')
  assert.doesNotMatch(provenance, /private-source-body-fixture|private-extra-file-fixture/u)
  assert.equal(JSON.parse(provenance).records[0].originalSource, 'other')
  assert.deepEqual(fs.readFileSync(outside), bytes); assert.deepEqual(fs.readFileSync(outsideHard), other)
})

test('index identity, path authority, and existing outputs are checked before writes', async t => {
  for (const scenario of ['digest', 'source-link', 'index-link', 'images-link', 'target', 'receipt', 'overlap', 'relative-receipt', 'invalid-agent']) {
    await t.test(scenario, async child => {
      const f = fixture(child), bytes = await png(40), row = record(bytes)
      f.index([row]); f.image(row, bytes)
      if (scenario === 'digest') f.options.indexSha256 = 'b'.repeat(64)
      if (scenario === 'source-link') { const alias = path.join(f.directory, 'alias'); fs.symlinkSync(f.source, alias); f.options.source = alias }
      if (scenario === 'index-link') {
        const original = path.join(f.directory, 'original.ndjson'); fs.renameSync(path.join(f.source, 'emoji-packs.ndjson'), original)
        fs.symlinkSync(original, path.join(f.source, 'emoji-packs.ndjson'))
      }
      if (scenario === 'images-link') {
        const original = path.join(f.directory, 'original-images'); fs.renameSync(f.images, original); fs.symlinkSync(original, f.images)
      }
      if (scenario === 'target') { fs.mkdirSync(f.options.dataDir); fs.writeFileSync(path.join(f.options.dataDir, 'untouched'), 'original') }
      if (scenario === 'receipt') fs.writeFileSync(f.options.receipt, 'original-receipt')
      if (scenario === 'overlap') f.options.dataDir = path.join(f.source, 'candidate')
      if (scenario === 'relative-receipt') f.options.receipt = 'relative-receipt.json'
      if (scenario === 'invalid-agent') f.options.agentId = '../other-agent'
      await assert.rejects(migrateAgentEmoji(f.options))
      if (scenario === 'target') assert.equal(fs.readFileSync(path.join(f.options.dataDir, 'untouched'), 'utf8'), 'original')
      else assert.equal(fs.existsSync(f.options.dataDir), false)
      if (scenario === 'receipt') assert.equal(fs.readFileSync(f.options.receipt, 'utf8'), 'original-receipt')
      else assert.equal(fs.existsSync(f.options.receipt), false)
      assertNoTemporary(f)
    })
  }
})

test('receipt publication failure removes only the tool-owned candidate and temporary files', async t => {
  const f = fixture(t), bytes = await png(50), row = record(bytes)
  f.index([row]); f.image(row, bytes)
  t.mock.method(fs, 'linkSync', () => {
    assert.equal(fs.existsSync(path.join(f.partition(), 'emoji-packs.ndjson')), true)
    throw new Error('fixture receipt publication failure')
  })
  await assert.rejects(migrateAgentEmoji(f.options), /fixture receipt publication failure/u)
  assert.equal(fs.existsSync(f.options.dataDir), false); assert.equal(fs.existsSync(f.options.receipt), false)
  assert.deepEqual(fs.readFileSync(path.join(f.images, path.basename(row.file))), bytes)
  assertNoTemporary(f)
})

test('CLI runs from a source-free release layout and another cwd with sanitized output and strict arguments', async t => {
  const f = fixture(t), bytes = await png(60), row = record(bytes)
  f.index([row]); f.image(row, bytes)
  const release = path.join(f.directory, 'release')
  for (const name of ['scripts/migrate-agent-emoji.mjs', 'dist/backend/modules/emoji/infrastructure/emojiDecoders.js',
    'dist/backend/modules/image/infrastructure/agentToolImage.js', 'dist/backend/modules/image/infrastructure/imageResource.js',
    'dist/backend/modules/image/domain/imageDimensions.js']) {
    const destination = path.join(release, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(root, name), destination)
  }
  fs.writeFileSync(path.join(release, 'package.json'), '{"type":"module"}')
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(release, 'node_modules'))
  const script = path.join(release, 'scripts/migrate-agent-emoji.mjs')
  const child = spawnSync(process.execPath, [script, ...cliArgs(f.options)], { cwd: f.directory, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '')
  assert.equal(JSON.parse(child.stdout).counts.copiedImages, 1)
  assert.doesNotMatch(child.stdout, /private-tag-fixture|private-description-fixture/u)
  assert.equal(fs.existsSync(path.join(release, 'src')), false)
  const malformed = spawnSync(process.execPath, [script, ...cliArgs(f.options), '--agent-id', 'private-invalid-input'], { cwd: f.directory, encoding: 'utf8' })
  assert.equal(malformed.status, 1); assert.equal(malformed.stdout, '')
  assert.deepEqual(JSON.parse(malformed.stderr), { ok: false, error: 'invalid_arguments' })
  assertNoTemporary(f)
})
