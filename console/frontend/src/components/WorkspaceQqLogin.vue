<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NModal, NSpin, useMessage } from 'naive-ui'
import { QrCode } from 'lucide-vue-next'
import { api } from '../lib/api'
import { canInspectQqLogin, capability, workspace } from '../lib/workspace'
import type { WorkspaceConnection } from '../lib/workspaceModel'

const props = defineProps<{ connection: WorkspaceConnection; primary?: boolean }>()
const notifications = useMessage()
const descriptions = {
  connected: 'QQ 已连接，可以收发消息。',
  connecting: '正在等待 QQ 连接。',
  'login-required': '点击获取二维码，然后用手机 QQ 扫码。',
  'awaiting-scan': '用手机 QQ 扫码，并在手机上确认登录。',
  'awaiting-confirmation': '已扫码，请在手机 QQ 上确认。',
  'account-mismatch': '当前登录的 QQ 与此连接的账号不同，请在 QQ 登录服务中切换到正确账号。'
} as const
type LoginState = keyof typeof descriptions
type LoginView = { state: LoginState; qrImage?: string; remainingMs?: number }

const permitted = computed(() => canInspectQqLogin(props.connection))
const canRefresh = computed(() => capability('qq-login.refresh').status === 'available')
const path = computed(() => `/api/connections/${encodeURIComponent(props.connection.id)}/qq-login/${encodeURIComponent(props.connection.account.id)}`)
const open = ref(false), loading = ref(false), generating = ref(false), failure = ref('')
const view = ref<LoginView>()
const canGenerate = computed(() => canRefresh.value && view.value &&
  ['login-required', 'awaiting-scan'].includes(view.value.state))
let session: AbortController | undefined
let poll: ReturnType<typeof setTimeout> | undefined
let expiration: ReturnType<typeof setTimeout> | undefined

function parse(input: unknown): LoginView {
  const value = input as Partial<LoginView> & { accountId?: string }
  if (!value || value.accountId !== props.connection.account.id || !value.state ||
      !Object.hasOwn(descriptions, value.state)) throw new Error('QQ 登录状态无效')
  if (value.state === 'awaiting-scan') {
    if (typeof value.qrImage !== 'string' || value.qrImage.length > 24_000 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.qrImage) ||
        typeof value.remainingMs !== 'number' || !Number.isFinite(value.remainingMs) ||
        value.remainingMs <= 0 || value.remainingMs > 100_000) throw new Error('QQ 登录二维码无效')
    return { state: value.state, qrImage: value.qrImage, remainingMs: value.remainingMs }
  }
  return { state: value.state }
}

async function load(signal: AbortSignal, action: 'open' | 'poll' | 'refresh') {
  if (signal.aborted) return
  clearTimeout(poll)
  loading.value = true
  generating.value = action === 'refresh'
  if (action !== 'poll') failure.value = ''
  try {
    const requestQr = async () => {
      generating.value = true
      clearTimeout(expiration)
      view.value = { state: 'login-required' }
      return parse(await api(path.value, { method: 'POST', body: '{}', signal }))
    }
    let result = action === 'refresh' ? await requestQr() : parse(await api(path.value, { signal }))
    if (signal.aborted) return
    if (action === 'open' && result.state === 'login-required' && canRefresh.value) result = await requestQr()
    if (signal.aborted) return
    if (result.state !== 'login-required' || !view.value) failure.value = ''
    view.value = result
    clearTimeout(expiration)
    if (result.remainingMs)
      expiration = setTimeout(() => { view.value = { state: 'login-required' } }, result.remainingMs)
    if (result.state === 'connected') {
      failure.value = ''
      if (props.connection.state !== 'connected') {
        notifications.success('QQ 已连接')
        void workspace.load().catch(() => {})
      }
      return
    }
  } catch {
    if (signal.aborted) return
    failure.value = generating.value ? '暂时无法生成二维码，请稍后刷新。' : '暂时无法读取 QQ 登录状态，正在重试。'
    if (!generating.value) {
      view.value = undefined
      clearTimeout(expiration)
    }
  } finally {
    if (!signal.aborted) {
      generating.value = false
      loading.value = false
      if (view.value?.state !== 'connected') poll = setTimeout(() => void load(signal, 'poll'), 3_000)
    }
  }
}

function dispose() {
  session?.abort()
  clearTimeout(poll)
  clearTimeout(expiration)
  session = undefined
  view.value = undefined
  failure.value = ''
  loading.value = false
  generating.value = false
}

watch([path, permitted], () => { open.value = false })
watch(open, (visible) => {
  dispose()
  if (!visible || !permitted.value) return
  session = new AbortController()
  void load(session.signal, 'open')
})
onBeforeUnmount(dispose)
</script>

<template>
  <NButton v-if="permitted" size="small" :type="primary ? 'primary' : 'default'" :secondary="!primary" @click="open = true">
    <template #icon><QrCode :size="16" /></template>
    {{ connection.state === 'connected' ? 'QQ 登录状态' : '扫码登录' }}
  </NButton>
  <NModal v-model:show="open" preset="card" title="QQ 登录" class="qq-login-dialog" :style="{ width: 'min(420px, calc(100vw - 32px))' }">
    <div class="qq-login-body">
      <strong>QQ {{ connection.account.id }}</strong>
      <div class="qq-login-code" v-if="view?.qrImage || generating">
        <img v-if="view?.qrImage" :src="view.qrImage" alt="QQ 登录二维码" width="224" height="224" />
        <NSpin v-else aria-label="正在获取二维码" />
      </div>
      <p class="field-help" role="status">
        {{ generating ? '正在获取二维码…' : view ? descriptions[view.state] : failure || '正在检查登录状态…' }}
      </p>
      <p v-if="failure && view" class="field-help" role="alert">{{ failure }}</p>
      <NButton v-if="canGenerate" :loading="generating" :disabled="loading" secondary
        @click="session && load(session.signal, 'refresh')">
        {{ view?.state === 'awaiting-scan' || failure ? '刷新二维码' : '获取二维码' }}
      </NButton>
      <p v-else-if="view?.state === 'login-required' && !canRefresh" class="field-help">当前控制台身份无法生成二维码。</p>
    </div>
  </NModal>
</template>

<style scoped>
.qq-login-body {
  display: grid;
  justify-items: center;
  gap: 14px;
  text-align: center;
}
.qq-login-code {
  display: grid;
  place-items: center;
  width: 224px;
  height: 224px;
  background: white;
  border-radius: 10px;
  overflow: hidden;
}
.qq-login-body p {
  margin: 0;
}
</style>
