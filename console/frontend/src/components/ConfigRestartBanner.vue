<script setup lang="ts">
import { computed, ref } from 'vue'
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
        : '配置已保存，等待重启'
)
async function check() {
  if (checking.value) return
  checking.value = true
  error.value = ''
  try {
    await api('/api/config-state')
  } catch {
    error.value = '暂时无法核对服务状态，草稿与编辑锁已保留。'
  } finally {
    checking.value = false
  }
}
</script>
<template>
  <div v-if="restartBlocked" class="config-restart-banner" role="status">
    <NAlert type="warning" :title="title" :show-icon="false">
      <p v-if="consoleRestart.state.recoveryRequired">
        配置事务尚未完成，请停止服务并按事务恢复流程离线处理；本页面不提供在线恢复。恢复后启动新进程并检查状态，确认配置完整加载后再继续编辑。草稿会保留。
      </p>
      <p v-else-if="consoleRestart.state.phase === 'saving'">正在写入本次修改，请稍候。</p>
      <p v-else-if="consoleRestart.state.phase === 'uncertain'">
        请勿重复保存。请重启服务并检查状态，确认新的进程已加载磁盘配置后恢复编辑；未提交草稿会保留。
      </p>
      <p v-else>请重启服务后检查状态。确认新的进程已加载配置后恢复编辑；其他页面的草稿会保留。</p>
      <NButton
        v-if="consoleRestart.state.phase !== 'saving'"
        size="small"
        :loading="checking"
        @click="check"
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
