<script setup lang="ts">
import { NAlert, NTag } from 'naive-ui'
import { accountLabel } from '../lib/workspaceModel'
import { configurationScopeKey, type ConfigurationPreview } from '../lib/workspaceChangeModel'
defineProps<{ value: ConfigurationPreview; expired?: boolean }>()
const files = { host: '宿主配置', personas: '人设库', bindings: '本人、连接与会话绑定' }
const modes = {
  text: '群文字',
  simulation: '群仿真',
  private: '私聊',
  'private-disabled': '私聊未启用'
}
const json = (value: unknown) => JSON.stringify(value, null, 2)
</script>
<template>
  <section class="candidate-preview page-stack" aria-label="服务端配置预览">
    <NAlert :type="expired ? 'warning' : 'info'" :show-icon="false">
      {{
        expired
          ? '此候选已过期，请重新读取配置并预览。'
          : '以下是服务端候选。确认提交后写入配置，重启后生效。'
      }}
      <p>有效至 {{ new Date(value.expiresAt).toLocaleString('zh-CN', { hour12: false }) }}</p>
    </NAlert>
    <section class="panel">
      <h3>影响范围与权限</h3>
      <p class="field-help">
        提交后整个宿主等待重启，已有会话的绑定版本与授权须重新核验。以下范围由服务端返回。
      </p>
      <p v-for="id in value.affected.agents" :key="id">本人标识 · {{ id }}</p>
      <p
        v-for="connection in value.affected.connections"
        :key="connection.id"
        class="candidate-source"
      >
        连接 {{ connection.id }} · 账号 {{ accountLabel(connection.account) }}
      </p>
      <article
        v-for="row in value.affected.conversations"
        :key="configurationScopeKey(row)"
        class="candidate-scope"
      >
        <strong>本人标识 · {{ row.agentId }}</strong>
        <p class="candidate-source">
          连接 {{ row.connectionId }} · 账号 {{ accountLabel(row.target.account) }} ·
          {{ row.target.kind === 'group' ? '群聊' : '私聊' }} {{ row.target.id }}
        </p>
        <template
          v-for="permission in value.permissions.filter(
            (item) => item.scopeKey === configurationScopeKey(row)
          )"
          :key="permission.scopeKey"
        >
          <NTag size="small">{{ modes[permission.mode] }}</NTag>
          <p>工具：{{ permission.tools.length ? permission.tools.join('、') : '未列出工具' }}</p>
          <p class="field-help">{{ permission.note }}</p>
        </template>
        <p
          v-if="!value.permissions.some((item) => item.scopeKey === configurationScopeKey(row))"
          class="field-help"
        >
          已有会话：本次不新增授权，重启后按当前绑定重新核验权限。
        </p>
      </article>
      <p v-if="!value.permissions.length" class="field-help">
        本次不新增会话或会话权限。创建后可到连接页为本人配置接入。
      </p>
    </section>
    <section class="panel">
      <h3>字段差异</h3>
      <article v-for="(change, index) in value.changes" :key="index" class="candidate-change">
        <div class="panel-heading">
          <strong>{{ files[change.file] }}</strong
          ><NTag size="small">{{ change.action === 'add' ? '新增' : '修改' }}</NTag>
        </div>
        <code>{{ change.path }}</code>
        <div class="candidate-diff">
          <div>
            <h4>变更前</h4>
            <pre>{{ json(change.before) }}</pre>
          </div>
          <div>
            <h4>变更后</h4>
            <pre>{{ json(change.after) }}</pre>
          </div>
        </div>
      </article>
    </section>
    <details class="technical-details">
      <summary>候选与完整读取版本</summary>
      <dl>
        <dt>候选</dt>
        <dd>{{ value.previewId }}</dd>
        <dt>候选摘要</dt>
        <dd>{{ value.candidateDigest }}</dd>
        <dt>配置版本</dt>
        <dd>{{ value.revision }}</dd>
        <dt>进程</dt>
        <dd>{{ value.processEpoch }}</dd>
        <dt>宿主配置</dt>
        <dd>{{ value.readSet.host }}</dd>
        <dt>人设库</dt>
        <dd>{{ value.readSet.personas }}</dd>
        <dt>绑定</dt>
        <dd>{{ value.readSet.bindings }}</dd>
      </dl>
    </details>
  </section>
</template>
