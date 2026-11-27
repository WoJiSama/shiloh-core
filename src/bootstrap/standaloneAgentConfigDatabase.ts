import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConfigSourceName, ConfigSources, SourceSnapshot } from './standaloneAgentConfigSources.js'

const applicationId = 1397246275
const sourceLimit = 2 * 1024 * 1024
const generationId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceKeys = ['host', 'personas', 'bindings'] as const
type Versions = SourceSnapshot['versions']
export type ConfigDatabaseContent = {
  readonly generation: string
  readonly versions: Versions
  readonly sources: ConfigSources
}

function open(file: string, readOnly: boolean): DatabaseSync {
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) throw new Error('SQLite 配置需要 Node.js 22.13 或更高版本')
  const db = new sqlite.DatabaseSync(file, { readOnly })
  try {
    db.exec('PRAGMA trusted_schema = OFF')
    if (!readOnly) db.exec('PRAGMA synchronous = EXTRA')
    return db
  } catch (error) { db.close(); throw error }
}

export function openStandaloneConfigDatabase(file: string, readOnly: boolean): DatabaseSync {
  const db = open(file, readOnly)
  try {
    if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
        db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') {
      throw new Error('独立 Core 配置数据库格式无效')
    }
    return db
  } catch (error) { db.close(); throw error }
}

function version(value: unknown, absent: boolean): value is string {
  return typeof value === 'string' && (absent ? value === 'absent' : /^[0-9a-f]{64}$/u.test(value))
}

export function readStandaloneConfigDatabase(db: DatabaseSync): ConfigDatabaseContent {
  const row = db.prepare(`SELECT generation, host, personas, bindings, host_version, personas_version, bindings_version
    FROM configuration WHERE id = 1 AND length(CAST(host AS BLOB)) <= ${sourceLimit}
    AND (personas IS NULL OR length(CAST(personas AS BLOB)) <= ${sourceLimit})
    AND length(CAST(bindings AS BLOB)) <= ${sourceLimit}`).get()
  if (!row || typeof row.generation !== 'string' || !generationId.test(row.generation) || typeof row.host !== 'string' ||
      typeof row.bindings !== 'string' || row.personas !== null && typeof row.personas !== 'string' ||
      !version(row.host_version, false) || !version(row.personas_version, row.personas === null) || !version(row.bindings_version, false)) {
    throw new Error('独立 Core 配置数据库记录无效')
  }
  return { generation: row.generation, versions: Object.freeze({
    host: row.host_version, personas: row.personas_version, bindings: row.bindings_version,
  }), sources: Object.freeze({ format: 'json', host: row.host, personas: row.personas ?? undefined, bindings: row.bindings }) }
}

function validateSources(sources: ConfigSources): void {
  if (sources.format !== 'json') throw new Error('配置数据库需要 JSON 配置源')
  for (const key of sourceKeys) {
    const source = sources[key]
    if (key === 'personas' && source === undefined) continue
    if (typeof source !== 'string' || Buffer.byteLength(source) > sourceLimit) throw new Error('配置数据库记录超限')
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置数据库需要 JSON 对象')
  }
}

export function nextStandaloneConfigDatabaseContent(sources: ConfigSources, before?: Pick<ConfigDatabaseContent, 'sources' | 'versions'>,
  versions?: Versions): ConfigDatabaseContent {
  validateSources(sources)
  const generation = randomUUID()
  const versionFor = (key: ConfigSourceName) => {
    const source = sources[key]
    if (source === undefined) return 'absent'
    if (versions) return versions[key]
    if (before?.sources[key] === source) return before.versions[key]
    return digest(JSON.stringify([before?.versions[key] ?? generation, key, source]))
  }
  return { generation, sources, versions: { host: versionFor('host'), personas: versionFor('personas'), bindings: versionFor('bindings') } }
}

export function writeStandaloneConfigDatabase(db: DatabaseSync, { generation, sources, versions }: ConfigDatabaseContent): void {
  db.prepare(`INSERT INTO configuration (id, generation, host, personas, bindings, host_version, personas_version, bindings_version)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    generation=excluded.generation, host=excluded.host, personas=excluded.personas, bindings=excluded.bindings,
    host_version=excluded.host_version, personas_version=excluded.personas_version, bindings_version=excluded.bindings_version`)
    .run(generation, sources.host, sources.personas ?? null, sources.bindings, versions.host, versions.personas, versions.bindings)
}

/** Initialize a new, private staging file. The caller owns publication. */
export function initializeStandaloneConfigDatabase(file: string, content: ConfigDatabaseContent): void {
  const db = open(file, false)
  try {
    db.exec(`BEGIN IMMEDIATE;
      PRAGMA application_id = ${applicationId};
      PRAGMA user_version = 1;
      CREATE TABLE configuration (
        id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL,
        host TEXT NOT NULL, personas TEXT, bindings TEXT NOT NULL,
        host_version TEXT NOT NULL, personas_version TEXT NOT NULL, bindings_version TEXT NOT NULL
      ) STRICT`)
    writeStandaloneConfigDatabase(db, content)
    readStandaloneConfigDatabase(db)
    db.exec('COMMIT')
  } finally { db.close() }
}

export function isStandaloneConfigDatabase(file: string): boolean {
  return file.toLowerCase().endsWith('.sqlite')
}
