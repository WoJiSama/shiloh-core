<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { workspace } from '../lib/workspace'
import { workspaceFeatures, type WorkspaceFeature } from '../lib/navigation'
import { robotLocation, selectConversation } from '../lib/workspaceModel'
import CapabilityGate from '../components/CapabilityGate.vue'
import SchemaPage from './SchemaPage.vue'
import WorkspaceConnections from './WorkspaceConnections.vue'
const props = defineProps<{ feature: WorkspaceFeature }>()
const mode = workspace.mode
const route = useRoute()
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
const contextAgent = computed(() =>
  typeof route.query.agentId === 'string'
    ? workspace.data.value?.agents.find((item) => item.id === route.query.agentId)
    : undefined
)
const backTarget = computed(() => {
  const returnTab =
    typeof route.query.returnTab === 'string' &&
    ['home', 'conversations', 'self', 'actions', 'boundaries'].includes(route.query.returnTab)
      ? route.query.returnTab
      : 'home'
  const agent = contextAgent.value
  if (agent) {
    try {
      const selected = selectConversation(agent, route.query)
      const location = robotLocation(agent, returnTab, selected)
      if (
        !selected &&
        typeof route.query.connection === 'string' &&
        agent.conversations.some((row) => row.binding.connectionId === route.query.connection)
      )
        return { path: location.path, query: { connection: route.query.connection } }
      return location
    } catch {
      return robotLocation(agent, returnTab)
    }
  }
  return { path: feature.value.group, query: route.query }
})
const componentProps = computed<Record<string, unknown>>(() => {
  if (props.feature === 'risk') return { kind: 'riskControl' }
  if (props.feature === 'persona') return { initialPersonaId: contextAgent.value?.personaId }
  if (props.feature === 'simulation') {
    return {
      initialScopeKey: typeof route.query.scopeKey === 'string' ? route.query.scopeKey : undefined,
      initialBindingToken:
        typeof route.query.bindingToken === 'string' ? route.query.bindingToken : undefined
    }
  }
  return {}
})
const groupLabels: Record<string, string> = {
  '/resources': '资源库',
  '/runtime': '运行中心',
  '/system': '系统',
  '/connections': '连接',
  '/robots': '机器人'
}
const backLabel = computed(() =>
  backTarget.value.path.startsWith('/robots/') ? '机器人' : groupLabels[feature.value.group]
)
</script>
<template>
  <template v-if="mode === 'standalone'"
    ><div class="feature-breadcrumb">
      <RouterLink :to="backTarget">← 返回{{ backLabel }}</RouterLink>
    </div>
    <WorkspaceConnections v-if="props.feature === 'groups'" /><CapabilityGate
      v-else
      :operation="feature.operation"
      ><SchemaPage v-if="props.feature === 'commands'" kind="dice" /><component
        v-else
        :is="components[props.feature]"
        v-bind="componentProps" /></CapabilityGate></template
  ><component v-else :is="components[props.feature]" v-bind="componentProps" />
</template>
