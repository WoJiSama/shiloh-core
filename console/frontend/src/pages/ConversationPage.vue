<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import SchemaPage from './SchemaPage.vue'
import { workspace } from '../lib/workspace'

const tab = ref('conversation')
const trackingVisited = ref(false)
const reasoningVisited = ref(false)
const conversation = ref<InstanceType<typeof SchemaPage> | null>(null)
const tracking = ref<InstanceType<typeof SchemaPage> | null>(null)
const reasoning = ref<InstanceType<typeof SchemaPage> | null>(null)
const editors = { conversation, tracking, reasoning }
const editor = computed(() => editors[tab.value as keyof typeof editors]?.value)
const tabs = computed(() => [
  { id: 'conversation', label: '对话配置' },
  { id: 'tracking', label: '对话追踪' },
  ...(workspace.mode.value === 'standalone' ? [{ id: 'reasoning', label: '推理设置' }] : [])
])
function selectTab(id: string) {
  if (id === 'tracking') trackingVisited.value = true
  if (id === 'reasoning') reasoningVisited.value = true
  tab.value = id
}
</script>

<template>
  <div class="page-stack conversation-page">
    <PageHeader
      title="对话设置"
      eyebrow="配置中心"
      description="设置触发、访问权限与回复方式，调整追踪和群聊参与策略。"
      ><template #actions
        ><NButton :disabled="editor?.saving || editor?.loading" @click="editor?.reload()"
          >刷新配置</NButton
        ></template
      ></PageHeader
    >
    <nav class="task-tabs" role="tablist" aria-label="对话设置任务分区">
      <button
        v-for="item in tabs"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        @click="selectTab(item.id)"
      >
        {{ item.label }}
        <NTag
          v-if="editors[item.id as keyof typeof editors].value?.dirty"
          type="warning"
          size="small"
          >{{ editors[item.id as keyof typeof editors].value?.dirty }}</NTag
        >
      </button>
    </nav>
    <SchemaPage v-show="tab === 'conversation'" ref="conversation" kind="conversation" embedded />
    <SchemaPage
      v-if="trackingVisited"
      v-show="tab === 'tracking'"
      ref="tracking"
      kind="tracking"
      embedded
    />
    <SchemaPage v-if="reasoningVisited" v-show="tab === 'reasoning'" ref="reasoning" kind="reasoning" embedded />
  </div>
</template>

<style scoped>
.conversation-page {
  max-width: 1120px;
}
.task-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 9px;
}
</style>
