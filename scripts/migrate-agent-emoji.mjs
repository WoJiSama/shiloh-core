#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { decodeEmojiItem } from '../dist/backend/modules/emoji/infrastructure/emojiDecoders.js'
import { validateAgentToolImageBytes } from '../dist/backend/modules/image/infrastructure/agentToolImage.js'

const MAX_INDEX_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PIXELS = 64 * 1024 * 1024
const MAX_RECORDS = 10_000
const MAX_FILES = MAX_RECORDS * 2 + 128
const HASH = /^[a-f0-9]{64}$/u
const IMAGE = /^([a-f0-9]{64})\.(jpg|png|gif|webp)$/u
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
const LEGACY_SOURCES = new Set(['auto', 'manual', 'maintenance'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const invalid = code => Object.assign(new Error(code), { migrationCode: code })
const identity = stat => `${stat.dev}:${stat.ino}`
const exists = location => { try { fs.lstatSync(location); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep)

/** Only explicit, real directories are anchors; no index field can select a path. */
function directories() {
  const identities = new Map()
  return location => {
    let current = path.parse(location).root
    for (const piece of location.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, piece)
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid('unsafe_directory')
      const expected = identities.get(current)
      if (expected !== undefined && expected !== identity(stat)) throw invalid('directory_changed')
      identities.set(current, identity(stat))
    }
  }
}

function readBounded(location, maximum, checkDirectory) {
  checkDirectory(path.dirname(location))
  const stat = fs.lstatSync(location)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw invalid('unsafe_file')
  const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (identity(before) !== identity(stat) || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw invalid('file_changed')
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1))
    let length = 0
    while (length < buffer.length) {
      const bytes = fs.readSync(fd, buffer, length, buffer.length - length, null)
      if (!bytes) break
      length += bytes
    }
    const after = fs.fstatSync(fd)
    checkDirectory(path.dirname(location))
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw invalid('file_changed')
    return buffer.subarray(0, length)
  } finally { fs.closeSync(fd) }
}

function writeExclusive(location, bytes) {
  const fd = fs.openSync(location, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  let complete = false
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); complete = true }
  finally { fs.closeSync(fd); if (!complete) fs.unlinkSync(location) }
}

function syncDirectory(location) {
  const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function metadata(raw) {
  const item = decodeEmojiItem(raw)
  if (!item || !HASH.test(item.hash) || item.file !== `emoji_files/${path.basename(item.file)}` ||
      !IMAGE.test(path.basename(item.file)) || !path.basename(item.file).startsWith(item.hash + '.')) return null
  for (const name of ['tags', 'useCases']) {
    if (raw[name] !== undefined && (!Array.isArray(raw[name]) || raw[name].length > 64 || raw[name].some(value => typeof value !== 'string' || value.length > 1024))) return null
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 4096) ||
      raw.usedCount !== undefined && (!Number.isSafeInteger(raw.usedCount) || raw.usedCount < 0) ||
      raw.isBanned !== undefined && typeof raw.isBanned !== 'boolean' ||
      raw.noFileFlag !== undefined && typeof raw.noFileFlag !== 'boolean') return null
  for (const name of ['lastUsedAt', 'registeredAt']) {
    if (raw[name] !== undefined && !(name === 'lastUsedAt' && raw[name] === null) &&
        (typeof raw[name] !== 'string' || raw[name].length > 128 || /[\u0000-\u001f\u007f]/u.test(raw[name]))) return null
  }
  return item
}

async function validateImage(bytes, extension) {
  validateAgentToolImageBytes(bytes, MIME[extension])
  const options = { animated: true, failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true }
  const image = sharp(bytes, options)
  const meta = await image.metadata()
  const pages = meta.pages ?? 1
  const pageHeight = meta.pageHeight ?? meta.height
  if (!meta.width || !pageHeight || meta.width > 16_384 || pageHeight > 16_384 ||
      !Number.isSafeInteger(pages) || pages < 1 || pages > 512 || meta.width * pageHeight * pages > MAX_PIXELS) throw invalid('unsafe_image_dimensions')
  // Metadata alone does not detect a truncated image; decode all frames without
  // rewriting the historical bytes whose SHA256 is the archive's record key.
  await image.stats()
}

function optionsChecked(options) {
  if (!options || typeof options !== 'object') throw invalid('invalid_arguments')
  const { source, dataDir, agentId, receipt } = options
  if (![source, dataDir, receipt].every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')) ||
      typeof agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(agentId) ||
      ![options.archiveSha256, options.indexSha256].every(value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/u.test(value))) throw invalid('invalid_arguments')
  const result = { source: path.resolve(source), dataDir: path.resolve(dataDir), receipt: path.resolve(receipt), agentId,
    archiveSha256: options.archiveSha256.toLowerCase(), indexSha256: options.indexSha256.toLowerCase() }
  if (within(result.source, result.dataDir) || within(result.dataDir, result.source) ||
      within(result.source, result.receipt) || within(result.dataDir, result.receipt) ||
      within(result.receipt, result.source) || within(result.receipt, result.dataDir)) throw invalid('overlapping_paths')
  return result
}

/** Create an offline candidate only. The data root and receipt must not exist. */
export async function migrateAgentEmoji(input) {
  const options = optionsChecked(input), checkDirectory = directories()
  const parent = path.dirname(options.dataDir), receiptParent = path.dirname(options.receipt)
  checkDirectory(options.source); checkDirectory(parent); checkDirectory(receiptParent)
  const sourceImages = path.join(options.source, 'emoji_files')
  checkDirectory(sourceImages)
  if (exists(options.dataDir) || exists(options.receipt)) throw invalid('target_exists')
  const index = readBounded(path.join(options.source, 'emoji-packs.ndjson'), MAX_INDEX_BYTES, checkDirectory)
  if (digest(index) !== options.indexSha256) throw invalid('index_digest_mismatch')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(index) } catch { throw invalid('invalid_index_encoding') }
  const lines = text.split('\n').map((line, lineIndex) => ({ line, lineNumber: lineIndex + 1 })).filter(row => row.line.trim())
  if (lines.length > MAX_RECORDS) throw invalid('index_record_limit')
  const names = fs.readdirSync(sourceImages).sort()
  if (names.length > MAX_FILES) throw invalid('image_file_limit')
  const counts = { inputRecords: lines.length, invalidRecords: 0, duplicateRecords: 0, duplicateHashes: 0,
    outputRecords: 0, copiedImages: 0, availableRecords: 0, bannedRecords: 0, disabledRecords: 0,
    missingImages: 0, invalidImages: 0, hashMismatches: 0, orphanImages: 0, invalidFiles: 0,
    embeddingsCleared: 0, bytesCopied: 0 }
  const groups = new Map(), hashOccurrences = new Map(), safeFiles = new Set()
  for (const name of names) {
    const stat = fs.lstatSync(path.join(sourceImages, name))
    if (IMAGE.test(name) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) safeFiles.add(name)
    else counts.invalidFiles++
  }
  for (const row of lines) {
    let raw, item
    try {
      raw = JSON.parse(row.line)
      if (raw && typeof raw.hash === 'string' && HASH.test(raw.hash)) hashOccurrences.set(raw.hash, (hashOccurrences.get(raw.hash) ?? 0) + 1)
      item = metadata(raw)
    } catch { /* Invalid metadata is counted, never printed. */ }
    if (!item) { counts.invalidRecords++; continue }
    const group = groups.get(item.hash) ?? []
    group.push({ item, raw, lineNumber: row.lineNumber, recordSha256: digest(row.line) })
    groups.set(item.hash, group)
  }
  counts.duplicateHashes = [...hashOccurrences.values()].filter(count => count > 1).length
  const unique = []
  for (const group of groups.values()) {
    // An invalid duplicate must not hide a valid ban by leaving an earlier row
    // active. Invalid rows stay in invalidRecords; every valid peer is excluded.
    if (hashOccurrences.get(group[0].item.hash) > 1) counts.duplicateRecords += group.length
    else unique.push(group[0])
  }
  const referenced = new Set(unique.map(row => path.basename(row.item.file)))
  counts.orphanImages = [...safeFiles].filter(name => !referenced.has(name)).length
  const startedAt = new Date().toISOString(), agentHash = digest(options.agentId)
  const relativePartition = `emoji/agents/${agentHash}`
  const stage = fs.mkdtempSync(path.join(parent, '.migrate-agent-emoji-'))
  const stageIdentity = identity(fs.lstatSync(stage))
  const temporaryReceipt = path.join(receiptParent, `.migrate-agent-emoji-receipt-${randomUUID()}.json`)
  const lock = path.join(parent, `.migrate-agent-emoji-${digest(options.dataDir)}.lock`)
  let ownsLock = false, committed = false, ownsReceipt = false, ownsTemporaryReceipt = false
  try {
    writeExclusive(lock, Buffer.from(randomUUID())); ownsLock = true
    checkDirectory(parent); checkDirectory(receiptParent)
    if (exists(options.dataDir) || exists(options.receipt)) throw invalid('target_exists')
    const partition = path.join(stage, ...relativePartition.split('/')), outputImages = path.join(partition, 'emoji_files')
    fs.mkdirSync(outputImages, { recursive: true, mode: 0o700 })
    const records = [], provenance = [], imageDigests = []
    for (const row of unique) {
      const item = { ...row.item, embedding: null, source: `legacy-archive:${options.archiveSha256}` }
      const name = path.basename(item.file), extension = IMAGE.exec(name)[2]
      let bytes, imageStatus = 'missing'
      if (!names.includes(name)) counts.missingImages++
      else {
        try {
          bytes = readBounded(path.join(sourceImages, name), MAX_IMAGE_BYTES, checkDirectory)
          if (digest(bytes) !== item.hash) { counts.hashMismatches++; throw invalid('image_digest_mismatch') }
          await validateImage(bytes, extension)
          imageStatus = 'verified'
        } catch (error) {
          if (error.migrationCode === 'directory_changed' || error.migrationCode === 'unsafe_directory') throw error
          counts.invalidImages++; bytes = undefined; imageStatus = 'invalid'
        }
      }
      if (bytes) {
        writeExclusive(path.join(outputImages, name), bytes)
        counts.copiedImages++; counts.bytesCopied += bytes.length
        imageDigests.push(`${name}\t${item.hash}\t${bytes.length}\n`)
      } else item.noFileFlag = true
      if (Array.isArray(row.raw.embedding) && row.raw.embedding.length) counts.embeddingsCleared++
      if (item.isBanned) counts.bannedRecords++
      if (item.isBanned || item.noFileFlag) counts.disabledRecords++
      else counts.availableRecords++
      records.push(item)
      provenance.push({ hash: item.hash, indexLine: row.lineNumber, originalRecordSha256: row.recordSha256,
        originalSource: row.raw.source === undefined ? 'absent' : LEGACY_SOURCES.has(row.raw.source) ? row.raw.source : 'other', imageStatus })
    }
    counts.outputRecords = records.length
    const outputIndex = Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + (records.length ? '\n' : ''))
    if (outputIndex.length > MAX_INDEX_BYTES) throw invalid('output_index_limit')
    const provenanceBytes = jsonBytes({ schema: 1, agentId: options.agentId, archiveSha256: options.archiveSha256,
      indexSha256: options.indexSha256, createdAt: new Date().toISOString(),
      attribution: 'legacy-archive-without-message-or-account-identity', embeddingPolicy: 'cleared-unverified-model', records: provenance })
    writeExclusive(path.join(partition, 'emoji-packs.ndjson'), outputIndex)
    writeExclusive(path.join(partition, 'legacy-provenance.json'), provenanceBytes)
    const receipt = { schema: 1, candidateOnly: true, deliveryAttempted: false, startedAt, completedAt: new Date().toISOString(),
      agentId: options.agentId, archiveSha256: options.archiveSha256, archiveDigestVerification: 'caller-supplied',
      indexSha256: options.indexSha256, indexDigestVerified: true, relativePartition, counts,
      outputIndexSha256: digest(outputIndex), outputImageSetSha256: digest(imageDigests.sort().join('')),
      provenanceSha256: digest(provenanceBytes) }
    writeExclusive(temporaryReceipt, jsonBytes(receipt)); ownsTemporaryReceipt = true
    for (const location of [outputImages, partition, path.dirname(partition), path.dirname(path.dirname(partition)), stage]) syncDirectory(location)
    checkDirectory(options.source); checkDirectory(sourceImages); checkDirectory(parent); checkDirectory(receiptParent)
    if (exists(options.dataDir) || exists(options.receipt)) throw invalid('target_exists')
    fs.renameSync(stage, options.dataDir); committed = true
    // link is an atomic no-overwrite publication, unlike rename for a receipt.
    fs.linkSync(temporaryReceipt, options.receipt); ownsReceipt = true
    fs.unlinkSync(temporaryReceipt); ownsTemporaryReceipt = false
    syncDirectory(parent); syncDirectory(receiptParent)
    return receipt
  } catch (error) {
    if (ownsReceipt) fs.unlinkSync(options.receipt)
    if (committed && exists(options.dataDir) && identity(fs.lstatSync(options.dataDir)) === stageIdentity) fs.rmSync(options.dataDir, { recursive: true })
    throw error
  } finally {
    if (!committed && exists(stage) && identity(fs.lstatSync(stage)) === stageIdentity) fs.rmSync(stage, { recursive: true })
    if (ownsTemporaryReceipt) fs.unlinkSync(temporaryReceipt)
    if (ownsLock) fs.unlinkSync(lock)
  }
}

function cliOptions(args) {
  const names = { '--source': 'source', '--data-dir': 'dataDir', '--agent-id': 'agentId',
    '--archive-sha256': 'archiveSha256', '--index-sha256': 'indexSha256', '--receipt': 'receipt' }
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key)) throw invalid('invalid_arguments')
    result[key] = value
  }
  if (Object.keys(result).length !== Object.keys(names).length) throw invalid('invalid_arguments')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
      process.stdout.write('node scripts/migrate-agent-emoji.mjs --source /safe/database --data-dir /new/candidate --agent-id AGENT --archive-sha256 SHA256 --index-sha256 SHA256 --receipt /new/receipt.json\nThe candidate root and receipt must not exist; parent directories must already be real directories.\n')
    } else process.stdout.write(JSON.stringify(await migrateAgentEmoji(cliOptions(process.argv.slice(2)))) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.migrationCode ?? 'migration_failed' }) + '\n')
    process.exitCode = 1
  }
}
