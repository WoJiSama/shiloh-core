<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { consoleRestart } from '../lib/consoleRestart'
import { workspace, capability } from '../lib/workspace'
import { createWorkspaceChangeSession } from '../lib/workspaceChanges'
import { robotLabel } from '../lib/workspaceModel'
import type { ConfigurationChange } from '../lib/workspaceChangeModel'
import type { SchemaFieldDefinition } from '../lib/schemaState'
import SchemaField from './SchemaField.vue'
import ConfigurationCandidatePreview from './ConfigurationCandidatePreview.vue'

const props = defineProps<{ kind: 'connection.add' | 'agent.create'; show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const session = createWorkspaceChangeSession()
const {
  catalog,
  preview,
  receipt,
  loading,
  previewing,
  committing,
  error,
  issue,
  busy,
  locked,
  requiresRead,
  terminal,
  canStartAnother
} = session
const dialog = useDialog(),
  message = useMessage()
const isConnection = computed(() => props.kind === 'connection.add')
const connection = reactive({
  agentId: '',
  id: '',
  accountId: '',
  transport: 'forward-websocket' as 'forward-websocket' | 'reverse-websocket',
  url: '',
  accessTokenEnv: ''
})
const conversations = ref<{ kind: 'group' | 'private'; conversationId: string }[]>([
  { kind: 'group', conversationId: '' }
])
const agent = reactive({ id: '', personaMode: 'existing', personaId: 'default' })
type PersonaField =
  string | string[] | { name: string; hint: string; probability?: number }[] | undefined
const newPersona = ref<{ id: string; name: string; [field: string]: PersonaField }>({
  id: '',
  name: ''
})
const reviewed = ref(false),
  now = ref(Date.now())
const expired = computed(() => !!preview.value && preview.value.expiresAt <= now.value)
const title = computed(() => (isConnection.value ? '为本人新增 QQ 连接' : '创建机器人本人'))
const fields: SchemaFieldDefinition[] = [
  { field: 'identity', label: '身份定位', component: 'InputTextArea' },
  { field: 'tone', label: '语气', component: 'InputTextArea' },
  ...['speechStyle', 'preferences', 'boundaries'].map((field, index) => ({
    field,
    label: ['说话风格', '偏好与话题', '固定边界'][index],
    component: 'GTags'
  })),
  { field: 'notes', label: '其他备注', component: 'InputTextArea' },
  {
    field: 'moods',
    label: '心情',
    component: 'GSubForm',
    subFields: [
      { field: 'name', label: '名称', component: 'Input', required: true },
      { field: 'hint', label: '提示', component: 'InputTextArea' },
      {
        field: 'probability',
        label: '概率',
        component: 'InputNumber',
        props: { min: 0, max: 1, step: 0.01 }
      }
    ]
  },
  { field: 'reactions', label: '场景反应', component: 'InputTextArea' },
  { field: 'samples', label: '回复示例', component: 'InputTextArea' },
  { field: 'blacklist', label: '表达黑名单', component: 'InputTextArea' }
]
const agentOptions = computed(
  () =>
    catalog.value?.agents.map((item) => {
      const robot = workspace.data.value?.agents.find((row) => row.id === item.agentId)
      return {
        value: item.agentId,
        label: robot
          ? `${robotLabel(robot, workspace.data.value?.agents ?? [])} · ${item.agentId}`
          : `本人标识 · ${item.agentId}`
      }
    }) ?? []
)
const personaOptions = computed(
  () =>
    catalog.value?.personas.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.id}`
    })) ?? []
)
const draftSignature = computed(() =>
  JSON.stringify(
    isConnection.value
      ? { connection, conversations: conversations.value }
      : { agent, newPersona: newPersona.value }
  )
)
const dirty = computed(() =>
  isConnection.value
    ? Object.entries(connection).some(([key, value]) => key !== 'transport' && !!value) ||
      conversations.value.length !== 1 ||
      !!conversations.value[0]?.conversationId
    : !!agent.id ||
      agent.personaMode !== 'existing' ||
      agent.personaId !== 'default' ||
      Object.values(newPersona.value).some(Boolean)
)
useUnsavedGuard(() => committing.value || (dirty.value && issue.value !== 'saved'))
const availability = computed(() =>
  ['configuration.read', 'configuration.preview', 'configuration.commit']
    .map((operation) => capability(operation))
    .find((item) => item.status !== 'available')
)
const editDisabled = computed(() => locked.value || !!availability.value)
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const qq = /^[1-9][0-9]{0,127}$/
const validation = computed(() => {
  if (!catalog.value) return ''
  if (isConnection.value) {
    if (!catalog.value.agents.some((item) => item.agentId === connection.agentId))
      return '请选择连接所属的本人。'
    if (!identifier.test(connection.id))
      return '连接标识须为 1–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。'
    if (catalog.value.connections.some((item) => item.id === connection.id))
      return '此连接标识已存在。'
    if (!qq.test(connection.accountId)) return '请填写无前导零的 QQ 账号。'
    if (catalog.value.connections.some((item) => item.account.id === connection.accountId))
      return '此 QQ 账号已有连接，请勿重复新增。'
    try {
      const url = new URL(connection.url)
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (connection.transport === 'reverse-websocket' && url.protocol !== 'ws:')
      )
        return '请填写无凭据、查询参数或片段的 WebSocket 地址；反向监听使用 ws://。'
    } catch {
      return '请填写完整的 WebSocket 地址。'
    }
    if (
      (connection.accessTokenEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(connection.accessTokenEnv)) ||
      (connection.transport === 'reverse-websocket' && !connection.accessTokenEnv)
    )
      return '令牌环境变量名须为 1–128 位大写字母、数字或下划线，且不能以数字开头；反向连接必须填写。'
    if (
      !conversations.value.length ||
      conversations.value.length > 64 ||
      conversations.value.some((row) => !qq.test(row.conversationId))
    )
      return '请明确填写 1–64 个群聊或好友会话，编号不能有前导零。'
    if (
      new Set(conversations.value.map((row) => `${row.kind}:${row.conversationId}`)).size !==
      conversations.value.length
    )
      return '同一连接内不能重复添加相同会话。'
  } else {
    if (!identifier.test(agent.id))
      return '本人标识须为 1–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。'
    if (catalog.value.agents.some((item) => item.agentId === agent.id)) return '此本人标识已存在。'
    if (catalog.value.personas.some((item) => item.id === `agent:${agent.id}`))
      return '此本人标识与现有人设的状态分区冲突。'
    if (agent.personaMode === 'new') {
      const id = String(newPersona.value.id ?? ''),
        name = String(newPersona.value.name ?? '')
      if (
        !id.trim() ||
        id !== id.trim() ||
        id.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(id) ||
        id === 'default'
      )
        return '请填写有效的新模板标识，不能使用 default。'
      if (!name.trim() || name.length > 200) return '新人设名称不能为空，最多 200 字。'
      if (
        catalog.value.personas.some(
          (item) =>
            item.id === id ||
            (item.id !== 'default' && item.name.toLowerCase() === name.trim().toLowerCase())
        )
      )
        return '模板标识或名称已存在，请复用已有模板或使用新标识。'
      if (
        id === `agent:${agent.id}` ||
        catalog.value.agents.some((item) => id === `agent:${item.agentId}`)
      )
        return '新模板标识与本人的状态分区冲突。'
    } else if (!catalog.value.personas.some((item) => item.id === agent.personaId))
      return '请选择已有的人设模板。'
  }
  return ''
})
function change(): ConfigurationChange {
  return isConnection.value
    ? {
        kind: 'connection.add',
        agentId: connection.agentId,
        connection: {
          id: connection.id,
          accountId: connection.accountId,
          transport: connection.transport,
          url: connection.url,
          ...(connection.accessTokenEnv ? { accessTokenEnv: connection.accessTokenEnv } : {})
        },
        conversations: conversations.value.map((row) => ({ ...row }))
      }
    : {
        kind: 'agent.create',
        agentId: agent.id,
        personaId: agent.personaMode === 'new' ? String(newPersona.value.id) : agent.personaId,
        ...(agent.personaMode === 'new'
          ? { newPersona: JSON.parse(JSON.stringify(newPersona.value)) }
          : {})
      }
}
function previewDraft() {
  if (validation.value || editDisabled.value) return
  reviewed.value = false
  void session.previewChange(change())
}
function close() {
  if (committing.value) return
  session.cancelReads()
  emit('update:show', false)
}
function requestClose() {
  if (committing.value) {
    message.warning('正在提交配置，请等待结果；不要重复操作。')
    return
  }
  if (!dirty.value || terminal.value) {
    close()
    return
  }
  dialog.warning({
    title: '收起并保留草稿',
    content: '当前草稿尚未提交。收起后会保留在本页，再次打开时需要重新预览；离开页面仍需确认。',
    positiveText: '保留草稿并收起',
    negativeText: '继续编辑',
    onPositiveClick: close
  })
}
function startAnother() {
  if (!session.reset()) return
  Object.assign(connection, {
    agentId: '',
    id: '',
    accountId: '',
    transport: 'forward-websocket',
    url: '',
    accessTokenEnv: ''
  })
  conversations.value = [{ kind: 'group', conversationId: '' }]
  Object.assign(agent, { id: '', personaMode: 'existing', personaId: 'default' })
  newPersona.value = { id: '', name: '' }
  reviewed.value = false
}
watch(
  draftSignature,
  () => {
    reviewed.value = false
    session.invalidatePreview()
  },
  { flush: 'sync' }
)
watch(
  () => props.show,
  (value) => {
    if (value && !catalog.value) void session.loadCatalog()
    if (!value) session.cancelReads()
  },
  { immediate: true }
)
watch(
  () => consoleRestart.state.reloadGeneration,
  () => {
    session.processReloaded()
    reviewed.value = false
    if (props.show) void session.loadCatalog()
  }
)
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  session.dispose()
})
</script>
<template>
  <NDrawer
    :show="show"
    placement="right"
    width="min(880px, 100vw)"
    :mask-closable="!committing"
    :close-on-esc="!committing"
    @update:show="
      (value) => {
        if (!value) requestClose()
      }
    "
  >
    <NDrawerContent
      :title="title"
      :closable="!committing"
      :native-scrollbar="false"
      body-content-class="configuration-drawer-body"
    >
      <div class="configuration-onboarding page-stack">
        <NAlert type="info" :show-icon="false"
          >{{
            isConnection
              ? 'QQ 账号是本人的连接。只添加这里明确填写的会话，不复制其他账号的群列表或工具授权。'
              : '本人使用稳定标识保存归属。已有模板可以复用；新人设草稿与本人一并预览和提交。'
          }}保存后重启服务生效。</NAlert
        >
        <NAlert v-if="availability && !terminal" type="warning" :show-icon="false">{{
          availability.reason
        }}</NAlert>
        <div class="toolbar">
          <NButton
            :loading="loading"
            :disabled="
              busy ||
              consoleRestart.blocked.value ||
              capability('configuration.read').status !== 'available'
            "
            @click="session.loadCatalog"
            >{{ terminal ? '读取重启后配置' : '重新读取配置' }}</NButton
          >
          <NTag v-if="catalog" size="small">配置已核对</NTag>
        </div>
        <NAlert
          v-if="error"
          :type="issue === 'unknown' || issue === 'recovery' ? 'warning' : 'error'"
          :show-icon="false"
          role="status"
          >{{ error }}</NAlert
        >
        <NAlert v-if="issue === 'saved' && receipt" type="success" :show-icon="false">
          配置已保存，{{
            canStartAnother ? '已核对新进程配置。' : '等待重启后加载。当前工作区仍展示已加载配置。'
          }}
          <p class="candidate-source">事务 {{ receipt.transactionId }}</p>
        </NAlert>
        <NAlert v-if="terminal && canStartAnother" type="info" :show-icon="false"
          >新进程配置已读取。请核对当前本人和连接，再结束本次操作；系统不会自动补交。<NButton
            size="small"
            @click="startAnother"
            >结束本次并开始新操作</NButton
          ></NAlert
        >
        <form v-if="catalog" class="page-stack" @submit.prevent="previewDraft">
          <fieldset class="configuration-fields" :disabled="editDisabled">
            <template v-if="isConnection">
              <div class="form-field">
                <label for="connection-agent">所属本人</label
                ><NSelect
                  :input-props="{ id: 'connection-agent' }"
                  :value="connection.agentId"
                  :options="agentOptions"
                  :disabled="editDisabled"
                  aria-label="连接所属本人"
                  @update:value="connection.agentId = $event"
                />
              </div>
              <p v-if="!agentOptions.length" class="field-help">尚无本人，请先到机器人列表创建。</p>
              <div class="field-grid">
                <div class="form-field">
                  <label for="new-connection-id">连接标识</label
                  ><NInput
                    id="new-connection-id"
                    v-model:value="connection.id"
                    :disabled="editDisabled"
                    aria-label="新连接标识"
                    placeholder="例如 qq-second"
                  />
                </div>
                <div class="form-field">
                  <label for="new-connection-account">QQ 账号</label
                  ><NInput
                    id="new-connection-account"
                    v-model:value="connection.accountId"
                    :disabled="editDisabled"
                    aria-label="新增 QQ 账号"
                  />
                </div>
                <div class="form-field">
                  <label>连接方式</label
                  ><NSelect
                    v-model:value="connection.transport"
                    :disabled="editDisabled"
                    aria-label="OneBot 连接方式"
                    :options="[
                      { value: 'forward-websocket', label: '正向 WebSocket' },
                      { value: 'reverse-websocket', label: '反向 WebSocket 监听' }
                    ]"
                  />
                </div>
                <div class="form-field">
                  <label for="new-connection-token">令牌环境变量名称</label
                  ><NInput
                    id="new-connection-token"
                    v-model:value="connection.accessTokenEnv"
                    :disabled="editDisabled"
                    aria-label="令牌环境变量名称"
                    placeholder="填写变量名，不填写令牌值"
                  />
                </div>
              </div>
              <div class="form-field">
                <label for="new-connection-url">WebSocket 地址</label
                ><NInput
                  id="new-connection-url"
                  v-model:value="connection.url"
                  :disabled="editDisabled"
                  aria-label="WebSocket 地址"
                  placeholder="ws://127.0.0.1:3001"
                />
              </div>
              <p class="field-help">
                令牌从服务环境读取。反向连接须填写令牌环境变量名；预览会核对候选配置。
              </p>
              <section class="panel">
                <div class="panel-heading">
                  <h3>明确绑定的会话</h3>
                  <NButton
                    size="small"
                    :disabled="editDisabled || conversations.length >= 64"
                    @click="conversations.push({ kind: 'group', conversationId: '' })"
                    >添加会话</NButton
                  >
                </div>
                <div
                  v-for="(row, index) in conversations"
                  :key="index"
                  class="configuration-conversation"
                >
                  <NSelect
                    v-model:value="row.kind"
                    :disabled="editDisabled"
                    :aria-label="`会话 ${index + 1} 类型`"
                    :options="[
                      { value: 'group', label: '群聊' },
                      { value: 'private', label: '好友私聊' }
                    ]"
                  />
                  <NInput
                    v-model:value="row.conversationId"
                    :disabled="editDisabled"
                    :aria-label="`会话 ${index + 1} 编号`"
                    :placeholder="row.kind === 'group' ? '群号' : '好友 QQ 号'"
                  />
                  <NButton
                    size="small"
                    :disabled="editDisabled || conversations.length <= 1"
                    :aria-label="`移除会话 ${index + 1}`"
                    @click="conversations.splice(index, 1)"
                    >移除</NButton
                  >
                </div>
              </section>
            </template>
            <template v-else>
              <div class="form-field">
                <label for="new-agent-id">本人标识</label
                ><NInput
                  id="new-agent-id"
                  v-model:value="agent.id"
                  :disabled="editDisabled"
                  aria-label="新本人标识"
                  placeholder="例如 research"
                /><small class="field-help">建立后保持稳定。它区分不同本人，不是可编辑姓名。</small>
              </div>
              <div class="form-field">
                <label>人设来源</label
                ><NSelect
                  v-model:value="agent.personaMode"
                  :disabled="editDisabled"
                  aria-label="新人设来源"
                  :options="[
                    { value: 'existing', label: '复用已有模板' },
                    { value: 'new', label: '创建新模板' }
                  ]"
                />
              </div>
              <div v-if="agent.personaMode === 'existing'" class="form-field">
                <label>人设模板</label
                ><NSelect
                  v-model:value="agent.personaId"
                  :disabled="editDisabled"
                  aria-label="复用人设模板"
                  :options="personaOptions"
                />
              </div>
              <section v-else class="panel page-stack">
                <div class="field-grid">
                  <div class="form-field">
                    <label for="new-persona-id">模板标识</label
                    ><NInput
                      id="new-persona-id"
                      v-model:value="newPersona.id"
                      :disabled="editDisabled"
                      aria-label="新模板标识"
                    />
                  </div>
                  <div class="form-field">
                    <label for="new-persona-name">人设名称</label
                    ><NInput
                      id="new-persona-name"
                      v-model:value="newPersona.name"
                      :disabled="editDisabled"
                      aria-label="新人设名称"
                    />
                  </div>
                </div>
                <p class="field-help">未填写的可选字段继承默认人设；填写空值会覆盖默认内容。</p>
                <details>
                  <summary>人设内容</summary>
                  <div class="page-stack configuration-persona-fields" :inert="editDisabled">
                    <div v-for="field in fields" :key="field.field">
                      <SchemaField
                        :field="field"
                        :model-value="newPersona[field.field]"
                        apply-hint="与本人一并预览，提交后重启生效"
                        @update:model-value="(value) => (newPersona[field.field] = value)"
                      />
                      <NButton
                        v-if="newPersona[field.field] !== undefined"
                        text
                        size="tiny"
                        :disabled="editDisabled"
                        @click="delete newPersona[field.field]"
                        >恢复继承</NButton
                      >
                    </div>
                  </div>
                </details>
              </section>
            </template>
          </fieldset>
          <p v-if="validation && !terminal" class="field-help" role="status">{{ validation }}</p>
          <NButton
            v-if="!terminal"
            type="primary"
            :loading="previewing"
            :disabled="!!validation || editDisabled || loading || requiresRead"
            attr-type="submit"
            >生成服务端预览</NButton
          >
        </form>
        <ConfigurationCandidatePreview
          v-if="preview"
          :value="preview"
          :expired="expired && !terminal"
        />
        <section v-if="preview && !terminal" class="configuration-submit panel">
          <label class="configuration-review"
            ><input
              v-model="reviewed"
              type="checkbox"
              :disabled="editDisabled || expired"
            />我已核对字段差异、完整来源与权限影响，确认保存并在重启后生效。</label
          >
          <NButton
            type="primary"
            :loading="committing"
            :disabled="!reviewed || expired || editDisabled || busy"
            @click="session.commit"
            >确认提交此候选</NButton
          >
        </section>
      </div>
      <template #footer
        ><NButton :disabled="committing" @click="requestClose">{{
          dirty && !terminal ? '收起并保留草稿' : '关闭'
        }}</NButton></template
      >
    </NDrawerContent>
  </NDrawer>
</template>
