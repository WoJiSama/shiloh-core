<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import SchemaPage from './SchemaPage.vue'
import { api } from '../lib/api'

const section = ref<'dice' | 'commands' | 'diceAssets'>('dice')
const visited = ref(new Set(['dice']))
const sections = [{ id: 'dice', label: '骰子基础' }, { id: 'commands', label: '命令目录' }, { id: 'diceAssets', label: '骰子回复与资产' }] as const
const error = ref('')
function select(id: typeof section.value) {
  visited.value.add(id)
  section.value = id
}
async function download() {
  error.value = ''
  try {
    const state = await api<{ groups: { fields: { field: string; value: string }[] }[] }>('/api/config/commands')
    const markdown = state.groups.flatMap(group => group.fields).find(item => item.field === 'commandHelp.markdown')?.value
    if (typeof markdown !== 'string') throw new Error('命令目录暂不可用')
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'shiloh-commands.md'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  } catch (cause) { error.value = (cause as Error).message }
}
</script>

<template>
  <div class="page-stack">
    <PageHeader title="命令与骰子">
      <template #actions><NButton v-if="section === 'commands'" @click="download">下载已保存的命令说明</NButton></template>
    </PageHeader>
    <nav class="task-tabs" role="tablist" aria-label="命令与骰子">
      <button v-for="item in sections" :key="item.id" role="tab" :aria-selected="section === item.id" @click="select(item.id)">{{ item.label }}</button>
    </nav>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <template v-for="item in sections" :key="item.id">
      <SchemaPage v-if="visited.has(item.id)" v-show="section === item.id" :kind="item.id" embedded />
    </template>
  </div>
</template>
