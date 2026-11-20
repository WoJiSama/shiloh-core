<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NPagination, NSelect, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'

interface Status {
  enabled: boolean
  legacyImported: boolean
}
interface Records {
  enabled?: boolean
  archived?: boolean
  privacyRestricted?: boolean
  total: number
  indexed: number
  rows: { id: string; at: number; text: string; indexed: boolean }[]
}

const status = ref<Status>()
const records = ref<Records>()
const scopeKey = ref('')
const source = ref<'core' | 'legacy'>('core')
const query = ref('')
const appliedQuery = ref('')
const page = ref(1)
const loading = ref(true)
const recalling = ref(false)
const error = ref('')
const recall = ref<string | null>(null)
const setup = new AbortController()
let request: AbortController | undefined

const scopes = computed(() => (workspace.data.value?.agents ?? []).flatMap((agent) =>
  agent.conversations.flatMap((row) => {
    if (capability('semantic.records', row.scopeKey).status !== 'available') return []
    const target = row.binding.target
    return [{ value: row.scopeKey, token: row.bindingToken, kind: target.kind,
      label: agent.name + ' · ' + target.account.id + ' · ' + (target.kind === 'group' ? '群 ' : '会话 ') + target.id }]
  })
))
const sourceOptions = computed(() => [
  { label: 'Core 来源库', value: 'core' },
  ...(status.value?.legacyImported ? [{ label: '旧版语义归档', value: 'legacy' }] : [])
])
const eligibleScopes = computed(() => source.value === 'legacy' ? scopes.value.filter(row => row.kind === 'group') : scopes.value)
const selected = computed(() => eligibleScopes.value.find(row => row.value === scopeKey.value) ?? eligibleScopes.value[0])
const canRecall = computed(() => status.value?.enabled && source.value === 'core' &&
  selected.value && capability('semantic.recall', selected.value.value).status === 'available')
const blankMessage = computed(() => {
  if (!selected.value) return '当前账号没有获准查看的会话'
  if (records.value?.privacyRestricted) return '旧语义块缺少逐条作者来源，本会话的遗忘状态限制了访问'
  if (source.value === 'legacy' && !records.value?.archived) return '该群没有可查看的旧版语义归档'
  if (source.value === 'core' && status.value?.enabled === false) return '当前 Core 的语义召回处于关闭状态'
  return appliedQuery.value ? '没有匹配的记录' : '暂无记录'
})

function scopedQuery(q: string) {
  const scope = selected.value
  if (!scope) return null
  return new URLSearchParams({ scopeKey: scope.value, bindingToken: scope.token, q })
}

async function loadRecords() {
  request?.abort()
  const params = scopedQuery(appliedQuery.value)
  records.value = undefined
  recall.value = null
  recalling.value = false
  error.value = ''
  if (!params || !status.value) {
    loading.value = false
    return
  }
  const current = new AbortController()
  request = current
  params.set('source', source.value)
  params.set('page', String(page.value))
  loading.value = true
  try {
    const result = await api<Records>('/api/semantic/records?' + params, { signal: current.signal })
    if (!current.signal.aborted) records.value = result
  } catch (cause) {
    if (!current.signal.aborted) error.value = (cause as Error).message
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

async function load() {
  try {
    status.value = await api<Status>('/api/semantic', { signal: setup.signal })
    if (!status.value.enabled && status.value.legacyImported && source.value !== 'legacy') source.value = 'legacy'
    else await loadRecords()
  } catch (cause) {
    if (!setup.signal.aborted) {
      error.value = (cause as Error).message
      loading.value = false
    }
  }
}

function search() {
  page.value = 1
  appliedQuery.value = query.value.trim()
  void loadRecords()
}

async function runRecall() {
  const params = scopedQuery(query.value.trim())
  if (!params?.get('q') || !canRecall.value) return
  request?.abort()
  const current = new AbortController()
  request = current
  recalling.value = true
  error.value = ''
  try {
    const result = await api<{ text: string }>('/api/semantic/recall?' + params, { signal: current.signal })
    if (!current.signal.aborted) recall.value = result.text
  } catch (cause) {
    if (!current.signal.aborted) error.value = (cause as Error).message
  } finally {
    if (!current.signal.aborted) recalling.value = false
  }
}

watch([source, () => selected.value?.value, () => selected.value?.token], () => {
  page.value = 1
  void loadRecords()
})
onBeforeUnmount(() => {
  setup.abort()
  request?.abort()
})
void load()
</script>

<template>
  <div class="page-stack">
    <PageHeader title="记忆检索" subtitle="查看当前会话的语义来源和旧版归档。" />
    <NAlert v-if="source === 'legacy' && status?.legacyImported" type="info">
      旧版语义资料按原群查看。Core 召回使用当前会话已核验的来源。
    </NAlert>
    <div v-if="status" class="semantic-controls">
      <NSelect v-model:value="source" :options="sourceOptions" aria-label="资料来源" />
      <NSelect
        :value="selected?.value ?? null"
        :options="eligibleScopes"
        aria-label="记忆所属会话"
        placeholder="选择会话"
        filterable
        @update:value="scopeKey = $event"
      />
      <NInput v-model:value="query" placeholder="输入检索内容" :maxlength="2000" @keyup.enter="search" />
      <NButton :loading="loading" @click="search">查找</NButton>
      <NButton v-if="canRecall" :loading="recalling" :disabled="loading || !query.trim()" @click="runRecall">运行 Core 召回</NButton>
    </div>
    <PageState :loading="loading && !records" :error="error" @retry="status ? loadRecords() : load()" />
    <NCard v-if="recall !== null" size="small" title="召回结果">
      <pre class="semantic-text">{{ recall || '没有符合当前会话授权的来源' }}</pre>
    </NCard>
    <p v-if="records?.total" class="semantic-count">{{ records.total }} 条匹配 · {{ records.indexed }} 条带索引</p>
    <NEmpty v-if="!loading && !error && !records?.rows.length" :description="blankMessage" />
    <NCard v-for="row in records?.rows ?? []" :key="row.id" size="small">
      <div class="semantic-time">
        <time>{{ new Date(row.at).toLocaleString('zh-CN') }}</time>
        <NTag v-if="row.indexed" size="small">已有索引</NTag>
      </div>
      <pre class="semantic-text">{{ row.text }}</pre>
    </NCard>
    <NPagination v-if="records && records.total > 25" :page="page" :item-count="records.total" :page-size="25"
      @update:page="(value: number) => { page = value; loadRecords() }" />
  </div>
</template>

<style scoped>
.semantic-controls { display: grid; grid-template-columns: minmax(130px, 0.6fr) minmax(230px, 1.2fr) minmax(150px, 1fr) auto auto; gap: 8px; }
.semantic-time { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.semantic-text { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.semantic-count { margin: 0; }
@media (max-width: 960px) {
  .semantic-controls { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 540px) {
  .semantic-controls { grid-template-columns: 1fr; }
}
</style>
