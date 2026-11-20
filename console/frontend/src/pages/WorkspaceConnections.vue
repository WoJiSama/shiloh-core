<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NButton, NInput, NPagination, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import WorkspaceOnboarding from '../components/WorkspaceOnboarding.vue'
import QzoneComposer from '../components/QzoneComposer.vue'
import { workspace, capability } from '../lib/workspace'
import {
  accountLabel,
  conversationLabel,
  connectionStateLabel,
  robotLabel,
  robotLocation
} from '../lib/workspaceModel'
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
const connections = computed(
  () =>
    data.value?.connections.filter(
      (item) =>
        (!route.params.id || item.id === route.params.id) &&
        `${item.id} ${accountLabel(item.account)}`.toLowerCase().includes(query.value.toLowerCase())
    ) ?? []
)
const visible = computed(() => connections.value.slice((page.value - 1) * 12, page.value * 12))
const scenes = (id: string) =>
  data.value?.agents.flatMap((agent) =>
    agent.conversations
      .filter((row) => row.binding.connectionId === id)
      .map((conversation) => ({ agent, conversation }))
  ) ?? []
watch(query, () => (page.value = 1))
</script>
<template>
  <div class="page-stack">
    <PageHeader
      :title="route.params.id ? String(route.params.id) : '连接'"
      description="连接是机器人的平台接入方式。连接状态来自当前适配器，不代表本人正在交流或思考。"
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
      placeholder="搜索连接或平台账号"
      aria-label="搜索连接"
      clearable
    />
    <section v-for="connection in visible" :key="connection.id" class="panel">
      <div class="panel-heading">
        <div>
          <h2>{{ connection.id }}</h2>
          <p class="field-help">{{ accountLabel(connection.account) }}</p>
        </div>
        <NTag :type="connection.state === 'connected' ? 'success' : 'default'">{{
          connectionStateLabel(connection.state)
        }}</NTag>
      </div>
      <p class="field-help">{{ connection.conversationCount }} 个接入会话</p>
      <NButton v-if="connection.capabilities.includes('qq.qzone') && capability('qzone.publish').status === 'available'"
        size="small" :disabled="connection.state !== 'connected'"
        @click="qzoneAccount = connection.account.id; qzoneOpen = true">发布 QQ 空间说说</NButton>
      <div class="tag-list">
        <NTag v-for="item in connection.capabilities" :key="item" size="small">{{ item }}</NTag
        ><span v-if="!connection.capabilities.length" class="muted">未报告连接能力</span>
      </div>
      <div
        class="workspace-list-row"
        v-for="{ agent, conversation } in scenes(connection.id)"
        :key="conversation.scopeKey"
      >
        <span class="row-main"
          ><strong>{{ robotLabel(agent, data?.agents ?? []) }}</strong
          ><small>{{ conversationLabel(conversation) }}</small></span
        ><RouterLink :to="robotLocation(agent, 'conversations', conversation)"
          >进入会话 →</RouterLink
        >
      </div>
      <p v-if="!scenes(connection.id).length" class="empty-note">
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
