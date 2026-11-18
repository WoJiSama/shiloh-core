<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NPagination, NTag } from 'naive-ui'
import { ArrowUpRight, MessageCircle, Cable } from 'lucide-vue-next'
import { workspace, capability } from '../lib/workspace'
import { robotLabel, robotLocation, connectionStateLabel } from '../lib/workspaceModel'
import PageHeader from '../components/PageHeader.vue'
import WorkspaceOnboarding from '../components/WorkspaceOnboarding.vue'
const data = workspace.data,
  query = ref(''),
  page = ref(1)
const onboarding = ref(false)
const createCapability = computed(() =>
  ['configuration.read', 'configuration.preview', 'configuration.commit']
    .map((operation) => capability(operation))
    .find((item) => item.status !== 'available')
)
const rows = computed(
  () =>
    data.value?.agents.filter((item) =>
      `${item.name} ${item.personaName} ${item.id} ${item.conversations.map((row) => row.binding.connectionId + ' ' + row.binding.target.id).join(' ')}`
        .toLowerCase()
        .includes(query.value.toLowerCase())
    ) ?? []
)
const visible = computed(() => rows.value.slice((page.value - 1) * 12, page.value * 12))
watch(query, () => (page.value = 1))
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="机器人"
      description="每张卡片对应一个独立的本人。平台账号与人设模板都不代替她的身份。"
      ><template #actions
        ><NButton
          type="primary"
          :disabled="!!createCapability"
          :title="createCapability?.reason"
          @click="onboarding = true"
          >创建本人</NButton
        ></template
      ></PageHeader
    >
    <p v-if="createCapability" class="field-help">{{ createCapability.reason }}</p>
    <WorkspaceOnboarding v-model:show="onboarding" kind="agent.create" />
    <div class="toolbar workspace-filter">
      <NInput
        v-model:value="query"
        placeholder="搜索名字、人设、连接或会话"
        aria-label="搜索机器人"
        clearable
      /><span class="muted">{{ rows.length }} 个本人</span>
    </div>
    <div class="robot-card-grid">
      <RouterLink
        v-for="agent in visible"
        :key="agent.id"
        :to="robotLocation(agent)"
        class="panel robot-card"
        ><div class="panel-heading">
          <span class="robot-avatar large">{{ agent.name.slice(0, 1) }}</span
          ><ArrowUpRight :size="19" />
        </div>
        <h2>{{ robotLabel(agent, data?.agents ?? []) }}</h2>
        <p class="muted">人设 · {{ agent.personaName }}</p>
        <div class="robot-card-meta">
          <span><MessageCircle :size="15" />{{ agent.conversations.length }} 个会话</span
          ><span
            ><Cable :size="15" />{{
              new Set(agent.conversations.map((row) => row.binding.connectionId)).size
            }}
            个连接</span
          >
        </div>
        <div class="tag-list">
          <NTag
            v-for="connection in data?.connections.filter((item) =>
              agent.conversations.some((row) => row.binding.connectionId === item.id)
            )"
            :key="connection.id"
            size="small"
            :type="connection.state === 'connected' ? 'success' : 'default'"
            >{{ connection.id }} · {{ connectionStateLabel(connection.state) }}</NTag
          >
        </div></RouterLink
      >
    </div>
    <p v-if="!rows.length" class="panel empty-note">没有匹配的机器人。</p>
    <NPagination
      v-if="rows.length > 12"
      v-model:page="page"
      :page-size="12"
      :item-count="rows.length"
    />
  </div>
</template>
