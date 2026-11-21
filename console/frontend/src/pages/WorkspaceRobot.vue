<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NInput, NPagination, NTag } from 'naive-ui'
import { workspace, capability } from '../lib/workspace'
import { api } from '../lib/api'
import {
  connectionStateLabel,
  robotLabel,
  robotLocation,
  selectConversation,
  statusLabel,
  type WorkspaceConversation
} from '../lib/workspaceModel'
import { accountLabel, conversationLabel, namedId } from '../lib/workspaceNames'
import PageHeader from '../components/PageHeader.vue'
import CapabilityGate from '../components/CapabilityGate.vue'
import RobotScene from '../components/RobotScene.vue'
import PersonProfilesPage from './PersonProfilesPage.vue'
import TrusteeshipPage from './TrusteeshipPage.vue'
const route = useRoute(),
  router = useRouter(),
  data = workspace.data
const tabs = [
  { id: 'home', label: '主页' },
  { id: 'conversations', label: '会话' },
  { id: 'self', label: '自我与记忆' },
  { id: 'actions', label: '行动' },
  { id: 'boundaries', label: '能力与边界' }
]
const agent = computed(() => data.value?.agents.find((item) => item.id === route.params.id))
interface SelfProfileVersion {
  revision: number
  name: string
  aliases: string[]
  introduction: string
  identity: string
  reason: string
  changedAt: number
}
interface PersonalWorkSummary {
  goals: { id: string; title: string; nextAt: number; state: 'active' | 'completed' | 'abandoned'; waitingFor?: string }[]
  actions: { id: string; kind: 'contact' | 'reserve' | 'research' | 'coding' | 'follow-share'; state: 'pending' | 'confirmed' | 'failed' | 'unknown'; at: number; goalId?: string; followId?: string }[]
  tools: { name: string; description: string; activeRevision?: number; versions?: number[] }[]
  followEnabled?: boolean
  follows?: { id: string; title: string; url: string; state: 'active' | 'stopped'; nextAt: number; lastCheckedAt?: number;
    failures: number; latest?: { text: string; url: string; at: number } }[]
}
const selfProfiles = ref<SelfProfileVersion[]>([])
const personalWork = ref<PersonalWorkSummary>()
const profileError = ref('')
const profileLoading = ref(false)
const selfProfile = computed(() => selfProfiles.value.at(-1))
const tab = computed(() =>
  tabs.some((item) => item.id === route.params.tab) ? String(route.params.tab) : 'home'
)
watch(() => [tab.value, agent.value?.id, capability('self-profile.read').status] as const, async ([selected, id, status], _previous, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  selfProfiles.value = []
  personalWork.value = undefined
  profileError.value = ''
  profileLoading.value = false
  if (!['self', 'actions'].includes(selected) || !id || status !== 'available') return
  profileLoading.value = true
  try {
    const result = await api('/api/self-profile/' + encodeURIComponent(id), { signal: controller.signal }) as {
      profiles: SelfProfileVersion[]; work?: PersonalWorkSummary
    }
    if (!controller.signal.aborted) {
      selfProfiles.value = result.profiles
      personalWork.value = result.work
    }
  } catch (error) {
    if (!controller.signal.aborted) profileError.value = (error as Error).message
  } finally {
    if (!controller.signal.aborted) profileLoading.value = false
  }
}, { immediate: true })
const goalStates = { active: '进行中', completed: '已完成', abandoned: '已放下' }
const actionNames = { contact: '联系', reserve: '预约登记', research: '检索', coding: '编程候选', 'follow-share': '分享兴趣更新' }
const actionStates = { pending: '待回执', confirmed: '已确认', failed: '失败', unknown: '待核实' }
const beijingTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' })
const selection = computed(() => {
  try {
    return {
      selected: agent.value ? selectConversation(agent.value, route.query) : undefined,
      error: ''
    }
  } catch (cause) {
    return { selected: undefined, error: (cause as Error).message }
  }
})
const query = ref(''),
  page = ref(1)
const panel = computed(() => {
  const value = route.query.panel
  if (tab.value === 'self' && value === 'person-profiles') return value
  if (tab.value === 'actions' && value === 'trusteeship') return value
  return undefined
})
const rows = computed(
  () =>
    agent.value?.conversations
      .filter(
        (row) => !route.query.connection || row.binding.connectionId === route.query.connection
      )
      .filter((row) =>
        `${conversationLabel(row)} ${row.binding.connectionId} ${accountLabel(row.binding.target.account)}`
          .toLowerCase()
          .includes(query.value.toLowerCase())
      ) ?? []
)
const visible = computed(() =>
  selection.value.selected
    ? [selection.value.selected]
    : rows.value.slice((page.value - 1) * 6, page.value * 6)
)
const connections = computed(
  () =>
    data.value?.connections.filter((item) =>
      agent.value?.conversations.some((row) => row.binding.connectionId === item.id)
    ) ?? []
)
function open(row: WorkspaceConversation) {
  if (agent.value) void router.push(robotLocation(agent.value, tab.value, row))
}
function simulationLocation(row: WorkspaceConversation) {
  return {
    path: '/simulation',
    query: {
      agentId: row.binding.agentId,
      returnTab: tab.value,
      connection: row.binding.connectionId,
      scopeKey: row.scopeKey,
      bindingToken: row.bindingToken
    }
  }
}
const personaTarget = computed(() => {
  if (!agent.value) return { path: '/persona', query: {} }
  const selected = selection.value.selected
  const location = selected
    ? robotLocation(agent.value, tab.value, selected)
    : robotLocation(agent.value, tab.value)
  return {
    path: '/persona',
    query: {
      agentId: agent.value.id,
      returnTab: tab.value,
      ...(typeof route.query.connection === 'string' ? { connection: route.query.connection } : {}),
      ...(selected ? location.query : {})
    }
  }
})
function togglePanel(next: 'person-profiles' | 'trusteeship') {
  const nextQuery = { ...route.query }
  if (panel.value === next) delete nextQuery.panel
  else nextQuery.panel = next
  void router.push({ path: route.path, query: nextQuery })
}
function tabQuery(id: string) {
  const nextQuery = { ...route.query }
  const panelForTab =
    (id === 'self' && nextQuery.panel === 'person-profiles') ||
    (id === 'actions' && nextQuery.panel === 'trusteeship')
  if (!panelForTab) delete nextQuery.panel
  return nextQuery
}
watch(
  () => [tab.value, query.value, route.query.connection, route.query.scopeKey],
  () => {
    page.value = 1
  }
)
</script>
<template>
  <div class="page-stack">
    <RouterLink to="/robots">← 全部机器人</RouterLink
    ><template v-if="agent"
      ><PageHeader
        :title="robotLabel(agent, data?.agents ?? [])"
        :description="`人设 · ${agent.personaName}。${agent.conversations.length} 个绑定会话。`"
        ><template #actions
          ><span class="robot-avatar large">{{ agent.name.slice(0, 1) }}</span></template
        ></PageHeader
      >
      <nav class="robot-tabs" aria-label="机器人详情">
        <RouterLink
          v-for="item in tabs"
          :key="item.id"
          :to="{ path: robotLocation(agent, item.id).path, query: tabQuery(item.id) }"
          :class="{ active: tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <NAlert v-if="selection.error" type="error" title="会话链接已失效"
        >{{ selection.error }}
        <div>
          <NButton size="small" @click="router.push(robotLocation(agent, tab))"
            >返回本人的会话</NButton
          >
        </div></NAlert
      >
      <template v-else-if="tab === 'home'"
        ><div class="workspace-columns">
          <section class="panel">
            <span class="eyebrow">本人</span>
            <h2>{{ robotLabel(agent, data?.agents ?? []) }}</h2>
            <p class="field-help">
              初始人设「{{ agent.personaName }}」。在「自我与记忆」中查看她现在的档案。
            </p>
            <details class="technical-details">
              <summary>技术详情</summary>
              <dl>
                <dt>agentId</dt>
                <dd>{{ agent.id }}</dd>
                <dt>personaId</dt>
                <dd>{{ agent.personaId }}</dd>
              </dl>
            </details>
            <RouterLink :to="personaTarget" class="text-link">查看人设资源 →</RouterLink>
          </section>
          <section class="panel">
            <h2>接入连接</h2>
            <div v-for="connection in connections" :key="connection.id" class="workspace-list-row">
              <RouterLink :to="`/connections/${encodeURIComponent(connection.id)}`">{{
                namedId(connection.id, connection.name)
              }}</RouterLink
              ><NTag
                size="small"
                :type="connection.state === 'connected' ? 'success' : 'default'"
                >{{ connectionStateLabel(connection.state) }}</NTag
              >
            </div>
            <p v-if="!connections.length" class="empty-note">当前没有绑定连接。</p>
          </section>
        </div>
        <section class="panel">
          <div class="panel-heading">
            <h2>本人的会话</h2>
            <RouterLink :to="robotLocation(agent, 'conversations')">查看全部</RouterLink>
          </div>
          <div
            v-for="row in agent.conversations.slice(0, 6)"
            :key="row.scopeKey"
            class="workspace-list-row"
          >
            <span class="row-main"
              ><strong>{{ conversationLabel(row) }}</strong
              ><small
                >{{ row.binding.connectionId }} ·
                {{ accountLabel(row.binding.target.account) }}</small
              ></span
            ><RouterLink :to="robotLocation(agent, 'conversations', row)">进入会话 →</RouterLink>
          </div>
          <p v-if="!agent.conversations.length" class="empty-note">本人尚未绑定会话。</p>
        </section>
        </template
      >
      <template v-else-if="['conversations', 'self', 'actions'].includes(tab)"
        ><section v-if="tab === 'self' && (selfProfile || profileLoading || profileError)" class="panel">
          <h3>本人档案</h3>
          <NAlert v-if="profileError" type="error">{{ profileError }}</NAlert>
          <p v-else-if="profileLoading">正在读取档案</p>
          <template v-else-if="selfProfile">
            <p><strong>{{ selfProfile.name }}</strong> <NTag size="small">版本 {{ selfProfile.revision }}</NTag></p>
            <p v-if="selfProfile.aliases.length">也回应 {{ selfProfile.aliases.join('、') }}</p>
            <p v-if="selfProfile.introduction">{{ selfProfile.introduction }}</p>
            <p>{{ selfProfile.identity }}</p>
            <details v-if="selfProfiles.length > 1">
              <summary>档案修订记录</summary>
              <ol>
                <li v-for="entry in [...selfProfiles].reverse()" :key="entry.revision">
                  <strong>{{ entry.name }}</strong> · {{ entry.changedAt ? new Date(entry.changedAt).toLocaleString() : '初始档案' }}
                  <p>{{ entry.reason }}</p>
                </li>
              </ol>
            </details>
          </template>
        </section>
        <section v-if="tab === 'actions' && (personalWork || profileLoading || profileError)" class="panel">
          <h3>自主工作</h3>
          <NAlert v-if="profileError" type="error">{{ profileError }}</NAlert>
          <p v-else-if="profileLoading">正在读取自主工作</p>
          <template v-else-if="personalWork">
            <div v-for="goal in personalWork.goals" :key="goal.id" class="workspace-row">
              <span class="row-main">
                <strong>{{ goal.title }}</strong>
                <small v-if="goal.state === 'active'">
                  {{ goal.waitingFor || '下次检查' }} · {{ beijingTime.format(goal.nextAt) }}
                </small>
              </span>
              <NTag size="small">{{ goalStates[goal.state] }}</NTag>
            </div>
            <p v-if="!personalWork.goals.length" class="empty-note">暂无自主目标。</p>
            <details v-if="personalWork.followEnabled || personalWork.follows?.length" open>
              <summary>兴趣跟进</summary>
              <p v-if="!personalWork.followEnabled" class="empty-note">兴趣跟进已停用。</p>
              <p v-else-if="!personalWork.follows?.length" class="empty-note">还没有开始跟进。</p>
              <div v-for="follow in personalWork.follows" :key="follow.id" class="workspace-row">
                <div class="row-main">
                  <a :href="follow.url" target="_blank" rel="noopener noreferrer"><strong>{{ follow.title }}</strong></a>
                  <small v-if="follow.lastCheckedAt !== undefined">最近检查 {{ beijingTime.format(follow.lastCheckedAt) }}</small>
                  <small v-if="follow.state === 'active' && personalWork.followEnabled">
                    {{ follow.failures ? '检查失败，下次重试' : '下次检查' }} {{ beijingTime.format(follow.nextAt) }}
                  </small>
                  <template v-if="follow.latest">
                    <p>{{ follow.latest.text }}</p>
                    <small><a :href="follow.latest.url" target="_blank" rel="noopener noreferrer">查看原公告</a>
                      · {{ beijingTime.format(follow.latest.at) }}</small>
                  </template>
                </div>
                <NTag size="small">{{ follow.state === 'stopped' ? '已结束' : personalWork.followEnabled ? '跟进中' : '已停用' }}</NTag>
              </div>
            </details>
            <details v-if="personalWork.actions.length">
              <summary>行动回执</summary>
              <ul>
                <li v-for="entry in [...personalWork.actions].reverse()" :key="entry.id">
                  {{ actionNames[entry.kind] }} · {{ actionStates[entry.state] }} · {{ beijingTime.format(entry.at) }}
                  <span v-if="entry.goalId"> · {{ personalWork.goals.find(goal => goal.id === entry.goalId)?.title }}</span>
                  <span v-else-if="entry.followId && personalWork.follows?.some(follow => follow.id === entry.followId)">
                    · {{ personalWork.follows?.find(follow => follow.id === entry.followId)?.title }}</span>
                </li>
              </ul>
            </details>
            <details v-if="personalWork.tools.length">
              <summary>自建工具</summary>
              <ul>
                <li v-for="tool in personalWork.tools" :key="tool.name">
                  <strong>{{ tool.name }}</strong>
                  <span v-if="tool.activeRevision !== undefined"> · {{ tool.activeRevision ? '版本 ' + tool.activeRevision : '已停用' }}</span>
                  <small> · {{ tool.description }}</small>
                </li>
              </ul>
            </details>
          </template>
        </section><p class="context-note">
          {{
            tab === 'self'
              ? '本人的档案在所有绑定会话生效。下方可以查看各会话的记忆。'
              : tab === 'actions'
                ? '目标、承诺与实际回执分别展示，待确认和未知结果不计作成功。'
                : '每个会话保留所属连接与完整平台地址。选择后再操作。'
          }}
        </p>
        <div class="toolbar workspace-filter">
          <NInput
            v-model:value="query"
            placeholder="搜索本人的连接或会话"
            aria-label="搜索本人的会话"
            clearable
          /><RouterLink
            v-if="selection.selected"
            :to="{ path: robotLocation(agent, tab).path, query: panel ? { panel } : {} }"
            >查看全部会话</RouterLink
          ><NButton
            v-if="tab === 'self' || tab === 'actions'"
            size="small"
            @click="togglePanel(tab === 'self' ? 'person-profiles' : 'trusteeship')"
            >{{ panel ? '收起' : tab === 'self' ? '人物记忆' : '托付与承诺' }}</NButton
          >
        </div>
        <template v-if="panel === 'person-profiles' && tab === 'self'"
          ><CapabilityGate operation="profiles.read"
            ><PersonProfilesPage
              :conversation-scopes="selection.selected ? [selection.selected] : rows"
              embedded /></CapabilityGate></template
        ><template v-else-if="panel === 'trusteeship' && tab === 'actions'"
          ><CapabilityGate operation="trusteeship.read"
            ><TrusteeshipPage
              :conversation-scopes="selection.selected ? [selection.selected] : rows"
              embedded /></CapabilityGate></template
        ><template v-else
          ><div v-if="!selection.selected" class="scene-selector">
            <button v-for="row in visible" :key="row.scopeKey" @click="open(row)">
              <strong>{{ conversationLabel(row) }}</strong
              ><small
                >{{ row.binding.connectionId }} ·
                {{ accountLabel(row.binding.target.account) }}</small
              >
            </button>
          </div>
          <RobotScene
            v-for="row in visible"
            :key="row.scopeKey + row.bindingToken"
            :conversation="row"
            :section="tab as 'conversations' | 'self' | 'actions'"
            :manage-to="simulationLocation(row)" />
          <p v-if="!rows.length" class="panel empty-note">没有匹配的会话。</p>
          <NPagination
            v-if="!selection.selected && rows.length > 6"
            v-model:page="page"
            :item-count="rows.length"
            :page-size="6" /></template
      ></template>
      <template v-else
        ><section class="panel">
          <h2>人设与参与边界</h2>
          <p class="field-help">
            人设是表达与身份约束的配置资源。参与、预算和实际授权按每个会话独立核验；不同连接不会自动共享访问权限。
          </p>
          <div class="toolbar">
            <RouterLink :to="personaTarget">人设模板与分配 →</RouterLink
            ><RouterLink :to="robotLocation(agent, 'conversations')">各会话参与边界 →</RouterLink>
          </div>
        </section>
        <section class="panel">
          <h2>当前管理能力</h2>
          <div v-for="item in data?.capabilities" :key="item.operation" class="capability-row">
            <span class="row-main"
              ><code>{{ item.operation }}</code
              ><small
                >{{ item.scope === 'conversation' ? '按会话核验' : '实例管理'
                }}<template v-if="item.reason">
                  · {{ capability(item.operation).reason }}</template
                ></small
              ></span
            ><NTag size="small">{{ statusLabel(capability(item.operation).status) }}</NTag>
          </div>
        </section></template
      > </template
    ><NAlert v-else type="info" title="未找到机器人"
      >此本人不在当前可见工作区内，请从机器人列表重新选择。</NAlert
    >
  </div>
</template>
