import { types } from 'node:util'
import type { AgentMediaResourceContext } from '../contracts/agentMediaRelay.js'
import type { AgentGroupLogArtifact } from '../contracts/agentGroupLog.js'
import { MAX_AGENT_GROUP_LOG_BYTES, validateAgentGroupLogArtifact } from '../modules/media/infrastructure/agentGroupLogArtifact.js'
import { openQqBoundedFileBridge } from './qqBoundedFileBridge.js'

export const QQ_GROUP_LOG_TIMEOUT_MS = 10 * 60 * 1000
const failure = () => new Error('QQ 团录临时资源不可用或操作已取消')
export interface QqGroupLogLease {
  /** Private capability; never return to Core, tools, users or persistence. */
  readonly nativeUrl: string
  release(): Promise<void>
}
export interface QqGroupLogBridgeOptions {
  readonly directory: string
  readonly listen: { readonly host: string; readonly port: number }
  readonly advertisedOrigin: string
  readonly allowedPeers: readonly string[]
  readonly maxTotalBytes?: number
  readonly maxLogs?: number
  readonly timeoutMs?: number
}
export interface QqGroupLogBridge {
  stage(log: AgentGroupLogArtifact, context: AgentMediaResourceContext): Promise<QqGroupLogLease>
  close(): Promise<void>
}

function ownedContext(input: AgentMediaResourceContext): AgentMediaResourceContext {
  if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw failure()
  const keys = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input)
  if (keys.some(key => typeof key !== 'string' || !['signal', 'isCurrent', 'ensureCurrent'].includes(key) ||
      !Object.hasOwn(descriptors[key as string]!, 'value'))) throw failure()
  const signal: unknown = descriptors.signal?.value, check: unknown = descriptors.isCurrent?.value, ensure: unknown = descriptors.ensureCurrent?.value
  if (!signal || typeof signal !== 'object' || types.isProxy(signal) || !(signal instanceof AbortSignal) ||
      typeof check !== 'function' || types.isProxy(check) || ensure !== undefined && (typeof ensure !== 'function' || types.isProxy(ensure))) throw failure()
  return Object.freeze({ signal, isCurrent: () => check.call(input) === true,
    ...(typeof ensure === 'function' ? { ensureCurrent: () => ensure.call(input) as Promise<void> } : {}),
  })
}

/** Explicit group-log transport; ordinary files and requester ZIP limits stay unchanged. */
export async function openQqGroupLogBridge(options: QqGroupLogBridgeOptions): Promise<QqGroupLogBridge> {
  try {
    const bridge = await openQqBoundedFileBridge({ directory: options.directory, listen: options.listen,
      advertisedOrigin: options.advertisedOrigin, allowedPeers: options.allowedPeers,
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
      ...(options.maxLogs !== undefined ? { maxFiles: options.maxLogs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }, { validate: validateAgentGroupLogArtifact, maxTotalBytes: 4 * MAX_AGENT_GROUP_LOG_BYTES, maxFiles: 4,
      timeoutMs: QQ_GROUP_LOG_TIMEOUT_MS, resourcePath: 'qq-group-log', directoryPrefix: 'qq-group-log-',
    })
    return Object.freeze({
      async stage(log: AgentGroupLogArtifact, context: AgentMediaResourceContext): Promise<QqGroupLogLease> {
        try {
          const lease = await bridge.stage(log, ownedContext(context))
          return Object.freeze({ nativeUrl: lease.nativeUrl, async release() { try { await lease.release() } catch { throw failure() } } })
        } catch { throw failure() }
      },
      async close() { try { await bridge.close() } catch { throw failure() } },
    })
  } catch { throw failure() }
}
