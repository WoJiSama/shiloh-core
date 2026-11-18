<script setup lang="ts">
import { workspace } from '../lib/workspace'
import WorkspaceOverview from './WorkspaceOverview.vue'
import BotsPage from './BotsPage.vue'
const mode = workspace.mode
</script>
<template><WorkspaceOverview v-if="mode === 'standalone'" /><BotsPage v-else /></template>
