<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NButton, NInput, NPagination, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import WorkspaceOnboarding from '../components/WorkspaceOnboarding.vue'
import QzoneComposer from '../components/QzoneComposer.vue'
import WorkspaceQqLogin from '../components/WorkspaceQqLogin.vue'
import { workspace, capability } from '../lib/workspace'
import { connectionStateLabel, robotLabel, robotLocation } from '../lib/workspaceModel'
import { accountLabel, accountReference, conversationLabel, namedId } from '../lib/workspaceNames'
const route = useRoute(),
  data = workspace.data,
  query = ref(''),
  page = ref(1)
const onboarding = ref(false)
const qzoneOpen = ref(false), qzoneAccount = ref('')
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
      description="查看平台账号、QQ 登录和已接入的会话。"
      ><template #actions
        ><NButton
          type="primary"
          :disabled="!!createCapability"
          :title="createCapability?.reason"
          @click="onboarding = true"
          >新增 QQ 连接</NButton
        ></template
      ></PageHeader
    >
    <p v-if="createCapability" class="field-help">{{ createCapability.reason }}</p>
    <WorkspaceOnboarding v-model:show="onboarding" kind="connection.add" />
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
      <WorkspaceQqLogin :connection="connection" :primary="connection.state === 'disconnected'" />
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
