<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDataTable,
  NTag,
  useDialog,
  useMessage,
  type DataTableColumns
} from 'naive-ui'
import { h } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'
import type { ConsoleConversationSelector } from '../lib/consoleBindings'
import { workspace, capability } from '../lib/workspace'
import { consoleRestart } from '../lib/consoleRestart'
import {
  conversationSourceLabel,
  robotLabel,
  type WorkspaceConversation
} from '../lib/workspaceModel'
const props = defineProps<{ conversationScopes?: WorkspaceConversation[]; embedded?: boolean }>()
const canWrite = (operation: string, scopeKey?: string) =>
  alive &&
  !uncertain.value &&
  !error.value &&
  !loading.value &&
  !acting.value &&
  (workspace.mode.value !== 'standalone' ||
    (!!scopeKey && capability(operation, scopeKey).status === 'available') ||
    (!scopeKey &&
      capability(operation).scope === 'global' &&
      capability(operation).status === 'available'))
const scopes = computed(
  () =>
    props.conversationScopes ??
    (workspace.mode.value === 'standalone'
      ? (workspace.data.value?.agents.flatMap((item) => item.conversations) ?? [])
      : undefined)
)
const inScope = (row: ConsoleConversationSelector) =>
  !scopes.value ||
  scopes.value.some(
    (scene) => scene.scopeKey === row.scopeKey && scene.bindingToken === row.bindingToken
  )

interface ConversationScope extends ConsoleConversationSelector {
  groupId: string
  agentId?: string
  account?: { platform: string; namespace: string; id: string }
  conversation?: {
    id: string
    kind: string
    account: { platform: string; namespace: string; id: string }
  }
}
interface Commitment extends ConversationScope {
  id: string
  creatorId: string
  creatorName: string
  intent: string
  schedule: string
  deliver: string
  nextRunAt: number
  expiryAt: number
  status: string
  lastResult: string
  retryCount: number
}
interface Failure extends ConsoleConversationSelector {
  id?: string
  intent?: string
  group_id?: string
  reason?: string
  at?: number
}
interface DelegatedEntry {
  id: string
  owner: string
  ownerName: string
  content: string
  dueAt: number
  status: string
  createdAt: number
}
interface DelegatedScope extends ConversationScope {
  scopeKey?: string
}
type DelegatedRow = DelegatedEntry & DelegatedScope
interface Overview {
  commitments: Commitment[]
  failures: Failure[]
  delegated: (DelegatedScope & { entries: DelegatedEntry[] })[]
  config: {
    maxActivePerGroup: number
    maxPerCreator: number
    defaultExpiryDays: number
    maxPerGroupDelegated: number
    maxPerOwnerDelegated: number
  }
}

const overview = ref<Overview | null>(null)
const loading = ref(false)
const error = ref('')
const acting = ref(false)
const uncertain = ref(false)
const message = useMessage()
const dialog = useDialog()
let timer: number | null = null
let alive = true,
  sequence = 0,
  controller: AbortController | undefined
const selectionVersion = () =>
  JSON.stringify([
    workspace.mode.value === 'standalone' ? consoleRestart.state.reloadGeneration : 0,
    scopes.value?.map((row) => [row.scopeKey, row.bindingToken])
  ])
function uncertainWrite(cause: unknown) {
  const status = (cause as { status?: number }).status
  uncertain.value = !status || ![400, 401, 403, 404, 422].includes(status)
  if (uncertain.value) error.value = '操作结果待核对，请勿重复操作；请重新读取并核对当前来源。'
}

async function load() {
  if (acting.value) return
  const ticket = ++sequence
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await api<Overview>('/api/trusteeship/overview', { signal: controller.signal })
    if (!alive || ticket !== sequence || controller.signal.aborted) return
    if (
      !Array.isArray(result.commitments) ||
      !Array.isArray(result.delegated) ||
      !Array.isArray(result.failures)
    )
      throw new Error('托付数据响应不完整，请刷新核对')
    overview.value = {
      ...result,
      commitments: result.commitments.filter(inScope),
      delegated: result.delegated.filter(inScope),
      failures: result.failures.filter(inScope)
    }
    uncertain.value = false
  } catch (e: any) {
    if (alive && ticket === sequence && !controller.signal.aborted)
      error.value = e?.message || '加载失败'
  } finally {
    if (alive && ticket === sequence) loading.value = false
  }
}
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 30000)
})
onBeforeUnmount(() => {
  alive = false
  sequence++
  controller?.abort()
  if (timer) window.clearInterval(timer)
})
watch(
  selectionVersion,
  () => {
    overview.value = null
    acting.value = false
    uncertain.value = false
    void load()
  },
  { flush: 'sync' }
)

function fmtTime(at: number): string {
  if (!at) return '—'
  return new Date(at + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
}
function fmtDue(at: number): string {
  if (!at) return ''
  const days = Math.ceil((at - Date.now()) / 86400_000)
  return days <= 0 ? '（到期）' : days <= 7 ? `（${days} 天后到期）` : ''
}
function renderConversation(row: ConversationScope): string {
  const id = row.conversation?.id || row.groupId
  if (workspace.mode.value !== 'standalone')
    return row.account
      ? `${row.account.platform} / ${row.account.namespace} / ${row.account.id}\n${id}${row.agentId ? ' · ' + row.agentId : ''}`
      : id
  const robot = workspace.data.value?.agents.find((item) =>
    item.conversations.some(
      (scene) => scene.scopeKey === row.scopeKey && scene.bindingToken === row.bindingToken
    )
  )
  return row.account
    ? `${robot ? robotLabel(robot, workspace.data.value?.agents ?? []) + ' · ' : ''}${row.account.platform} / ${row.account.namespace} / ${row.account.id}\n${id}`
    : id
}
function confirmationSource(row: ConversationScope): string {
  const scene = scopes.value?.find(
    (scene) => scene.scopeKey === row.scopeKey && scene.bindingToken === row.bindingToken
  )
  return scene ? conversationSourceLabel(scene) : `会话 ${renderConversation(row)}`
}

function cancelCommitment(row: Commitment) {
  if (!canWrite('commitments.cancel', row.scopeKey)) return
  const ticket = sequence,
    selected = selectionVersion()
  dialog.warning({
    title: '取消承诺',
    content: `仅作用于 ${confirmationSource(row)}。将取消 ${row.creatorName || row.creatorId} 托付的「${row.intent.slice(0, 60)}」，机器人不再执行。确定继续吗？`,
    positiveText: '取消承诺',
    negativeText: '先不动',
    onPositiveClick: async () => {
      if (!alive) return
      if (ticket !== sequence || selected !== selectionVersion()) {
        message.warning('列表已更新，请核对当前来源后重新操作。')
        return
      }
      if (!canWrite('commitments.cancel', row.scopeKey)) return
      acting.value = true
      try {
        await api('/api/trusteeship/commitment-cancel', {
          method: 'POST',
          body: JSON.stringify({
            id: row.id,
            groupId: row.groupId,
            scopeKey: row.scopeKey,
            bindingToken: row.bindingToken
          })
        })
        if (alive && ticket === sequence) {
          message.success('已取消')
          acting.value = false
          await load()
        }
      } catch (e: any) {
        if (alive && ticket === sequence) {
          uncertainWrite(e)
          message.error(e?.message || '操作失败')
        }
      } finally {
        if (alive && ticket === sequence) acting.value = false
      }
    }
  })
}

function deleteDelegated(row: DelegatedRow) {
  if (!canWrite('delegated.delete', row.scopeKey)) return
  const ticket = sequence,
    selected = selectionVersion()
  dialog.warning({
    title: '删除托付记忆',
    content: `仅作用于 ${confirmationSource(row)}。将删除 ${row.ownerName || row.owner} 托付的原话「${row.content.slice(0, 60)}」（被托付人的数据归被托付人，删除后不可恢复）。确定继续吗？`,
    positiveText: '删除',
    negativeText: '先不动',
    onPositiveClick: async () => {
      if (!alive) return
      if (ticket !== sequence || selected !== selectionVersion()) {
        message.warning('列表已更新，请核对当前来源后重新操作。')
        return
      }
      if (!canWrite('delegated.delete', row.scopeKey)) return
      acting.value = true
      try {
        await api('/api/trusteeship/delegated-delete', {
          method: 'POST',
          body: JSON.stringify({
            groupId: row.groupId,
            id: row.id,
            scopeKey: row.scopeKey,
            bindingToken: row.bindingToken
          })
        })
        if (alive && ticket === sequence) {
          message.success('已删除')
          acting.value = false
          await load()
        }
      } catch (e: any) {
        if (alive && ticket === sequence) {
          uncertainWrite(e)
          message.error(e?.message || '操作失败')
        }
      } finally {
        if (alive && ticket === sequence) acting.value = false
      }
    }
  })
}

async function clearFailLog() {
  if (props.conversationScopes || !canWrite('commitments.clear-failures')) return
  const ticket = sequence
  acting.value = true
  try {
    await api('/api/trusteeship/faillog-clear', { method: 'POST' })
    if (alive && ticket === sequence) {
      message.success('已清空失败记录')
      acting.value = false
      await load()
    }
  } catch (e: any) {
    if (alive && ticket === sequence) {
      uncertainWrite(e)
      message.error(e?.message || '操作失败')
    }
  } finally {
    if (alive && ticket === sequence) acting.value = false
  }
}

const commitmentColumns: DataTableColumns<Commitment> = [
  { title: '会话', key: 'groupId', minWidth: 155, render: renderConversation },
  {
    title: '托付人',
    key: 'creatorName',
    width: 110,
    render: (row) => row.creatorName || row.creatorId
  },
  { title: '托付内容（原话）', key: 'intent', minWidth: 220, ellipsis: { tooltip: true } },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row) =>
      (({ active: '待执行', claimed: '已领取', executing: '执行中' }) as Record<string, string>)[
        row.status
      ] || row.status
  },
  { title: '节奏', key: 'schedule', width: 120 },
  {
    title: '兑现',
    key: 'deliver',
    width: 80,
    render: (row) => (row.deliver === 'agent' ? '我动手' : '直发')
  },
  { title: '下次执行', key: 'nextRunAt', width: 140, render: (row) => fmtTime(row.nextRunAt) },
  {
    title: '到期',
    key: 'expiryAt',
    width: 130,
    render: (row) => `${fmtTime(row.expiryAt)}${fmtDue(row.expiryAt)}`
  },
  {
    title: '',
    key: 'action',
    width: 80,
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          type: 'error',
          secondary: true,
          disabled: !canWrite('commitments.cancel', row.scopeKey),
          onClick: () => cancelCommitment(row)
        },
        { default: () => '取消' }
      )
  }
]

const delegatedRows = computed(() => {
  const rows: DelegatedRow[] = []
  for (const { entries, ...scope } of overview.value?.delegated || []) {
    for (const entry of entries) rows.push({ ...scope, ...entry })
  }
  return rows
})
function delegatedColumnsFor(): DataTableColumns<DelegatedRow> {
  return [
    { title: '会话', key: 'groupId', minWidth: 155, render: renderConversation },
    { title: '托付人', key: 'ownerName', width: 110, render: (row) => row.ownerName || row.owner },
    { title: '原话', key: 'content', minWidth: 240, ellipsis: { tooltip: true } },
    { title: '记于', key: 'createdAt', width: 140, render: (row) => fmtTime(row.createdAt) },
    {
      title: '到期',
      key: 'dueAt',
      width: 150,
      render: (row) => (row.dueAt ? `${fmtTime(row.dueAt)}${fmtDue(row.dueAt)}` : '—')
    },
    {
      title: '',
      key: 'action',
      width: 80,
      render: (row) =>
        h(
          NButton,
          {
            size: 'tiny',
            type: 'error',
            secondary: true,
            disabled: !canWrite('delegated.delete', row.scopeKey),
            onClick: () => deleteDelegated(row)
          },
          { default: () => '删除' }
        )
    }
  ]
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="托付数据"
      subtitle="群友托付给机器人的定时事务（承诺账本）与「帮我记住」的原话（委托记忆）——透明化与被遗忘权，只读+删除，数据不出机"
    />
    <NButton :loading="loading" :disabled="acting" @click="load">重新读取</NButton>
    <PageState :loading="loading && !overview" :error="error" @retry="load" />
    <template v-if="overview">
      <NAlert type="default" :show-icon="false" style="margin-bottom: 12px">
        托付数据属于托付人：群友可随时在群里让机器人取消/忘掉自己的托付；此页为主人提供总览与清理。
        上限：每群 {{ overview.config.maxActivePerGroup }} 个承诺 / 每人
        {{ overview.config.maxPerCreator }} 个 / 默认
        {{ overview.config.defaultExpiryDays }} 天到期；委托记忆每群
        {{ overview.config.maxPerGroupDelegated }} 条 / 每人
        {{ overview.config.maxPerOwnerDelegated }} 条。
      </NAlert>

      <h3 class="section">承诺账本（活跃 {{ overview.commitments.length }}）</h3>
      <NAlert v-if="!overview.commitments.length" type="info" style="margin-bottom: 12px"
        >还没有任何活跃的定时托付——群友说「每天X点做Y」就会出现在这里。</NAlert
      >
      <NDataTable
        v-else
        :columns="commitmentColumns"
        :data="overview.commitments"
        :pagination="{ pageSize: 10 }"
        size="small"
        style="margin-bottom: 20px"
      />

      <div v-if="overview.failures.length" class="faillog">
        <h3 class="section">
          失败记录（{{ overview.failures.length }}）
          <NButton
            v-if="!conversationScopes"
            size="tiny"
            quaternary
            type="error"
            :disabled="!canWrite('commitments.clear-failures')"
            :loading="acting"
            @click="clearFailLog"
            >清空（处理完再清，哨兵告警随之消除）</NButton
          >
        </h3>
        <div v-for="(f, i) in overview.failures" :key="i" class="fail-line">
          <NTag size="small" type="error">失约</NTag>
          群{{ f.group_id || '?' }} 「{{ (f.intent || f.id || '').slice(0, 50) }}」
          {{ f.reason || '' }} · {{ fmtTime(f.at || 0) }}
        </div>
      </div>

      <h3 class="section">
        委托记忆（{{ (overview.delegated || []).reduce((n, g) => n + g.entries.length, 0) }} 条）
      </h3>
      <NAlert v-if="!delegatedRows.length" type="info"
        >还没有群友托付记事——「帮我记住X」的原话会出现在这里。</NAlert
      >
      <NDataTable
        v-else
        :columns="delegatedColumnsFor()"
        :data="delegatedRows"
        :pagination="{ pageSize: 10 }"
        size="small"
      />
    </template>
  </div>
</template>

<script lang="ts">
export default { name: 'TrusteeshipPage' }
</script>

<style scoped>
.section {
  font-size: 14px;
  margin: 6px 0 10px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.faillog {
  margin-bottom: 20px;
}
.fail-line {
  font-size: 13px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
