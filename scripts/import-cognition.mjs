#!/usr/bin/env node
// Offline only: never imports host bootstrap, configuration or Redis clients.
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 16 * 1024 * 1024
const help = `Offline historical cognition import (default: preview, no writes)

  node scripts/import-cognition.mjs --input legacy.json --output cognition.json
  node scripts/import-cognition.mjs --input legacy.json --output cognition.json \\
    --apply --preview-hash <previewHash> --expected-revision <destinationRevision>

--output is one agent's CognitionState JSON; absent file means revision 0.
Apply requires the hash printed by a fresh preview and the expected destination
revision. Input and output must be different files. Output writes hold an
exclusive .import.lock and use a same-directory atomic rename. A stale lock
requires explicit operator review; it is never removed automatically.
No messages are sent; no database, Redis or production configuration is read.

Input schemaVersion 1 (all top-level arrays required, no extra fields):
{
  "schemaVersion": 1,
  "agentId": "shiloh",
  "mappings": [{
    "legacy": {"botId":"old-bot","personaId":"old-persona","groupId":"old-room"},
    "agentId":"shiloh",
    "conversation": {"account":{"platform":"qq","namespace":"global","id":"bot-a"},"kind":"group","id":"room-a"},
    "verified": true
  }],
  "sources": [{
    "scope": {"botId":"old-bot","personaId":"old-persona","groupId":"old-room"},
    "ref":"message:1", "kind":"message", "nativeId":"real-platform-message-id",
    "authorId":"real-author-id", "occurredAt":1800000000000,
    "content":"Original evidence", "revision":1,
    "participantIds":["real-author-id"], "status":"active"
  }],
  "memories": [{
    "scope": {"botId":"old-bot","personaId":"old-persona","groupId":"old-room"},
    "id":"memory-1", "kind":"experience", "content":"Historical experience",
    "epistemic":"reported", "evidenceRefs":["message:1"],
    "createdAt":1800000000000, "updatedAt":1800000000000
  }],
  "invalidations": []
}

Sources: kind=message|self-expression|receipt; status=active|revoked. Receipt
sources require ref=nativeId=receipt:<real-receipt-id>, the bot account as author,
and an empty participantIds array. Active receipt content must be a JSON string
with exactly {toolName,status,summary,goalId}; toolName is nonempty, goalId is null
or a nonempty ID, and status must match receiptStatus=succeeded|failed|unknown.
Pending or inconsistent receipts are skipped. Failed/unknown remain reported,
never completed action evidence. Revoked receipt bodies may be empty; preserve
their exact identity so the deletion is imported as a tombstone.
Use message:<old positive seq> or receipt:<old id> as ref, with a verified real
nativeId, real author and event time. Memory kind=experience|opinion|interest;
epistemic=reported|observed|inferred|desired. evidenceRefs can include memory:<id>.
An observed memory requires evidence from a succeeded receipt; a message alone
cannot establish that an action completed.
Optional memory.supersedes references the old memory ID in the same old scope.
All imported memories remain scene-scoped; no automatic self promotion occurs.
Invalidation: {id,scope,before,sourceRefs?:[ref],authorId?:string}; selectors
intersect. Preserve every historical withdrawal, erasure and scene restriction.
An unresolved invalidation blocks apply; incomplete memories report skip reasons.
Legacy global notes, goals and pending tool receipts need separate review.
`

function parse(args) {
  const options = { apply: false }
  const names = new Map([['--input', 'input'], ['--output', 'output'], ['--preview-hash', 'previewHash'], ['--expected-revision', 'expectedRevision']])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') { if (args.length !== 1) throw new Error('--help cannot be combined'); return { help: true } }
    if (arg === '--apply') { if (options.apply) throw new Error('Duplicate --apply'); options.apply = true; continue }
    const name = names.get(arg), value = args[++index]
    if (!name || !value || value.startsWith('--') || Object.hasOwn(options, name)) throw new Error(`Unknown, duplicate or incomplete argument: ${arg}`)
    options[name] = value
  }
  if (!options.input || !options.output) throw new Error('Explicit --input and --output files are required; use --help')
  if (options.apply) {
    if (!/^[a-f0-9]{64}$/u.test(options.previewHash ?? '') || !/^(0|[1-9]\d*)$/u.test(options.expectedRevision ?? '') || !Number.isSafeInteger(Number(options.expectedRevision))) throw new Error('--apply requires exact --preview-hash and --expected-revision')
  } else if (options.previewHash !== undefined || options.expectedRevision !== undefined) throw new Error('Preview does not accept apply confirmation fields')
  return options
}
const hash = text => createHash('sha256').update(text).digest('hex')
async function maybeStat(file) { try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
async function regular(file) {
  const stat = await maybeStat(file)
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('Only regular, non-linked output files are supported')
  return stat
}
async function paths(input, output) {
  const source = await realpath(path.resolve(input)), parent = await realpath(path.dirname(path.resolve(output)))
  const target = path.join(parent, path.basename(output)), sourceStat = await lstat(source), targetStat = await regular(target)
  if (!sourceStat.isFile() || source === target || targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) throw new Error('Refusing to overwrite the input snapshot')
  return { source, target }
}
async function readJson(file, optional = false) {
  const stat = await maybeStat(file)
  if (!stat && optional) return undefined
  if (!stat?.isFile() || stat.size > MAX_BYTES) throw new Error('JSON file missing, not regular, or too large')
  const raw = await readFile(file, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('JSON file too large')
  return { value: JSON.parse(raw), fingerprint: hash(raw) }
}
async function defaultModules() {
  return { ...await import('../dist/backend/modules/memory/infrastructure/cognitionImport.js'),
    ...await import('../dist/backend/modules/memory/domain/cognitionState.js') }
}

/** The injection seam is only for offline tests; the command loads built backend
 * modules directly and never loads the application or reads its settings. */
export async function runCognitionImportCli(args, modules, write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const options = parse(args)
  if (options.help) { process.stdout.write(help); return }
  const api = modules ?? await defaultModules(), files = await paths(options.input, options.output)
  if (!options.apply) {
    const source = await readJson(files.source), destination = await readJson(files.target, true)
    write({ mode: 'preview', output: files.target, ...api.previewCognitionImport(source.value, destination?.value) })
    return
  }
  const lockPath = `${files.target}.import.lock`
  let lock
  try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Output is locked by another import; review the .import.lock before retrying'); throw error }
  let temp
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync()
    // Check aliases again after locking and capture the exact destination bytes.
    await paths(files.source, files.target)
    const source = await readJson(files.source), destination = await readJson(files.target, true)
    const preview = api.previewCognitionImport(source.value, destination?.value)
    const initial = destination ? api.validateCognitionState(destination.value, preview.agentId) : api.createEmptyCognitionState(preview.agentId)
    const store = { async update(agentId, mutate, guard) {
      if (!guard.isCurrent()) throw new Error('Import guard expired')
      const state = api.validateCognitionState(initial, agentId), next = api.validateCognitionState(mutate(structuredClone(state)) ?? state, agentId)
      api.validateCognitionTransition(state, next)
      if (JSON.stringify(state) !== JSON.stringify(next)) {
        if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Destination revision exhausted')
        next.revision = state.revision + 1
      }
      return next
    } }
    const state = await api.applyCognitionImport(store, source.value, {
      previewHash: options.previewHash, expectedRevision: Number(options.expectedRevision), guard: { isCurrent: () => true },
    })
    if (JSON.stringify(state) === JSON.stringify(initial)) {
      write({ mode: 'applied', output: files.target, previewHash: preview.previewHash, revision: state.revision, alreadyApplied: true }); return
    }
    temp = path.join(path.dirname(files.target), `.${path.basename(files.target)}.${randomUUID()}.tmp`)
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    await paths(files.source, files.target)
    const currentSource = await readJson(files.source), current = await readJson(files.target, true)
    if (currentSource.fingerprint !== source.fingerprint || current?.fingerprint !== destination?.fingerprint) throw new Error('Input or output changed during import; preview again')
    await rename(temp, files.target); temp = undefined
    // Persist the rename where supported. Failure after rename leaves an
    // idempotently checkpointed state that can safely be inspected/replayed.
    const directory = await open(path.dirname(files.target), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    write({ mode: 'applied', output: files.target, previewHash: preview.previewHash, revision: state.revision, alreadyApplied: false, counts: preview.counts, skipped: preview.skipped })
  } finally {
    if (temp) await unlink(temp).catch(() => {})
    await lock.close()
    await unlink(lockPath)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCognitionImportCli(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
