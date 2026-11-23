<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NSelect, NTag } from 'naive-ui'
import { useRoute } from 'vue-router'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { conversationLabel } from '../lib/workspaceNames'
import { useOpsResource } from '../lib/operations'
const route = useRoute()
const accountId = computed(() => typeof route.query.qq === 'string' && /^[1-9]\d{4,11}$/u.test(route.query.qq) ? route.query.qq : '')
const days = ref(7)
const operation = computed(() => accountId.value ? 'bot-stats.read' : 'stats.read')
type Counts = { date: string; received: number; sent: number; failed: number; unknown: number }
type Row = { scopeKey: string; connectionId: string; id: string; daily: Counts[] }
const traffic = useOpsResource(signal => {
  if (capability(operation.value).status !== 'available') return Promise.resolve(null)
  const url = accountId.value ? '/api/bot/stats?qq=' + accountId.value + '&' : '/api/overview/stats?'
  return api<{ dates: string[]; rows: Row[]; startedAt: number }>(url + 'days=' + days.value, { signal })
})
const periodStart = computed(() => traffic.data.value && new Date(traffic.data.value.startedAt)
  .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
const sentinel = useOpsResource(signal => capability('sentinel.read').status === 'available'
  ? api<{ availableMiB: number; alerts: { code: string; connectionId?: string }[] }>('/api/sentinel', { signal }) : Promise.resolve(null))
const apps = useOpsResource(signal => capability('apps.read').status === 'available'
  ? api<{ apps: { name: string; enabled: boolean }[] }>('/api/apps', { signal }) : Promise.resolve(null))
const names = computed(() => new Map(workspace.data.value?.agents.flatMap(agent =>
  agent.conversations.map(row => [row.scopeKey, conversationLabel(row)] as const))))
const labels: Record<string, string> = { core_pending: 'Core 正在初始化', disk_low: '存储空间偏低',
  qq_disconnected: 'QQ 未连接', journal_degraded: '运行日志写入异常', account_recovery: '会话正在恢复' }
const sum = (row: Row, key: 'received' | 'sent' | 'failed' | 'unknown') => row.daily.reduce((total, value) => total + value[key], 0)
watch([days, accountId, () => capability(operation.value).status], () => traffic.reset())
watch(() => capability('sentinel.read').status, () => sentinel.reset())
watch(() => capability('apps.read').status, () => apps.reset())
</script>
<template>
  <section v-if="sentinel.data.value" class="panel">
    <div class="panel-heading"><h2>运行状态</h2><NButton size="small" @click="sentinel.refresh">刷新</NButton></div>
    <p>可用存储空间 {{ sentinel.data.value.availableMiB.toLocaleString('zh-CN') }} MiB</p>
    <NAlert v-for="alert in sentinel.data.value.alerts" :key="alert.code + (alert.connectionId ?? '')" type="warning">
      {{ labels[alert.code] ?? alert.code }} <span v-if="alert.connectionId">· {{ alert.connectionId }}</span>
    </NAlert>
  </section>
  <NAlert v-else-if="sentinel.error.value" type="warning">暂时无法读取运行状态。</NAlert>
  <section v-if="capability(operation).status === 'available'" class="panel">
    <div class="panel-heading">
      <h2>收发统计 {{ accountId }}</h2>
      <div class="toolbar">
        <RouterLink v-if="accountId" to="/runtime">所有账号</RouterLink>
        <NSelect v-model:value="days" :options="[{ label: '今天', value: 1 }, { label: '最近 7 天', value: 7 }, { label: '最近 30 天', value: 30 }]"
          aria-label="时间范围" style="width: 140px" />
      </div>
    </div>
    <p v-if="periodStart" class="field-help">统计自 {{ periodStart }} 开始，按北京时间汇总。</p>
    <NAlert v-if="traffic.error.value" type="error">{{ traffic.error.value }}</NAlert>
    <p v-if="traffic.loading.value">正在汇总收发记录…</p>
    <div v-if="traffic.data.value?.rows.length" class="table-scroll">
      <table class="ops-table">
        <thead><tr><th>会话</th><th>接收</th><th>平台确认</th><th>失败</th><th>待核实</th></tr></thead>
        <tbody><tr v-for="row in traffic.data.value.rows" :key="row.scopeKey">
          <td>{{ names.get(row.scopeKey) ?? row.id }}<small class="muted"> · {{ row.connectionId }}</small></td>
          <td>{{ sum(row, 'received') }}</td><td>{{ sum(row, 'sent') }}</td>
          <td>{{ sum(row, 'failed') }}</td><td>{{ sum(row, 'unknown') }}</td>
        </tr></tbody>
      </table>
    </div>
    <p v-else-if="traffic.data.value" class="empty-note">此范围没有接入会话。</p>
  </section>
  <NAlert v-if="apps.error.value" type="warning">暂时无法读取已配置功能。</NAlert>
  <section v-if="apps.data.value" class="panel">
    <h2>已配置功能</h2>
    <div class="tag-list">
      <NTag v-for="app in apps.data.value.apps" :key="app.name" :type="app.enabled ? 'success' : 'default'">
        {{ app.name }} · {{ app.enabled ? '开' : '关' }}
      </NTag>
    </div>
  </section>
</template>
<style scoped>
.table-scroll { overflow-x: auto; }
.ops-table { width: 100%; border-collapse: collapse; }
.ops-table :is(th, td) { padding: 8px 12px; text-align: left; white-space: nowrap; }
</style>
