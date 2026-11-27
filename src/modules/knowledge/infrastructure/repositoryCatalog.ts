import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { RepositoryCatalog, RepositorySource } from '../../../contracts/repositoryKnowledge.js'
import { conversationAddressKey, isConversationAddress } from '../../runtime/domain/agentBindings.js'

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const pathPattern = /^[\p{L}\p{N}_-][\p{L}\p{N}_. /-]{0,239}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,100}$/u
const emptyCatalog: RepositoryCatalog = { repositories: [], projects: [], grants: [] }

export const repositoryHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function repositoryPath(value: unknown): value is string {
  return typeof value === 'string' && pathPattern.test(value) &&
    value.split('/').every(segment => segment && !segment.startsWith('.') && segment === segment.trim())
}

export function repositoryRef(value: unknown): value is string {
  return typeof value === 'string' && branchPattern.test(value) && !value.includes('..') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field))) {
    throw new Error('项目知识库配置字段无效')
  }
  return value as Record<string, unknown>
}

function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('项目知识库配置列表无效')
  return value
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('项目或仓库 ID 无效')
  return value
}

function unique<T>(values: T[]): T[] {
  if (new Set(values).size !== values.length) throw new Error('项目知识库配置存在重复项')
  return values
}

function repoRemote(value: unknown): { remote: string; link: string } {
  if (typeof value !== 'string' || value.length > 360) throw new Error('云效仓库地址无效')
  const ssh = /^(?:git@codeup\.aliyun\.com:|ssh:\/\/git@codeup\.aliyun\.com\/)([\w.-]+(?:\/[\w.-]+){2,})$/u.exec(value)
  const https = /^https:\/\/codeup\.aliyun\.com\/([\w.-]+(?:\/[\w.-]+){2,})$/u.exec(value)
  const slug = (ssh?.[1] ?? https?.[1])?.replace(/\.git$/u, '')
  if (!slug || !slug.split('/').every(part => /^[A-Za-z0-9_][\w.-]*$/u.test(part) && !part.endsWith('.'))) {
    throw new Error('请提供云效 Codeup 的 SSH 或 HTTPS 仓库地址')
  }
  const link = 'https://codeup.aliyun.com/' + slug
  return { remote: ssh ? 'git@codeup.aliyun.com:' + slug + '.git' : link + '.git', link }
}

export function decodeRepositoryCatalog(input: unknown, bound?: (target: ConversationAddress) => boolean): RepositoryCatalog {
  const root = record(input, ['repositories', 'projects', 'grants'])
  const repositories = list(root.repositories, 32).map(value => {
    const row = record(value, ['id', 'remote', 'link', 'branch', 'paths'])
    if (!repositoryRef(row.branch)) throw new Error('仓库跟踪分支无效')
    const paths = unique(list(row.paths, 32).map(item => {
      if (!repositoryPath(item)) throw new Error('仓库索引路径无效')
      return item
    }))
    if (!paths.length) throw new Error('请选择仓库允许索引的文件或目录')
    return { id: id(row.id), ...repoRemote(row.remote), branch: row.branch, paths } satisfies RepositorySource
  })
  const repos = new Set(unique(repositories.map(row => row.id)))
  unique(repositories.map(row => row.link))
  const projects = list(root.projects, 32).map(value => {
    const row = record(value, ['id', 'name', 'repositories'])
    const selected = unique(list(row.repositories, 8).map(id))
    if (!selected.length || selected.some(repo => !repos.has(repo)) || typeof row.name !== 'string' ||
        !row.name.trim() || row.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(row.name)) throw new Error('项目名称或仓库配置无效')
    return { id: id(row.id), name: row.name.trim(), repositories: selected }
  })
  unique(projects.map(row => row.id))
  const grants = list(root.grants, 1024).map(value => {
    const row = record(value, ['target', 'projectId', 'repositories'])
    const fields = record(row.target, ['account', 'kind', 'id'])
    record(fields.account, ['platform', 'namespace', 'id'])
    const target = fields as unknown as ConversationAddress
    const projectId = id(row.projectId)
    const selected = unique(list(row.repositories, 8).map(id))
    const project = projects.find(item => item.id === projectId)
    if (!isConversationAddress(target) || !['group', 'private'].includes(target.kind) || bound?.(target) === false ||
        !selected.length || !project || selected.some(repo => !project.repositories.includes(repo))) throw new Error('会话的仓库授权无效')
    return { target, projectId, repositories: selected }
  })
  unique(grants.map(row => JSON.stringify([conversationAddressKey(row.target), row.projectId])))
  return { repositories, projects, grants }
}

export async function writeRepositoryJson(file: string, value: unknown, ensureCurrent: () => void): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true })
    ensureCurrent()
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

export async function readRepositoryJson(file: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const raw = await readFile(file)
  if (raw.length > limit) throw new Error('项目知识库文件超过大小限制')
  return JSON.parse(raw.toString('utf8'))
}

export async function openRepositoryCatalog(directory: string, seed: RepositoryCatalog | undefined, isCurrent: () => boolean) {
  const file = path.join(directory, 'catalog.json')
  const used = new Map<string, string>()
  let active: RepositoryCatalog
  try {
    const root = record(await readRepositoryJson(file), ['catalog', 'identities'])
    active = decodeRepositoryCatalog(root.catalog)
    for (const value of list(root.identities, 256)) {
      const row = record(value, ['id', 'link'])
      used.set(id(row.id), repoRemote(row.link).link)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    active = seed ?? emptyCatalog
  }
  for (const source of active.repositories) {
    if (used.has(source.id) && used.get(source.id) !== source.link) throw new Error('仓库 ID 与存储身份不符')
    used.set(source.id, source.link)
  }
  let write = Promise.resolve()
  return {
    get: () => active,
    revision: () => repositoryHash(active),
    replace(revision: string, next: RepositoryCatalog, ensureCurrent: () => void) {
      const task = write.then(async () => {
        if (!isCurrent() || repositoryHash(active) !== revision) return false
        const identities = new Map(used)
        for (const source of next.repositories) {
          const existing = identities.get(source.id)
          if (existing && existing !== source.link || [...identities].some(([key, link]) => key !== source.id && link === source.link)) {
            throw new Error('已登记仓库须沿用原仓库 ID')
          }
          identities.set(source.id, source.link)
        }
        if (identities.size > 256) throw new Error('项目知识库仓库身份容量已满')
        await writeRepositoryJson(file, { catalog: next, identities: [...identities].map(([id, link]) => ({ id, link })) }, () => {
          if (!isCurrent()) throw new Error('仓库管理权限已改变')
          ensureCurrent()
        })
        active = next
        for (const [key, link] of identities) used.set(key, link)
        return true
      })
      write = task.then(() => {}, () => {})
      return task
    },
  }
}
