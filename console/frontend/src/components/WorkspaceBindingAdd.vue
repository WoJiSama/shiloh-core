<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, NSelect } from 'naive-ui'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { robotLabel } from '../lib/workspaceModel'

const props = defineProps<{ connectionId: string; platform?: string }>()
const show = ref(false)
const conversationId = ref('')
const conversationKind = ref('group')
const agentId = ref<string | null>(null)
const busy = ref(false)
const error = ref('')
type Preview = { revision: string; previewId: string; readSet: Record<string, string>; candidateDigest: string }
const preview = ref<Preview>()
const validId = computed(() => props.platform === 'dingtalk'
  ? /^[A-Za-z0-9_@.$=+/-]{1,128}$/.test(conversationId.value)
  : /^[1-9]\d{4,11}$/u.test(conversationId.value))
const agents = computed(() => (workspace.data.value?.agents ?? []).map((agent, _, rows) => ({
  label: robotLabel(agent, rows), value: agent.id
})))
const allowed = computed(() => ['configuration.read', 'configuration.preview', 'configuration.commit']
  .every(operation => capability(operation).status === 'available'))
function open() {
  conversationId.value = ''
  conversationKind.value = 'group'
  agentId.value = null
  error.value = ''
  preview.value = undefined
  show.value = true
}
const invalidate = () => { preview.value = undefined }
async function save() {
  if (busy.value || !agentId.value || !validId.value) return
  busy.value = true
  error.value = ''
  try {
    if (preview.value) {
      const { revision, previewId, readSet, candidateDigest } = preview.value
      await api('/api/configuration/commit', { method: 'POST', body: JSON.stringify({ revision, previewId, readSet, candidateDigest }) })
      show.value = false
    } else {
      const { revision } = await api<{ revision: string }>('/api/configuration/catalog')
      preview.value = await api<Preview>('/api/configuration/preview', { method: 'POST', body: JSON.stringify({
        revision, change: { kind: 'binding.add', agentId: agentId.value, connectionId: props.connectionId,
          conversationId: conversationId.value, conversationKind: conversationKind.value }
      }) })
    }
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <NButton v-if="allowed" size="small" @click="open">绑定会话</NButton>
  <NModal v-model:show="show" preset="card" title="绑定会话" :style="{ width: 'min(450px, 92vw)' }" :mask-closable="!busy">
    <div class="page-stack">
      <label>机器人<NSelect v-model:value="agentId" :options="agents" :disabled="busy" @update:value="invalidate" /></label>
      <label>会话类型<NSelect v-model:value="conversationKind" :options="[{ label: '群聊', value: 'group' }, { label: '好友私聊', value: 'private' }]" :disabled="busy" @update:value="invalidate" /></label>
      <label>{{ platform === 'dingtalk' ? '群 Open Conversation ID 或成员 User ID' : '群号或好友 QQ 号' }}<NInput v-model:value="conversationId" :disabled="busy" @update:value="invalidate" /></label>
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <NAlert v-if="preview" type="info">配置校验通过。保存后需要重启 Core 以加载绑定。</NAlert>
      <NButton type="primary" :loading="busy" :disabled="!agentId || !validId" @click="save">
        {{ preview ? '保存绑定' : '核对绑定' }}
      </NButton>
    </div>
  </NModal>
</template>
