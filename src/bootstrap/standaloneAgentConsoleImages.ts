import * as fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleResponse, AgentConsoleService } from '../contracts/agentConsole.js'
import type { MessageImage } from '../contracts/platformConnection.js'
import { validateAgentToolImageBytes } from '../modules/image/infrastructure/agentToolImage.js'
import { createAgentImageRunner, type AgentImageToolsOptions } from '../modules/tools/infrastructure/agentImageTools.js'

const extensions: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}
const assetName = /^[\w.-]{1,200}\.(?:png|jpe?g|webp|gif)$/iu
const jobId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const jobsLimit = 2
const historyLimit = 100
const maximumAssetBytes = 20 * 1024 * 1024

interface ImageJobMeta {
  readonly at: string
  readonly mode: 'generate' | 'edit'
  readonly prompt: string
  readonly provider: string
  readonly aspectRatio: string
  readonly size: string
  readonly quality: string
  readonly n: number
}

function json(value: AgentConsoleJson, status = 200): AgentConsoleResponse {
  return { kind: 'json', value, status }
}

function requestFields(request: AgentConsoleRequest) {
  try {
    if (!request.bytes || request.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw Error()
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error()
    return body as Record<string, unknown>
  } catch {
    throw new AgentConsoleError('invalid_request')
  }
}

function option(value: unknown, maximum: number) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AgentConsoleError('invalid_request')
  }
  return value.trim()
}

function readLocalFile(filename: string, limit: number): Buffer | undefined {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size < 1 || stat.size > limit) return undefined
  const buffer = fs.readFileSync(filename)
  return buffer.length <= limit ? buffer : undefined
}

function readMeta(filename: string): Record<string, unknown> {
  const bytes = readLocalFile(filename, 16 * 1024)
  if (!bytes) return {}
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function createStandaloneAgentConsoleImages(options: AgentImageToolsOptions & {
  readonly dataDir: string
  readonly recordUsage?: (model: string, usage: unknown) => void
}): readonly AgentConsoleService[] {
  const runner = createAgentImageRunner(options)
  const root = path.join(options.dataDir, 'console', 'draw')
  const legacy = path.join(options.dataDir, 'legacy-console', 'draw')
  const running = new Set<{ owner: string; abort: AbortController }>()

  function listing(directory: string) {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return []
    return fs.readdirSync(directory, { withFileTypes: true })
  }

  function filenameAllowed(filename: string) {
    return assetName.test(filename) && !filename.startsWith('.') && !filename.includes('..')
  }

  function assets(directory: string) {
    return listing(directory).filter(entry => entry.isFile() && filenameAllowed(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap(entry => {
        const stat = fs.lstatSync(path.join(directory, entry.name), { throwIfNoEntry: false })
        return stat?.isFile() && stat.size > 0 && stat.size <= maximumAssetBytes
          ? [{ file: entry.name, bytes: stat.size, at: stat.mtimeMs }] : []
      })
  }

  function history() {
    function batch(id: string, metadata: Record<string, unknown>, images: ReturnType<typeof assets>) {
      const safe = (key: string, limit: number) => {
        const value = metadata[key]
        return typeof value === 'string' && value.length <= limit && !runner.containsSecret(value) ? value : ''
      }
      return { id, images, count: images.length, prompt: safe('prompt', 4000), provider: safe('provider', 200),
        mode: safe('mode', 8), aspectRatio: safe('aspectRatio', 16), size: safe('size', 16), quality: safe('quality', 32),
        n: typeof metadata.n === 'number' && metadata.n >= 1 && metadata.n <= 4 ? metadata.n : images.length,
        at: safe('at', 40) || new Date(images[0]!.at).toISOString() }
    }
    const batches = listing(root).filter(entry => entry.isDirectory() && jobId.test(entry.name)).flatMap(entry => {
      const directory = path.join(root, entry.name)
      const images = assets(directory).filter(image => image.file.startsWith(entry.name + '-'))
      return images.length ? [batch(entry.name, readMeta(path.join(directory, 'metadata.json')), images)] : []
    })
    const oldBatches = new Map<string, { metadata: Record<string, unknown>; images: ReturnType<typeof assets> }>()
    for (const item of assets(legacy)) {
      const metadata = readMeta(path.join(legacy, item.file + '.json'))
      const id = typeof metadata.batch === 'string' && /^[\w.-]{1,200}$/u.test(metadata.batch)
        ? 'legacy-' + metadata.batch : 'legacy-' + item.file
      const previous = oldBatches.get(id)
      if (previous) previous.images.push(item)
      else oldBatches.set(id, { metadata, images: [item] })
    }
    for (const [id, { metadata, images }] of oldBatches) batches.push(batch(id, metadata, images))
    return batches.sort((left, right) => right.images[0]!.at - left.images[0]!.at).slice(0, historyLimit)
  }

  function save(images: readonly MessageImage[], metadata: ImageJobMeta, ensureCurrent: () => void) {
    const id = randomUUID()
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const temporary = fs.mkdtempSync(path.join(root, '.draw-'))
    let published = false
    try {
      const files = images.map((image, index) => {
        const file = id + '-' + (index + 1) + '.' + extensions[image.mime]
        const bytes = Buffer.from(image.base64, 'base64')
        fs.writeFileSync(path.join(temporary, file), bytes, { flag: 'wx', mode: 0o600 })
        return { file, bytes: bytes.length }
      })
      fs.writeFileSync(path.join(temporary, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
      ensureCurrent()
      fs.renameSync(temporary, path.join(root, id))
      published = true
      return files
    } finally {
      if (!published) fs.rmSync(temporary, { recursive: true, force: true })
    }
  }

  async function generate(request: AgentConsoleRequest, context: AgentConsoleContext, mode: 'generate' | 'edit') {
    const body = requestFields(request)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt || prompt.length > 4000 || runner.containsSecret(prompt) ||
      Object.keys(body).some(key => !['prompt', 'provider', 'aspectRatio', 'size', 'quality', 'n', 'images'].includes(key))) {
      throw new AgentConsoleError('invalid_request')
    }
    const provider = option(body.provider, 200)
    const aspectRatio = option(body.aspectRatio, 16)
    const size = option(body.size, 16).toLowerCase()
    const quality = option(body.quality, 32)
    const count = body.n ?? 1
    const references = body.images ?? []
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 4 ||
      !Array.isArray(references) || references.length > 4 ||
      mode === 'edit' && references.length === 0 || mode === 'generate' && references.length !== 0) {
      throw new AgentConsoleError('invalid_request')
    }
    if (running.size >= jobsLimit) return json({ error: '已有生图任务在进行中，请稍候再试' }, 409)
    const job = { owner: context.principal.id, abort: new AbortController() }
    running.add(job)
    const signal = AbortSignal.any([context.signal, job.abort.signal])
    const ensureCurrent = () => {
      signal.throwIfAborted()
      context.ensureCurrent()
    }
    const startedAt = Date.now()
    try {
      const result = await runner.run(mode, { prompt, count,
        ...(provider ? { provider } : {}), ...(aspectRatio ? { aspectRatio } : {}),
        ...(size ? { size } : {}), ...(quality ? { quality } : {}),
        async references(_guard, add) {
          for (const value of references) {
            if (typeof value !== 'string') throw new AgentConsoleError('invalid_request')
            const item = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/u.exec(value)
            if (!item) throw new AgentConsoleError('invalid_request')
            add({ mime: item[1]!, base64: item[2]! })
          }
        },
      }, { signal, ensureCurrent: async () => ensureCurrent(), isCurrent: () => !signal.aborted && context.isCurrent(),
        ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}) })
      context.ensureCurrent()
      if (result.status !== 'succeeded') return json({ error: result.content, outcome: result.status }, result.status === 'unknown' ? 502 : 422)
      const at = new Date().toISOString()
      const files = save(result.images, { at, mode, prompt, provider: result.provider, aspectRatio, size, quality, n: count }, ensureCurrent)
      return json({ ok: true, mode, provider: result.provider, tookMs: Date.now() - startedAt, count: files.length, images: files })
    } finally {
      running.delete(job)
    }
  }

  const handlers: Readonly<Record<string, NonNullable<AgentConsoleService['handle']>>> = {
    'images.providers': async () => json(runner.list),
    'images.history': async () => json(history()),
    'images.generate': (request, context) => generate(request, context, 'generate'),
    'images.edit': (request, context) => generate(request, context, 'edit'),
    'images.cancel': async (_request, context) => {
      context.ensureCurrent()
      let cancelled = 0
      for (const job of running) {
        if (job.owner !== context.principal.id || job.abort.signal.aborted) continue
        job.abort.abort()
        cancelled++
      }
      return json({ ok: true, cancelled })
    },
    'images.read': async (request) => {
      const name = request.params.name
      if (!name || !filenameAllowed(name)) throw new AgentConsoleError('not_found')
      const id = name.slice(0, 36)
      const directory = jobId.test(id) && name[id.length] === '-' ? path.join(root, id) : legacy
      if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new AgentConsoleError('not_found')
      const bytes = readLocalFile(path.join(directory, name), maximumAssetBytes)
      if (!bytes) throw new AgentConsoleError('not_found')
      const image = validateAgentToolImageBytes(bytes)
      return { kind: 'bytes', contentType: image.mime, value: bytes }
    },
  }
  return AGENT_CONSOLE_SERVICES.flatMap(service => {
    const handle = handlers[service.operation]
    return handle ? [{ ...service, handle }] : []
  })
}
