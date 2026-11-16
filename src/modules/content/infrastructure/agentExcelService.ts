import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { agentExcelQuery, MAX_AGENT_EXCEL_BYTES, MAX_AGENT_EXCEL_RESULT_CHARS, parseAgentExcelInput } from './agentExcelTypes.js'
import type { AgentExcelWorkerRequest } from './agentExcelTypes.js'
import { excelZipBudget } from './excelZipGuard.js'
import type { ExcelZipBudget } from './excelZipGuard.js'

export type AgentExcelContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export interface AgentExcelServiceOptions {
  /** Total queue, authorization, parsing and cleanup deadline; may only shorten twenty seconds. */
  readonly timeoutMs?: number
  readonly maxConcurrent?: number
  readonly maxQueued?: number
  readonly zipBudget?: Partial<ExcelZipBudget>
  /** Trusted host/test seam. The model never selects a worker or supplies an executable path. */
  readonly workerFactory?: (url: URL, options: WorkerOptions) => Worker
}
export interface AgentExcelService {
  query(input: AgentExcelWorkerRequest, context: AgentExcelContext): Promise<string>
}
const unavailable = () => new Error('Excel 读取已停止：文件格式、解析预算、期限或授权无效')
function current(context: AgentExcelContext, signal: AbortSignal) {
  try { return !signal.aborted && !context.signal.aborted && context.isCurrent() } catch { return false }
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable())
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, () => { signal.removeEventListener('abort', abort); reject(unavailable()) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
interface Job {
  readonly input: AgentExcelWorkerRequest
  readonly context: AgentExcelContext
  readonly signal: AbortSignal
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  cleanup(): void
  authority?: Promise<void>
  worker?: Worker
  reserved: boolean
  ending: boolean
  received: boolean
}
/** One owned worker per request. No workbooks, source URLs or cross-conversation caches are retained. */
export function createAgentExcelService(options: AgentExcelServiceOptions = {}): AgentExcelService {
  const timeoutMs = options.timeoutMs ?? 15_000, maximum = options.maxConcurrent ?? 1, maxQueued = options.maxQueued ?? 4
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000 ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 8) throw unavailable()
  const budget = excelZipBudget(options.zipBudget)
  const workerFactory = options.workerFactory ?? ((url, config) => new Worker(url, config))
  const queue: Job[] = []
  let active = 0
  async function authorize(job: Job): Promise<void> {
    if (!current(job.context, job.signal)) throw unavailable()
    if (!job.authority) {
      const checking = bounded(Promise.resolve().then(async () => {
        if (!current(job.context, job.signal)) throw unavailable()
        await job.context.ensureCurrent?.()
        if (!current(job.context, job.signal)) throw unavailable()
      }), job.signal)
      job.authority = checking
      void checking.finally(() => { if (job.authority === checking) delete job.authority }).catch(() => {})
    }
    await job.authority
    if (!current(job.context, job.signal)) throw unavailable()
  }
  async function finish(job: Job, error?: Error, content?: string) {
    if (job.ending) return
    job.ending = true
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    try {
      // Do not free the slot or return a result while cancelled parsing can still execute.
      if (job.worker) await job.worker.terminate()
      if (error || !current(job.context, job.signal) || content === undefined) job.reject(unavailable())
      else job.resolve(content)
    } catch { job.reject(unavailable()) }
    finally {
      job.cleanup()
      if (job.reserved) active--
      pump()
    }
  }
  async function run(job: Job) {
    try {
      await authorize(job)
      if (job.ending) return
      // An exact, unpooled allocation avoids transferring unrelated Buffer slab bytes.
      const bytes = Uint8Array.from(job.input.bytes)
      job.worker = workerFactory(new URL('./agentExcelWorker.js', import.meta.url), {
        workerData: { bytes: bytes.buffer, query: job.input.query, source: job.input.source, budget }, transferList: [bytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }, env: {}, execArgv: [],
      })
      job.worker.once('message', (value: unknown) => {
        job.received = true
        void (async () => {
          if (job.ending) return
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
          const message = value as Record<string, unknown>
          if (message.ok !== true || typeof message.content !== 'string' || !message.content ||
              message.content.length > MAX_AGENT_EXCEL_RESULT_CHARS * 2 || [...message.content].length > MAX_AGENT_EXCEL_RESULT_CHARS) throw unavailable()
          await authorize(job)
          await finish(job, undefined, message.content)
        })().catch(() => { void finish(job, unavailable()) })
      })
      job.worker.once('error', () => { void finish(job, unavailable()) })
      job.worker.once('exit', () => { if (!job.received) void finish(job, unavailable()) })
      if (!current(job.context, job.signal)) void finish(job, unavailable())
    } catch { void finish(job, unavailable()) }
  }
  function pump() {
    while (active < maximum && queue.length) {
      const job = queue.shift()!
      if (job.ending) continue
      active++; job.reserved = true
      void run(job)
    }
  }
  return {
    async query(input, context) {
      // Own every parameter and byte before the first asynchronous authorization or queue wait.
      if (!input || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > MAX_AGENT_EXCEL_BYTES ||
          !input.source || typeof input.source.name !== 'string' || !input.source.name.trim() || input.source.name.length > 255 ||
          /[\u0000-\u001f\u007f]/u.test(input.source.name) || input.source.origin !== undefined &&
            !['current', 'reply', 'recent', 'group_file', 'explicit'].includes(input.source.origin)) throw unavailable()
      const query = agentExcelQuery(parseAgentExcelInput(input.query))
      const owned: AgentExcelWorkerRequest = { bytes: Uint8Array.from(input.bytes), query,
        source: Object.freeze({ name: input.source.name, ...(input.source.origin ? { origin: input.source.origin } : {}) }) }
      if (!current(context, context.signal) || active >= maximum && queue.length >= maxQueued) throw unavailable()
      return await new Promise<string>((resolve, reject) => {
        const deadline = AbortSignal.timeout(timeoutMs), signal = AbortSignal.any([context.signal, deadline])
        const abort = () => { void finish(job, unavailable()) }
        const timer = setInterval(() => { if (!job.ending) void authorize(job).catch(abort) }, 25)
        const job: Job = { input: owned, context, signal, resolve, reject, reserved: false, ending: false, received: false,
          cleanup() { clearInterval(timer); signal.removeEventListener('abort', abort) } }
        signal.addEventListener('abort', abort, { once: true })
        queue.push(job)
        if (signal.aborted) abort()
        else pump()
      })
    },
  }
}
