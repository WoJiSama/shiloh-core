<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { useRoute } from 'vue-router'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { conversationLabel } from '../lib/workspaceNames'
import { confirmLeave, useUnsavedGuard } from '../composables/useUnsavedGuard'
import SchemaPage from './SchemaPage.vue'
import PageHeader from '../components/PageHeader.vue'

type Policy = { enabled: boolean; foldLongMessages: boolean; forwardFolded: boolean; maxLength: number; maxLines: number }
type GroupView = { revision: string; values: Policy; defaults: Policy; overrides: Partial<Policy> }
const groups = computed(() => workspace.data.value?.agents.flatMap(agent => agent.conversations)
  .filter(row => row.binding.target.kind === 'group' && capability('group-admin.read', row.scopeKey).status === 'available') ?? [])
const choices = computed(() => groups.value.map(row => ({ value: row.scopeKey,
  label: `${conversationLabel(row)} · ${row.binding.connectionId}` })))
const selected = ref('')
const active = computed(() => groups.value.find(row => row.scopeKey === selected.value))
const view = ref<GroupView>()
const draft = ref<Policy>()
const inherit = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const lifecycle = new AbortController()
onBeforeUnmount(() => lifecycle.abort())
const dirty = computed(() => !!view.value && (inherit.value || JSON.stringify(view.value.values) !== JSON.stringify(draft.value)))
useUnsavedGuard(() => dirty.value)

async function select(key: string) {
  if (loading.value || saving.value || dirty.value && !await confirmLeave()) return
  selected.value = key
  const row = active.value
  if (!row) return
  view.value = undefined
  draft.value = undefined
  inherit.value = false
  error.value = ''
  loading.value = true
  try {
    const query = new URLSearchParams({ scopeKey: row.scopeKey, bindingToken: row.bindingToken })
    const data = await api<GroupView>(`/api/groups/${encodeURIComponent(row.binding.target.id)}/admin?${query}`, { signal: lifecycle.signal })
    view.value = data
    draft.value = { ...data.values }
  } catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false }
}

async function save() {
  const row = active.value, loaded = view.value, edited = draft.value
  if (!row || !loaded || !edited || !dirty.value || saving.value || capability('group-admin.write', row.scopeKey).status !== 'available') return
  error.value = ''
  saving.value = true
  try {
    const values = Object.fromEntries((Object.keys(edited) as (keyof Policy)[]).flatMap(key => edited[key] === loaded.values[key] ? [] : [[key, edited[key]]]))
    const result = await api<{ view: GroupView }>(`/api/groups/${encodeURIComponent(row.binding.target.id)}/admin`, {
      method: 'PUT', signal: lifecycle.signal, body: JSON.stringify({ revision: loaded.revision, scopeKey: row.scopeKey,
        bindingToken: row.bindingToken, ...(inherit.value ? { resets: Object.keys(loaded.overrides) } : { values }) })
    })
    view.value = result.view
    draft.value = { ...result.view.values }
    inherit.value = false
  } catch (cause) { error.value = (cause as Error).message }
  finally { saving.value = false }
}
const route = useRoute()
watch(() => groups.value.find(row => row.scopeKey === route.query.scopeKey)?.scopeKey, key => {
  if (key && key !== selected.value) void select(key)
}, { immediate: true })
</script>

<template>
  <div class="page-stack">
    <PageHeader title="群管理" description="设置默认审核规则，或按 QQ 连接和群聊调整。审核动作限提醒、撤回和短时禁言。" />
    <section class="panel page-stack">
      <h2>单群规则</h2>
      <NSelect :value="selected || null" :options="choices" :disabled="saving || loading" filterable
        placeholder="选择接入的群聊" aria-label="选择接入的群聊" @update:value="select" />
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <div v-if="draft && view" class="page-stack">
        <label>审核明显广告与刷屏 <NSwitch v-model:value="draft.enabled" :disabled="inherit" /></label>
        <label>折叠超长纯文字消息 <NSwitch v-model:value="draft.foldLongMessages" :disabled="inherit" /></label>
        <template v-if="draft.foldLongMessages">
          <label>字数上限 <NInputNumber v-model:value="draft.maxLength" :min="100" :max="20000" :disabled="inherit" /></label>
          <label>行数上限（0 为关闭） <NInputNumber v-model:value="draft.maxLines" :min="0" :max="2000" :disabled="inherit" /></label>
          <label>撤回后发合并转发 <NSwitch v-model:value="draft.forwardFolded" :disabled="inherit" /></label>
        </template>
        <p v-if="inherit" class="field-help">保存后，这个群将使用下方默认规则。</p>
        <div class="toolbar">
          <NButton type="primary" :loading="saving" :disabled="!dirty || !active || capability('group-admin.write', active.scopeKey).status !== 'available'" @click="save">保存本群规则</NButton>
          <NButton v-if="Object.keys(view.overrides).length" :disabled="saving || inherit" @click="inherit = true">恢复默认</NButton>
        </div>
      </div>
    </section>
    <SchemaPage kind="groupAdmin" embedded />
  </div>
</template>
