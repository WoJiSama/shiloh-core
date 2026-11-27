<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAlert, NButton, NInput, NModal, NPagination, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import WorkspaceOnboarding from '../components/WorkspaceOnboarding.vue'
import QzoneComposer from '../components/QzoneComposer.vue'
import WorkspaceQqLogin from '../components/WorkspaceQqLogin.vue'
import WorkspaceBindingAdd from '../components/WorkspaceBindingAdd.vue'
import WorkspaceChannelSettings from '../components/WorkspaceChannelSettings.vue'
import WorkspaceDingTalkReplyPolicy from '../components/WorkspaceDingTalkReplyPolicy.vue'
import { api } from '../lib/api'
import { useOpsResource } from '../lib/operations'
import { workspace, capability } from '../lib/workspace'
import { connectionStateLabel, robotLabel, robotLocation } from '../lib/workspaceModel'
import { accountLabel, accountReference, conversationLabel, namedId } from '../lib/workspaceNames'
const props = defineProps<{ accountId?: string }>()
const route = useRoute(),
  data = workspace.data,
  query = ref(''),
  page = ref(1)
const onboarding = ref(false)
const qzoneOpen = ref(false), qzoneAccount = ref('')
type ManagedAccount = { connectionId: string; accountId: string; state: 'running' | 'stopped' | 'absent' | 'unavailable'; busy: boolean }
const managedAccounts = useOpsResource(signal => capability('accounts.managed').status === 'available'
  ? api<{ revision: string; accounts: ManagedAccount[]; canProvision: boolean }>('/api/accounts/managed', { signal }) : Promise.resolve(null))
const managed = computed(() => new Map(managedAccounts.data.value?.accounts.map(row => [row.connectionId, row])))
const activeAction = ref('')
const accountError = ref('')
const provisioning = ref(false)
const newAccount = ref('')
const stateLabels = { running: '账号容器运行中', stopped: '账号容器已停用', absent: '账号容器缺失', unavailable: '容器状态不可用' }
watch(() => [workspace.data.value?.observedAt, capability('accounts.managed').status] as const, ([, status]) => {
  if (status === 'available') void managedAccounts.refresh()
  else managedAccounts.reset()
})
async function operate(row: ManagedAccount, action: 'start' | 'stop' | 'restart') {
  if (activeAction.value || (action !== 'start' && !window.confirm(`确认${action === 'stop' ? '停用' : '重启'}此 QQ 账号？`))) return
  activeAction.value = row.connectionId
  accountError.value = ''
  try {
    await api('/api/accounts/action', { method: 'POST', body: JSON.stringify({
      connectionId: row.connectionId, accountId: row.accountId, action }) })
    await Promise.all([managedAccounts.refresh(), workspace.load()])
  } catch (cause) { accountError.value = (cause as Error).message }
  finally { activeAction.value = '' }
}
async function provision() {
  const revision = managedAccounts.data.value?.revision
  if (!revision || activeAction.value || !/^[1-9]\d{4,11}$/u.test(newAccount.value)) return
  activeAction.value = 'add'
  accountError.value = ''
  try {
    await api('/api/accounts/add', { method: 'POST', body: JSON.stringify({ accountId: newAccount.value, revision }) })
    provisioning.value = false
    newAccount.value = ''
  } catch (cause) { accountError.value = (cause as Error).message }
  finally { activeAction.value = '' }
}
const createCapability = computed(() =>
  ['configuration.read', 'configuration.preview', 'configuration.commit']
    .map((operation) => capability(operation))
    .find((item) => item.status !== 'available')
)
const connections = computed(() => {
  const snapshot = data.value
  const search = query.value.trim().toLocaleLowerCase()
  if (!snapshot) return []
  const scenes = snapshot.agents.flatMap((agent) =>
    agent.conversations.map((conversation) => ({ agent, conversation }))
  )
  return snapshot.connections.flatMap((connection) => {
    if (props.accountId && props.accountId !== connection.account.id) return []
    if (route.params.id && connection.id !== route.params.id) return []
    const rows = scenes.filter(({ conversation }) => conversation.binding.connectionId === connection.id)
    if (!search || `${connection.id} ${accountLabel(connection.account)}`.toLocaleLowerCase().includes(search))
      return [{ connection, rows }]
    const matching = rows.filter(({ agent, conversation }) =>
      `${conversationLabel(conversation)} ${agent.name}`.toLocaleLowerCase().includes(search))
    return matching.length ? [{ connection, rows: matching }] : []
  })
})
const visible = computed(() => connections.value.slice((page.value - 1) * 12, page.value * 12))
const title = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? namedId(id, data.value?.connections.find(row => row.id === id)?.name) : '连接'
})
watch([query, () => route.params.id], () => (page.value = 1))
</script>
<template>
  <div class="page-stack">
    <PageHeader
      :title="title"
      description="管理平台账号、回复规则、人设、记忆空间和会话。"
      ><template #actions
        ><NButton v-if="managedAccounts.data.value?.canProvision && capability('accounts.add').status === 'available'" type="primary"
          @click="provisioning = true">开通 QQ 账号</NButton><NButton
          type="primary"
          :disabled="!!createCapability"
          :title="createCapability?.reason"
          @click="onboarding = true"
          >新增 QQ 连接</NButton
        ><WorkspaceChannelSettings /></template
      ></PageHeader
    >
    <p v-if="createCapability" class="field-help">{{ createCapability.reason }}</p>
    <WorkspaceOnboarding v-model:show="onboarding" kind="connection.add" />
    <NModal v-model:show="provisioning" preset="card" title="开通 QQ 账号" :style="{ width: 'min(450px, 92vw)' }" :mask-closable="!activeAction">
      <div class="page-stack">
        <p>开通后重启 Core，再回到连接页扫码。登录完成后可为此账号绑定机器人和会话。</p>
        <NInput v-model:value="newAccount" placeholder="输入 QQ 号" aria-label="输入 QQ 号" />
        <NAlert v-if="accountError" type="error">{{ accountError }}</NAlert>
        <NButton type="primary" :loading="activeAction === 'add'" :disabled="!/^[1-9]\d{4,11}$/u.test(newAccount)" @click="provision">创建账号容器</NButton>
      </div>
    </NModal>
    <NAlert v-if="accountError && !provisioning" type="error">{{ accountError }}</NAlert>
    <NAlert v-if="managedAccounts.error.value" type="warning">暂时无法读取账号容器状态。</NAlert>
    <QzoneComposer v-if="qzoneAccount" v-model:show="qzoneOpen" :bot-ids="[qzoneAccount]" />
    <RouterLink v-if="route.params.id" to="/connections">← 全部连接</RouterLink
    ><NInput
      v-model:value="query"
      placeholder="搜索连接、群名、QQ 昵称或号码"
      :input-props="{ 'aria-label': '搜索连接或会话' }"
      clearable
    />
    <section v-for="{ connection, rows } in visible" :key="connection.id" class="panel">
      <div class="panel-heading">
        <div>
          <h2>{{ connection.name || connection.id }}</h2>
          <p class="field-help">
            <template v-if="connection.name">{{ connection.id }} · </template>{{ accountReference(connection.account) }}
          </p>
        </div>
        <NTag :type="connection.state === 'connected' ? 'success' : connection.state === 'disconnected' ? 'warning' : 'default'">{{
          connectionStateLabel(connection.state)
        }}</NTag>
      </div>
      <p class="field-help">{{ connection.conversationCount }} 个接入会话</p>
      <p class="field-help">人设 {{ connection.personaId === 'assistant:none' ? '无' : connection.personaId || '继承会话绑定' }} · 记忆 {{ connection.memorySpaceId || '独享' }}</p>
      <WorkspaceQqLogin v-if="connection.account.platform === 'qq'" :connection="connection" :primary="connection.state === 'disconnected'" />
      <WorkspaceBindingAdd :connection-id="connection.id" :platform="connection.account.platform" />
      <WorkspaceChannelSettings :connection="connection" />
      <WorkspaceDingTalkReplyPolicy v-if="connection.account.platform === 'dingtalk'" :connection-id="connection.id" />
      <RouterLink v-if="connection.account.platform === 'qq' && capability('bot-stats.read').status === 'available'"
        :to="{ path: '/runtime', query: { qq: connection.account.id } }">收发统计</RouterLink>
      <div v-if="managed.has(connection.id)" class="toolbar">
        <span class="field-help">{{ stateLabels[managed.get(connection.id)!.state] }}</span>
        <template v-if="capability('accounts.action').status === 'available'">
          <NButton v-if="managed.get(connection.id)!.state === 'stopped'" size="small" :disabled="!!activeAction"
            @click="operate(managed.get(connection.id)!, 'start')">启用</NButton>
          <template v-if="managed.get(connection.id)!.state === 'running'">
            <NButton size="small" :disabled="!!activeAction" @click="operate(managed.get(connection.id)!, 'restart')">重启账号</NButton>
            <NButton size="small" :disabled="!!activeAction" @click="operate(managed.get(connection.id)!, 'stop')">停用</NButton>
          </template>
        </template>
      </div>
      <p v-if="connection.account.platform === 'qq' && connection.state === 'disconnected' && !connection.capabilities.includes('qq.login')" class="field-help">
        此连接未配置控制台扫码，请在对应的 QQ 登录服务中重新登录。
      </p>
      <NButton v-if="connection.capabilities.includes('qq.qzone') && capability('qzone.publish').status === 'available'"
        size="small" :disabled="connection.state !== 'connected'"
        @click="qzoneAccount = connection.account.id; qzoneOpen = true">发布 QQ 空间说说</NButton>
      <div class="tag-list">
        <NTag v-for="item in connection.capabilities.filter((name) => name !== 'qq.login')" :key="item" size="small">{{ item }}</NTag
        ><span v-if="!connection.capabilities.length" class="muted">未报告连接能力</span>
      </div>
      <div
        class="workspace-list-row"
        v-for="{ agent, conversation } in rows"
        :key="conversation.scopeKey"
      >
        <span class="row-main"
          ><strong>{{ conversationLabel(conversation) }}</strong
          ><small>{{ robotLabel(agent, data?.agents ?? []) }}</small></span
        ><RouterLink :to="robotLocation(agent, 'conversations', conversation)"
          >进入会话 →</RouterLink
        >
        <RouterLink v-if="conversation.binding.target.kind === 'group' && capability('group-admin.read', conversation.scopeKey).status === 'available'"
          :to="{ path: '/group-admin', query: { scopeKey: conversation.scopeKey } }">群管理</RouterLink>
      </div>
      <p v-if="!rows.length" class="empty-note">
        当前可见范围内没有绑定此连接的会话。
      </p>
    </section>
    <p v-if="!connections.length" class="panel empty-note">没有匹配的连接。</p>
    <NPagination
      v-if="connections.length > 12"
      v-model:page="page"
      :page-size="12"
      :item-count="connections.length"
    />
  </div>
</template>
