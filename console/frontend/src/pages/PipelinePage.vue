<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NSelect, NTag, NEmpty, NDrawer, NDrawerContent } from 'naive-ui'
import { RefreshCw, ArrowUpRight } from 'lucide-vue-next'
import SchemaPage from './SchemaPage.vue'
import { capability } from '../lib/workspace'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'
import IdentityLabel from '../components/IdentityLabel.vue'
import { workspaceRobotLabel } from '../lib/workspaceNames'
import {
  parsePipelineSnapshot,
  pipelineAccountLabel,
  pipelineConversationLabel,
  pipelineDuration,
  pipelineEffectNames,
  pipelineEffectStates,
  pipelineStateLabel,
  pipelineStatusOptions,
  pipelineTime,
  type PipelineJob,
  type PipelineMode,
  type PipelineSnapshot
} from '../lib/standalonePipeline'
const tab = ref('jobs'),
  loading = ref(false),
  error = ref(''),
  data = ref<PipelineSnapshot | null>(null),
  mode = ref<PipelineMode>('unknown'),
  kind = ref('all'),
  status = ref('all'),
  detail = ref<PipelineJob | null>(null)
const kinds = [
  { label: '全部类型', value: 'all' },
  { label: '消息事件', value: 'event' },
  { label: '媒体交付', value: 'delivery' }
]
const statuses = computed(() => pipelineStatusOptions(mode.value))
const settingsAvailable = computed(() => mode.value === 'legacy' ||
  mode.value === 'standalone' && capability('config.read').status === 'available')
const settingsVisited = ref(false)
const legacyDetail = computed(() =>
  detail.value?.mode === 'legacy'
    ? Object.entries(detail.value).filter(([key]) => key !== 'mode')
    : []
)
const eventNames = { message: '消息', recall: '撤回', nudge: '戳一戳' }
const queueNames = {
  private: '私聊',
  group: '群聊',
  simulation: '主动消息',
  privacy: '隐私指令',
  'group-log': '群消息记录'
}
let abort: AbortController | null = null,
  seq = 0
async function load() {
  detail.value = null
  if (!statuses.value.some((option) => option.value === status.value)) status.value = 'all'
  const current = ++seq
  abort?.abort()
  abort = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await api<unknown>(
      `/api/pipeline/jobs?kind=${kind.value}&status=${status.value}&limit=100`,
      { signal: abort.signal }
    )
    if (current !== seq) return
    const snapshot = parsePipelineSnapshot(result)
    data.value = snapshot
    mode.value = snapshot.mode
    if (!statuses.value.some((option) => option.value === status.value)) status.value = 'all'
  } catch (e) {
    if (current === seq && (e as Error).name !== 'AbortError') {
      data.value = null
      error.value = (e as Error).message
    }
  } finally {
    if (current === seq) loading.value = false
  }
}
function select(value: string) {
  detail.value = null
  if (value === 'settings') settingsVisited.value = true
  tab.value = value
  if (value === 'jobs' && !data.value && !loading.value) load()
}
onMounted(load)
onBeforeUnmount(() => {
  seq++
  abort?.abort()
})
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="消息与搬运"
      eyebrow="消息与运行"
      :description="
        mode === 'standalone'
          ? '查看未确认消息和媒体交付记录，按完整会话身份核对持久化状态。'
          : '配置消息处理和平台授权，追踪持久任务的交付结果。'
      "
      ><template #actions
        ><NButton v-if="tab === 'jobs'" :loading="loading" @click="load"
          ><template #icon><RefreshCw :size="16" /></template>刷新记录</NButton
        ></template
      ></PageHeader
    >
    <div v-if="settingsAvailable" class="task-tabs" role="tablist" aria-label="消息与搬运">
      <button role="tab" :aria-selected="tab === 'settings'" @click="select('settings')">
        策略与授权</button
      ><button role="tab" :aria-selected="tab === 'jobs'" @click="select('jobs')">任务记录</button>
    </div>
    <div v-if="settingsAvailable && (mode === 'legacy' || settingsVisited)" v-show="tab === 'settings'">
      <SchemaPage kind="pipeline" embedded />
    </div>
    <section v-if="tab === 'jobs'" class="page-stack">
      <div class="toolbar">
        <NSelect
          v-model:value="kind"
          :options="kinds"
          style="width: 160px"
          aria-label="任务类型"
          @update:value="load"
        /><NSelect
          v-model:value="status"
          :options="statuses"
          :disabled="mode === 'unknown'"
          style="width: 230px"
          aria-label="任务状态"
          @update:value="load"
        /><span v-if="data" class="muted">本次查询 {{ data.returned }} 条 · 最多展示 100 条</span>
      </div>
      <NAlert type="info" :show-icon="false"
        >任务状态为最后持久化结果，待处理状态不能证明 worker 当前存活。结果未知或不确定的任务不会自动重发，请先核对会话中的实际消息。<span
          v-if="data?.scanTruncated"
          >本次读取达到上限，结果可能不完整。</span
        ></NAlert
      ><PageState :loading="loading" :error="error" @retry="load"
        ><div class="panel">
          <NEmpty v-if="!data?.jobs?.length" description="当前筛选没有留存任务" />
          <div v-else class="jobs-list">
            <button
              v-for="job in data.jobs"
              :key="JSON.stringify([job.kind, job.id, job.mode === 'standalone' ? job.scopeKey : ''])"
              :data-job-id="job.id"
              class="job-row"
              @click="detail = job"
            >
              <div>
                <span class="job-title"
                  >{{ job.kind === 'delivery' ? '媒体交付' : '消息事件'
                  }}<NTag
                    size="small"
                    :type="
                      ['failed', 'uncertain', 'unknown'].includes(job.state)
                        ? 'error'
                        : job.state === 'sent' || job.state === 'completed'
                          ? 'success'
                          : 'default'
                    "
                    >{{ pipelineStateLabel(job) }}</NTag
                  ></span
                ><template v-if="job.mode === 'standalone'">
                  <span class="muted job-identity"
                    >Agent {{ workspaceRobotLabel(job.agentId) }} · 连接 {{ job.connectionId }}</span
                  ><span class="muted job-identity"
                    >账号 {{ pipelineAccountLabel(job) }} · {{ pipelineConversationLabel(job) }}</span
                  ><span v-if="job.kind === 'event'" class="muted"
                    >{{ queueNames[job.queue] }}队列 · {{ eventNames[job.eventKind] }} · 尚未确认</span
                  ><span v-else class="muted">来源 {{ job.provider }}</span>
                </template>
                <span v-else class="muted"
                  >{{ job.platform || '消息' }} · 机器人
                  <IdentityLabel kind="bot" :id="job.botId || ''" /> · 群
                  <IdentityLabel kind="group" :id="job.groupId || ''" /></span
                ><span v-if="job.mode === 'legacy' && job.lastError" class="job-error">{{ job.lastError }}</span>
              </div>
              <div v-if="job.mode === 'standalone' && job.kind === 'event'" class="job-time">
                <small>{{ job.occurredAt === undefined ? '未记录事件时间' : pipelineTime(job.occurredAt) }}</small>
              </div>
              <div v-else class="job-time">
                <small>{{ pipelineTime(job.updatedAt) }}</small
                ><small v-if="job.attempts !== undefined"
                  >{{ job.attempts }} 次{{ job.mode === 'standalone' ? '准备' : '尝试' }}</small
                >
              </div>
              <ArrowUpRight :size="16" />
            </button>
          </div>
        </div>
        <div v-if="data?.mode === 'standalone'" class="pipeline-retention field-help">
          <p>
            Inbox 仅包含未确认事件；文本会话队列空闲
            {{ pipelineDuration(data.retention.textQueueIdleSeconds) }} 后清理。记录消失不能证明发送成功。
          </p>
          <p>
            媒体记录自最后一次持久写入起保留
            {{ pipelineDuration(data.retention.mediaRecordIdleSeconds) }}，任务执行期限为创建后
            {{ pipelineDuration(data.retention.mediaTaskLifetimeSeconds) }}；执行截止时间不是记录过期时间。
            准备次数不代表发送次数。
          </p>
          <p>本次读取 {{ pipelineTime(data.observedAt) }} · 最多展示 100 条留存记录</p>
        </div>
        <p v-else-if="data?.mode === 'legacy'" class="field-help">
          配置中的保留时间：事件 {{ data.retention.eventMinutes }} 分钟，交付
          {{ data.retention.deliveryHours }} 小时；当前运行实例可能使用此前配置。仅查询 TTL
          窗口内的留存记录，任务更新时刷新保留时间，过期记录不计入历史累计。
        </p></PageState
      >
    </section>
    <NDrawer
      :show="Boolean(detail)"
      :width="'min(520px, calc(100vw - 20px))'"
      @update:show="!$event && (detail = null)"
      ><NDrawerContent title="任务详情" closable
        ><template v-if="detail?.mode === 'standalone'">
          <dl class="detail-list">
            <dt>任务 ID</dt><dd>{{ detail.id }}</dd>
            <dt>类型</dt><dd>{{ detail.kind === 'event' ? '未确认消息事件' : '媒体交付' }}</dd>
            <dt>最后持久化状态</dt><dd>{{ pipelineStateLabel(detail) }}</dd>
            <dt>Agent</dt><dd>{{ workspaceRobotLabel(detail.agentId) }}</dd>
            <dt>连接</dt><dd>{{ detail.connectionId }}</dd>
            <dt>账号（平台 / 命名空间 / ID）</dt><dd>{{ pipelineAccountLabel(detail) }}</dd>
            <dt>会话</dt><dd>{{ pipelineConversationLabel(detail) }}</dd>
            <template v-if="detail.kind === 'event'">
              <dt>队列</dt><dd>{{ queueNames[detail.queue] }}</dd>
              <dt>事件</dt><dd>{{ eventNames[detail.eventKind] }}</dd>
              <dt>事件时间</dt><dd>{{ pipelineTime(detail.occurredAt) }}</dd>
            </template>
            <template v-else>
              <dt>媒体来源</dt><dd>{{ detail.provider }}</dd>
              <dt>创建时间</dt><dd>{{ pipelineTime(detail.createdAt) }}</dd>
              <dt>最后持久写入</dt><dd>{{ pipelineTime(detail.updatedAt) }}</dd>
              <dt>执行截止时间</dt><dd>{{ pipelineTime(detail.expiresAt) }}</dd>
              <dt>准备次数</dt><dd>{{ detail.attempts }}（不是发送次数）</dd>
              <dt>准备失败次数</dt><dd>{{ detail.prepareFailures }}</dd>
              <dt>下次准备时间</dt><dd>{{ detail.nextRetryAt ? pipelineTime(detail.nextRetryAt) : '未安排' }}</dd>
            </template>
          </dl>
          <p v-if="detail.kind === 'event'" class="field-help">
            此记录尚未确认；确认后不再出现在 Inbox 中，不能据此判断发送结果。
          </p>
          <template v-else>
            <h3 class="effect-heading">交付步骤</h3>
            <p v-if="!detail.effects.length" class="field-help">尚无持久化的发送步骤。</p>
            <ol v-else class="effect-list">
              <li v-for="(effect, index) in detail.effects" :key="index">
                <div><strong>{{ pipelineEffectNames[effect.effect] }}</strong><span>{{ pipelineEffectStates[effect.state] }}</span></div>
                <small>开始 {{ pipelineTime(effect.beganAt) }}</small>
                <small v-if="effect.finishedAt !== undefined">结束 {{ pipelineTime(effect.finishedAt) }}</small>
              </li>
            </ol>
            <p class="field-help">执行截止时间不是记录过期时间；结果未知不会自动重发。</p>
          </template>
        </template>
        <dl v-else-if="detail?.mode === 'legacy'" class="detail-list">
          <template v-for="[key, value] in legacyDetail" :key="key"
            ><dt>{{ key }}</dt>
            <dd>
              <IdentityLabel
                v-if="key === 'botId' || key === 'groupId'"
                :kind="key === 'botId' ? 'bot' : 'group'"
                :id="String(value || '')"
              />
              <template v-else>{{
                ['createdAt', 'updatedAt', 'nextRetryAt', 'leaseUntil'].includes(String(key))
                  ? pipelineTime(Number(value))
                  : value
              }}</template>
            </dd></template
          >
        </dl></NDrawerContent
      ></NDrawer
    >
  </div>
</template>
<style scoped>
.job-row {
  display: flex;
  gap: 16px;
  align-items: center;
  text-align: left;
  width: 100%;
  padding: 18px 0;
  color: var(--c-text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--c-border);
}
.job-row:last-child {
  border-bottom: 0;
}
.job-row > div:first-child {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}
.job-title {
  display: flex;
  gap: 10px;
  align-items: center;
  font-weight: 500;
}
.job-row .muted {
  font-size: 12px;
}
.job-identity {
  overflow-wrap: anywhere;
}
.pipeline-retention p {
  margin: 8px 0;
}
.effect-heading {
  margin: 28px 0 12px;
  font-size: 14px;
}
.effect-list {
  display: grid;
  gap: 16px;
  padding-left: 20px;
}
.effect-list li > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.effect-list small {
  display: block;
  margin-top: 5px;
  color: var(--c-muted);
}
.job-error {
  font-size: 12px;
  color: var(--c-danger);
  overflow-wrap: anywhere;
}
.job-time {
  display: grid;
  gap: 5px;
  color: var(--c-muted);
  text-align: right;
}
@media (max-width: 600px) {
  .job-row {
    flex-wrap: wrap;
  }
  .job-time {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
  }
  .job-row > svg {
    display: none;
  }
}
</style>
