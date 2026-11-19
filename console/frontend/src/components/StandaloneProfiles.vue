<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NPagination, NTag, useDialog, useMessage } from 'naive-ui'
import { api } from '../lib/api'
import { workspace, capability } from '../lib/workspace'
import { consoleRestart } from '../lib/consoleRestart'
import {
  accountLabel,
  conversationLabel,
  conversationSourceLabel,
  type WorkspaceConversation
} from '../lib/workspaceModel'
import PageHeader from './PageHeader.vue'
import PageState from './PageState.vue'
import ForgetReceipt from './ForgetReceipt.vue'
import { forgetRequestId, useForgetReceipt } from '../lib/forgetReceipt'
interface Scene {
  kind: 'group' | 'private'
  id: string
  peerId?: string
}
interface Entry {
  id: string
  category: string
  text: string
  evidenceKind: string
  source: { scene: Scene; authorId: string; messageId: string; at: number; excerpt: string }
}
interface Profile {
  userId: string
  identity: { botId: string; personaId: string }
  sourceScene: Scene
  entries: Entry[]
  scopeKey: string
  bindingToken: string
}
const props = defineProps<{ conversationScopes?: WorkspaceConversation[]; embedded?: boolean }>()
const rows = ref<Profile[] | null>(null),
  loading = ref(false),
  error = ref(''),
  query = ref(''),
  page = ref(1),
  busy = ref(false),
  uncertain = ref(false)
const forgetting = useForgetReceipt()
const dialog = useDialog()
const message = useMessage()
let alive = true,
  sequence = 0,
  controller: AbortController | undefined
const categories: Record<string, string> = {
  name: '称呼',
  interest: '兴趣',
  preference: '偏好',
  fact: '事实',
  event: '事件',
  relationship: '关系',
  impression: '印象'
}
const evidence: Record<string, string> = { self: '本人自述', reported: '转述', inferred: '推测' }
const scenes = computed(
  () =>
    props.conversationScopes ??
    workspace.data.value?.agents.flatMap((item) => item.conversations) ??
    []
)
const sceneFor = (row: Profile) =>
  scenes.value.find(
    (scene) => scene.scopeKey === row.scopeKey && scene.bindingToken === row.bindingToken
  )
const sourceVersion = computed(() =>
  JSON.stringify([
    consoleRestart.state.reloadGeneration,
    scenes.value.map((row) => [row.scopeKey, row.bindingToken])
  ])
)
const filtered = computed(
  () =>
    rows.value
      ?.filter((row) => !!sceneFor(row))
      .filter((row) =>
        `${row.userId} ${row.entries.map((entry) => entry.text + ' ' + entry.category).join(' ')}`
          .toLowerCase()
          .includes(query.value.toLowerCase())
      ) ?? []
)
const visible = computed(() => filtered.value.slice((page.value - 1) * 10, page.value * 10))
const canWrite = (operation: string, scopeKey?: string) =>
  capability(operation, scopeKey).status === 'available' &&
  !loading.value &&
  !error.value &&
  !busy.value &&
  !uncertain.value
function parse(value: unknown): Profile[] {
  const payload = value as { profiles?: Profile[] }
  if (!payload || !Array.isArray(payload.profiles) || payload.profiles.length > 10000)
    throw new Error('人物记忆响应不完整')
  for (const row of payload.profiles) {
    if (
      !row ||
      typeof row.userId !== 'string' ||
      !row.userId ||
      typeof row.scopeKey !== 'string' ||
      typeof row.bindingToken !== 'string' ||
      !row.identity ||
      typeof row.identity.botId !== 'string' ||
      typeof row.identity.personaId !== 'string' ||
      !row.sourceScene ||
      !['group', 'private'].includes(row.sourceScene.kind) ||
      typeof row.sourceScene.id !== 'string' ||
      !Array.isArray(row.entries) ||
      row.entries.length > 10000
    )
      throw new Error('人物记忆缺少完整来源，请刷新核对')
    for (const entry of row.entries)
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        !Object.hasOwn(categories, entry.category) ||
        typeof entry.text !== 'string' ||
        !entry.source ||
        !entry.source.scene ||
        !['group', 'private'].includes(entry.source.scene.kind) ||
        typeof entry.source.scene.id !== 'string' ||
        typeof entry.source.authorId !== 'string' ||
        typeof entry.source.messageId !== 'string' ||
        !Number.isFinite(entry.source.at) ||
        typeof entry.source.excerpt !== 'string'
      )
        throw new Error('人物记忆条目或来源不完整')
  }
  return payload.profiles
}
async function load() {
  if (busy.value) return
  const ticket = ++sequence
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = parse(await api('/api/person-profiles', { signal: controller.signal }))
    if (ticket !== sequence || controller.signal.aborted) return
    rows.value = result.filter((row) => !!sceneFor(row))
    uncertain.value = false
  } catch (cause) {
    if (ticket === sequence && !controller.signal.aborted)
      error.value = (cause as Error).message || '人物记忆暂时不可用'
  } finally {
    if (ticket === sequence) loading.value = false
  }
}
function erase(row: Profile, entry?: Entry) {
  const operation = entry ? 'profiles.delete-field' : 'profiles.delete'
  if (!canWrite(operation, row.scopeKey)) return
  const selected = sceneFor(row),
    ticket = sequence
  if (!selected) return
  dialog.warning({
    title: entry ? '删除这条人物记忆' : '清空当前来源会话的人物记忆',
    content: `仅删除 ${conversationSourceLabel(selected)} 中关于 ${row.userId} 的${entry ? '这一条记录' : '人物记录'}。其他来源会话的记录不在本次删除范围内。`,
    positiveText: '删除',
    negativeText: '保留',
    onPositiveClick: async () => {
      if (!alive) return
      if (ticket !== sequence || sceneFor(row) !== selected) {
        message.warning('列表已更新，请核对当前来源后重新操作。')
        return
      }
      if (!canWrite(operation, row.scopeKey)) return
      busy.value = true
      error.value = ''
      try {
        const result = await api(entry ? '/api/person-profiles/delete-field' : '/api/person-profiles/delete', {
          method: 'POST',
          body: JSON.stringify({
            userId: row.userId,
            scopeKey: row.scopeKey,
            bindingToken: row.bindingToken,
            requestId: forgetRequestId(),
            ...(entry ? { field: 'entries', value: entry.id } : {})
          })
        })
        forgetting.capture(result, { scopeKey: row.scopeKey, bindingToken: row.bindingToken,
          isCurrent: () => alive && !!sceneFor(row) })
        if (ticket === sequence) {
          busy.value = false
          await load()
        }
      } catch (cause) {
        if (ticket === sequence) {
          const status = (cause as { status?: number }).status
          uncertain.value = !status || ![400, 401, 403, 422].includes(status)
          error.value = uncertain.value
            ? '删除结果待核对，请勿重复删除。请重新读取来源会话后确认。'
            : (cause as Error).message
        }
      } finally {
        if (ticket === sequence) busy.value = false
      }
    }
  })
}
const entryPages = ref<Record<string, number>>({})
const entryKey = (row: Profile) => row.scopeKey + ':' + row.userId
const pageEntries = (row: Profile) =>
  row.entries.slice(
    ((entryPages.value[entryKey(row)] ?? 1) - 1) * 10,
    (entryPages.value[entryKey(row)] ?? 1) * 10
  )
const time = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false })
watch(
  sourceVersion,
  () => {
    forgetting.reset()
    busy.value = false
    uncertain.value = false
    rows.value = null
    entryPages.value = {}
    page.value = 1
    void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  sequence++
  controller?.abort()
})
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="人物记忆"
      description="本人对人物的已有记录，按当前来源会话展示。删除只作用于所选来源，不清空其他会话。"
    />
    <div class="toolbar workspace-filter">
      <NInput
        v-model:value="query"
        placeholder="搜索人物标识、类别或记忆正文"
        aria-label="搜索人物记忆"
        clearable
        @update:value="page = 1"
      /><NButton :loading="loading" :disabled="busy" @click="load">重新读取</NButton>
    </div>
    <PageState
      :loading="loading && !rows"
      :error="error"
      :empty="rows !== null && !filtered.length"
      empty-text="当前可见来源中没有人物记忆。"
      @retry="load"
      ><section v-for="row in visible" :key="entryKey(row)" class="panel">
        <div class="panel-heading">
          <h2>{{ row.userId }}</h2>
          <NButton
            size="small"
            type="error"
            secondary
            :disabled="!canWrite('profiles.delete', row.scopeKey)"
            @click="erase(row)"
            >清空当前来源记录</NButton
          >
        </div>
        <p v-if="sceneFor(row)" class="field-help">
          {{ conversationLabel(sceneFor(row)!) }} · {{ sceneFor(row)!.binding.connectionId }} ·
          {{ accountLabel(sceneFor(row)!.binding.target.account) }}
        </p>
        <p class="field-help">
          来源场景：{{ row.sourceScene.kind === 'group' ? '群聊' : '私聊' }} ·
          {{ row.sourceScene.id }}
        </p>
        <article v-for="entry in pageEntries(row)" :key="entry.id" class="scene-record">
          <div class="panel-heading">
            <div class="tag-list">
              <NTag size="small">{{ categories[entry.category] }}</NTag
              ><NTag size="small">{{ evidence[entry.evidenceKind] || entry.evidenceKind }}</NTag>
            </div>
            <NButton
              size="tiny"
              type="error"
              quaternary
              :disabled="!canWrite('profiles.delete-field', row.scopeKey)"
              @click="erase(row, entry)"
              >删除此条</NButton
            >
          </div>
          <p>{{ entry.text }}</p>
          <blockquote v-if="entry.source.excerpt">{{ entry.source.excerpt }}</blockquote>
          <p class="field-help">
            来源作者 {{ entry.source.authorId }} · 消息 {{ entry.source.messageId }} ·
            {{ time(entry.source.at) }}
          </p>
          <details class="technical-details">
            <summary>条目标识与来源</summary>
            <p>ID · {{ entry.id }}</p>
            <p>来源场景 · {{ entry.source.scene.kind }} / {{ entry.source.scene.id }}</p>
          </details>
        </article>
        <NPagination
          v-if="row.entries.length > 10"
          :page="entryPages[entryKey(row)] ?? 1"
          :page-size="10"
          :item-count="row.entries.length"
          @update:page="(value) => (entryPages[entryKey(row)] = value)"
        />
      </section>
      <NPagination
        v-if="filtered.length > 10"
        v-model:page="page"
        :page-size="10"
        :item-count="filtered.length" /></PageState
    ><ForgetReceipt :receipt="forgetting.receipt.value" :error="forgetting.error.value" :loading="forgetting.loading.value" @refresh="forgetting.refresh()" />
    <NAlert v-if="uncertain" type="warning">操作结果未知，已锁定删除；请先重新读取并核对。</NAlert>
  </div>
</template>
