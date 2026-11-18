<script setup lang="ts">
import { workspace } from '../lib/workspace'
import BotDetailPage from './BotDetailPage.vue'
import WorkspaceConnections from './WorkspaceConnections.vue'
import { NAlert } from 'naive-ui'
defineProps<{ qq: string }>()
const mode = workspace.mode
</script>
<template>
  <div v-if="mode === 'standalone'" class="page-stack">
    <NAlert type="info" title="此链接指向平台账号"
      >请选择对应连接查看接入会话，或从机器人列表打开本人。</NAlert
    ><RouterLink to="/robots">打开机器人列表 →</RouterLink><WorkspaceConnections />
  </div>
  <BotDetailPage v-else :qq="qq" />
</template>
