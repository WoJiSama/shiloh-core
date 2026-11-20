import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import type { readStandaloneAgentConfig } from './standaloneAgentConfig.js'
import { stageStandaloneAgentArchiveMigration, type ArchiveMigrationCheck } from './standaloneAgentArchiveMigration.js'
import { withFrozenLegacyRedis } from './standaloneAgentLegacyMemoryMigration.js'
import { commitStandaloneTransfer } from './standaloneAgentMigration.js'
import { standaloneAgentSecrets } from './standaloneAgentSecrets.js'
import { agentBindingToken } from '../modules/runtime/domain/agentBindings.js'
import { agentRedisPrefix, connectAgentRedis } from '../modules/runtime/infrastructure/agentRedis.js'
import { createAgentSemanticMemoryStore } from '../modules/memory/infrastructure/agentSemanticMemoryStore.js'
import { createAgentSecretTextCheck } from '../modules/messaging/infrastructure/agentSecretText.js'
import { createForbiddenWordGuard } from '../modules/conversation/domain/forbiddenWordGuard.js'

const execute = promisify(execFile)
const day = 86_400_000
const archiveEvidenceReader = [
  'import hashlib, json, sys, tarfile',
  'from pathlib import PurePosixPath',
  'configs = {}',
  'files = {}',
  'explicit = False',
  'with tarfile.open(sys.argv[1], "r|gz") as archive:',
  ' for member in archive:',
  '  path = PurePosixPath(member.name).as_posix()',
  '  if path == "config/agent-bindings.yaml": explicit = True',
  '  if not member.isfile(): continue',
  '  if path in ("config/message.yaml", "config/persona-library.yaml"):',
  '   if path in configs or member.size > 2097152: raise ValueError()',
  '   configs[path] = {"text": archive.extractfile(member).read().decode(), "at": int(member.mtime * 1000)}',
  '  if path.startswith(("data/message_archive/group/", "data/semantic_memory/redactions/", "data/semantic_memory/group/")):',
  '   if path in files or member.size > 134217728: raise ValueError()',
  '   files[path] = hashlib.file_digest(archive.extractfile(member), "sha256").hexdigest()',
  'print(json.dumps({"configs": configs, "files": files, "explicit": explicit}))',
].join('\n')

function fail(label: string): never { throw new Error('旧群原文接续：' + label) }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stamp(filename: string) {
  const stat = fs.lstatSync(filename, { bigint: true })
  if (!stat.isFile() || fs.realpathSync(filename) !== filename) return fail('来源文件路径无效')
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
async function digest(filename: string) {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}
function leaves(input: unknown, out: string[], depth = 0) {
  if (depth > 12) return
  for (const [field, value] of Object.entries(object(input))) {
    if (typeof value === 'string' && value && /(?:api[-_]?key|apikey|secret|token|password|authorization|cookie)$/iu.test(field)) out.push(value)
    else if (Array.isArray(value)) for (const row of value) leaves(row, out, depth + 1)
    else if (typeof value === 'object') leaves(value, out, depth + 1)
  }
}

export async function runStandaloneLegacyGroupArchiveMigration(config: ReturnType<typeof readStandaloneAgentConfig>,
  options: { backupDir: string; connectionId: string; apply: boolean }) {
  const connection = config.connections.find(row => row.connection.id === options.connectionId)?.connection
  if (!connection || config.history.enabled !== true || !config.isConfigCurrent()) return fail('宿主连接或原文来源库配置无效')
  const restore = path.join(config.dataDir, 'legacy-source')
  const archive = path.join(path.resolve(options.backupDir), 'legacy-config-data.tar.gz')
  const rdb = path.join(path.resolve(options.backupDir), 'redis.rdb')
  const sourceStamps = new Map([archive, rdb].map(filename => [filename, stamp(filename)]))
  const temporaryEvidence = JSON.parse((await execute('python3', ['-c', archiveEvidenceReader, archive], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 12 * 1024 * 1024,
  })).stdout) as {
    explicit: boolean; configs: Record<string, { text: string; at: number }>; files: Record<string, string>
  }
  if (temporaryEvidence.explicit) return fail('该旧宿主已声明原始绑定，请用显式迁移')
  const originalConfig = temporaryEvidence.configs['config/message.yaml']
  const originalLibrary = temporaryEvidence.configs['config/persona-library.yaml']
  if (!originalConfig || !originalLibrary || !Number.isSafeInteger(originalLibrary.at) || originalLibrary.at <= 0) return fail('原始人设生效时间缺失')
  const raw = YAML.parse(originalConfig.text)
  const settings = object(object(raw).pluginSettings)
  const library = object(YAML.parse(originalLibrary.text))
  if (settings.enabled !== true || settings.enableGroupWhitelist !== true || !Array.isArray(settings.allowedGroups) ||
      !Array.isArray(library.personas)) return fail('旧版群路由或人设配置无效')
  const allowedGroups = new Set(settings.allowedGroups.map(String))
  const base = path.join(restore, 'data')
  const current = () => {
    try { return config.isConfigCurrent() && [...sourceStamps].every(([file, revision]) => stamp(file) === revision) }
    catch { return false }
  }
  if (!current()) return fail('冻结证据已变化')
  const now = Date.now()
  const frozenAt = Math.min(Math.floor(fs.statSync(archive).mtimeMs), now)
  const rdbHash = await digest(rdb)
  const secrets = standaloneAgentSecrets(config, process.env)
  leaves(raw, secrets)
  const checkSecret = createAgentSecretTextCheck(secrets)
  const words = createForbiddenWordGuard({ warn() {} })
  const allowsText = (text: string) => checkSecret(text) && !words.findForbiddenWord(text, config.forbiddenWords)
  const prefix = agentRedisPrefix(config.instance)
  const redis = await connectAgentRedis(config.redisUrl)
  try {
    return await withFrozenLegacyRedis(rdb, rdbHash, async frozen => {
      const report = []
      for (const binding of config.loadedBindings) {
        const { target } = binding
        if (binding.connectionId !== options.connectionId || target.kind !== 'group' ||
            !allowedGroups.has(target.id)) continue
        const oldRole = object(library.groupBindings)[target.id] || object(library.accountBindings)[target.account.id] || 'default'
        if (oldRole !== 'default' || binding.personaId !== oldRole || binding.agentId !== 'shiloh') continue
        const groupPrefix = 'data/message_archive/group/' + target.id + '/'
        const freeze = Object.entries(temporaryEvidence.files).filter(([name]) => name.startsWith(groupPrefix) ||
          name === 'data/semantic_memory/redactions/' + target.id + '.json' ||
          name === 'data/semantic_memory/group/' + target.id + '.ndjson')
        const archiveFiles = freeze.filter(([name]) => name.startsWith(groupPrefix))
        if (!archiveFiles.length) continue
        const observedFiles = fs.readdirSync(path.join(base, 'message_archive', 'group', target.id))
          .filter(name => name.endsWith('.ndjson')).sort()
        const expectedFiles = archiveFiles.map(([name]) => path.basename(name)).sort()
        if (JSON.stringify(observedFiles) !== JSON.stringify(expectedFiles)) return fail('群归档目录和冻结备份不一致')
        const pinned = new Map<string, string>()
        for (const [name, sha] of freeze) {
          const filename = path.join(restore, name)
          if (!filename.startsWith(restore + path.sep)) return fail('归档路径超出范围')
          const revision = stamp(filename)
          if (await digest(filename) !== sha || stamp(filename) !== revision) return fail('原始资料与冻结备份不一致')
          pinned.set(filename, revision)
        }
        const before = agentBindingToken(binding)
        const groupCurrent = () => {
          try {
            const live = config.resolvePersona(target)?.binding
            return current() && !!live && agentBindingToken(live) === before &&
              [...pinned].every(([file, revision]) => stamp(file) === revision)
          } catch { return false }
        }
        const checks = new Map<string, ArchiveMigrationCheck>()
        const result = await stageStandaloneAgentArchiveMigration({
          redis: { get: key => key.startsWith(prefix) ? redis.get(key) : frozen.get(key) },
          prefix, binding, legacyGroup: { originalRole: oldRole, roleEffectiveAt: originalLibrary.at, frozenAt },
          sourceArchiveDir: path.join(base, 'message_archive'), history: config.history, now, checks,
          isCurrent: groupCurrent, allowsText, ...(!options.apply ? { previewWhileRunning: true } : {}),
        })
        const semantic = createAgentSemanticMemoryStore({
          get: key => redis.get(prefix + key),
          eval: (script, request) => redis.eval(script, { ...request, keys: request.keys.map(key => prefix + key) }),
        })
        const recent = result.portableRows
          .filter(row => row.at >= now - config.semanticMemory.retentionDays * day && row.text.trim().length <= 1600)
          .map(row => ({ messageId: row.messageId, authorId: row.authorId, name: row.name, text: row.text.trim(), at: row.at }))
        const staged = config.semanticMemory.enabled ? await semantic.planSourceImport({ agentId: binding.agentId, target },
          recent, config.semanticMemory.maxMessagesPerConversation) : { imported: 0, checks: [] }
        for (const guard of staged.checks) {
          const key = prefix + guard.key, prior = checks.get(key)
          if (prior && prior.value !== guard.value) return fail('语义隐私或来源库在预演期间改变')
          checks.set(key, { ...guard, key })
        }
        if (!result.isCurrent()) return fail('会话绑定、来源或宿主配置已变更')
        if (options.apply) await commitStandaloneTransfer(redis, [...checks.values()].filter(check => check.key.startsWith(prefix)))
        report.push({ groupId: target.id, ...result.report, semanticSources: staged.imported })
      }
      return { mode: options.apply ? 'applied' : 'preview', groups: report }
    })
  } finally {
    await redis.close()
  }
}
