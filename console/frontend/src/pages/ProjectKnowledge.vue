<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NInput, NSelect, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { conversationSourceLabel } from '../lib/workspaceNames'
import type { WorkspaceTarget } from '../lib/workspaceModel'

type Repository = { id: string; remote: string; branch: string; paths: string[] }
type Project = { id: string; name: string; repositories: string[] }
type Grant = { target: WorkspaceTarget; projectId: string; repositories: string[] }
type Catalog = { repositories: Repository[]; projects: Project[]; grants: Grant[] }
type SyncState = { id: string; tracked: string | null; discovered: string | null; files: number; changedFiles: number; memoryCount: number;
  syncedAt: number | null; state: 'new' | 'syncing' | 'ready' | 'failed'; overview?: { text: string; sources: { path: string; line: number }[] } }
type Snapshot = { revision: string; catalog: Catalog; status: SyncState[] }

const snapshot = ref<Snapshot>()
const busy = ref(false)
const error = ref('')
const result = ref('')
const repository = reactive({ id: '', remote: '', branch: 'master', paths: '' })
const project = reactive({ id: '', name: '', repositories: [] as string[] })
const grant = reactive({ scope: '', projectId: '', repositories: [] as string[] })
const stateNames = { new: '待同步', syncing: '同步中', ready: '可用', failed: '同步失败' }
const canWrite = computed(() => capability('project-knowledge.write').status === 'available' && !busy.value)
const canRefresh = computed(() => capability('project-knowledge.refresh').status === 'available' && !busy.value)
const states = computed(() => new Map(snapshot.value?.status.map(row => [row.id, row])))
const repoOptions = computed(() => (snapshot.value?.catalog.repositories ?? []).map(row => ({ label: row.id, value: row.id })))
const projectOptions = computed(() => (snapshot.value?.catalog.projects ?? []).map(row => ({ label: row.name, value: row.id })))
const grantOptions = computed(() => repoOptions.value.filter(row =>
  snapshot.value?.catalog.projects.find(item => item.id === grant.projectId)?.repositories.includes(row.value)))
const conversations = computed(() => (workspace.data.value?.agents ?? []).flatMap(agent => agent.conversations)
  .filter(row => ['group', 'private'].includes(row.binding.target.kind)))
const conversationOptions = computed(() => conversations.value.map(row => ({ label: conversationSourceLabel(row), value: row.scopeKey })))
const addressKey = ({ account, kind, id }: WorkspaceTarget) => JSON.stringify([account.platform, account.namespace, account.id, kind, id])
const showTarget = (target: WorkspaceTarget) => {
  const current = conversations.value.find(row => addressKey(row.binding.target) === addressKey(target))
  return current ? conversationSourceLabel(current) : `${target.account.platform} · ${target.account.id} · ${target.id}`
}
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

async function request(run: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  result.value = ''
  try { await run() } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
const read = () => request(async () => {
  snapshot.value = await api<Snapshot>('/api/project-knowledge')
})
onMounted(async () => {
  try { if (!workspace.data.value) await workspace.load() }
  catch (cause) { error.value = (cause as Error).message; return }
  if (capability('project-knowledge.read').status === 'available') await read()
})
function save(change: (current: Catalog) => Catalog) {
  const current = snapshot.value
  if (!current || !canWrite.value) return Promise.resolve()
  return request(async () => {
    snapshot.value = await api<Snapshot>('/api/project-knowledge', { method: 'PUT',
      body: JSON.stringify({ revision: current.revision, catalog: change(current.catalog) }) })
    result.value = '已保存'
  })
}
function saveRepository() {
  const row = { ...repository, remote: repository.remote.trim(), branch: repository.branch.trim(),
    paths: [...new Set(repository.paths.split(/[\n,，]/).map(word => word.trim()).filter(Boolean))] }
  if (!idPattern.test(row.id) || !row.remote || !row.branch || !row.paths.length) return
  return save(current => ({ ...current, repositories: [...current.repositories.filter(item => item.id !== row.id), row] }))
}
function saveProject() {
  const row = { ...project, name: project.name.trim() }
  if (!idPattern.test(row.id) || !row.name || !row.repositories.length) return
  return save(current => ({ ...current, projects: [...current.projects.filter(item => item.id !== row.id), row] }))
}
function saveGrant() {
  const target = conversations.value.find(row => row.scopeKey === grant.scope)?.binding.target
  if (!target || !grant.projectId || !grant.repositories.length) return
  return save(current => ({ ...current, grants: [...current.grants.filter(item => item.projectId !== grant.projectId ||
    addressKey(item.target) !== addressKey(target)), { target, projectId: grant.projectId, repositories: [...grant.repositories] }] }))
}
function removeGrant(grant: Grant) {
  return save(current => ({ ...current, grants: current.grants.filter(item => item.projectId !== grant.projectId ||
    addressKey(item.target) !== addressKey(grant.target)) }))
}
function sync(id: string) {
  return request(async () => {
    await api('/api/project-knowledge/' + encodeURIComponent(id) + '/refresh', { method: 'POST', body: '{}' })
    snapshot.value = await api<Snapshot>('/api/project-knowledge')
    result.value = '已请求同步'
  })
}
</script>

<template>
  <div class="page-stack">
    <PageHeader title="项目知识库" description="管理云效仓库、同步版本和可查询的会话。">
      <template #actions>
        <NButton :loading="busy" :disabled="capability('project-knowledge.read').status !== 'available'" @click="read">刷新状态</NButton>
      </template>
    </PageHeader>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <NAlert v-if="result" type="success" role="status">{{ result }}</NAlert>
    <NAlert v-if="capability('project-knowledge.read').status !== 'available'" type="info">项目知识库尚未启用，或当前账号无权管理。</NAlert>
    <template v-if="snapshot">
      <section class="panel">
        <div class="panel-heading"><h2>仓库</h2></div>
        <div v-for="row in snapshot.catalog.repositories" :key="row.id" class="workspace-list-row">
          <div>
            <strong>{{ row.id }}</strong>
            <div class="field-help">{{ row.branch }} · {{ row.paths.join('、') }}</div>
            <div v-if="states.has(row.id)" class="field-help">
              <NTag size="small">{{ stateNames[states.get(row.id)!.state] }}</NTag>
              {{ states.get(row.id)?.tracked?.slice(0, 12) || '暂无提交' }}
              · {{ states.get(row.id)?.memoryCount || 0 }} 条库记忆
            </div>
            <div v-if="states.get(row.id)?.discovered && states.get(row.id)?.discovered !== states.get(row.id)?.tracked" class="field-help">
              待发布版本 {{ states.get(row.id)?.discovered?.slice(0, 12) }}
            </div>
            <details v-if="states.get(row.id)?.overview">
              <summary>仓库概览</summary>
              <p>{{ states.get(row.id)?.overview?.text }}</p>
              <p class="field-help">{{ states.get(row.id)?.overview?.sources.map(item => item.path + ':' + item.line).join('、') }}</p>
            </details>
          </div>
          <div class="toolbar">
            <NButton size="small" :disabled="!canWrite" @click="Object.assign(repository, { ...row, paths: row.paths.join('\n') })">编辑</NButton>
            <NButton size="small" :disabled="!canRefresh" @click="sync(row.id)">同步</NButton>
          </div>
        </div>
        <form v-if="capability('project-knowledge.write').status === 'available'" class="knowledge-form" @submit.prevent="saveRepository">
          <label>仓库 ID<NInput v-model:value="repository.id" maxlength="64" placeholder="chaos" /></label>
          <label>云效 Git 地址<NInput v-model:value="repository.remote" maxlength="360" /></label>
          <label>跟踪分支<NInput v-model:value="repository.branch" maxlength="100" /></label>
          <label>允许索引的路径<NInput v-model:value="repository.paths" type="textarea" placeholder="每行一个文件或目录" /></label>
          <NButton attr-type="submit" type="primary" :disabled="!canWrite">保存仓库</NButton>
        </form>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>项目</h2></div>
        <div v-for="row in snapshot.catalog.projects" :key="row.id" class="workspace-list-row">
          <div><strong>{{ row.name }}</strong><div class="field-help">{{ row.repositories.join('、') }}</div></div>
          <NButton size="small" :disabled="!canWrite" @click="Object.assign(project, { ...row, repositories: [...row.repositories] })">编辑</NButton>
        </div>
        <form v-if="capability('project-knowledge.write').status === 'available'" class="knowledge-form" @submit.prevent="saveProject">
          <label>项目 ID<NInput v-model:value="project.id" maxlength="64" /></label>
          <label>项目名称<NInput v-model:value="project.name" maxlength="80" /></label>
          <label>包含的仓库<NSelect v-model:value="project.repositories" multiple :options="repoOptions" /></label>
          <NButton attr-type="submit" type="primary" :disabled="!canWrite">保存项目</NButton>
        </form>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>会话授权</h2></div>
        <div v-for="row in snapshot.catalog.grants" :key="row.projectId + addressKey(row.target)" class="workspace-list-row">
          <div>
            <strong>{{ showTarget(row.target) }}</strong>
            <div class="field-help">{{ row.projectId }} · {{ row.repositories.join('、') }}</div>
          </div>
          <NButton size="small" :disabled="!canWrite" @click="removeGrant(row)">撤销授权</NButton>
        </div>
        <form v-if="capability('project-knowledge.write').status === 'available'" class="knowledge-form" @submit.prevent="saveGrant">
          <label>会话<NSelect v-model:value="grant.scope" filterable :options="conversationOptions" /></label>
          <label>项目<NSelect v-model:value="grant.projectId" :options="projectOptions" @update:value="grant.repositories = []" /></label>
          <label>可查询的仓库<NSelect v-model:value="grant.repositories" multiple :options="grantOptions" /></label>
          <NButton attr-type="submit" type="primary" :disabled="!canWrite">保存授权</NButton>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.knowledge-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 16px;
}
.knowledge-form label { display: grid; gap: 6px; }
.knowledge-form > .n-button { justify-self: start; }
.workspace-list-row { overflow-wrap: anywhere; }
</style>
