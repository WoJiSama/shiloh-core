import path from 'node:path'
import { createStandaloneAgentCandidateValidator } from './standaloneAgentConfig.js'
import { isStandaloneConfigDatabase, nextStandaloneConfigDatabaseContent } from './standaloneAgentConfigDatabase.js'
import { encodeConfigJson, readConfigJson, readStandaloneConfigDocument } from './standaloneAgentConfigDocument.js'
import {
  acquireStandaloneAgentConfigLock, checkStandaloneAgentConfigDatabaseDestination, exportStandaloneAgentConfigFile, isStandaloneAgentSourceSnapshotCurrent,
  publishStandaloneAgentConfigDatabase, readStandaloneAgentConfigImportFile, readStandaloneAgentSourceSnapshot,
} from './standaloneAgentConfigSources.js'
import type { ConfigSources } from './standaloneAgentConfigSources.js'

function migrateSources(input: ConfigSources): ConfigSources {
  function json(source: string): string {
    const doc = readStandaloneConfigDocument(source, input.format)
    if (doc.errors.length) throw new Error('旧配置无法解析')
    return encodeConfigJson(doc.toJS({ maxAliasCount: 100 }))
  }
  return {
    format: 'json', host: json(input.host), bindings: json(input.bindings),
    personas: input.personas === undefined ? undefined : json(input.personas),
  }
}

function jsonBundle(input: string): { sources: ConfigSources; revision?: string } {
  const values = readConfigJson(input)
  const revision = values.revision
  if (Object.keys(values).some(key => !['host', 'personas', 'bindings', 'revision'].includes(key)) ||
      revision !== undefined && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision))) throw new Error('配置导入包字段无效')
  return {
    ...(revision === undefined ? {} : { revision }),
    sources: {
      format: 'json', host: encodeConfigJson(values.host), bindings: encodeConfigJson(values.bindings),
      personas: values.personas === undefined ? undefined : encodeConfigJson(values.personas),
    },
  }
}

export function exportStandaloneAgentConfig(file: string, output: string, signal: AbortSignal) {
  if (!isStandaloneConfigDatabase(file)) throw new Error('配置导出需要 SQLite 配置库')
  const snapshot = readStandaloneAgentSourceSnapshot(file)
  const { host, bindings, personas } = snapshot.sources
  const bundle = { revision: snapshot.revision, host: readConfigJson(host),
    ...(personas === undefined ? {} : { personas: readConfigJson(personas) }), bindings: readConfigJson(bindings) }
  const pretty = JSON.stringify(bundle, null, 2) + '\n'
  const source = Buffer.byteLength(pretty) <= 8 * 1024 * 1024 ? pretty : JSON.stringify(bundle) + '\n'
  exportStandaloneAgentConfigFile(output, source, () => {
    signal.throwIfAborted()
    if (!isStandaloneAgentSourceSnapshotCurrent(snapshot)) throw new Error('导出期间配置已改变')
  })
  return { format: 'json', phase: 'exported', revision: snapshot.revision }
}

export async function importStandaloneAgentConfig(input: string, output: string, options: {
  readonly env: NodeJS.ProcessEnv
  readonly apply: boolean
  readonly signal: AbortSignal
}) {
  if (!isStandaloneConfigDatabase(output)) throw new Error('配置导入需要 SQLite 目标路径')
  const extension = path.extname(input).toLowerCase()
  if (!['.yaml', '.yml', '.json'].includes(extension)) throw new Error('配置导入支持旧宿主 YAML 或 JSON 配置包')
  const legacy = extension === '.json' ? undefined : readStandaloneAgentSourceSnapshot(input)
  const seed = legacy ? undefined : readStandaloneAgentConfigImportFile(input)
  const bundle = seed && jsonBundle(seed.source)
  const existing = bundle?.revision === undefined ? undefined : readStandaloneAgentSourceSnapshot(output)
  if (existing && (existing.sources.format !== 'json' || existing.revision !== bundle?.revision)) throw new Error('配置导入包的版本已改变')
  const destination = existing?.hostFile ?? checkStandaloneAgentConfigDatabaseDestination(output)
  if (legacy && legacy.root !== path.dirname(destination)) {
    throw new Error('旧 YAML 的目标数据库应放在原配置目录，以保留相对路径和数据目录')
  }
  const sources = legacy ? migrateSources(legacy.sources) : bundle!.sources
  const content = nextStandaloneConfigDatabaseContent(sources, existing, legacy?.versions)
  createStandaloneAgentCandidateValidator(destination, options.env, { requireCredentials: false, sourceSnapshot: {
    hostFile: destination, sources, versions: content.versions,
  } })(sources)
  let fenced = false
  const ensureCurrent = () => {
    options.signal.throwIfAborted()
    if ((legacy ? !isStandaloneAgentSourceSnapshotCurrent(legacy) : !seed!.isCurrent()) ||
        existing && !fenced && !isStandaloneAgentSourceSnapshotCurrent(existing)) throw new Error('导入期间来源配置已改变')
  }
  let versions = content.versions
  if (options.apply) {
    const before = existing ?? legacy
    const lock = before && await acquireStandaloneAgentConfigLock(before, { signal: options.signal, ensureCurrent })
    try {
      if (existing && lock) {
        const { snapshot } = lock.commitSources(sources, existing, {
          ensureActorCurrent: ensureCurrent, onFenced() { fenced = true }, onCommitPublished() {},
        })
        versions = snapshot.versions
      } else publishStandaloneAgentConfigDatabase(destination, content, ensureCurrent)
    }
    finally { lock?.release() }
  } else ensureCurrent()
  return { format: 'sqlite', phase: options.apply ? 'imported' : 'validated',
    source: legacy ? 'legacy-yaml' : 'json', versions }
}
