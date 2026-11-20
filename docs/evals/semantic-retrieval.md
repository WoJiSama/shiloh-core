# Core 语义检索离线评估

v2 评估使用固定语料、固定问题和显式指定的相关原消息，调用独立 Core 的 `createAgentSemanticMemory().read()`。来源权限、查询权限、排序、重排、topK 与上下文裁剪均经过实际读取路径。评估不连接机器人 Redis，不读取宿主配置，不生成随机问题，也不发送 QQ 消息。

报告中的上下文指该读取入口返回的语义记忆文本。它不覆盖随后整个提示词的装配、模型回答或 QQ 投递；这些环节需要各自的集成与效果验证。

## 运行

源码仓库先构建后端；独立发布包已包含编译产物、工具和默认数据集。

```sh
npm run backend:build
node scripts/semantic-memory-eval.mjs --help
node scripts/semantic-memory-eval.mjs \
  --dataset tests/fixtures/semantic-retrieval-benchmark.v2.json \
  --output /tmp/core-retrieval-v2.json
```

`npm run eval:memory -- --output /tmp/core-retrieval-v2.json` 是同一工具的快捷入口。默认后端是确定性合成后端，只用于验证评估流程与回归，输出不构成真实 embedding 或 rerank 的质量证据。

工具默认使用新建客户端隔离查询缓存。需要单独观察预热后的结果时显式运行：

```sh
node scripts/semantic-memory-eval.mjs \
  --cache warm-client \
  --output /tmp/core-retrieval-v2-warm.json
```

客户端隔离不代表远端服务缓存已清空。预热耗时与被测查询耗时分开，不能将冷、热条件混为一个延迟分位数。

## 数据集与实验条件

默认数据集位于 [`tests/fixtures/semantic-retrieval-benchmark.v2.json`](../../tests/fixtures/semantic-retrieval-benchmark.v2.json)。`schemaVersion` 为 2，`id` 与 `revision` 标识基准，`clockAt` 固定保留期与时间判断。修改语料、问题、权限条件或标准证据时应更新 revision。

- `scopes` 声明 Agent、完整会话地址、私聊本人及原消息。撤回、遗忘、停用等状态是固定实验输入。
- `queries` 声明查询会话、问题、相关证据和禁止来源。证据按作用域与原消息 ID 联合定位，重复消息 ID 不会跨群或账号混同。
- `profiles.production` 使用要验证的 Core 配置；默认对应 topK 5、最低向量分数 0.35、1000ms 读取预算。
- `profiles.comparison` 明确算法对比条件。向量、BM25、混合、混合加重排从同一批授权语料独立产生候选。比较配置的结果不能直接冒充生产上下文表现。

数据集包含正常相关证据、多条证据、无答案、时间更正及来源隔离等场景。标准证据表示需要取回的原文；即使取回了更正记录，也仍须单独验证最终回答是否理解了更正。本工具不评价整段模型回答。

随附数据集是为回归编写的小型合成场景，没有真实用户查询的代表性证明。要判断业务质量，应另行审阅并冻结具有代表性的查询与标准证据，保留无答案和失败案例，再使用真实模型运行。

语料向量准备在被测查询之前单独进行；禁止来源不会送入准备阶段的模型。每次查询使用冻结的隔离存储，写操作直接拒绝。报告保存输入与准备后语料指纹，并检查读取前后状态未改变。

## 读取报告

报告包含 `schemaVersion: 2`、`runtime: core`、方法、数据集与语料指纹、后端身份、模型元数据、配置、时钟、缓存条件及逐查询结果。

理解结果时需要分别看：

- **检索命中和证据召回**：是否取回任何一条相关证据，以及取回多少条标准证据。候选排序、topK 选择和最终上下文是不同阶段。Hit@k 和 EvidenceRecall@k 使用实际选择的 topK；`effectiveTopK` 为 5 时，@10 也最多评价这 5 条，不表示曾输出 10 条。
- **上下文完整覆盖**：仅计实际投影中完整保留的原消息；被 5000 字预算截掉或只保留一部分的证据不会算完整覆盖。
- **无答案与禁止来源**：没有标准证据时，是否确实返回空上下文；撤回、错误人物、错误会话等来源是否进入结果。
- **失败与回退**：超时、异常、缺少有效向量、重排未提供或回退均单独记录。查询失败保留在分母中，不能作为正确拒答。
- **逐模式延迟**：每个模式各自计时，语料准备和预热另行记录。合成后端耗时不能代表模型服务或生产端到端延迟。

比较两次运行前，应确认数据集与语料指纹、方法、配置、后端/模型版本及缓存条件一致。服务端同名模型发生变化时，应在后端 metadata 的 revision 中记录实际版本。

CLI 先验证编译产物及来源指纹，拒绝缺失或过期的构建；报告的 `implementation` 保存构建清单哈希、提交与编译环境。未提交的改动也由清单指纹区分，不能仅凭提交号判断运行字节相同。

## 使用真实模型

工具只有在显式传入 `--backend` 时才加载外部后端。模块导出 `metadata` 和 `createBackend()`，工厂返回带稳定向量空间 `id` 的 `AgentSemanticMemoryBackend`；每次实验独立创建并释放客户端。

仓库提供 [`scripts/examples/semantic-evaluation-backend.mjs`](../../scripts/examples/semantic-evaluation-backend.mjs)，复用 Core 的模型后端。通过专用环境变量提供评估端点、模型与凭据：

```sh
export BL_EVAL_EMBEDDING_URL='https://embedding.example.com/v1/embeddings'
export BL_EVAL_EMBEDDING_MODEL='your-embedding-model'
# BL_EVAL_EMBEDDING_KEY 从评估环境注入
# 可选重排需要同时提供 BL_EVAL_RERANK_URL / MODEL / KEY
export BL_EVAL_MODEL_REVISION='your-model-revision'
node scripts/semantic-memory-eval.mjs \
  --backend scripts/examples/semantic-evaluation-backend.mjs \
  --output /tmp/core-retrieval-real-v2.json
```

显式选择该后端会把数据集中的获准语料和查询发送到声明的模型服务。请使用已审阅的数据集；默认命令始终使用合成后端。报告不包含 API key。

## Core 群聊会议改期回放

复用本页固定语料的会议原话和检索参数。回放通过 Core 的群文字消息入口写入原定安排、改期和地点，等待后台索引，再逐轮询问现行安排和原定安排，通过 QQ 撤回事件收回唯一的改期消息，最后再次询问现行安排。每轮保存实际召回的来源、模型请求中的更正可见状态、历史查询次数和测试发送适配器收到的正文。

```sh
npm run backend:build
BL_MEMORY_REPLAY_REPORT=/tmp/bl-meeting-scripted.json \
  node --test --test-name-pattern='Core meeting-time replay' tests/agentSemanticRuntime.test.js
```

脚本模式使用隔离 `redis-server`、合成嵌入与重排、脚本化回复，撤回后额外调用 `chatHistoryTool`，验证它仍能读取原定消息。`BL_MEMORY_REPLAY_MODEL` 显式指定回答模型时，在三个独立存储中各跑一遍同样的序列；嵌入与重排仍使用合成后端，真实模型只处理这组合成对话。Chat Completions 服务地址由 `BL_MEMORY_REPLAY_BASE_URL` 指定，凭据从 `BL_MEMORY_REPLAY_API_KEY` 注入。省略地址时使用 OpenAI 的默认地址，可沿用 `OPENAI_API_KEY`。

```sh
# 评估环境事先设置 BL_MEMORY_REPLAY_API_KEY，按需设置 BL_MEMORY_REPLAY_BASE_URL
BL_MEMORY_REPLAY_MODEL='your-chat-model' BL_MEMORY_REPLAY_REPORT=/tmp/bl-meeting-live.json \
  node --test --test-name-pattern='Core meeting-time replay' tests/agentSemanticRuntime.test.js
```

人工核对发送适配器收到的正文。现行安排应为周三下午两点，原定安排应为周一上午九点。撤回后的回复应明确说明现行时间无法确认，提及周一时须标明是原定。模型访问失败计入失败。实模回放须收到模型的有效返回，正确回复应满足上述语义。回放范围为隔离 Core 群文字、固定检索条件和所记录的回答模型。

2026-11-19 的[归档证据](../replays/2026-11-19-meeting-reschedule/evidence.json)包含基线与候选的实际正文、来源、模型调用、脚本历史查询及 v2 检索对照。回答模型为本地 Qwen2.5-3B-Instruct Q4_K_M，GGUF 指纹见归档。对照使用 llama.cpp b12122 的 `--ctx-size 4096 --parallel 1 --jinja`，生成温度为 0，最多输出 512 个 token。复跑基线行为可在同一源码快照的独立副本中移除普通文字 `buildSystemPrompt` 调用的 `useHistoricalEvidence` 参数，然后重建并执行同样的回放。

## 旧评估与控制台历史

旧插件曾从分块临时生成问题，再把混合检索后的结果重新排序为“纯向量”，并合计普通检索与重排耗时；启用记忆演化时还会改变记忆强度。这些历史数字标为 `legacy-v1`，不能代表当前 Core，也不能与 v2 直接画成质量趋势。旧在线评估命令和按钮仅提供迁移指引；查询、重建和历史查看继续保留。

v2 默认将 JSON 输出到标准输出，使用 `--output FILE` 时才写报告文件。需要保存 NDJSON 历史时显式使用 `--history FILE`；工具不会自行发现或写入运行中的历史目录。控制台将 v2 与旧历史分开展示，缺失指标保持缺失。
