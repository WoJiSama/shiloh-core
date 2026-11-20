<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NSpace, NTab, NTabs, NTag } from 'naive-ui'
import { api } from '../lib/api'
import { consoleRestart, type ConfigSaveResult } from '../lib/consoleRestart'
import type { StandaloneAiView, StandaloneModel } from '../lib/standaloneConfig'
import { clone, equal } from '../lib/schemaState'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import SaveBar from './SaveBar.vue'
const restartBlocked = consoleRestart.blocked
const props = defineProps<{ initial: StandaloneAiView }>()
const view = ref(clone(props.initial))
const drafts = ref(clone(props.initial.sections)),
  baseline = ref(clone(props.initial.sections))
const active = ref(props.initial.definitions[0]?.configKey || '')
const saving = ref(false),
  error = ref(''),
  saved = ref('')
let request: AbortController | undefined
let probeRequest: AbortController | undefined
const probeState = ref<Record<string, { loading: boolean; detail?: string; ok?: boolean }>>({})
const provider = computed(() => drafts.value[active.value]?.[0])
const selected = computed(() => view.value.definitions.find(item => item.configKey === active.value))
const activeProbe = computed(() => probeState.value[active.value])
const canProbeDraft = computed(() => {
  const saved = baseline.value[active.value]?.[0], draft = provider.value
  if (!saved || !draft) return false
  try { return new URL(draft.baseUrl).href === new URL(saved.baseUrl).href && draft.apiKeyEnv === saved.apiKeyEnv }
  catch { return false }
})
const dirty = computed(() =>
  equal(drafts.value[active.value], baseline.value[active.value]) ? 0 : 1
)
const anyDirty = computed(() => !equal(drafts.value, baseline.value))
const validation = computed(() => {
  const item = provider.value
  if (!item || drafts.value[active.value].length !== 1) return '此槽位需要一个模型配置'
  try {
    const url = new URL(item.baseUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return 'API 地址需为无凭据、查询参数和片段的 HTTP 或 HTTPS 地址'
  } catch {
    return '请填写完整的 API 地址'
  }
  if (!item.name.trim()) return '请填写模型名称'
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(item.apiKeyEnv)) return '凭据需填写有效的环境变量名'
  return ''
})
useUnsavedGuard(() => anyDirty.value || saving.value)
function apply(next: StandaloneAiView, submitted?: Record<string, StandaloneModel[]>) {
  const previous = submitted || baseline.value
  const local = drafts.value
  drafts.value = Object.fromEntries(
    Object.entries(next.sections).map(([key, rows]) => [
      key,
      equal(local[key], previous[key]) ? clone(rows) : clone(local[key] || rows)
    ])
  )
  baseline.value = clone(next.sections)
  view.value = clone(next)
  if (!next.definitions.some((item) => item.configKey === active.value))
    active.value = next.definitions[0]?.configKey || ''
}
async function probe(draft: boolean) {
  const key = active.value, model = provider.value
  if (!model || probeRequest || restartBlocked.value || (draft && (!canProbeDraft.value || validation.value))) return
  const controller = new AbortController()
  probeRequest = controller
  probeState.value[key] = { loading: true }
  try {
    const response = await api<{ results: { name: string; ok: boolean; ms: number; detail: string }[] }>(
      draft ? '/api/ai/probe-provider' : '/api/ai/probe', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ configKey: key, ...(draft ? { provider: {
          baseUrl: model.baseUrl, name: model.name.trim(), apiKeyEnv: model.apiKeyEnv
        } } : {}) })
      })
    const result = response.results[0]
    probeState.value[key] = result
      ? { loading: false, ok: result.ok, detail: `${result.name} · ${result.detail} · ${result.ms} ms` }
      : { loading: false, ok: false, detail: '未收到测试结果' }
  } catch (cause: any) {
    if (cause.name !== 'AbortError') probeState.value[key] = { loading: false, ok: false, detail: cause.message || '测试失败' }
  } finally {
    probeRequest = undefined
  }
}
async function save() {
  if (!dirty.value || saving.value || consoleRestart.blocked.value || validation.value) return
  const key = active.value,
    submitted = clone(drafts.value)
  saving.value = true
  error.value = ''
  request = new AbortController()
  try {
    const rows = submitted[key].map(({ baseUrl, name, apiKeyEnv }) => ({
      baseUrl,
      name,
      apiKeyEnv
    }))
    const result = await api<ConfigSaveResult<StandaloneAiView>>('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify({
        configKey: key,
        providers: rows,
        revision: view.value.revisions[key]
      }),
      signal: request.signal
    })
    const comparison = clone(baseline.value)
    comparison[key] = submitted[key]
    apply(result.view, comparison)
    saved.value = result.requiresRestart ? '已保存，重启服务后生效' : '配置没有变化'
  } catch (cause: any) {
    error.value =
      consoleRestart.state.phase === 'uncertain'
        ? '保存结果待核对，请勿重复保存；草稿已保留'
        : cause.message || '保存失败，草稿已保留'
  } finally {
    saving.value = false
  }
}
watch(
  () => consoleRestart.state.reloadGeneration,
  async () => {
    try {
      apply(await api<StandaloneAiView>('/api/ai/config'))
    } catch (cause: any) {
      error.value = cause.message || '重启后配置加载失败'
    }
  }
)
onBeforeUnmount(() => { request?.abort(); probeRequest?.abort() })
</script>
<template>
  <div class="page-stack standalone-ai-config" :inert="restartBlocked">
    <NAlert type="info" :show-icon="false"
      >每个能力槽位使用一个模型。凭据由服务器环境变量提供，保存后重启服务生效。</NAlert
    >
    <NTabs v-model:value="active" type="line"
      ><NTab v-for="item in view.definitions" :key="item.configKey" :name="item.configKey">{{
        item.title
      }}</NTab></NTabs
    >
    <section v-if="provider" class="panel standalone-model">
      <div class="panel-heading">
        <h2>{{ selected?.title }}</h2>
        <NTag :type="provider.apiKeyConfigured ? 'success' : 'warning'">{{
          provider.apiKeyConfigured ? '凭据已配置' : '凭据尚未配置'
        }}</NTag>
      </div>
      <NSpace v-if="selected?.capabilities?.probe && !restartBlocked" class="probe-actions">
        <NButton size="small" :loading="activeProbe?.loading" @click="probe(false)">测试已启用渠道</NButton>
        <NButton v-if="dirty" size="small" :disabled="!canProbeDraft || !!validation || activeProbe?.loading" @click="probe(true)">测试草稿模型</NButton>
      </NSpace>
      <p v-if="selected?.capabilities?.probe && dirty && !canProbeDraft" class="field-help">API 地址或凭据变更在保存并重启后可测试。</p>
      <NAlert v-if="activeProbe?.detail" :type="activeProbe.ok ? 'success' : 'error'" role="status">{{ activeProbe.detail }}</NAlert>
      <div class="field-grid">
        <div class="form-field">
          <label for="standalone-model-name">模型名称</label
          ><NInput
            id="standalone-model-name"
            v-model:value="provider.name"
            :disabled="restartBlocked"
          />
        </div>
        <div class="form-field">
          <label for="standalone-model-env">凭据环境变量名</label
          ><NInput
            id="standalone-model-env"
            v-model:value="provider.apiKeyEnv"
            :disabled="restartBlocked"
            placeholder="MODEL_API_KEY"
          /><span class="field-help">填写环境变量名，密钥内容不会显示在浏览器。</span>
        </div>
        <div class="form-field full-field">
          <label for="standalone-model-url">API 地址</label
          ><NInput
            id="standalone-model-url"
            v-model:value="provider.baseUrl"
            :disabled="restartBlocked"
          />
        </div>
      </div>
    </section>
    <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
    <p v-if="dirty && validation" role="status">{{ validation }}</p>
    <SaveBar
      :dirty="dirty"
      :saving="saving"
      :saved="saved"
      :disabled="restartBlocked || !!validation"
      @save="save"
      @discard="drafts[active] = clone(baseline[active])"
    />
  </div>
</template>
<style scoped>
.standalone-model {
  padding: 22px;
}
.probe-actions {
  margin-top: 16px;
}
</style>
