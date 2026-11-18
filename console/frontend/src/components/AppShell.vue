<script setup lang="ts">
import LegacyAppShell from './LegacyAppShell.vue'
import WorkspaceShell from './WorkspaceShell.vue'
import { workspace } from '../lib/workspace'
defineProps<{ appearance: string }>()
defineEmits<{ theme: []; logout: [] }>()
const mode = workspace.mode
</script>
<template>
  <WorkspaceShell
    v-if="mode === 'standalone'"
    :appearance="appearance"
    @theme="$emit('theme')"
    @logout="$emit('logout')"
  />
  <LegacyAppShell
    v-else
    :appearance="appearance"
    @theme="$emit('theme')"
    @logout="$emit('logout')"
  />
</template>
