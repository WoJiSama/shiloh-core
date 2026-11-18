<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert } from 'naive-ui'
import { capability } from '../lib/workspace'
import { statusLabel } from '../lib/workspaceModel'
const props = defineProps<{ operation: string }>()
const state = computed(() => capability(props.operation))
const opened = ref(false)
watch(
  state,
  (value) => {
    if (value.status === 'available') opened.value = true
  },
  { immediate: true }
)
</script>
<template>
  <NAlert
    v-if="state.status !== 'available'"
    :type="state.status === 'restart-required' ? 'warning' : 'info'"
    :title="statusLabel(state.status)"
  >
    {{ state.reason || '当前身份无法使用这项能力。' }}
  </NAlert>
  <div
    v-if="opened"
    :inert="state.status !== 'available'"
    :hidden="state.status === 'forbidden' || state.status === 'unavailable'"
  >
    <slot />
  </div>
</template>
