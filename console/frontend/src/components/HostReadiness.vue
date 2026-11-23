<script setup lang="ts">
import { watch } from 'vue'
import { NAlert, NTag } from 'naive-ui'
import { api } from '../lib/api'
import { useOpsResource } from '../lib/operations'
import { capability, workspace } from '../lib/workspace'

const state = useOpsResource((signal) => capability('host.readiness').status !== 'available' ? Promise.resolve(null) : api<{ ready: boolean; accounts: {
  connectionId: string; state: 'ready' | 'recovering' | 'disconnected'
}[] }>('/api/host/readiness', { signal }))
const labels = { ready: '就绪', recovering: '正在恢复', disconnected: 'QQ 未连接' }
watch(() => [workspace.data.value?.observedAt, capability('host.readiness').status] as const, ([, status]) => {
  if (status === 'available') void state.refresh()
}, { immediate: true })
</script>

<template>
  <NAlert v-if="state.error.value" type="warning">暂时无法核对 Core 就绪状态。</NAlert>
  <div v-else-if="state.data.value" class="workspace-list-row">
    <span class="row-main">
      <strong>{{ state.data.value.ready ? 'Core 调度已启动' : 'Core 正在初始化或等待加载配置' }}</strong>
      <small v-for="account in state.data.value.accounts" :key="account.connectionId">
        {{ account.connectionId }} · {{ labels[account.state] }}
      </small>
    </span>
    <NTag v-if="state.data.value.ready" size="small" type="success">调度在线</NTag>
  </div>
</template>
