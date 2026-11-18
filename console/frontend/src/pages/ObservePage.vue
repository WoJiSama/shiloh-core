<script setup lang="ts">
import PageState from '../components/PageState.vue'
import StandaloneObserve from '../components/StandaloneObserve.vue'
import LegacyObservePage from './LegacyObservePage.vue'
import { workspace } from '../lib/workspace'

const mode = workspace.mode
async function retry() {
  await workspace.load().catch(() => {})
}
</script>

<template>
  <StandaloneObserve v-if="mode === 'standalone'" />
  <LegacyObservePage v-else-if="mode === 'legacy'" />
  <PageState
    v-else
    :loading="!workspace.error.value"
    :error="workspace.error.value"
    @retry="retry"
  />
</template>
