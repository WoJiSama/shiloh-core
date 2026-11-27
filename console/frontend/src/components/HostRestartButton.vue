<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { NButton } from 'naive-ui'
import { api } from '../lib/api'
import { capability, workspace } from '../lib/workspace'
import { consoleRestart, parseConfigProcessState } from '../lib/consoleRestart'

const busy = ref(false)
const feedback = ref('')
const lifecycle = new AbortController()
onBeforeUnmount(() => lifecycle.abort())

async function restart() {
  if (busy.value || !window.confirm('重启希洛 Core 并加载磁盘上的配置？')) return
  busy.value = true
  feedback.value = ''
  const signal = lifecycle.signal
  let submitted = false
  try {
    const expected = parseConfigProcessState(await api('/api/config-state', { signal }))
    if (expected.recoveryRequired || !expected.storedRevision) throw new Error('配置状态待核实')
    submitted = true
    await api('/api/host/restart', { method: 'POST', signal,
      body: JSON.stringify({ processEpoch: expected.processEpoch, storedRevision: expected.storedRevision }) })
    feedback.value = '正在等待新进程加载配置…'
    const deadline = Date.now() + 75_000
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const probe = AbortSignal.any([signal, AbortSignal.timeout(5000)])
      const current = await api('/api/config-state', { signal: probe }).then(parseConfigProcessState, () => null)
      if (current && current.processEpoch !== expected.processEpoch && current.phase === 'active' &&
          current.loadedRevision === expected.storedRevision) {
        feedback.value = '新进程已加载配置'
        await workspace.load(signal).catch(() => {})
        return
      }
    }
    if (!signal.aborted) feedback.value = '暂未确认配置已生效，请检查服务状态。'
  } catch {
    if (!signal.aborted) feedback.value = submitted ? '重启结果待核实，请检查服务状态。' : '暂时无法核对配置版本。'
  } finally { busy.value = false }
}
</script>

<template>
  <div v-if="capability('host.restart').status === 'available' && !consoleRestart.state.recoveryRequired">
    <NButton size="small" :loading="busy" :disabled="consoleRestart.state.phase === 'saving'" @click="restart">
      {{ consoleRestart.blocked.value ? '重启并应用配置' : '重启服务' }}
    </NButton>
    <span v-if="feedback" class="field-help" role="status"> {{ feedback }}</span>
  </div>
</template>
