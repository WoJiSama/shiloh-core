import { computed, ref, shallowRef } from 'vue'
import { api } from './api'
import { capability } from './workspace'
import { consoleRestart } from './consoleRestart'
import {
  parseConfigurationCatalog,
  parseConfigurationPreview,
  parseConfigurationCommitResult,
  type ConfigurationCatalog,
  type ConfigurationChange,
  type ConfigurationPreview,
  type ConfigurationCommitResult
} from './workspaceChangeModel'

type Request = (path: string, options?: RequestInit) => Promise<unknown>
export type ConfigurationIssue = '' | 'stale' | 'unknown' | 'recovery' | 'saved'
const codeOf = (cause: unknown) => (cause as { details?: { error?: string } })?.details?.error
const statusOf = (cause: unknown) => (cause as { status?: number })?.status
const messageOf = (cause: unknown) => {
  const code = codeOf(cause)
  return (
    (
      {
        invalid_request: '填写内容未通过服务端校验，请核对标识、连接地址和会话。',
        forbidden: '当前身份未获此项配置授权。',
        unavailable: '配置服务暂时不可用，请保留草稿后重试读取。',
        candidate_stale: '候选已失效，请重新读取配置并预览；草稿已保留。',
        conflict: '当前配置版本或身份已改变，请核对服务状态。'
      } as Record<string, string>
    )[code ?? ''] ||
    (cause as Error)?.message ||
    '无法核对配置，请保留草稿。'
  )
}
const sameReadSet = (a: ConfigurationCatalog['readSet'], b: ConfigurationCatalog['readSet']) =>
  a.host === b.host && a.personas === b.personas && a.bindings === b.bindings

export function createWorkspaceChangeSession(request: Request = api) {
  const catalog = shallowRef<ConfigurationCatalog | null>(null)
  const preview = shallowRef<ConfigurationPreview | null>(null)
  const receipt = shallowRef<ConfigurationCommitResult | null>(null)
  const loading = ref(false),
    previewing = ref(false),
    committing = ref(false)
  const error = ref(''),
    issue = ref<ConfigurationIssue>(''),
    requiresRead = ref(true)
  let alive = true,
    catalogSequence = 0,
    previewSequence = 0,
    draftVersion = 0
  let catalogController: AbortController | undefined, previewController: AbortController | undefined
  let acceptedVersion = -1,
    acceptedGeneration = -1,
    catalogGeneration = -1,
    submissionEpoch = ''
  const terminal = computed(() => ['unknown', 'recovery', 'saved'].includes(issue.value))
  const busy = computed(() => loading.value || previewing.value || committing.value)
  const locked = computed(() => consoleRestart.blocked.value || committing.value || terminal.value)
  const canStartAnother = computed(
    () =>
      terminal.value &&
      !!catalog.value &&
      !requiresRead.value &&
      catalog.value.processEpoch !== submissionEpoch &&
      !consoleRestart.blocked.value &&
      !busy.value
  )
  const allowed = (operation: string) => capability(operation).status === 'available'

  function invalidatePreview() {
    if (committing.value) return
    draftVersion++
    previewSequence++
    previewController?.abort()
    previewing.value = false
    preview.value = null
    acceptedVersion = -1
    if (!terminal.value && issue.value !== 'stale') error.value = ''
  }
  async function loadCatalog() {
    if (!alive || busy.value || consoleRestart.blocked.value || !allowed('configuration.read'))
      return
    invalidatePreview()
    const ticket = ++catalogSequence,
      generation = consoleRestart.state.generation
    catalogController?.abort()
    const controller = (catalogController = new AbortController())
    loading.value = true
    error.value = ''
    requiresRead.value = true
    try {
      const value = parseConfigurationCatalog(
        await request('/api/configuration/catalog', { signal: controller.signal })
      )
      if (!alive || ticket !== catalogSequence || controller.signal.aborted) return
      if (
        generation !== consoleRestart.state.generation ||
        value.processEpoch !== consoleRestart.state.processEpoch
      )
        throw new Error('读取期间进程已改变，请重新核对配置。')
      catalog.value = value
      catalogGeneration = generation
      requiresRead.value = false
      if (issue.value === 'stale') issue.value = ''
    } catch (cause) {
      if (alive && ticket === catalogSequence && !controller.signal.aborted) {
        catalog.value = null
        error.value = messageOf(cause)
      }
    } finally {
      if (alive && ticket === catalogSequence) loading.value = false
    }
  }
  async function previewChange(change: ConfigurationChange) {
    if (
      !alive ||
      busy.value ||
      locked.value ||
      requiresRead.value ||
      !catalog.value ||
      !allowed('configuration.preview')
    )
      return
    invalidatePreview()
    const current = catalog.value,
      version = draftVersion,
      generation = consoleRestart.state.generation
    if (catalogGeneration !== generation) {
      requiresRead.value = true
      issue.value = 'stale'
      error.value = '进程或配置状态已改变，请重新读取并预览。'
      return
    }
    const ticket = ++previewSequence
    const controller = (previewController = new AbortController())
    previewing.value = true
    error.value = ''
    try {
      const value = parseConfigurationPreview(
        await request('/api/configuration/preview', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ revision: current.revision, change })
        })
      )
      if (
        !alive ||
        ticket !== previewSequence ||
        controller.signal.aborted ||
        draftVersion !== version
      )
        return
      if (
        generation !== consoleRestart.state.generation ||
        value.processEpoch !== current.processEpoch ||
        value.revision !== current.revision ||
        value.configRevision !== current.configRevision ||
        !sameReadSet(value.readSet, current.readSet) ||
        value.expiresAt <= Date.now()
      )
        throw new Error('预览版本与当前配置不一致或已过期，请重新读取并预览。')
      preview.value = value
      acceptedVersion = version
      acceptedGeneration = generation
    } catch (cause) {
      if (alive && ticket === previewSequence && !controller.signal.aborted) {
        error.value = messageOf(cause)
        if (statusOf(cause) === 409) {
          issue.value = 'stale'
          requiresRead.value = true
        }
      }
    } finally {
      if (alive && ticket === previewSequence) previewing.value = false
    }
  }
  async function commit() {
    if (
      !alive ||
      busy.value ||
      locked.value ||
      !preview.value ||
      !catalog.value ||
      !allowed('configuration.commit')
    )
      return
    const selected = preview.value
    if (
      acceptedVersion !== draftVersion ||
      acceptedGeneration !== consoleRestart.state.generation ||
      requiresRead.value ||
      selected.expiresAt <= Date.now() ||
      !sameReadSet(selected.readSet, catalog.value.readSet)
    ) {
      invalidatePreview()
      issue.value = 'stale'
      requiresRead.value = true
      error.value = '候选已失效，请重新读取配置并预览；草稿已保留。'
      return
    }
    committing.value = true
    submissionEpoch = selected.processEpoch
    error.value = ''
    try {
      const value = parseConfigurationCommitResult(
        await request('/api/configuration/commit', {
          method: 'POST',
          body: JSON.stringify({
            previewId: selected.previewId,
            revision: selected.revision,
            candidateDigest: selected.candidateDigest,
            readSet: selected.readSet
          })
        })
      )
      if (!alive) return
      if (value.processEpoch !== selected.processEpoch) throw new Error('提交回执无法匹配原进程')
      receipt.value = value
      issue.value = 'saved'
    } catch (cause) {
      if (!alive) return
      const status = statusOf(cause),
        code = codeOf(cause)
      if (status === 409 && code === 'candidate_stale') {
        issue.value = 'stale'
        requiresRead.value = true
        preview.value = null
        error.value = '候选已失效，服务端未提交。请重新读取配置并预览；草稿已保留。'
      } else if (status === 503 && code === 'configuration_recovery_required') {
        issue.value = 'recovery'
        error.value =
          '配置需要离线恢复，已锁定提交。请停止服务并完成恢复，再重启核对状态；不要补交。'
      } else if (status && [400, 401, 403, 404, 413, 422].includes(status)) {
        preview.value = null
        error.value = messageOf(cause)
      } else {
        issue.value = 'unknown'
        error.value = '提交结果未知，已锁定提交。请核对服务状态；不要再次提交此候选。'
      }
    } finally {
      if (alive) committing.value = false
    }
  }
  function cancelReads() {
    if (committing.value) return false
    if (!terminal.value) invalidatePreview()
    else {
      previewSequence++
      previewController?.abort()
      previewing.value = false
    }
    catalogSequence++
    catalogController?.abort()
    loading.value = false
    return true
  }
  function processReloaded() {
    cancelReads()
    catalog.value = null
    requiresRead.value = true
    if (!terminal.value) {
      issue.value = 'stale'
      error.value = '新进程已加载，请重新读取配置并预览；未提交草稿已保留。'
    }
  }
  function reset() {
    if (busy.value || consoleRestart.blocked.value || (terminal.value && !canStartAnother.value))
      return false
    invalidatePreview()
    issue.value = ''
    receipt.value = null
    error.value = ''
    return true
  }
  function dispose() {
    cancelReads()
    alive = false
  }
  return {
    catalog,
    preview,
    receipt,
    loading,
    previewing,
    committing,
    error,
    issue,
    requiresRead,
    terminal,
    busy,
    locked,
    canStartAnother,
    invalidatePreview,
    loadCatalog,
    previewChange,
    commit,
    cancelReads,
    processReloaded,
    reset,
    dispose
  }
}
