<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, NSelect } from 'naive-ui'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { parseConfigurationCatalog, parseConfigurationPreview, type ConfigurationCatalog, type ConfigurationPreview } from '../lib/workspaceChangeModel'
import type { WorkspaceConnection } from '../lib/workspaceModel'
import { conversationLabel } from '../lib/workspaceNames'
import ConfigurationCandidatePreview from './ConfigurationCandidatePreview.vue'

const props = defineProps<{ connection?: WorkspaceConnection }>()
const show = ref(false), busy = ref(false), error = ref(''), saved = ref(false)
const catalog = ref<ConfigurationCatalog>(), preview = ref<ConfigurationPreview>()
const fields = reactive({ agentId: '', id: '', name: '', namespace: '', accountId: '', conversationId: '',
  clientIdEnv: 'DINGTALK_CLIENT_ID', clientSecretEnv: 'DINGTALK_CLIENT_SECRET',
  personaId: 'inherit', memorySpaceId: '', sharedGroups: [] as string[] })
const allowed = computed(() => ['configuration.read', 'configuration.preview', 'configuration.commit']
  .every(operation => capability(operation).status === 'available'))
const groups = computed(() => workspace.data.value?.agents.flatMap(ag => ag.conversations).filter(row =>
  row.binding.connectionId === props.connection?.id && row.binding.target.kind === 'group') ?? [])
const personas = computed(() => [
  { label: '继承现有绑定', value: 'inherit' }, { label: '无，使用通用助手', value: 'assistant:none' },
  ...(catalog.value?.personas ?? []).map(row => ({ label: row.name, value: row.id })),
])
const spaces = computed(() => [...new Set(workspace.data.value?.connections.flatMap(row => row.memorySpaceId ? [row.memorySpaceId] : []) ?? [])])
const inputId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const dingId = /^[A-Za-z0-9_@.$=+/-]{1,128}$/
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/
const valid = computed(() => props.connection ? (!fields.memorySpaceId || inputId.test(fields.memorySpaceId)) :
  !!fields.agentId && inputId.test(fields.id) && !!fields.name.trim() && [fields.namespace, fields.accountId, fields.conversationId].every(id => dingId.test(id)) &&
  envName.test(fields.clientIdEnv) && envName.test(fields.clientSecretEnv))

async function open() {
  show.value = true
  saved.value = false
  error.value = ''
  preview.value = undefined
  catalog.value = undefined
  fields.personaId = props.connection?.personaId ?? 'inherit'
  fields.memorySpaceId = props.connection?.memorySpaceId ?? ''
  fields.sharedGroups = groups.value.filter(row => row.sharedGroup).map(row => row.binding.target.id)
  busy.value = true
  try { catalog.value = parseConfigurationCatalog(await api('/api/configuration/catalog')) }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
const invalidate = () => { preview.value = undefined }
async function save() {
  if (busy.value || !catalog.value || !valid.value) return
  busy.value = true
  error.value = ''
  try {
    if (preview.value) {
      const { revision, previewId, readSet, candidateDigest } = preview.value
      await api('/api/configuration/commit', { method: 'POST', body: JSON.stringify({ revision, previewId, readSet, candidateDigest }) })
      saved.value = true
      preview.value = undefined
      return
    }
    const change = props.connection ? { kind: 'connection.settings', connectionId: props.connection.id,
      personaId: fields.personaId, memorySpaceId: fields.memorySpaceId || null, sharedGroups: fields.memorySpaceId ? fields.sharedGroups : [] } :
      { kind: 'connection.dingtalk.add', agentId: fields.agentId, connection: { id: fields.id, accountId: fields.accountId,
        namespace: fields.namespace, name: fields.name.trim(), clientIdEnv: fields.clientIdEnv, clientSecretEnv: fields.clientSecretEnv },
      conversations: [{ kind: 'group', conversationId: fields.conversationId }] }
    preview.value = parseConfigurationPreview(await api('/api/configuration/preview', { method: 'POST',
      body: JSON.stringify({ revision: catalog.value.revision, change }) }))
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <NButton v-if="allowed" :size="connection ? 'small' : 'medium'" @click="open">
    {{ connection ? '人设与记忆空间' : '新增钉钉连接' }}
  </NButton>
  <NModal v-model:show="show" preset="card" :title="connection ? '人设与记忆空间' : '新增钉钉连接'"
    :style="{ width: 'min(610px, 94vw)' }" :mask-closable="!busy">
    <div class="page-stack">
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <NAlert v-if="saved" type="info">已保存。重启 Core 后生效。</NAlert>
      <template v-else>
        <template v-if="connection">
          <label>账号人设<NSelect v-model:value="fields.personaId" :options="personas" :disabled="busy" @update:value="invalidate" /></label>
          <label>记忆空间 ID<NInput v-model:value="fields.memorySpaceId" placeholder="留空时使用账号自己的记忆" :disabled="busy" @update:value="invalidate" /></label>
          <div v-if="spaces.length" class="toolbar">
            <NButton v-for="space in spaces" :key="space" size="tiny" :disabled="busy" @click="fields.memorySpaceId = space; invalidate()">{{ space }}</NButton>
          </div>
          <label>共享群聊<NSelect v-model:value="fields.sharedGroups" multiple :disabled="busy || !fields.memorySpaceId"
            :options="groups.map(row => ({ label: conversationLabel(row), value: row.binding.target.id }))" @update:value="invalidate" /></label>
          <p class="field-help">选中的群可读空间内明确共享的笔记。跨账号私聊需另行核实双方身份。</p>
        </template>
        <template v-else>
          <label>机器人<NSelect v-model:value="fields.agentId" :disabled="busy"
            :options="(catalog?.agents ?? []).map(row => ({ label: row.agentId, value: row.agentId }))" @update:value="invalidate" /></label>
          <label>连接 ID<NInput v-model:value="fields.id" :disabled="busy" @update:value="invalidate" /></label>
          <label>显示名称<NInput v-model:value="fields.name" maxlength="100" :disabled="busy" @update:value="invalidate" /></label>
          <label>企业 Corp ID<NInput v-model:value="fields.namespace" :disabled="busy" @update:value="invalidate" /></label>
          <label>机器人 Robot Code<NInput v-model:value="fields.accountId" :disabled="busy" @update:value="invalidate" /></label>
          <label>群 Open Conversation ID<NInput v-model:value="fields.conversationId" :disabled="busy" @update:value="invalidate" /></label>
          <label>Client ID 环境变量<NInput v-model:value="fields.clientIdEnv" :disabled="busy" @update:value="invalidate" /></label>
          <label>Client Secret 环境变量<NInput v-model:value="fields.clientSecretEnv" :disabled="busy" @update:value="invalidate" /></label>
        </template>
        <ConfigurationCandidatePreview v-if="preview" :value="preview" />
        <NButton type="primary" :loading="busy" :disabled="!valid || !catalog" @click="save">{{ preview ? '保存配置' : '核对配置' }}</NButton>
      </template>
    </div>
  </NModal>
</template>
