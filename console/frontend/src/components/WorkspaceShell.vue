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
  workspaceFeatureEntries,
  workspaceFeaturePath,
  workspaceFeatures,
  workspaceNavigation,
  type WorkspaceFeature
} from '../lib/navigation'
import { accountLabel, conversationLabel, robotLabel, robotLocation } from '../lib/workspaceModel'
import { confirmLeave, installUnsavedDialog } from '../composables/useUnsavedGuard'
import { useOpsResource } from '../lib/operations'
import { consoleRestart } from '../lib/consoleRestart'

defineProps<{ appearance: string }>()
const emit = defineEmits<{ theme: []; logout: [] }>()
const route = useRoute(),
  router = useRouter(),
  message = useMessage()
const data = workspace.data,
  workspaceError = workspace.error,
  loading = workspace.loading
const menuOpen = ref(false),
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
function sectionForPath(path: string) {
  if (path.startsWith('/robots')) return '/robots'
  if (path.startsWith('/connections')) return '/connections'
  if (path.startsWith('/observe')) return '/runtime'
  const feature = workspaceFeatures[path.slice(1) as keyof typeof workspaceFeatures]
  if (feature) return feature.group
  return workspaceNavigation.some((item) => item.path === path) ? path : '/'
}
const active = computed(() => {
  const path = sectionForPath(route.path)
  return workspaceNavigation.find((item) => item.path === path) ?? workspaceNavigation[0]!
})
const selectedAgent = computed(() =>
  route.path.startsWith('/robots/')
    ? data.value?.agents.find((item) => item.id === route.params.id)
    : undefined
)
const subnavItems = computed(() => workspaceFeatureEntries(active.value.path))
function featureTarget(feature: WorkspaceFeature) {
  if ((feature === 'person-profiles' || feature === 'trusteeship') && selectedAgent.value) {
    return {
      path: `/robots/${encodeURIComponent(selectedAgent.value.id)}/${feature === 'person-profiles' ? 'self' : 'actions'}`,
      query: { ...route.query, panel: feature }
    }
  }
  return { path: workspaceFeaturePath(feature) }
}
function featureActive(feature: WorkspaceFeature) {
  const path = workspaceFeaturePath(feature)
  if (feature === 'person-profiles' && route.params.tab === 'self' && route.query.panel === feature)
    return true
  if (feature === 'groups' && route.path.startsWith('/connections')) return true
  if (feature === 'observe' && route.path.startsWith('/observe')) return true
  return route.path === path || route.path.startsWith(path + '/')
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
      label: item.id,
      hint: `连接 · ${accountLabel(item.account)}`,
      keywords: '',
      to: { path: `/connections/${encodeURIComponent(item.id)}` }
    })),
    ...(data.value?.agents ?? []).flatMap((agent) =>
      agent.conversations.map((row) => ({
        label: `${robotLabel(agent, data.value?.agents ?? [])} · ${conversationLabel(row)}`,
        hint: `${row.binding.connectionId} · ${accountLabel(row.binding.target.account)}`,
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
  () => route.fullPath,
  () => {
    menuOpen.value = false
    document.title = `${selectedAgent.value ? robotLabel(selectedAgent.value, data.value?.agents ?? []) : active.value.label} · 机器人控制台`
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
      <nav class="navigation" aria-label="主导航">
        <RouterLink
          v-for="item in workspaceNavigation"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: active.path === item.path }"
          :aria-current="active.path === item.path ? 'page' : undefined"
          ><component :is="item.icon" :size="19" /><span>{{ item.label }}</span></RouterLink
        >
      </nav>
      <div class="workspace-sidebar-note">
        <span class="eyebrow">独立宿主</span>
        <p>从本人出发，了解她的会话与行动。</p>
      </div>
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
        <div class="breadcrumbs">
          <span>{{ active.label }}</span
          ><ChevronRight v-if="selectedAgent" :size="13" /><strong v-if="selectedAgent">{{
            robotLabel(selectedAgent, data?.agents ?? [])
          }}</strong>
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
        <nav v-if="subnavItems.length" class="workspace-subnav" aria-label="当前分类功能">
          <RouterLink
            v-for="[key, item] in subnavItems"
            :key="key"
            :to="featureTarget(key as WorkspaceFeature)"
            :class="{ active: featureActive(key as WorkspaceFeature) }"
            :aria-current="featureActive(key as WorkspaceFeature) ? 'page' : undefined"
            >{{ item.label }}</RouterLink
          >
        </nav>
        <NAlert v-if="workspaceError" type="warning" title="工作区刷新失败" class="workspace-error"
          >{{ workspaceError }}。下方保留上次读取内容，请刷新后再操作。</NAlert
        ><RouterView v-slot="{ Component, route: current }"
          ><component :is="Component" :key="current.path"
        /></RouterView>
      </main>
    </div>
    <NDrawer v-model:show="menuOpen" placement="left" :width="260"
      ><NDrawerContent title="机器人控制台" closable
        ><nav class="navigation" aria-label="移动主导航">
          <RouterLink
            v-for="item in workspaceNavigation"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: active.path === item.path }"
            >{{ item.label }}</RouterLink
          >
        </nav>
        <NButton @click="logout">退出登录</NButton></NDrawerContent
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
