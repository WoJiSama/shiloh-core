<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight, Bot, Cable, MessageCircle, ShieldCheck } from 'lucide-vue-next'
import { NAlert, NTag } from 'naive-ui'
import { workspace, configurationLabel, canInspectQqLogin } from '../lib/workspace'
import { connectionStateLabel, robotLabel, robotLocation } from '../lib/workspaceModel'
import { accountReference, namedId } from '../lib/workspaceNames'
import PageHeader from '../components/PageHeader.vue'
import HostReadiness from '../components/HostReadiness.vue'
import WorkspaceQqLogin from '../components/WorkspaceQqLogin.vue'
const data = workspace.data
const total = computed(
  () => data.value?.agents.reduce((n, item) => n + item.conversations.length, 0) ?? 0
)
const disconnectedQq = computed(() => data.value?.connections.filter(
  (connection) => connection.account.platform === 'qq' && connection.state === 'disconnected'
) ?? [])
</script>
<template>
  <div v-if="data" class="page-stack">
    <PageHeader
      title="总览"
      ><template #actions
        ><span class="muted"
          >读取于
          {{ new Date(data.observedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span
        ></template
      ></PageHeader
    >
    <NAlert v-if="disconnectedQq.length" type="warning" title="QQ 连接已断开">
      <div v-for="connection in disconnectedQq" :key="connection.id" class="offline-qq">
        <span>{{ namedId(connection.id, connection.name) }} · {{ accountReference(connection.account) }}</span>
        <WorkspaceQqLogin v-if="canInspectQqLogin(connection)" :connection="connection" primary />
        <RouterLink v-else :to="`/connections/${encodeURIComponent(connection.id)}`">查看 QQ 连接</RouterLink>
      </div>
    </NAlert>
    <div class="workspace-metrics">
      <RouterLink to="/robots" class="panel workspace-metric"
        ><Bot :size="19" /><strong>{{ data.agents.length }}</strong
        ><span>机器人本人</span></RouterLink
      ><RouterLink to="/connections" class="panel workspace-metric"
        ><Cable :size="19" /><strong>{{ data.connections.length }}</strong
        ><span>平台连接</span></RouterLink
      ><RouterLink to="/robots" class="panel workspace-metric"
        ><MessageCircle :size="19" /><strong>{{ total }}</strong
        ><span>已绑定会话</span></RouterLink
      ><RouterLink to="/system" class="panel workspace-metric"
        ><ShieldCheck :size="19" /><strong class="metric-word">{{ configurationLabel() }}</strong
        ><span>配置状态</span></RouterLink
      >
    </div>
    <div class="workspace-columns">
      <section class="panel">
        <div class="panel-heading">
          <h2>机器人</h2>
          <RouterLink to="/robots">查看全部</RouterLink>
        </div>
        <RouterLink
          v-for="agent in data.agents.slice(0, 6)"
          :key="agent.id"
          :to="robotLocation(agent)"
          class="workspace-list-row"
          ><span class="robot-avatar">{{ agent.name.slice(0, 1) }}</span
          ><span class="row-main"
            ><strong>{{ robotLabel(agent, data.agents) }}</strong
            ><small>{{ agent.personaName }} · {{ agent.conversations.length }} 个会话</small></span
          ><ArrowUpRight :size="17"
        /></RouterLink>
        <p v-if="!data.agents.length" class="empty-note">工作区中暂无机器人。</p>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>连接状态</h2>
          <RouterLink to="/connections">查看全部</RouterLink>
        </div>
        <HostReadiness />
        <RouterLink
          v-for="connection in data.connections.slice(0, 6)"
          :key="connection.id"
          :to="`/connections/${encodeURIComponent(connection.id)}`"
          class="workspace-list-row"
          ><span class="row-main"
            ><strong>{{ namedId(connection.id, connection.name) }}</strong
            ><small>{{ accountReference(connection.account) }}</small></span
          ><NTag size="small" :type="connection.state === 'connected' ? 'success' : 'default'">{{
            connectionStateLabel(connection.state)
          }}</NTag></RouterLink
        >
        <p v-if="!data.connections.length" class="empty-note">尚无平台连接。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.offline-qq {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-top: 8px;
}
</style>
