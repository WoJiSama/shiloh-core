<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { workspace } from '../lib/workspace'
import { workspaceFeatures, type WorkspaceFeature } from '../lib/navigation'
import CapabilityGate from '../components/CapabilityGate.vue'
import SchemaPage from './SchemaPage.vue'
import WorkspaceConnections from './WorkspaceConnections.vue'
const props = defineProps<{ feature: WorkspaceFeature }>()
const mode = workspace.mode
const components = {
  persona: defineAsyncComponent(() => import('./PersonaPage.vue')),
  ai: defineAsyncComponent(() => import('./AiPage.vue')),
  draw: defineAsyncComponent(() => import('./DrawPage.vue')),
  games: defineAsyncComponent(() => import('./GamesPage.vue')),
  simulation: defineAsyncComponent(() => import('./SimulationPage.vue')),
  'person-profiles': defineAsyncComponent(() => import('./PersonProfilesPage.vue')),
  trusteeship: defineAsyncComponent(() => import('./TrusteeshipPage.vue')),
  observe: defineAsyncComponent(() => import('./ObservePage.vue')),
  tokens: defineAsyncComponent(() => import('./TokensPage.vue')),
  pipeline: defineAsyncComponent(() => import('./PipelinePage.vue')),
  life: defineAsyncComponent(() => import('./LifePage.vue')),
  style: defineAsyncComponent(() => import('./StylePage.vue')),
  semantic: defineAsyncComponent(() => import('./SemanticPage.vue')),
  commands: defineAsyncComponent(() => import('./CommandsPage.vue')),
  conversation: defineAsyncComponent(() => import('./ConversationPage.vue')),
  risk: defineAsyncComponent(() => import('./SchemaPage.vue')),
  'group-admin': defineAsyncComponent(() => import('./GroupAdminPage.vue')),
  groups: defineAsyncComponent(() => import('./GroupsPage.vue'))
}
const feature = computed(() => workspaceFeatures[props.feature])
const groupLabels: Record<string, string> = {
  '/resources': '资源库',
  '/runtime': '运行中心',
  '/system': '系统',
  '/connections': '连接',
  '/robots': '机器人'
}
</script>
<template>
  <template v-if="mode === 'standalone'"
    ><div class="feature-breadcrumb">
      <RouterLink :to="feature.group">← 返回{{ groupLabels[feature.group] }}</RouterLink>
    </div>
    <WorkspaceConnections v-if="props.feature === 'groups'" /><CapabilityGate
      v-else
      :operation="feature.operation"
      ><SchemaPage v-if="props.feature === 'commands'" kind="dice" /><component
        v-else
        :is="components[props.feature]"
        v-bind="
          props.feature === 'risk' ? { kind: 'riskControl' } : {}
        " /></CapabilityGate></template
  ><component
    v-else
    :is="components[props.feature]"
    v-bind="props.feature === 'risk' ? { kind: 'riskControl' } : {}"
  />
</template>
