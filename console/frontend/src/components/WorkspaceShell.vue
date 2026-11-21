<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { NButton, NInput, NModal, NDrawer, NDrawerContent, NAlert, useMessage } from 'naive-ui'
import {
  Bot,
  Search,
  Menu,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
  ArrowUpRight,
  RefreshCw,
  KeyRound
} from 'lucide-vue-next'
import { api, authState, clearToken } from '../lib/api'
import { workspace } from '../lib/workspace'
import {
  workspaceFeaturePath,
  workspaceFeatures,
  workspaceNavigation,
  type WorkspaceFeature
} from '../lib/navigation'
import { robotLabel, robotLocation } from '../lib/workspaceModel'
import { accountLabel, accountReference, conversationLabel, namedId } from '../lib/workspaceNames'
import { confirmLeave, installUnsavedDialog } from '../composables/useUnsavedGuard'
import { useOpsResource } from '../lib/operations'
import { consoleRestart } from '../lib/consoleRestart'
import WorkspaceNavigation from './WorkspaceNavigation.vue'

defineProps<{ appearance: string }>()
const emit = defineEmits<{ theme: []; logout: [] }>()
const route = useRoute(),
  router = useRouter(),
  message = useMessage()
const data = workspace.data,
  workspaceError = workspace.error,
  loading = workspace.loading
const menuOpen = ref(false),
  expandedSection = ref<string | null>(null),
  searchOpen = ref(false),
  query = ref(''),
  passwordOpen = ref(false),
  passwordBusy = ref(false),
  oldPassword = ref(''),
  newPassword = ref(''),
  passwordError = ref('')
const searchInput = ref<InstanceType<typeof NInput> | null>(null)
const build = __CONSOLE_BUILD__
installUnsavedDialog()
useOpsResource((signal) => workspace.load(signal), 30000)
const sectionLabels = Object.fromEntries(workspaceNavigation.map((item) => [item.path, item.label]))
const currentPath = computed(() => route.path.replace(/\/$/, '') || '/')
const activeFeature = computed<WorkspaceFeature | undefined>(() => {
  const path = currentPath.value
  if (path.startsWith('/robots/')) {
    if (route.params.tab === 'self' && route.query.panel === 'person-profiles')
      return 'person-profiles'
    if (route.params.tab === 'actions' && route.query.panel === 'trusteeship') return 'trusteeship'
  }
  if (path === '/connections' || path.startsWith('/connections/')) return 'groups'
  if (path === '/observe/details') return 'observe'
  const feature = path.slice(1)
  if (Object.hasOwn(workspaceFeatures, feature)) return feature as WorkspaceFeature
})
const active = computed(() => {
  const path = activeFeature.value
    ? workspaceFeatures[activeFeature.value].group
    : currentPath.value
  return (
    workspaceNavigation.find((item) => path === item.path || path.startsWith(item.path + '/')) ??
    workspaceNavigation[0]!
  )
})
const selectedAgent = computed(() =>
  route.path.startsWith('/robots/')
    ? data.value?.agents.find((item) => item.id === route.params.id)
    : undefined
)
const selectedConnection = computed(() =>
  route.path.startsWith('/connections/')
    ? data.value?.connections.find((item) => item.id === route.params.id)
    : undefined
)
const breadcrumbs = computed(() => [
  active.value.label,
  ...(selectedAgent.value ? [robotLabel(selectedAgent.value, data.value?.agents ?? [])] : []),
  ...(selectedConnection.value ? [namedId(selectedConnection.value.id, selectedConnection.value.name)] : []),
  ...(activeFeature.value ? [workspaceFeatures[activeFeature.value].label] : [])
])
function featureTarget(feature: WorkspaceFeature) {
  if ((feature === 'person-profiles' || feature === 'trusteeship') && selectedAgent.value) {
    return {
      path: `/robots/${encodeURIComponent(selectedAgent.value.id)}/${feature === 'person-profiles' ? 'self' : 'actions'}`,
      query: { ...route.query, panel: feature }
    }
  }
  return { path: workspaceFeaturePath(feature) }
}
const results = computed(() => {
  const choices = [
    ...workspaceNavigation.map((item) => ({
      label: item.label,
      hint: item.hint,
      keywords: '',
      to: { path: item.path }
    })),
    ...Object.entries(workspaceFeatures).map(([key, item]) => ({
      label: item.label,
      hint: `${sectionLabels[item.group] || item.group} · ${item.hint}`,
      keywords: item.keywords,
      to: featureTarget(key as WorkspaceFeature)
    })),
    ...(data.value?.agents ?? []).map((item) => ({
      label: robotLabel(item, data.value?.agents ?? []),
      hint: `机器人 · ${item.personaName}`,
      keywords: '',
      to: robotLocation(item)
    })),
    ...(data.value?.connections ?? []).map((item) => ({
      label: namedId(item.id, item.name),
      hint: `连接 · ${accountReference(item.account)}`,
      keywords: '',
      to: { path: `/connections/${encodeURIComponent(item.id)}` }
    })),
    ...(data.value?.agents ?? []).flatMap((agent) =>
      agent.conversations.map((row) => ({
        label: conversationLabel(row),
        hint: `${robotLabel(agent, data.value?.agents ?? [])} · ${row.binding.connectionId} · ${accountLabel(row.binding.target.account)}`,
        keywords: '',
        to: robotLocation(agent, 'conversations', row)
      }))
    )
  ]
  const q = query.value.trim().toLocaleLowerCase()
  return choices
    .filter(
      (item) =>
        !q ||
        `${item.label} ${item.hint} ${item.keywords} ${JSON.stringify(item.to)}`
          .toLocaleLowerCase()
          .includes(q)
    )
    .slice(0, 60)
})
function choose(target: RouteLocationRaw) {
  searchOpen.value = false
  void router.push(target)
}
function closeMenuOnCurrentLink(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  if (!(event.target instanceof Element)) return
  const href = event.target.closest('a[href]')?.getAttribute('href')
  if (href === router.resolve(route.fullPath).href) menuOpen.value = false
}
function keydown(event: KeyboardEvent) {
  const editing = (event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]')
  if (
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') ||
    (event.key === '/' && !editing)
  ) {
    event.preventDefault()
    searchOpen.value = true
  }
}
async function refresh() {
  try {
    await workspace.load()
  } catch (cause) {
    message.error((cause as Error).message)
  }
}
async function logout() {
  if (!(await confirmLeave())) return
  try {
    await api('/api/auth/logout', { method: 'POST' })
    clearToken()
    workspace.reset()
    emit('logout')
  } catch (cause) {
    message.error((cause as Error).message)
  }
}
async function changePassword() {
  if (passwordBusy.value) return
  if (newPassword.value.length < 8) {
    passwordError.value = '新密码至少 8 位'
    return
  }
  passwordBusy.value = true
  passwordError.value = ''
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
    })
    passwordOpen.value = false
    oldPassword.value = ''
    newPassword.value = ''
    message.success('密码已修改')
  } catch (cause) {
    passwordError.value = (cause as Error).message
  } finally {
    passwordBusy.value = false
  }
}
watch(
  [currentPath, activeFeature],
  () => {
    expandedSection.value = active.value.path === '/' ? null : active.value.path
  },
  { immediate: true }
)
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
  }
)
watch(
  breadcrumbs,
  (labels) => {
    document.title = [...labels, '机器人控制台'].join(' · ')
  },
  { immediate: true }
)
watch(
  () => consoleRestart.state.reloadGeneration,
  () => void refresh()
)
onMounted(() => window.addEventListener('keydown', keydown))
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>
<template>
  <div class="console-shell robot-console">
    <a class="skip-link" href="#main-content">跳到内容</a>
    <aside class="desktop-sidebar">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark"><Bot :size="22" /></span
        ><span>bl-chat<small>机器人控制台</small></span></RouterLink
      >
      <WorkspaceNavigation
        v-model:expanded="expandedSection"
        label="主导航"
        :current-path="currentPath"
        :active-section="active.path"
        :active-feature="activeFeature"
        :feature-target="featureTarget"
      />
      <div class="sidebar-user">
        <span class="avatar">{{ (authState?.username || 'T').slice(0, 1).toUpperCase() }}</span>
        <div>
          <strong>{{ authState?.username || '令牌模式' }}</strong
          ><small>{{ authState?.username ? '管理员' : '令牌登录' }}</small>
        </div>
        <NButton quaternary circle aria-label="退出登录" @click="logout"
          ><template #icon><LogOut :size="17" /></template
        ></NButton>
      </div>
      <small class="build-info" :title="`构建于 ${build.at}`"
        >构建 {{ build.revision }} · {{ build.at.slice(0, 10) }}</small
      >
    </aside>
    <div class="workspace">
      <header class="workspace-topbar">
        <NButton
          class="mobile-menu-button"
          quaternary
          circle
          aria-label="打开导航"
          @click="menuOpen = true"
          ><template #icon><Menu :size="21" /></template
        ></NButton>
        <div class="breadcrumbs" aria-label="当前位置">
          <template v-for="(label, index) in breadcrumbs" :key="index">
            <ChevronRight v-if="index > 0" :size="13" aria-hidden="true" />
            <strong v-if="index === breadcrumbs.length - 1">{{ label }}</strong>
            <span v-else>{{ label }}</span>
          </template>
        </div>
        <div class="topbar-tools">
          <button
            class="search-trigger"
            aria-label="搜索模块、机器人、连接或会话"
            @click="searchOpen = true"
          >
            <Search :size="15" /><span>搜索模块、机器人、连接或会话</span><kbd>⌘ K</kbd></button
          ><NButton quaternary circle aria-label="刷新工作区" :loading="loading" @click="refresh"
            ><template #icon><RefreshCw :size="17" /></template></NButton
          ><NButton
            quaternary
            circle
            :aria-label="appearance === 'dark' ? '切换浅色主题' : '切换深色主题'"
            @click="emit('theme')"
            ><template #icon
              ><Sun v-if="appearance === 'dark'" :size="17" /><Moon
                v-else
                :size="17" /></template></NButton
          ><NButton
            v-if="authState?.username"
            quaternary
            circle
            aria-label="修改密码"
            :disabled="consoleRestart.blocked.value"
            @click="passwordOpen = true"
            ><template #icon><KeyRound :size="17" /></template
          ></NButton>
        </div>
      </header>
      <main id="main-content" class="workspace-content">
        <NAlert v-if="workspaceError" type="warning" title="工作区刷新失败" class="workspace-error"
          >{{ workspaceError }}。下方保留上次读取内容，请刷新后再操作。</NAlert
        >
        <RouterView v-slot="{ Component, route: current }">
          <div v-if="Component" :key="current.path" class="workspace-page">
            <component :is="Component" />
          </div>
        </RouterView>
      </main>
    </div>
    <NDrawer v-model:show="menuOpen" placement="left" :width="260"
      ><NDrawerContent title="机器人控制台" closable
        ><WorkspaceNavigation
          v-model:expanded="expandedSection"
          label="移动主导航"
          :current-path="currentPath"
          :active-section="active.path"
          :active-feature="activeFeature"
          :feature-target="featureTarget"
          @click="closeMenuOnCurrentLink"
        />
        <NButton class="workspace-drawer-logout" @click="logout">退出登录</NButton></NDrawerContent
      ></NDrawer
    >
    <NModal
      v-model:show="searchOpen"
      preset="card"
      title="查找模块、机器人与会话"
      class="search-modal"
      @after-enter="searchInput?.focus()"
      ><NInput
        ref="searchInput"
        v-model:value="query"
        placeholder="模块、名字、连接或完整会话标识"
        clearable
      />
      <div class="search-results">
        <button v-for="(result, index) in results" :key="index" @click="choose(result.to)">
          <Search :size="16" /><span
            >{{ result.label }}<small>{{ result.hint }}</small></span
          ><ArrowUpRight :size="15" />
        </button>
        <p v-if="!results.length" class="muted">没有匹配结果</p>
      </div></NModal
    >
    <NModal v-model:show="passwordOpen" preset="card" title="修改密码" class="dialog-card"
      ><form class="page-stack" @submit.prevent="changePassword">
        <label class="form-field"
          ><span>当前密码</span
          ><NInput
            v-model:value="oldPassword"
            type="password"
            autocomplete="current-password" /></label
        ><label class="form-field"
          ><span>新密码</span
          ><NInput v-model:value="newPassword" type="password" autocomplete="new-password" /></label
        ><NAlert v-if="passwordError" type="error">{{ passwordError }}</NAlert
        ><NButton attr-type="submit" type="primary" :loading="passwordBusy">修改密码</NButton>
      </form></NModal
    >
  </div>
</template>

<style scoped>
.workspace-page {
  min-width: 0;
  animation: workspace-page-enter 180ms ease-out;
}

@keyframes workspace-page-enter {
  from {
    opacity: 0.65;
    transform: translateY(4px);
  }
}
</style>
