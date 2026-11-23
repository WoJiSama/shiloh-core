import { ref, shallowRef } from 'vue'
import { api } from './api'
import { parseWorkspace, type ConsoleWorkspace, type WorkspaceCapability, type WorkspaceConnection } from './workspaceModel'
import { consoleRestart } from './consoleRestart'

export function createWorkspaceStore(
  loader: (signal?: AbortSignal) => Promise<unknown>,
  onAccepted?: (value: ConsoleWorkspace) => void,
  currentGeneration?: () => number
) {
  const mode = ref<'unknown' | 'legacy' | 'standalone'>('unknown'),
    data = shallowRef<ConsoleWorkspace | null>(null),
    error = ref(''),
    loading = ref(false)
  let sequence = 0
  async function load(signal?: AbortSignal) {
    const ticket = ++sequence,
      generation = currentGeneration?.()
    loading.value = true
    try {
      const result = await loader(signal)
      if (signal?.aborted || ticket !== sequence) return
      const parsed = parseWorkspace(result)
      if (currentGeneration && generation !== currentGeneration())
        throw new DOMException('工作区读取已过期，请重新检查', 'AbortError')
      onAccepted?.(parsed)
      data.value = parsed
      mode.value = 'standalone'
      error.value = ''
    } catch (cause) {
      if (signal?.aborted || ticket !== sequence) return
      if (mode.value === 'unknown' && (cause as { status?: number })?.status === 404) {
        mode.value = 'legacy'
        error.value = ''
        return
      }
      error.value = (cause as Error).message || '工作区暂时不可用'
      throw cause
    } finally {
      if (ticket === sequence) loading.value = false
    }
  }
  function reset() {
    sequence++
    mode.value = 'unknown'
    data.value = null
    error.value = ''
    loading.value = false
  }
  return { mode, data, error, loading, load, reset }
}
export const workspace = createWorkspaceStore(
  (signal) => api('/api/workspace', signal ? { signal } : {}),
  (value) => consoleRestart.process(value.configState),
  () => consoleRestart.state.generation
)
export function capability(operation: string, scopeKey?: string): WorkspaceCapability {
  const item = workspace.data.value?.capabilities.find((item) => item.operation === operation)
  if (consoleRestart.blocked.value && !['observe.read', 'pipeline.read'].includes(operation))
    return {
      operation,
      scope: item?.scope ?? 'global',
      effect: item?.effect ?? 'read',
      status: 'restart-required',
      reason: '当前执行已暂停，请重启服务并核对配置状态后继续。'
    }
  if (workspace.error.value)
    return {
      operation,
      scope: item?.scope ?? 'global',
      effect: item?.effect ?? 'read',
      status: 'unavailable',
      reason: '工作区刷新失败，当前授权状态待核对。请刷新后继续。'
    }
  if (
    item?.scope === 'conversation' &&
    scopeKey !== undefined &&
    !item.authorizedScopes?.includes(scopeKey)
  )
    return { ...item, status: 'forbidden', reason: '当前完整会话未获此项操作授权。' }
  const reasons: Record<string, string> = {
    authorized: '已获授权，操作时仍会核对当前会话。',
    'authorization-denied': '当前身份未获这项管理授权。',
    'authorization-unavailable': '暂时无法核对授权，请稍后重试。',
    'handler-unavailable': '当前宿主尚未提供这项能力。',
    'execution-retired': '执行已暂停，等待服务重启。',
    'no-visible-conversations': '当前身份没有可见的授权会话。'
  }
  return item
    ? { ...item, reason: reasons[item.reason] ?? item.reason }
    : {
        operation,
        scope: 'global',
        effect: 'read',
        status: 'unavailable',
        reason: '当前宿主未提供这项能力。'
      }
}
export function canInspectQqLogin(connection: WorkspaceConnection) {
  return connection.account.platform === 'qq' && connection.capabilities.includes('qq.login') &&
    capability('qq-login.read').status === 'available'
}
export function configurationLabel() {
  if (consoleRestart.state.recoveryRequired || workspace.data.value?.configState.recoveryRequired)
    return '待离线恢复'
  const phase = consoleRestart.blocked.value
    ? consoleRestart.state.phase
    : workspace.data.value?.configState.phase
  return phase === 'saving'
    ? '保存中'
    : phase === 'uncertain'
      ? '待核对'
      : phase === 'restart-required'
        ? '待重启'
        : '已加载'
}
