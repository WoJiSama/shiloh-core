import { onBeforeUnmount, ref } from 'vue'
import { api } from './api'

export interface ForgetReceipt {
  operationId: string
  phase: 'accepted' | 'committed' | 'settling' | 'completed' | 'failed' | 'unknown'
  usage: 'pending' | 'blocked' | 'unknown'
  cleanup: 'pending' | 'completed' | 'failed' | 'unknown' | 'unsupported'
  impacts: { kind: string; id: string; partition: string; state: string }[]
}

export function forgetRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function parseForgetReceipt(value: unknown): ForgetReceipt | null {
  if (!value || typeof value !== 'object') return null
  const row = value as ForgetReceipt
  if (typeof row.operationId !== 'string' || !row.operationId ||
    !['accepted', 'committed', 'settling', 'completed', 'failed', 'unknown'].includes(row.phase) ||
    !['pending', 'blocked', 'unknown'].includes(row.usage) ||
    !['pending', 'completed', 'failed', 'unknown', 'unsupported'].includes(row.cleanup) ||
    !Array.isArray(row.impacts) || row.impacts.some(item => !item ||
      ['kind', 'id', 'partition', 'state'].some(key => typeof item[key as keyof typeof item] !== 'string'))) return null
  return row
}

export function useForgetReceipt() {
  const receipt = ref<ForgetReceipt | null>(null), error = ref(''), loading = ref(false)
  let generation = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    selected: { scopeKey: string; bindingToken?: string; isCurrent(): boolean } | undefined
  function reset() {
    generation++
    if (timer) clearTimeout(timer)
    controller?.abort()
    selected = undefined
    receipt.value = null
    error.value = ''
    loading.value = false
  }
  async function refresh(attempt = 0) {
    if (disposed) return
    const scope = selected, operationId = receipt.value?.operationId, ticket = generation
    if (!scope || !operationId || !scope.isCurrent()) return reset()
    if (timer) clearTimeout(timer)
    controller?.abort()
    const pending = new AbortController()
    controller = pending
    loading.value = true
    error.value = ''
    try {
      const query = new URLSearchParams({ scopeKey: scope.scopeKey,
        ...(scope.bindingToken ? { bindingToken: scope.bindingToken } : {}) })
      const row = parseForgetReceipt(await api(`/api/forgetting/${encodeURIComponent(operationId)}?${query}`, { signal: pending.signal }))
      if (ticket !== generation || pending.signal.aborted) return
      if (!scope.isCurrent()) return reset()
      if (!row || row.operationId !== operationId) throw new Error('遗忘回执响应不完整')
      receipt.value = row
      if (!['completed', 'failed', 'unknown'].includes(row.phase) && attempt < 8)
        timer = setTimeout(() => void refresh(attempt + 1), 1000)
    } catch (cause) {
      if (ticket === generation && !pending.signal.aborted) error.value = (cause as Error).message || '暂时无法读取遗忘回执'
    } finally {
      if (ticket === generation && !pending.signal.aborted) loading.value = false
    }
  }
  function capture(value: unknown, scope: NonNullable<typeof selected>) {
    const row = parseForgetReceipt(value)
    if (disposed || !row || !scope.isCurrent()) return
    reset()
    receipt.value = row
    selected = scope
    void refresh()
  }
  onBeforeUnmount(() => { disposed = true; reset() })
  return { receipt, error, loading, capture, refresh, reset }
}
