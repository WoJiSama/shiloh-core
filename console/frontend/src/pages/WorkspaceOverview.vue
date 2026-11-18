<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight, Bot, Cable, MessageCircle, ShieldCheck } from 'lucide-vue-next'
import { NTag } from 'naive-ui'
import { workspace, configurationLabel } from '../lib/workspace'
import { connectionStateLabel, robotLabel, robotLocation } from '../lib/workspaceModel'
import PageHeader from '../components/PageHeader.vue'
const data = workspace.data
const total = computed(
  () => data.value?.agents.reduce((n, item) => n + item.conversations.length, 0) ?? 0
)
const pending = computed(
  () => data.value?.capabilities.filter((item) => item.status !== 'available') ?? []
)
</script>
<template>
  <div v-if="data" class="page-stack">
    <PageHeader
      title="从本人开始"
      description="机器人是谁、在哪里交流、现在能做什么。这里展示宿主实际提供的信息。"
      ><template #actions
        ><span class="muted"
          >读取于
          {{ new Date(data.observedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span
        ></template
      ></PageHeader
    >
    <section class="workspace-hero panel">
      <div>
        <span class="eyebrow">机器人工作区</span>
        <h2>每个本人，都有自己的会话与经历。</h2>
        <p>人设提供表达与边界，连接负责接入平台。相同模板不会把不同机器人合并成同一个人。</p>
        <RouterLink to="/robots" class="text-link"
          >查看机器人 <ArrowUpRight :size="16"
        /></RouterLink>
      </div>
      <div class="hero-mark" aria-hidden="true"><Bot :size="58" :stroke-width="1.2" /></div>
    </section>
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
        <RouterLink
          v-for="connection in data.connections.slice(0, 6)"
          :key="connection.id"
          :to="`/connections/${encodeURIComponent(connection.id)}`"
          class="workspace-list-row"
          ><span class="row-main"
            ><strong>{{ connection.id }}</strong
            ><small>{{ connection.account.platform }} · {{ connection.account.id }}</small></span
          ><NTag size="small" :type="connection.state === 'connected' ? 'success' : 'default'">{{
            connectionStateLabel(connection.state)
          }}</NTag></RouterLink
        >
        <p v-if="!data.connections.length" class="empty-note">尚无平台连接。</p>
      </section>
    </div>
    <section class="panel">
      <div class="panel-heading">
        <h2>需要关注</h2>
        <RouterLink to="/system">查看能力与配置</RouterLink>
      </div>
      <p v-if="data.configState.requiresRestart" class="notice-line">
        配置已改变，执行已暂停。重启后核对新的配置状态。
      </p>
      <p v-else-if="pending.length" class="muted">
        {{ pending.length }} 项管理能力受当前授权或宿主能力限制，可在对应入口查看具体原因。
      </p>
      <p v-else class="muted">本次工作区读取未返回受限能力；各项操作仍以执行时的实际授权为准。</p>
    </section>
    <section class="panel cognition-note">
      <NTag size="small">设计中</NTag>
      <div>
        <h3>统一认知</h3>
        <p class="muted">
          跨会话连续自我与认知关系网络仍在设计中。当前可查看各会话已有的自我、记忆与行动记录。
        </p>
      </div>
    </section>
  </div>
</template>
