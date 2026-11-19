<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { NAlert, NButton, NDrawer, NDrawerContent, NInput, NSelect, NTag } from 'naive-ui'
import PageHeader from './PageHeader.vue'
import PageState from './PageState.vue'
import { api } from '../lib/api'
import { count, useOpsResource } from '../lib/operations'
import { capability, workspace } from '../lib/workspace'
import { consoleRestart } from '../lib/consoleRestart'
import { accountLabel, robotLabel } from '../lib/workspaceModel'
import {
  diagnosticLocation,
  diagnosticOutcomeLabel,
  diagnosticScopeLabel,
  diagnosticStatus,
  diagnosticTraceKey,
  parseStandaloneObserve,
  type DiagnosticEvent
} from '../lib/standaloneObserve'

const query = ref(''),
  traceDraft = ref(''),
  traceId = ref(''),
  traceError = ref(''),
  sessionCurrent = ref(true),
  agent = ref('all'),
  account = ref('all'),
  outcome = ref('all'),
  selectedId = ref(''),
  drawerOpen = ref(false)
const readAccess = computed(() => capability('observe.read'))
const epochCurrent = computed(
  () =>
    !consoleRestart.state.processEpoch ||
    workspace.data.value?.configState.processEpoch === consoleRestart.state.processEpoch
)
const mayRead = computed(
  () =>
    sessionCurrent.value &&
    workspace.mode.value === 'standalone' &&
    epochCurrent.value &&
    readAccess.value.status === 'available'
)
const accessKey = computed(() => {
  const snapshot = workspace.data.value
  return JSON.stringify([
    sessionCurrent.value,
    workspace.mode.value,
    workspace.error.value,
    consoleRestart.state.generation,
    consoleRestart.state.processEpoch,
    snapshot?.revision,
    snapshot?.configState.processEpoch,
    snapshot?.agents.map((owner) => [
      owner.id,
      owner.conversations.map((row) => [row.scopeKey, row.bindingToken])
    ]),
    snapshot?.capabilities
  ])
})
function clearDetail() {
  selectedId.value = ''
  drawerOpen.value = false
}
const resource = useOpsResource(async (signal) => {
  clearDetail()
  resource.data.value = null
  if (!mayRead.value)
    throw new Error(
      sessionCurrent.value
        ? epochCurrent.value
          ? readAccess.value.reason
          : '运行实例已改变，请刷新工作区后重新查询。'
        : '登录状态已失效，请重新登录后查询。'
    )
  const expectedAccess = accessKey.value,
    expectedEpoch = consoleRestart.state.processEpoch,
    path = traceId.value
      ? `/api/observe/summary?traceId=${encodeURIComponent(traceId.value)}`
      : '/api/observe/summary'
  const result = parseStandaloneObserve(await api(path, { signal }))
  if (signal.aborted || accessKey.value !== expectedAccess)
    throw new DOMException('查询已失效，请重新查询。', 'AbortError')
  if (expectedEpoch && result.processEpoch !== expectedEpoch)
    throw new Error('运行实例已改变，请刷新工作区后重新查询。')
  return result
}, 45000)
function refreshRecords() {
  clearDetail()
  resource.reset()
}
function resetFilters() {
  query.value = ''
  agent.value = account.value = outcome.value = 'all'
}
function lookupTrace() {
  const value = traceDraft.value.trim()
  clearDetail()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    traceError.value =
      '请输入完整查询编号，支持字母、数字、点、冒号、横线和下划线，最长 128 个字符。'
    return
  }
  traceError.value = ''
  traceId.value = value
  resetFilters()
  refreshRecords()
}
function recentRecords() {
  traceDraft.value = traceId.value = traceError.value = ''
  resetFilters()
  refreshRecords()
}
watch(accessKey, refreshRecords, { flush: 'sync' })
watch([query, agent, account, outcome], clearDetail, { flush: 'sync' })
function unauthorized() {
  sessionCurrent.value = false
}
onMounted(() => window.addEventListener('console:unauthorized', unauthorized))
onUnmounted(() => window.removeEventListener('console:unauthorized', unauthorized))
const events = computed(() => resource.data.value?.events ?? [])
function accountKey(event: DiagnosticEvent) {
  const scope = event.scope
  const value =
    scope.kind === 'conversation'
      ? scope.binding.target.account
      : scope.kind === 'account'
        ? scope.account
        : undefined
  return value ? JSON.stringify([value.platform, value.namespace, value.id]) : ''
}
function ownerLabel(event: DiagnosticEvent) {
  if (event.scope.kind !== 'conversation') return event.scope.kind === 'host' ? '宿主' : '连接账号'
  const id = event.scope.binding.agentId,
    snapshot = workspace.data.value,
    owner = snapshot?.agents.find((item) => item.id === id)
  return owner && snapshot ? robotLabel(owner, snapshot.agents) : id
}
const agentOptions = computed(() => [
  { label: '全部机器人本人', value: 'all' },
  ...Array.from(
    new Set(
      events.value.flatMap((event) =>
        event.scope.kind === 'conversation' ? [event.scope.binding.agentId] : []
      )
    )
  ).map((id) => {
    const event = events.value.find(
      (row) => row.scope.kind === 'conversation' && row.scope.binding.agentId === id
    )!
    return { label: `${ownerLabel(event)} · ${id}`, value: id }
  })
])
const accountOptions = computed(() => [
  { label: '全部连接账号', value: 'all' },
  ...Array.from(
    new Map(
      events.value.flatMap((event) => {
        const scope = event.scope,
          value =
            scope.kind === 'conversation'
              ? scope.binding.target.account
              : scope.kind === 'account'
                ? scope.account
                : undefined
        return value
          ? [[accountKey(event), { label: accountLabel(value), value: accountKey(event) }] as const]
          : []
      })
    ).values()
  )
])
const outcomeOptions = [
  { label: '全部状态', value: 'all' },
  { label: '失败', value: 'failed' },
  { label: '结果未知', value: 'unknown' },
  { label: '已取消', value: 'cancelled' },
  { label: '操作完成', value: 'succeeded' },
  { label: '已开始', value: 'started' }
]
const visible = computed(() =>
  events.value.filter((event) => {
    const search = query.value.trim().toLowerCase()
    return (
      (!search ||
        `${event.traceId} ${event.operation} ${event.code ?? ''} ${diagnosticScopeLabel(event)} ${ownerLabel(event)} ${event.configurationRevision ?? ''} ${event.delivery?.messageId ?? ''}`
          .toLowerCase()
          .includes(search)) &&
      (agent.value === 'all' ||
        (event.scope.kind === 'conversation' && event.scope.binding.agentId === agent.value)) &&
      (account.value === 'all' || accountKey(event) === account.value) &&
      (outcome.value === 'all' || diagnosticStatus(event) === outcome.value)
    )
  })
)
const selected = computed(() => events.value.find((event) => event.id === selectedId.value))
const timeline = computed(() =>
  selected.value
    ? events.value
        .filter((event) => diagnosticTraceKey(event) === diagnosticTraceKey(selected.value!))
        .slice()
        .reverse()
        .sort((a, b) => a.at - b.at)
    : []
)
const metrics = computed(() => [
  { label: '本次返回记录', value: events.value.length },
  {
    label: '失败记录',
    value: events.value.filter((event) => diagnosticStatus(event) === 'failed').length
  },
  {
    label: '结果未知',
    value: events.value.filter((event) => diagnosticStatus(event) === 'unknown').length
  },
  {
    label: '已取消',
    value: events.value.filter((event) => diagnosticStatus(event) === 'cancelled').length
  }
])
const configurationLabel = computed(() => {
  const value = resource.data.value?.configuration
  return value?.phase === 'saving'
    ? '配置正在保存'
    : value?.phase === 'uncertain'
      ? '配置状态待核对'
      : value?.requiresRestart
        ? '配置已保存，等待重启加载'
        : '当前配置已加载'
})
function eventTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}
function duration(event: DiagnosticEvent) {
  return event.durationMs === undefined
    ? '—'
    : event.durationMs < 1000
      ? `${event.durationMs} ms`
      : `${(event.durationMs / 1000).toFixed(2)} s`
}
function tagType(event: DiagnosticEvent) {
  const state = diagnosticStatus(event)
  return state === 'failed'
    ? 'error'
    : state === 'unknown' || state === 'cancelled'
      ? 'warning'
      : 'default'
}
function location(event: DiagnosticEvent) {
  return workspace.error.value ? undefined : diagnosticLocation(event, workspace.data.value)
}
function detail(event: DiagnosticEvent) {
  selectedId.value = event.id
  drawerOpen.value = true
}
</script>

<template>
  <div class="page-stack standalone-observe">
    <PageHeader
      title="运行观测"
      eyebrow="运行与排障"
      description="从近期保存的操作记录，追踪完整会话、配置版本和平台回执。"
    >
      <template #actions><NButton @click="refreshRecords">刷新记录</NButton></template>
    </PageHeader>
    <form class="panel trace-lookup" @submit.prevent="lookupTrace">
      <label class="section-title" for="observe-trace-reference">按查询编号查找</label>
      <div class="trace-lookup-controls">
        <NInput
          v-model:value="traceDraft"
          clearable
          :input-props="{ id: 'observe-trace-reference', 'aria-label': '查询编号' }"
          placeholder="粘贴异常提示中的完整查询编号"
          :maxlength="128"
          :disabled="!mayRead"
        />
        <NButton attr-type="submit" :disabled="!mayRead">查找记录</NButton>
        <NButton
          v-if="traceId"
          attr-type="button"
          data-action="recent-observations"
          @click="recentRecords"
          >返回近期记录</NButton
        >
      </div>
      <p class="field-help">
        在当前授权和日志保留范围内查找，仍受本次读取上限限制。
        <span v-if="traceId"
          >当前查询：<code>{{ traceId }}</code></span
        >
      </p>
    </form>
    <NAlert v-if="traceError" type="warning" :bordered="false">{{ traceError }}</NAlert>
    <NAlert v-if="resource.error.value && resource.data.value" type="warning" :bordered="false"
      >刷新失败，当前展示上次同步的记录：{{ resource.error.value }}</NAlert
    >
    <PageState
      :loading="resource.loading.value && !resource.data.value"
      :error="!resource.data.value ? resource.error.value : null"
      @retry="refreshRecords"
    >
      <template v-if="resource.data.value">
        <NAlert
          v-if="
            resource.data.value.configuration.requiresRestart ||
            resource.data.value.configuration.phase !== 'active'
          "
          type="warning"
          :bordered="false"
          >{{ configurationLabel }}。以下记录保留事件发生时实际加载的版本。</NAlert
        >
        <section class="panel configuration-panel">
          <div class="panel-heading">
            <h2 class="section-title">{{ configurationLabel }}</h2>
            <span class="field-help">{{ eventTime(resource.data.value.observedAt) }} 同步</span>
          </div>
          <dl class="configuration-facts">
            <div>
              <dt>运行中版本</dt>
              <dd>
                <code>{{ resource.data.value.configuration.loadedRevision }}</code>
              </dd>
            </div>
            <div>
              <dt>已保存版本</dt>
              <dd>
                <code>{{ resource.data.value.configuration.storedRevision || '暂无法核对' }}</code>
              </dd>
            </div>
          </dl>
        </section>
        <NAlert v-if="!resource.data.value.journal.available" type="info" :bordered="false"
          >未获宿主日志状态查看权限。仅展示已授权的运行记录。</NAlert
        >
        <NAlert v-else-if="resource.data.value.journal.degraded" type="warning" :bordered="false"
          >操作日志处于降级状态，本进程已有
          {{ count(resource.data.value.journal.failed) }} 次写入失败。当前记录可能不完整。</NAlert
        >
        <NAlert v-if="resource.data.value.scan.truncated" type="info" :bordered="false"
          >已达到本次读取上限，较早记录未全部返回；这里的数量仅统计已返回记录。</NAlert
        >
        <NAlert
          v-if="
            resource.data.value.scan.hostCountersVisible &&
            resource.data.value.scan.invalidRecords > 0
          "
          type="warning"
          :bordered="false"
          >本次读取跳过
          {{ count(resource.data.value.scan.invalidRecords) }}
          条损坏或无法验证的日志，未将其计为成功。</NAlert
        >
        <div class="observe-metrics">
          <div v-for="metric in metrics" :key="metric.label" class="panel metric">
            <span>{{ metric.label }}</span
            ><strong>{{ count(metric.value) }}</strong>
          </div>
        </div>
        <section class="panel events-panel">
          <div class="panel-heading">
            <div>
              <h2 class="section-title">{{ traceId ? '查询编号的操作记录' : '近期操作' }}</h2>
              <p class="field-help">
                筛选本次已返回记录。一次操作可能产生多条记录，记录数不等于聊天回合数。
              </p>
            </div>
            <span class="field-help"
              >{{ count(visible.length) }} / {{ count(events.length) }} 条</span
            >
          </div>
          <p v-if="!resource.data.value.scan.hostCountersVisible" class="field-help">
            仅展示已授权会话记录，未提供宿主日志扫描统计。
          </p>
          <div class="event-filters">
            <NInput
              v-model:value="query"
              clearable
              aria-label="搜索追踪编号或会话"
              placeholder="搜索追踪编号、会话、操作或版本"
            /><NSelect
              v-model:value="agent"
              :options="agentOptions"
              aria-label="按机器人本人筛选"
            /><NSelect
              v-model:value="account"
              :options="accountOptions"
              aria-label="按完整账号筛选"
            /><NSelect
              v-model:value="outcome"
              :options="outcomeOptions"
              aria-label="按记录状态筛选"
            />
          </div>
          <div v-if="visible.length" class="table-scroll">
            <table class="events-table">
              <thead>
                <tr>
                  <th>时间 / 操作</th>
                  <th>机器人与完整会话</th>
                  <th>结果</th>
                  <th>耗时</th>
                  <th><span class="sr-only">查看详情</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="event in visible" :key="event.id" :data-event-id="event.id">
                  <td>
                    <time>{{ eventTime(event.at) }}</time
                    ><strong>{{ event.operation }}</strong
                    ><small>{{ event.stage }}</small>
                  </td>
                  <td class="scope-cell">
                    <strong>{{ ownerLabel(event) }}</strong
                    ><span>{{ diagnosticScopeLabel(event) }}</span
                    ><small class="trace-id">{{ event.traceId }}</small>
                  </td>
                  <td>
                    <NTag :type="tagType(event)" size="small" :bordered="false">{{
                      diagnosticOutcomeLabel(event)
                    }}</NTag
                    ><small v-if="event.code">{{ event.code }}</small
                    ><small v-if="event.delivery?.messageId"
                      >平台消息 {{ event.delivery.messageId }}</small
                    >
                  </td>
                  <td class="duration-cell">{{ duration(event) }}</td>
                  <td>
                    <NButton
                      text
                      size="small"
                      :aria-label="`查看 ${event.operation} 的追踪记录`"
                      @click="detail(event)"
                      >详情 →</NButton
                    >
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty-records">
            {{
              events.length
                ? '没有符合筛选条件的记录。'
                : traceId
                  ? '当前读取与授权范围内未找到此查询编号，记录可能已过期或超出读取范围。'
                  : '当前读取范围内没有已授权的操作记录。'
            }}
          </p>
          <p v-if="resource.data.value.journal.available" class="field-help journal-health">
            本进程已保存 {{ count(resource.data.value.journal.written) }} 条日志<span
              v-if="resource.data.value.journal.lastWrittenAt"
              >，最近写入于 {{ eventTime(resource.data.value.journal.lastWrittenAt) }}</span
            >。历史记录按日志保留范围读取。
          </p>
        </section>
      </template>
    </PageState>
    <NDrawer
      v-model:show="drawerOpen"
      width="min(680px, 100vw)"
      placement="right"
      :auto-focus="false"
    >
      <NDrawerContent title="操作追踪" closable>
        <template v-if="selected">
          <dl class="event-facts">
            <div>
              <dt>追踪编号</dt>
              <dd>
                <code>{{ selected.traceId }}</code>
              </dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{{ diagnosticScopeLabel(selected) }}</dd>
            </div>
            <div v-if="selected.scope.kind === 'conversation'">
              <dt>绑定与入口消息</dt>
              <dd>
                版本 {{ selected.scope.binding.revision }}<br />{{
                  selected.scope.messageId
                    ? `入口消息 ${selected.scope.messageId}`
                    : '未记录入口消息编号'
                }}
              </dd>
            </div>
            <div>
              <dt>事件发生时的配置</dt>
              <dd>
                <code v-if="selected.configurationRevision">{{
                  selected.configurationRevision
                }}</code
                ><span v-else>旧记录未记录配置版本</span>
              </dd>
            </div>
            <div v-if="selected.delivery">
              <dt>平台回执</dt>
              <dd>
                {{ diagnosticOutcomeLabel(selected)
                }}<span v-if="selected.delivery.messageId">
                  · 消息 {{ selected.delivery.messageId }}</span
                ><span v-if="selected.delivery.code"> · {{ selected.delivery.code }}</span>
              </dd>
            </div>
            <div v-if="selected.errorKind || selected.httpStatus">
              <dt>故障分类</dt>
              <dd>
                {{ selected.errorKind || '—'
                }}<span v-if="selected.httpStatus"> · HTTP {{ selected.httpStatus }}</span>
              </dd>
            </div>
          </dl>
          <RouterLink v-if="location(selected)" class="conversation-link" :to="location(selected)!"
            >打开当前完整会话 →</RouterLink
          >
          <p v-else-if="selected.scope.kind === 'conversation'" class="field-help">
            此记录未能与当前完整绑定核对，保留历史信息。
          </p>
          <h2 class="section-title timeline-title">同一次追踪的记录</h2>
          <p class="field-help">仅包含本次返回范围内、完整来源身份一致的记录。</p>
          <ol class="trace-timeline">
            <li v-for="event in timeline" :key="event.id">
              <div class="timeline-heading">
                <strong>{{ event.operation }}</strong
                ><NTag :type="tagType(event)" size="small" :bordered="false">{{
                  diagnosticOutcomeLabel(event)
                }}</NTag>
              </div>
              <time>{{ eventTime(event.at) }} · {{ duration(event) }}</time
              ><code v-if="event.configurationRevision">配置 {{ event.configurationRevision }}</code
              ><small v-if="event.code || event.errorKind"
                >{{ event.code }} {{ event.errorKind }}</small
              ><small v-if="event.delivery?.messageId"
                >平台消息 {{ event.delivery.messageId }}</small
              >
            </li>
          </ol>
        </template>
        <NAlert v-else type="info" :bordered="false"
          >所选记录已不在当前读取范围，请刷新列表后重新选择。</NAlert
        >
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.configuration-panel,
.events-panel,
.trace-lookup {
  padding: 24px;
  min-width: 0;
}
.trace-lookup-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 16px 0 10px;
}
.trace-lookup-controls > .n-input {
  flex: 1 1 260px;
  min-width: 0;
}
.trace-lookup .field-help {
  margin-bottom: 0;
  overflow-wrap: anywhere;
}
.configuration-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin: 20px 0 0;
}
dt {
  color: var(--c-muted);
  font-size: 12px;
}
dd {
  margin: 7px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
code {
  overflow-wrap: anywhere;
  white-space: normal;
}
.observe-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
}
.metric {
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.metric > span {
  color: var(--c-muted);
  font-size: 12px;
}
.metric > strong {
  font-size: 28px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.event-filters {
  display: grid;
  grid-template-columns: minmax(180px, 2fr) repeat(3, minmax(150px, 1fr));
  gap: 10px;
  margin: 20px 0;
}
.table-scroll {
  position: relative;
  overflow-x: auto;
}
.events-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
.events-table th {
  font-weight: 500;
  color: var(--c-muted);
  font-size: 12px;
  white-space: nowrap;
}
.events-table th,
.events-table td {
  padding: 14px 10px;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}
.events-table th:first-child,
.events-table td:first-child {
  padding-left: 0;
}
.events-table strong,
.events-table span,
.events-table small,
.events-table time {
  display: block;
}
.events-table strong {
  font-weight: 500;
  margin: 5px 0;
  overflow-wrap: anywhere;
}
.events-table small,
.events-table time {
  color: var(--c-muted);
  font-size: 11px;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.scope-cell {
  min-width: 240px;
  max-width: 420px;
  overflow-wrap: anywhere;
}
.scope-cell span {
  font-size: 12px;
  line-height: 1.6;
}
.duration-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.trace-id {
  font-family: monospace;
}
.empty-records {
  padding: 30px 0;
  color: var(--c-muted);
  font-size: 13px;
}
.journal-health {
  margin-top: 20px;
}
.event-facts {
  display: grid;
  gap: 22px;
  margin: 8px 0 24px;
}
.event-facts dd {
  line-height: 1.7;
}
.conversation-link {
  display: inline-block;
  margin-bottom: 20px;
}
.timeline-title {
  margin-top: 24px;
}
.trace-timeline {
  list-style: none;
  padding: 0 0 0 14px;
  margin: 25px 0;
  border-left: 2px solid var(--c-border);
}
.trace-timeline li {
  padding: 0 0 24px 12px;
}
.timeline-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.timeline-heading strong {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.trace-timeline time,
.trace-timeline small,
.trace-timeline code {
  display: block;
  margin-top: 8px;
  color: var(--c-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
@media (max-width: 1000px) {
  .event-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 650px) {
  .configuration-panel,
  .events-panel,
  .trace-lookup {
    padding: 18px;
  }
  .configuration-facts,
  .event-filters {
    grid-template-columns: minmax(0, 1fr);
  }
  .observe-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .metric {
    padding: 18px;
  }
  .metric > strong {
    font-size: 24px;
  }
}
</style>
