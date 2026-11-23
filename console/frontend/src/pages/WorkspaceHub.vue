<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import { ArrowUpRight } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import HostRestartButton from '../components/HostRestartButton.vue'
import HostReadiness from '../components/HostReadiness.vue'
import WorkspaceTraffic from '../components/WorkspaceTraffic.vue'
import { workspace, capability, configurationLabel } from '../lib/workspace'
import { workspaceFeatureEntries, workspaceFeaturePath } from '../lib/navigation'
import { statusLabel } from '../lib/workspaceModel'
const props = defineProps<{ section: 'features' | 'resources' | 'runtime' | 'system' }>()
const data = workspace.data
const titles = {
  features: ['功能'],
  resources: ['资源库', '可复用的人设、模型与创作资源。资源与引用它的机器人分别管理。'],
  runtime: ['运行中心', '查看现有任务、真实记录与实例用量。执行未知不计作成功。'],
  system: ['系统', '核对服务配置、管理能力与授权边界。']
}
const entries = computed(() => workspaceFeatureEntries('/' + props.section))
</script>
<template>
  <div class="page-stack">
    <PageHeader :title="titles[section][0]" :description="titles[section][1]" />
    <section v-if="section === 'system' && data" class="panel">
      <div class="panel-heading">
        <h2>配置与执行</h2>
        <NTag :type="data.configState.requiresRestart ? 'warning' : 'success'">{{
          configurationLabel()
        }}</NTag>
      </div>
      <p class="field-help">配置保存后需重启服务。结果未知时保留草稿，禁止重复保存。</p>
      <HostRestartButton v-if="!data.configState.requiresRestart" />
      <HostReadiness />
      <details class="technical-details">
        <summary>技术详情</summary>
        <dl>
          <dt>进程版本</dt>
          <dd>{{ data.configState.processEpoch }}</dd>
          <dt>已加载</dt>
          <dd>{{ data.configState.loadedRevision }}</dd>
          <dt>磁盘配置</dt>
          <dd>{{ data.configState.storedRevision || '暂时无法核对' }}</dd>
        </dl>
      </details>
    </section>
    <div class="resource-grid">
      <RouterLink
        v-for="[feature, item] in entries"
        :key="feature"
        :to="workspaceFeaturePath(feature)"
        class="panel resource-card"
        ><div class="panel-heading">
          <h2>{{ item.label }}</h2>
          <ArrowUpRight :size="18" />
        </div>
        <p>{{ item.hint }}</p>
        <NTag
          size="small"
          :type="capability(item.operation).status === 'available' ? 'success' : 'default'"
          >{{ statusLabel(capability(item.operation).status) }}</NTag
        ><small v-if="capability(item.operation).status !== 'available'">{{
          capability(item.operation).reason
        }}</small></RouterLink
      >
    </div>
    <WorkspaceTraffic v-if="section === 'runtime'" />
    <section v-if="section === 'system'" class="panel">
      <h2>能力与授权</h2>
      <p class="field-help">
        能力可见性与实际操作授权分别校验。会话操作始终绑定完整会话地址与当前版本。
      </p>
      <div v-for="item in data?.capabilities" :key="item.operation" class="capability-row">
        <span class="row-main"
          ><code>{{ item.operation }}</code
          ><small
            >{{ item.scope === 'conversation' ? '会话范围' : '实例范围' }} ·
            {{ item.effect === 'write' ? '修改' : '读取'
            }}<template v-if="item.reason">
              · {{ capability(item.operation).reason }}</template
            ></small
          ></span
        ><NTag size="small">{{ statusLabel(capability(item.operation).status) }}</NTag>
      </div>
    </section>
  </div>
</template>
