import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { RepositoryEvidence, RepositorySource } from '../contracts/repositoryKnowledge.js'
import { repositoryPath, repositoryRef } from '../modules/knowledge/infrastructure/repositoryCatalog.js'

const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const allowedExtensions = /\.(?:md|mdx|txt|rst|adoc|java|kt|scala|groovy|ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|rs|py|rb|php|c|cc|cpp|h|cs|sql|xml|json|ya?ml|properties|toml|css|scss)$/iu
const excludedPath = /(?:^|\/)(?:node_modules|build|dist|target|vendor|fixtures|test-data|secrets?|credentials?|private|customer-data|uploads)(?:\/|\.|$)|(?:^|\/)(?:application|config)[.-](?:prod(?:uction)?|online)(?:[.-]|$)|(?:^|\/)[^/]*(?:-lock\.json|\.min\.js)$|(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)\.[^/]+$/iu
const privateValue = /-----BEGIN [^-\r\n]*PRIVATE KEY-----|\b(?:AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b|https?:\/\/[^\s/@:]+:[^\s/@]+@|(?:^|\s|['"])(?:[\w.-]*(?:secret|password|passwd|access.?token|api.?key))[\s'"]*[:=]\s*['"]?[A-Za-z0-9!@#$%^&*_/+.-]{8,}(?:['"\s,;]|$)/imu
const maxFileBytes = 384 * 1024

export function repositorySourcePath(source: RepositorySource, file: string): boolean {
  return repositoryPath(file) && (allowedExtensions.test(file) || /(?:^|\/)(?:README|LICENSE)$/iu.test(file)) &&
    !excludedPath.test(file) && source.paths.some(prefix => file === prefix || file.startsWith(prefix + '/'))
}

export function safeRepositoryText(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(value) && !privateValue.test(value)
}

export interface RepositoryGitOptions {
  readonly directory: string
  readonly testRemote?: (source: RepositorySource) => string
}

function run(cwd: string, args: readonly string[], signal: AbortSignal, options: { limit?: number; noMatch?: boolean; local?: boolean } = {}) {
  signal.throwIfAborted()
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: options.local ? 'file' : 'ssh:https',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS']) Reflect.deleteProperty(env, name)
  const parameters = ['-c', 'http.followRedirects=false', '-c', 'credential.interactive=never', '-c', 'core.quotePath=false',
    '-c', 'core.hooksPath=./knowledge-no-hooks', ...args]
  return new Promise<string>((resolve, reject) => {
    execFile('git', parameters, { cwd, env, signal, encoding: 'utf8', windowsHide: true, timeout: 90_000,
      maxBuffer: options.limit ?? 1024 * 1024 }, (error, stdout) => {
      if (signal.aborted) return reject(signal.reason)
      if (error && (!options.noMatch || error.code !== 1)) return reject(new Error('Git 仓库命令失败'))
      resolve(stdout)
    })
  })
}

export function createRepositoryGit(options: RepositoryGitOptions) {
  const mirror = (source: RepositorySource) => path.join(options.directory, source.id, 'git')
  const literalPaths = (source: RepositorySource) => source.paths.map(file => ':(literal)' + file)
  const git = (source: RepositorySource, args: readonly string[], signal: AbortSignal, limit?: number, noMatch?: boolean) => run(mirror(source), args,
    signal, { ...(limit !== undefined ? { limit } : {}), ...(noMatch ? { noMatch } : {}), local: !!options.testRemote })
  type File = { readonly oid: string; readonly size: number }
  const treeTasks = new Map<string, Promise<Map<string, File>>>()

  function tree(source: RepositorySource, sha: string, signal: AbortSignal): Promise<Map<string, File>> {
    signal.throwIfAborted()
    if (!shaPattern.test(sha)) throw new Error('仓库版本无效')
    const key = JSON.stringify([source.id, sha, source.paths])
    let task = treeTasks.get(key)
    if (!task) {
      task = git(source, ['ls-tree', '-r', '-z', '-l', '--full-tree', sha, '--', ...literalPaths(source)], signal, 8 * 1024 * 1024).then(output => {
        const files = new Map<string, File>()
        for (const row of output.split('\0')) {
          const match = /^100(?:644|755) blob ([a-f0-9]{40,64}) +([0-9]+)\t([^\n]+)$/u.exec(row)
          if (!match) continue
          const [, oid, bytes, file] = match
          if (oid && file && repositorySourcePath(source, file) && Number(bytes) <= maxFileBytes) files.set(file, { oid, size: Number(bytes) })
        }
        return files
      })
      const current = task
      treeTasks.set(key, task)
      void task.catch(() => { if (treeTasks.get(key) === current) treeTasks.delete(key) })
      if (treeTasks.size > 16) treeTasks.delete(treeTasks.keys().next().value!)
    }
    return task
  }

  async function snippet(source: RepositorySource, sha: string, file: string, start: number, signal: AbortSignal, span = 23): Promise<RepositoryEvidence | undefined> {
    if (!Number.isSafeInteger(start) || start < 1 || !repositorySourcePath(source, file)) return
    const entry = (await tree(source, sha, signal)).get(file)
    if (!entry || !entry.size) return
    const body = await git(source, ['cat-file', 'blob', entry.oid], signal, maxFileBytes + 512)
    if (!safeRepositoryText(body)) return
    const lines = body.split(/\r?\n/u)
    if (start > lines.length) return
    const end = Math.min(lines.length, start + span - 1)
    const text = lines.slice(start - 1, end).map(line => line.slice(0, 430)).join('\n').trim()
    if (text) return { repoId: source.id, sha, path: file, start, end, text }
  }

  return {
    async sync(source: RepositorySource, signal: AbortSignal, onFetched: (sha: string) => void, previous?: string) {
      const dir = mirror(source)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await git(source, ['init', '--bare', '--quiet', '--template='], signal)
      await git(source, ['fetch', '--quiet', '--no-recurse-submodules', '--no-auto-maintenance', '--tags',
        options.testRemote?.(source) ?? source.remote, '+refs/heads/' + source.branch + ':refs/knowledge/tracked'], signal)
      const sha = (await git(source, ['rev-parse', '--verify', 'refs/knowledge/tracked^{commit}'], signal)).trim()
      if (!shaPattern.test(sha)) throw new Error('云效返回的仓库版本无效')
      onFetched(sha)
      const files = await tree(source, sha, signal)
      const changes = previous && shaPattern.test(previous) && previous !== sha ?
        (await git(source, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', previous, sha, '--', ...literalPaths(source)],
          signal, 4 * 1024 * 1024)).split('\0').filter(file => repositorySourcePath(source, file)) : []
      await git(source, ['update-ref', 'refs/knowledge/pinned/' + sha, sha], signal)
      return { sha, files: files.size, changes }
    },
    async tag(source: RepositorySource, name: string, signal: AbortSignal) {
      if (!repositoryRef(name)) return undefined
      try {
        const sha = (await git(source, ['rev-parse', '--verify', 'refs/tags/' + name + '^{commit}'], signal)).trim()
        return shaPattern.test(sha) ? sha : undefined
      } catch { signal.throwIfAborted(); return undefined }
    },
    async search(source: RepositorySource, sha: string, terms: readonly string[], signal: AbortSignal, limit = 7) {
      const files = await tree(source, sha, signal)
      const candidates = new Map<string, { file: string; line: number; score: number }>()
      const valid = [...new Set(terms.map(term => term.trim()))].filter(term => term.length >= 2 && term.length <= 160 && safeRepositoryText(term)).slice(0, 8)
      for (const term of valid) {
        let matches: string
        try {
          matches = await git(source, ['grep', '-I', '-i', '-F', '-n', '-z', '--no-textconv', '-m', '3', '-e', term, sha, '--', ...literalPaths(source)],
            signal, 8 * 1024 * 1024, true)
        } catch { signal.throwIfAborted(); continue }
        for (const result of matches.matchAll(/(?:^|\n)[^:\n]+:([^\0\n]+)\0(\d+)\0([^\n]*)/gu)) {
          const [, file, lineText, body = ''] = result
          if (!file || !lineText || !files.has(file)) continue
          const line = Number(lineText)
          const key = JSON.stringify([file, Math.floor((line - 1) / 10)])
          const nameMatch = file.toLowerCase().includes(term.toLowerCase()) ? 9 : 0
          const score = Math.min(term.length, 18) + nameMatch + (body.includes(term) ? 2 : 0) +
            (/\/(?:references|docs)\//u.test(file) ? 2 : 0)
          const prior = candidates.get(key)
          if (prior) prior.score += score
          else candidates.set(key, { file, line, score })
        }
        for (const file of files.keys()) {
          if (!file.toLowerCase().includes(term.toLowerCase())) continue
          const key = JSON.stringify([file, 0])
          const prior = candidates.get(key)
          if (prior) prior.score += 4
          else candidates.set(key, { file, line: 1, score: 4 })
        }
      }
      const rows: RepositoryEvidence[] = []
      const sent = new Map<string, number>()
      for (const row of [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 64)) {
        if ((sent.get(row.file) ?? 0) >= 2 || rows.some(item => item.path === row.file && row.line >= item.start && row.line <= item.end)) continue
        const evidence = await snippet(source, sha, row.file, Math.max(1, row.line - 6), signal)
        if (!evidence) continue
        rows.push(evidence)
        sent.set(row.file, (sent.get(row.file) ?? 0) + 1)
        if (rows.length >= limit) break
      }
      return rows
    },
    snippet,
    async overview(source: RepositorySource, sha: string, signal: AbortSignal) {
      const files = await tree(source, sha, signal)
      const titles = [...files.keys()].filter(file => /(?:^|\/)(?:readme(?:\.[^.]+)?|(?:index|source-index|task-landing-spots|directory-map|modules-and-packages)\.md|pom\.xml|package\.json)$/iu.test(file))
      const result = await Promise.all(titles.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 7)
        .map(file => snippet(source, sha, file, 1, signal, 45)))
      return result.filter((item): item is RepositoryEvidence => !!item)
    },
  }
}
