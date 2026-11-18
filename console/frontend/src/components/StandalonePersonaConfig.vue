<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NSelect, NTab, NTabs } from 'naive-ui'
import { api } from '../lib/api'
import { consoleRestart, type ConfigSaveResult } from '../lib/consoleRestart'
import type {
  StandaloneAssignmentView,
  StandaloneLibraryView as LibraryView
} from '../lib/standaloneConfig'
import { clone, equal, validateField, type SchemaFieldDefinition } from '../lib/schemaState'
import { clientId } from '../lib/clientId'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import SaveBar from './SaveBar.vue'
import SchemaField from './SchemaField.vue'
import SchemaPage from '../pages/SchemaPage.vue'
import { workspace } from '../lib/workspace'
import { robotLabel, robotLocation } from '../lib/workspaceModel'
const restartBlocked = consoleRestart.blocked
interface Persona {
  id: string
  name: string
  [key: string]: any
}
const props = defineProps<{ initial: LibraryView }>()
const view = ref(clone(props.initial)),
  draft = ref(clone(props.initial.personas))
const tab = ref('library'),
  defaultsOpened = ref(false),
  selectedId = ref(props.initial.personas[0]?.id || '')
const assignments = ref<StandaloneAssignmentView | null>(null)
const agentDraft = ref<{ agentId: string; personaId: string }[]>([])
const error = ref(''),
  saved = ref(''),
  saving = ref(false),
  loadingAssignments = ref(false)
const controllers = new Set<AbortController>()
const selected = computed(() => draft.value.find((item) => item.id === selectedId.value))
const affectedRobots = computed(
  () => workspace.data.value?.agents.filter((agent) => agent.personaId === selectedId.value) ?? []
)
const robotName = (id: string) => {
  const agents = workspace.data.value?.agents ?? [],
    agent = agents.find((agent) => agent.id === id)
  return agent ? robotLabel(agent, agents) : '机器人'
}
const templateDirty = computed(() => (equal(draft.value, view.value.personas) ? 0 : 1))
const assignmentRows = (value: StandaloneAssignmentView) =>
  value.agents.map(({ agentId, personaId }) => ({ agentId, personaId }))
const assignmentDirty = computed(() =>
  assignments.value && !equal(agentDraft.value, assignmentRows(assignments.value)) ? 1 : 0
)
const dirty = computed(() =>
  tab.value === 'assignments' ? assignmentDirty.value : templateDirty.value
)
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
      { field: 'hint', label: '提示', component: 'InputTextArea', required: true },
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
const validation = computed(() => {
  if (tab.value === 'assignments') return ''
  const names = new Set<string>()
  for (const item of draft.value) {
    const name = item.name.trim().toLowerCase()
    if (!name || names.has(name)) return '人设名字不能为空或重复'
    names.add(name)
    for (const field of fields) {
      if (item[field.field] !== undefined) {
        const failures = validateField(field, item[field.field])
        if (failures.length) return failures[0]
      }
    }
  }
  return ''
})
useUnsavedGuard(() => !!templateDirty.value || !!assignmentDirty.value || saving.value)
function add() {
  if (consoleRestart.blocked.value) return
  const id = `persona-${clientId()}`
  draft.value.push({ id, name: '新人设' })
  selectedId.value = id
}
function remove() {
  if (consoleRestart.blocked.value || !selected.value) return
  draft.value = draft.value.filter((item) => item.id !== selectedId.value)
  selectedId.value = draft.value[0]?.id || ''
}
function editField(field: string, value: unknown) {
  if (selected.value && !consoleRestart.blocked.value) selected.value[field] = value
}
function inheritField(field: string) {
  if (selected.value && !consoleRestart.blocked.value) delete selected.value[field]
}
function assignAgent(agentId: string, value: string) {
  const row = agentDraft.value.find((item) => item.agentId === agentId)
  if (row && !consoleRestart.blocked.value) row.personaId = value
}
function rebaseTemplates(next: LibraryView) {
  const local = draft.value,
    old = view.value.personas
  const merged = next.personas
    .map((item) => {
      const previous = old.find((row) => row.id === item.id),
        edited = local.find((row) => row.id === item.id)
      if (!previous || !edited) return clone(item)
      const result = clone(item)
      for (const key of new Set([...Object.keys(previous), ...Object.keys(edited)])) {
        if (equal(previous[key], edited[key])) continue
        if (key in edited) result[key] = clone(edited[key])
        else delete result[key]
      }
      return result
    })
    .filter(
      (item) => !old.some((row) => row.id === item.id) || local.some((row) => row.id === item.id)
    )
  local
    .filter(
      (item) =>
        !next.personas.some((row) => row.id === item.id) &&
        (!old.some((row) => row.id === item.id) ||
          !equal(
            item,
            old.find((row) => row.id === item.id)
          ))
    )
    .forEach((item) => merged.push(clone(item)))
  draft.value = merged
  view.value = clone(next)
}
async function loadAssignments(preserve = false) {
  if (consoleRestart.blocked.value || loadingAssignments.value) return
  loadingAssignments.value = true
  error.value = ''
  try {
    const next = await api<StandaloneAssignmentView>('/api/persona/assignments')
    const old = assignments.value
    agentDraft.value = assignmentRows(next).map((row) => {
      const local = agentDraft.value.find((item) => item.agentId === row.agentId)
      const previous = old?.agents.find((item) => item.agentId === row.agentId)
      return preserve && local && previous && local.personaId !== previous.personaId
        ? clone(local)
        : row
    })
    assignments.value = next
  } catch (cause: any) {
    if (cause.name !== 'AbortError') error.value = cause.message || '分配列表加载失败'
  } finally {
    loadingAssignments.value = false
  }
}
function switchTab(value: string) {
  tab.value = value
  if (value === 'default') defaultsOpened.value = true
  if (value === 'assignments' && !assignments.value) void loadAssignments()
}
async function save() {
  if (!dirty.value || saving.value || consoleRestart.blocked.value || validation.value) return
  const assignment = tab.value === 'assignments'
  const controller = new AbortController()
  controllers.add(controller)
  saving.value = true
  error.value = ''
  try {
    if (assignment && assignments.value) {
      const result = await api<ConfigSaveResult<StandaloneAssignmentView>>(
        '/api/persona/assignments',
        {
          method: 'PUT',
          signal: controller.signal,
          body: JSON.stringify({
            revision: assignments.value.revision,
            agents: clone(agentDraft.value)
          })
        }
      )
      assignments.value = result.view
      agentDraft.value = assignmentRows(result.view)
      saved.value = result.requiresRestart ? '分配已保存，重启服务后生效' : '分配没有变化'
    } else {
      const result = await api<ConfigSaveResult<LibraryView>>('/api/persona/library', {
        method: 'PUT',
        signal: controller.signal,
        body: JSON.stringify({ revision: view.value.revision, personas: clone(draft.value) })
      })
      view.value = result.view
      draft.value = clone(result.view.personas)
      saved.value = result.requiresRestart ? '模板已保存，重启服务后生效' : '模板没有变化'
    }
  } catch (cause: any) {
    error.value =
      consoleRestart.state.phase === 'uncertain'
        ? '保存结果待核对，请勿重复保存；草稿已保留'
        : cause.message || '保存失败，草稿已保留'
  } finally {
    saving.value = false
    controllers.delete(controller)
  }
}
function discard() {
  if (tab.value === 'assignments' && assignments.value)
    agentDraft.value = assignmentRows(assignments.value)
  else draft.value = clone(view.value.personas)
}
watch(
  () => consoleRestart.state.reloadGeneration,
  async () => {
    try {
      rebaseTemplates(await api<LibraryView>('/api/persona/library'))
      if (assignments.value) await loadAssignments(true)
    } catch (cause: any) {
      error.value = cause.message || '重启后配置加载失败'
    }
  }
)
onBeforeUnmount(() => controllers.forEach((controller) => controller.abort()))
</script>
<template>
  <div class="page-stack standalone-persona-config" :inert="restartBlocked">
    <NAlert type="info" :show-icon="false"
      >模板和机器人
      分配分别保存。每次保存后重启服务，再进行下一次保存；默认人设在独立配置页编辑。</NAlert
    >
    <NTabs :value="tab" type="line" @update:value="switchTab"
      ><NTab name="library">人设模板</NTab><NTab name="assignments">机器人分配</NTab
      ><NTab name="default">默认人设</NTab></NTabs
    >
    <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
    <div v-show="tab === 'library'" class="page-stack">
      <div class="template-actions">
        <NButton :disabled="restartBlocked" @click="add">新建人设</NButton
        ><NSelect
          v-model:value="selectedId"
          :options="draft.map((item) => ({ label: item.name, value: item.id }))"
          :disabled="restartBlocked"
          aria-label="选择人设模板"
        />
      </div>
      <section v-if="selected" class="panel template-editor">
        <div class="panel-heading">
          <h2>{{ selected.name }}</h2>
          <NButton type="error" :disabled="restartBlocked" @click="remove">删除模板</NButton>
        </div>
        <details class="technical-details">
          <summary>模板技术标识</summary>
          <code>{{ selected.id }}</code>
        </details>
        <div class="template-impact">
          <strong>当前引用此模板的机器人</strong>
          <div class="tag-list">
            <RouterLink
              v-for="agent in affectedRobots"
              :key="agent.id"
              :to="robotLocation(agent)"
              >{{ robotLabel(agent, workspace.data.value?.agents ?? []) }}</RouterLink
            ><span v-if="!affectedRobots.length" class="muted">{{
              workspace.data.value
                ? '当前可见范围内没有机器人引用此模板。'
                : '请在机器人工作区核对实际引用。'
            }}</span>
          </div>
          <p class="field-help">
            模板是可复用资源。保存会影响引用它的机器人，重启后生效；已有经历不会因此合并。被引用的模板不能删除。
          </p>
        </div>
        <p class="field-help">未自定义的字段继承默认人设，自定义空值会覆盖默认内容。</p>
        <div class="form-field">
          <label for="template-name">人设名字</label
          ><NInput id="template-name" v-model:value="selected.name" :disabled="restartBlocked" />
        </div>
        <div class="field-grid">
          <div v-for="field in fields" :key="field.field" class="template-field">
            <div class="inherit-control">
              <span>{{ selected[field.field] === undefined ? '继承默认人设' : '已自定义' }}</span>
              <NButton
                v-if="selected[field.field] !== undefined"
                text
                size="tiny"
                :disabled="restartBlocked"
                @click="inheritField(field.field)"
                >恢复继承</NButton
              >
            </div>
            <SchemaField
              :field="field"
              :model-value="selected[field.field]"
              apply-hint="保存后重启服务生效"
              @update:model-value="(value) => editField(field.field, value)"
            />
          </div>
        </div>
      </section>
      <p v-else class="muted">尚无人设模板，可新建模板或使用全局默认人设。</p>
    </div>
    <div v-show="tab === 'assignments'" class="page-stack">
      <p v-if="loadingAssignments">正在加载机器人分配…</p>
      <section
        v-for="agent in assignments?.agents || []"
        :key="agent.agentId"
        class="panel agent-assignment"
      >
        <h2>{{ robotName(agent.agentId) }}</h2>
        <details class="technical-details">
          <summary>技术详情</summary>
          <code>agentId · {{ agent.agentId }}</code>
        </details>
        <div v-for="target in agent.targets" :key="target.scopeKey" class="assignment-target">
          <span
            >{{ target.connectionId }} · {{ target.target.account.platform }}/{{
              target.target.account.namespace
            }}/{{ target.target.account.id }}</span
          >
          <strong>{{ target.target.kind }} · {{ target.target.id }}</strong>
        </div>
        <NSelect
          :value="agentDraft.find((item) => item.agentId === agent.agentId)?.personaId"
          :options="assignments?.personas.map((item) => ({ label: item.name, value: item.id }))"
          :disabled="restartBlocked"
          :aria-label="`${robotName(agent.agentId)} 人设`"
          @update:value="(value) => assignAgent(agent.agentId, value)"
        />
      </section>
    </div>
    <div v-show="tab === 'default'">
      <SchemaPage v-if="defaultsOpened" kind="persona" embedded />
    </div>
    <p v-if="dirty && validation" role="status">{{ validation }}</p>
    <SaveBar
      v-if="tab !== 'default'"
      :dirty="dirty"
      :saving="saving"
      :saved="saved"
      :disabled="restartBlocked || !!validation || loadingAssignments"
      @save="save"
      @discard="discard"
    />
  </div>
</template>
<style scoped>
.template-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.template-actions .n-select {
  max-width: 360px;
}
.template-editor,
.agent-assignment {
  padding: 22px;
}
.assignment-target {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 0;
  font-size: 12px;
}
.assignment-target span {
  color: var(--c-muted);
}
.template-field {
  grid-column: 1 / -1;
}
.inherit-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--c-muted);
  font-size: 11px;
}
</style>
