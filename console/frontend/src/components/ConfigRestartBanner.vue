<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { api } from '../lib/api'
import { consoleRestart } from '../lib/consoleRestart'
import HostRestartButton from './HostRestartButton.vue'
const restartBlocked = consoleRestart.blocked
const checking = ref(false),
  error = ref('')
const title = computed(() =>
  consoleRestart.state.recoveryRequired
    ? '配置事务需要离线恢复'
    : consoleRestart.state.phase === 'saving'
      ? '正在保存配置'
      : consoleRestart.state.phase === 'uncertain'
        ? '保存结果待核对'
        : '配置已保存，正在核对服务是否恢复'
)
async function check(automatic = false, signal = AbortSignal.timeout(4_000)) {
  if (checking.value) return
  checking.value = true
  if (!automatic) error.value = ''
  try {
    await api('/api/config-state', { signal })
  } catch {
    if (!automatic) error.value = '暂时无法核对服务状态，草稿与编辑锁已保留。'
  } finally {
    checking.value = false
  }
}
watch(
  () => [consoleRestart.state.phase, consoleRestart.state.recoveryRequired] as const,
  ([phase, recovery], _previous, onCleanup) => {
    error.value = ''
    if (recovery || (phase !== 'restart-required' && phase !== 'uncertain')) return
    const controller = new AbortController()
    const deadline = Date.now() + 60_000
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer)
        error.value = '服务暂未确认恢复。请检查运行状态，必要时手动重启。草稿已保留。'
        return
      }
      void check(true, AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]))
    }, 2_000)
    onCleanup(() => {
      clearInterval(timer)
      controller.abort()
    })
  },
  { immediate: true }
)
</script>
<template>
  <div v-if="restartBlocked" class="config-restart-banner" role="status">
    <NAlert type="warning" :title="title" :show-icon="false">
      <p v-if="consoleRestart.state.recoveryRequired">
        配置事务尚未完成，请停止服务并按事务恢复流程离线处理；本页面不提供在线恢复。恢复后启动新进程并检查状态，确认配置完整加载后再继续编辑。草稿会保留。
      </p>
      <p v-else-if="consoleRestart.state.phase === 'saving'">正在写入本次修改，请稍候。</p>
      <p v-else-if="consoleRestart.state.phase === 'uncertain'">
        请勿重复保存。控制台会自动核对服务状态，确认重新加载磁盘配置后恢复编辑。未提交草稿会保留。
      </p>
      <p v-else>控制台会自动检查服务是否已加载保存的配置。确认后恢复编辑，其他页面的草稿会保留。</p>
      <NButton
        v-if="consoleRestart.state.phase !== 'saving'"
        size="small"
        :loading="checking"
        @click="check()"
      >
        检查服务状态
      </NButton>
      <HostRestartButton />
      <p v-if="error">{{ error }}</p>
    </NAlert>
  </div>
</template>
<style scoped>
.config-restart-banner {
  position: sticky;
  top: 0;
  z-index: 2000;
  padding: 10px 20px;
}
.config-restart-banner p {
  margin: 0 0 8px;
}
</style>
