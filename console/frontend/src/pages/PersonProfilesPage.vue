<script setup lang="ts">
import { workspace } from '../lib/workspace'
import type { WorkspaceConversation } from '../lib/workspaceModel'
import LegacyPersonProfilesPage from './LegacyPersonProfilesPage.vue'
import StandaloneProfiles from '../components/StandaloneProfiles.vue'
defineProps<{ conversationScopes?: WorkspaceConversation[]; embedded?: boolean }>()
const mode = workspace.mode
</script>
<template>
  <StandaloneProfiles
    v-if="mode === 'standalone'"
    :conversation-scopes="conversationScopes"
    :embedded="embedded"
  /><LegacyPersonProfilesPage
    v-else
    :conversation-scopes="conversationScopes"
    :embedded="embedded"
  />
</template>
