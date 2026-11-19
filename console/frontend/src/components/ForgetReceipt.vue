<script setup lang="ts">
import { NAlert, NButton } from 'naive-ui'
import type { ForgetReceipt } from '../lib/forgetReceipt'
defineProps<{ receipt: ForgetReceipt | null; error?: string; loading?: boolean }>()
defineEmits<{ refresh: [] }>()
const phases = { accepted: '已受理', committed: '已提交', settling: '正在处理', completed: '处理完成', failed: '处理失败', unknown: '结果待核对' }
const usage = { pending: '等待确认', blocked: '已停止使用', unknown: '尚未确认停止使用' }
const cleanup: Record<string, string> = { pending: '等待清理', completed: '已清理', failed: '清理失败', unknown: '清理结果待核对', unsupported: '当前范围未提供清理证明' }
const kinds: Record<string, string> = { 'person-memory-entry': '人物记忆', 'character-memory': '角色记忆', 'character-goal': '关联目标', 'character-work': '关联作品', 'character-shared-derived': '关联共享记录', 'source-consumer': '来源使用记录', partition: '关联分区' }
const impactStates: Record<string, string> = { pending: '等待处理', completed: '已处理', failed: '处理失败', unknown: '处理结果待核对', unsupported: '未提供清理证明' }
const partitions: Record<string, string> = { 'local-emoji-attributed-sources': '本地表情（已登记来源）', 'local-emoji-unattributed': '历史表情（缺少原始来源）', 'semantic-memory-sources': '语义原文库', 'semantic-memory-vectors': '语义向量库', 'conversation-memory-records': '滚动对话原文', 'conversation-memory-summaries': '近期会话摘要', 'conversation-memory-episodes': '历史情节' }
</script>
<template>
  <NAlert v-if="receipt" :type="receipt.phase === 'completed' && receipt.cleanup === 'completed' ? 'success' : receipt.phase === 'failed' ? 'error' : 'warning'" title="遗忘处理回执">
    <p>{{ phases[receipt.phase] }} · {{ usage[receipt.usage] }} · {{ cleanup[receipt.cleanup] }}</p>
    <details v-if="receipt.impacts.length">
      <summary>查看 {{ receipt.impacts.length }} 项影响记录</summary>
      <ul><li v-for="item in receipt.impacts" :key="`${item.kind}:${item.partition}:${item.id}`">{{ item.kind === 'partition' && partitions[item.id] ? partitions[item.id] : `${kinds[item.kind] || '关联记录'} ${item.id}` }} · {{ impactStates[item.state] || '状态待核对' }}</li></ul>
    </details>
    <small>回执编号：{{ receipt.operationId }}</small>
    <p v-if="error">{{ error }}</p>
    <NButton size="small" :loading="loading" @click="$emit('refresh')">刷新遗忘回执</NButton>
  </NAlert>
</template>
