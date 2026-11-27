<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NSelect } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SaveBar from '../components/SaveBar.vue'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { api } from '../lib/api'
import { consoleRestart, type ConfigSaveResult } from '../lib/consoleRestart'
import { clone, equal } from '../lib/schemaState'
import { capability } from '../lib/workspace'

type GlobalMode = 'all' | 'off'
type Mode = GlobalMode | 'groups' | 'inherit'
type Rule = { mode: GlobalMode } | { mode: 'groups'; groups: string[] }
type Kind = 'features' | 'tools'
interface Policy {
  default: GlobalMode
  features: Record<string, Rule>
  tools: Record<string, Rule>
}
interface FeatureItem {
  kind: Kind
  name: string
  label: string
}
interface SwitchView {
  revision: string
  policy: Policy
  items: FeatureItem[]
  groups: string[]
}

const endpoint = '/api/config/feature-switches'
const view = ref<SwitchView>()
const draft = ref<Policy>()
const filter = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const saved = ref('')
let request: AbortController | undefined

const disabled = computed(
  () =>
    loading.value ||
    saving.value ||
    consoleRestart.blocked.value ||
    capability('config.write').status !== 'available'
)
const dirty = computed(() => {
  if (!draft.value || !view.value) return 0
  const current = draft.value,
    original = view.value.policy
  return (
    Number(current.default !== original.default) +
    (['features', 'tools'] as const).reduce(
      (count, kind) =>
        count +
        [...new Set([...Object.keys(current[kind]), ...Object.keys(original[kind])])].filter(
          (name) => !equal(current[kind][name], original[kind][name])
        ).length,
      0
    )
  )
})
const items = computed(() => {
  const query = filter.value.trim().toLowerCase()
  return (view.value?.items ?? []).filter((item) =>
    `${item.label} ${item.name}`.toLowerCase().includes(query)
  )
})
const sections = computed(() => [
  { title: '自动功能与指令', items: items.value.filter((item) => item.kind === 'features') },
  { title: '模型工具', items: items.value.filter((item) => item.kind === 'tools') }
])
const modeOptions = computed(() => [
  { label: `继承全局（${draft.value?.default === 'off' ? '关闭' : '开启'}）`, value: 'inherit' },
  { label: '全部开启', value: 'all' },
  { label: '仅指定群开启', value: 'groups' },
  { label: '全部关闭', value: 'off' }
])

useUnsavedGuard(() => dirty.value > 0 || saving.value)

function itemRule(item: FeatureItem) {
  const rules = draft.value?.[item.kind]
  return rules && Object.hasOwn(rules, item.name) ? rules[item.name] : undefined
}
function setMode(item: FeatureItem, mode: Mode) {
  if (!draft.value || disabled.value) return
  const rules = draft.value[item.kind]
  if (mode === 'inherit') delete rules[item.name]
  else if (mode === 'groups') setGroups(item, [])
  else draft.value[item.kind] = { ...rules, [item.name]: { mode } }
}
function setGroups(item: FeatureItem, groups: string[]) {
  if (!draft.value || disabled.value) return
  draft.value[item.kind] = {
    ...draft.value[item.kind],
    [item.name]: { mode: 'groups', groups: [...groups].sort() }
  }
}
function itemGroups(item: FeatureItem) {
  const rule = itemRule(item)
  return rule?.mode === 'groups' ? rule.groups : []
}
function groupOptions(item: FeatureItem) {
  const bound = view.value?.groups ?? []
  return [...new Set([...bound, ...itemGroups(item)])].sort().map((value) => ({
    value,
    label: bound.includes(value) ? value : `${value}（未接入）`
  }))
}
function setAll(mode: GlobalMode) {
  if (!disabled.value) draft.value = { default: mode, features: {}, tools: {} }
}
function apply(next: SwitchView, keepDraft = false) {
  const updated = clone(next.policy)
  if (keepDraft && view.value && draft.value) {
    const original = view.value.policy,
      edits = draft.value
    if (edits.default !== original.default) updated.default = edits.default
    for (const kind of ['features', 'tools'] as const) {
      for (const name of new Set([...Object.keys(original[kind]), ...Object.keys(edits[kind])])) {
        if (equal(original[kind][name], edits[kind][name])) continue
        const rule = Object.hasOwn(edits[kind], name) ? edits[kind][name] : undefined
        if (rule) updated[kind] = { ...updated[kind], [name]: clone(rule) }
        else delete updated[kind][name]
      }
    }
  }
  view.value = next
  draft.value = updated
}
function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : '请求失败'
}
async function load() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const next = await api<SwitchView>(endpoint, { signal: controller.signal })
    if (!controller.signal.aborted) apply(next, true)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = errorText(cause)
  } finally {
    if (request === controller) loading.value = false
  }
}
async function save() {
  if (!view.value || !draft.value || !dirty.value || disabled.value) return
  const controller = new AbortController()
  request = controller
  saving.value = true
  error.value = ''
  saved.value = ''
  try {
    const result = await api<ConfigSaveResult<SwitchView>>(endpoint, {
      method: 'PUT',
      body: JSON.stringify({ revision: view.value.revision, values: draft.value }),
      signal: controller.signal
    })
    apply(result.view)
    saved.value = result.requiresRestart ? '已保存，重启服务后生效' : '配置没有变化'
  } catch (cause) {
    if (!controller.signal.aborted)
      error.value =
        consoleRestart.state.phase === 'uncertain' ? '保存结果待核对，草稿已保留' : errorText(cause)
  } finally {
    saving.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => request?.abort())
watch(() => consoleRestart.state.reloadGeneration, load)
</script>

<template>
  <div class="page-stack">
    <PageHeader
      title="工具与功能开关"
      description="开启后仍遵循原有权限和服务配置。保存后重启服务生效。"
    />
    <PageState v-if="!view || !draft" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <section class="panel switch-panel">
        <div class="panel-heading">
          <h2>全局默认{{ draft.default === 'off' ? '关闭' : '开启' }}</h2>
          <div class="switch-actions">
            <NButton :disabled="disabled" @click="setAll('all')">全部开启</NButton>
            <NButton :disabled="disabled" @click="setAll('off')">全部关闭</NButton>
          </div>
        </div>
        <p class="field-help">批量操作会重置各项单独设置。仅指定群开启时，其他会话关闭该项。</p>
        <NInput
          v-model:value="filter"
          placeholder="搜索功能或工具"
          :input-props="{ 'aria-label': '搜索功能或工具' }"
          clearable
        />
      </section>
      <PageState v-if="!items.length" empty empty-text="没有匹配的功能或工具" />
      <template v-for="section in sections" :key="section.title">
        <section v-if="section.items.length" class="panel switch-panel">
          <h2>{{ section.title }}</h2>
          <div v-for="item in section.items" :key="item.name" class="switch-row">
            <span class="row-main"
              ><strong>{{ item.label }}</strong
              ><small v-if="item.label !== item.name">{{ item.name }}</small></span
            >
            <NSelect
              :value="itemRule(item)?.mode ?? 'inherit'"
              :options="modeOptions"
              :aria-label="`${item.label}的开启范围`"
              :disabled="disabled"
              @update:value="(mode: Mode) => setMode(item, mode)"
            />
            <NSelect
              v-if="itemRule(item)?.mode === 'groups'"
              class="switch-groups"
              :value="itemGroups(item)"
              :options="groupOptions(item)"
              :aria-label="`${item.label}的启用群`"
              :disabled="disabled"
              :placeholder="view.groups.length ? '选择启用的 QQ 群' : '暂无已接入的群'"
              filterable
              multiple
              @update:value="(groups) => setGroups(item, groups)"
            />
          </div>
        </section>
      </template>
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <SaveBar
        :dirty="dirty"
        :saving="saving"
        :saved="saved"
        :disabled="disabled"
        @save="save"
        @discard="apply(view)"
      />
    </template>
  </div>
</template>

<style scoped>
.switch-panel {
  padding: 20px;
}
.switch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.switch-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 230px);
  align-items: center;
  gap: 8px 20px;
  padding: 12px 0;
  border-bottom: 1px solid var(--c-border);
}
.switch-row:last-child {
  border-bottom: 0;
}
.switch-groups {
  grid-column: 2;
}
@media (max-width: 560px) {
  .switch-row {
    grid-template-columns: 1fr;
  }
  .switch-groups {
    grid-column: 1;
  }
}
</style>
