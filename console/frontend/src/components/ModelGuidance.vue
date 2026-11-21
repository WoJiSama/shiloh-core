<script setup lang="ts">
import type { ModelSelectionGuidance } from '../lib/modelGuidance'

defineProps<{ guidance: ModelSelectionGuidance }>()
</script>

<template>
  <div class="model-guidance">
    <p>{{ guidance.purpose }}</p>
    <p><strong>建议选择 {{ guidance.tier }}</strong>。{{ guidance.criteria }}</p>
  </div>
</template>

<style scoped>
.model-guidance {
  display: grid;
  gap: 5px;
  border-inline-start: 2px solid var(--c-border);
  padding-inline-start: 12px;
  color: var(--c-muted);
  font-size: 13px;
  line-height: 1.6;
}
.model-guidance p {
  margin: 0;
}
.model-guidance strong {
  color: var(--c-text);
}
</style>
