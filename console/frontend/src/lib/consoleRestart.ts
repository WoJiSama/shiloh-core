import { computed, reactive } from 'vue'

export interface ConfigSaveResult<T> {
  changed: number
  requiresRestart: boolean
  committedRevision: string
  processEpoch: string
  view: T
}
export interface ConfigProcessState {
  processEpoch: string
  loadedRevision: string
  storedRevision: string
  requiresRestart: boolean
  phase: 'active' | 'restart-required' | 'uncertain'
  recoveryRequired?: boolean
  transaction?: ConfigTransactionState
}
export interface ConfigTransactionState {
  phase: 'clean' | 'recovery-required' | 'blocked'
  txId?: string
  direction?: 'undo' | 'redo'
  reason?: string
}
export function parseConfigProcessState(value: unknown): ConfigProcessState & {
  recoveryRequired: boolean
  transaction: ConfigTransactionState
} {
  function fail(): never {
    throw new Error('无法核对配置状态，请保留草稿后重试检查')
  }
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail()
  const text = (value: unknown, allowEmpty = false): string =>
    typeof value === 'string' &&
    value.length <= 4096 &&
    (allowEmpty || !!value.trim()) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
      ? value
      : fail()
  const raw = record(value)
  if (
    typeof raw.phase !== 'string' ||
    !['active', 'restart-required', 'uncertain'].includes(raw.phase) ||
    typeof raw.requiresRestart !== 'boolean'
  )
    fail()
  const recoveryRequired = Object.hasOwn(raw, 'recoveryRequired')
    ? typeof raw.recoveryRequired === 'boolean'
      ? raw.recoveryRequired
      : fail()
    : false
  let transaction: ConfigTransactionState = { phase: 'clean' }
  if (Object.hasOwn(raw, 'transaction')) {
    const item = record(raw.transaction)
    if (
      typeof item.phase !== 'string' ||
      !['clean', 'recovery-required', 'blocked'].includes(item.phase)
    )
      fail()
    transaction = { phase: item.phase as ConfigTransactionState['phase'] }
    if (Object.hasOwn(item, 'txId')) transaction.txId = text(item.txId)
    if (Object.hasOwn(item, 'direction')) {
      if (item.direction !== 'undo' && item.direction !== 'redo') fail()
      transaction.direction = item.direction
    }
    if (Object.hasOwn(item, 'reason')) {
      if (typeof item.reason !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/u.test(item.reason)) fail()
      transaction.reason = item.reason
    }
  }
  const next = {
    processEpoch: text(raw.processEpoch),
    loadedRevision: text(raw.loadedRevision),
    storedRevision: text(raw.storedRevision, true),
    requiresRestart: raw.requiresRestart,
    phase: raw.phase as ConfigProcessState['phase'],
    recoveryRequired,
    transaction
  }
  if (
    recoveryRequired !== (transaction.phase !== 'clean') ||
    (next.phase === 'active' &&
      (next.requiresRestart ||
        next.loadedRevision !== next.storedRevision ||
        next.recoveryRequired))
  )
    fail()
  return next
}
const commitPath = '/api/configuration/commit'
export const isConfigurationWrite = (path: string, method = 'GET') =>
  (method.toUpperCase() === 'POST' && path === commitPath) ||
  (method.toUpperCase() === 'PUT' &&
    (/^\/api\/config\/[^/?]+(?:\?|$)/.test(path) ||
      ['/api/ai/config', '/api/persona/library', '/api/persona/assignments'].includes(path)))
const stateRequest = (path: string) => path === '/api/config-state'
const authRequest = (path: string) => path.startsWith('/api/auth/')
export const isConfigurationRead = (path: string) =>
  path.startsWith('/api/config/') ||
  path === '/api/configuration/catalog' ||
  ['/api/ai/config', '/api/persona/library', '/api/persona/assignments'].includes(path)
const stale = () => new DOMException('配置有效期已改变，请等待重启后重新载入', 'AbortError')

export function createConsoleRestartGate() {
  const state = reactive({
    standalone: false,
    phase: 'active' as 'active' | 'saving' | 'restart-required' | 'uncertain',
    processEpoch: '',
    committedRevision: '',
    recoveryRequired: false,
    transaction: { phase: 'clean' } as ConfigTransactionState,
    generation: 0,
    reloadGeneration: 0
  })
  const blocked = computed(
    () => state.standalone && (state.phase !== 'active' || state.recoveryRequired)
  )
  function assertAllowed(path: string, method = 'GET') {
    if (!blocked.value || authRequest(path) || stateRequest(path)) return
    if (method.toUpperCase() !== 'GET' || isConfigurationRead(path)) throw stale()
  }
  function invalidate() {
    if (!state.standalone || blocked.value) return
    state.phase = 'restart-required'
    state.generation++
  }
  function observe(value: unknown, generation: number) {
    if (generation !== state.generation) throw stale()
    const view = value as { mode?: string; processEpoch?: string }
    if (view?.mode !== 'standalone') return
    if (typeof view.processEpoch !== 'string' || !view.processEpoch) throw stale()
    if (state.processEpoch && state.processEpoch !== view.processEpoch) {
      invalidate()
      throw stale()
    }
    state.standalone = true
    state.processEpoch = view.processEpoch
  }
  function begin(path = '') {
    if (blocked.value || !state.processEpoch) throw stale()
    state.phase = 'saving'
    state.generation++
    return { generation: state.generation, processEpoch: state.processEpoch, path }
  }
  function complete(ticket: ReturnType<typeof begin>, result: unknown) {
    if (ticket.generation !== state.generation || ticket.processEpoch !== state.processEpoch)
      throw stale()
    const saved = result as Partial<ConfigSaveResult<unknown>>
    if (
      !saved ||
      typeof saved !== 'object' ||
      saved.processEpoch !== ticket.processEpoch ||
      typeof saved.requiresRestart !== 'boolean' ||
      typeof saved.committedRevision !== 'string' ||
      !saved.committedRevision ||
      typeof saved.changed !== 'number' ||
      !Number.isSafeInteger(saved.changed) ||
      saved.changed < 0 ||
      (!saved.requiresRestart && saved.changed !== 0) ||
      !saved.view ||
      typeof saved.view !== 'object'
    ) {
      state.phase = 'uncertain'
      throw new Error('保存响应无法核对，请先检查服务状态；草稿已保留')
    }
    state.committedRevision = saved.requiresRestart ? saved.committedRevision : ''
    state.phase = saved.requiresRestart ? 'restart-required' : 'active'
  }
  function failed(
    ticket: ReturnType<typeof begin> | undefined,
    error: unknown,
    path = ticket?.path ?? ''
  ) {
    if (ticket && ticket.generation !== state.generation) return
    const status = (error as { status?: number })?.status
    const code = (error as { details?: { error?: unknown } })?.details?.error
    if (status === 503 && code === 'configuration_recovery_required') {
      state.standalone = true
      state.recoveryRequired = true
      state.transaction = { phase: 'recovery-required' }
      state.phase = 'uncertain'
      if (!ticket) state.generation++
      return
    }
    if (!ticket || state.phase !== 'saving') return
    state.phase =
      (status && [400, 401, 403, 404, 413, 422].includes(status)) ||
      (status === 409 &&
        code === 'candidate_stale' &&
        ticket.path === commitPath &&
        path === commitPath)
        ? 'active'
        : 'uncertain'
  }
  function process(value: unknown) {
    const next = parseConfigProcessState(value)
    const newEpoch = !!state.processEpoch && next.processEpoch !== state.processEpoch
    state.standalone = true
    if (!state.processEpoch) state.processEpoch = next.processEpoch
    if (
      newEpoch &&
      next.phase === 'active' &&
      !next.requiresRestart &&
      !next.recoveryRequired &&
      next.transaction.phase === 'clean' &&
      next.loadedRevision === next.storedRevision &&
      (!state.committedRevision || next.loadedRevision === state.committedRevision)
    ) {
      state.processEpoch = next.processEpoch
      state.committedRevision = ''
      state.phase = 'active'
      state.recoveryRequired = false
      state.transaction = next.transaction
      state.generation++
      state.reloadGeneration++
    } else {
      if (newEpoch) {
        state.processEpoch = next.processEpoch
        state.generation++
      }
      if (next.recoveryRequired) {
        if (!state.recoveryRequired && !newEpoch) state.generation++
        state.recoveryRequired = true
        state.transaction = next.transaction
        state.phase = 'uncertain'
      } else if (!state.recoveryRequired) {
        state.transaction = next.transaction
        if (state.phase === 'active' && (next.requiresRestart || next.phase !== 'active')) {
          state.phase = next.phase === 'uncertain' ? 'uncertain' : 'restart-required'
          if (!newEpoch) state.generation++
        } else if (newEpoch && state.phase === 'saving') state.phase = 'uncertain'
      }
    }
  }
  return { state, blocked, assertAllowed, observe, begin, complete, failed, process, invalidate }
}

export const consoleRestart = createConsoleRestartGate()
