<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { NAlert, NButton, NPagination, NTag, useDialog, useMessage } from 'naive-ui'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { consoleRestart } from '../lib/consoleRestart'
import {
  accountLabel,
  conversationLabel,
  conversationSourceLabel,
  type WorkspaceConversation
} from '../lib/workspaceModel'
import PageState from './PageState.vue'

const props = defineProps<{
  conversation: WorkspaceConversation
  section: 'conversations' | 'self' | 'actions'
  manageTo?: RouteLocationRaw
}>()
interface Memory {
  id: string
  content: string
  kind: string
  epistemic?: string
  evidenceRefs?: string[]
  createdAt: number
}
interface Goal {
  id: string
  title: string
  status: string
  nextStep: string
  lastOutcome?: string
  evidenceRefs?: string[]
}
interface Receipt {
  id: string
  toolName: string
  status: string
  summary: string
  at: number
  goalId?: string
}
interface Scene {
  scopeKey: string
  bindingToken: string
  active: boolean
  running: boolean
  replyMode?: string
  unreadCount: number
  budget?: { turns: number; maxTurnsPerDay: number; dailyCostCny: number; todayCostCny: number }
  character?: {
    paused: boolean
    decision?: { kind: string; reason: string; at: number }
    memories: Memory[]
    goals: Goal[]
    receipts: Receipt[]
  }
  activities?: {
    works: { id: string; title: string; kind: string; status: string }[]
    subscriptions: { id: string; title: string; status: string }[]
  }
}
const view = ref<Scene | null>(null),
  loading = ref(false),
  error = ref(''),
  acting = ref(false),
  uncertain = ref(false),
  memoryPage = ref(1),
  actionPage = ref(1)
const dialog = useDialog()
const message = useMessage()
let alive = true,
  sequence = 0,
  controller: AbortController | undefined
const readCapability = computed(() =>
  capability('simulation.group-read', props.conversation.scopeKey)
)
const canWrite = computed(
  () =>
    capability('simulation.group-write', props.conversation.scopeKey).status === 'available' &&
    !workspace.error.value &&
    !loading.value &&
    !error.value &&
    !uncertain.value &&
    !acting.value
)
const label = computed(() => conversationLabel(props.conversation))
const memories = computed(
  () =>
    view.value?.character?.memories.slice((memoryPage.value - 1) * 10, memoryPage.value * 10) ?? []
)
const goals = computed(
  () => view.value?.character?.goals.slice((actionPage.value - 1) * 10, actionPage.value * 10) ?? []
)
const receipts = computed(
  () =>
    view.value?.character?.receipts.slice((actionPage.value - 1) * 10, actionPage.value * 10) ?? []
)
const time = (at: number) =>
  Number.isFinite(at) && at > 0
    ? new Date(at).toLocaleString('zh-CN', { hour12: false })
    : '未记录时间'
const replyModes: Record<string, string> = { atOnly: '仅被提及', auto: '自主', active: '活跃' }
const labels: Record<string, string> = {
  experience: '经历',
  interest: '兴趣',
  opinion: '观点',
  reported: '他人提及',
  observed: '实际观察',
  inferred: '暂时判断',
  desired: '意愿或计划',
  active: '进行中',
  waiting: '等待中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃',
  failed: '已确认失败',
  succeeded: '已确认成功',
  pending: '待确认',
  unknown: '结果未知',
  engage: '参与交流',
  silent: '保持安静',
  cannot: '能力不足',
  unauthorized: '权限不足',
  unwilling: '不愿意',
  deferred: '稍后再做'
}
async function load() {
  if (acting.value) return
  const ticket = ++sequence,
    selected = props.conversation
  controller?.abort()
  controller = new AbortController()
  error.value = ''
  view.value = null
  if (selected.binding.target.kind !== 'group' || readCapability.value.status !== 'available') {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await api<Scene>(
      '/api/simulation/group?' +
        new URLSearchParams({ scopeKey: selected.scopeKey, bindingToken: selected.bindingToken }),
      { signal: controller.signal }
    )
    if (ticket !== sequence || controller.signal.aborted) return
    if (
      result.scopeKey !== selected.scopeKey ||
      result.bindingToken !== selected.bindingToken ||
      typeof result.active !== 'boolean' ||
      typeof result.running !== 'boolean' ||
      (result.budget &&
        ![
          result.budget.turns,
          result.budget.maxTurnsPerDay,
          result.budget.dailyCostCny,
          result.budget.todayCostCny
        ].every((value) => typeof value === 'number' && Number.isFinite(value))) ||
      (result.character &&
        (!Array.isArray(result.character.memories) ||
          !Array.isArray(result.character.goals) ||
          !Array.isArray(result.character.receipts)))
    )
      throw new Error('会话响应与当前显示的绑定不一致，请从会话列表重新打开')
    view.value = result
  } catch (cause) {
    if (ticket === sequence && !controller.signal.aborted)
      error.value = (cause as Error).message || '无法读取当前会话'
  } finally {
    if (ticket === sequence) loading.value = false
  }
}
async function mutate(body: Record<string, unknown>) {
  if (!canWrite.value || !view.value) return
  const selected = props.conversation,
    ticket = sequence
  acting.value = true
  error.value = ''
  try {
    await api('/api/simulation/group', {
      method: 'POST',
      body: JSON.stringify({
        scopeKey: selected.scopeKey,
        bindingToken: selected.bindingToken,
        ...body
      })
    })
    if (ticket === sequence) {
      acting.value = false
      await load()
    }
  } catch (cause) {
    if (ticket !== sequence) return
    const status = (cause as { status?: number }).status
    uncertain.value = !status || ![400, 401, 403, 422].includes(status)
    error.value = uncertain.value
      ? '操作结果待核对，请勿重复操作。重新读取当前会话确认状态。'
      : (cause as Error).message
  } finally {
    if (ticket === sequence) acting.value = false
  }
}
function control(operation: string, id?: string) {
  return mutate({ action: 'character', operation, ...(id ? { id } : {}) })
}
function confirmControl(operation: string, id: string, title: string) {
  const selected = props.conversation,
    ticket = sequence
  dialog.warning({
    title,
    content: `仅作用于 ${conversationSourceLabel(selected)} 的当前记录。关联内容可能随来源一同失效。`,
    positiveText: '确认',
    negativeText: '保留',
    onPositiveClick: () => {
      if (!alive) return
      if (props.conversation !== selected || ticket !== sequence) {
        message.warning('列表已更新，请核对当前来源后重新操作。')
        return
      }
      return control(operation, id)
    }
  })
}
async function reread() {
  await load()
  if (view.value) uncertain.value = false
}
watch(
  () =>
    JSON.stringify([
      props.conversation.scopeKey,
      props.conversation.bindingToken,
      consoleRestart.state.reloadGeneration
    ]),
  () => {
    acting.value = false
    uncertain.value = false
    memoryPage.value = 1
    actionPage.value = 1
    void load()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => readCapability.value.status,
  () => void load(),
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  sequence++
  controller?.abort()
})
</script>
<template>
  <section class="panel robot-scene">
    <div class="panel-heading">
      <div>
        <span class="eyebrow">来源会话</span>
        <h3>{{ label }}</h3>
        <p class="field-help">
          {{ conversation.binding.connectionId }} ·
          {{ accountLabel(conversation.binding.target.account) }}
        </p>
      </div>
      <span class="toolbar">
        <RouterLink
          v-if="
            props.manageTo &&
            conversation.binding.target.kind === 'group' &&
            readCapability.status === 'available'
          "
          :to="props.manageTo"
          >管理此会话 →</RouterLink
        >
        <NButton size="small" :loading="loading" :disabled="acting" @click="reread"
          >重新读取</NButton
        >
      </span>
    </div>
    <p v-if="conversation.binding.target.kind !== 'group'" class="empty-note">
      此会话已绑定本人；当前宿主尚未提供此类型会话的自我与行动视图。
    </p>
    <NAlert
      v-else-if="readCapability.status !== 'available'"
      type="info"
      :title="readCapability.status === 'restart-required' ? '等待重启' : '当前不可读取'"
      >{{ readCapability.reason }}</NAlert
    >
    <PageState v-else :loading="loading" :error="error" @retry="reread"
      ><div v-if="view" class="page-stack scene-content">
        <template v-if="section === 'conversations'"
          ><div class="tag-list">
            <NTag size="small">{{ view.active ? '允许参与' : '已关闭参与' }}</NTag
            ><NTag size="small">{{ view.running ? '当前有回合执行' : '当前无回合执行' }}</NTag
            ><NTag v-if="view.replyMode" size="small">{{
              replyModes[view.replyMode] || view.replyMode
            }}</NTag>
          </div>
          <div v-if="view.budget" class="scene-facts">
            <span
              >今日回合
              <strong
                >{{ view.budget.turns }} /
                {{
                  view.budget.maxTurnsPerDay === -1 ? '不限' : view.budget.maxTurnsPerDay
                }}</strong
              ></span
            ><span
              >今日模型费 <strong>¥{{ view.budget.todayCostCny }}</strong></span
            ><span
              >会话每日额度 <strong>¥{{ view.budget.dailyCostCny }}</strong></span
            >
          </div>
          <p class="field-help">金额来自此会话的运行数据，不代表本人所有会话的总费用。</p>
          <NButton
            :disabled="!canWrite"
            :loading="acting"
            size="small"
            @click="mutate({ action: view.active ? 'disable' : 'enable' })"
            >{{ view.active ? '关闭此会话参与' : '允许此会话参与' }}</NButton
          ></template
        >
        <template v-else-if="section === 'self'"
          ><div v-if="view.character">
            <div class="panel-heading">
              <h3>会话中的自我记录</h3>
              <NTag size="small">{{ view.character.memories.length }} 条</NTag>
            </div>
            <p v-if="!memories.length" class="empty-note">当前会话没有可见的自我记录。</p>
            <article v-for="memory in memories" :key="memory.id" class="scene-record">
              <div class="tag-list">
                <NTag size="small">{{ labels[memory.kind] || memory.kind }}</NTag
                ><NTag v-if="memory.epistemic" size="small">{{
                  labels[memory.epistemic] || memory.epistemic
                }}</NTag>
              </div>
              <p>{{ memory.content }}</p>
              <details v-if="memory.evidenceRefs?.length" class="technical-details">
                <summary>来源引用</summary>
                <ul>
                  <li v-for="ref in memory.evidenceRefs" :key="ref">{{ ref }}</li>
                </ul>
              </details>
              <div class="panel-heading">
                <small class="muted">{{ time(memory.createdAt) }}</small
                ><NButton
                  size="tiny"
                  type="error"
                  quaternary
                  :disabled="!canWrite"
                  @click="confirmControl('delete-memory', memory.id, '删除这条记忆')"
                  >删除</NButton
                >
              </div>
            </article>
            <NPagination
              v-if="view.character.memories.length > 10"
              v-model:page="memoryPage"
              :page-size="10"
              :item-count="view.character.memories.length"
            />
          </div>
          <p v-else class="empty-note">此会话没有返回自我记录能力。</p></template
        >
        <template v-else
          ><template v-if="view.character"
            ><div class="panel-heading">
              <h3>{{ view.character.paused ? '自主行动已暂停' : '自主行动未暂停' }}</h3>
              <NButton
                size="small"
                :disabled="!canWrite"
                :loading="acting"
                @click="control(view.character.paused ? 'resume' : 'pause')"
                >{{ view.character.paused ? '恢复此会话行动' : '暂停此会话行动' }}</NButton
              >
            </div>
            <p v-if="view.character.decision" class="field-help">
              最近决定：{{ labels[view.character.decision.kind] || view.character.decision.kind }} ·
              {{ view.character.decision.reason }} · {{ time(view.character.decision.at) }}
            </p>
            <h3>目标</h3>
            <p v-if="!goals.length" class="empty-note">当前没有可见目标。</p>
            <article v-for="goal in goals" :key="goal.id" class="scene-record">
              <div class="panel-heading">
                <strong>{{ goal.title }}</strong
                ><NTag size="small">{{ labels[goal.status] || goal.status }}</NTag>
              </div>
              <p>{{ goal.nextStep }}</p>
              <details v-if="goal.evidenceRefs?.length" class="technical-details">
                <summary>目标依据</summary>
                <ul>
                  <li v-for="ref in goal.evidenceRefs" :key="ref">{{ ref }}</li>
                </ul>
              </details>
              <p v-if="goal.lastOutcome" class="field-help">{{ goal.lastOutcome }}</p>
              <div v-if="['active', 'waiting', 'paused'].includes(goal.status)" class="toolbar">
                <NButton
                  size="tiny"
                  :disabled="!canWrite"
                  @click="control(goal.status === 'paused' ? 'resume-goal' : 'pause-goal', goal.id)"
                  >{{ goal.status === 'paused' ? '恢复目标' : '暂停目标' }}</NButton
                ><NButton
                  size="tiny"
                  type="error"
                  quaternary
                  :disabled="!canWrite"
                  @click="confirmControl('cancel-goal', goal.id, '停止这个目标')"
                  >停止目标</NButton
                >
              </div>
            </article>
            <h3>实际行动回执</h3>
            <p v-if="!receipts.length" class="empty-note">当前没有可见行动回执。</p>
            <article v-for="receipt in receipts" :key="receipt.id" class="scene-record">
              <div class="panel-heading">
                <strong>{{ receipt.toolName }}</strong
                ><NTag
                  size="small"
                  :type="
                    receipt.status === 'succeeded'
                      ? 'success'
                      : receipt.status === 'unknown'
                        ? 'warning'
                        : 'default'
                  "
                  >{{ labels[receipt.status] || receipt.status }}</NTag
                >
              </div>
              <p>{{ receipt.summary }}</p>
              <p v-if="receipt.goalId" class="field-help">关联目标 · {{ receipt.goalId }}</p>
              <small class="muted">{{ time(receipt.at) }}</small>
            </article>
            <NPagination
              v-if="Math.max(view.character.goals.length, view.character.receipts.length) > 10"
              v-model:page="actionPage"
              :page-size="10"
              :item-count="Math.max(view.character.goals.length, view.character.receipts.length)"
          /></template>
          <p v-else class="empty-note">此会话没有返回行动记录能力。</p>
          <template v-if="view.activities"
            ><h3>作品与订阅</h3>
            <div v-for="work in view.activities.works" :key="work.id" class="workspace-list-row">
              <strong>{{ work.title }}</strong
              ><span>{{ work.kind }} · {{ work.status }}</span>
            </div>
            <div
              v-for="subscription in view.activities.subscriptions"
              :key="subscription.id"
              class="workspace-list-row"
            >
              <strong>{{ subscription.title }}</strong
              ><span>{{ subscription.status }}</span>
            </div>
            <p
              v-if="!view.activities.works.length && !view.activities.subscriptions.length"
              class="empty-note"
            >
              此会话暂无作品与订阅。
            </p></template
          ></template
        >
        <p v-if="!canWrite" class="field-help">
          {{
            uncertain
              ? '请先核对未知操作结果。'
              : capability('simulation.group-write', conversation.scopeKey).reason
          }}
        </p>
      </div></PageState
    >
  </section>
</template>
