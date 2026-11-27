<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NSelect } from 'naive-ui'
import { api } from '../lib/api'
import { capability } from '../lib/workspace'

const props = defineProps<{ connectionId: string }>()
const modes = [
  { label: '私聊和群聊', value: 'both' },
  { label: '只回私聊', value: 'private' },
  { label: '只回群聊', value: 'group' }
]
const listFields = [
  { key: 'allowUserIds', label: '成员白名单' },
  { key: 'denyUserIds', label: '成员黑名单' },
  { key: 'allowGroupIds', label: '群聊白名单' },
  { key: 'denyGroupIds', label: '群聊黑名单' }
] as const
type ListField = (typeof listFields)[number]['key']
type Scope = { mode: 'both' | 'private' | 'group'; requireMention: boolean }
type ReplyPolicy = Scope & Record<ListField, string[]>
type Draft = Scope & Record<ListField, string>
type Rules = { revision: string; privateChatEnabled: boolean; replyPolicy: ReplyPolicy }

const show = ref(false)
const draft = ref<Draft>()
const current = shallowRef<Rules>()
const loading = ref(false), saving = ref(false), saved = ref(false), needsRead = ref(false), error = ref('')
const canRead = computed(() => capability('dingtalk-reply-policy.read').status === 'available')
const canSave = computed(() => capability('dingtalk-reply-policy.write').status === 'available')
const busy = computed(() => loading.value || saving.value)
const disabled = computed(() => busy.value || !canSave.value || needsRead.value)
const path = computed(() => `/api/connections/${encodeURIComponent(props.connectionId)}/dingtalk-reply-policy`)
let reading: AbortController | undefined

function parsePolicy(input: unknown): ReplyPolicy | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const { mode, requireMention, allowUserIds, denyUserIds, allowGroupIds, denyGroupIds } = input as Record<string, unknown>
  if (Object.keys(input).length !== 6 || (mode !== 'both' && mode !== 'private' && mode !== 'group') || typeof requireMention !== 'boolean') return
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 &&
    value.every(id => typeof id === 'string' && id !== '0' && /^[A-Za-z0-9_@.$=+/-]{1,128}$/u.test(id)) && new Set(value).size === value.length
  if (!ids(allowUserIds) || !ids(denyUserIds) || !ids(allowGroupIds) || !ids(denyGroupIds)) return
  return { mode, requireMention, allowUserIds, denyUserIds, allowGroupIds, denyGroupIds }
}

const edited = computed(() => {
  if (!draft.value) return
  const { mode, requireMention, ...lists } = draft.value
  const ids = Object.fromEntries(listFields.map(({ key }) => [key, lists[key].split(/[\r\n,，]/u).map(id => id.trim()).filter(Boolean)]))
  return parsePolicy({ mode, requireMention, ...ids })
})
const changed = computed(() => !!current.value && !!draft.value &&
  JSON.stringify(current.value.replyPolicy) !== JSON.stringify(edited.value))

function updateView(input: unknown) {
  const value = input as Record<string, unknown> | undefined
  const policy = parsePolicy(value?.replyPolicy)
  if (value?.connectionId !== props.connectionId || typeof value.revision !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(value.revision) || typeof value.privateChatEnabled !== 'boolean' || !policy) {
    throw new Error('无法核对钉钉回复规则，请重新读取。')
  }
  current.value = { revision: value.revision, privateChatEnabled: value.privateChatEnabled, replyPolicy: policy }
  draft.value = { mode: policy.mode, requireMention: policy.requireMention, allowUserIds: policy.allowUserIds.join('\n'),
    denyUserIds: policy.denyUserIds.join('\n'), allowGroupIds: policy.allowGroupIds.join('\n'), denyGroupIds: policy.denyGroupIds.join('\n') }
  needsRead.value = false
}

async function load() {
  if (busy.value || !canRead.value) return
  const controller = (reading = new AbortController())
  loading.value = true
  error.value = ''
  saved.value = false
  try {
    const value = await api<unknown>(path.value, { signal: controller.signal })
    if (!controller.signal.aborted) updateView(value)
  } catch (cause) {
    if (!controller.signal.aborted) {
      needsRead.value = true
      error.value = (cause as Error).message || '暂时无法读取回复规则。'
    }
  } finally {
    if (reading === controller) { reading = undefined; loading.value = false }
  }
}
function open() {
  show.value = true
  if (!changed.value || needsRead.value) void load()
}
function setShow(value: boolean) {
  if (value || saving.value) return
  cancelRead()
  show.value = false
}
function cancelRead() {
  reading?.abort()
  reading = undefined
  loading.value = false
}
async function save() {
  const policy = edited.value, revision = current.value?.revision
  if (!policy || !revision || !changed.value || disabled.value) return
  saving.value = true
  error.value = ''
  saved.value = false
  try {
    updateView(await api<unknown>(path.value, { method: 'PUT', body: JSON.stringify({ revision, replyPolicy: policy }) }))
    saved.value = true
  } catch (cause) {
    const status = (cause as { status?: number })?.status
    needsRead.value = status !== 400
    error.value = status === 409 ? '回复规则已有新版本。请重新读取规则后再编辑。' :
      status === 400 ? '请核对回复范围和名单。' : '保存结果待核对，请重新读取规则。'
  } finally { saving.value = false }
}
onScopeDispose(cancelRead)
</script>

<template>
  <NButton v-if="canRead" size="small" @click="open">回复规则</NButton>
  <NModal :show="show" preset="card" title="钉钉回复规则" :style="{ width: 'min(650px, 94vw)' }"
    :mask-closable="!saving" :close-on-esc="!saving" :closable="!saving" @update:show="setShow">
    <div class="page-stack">
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <NAlert v-if="saved && !changed" type="success" role="status">回复规则已生效。</NAlert>
      <p v-if="loading && !draft" role="status">正在读取回复规则…</p>
      <template v-if="draft">
        <label>回复范围<NSelect v-model:value="draft.mode" aria-label="回复范围" :options="modes" :disabled="disabled" /></label>
        <NAlert v-if="draft.mode !== 'group' && current?.privateChatEnabled === false" type="warning">
          私聊回复需要在宿主启用 privateChat.enabled，并绑定对应成员的私聊。
        </NAlert>
        <NCheckbox v-model:checked="draft.requireMention" :disabled="disabled || draft.mode === 'private'">
          群聊只回复 @ 本机器人
        </NCheckbox>
        <p v-if="draft.mode !== 'private' && !draft.requireMention" class="field-help">
          机器人可回复钉钉实际投递的普通群消息。群内哪些消息能收到，由钉钉的事件投递范围决定。
        </p>
        <p class="field-help">只处理已绑定会话。名单用成员 Staff ID 或群 Open Conversation ID，每行一个，可用逗号分隔。白名单留空时全员或全部已绑定群可通过该项，黑名单优先。</p>
        <label v-for="{ key, label } in listFields" :key="key">
          {{ label }}
          <NInput v-model:value="draft[key]" type="textarea" :input-props="{ 'aria-label': label }" :autosize="{ minRows: 2, maxRows: 5 }"
            :disabled="disabled || (draft.mode === 'private' && (key === 'allowGroupIds' || key === 'denyGroupIds'))" />
        </label>
        <p v-if="!edited" class="field-help" role="status">请填写有效的钉钉 ID。每个名单最多 256 项，同一名单内的 ID 须唯一。</p>
        <NButton v-if="canSave && !needsRead" type="primary" :loading="saving" :disabled="disabled || !changed || !edited" @click="save">
          保存规则
        </NButton>
      </template>
      <NButton v-if="needsRead && canRead" :loading="loading" :disabled="busy" @click="load">重新读取规则</NButton>
    </div>
  </NModal>
</template>
