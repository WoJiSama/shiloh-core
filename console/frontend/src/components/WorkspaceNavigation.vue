<script setup lang="ts">
import { useId } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import {
  workspaceFeatureEntries,
  workspaceNavigation,
  type WorkspaceFeature
} from '../lib/navigation'

defineProps<{
  label: string
  currentPath: string
  activeSection: string
  activeFeature?: WorkspaceFeature
  featureTarget: (feature: WorkspaceFeature) => RouteLocationRaw
}>()
const expanded = defineModel<string | null>('expanded', { required: true })
const id = useId()
const sections = workspaceNavigation.map((section) => ({
  ...section,
  children: workspaceFeatureEntries(section.path)
}))
</script>

<template>
  <nav class="workspace-navigation" :aria-label="label">
    <ul class="workspace-nav-list">
      <li v-for="section in sections" :key="section.path">
        <template v-if="section.children.length">
          <button
            type="button"
            class="workspace-nav-heading"
            :class="{ active: activeSection === section.path }"
            :aria-expanded="expanded === section.path"
            :aria-controls="id + section.path.replace('/', '-')"
            @click="expanded = expanded === section.path ? null : section.path"
          >
            <component :is="section.icon" :size="18" aria-hidden="true" />
            <span>{{ section.label }}</span>
            <ChevronRight class="workspace-nav-chevron" :size="15" aria-hidden="true" />
          </button>
          <ul
            v-show="expanded === section.path"
            :id="id + section.path.replace('/', '-')"
            class="workspace-nav-children"
          >
            <li v-if="section.overviewLabel">
              <RouterLink
                class="workspace-nav-link"
                :to="section.path"
                :aria-current="currentPath === section.path ? 'page' : undefined"
                >{{ section.overviewLabel }}</RouterLink
              >
            </li>
            <li v-for="[feature, item] in section.children" :key="feature">
              <RouterLink
                class="workspace-nav-link"
                :to="featureTarget(feature)"
                :aria-current="activeFeature === feature ? 'page' : undefined"
                >{{ item.label }}</RouterLink
              >
            </li>
          </ul>
        </template>
        <RouterLink
          v-else
          class="workspace-nav-heading"
          :to="section.path"
          :aria-current="currentPath === section.path ? 'page' : undefined"
        >
          <component :is="section.icon" :size="18" aria-hidden="true" />
          <span>{{ section.label }}</span>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.workspace-nav-list,
.workspace-nav-children {
  display: grid;
  gap: 3px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.workspace-nav-heading,
.workspace-nav-link {
  display: flex;
  align-items: center;
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--c-muted);
  text-align: start;
  line-height: 1.4;
}
.workspace-nav-heading {
  min-height: 40px;
  gap: 10px;
  padding: 8px 11px;
  font-size: 14px;
}
.workspace-nav-heading span {
  flex: 1;
}
.workspace-nav-heading:hover,
.workspace-nav-heading[aria-expanded='true'],
.workspace-nav-link:hover {
  background: var(--c-soft);
  color: var(--c-text);
}
.workspace-nav-heading.active {
  color: var(--c-accent);
  font-weight: 600;
}
.workspace-nav-heading.active[aria-expanded='false'],
.workspace-navigation [aria-current='page'] {
  background: var(--c-selected);
  color: var(--c-accent);
  font-weight: 600;
}
.workspace-nav-heading:focus-visible,
.workspace-nav-link:focus-visible {
  outline-offset: -2px;
}
.workspace-nav-chevron {
  transition: transform 0.15s ease;
}
[aria-expanded='true'] > .workspace-nav-chevron {
  transform: rotate(90deg);
}
.workspace-nav-children {
  margin: 4px 0 7px 19px;
  padding-inline-start: 9px;
  border-inline-start: 1px solid var(--c-border);
}
.workspace-nav-link {
  min-height: 34px;
  padding: 6px 10px;
  font-size: 13px;
}
@media (max-width: 850px) {
  .workspace-nav-heading,
  .workspace-nav-link {
    min-height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-nav-chevron {
    transition: none;
  }
}
</style>
