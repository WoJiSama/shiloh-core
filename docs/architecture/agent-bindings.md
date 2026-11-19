# 角色与会话绑定

在插件的 `config` 目录创建 `agent-bindings.yaml`。`agents` 定义运行角色和它使用的人设 ID，`connections` 声明平台账号，`bindings` 将一个账号下的群聊或私聊交给一个角色。

```yaml
version: 1
agents:
  - id: daily
    personaId: default
  - id: work
    personaId: default
connections:
  - id: qq-main
    platform: qq
    namespace: global
    accountId: '123456789'
  - id: qq-secondary
    platform: qq
    namespace: global
    accountId: '987654321'
bindings:
  - connectionId: qq-main
    kind: group
    conversationId: '111111'
    agentId: daily
  - connectionId: qq-secondary
    kind: private
    conversationId: '222222'
    agentId: daily
  - connectionId: qq-main
    kind: group
    conversationId: '333333'
    agentId: work
```

QQ 群聊的 `conversationId` 填群号，私聊填对方 QQ 号。账号和会话 ID 均填写字符串。人设 ID 可从 `#人设列表` 查看，`default` 使用 `message.yaml` 中的默认人设。角色 ID 用于现有角色状态的分区，建立绑定后应保持稳定。

同一会话最多有一个显式绑定。显式绑定优先于 `persona-library.yaml` 的群、私聊和账号人设规则。没有匹配绑定时沿用原来的规则和状态分区。现有 QQ 登录、群白名单、私聊权限和工具权限继续由原入口处理。

`#当前人设` 会显示本会话实际使用的人设和显式角色。在显式绑定的群内，`#切换人设` 和 `#人设重置` 会提示部署者修改绑定文件。

普通聊天和群聊仿真都读取该文件。保存后，新回合读取新配置。普通聊天的发送和工具执行、仿真回合的动作，以及持久化聊天回合补跑都会核对绑定。主回复、工具续轮、独立文字回复和仿真模型在每次 HTTP 请求前复核原绑定，覆盖兼容重试和备用渠道。换绑后丢弃迟到结果，已发给平台的动作按实际回执结算。配置格式错误或选定的人设缺失时，可在运行日志中定位原因并修复文件。

普通聊天的 TimingGate、仿真唤醒预判和后台人物画像抽取也在调用模型前复核。失效的唤醒预判结果不能推进已读水位，失效的画像结果不能写入人物事实或推进抽取进度。

示例中的两个账号共享 `daily` 角色标识。群内记忆、资料来源和执行权限各自按账号和会话隔离。显式绑定的人物记忆及仿真角色状态使用角色专属分区。

现有 QQ 插件和独立宿主使用相同的人设解析规则。两个角色可以共用同一个人设模板，各自以 `agent:<角色 ID>` 保存角色状态。若人设库已有同名 ID，两个入口都会拒绝该角色绑定。

## 消息与投递

QQ 入口将会话、发送者、正文、点名、引用和附件归一为 `IncomingMessage`。普通聊天用它读取点名和引用元数据，并通过宿主补查引用原文和合并转发。群聊仿真直接从统一消息写入会话缓冲。

`SendMessageAction` 携带目标账号、会话和可选的原回合绑定。仿真文字、点名和引用由 QQ 适配器组装为平台消息段。普通聊天和既有 QQ 工具的原生段经同一个发送适配器兼容，卡片、转发和二进制对象由当前调用持有。宿主出站限流放行时再次检查回合绑定。

带绑定的原生 QQ 工具从入站上下文选定执行账号。改群名片、禁言、戳一戳、撤回等操作在每次调用平台前复核。需要先查成员、消息或 QQ 空间凭据的动作，在查询返回后仍须通过复核；批量操作逐项检查。既有 QQ 工具权限继续适用。

现有 QQ 插件的仿真按本轮可见消息序号读取附图。合并转发、逐张下载与发送给视觉模型前都复核旧回合的绑定。迟到的图片描述从该回合丢弃，成功描述只用于本轮。

适配器返回已确认、明确失败或结果未知。明确拒绝优先于回执中的消息 ID。确认发送需要有效消息 ID，未知结果会停止该回合的后续回复或仿真发送。QQ 历史归档、文件上传及持久媒体交付继续走各自的存储或回执协议。

## 记忆与调度

普通聊天的智能续话、严格模式会话追踪、上一轮摘要、近期话题和互动提示按完整会话地址及显式绑定版本读取。保存绑定文件后，即使重新选回同一角色，也从新会话上下文开始。已排队的续话和追踪判断在调用模型前复核原绑定，批量判断排除已失效的会话，迟到的判断结果不能触发新回合。违禁词在入站和出站使用同一绑定范围中断回复，排队发送在放行时仍受中断约束。无显式绑定的会话继续使用原状态键。

普通 QQ 工具的任务事实、运行状态和去重按原绑定版本及请求者区分。图片生成队列和图片编辑任务记录原绑定和账号，启动恢复时重新核对。旧版未记录绑定的图片任务可由原兼容会话恢复。已有明确投递尝试的图片任务在重启后保留待核实记录，跳过自动补跑。

QQ 私聊近期记录按接收账号和对方 QQ 分区。普通私聊回合和近期记录查询只读取当前账号。旧缓存中带有匹配 `self_id` 的对方发言仍可读取，归属不明的旧条目会随原缓存到期。清除近期私聊记录只清当前账号的分区及可归属旧条目。普通聊天保存的回合备份也按显式角色和完整地址分区，兼容私聊按账号和对方 QQ 保存。

现有 QQ 插件会处理旧版 Yunzai 和 OneBot 的群聊、好友撤回通知，按接收账号、会话及原始消息 ID 撤销相关人物记忆来源。支持归档关闭及当前角色配置读取失败的情形。缺少账号的旧通知只在宿主能确认唯一 QQ 账号时使用该账号。

显式绑定群的委托记忆和仿真群笔记使用角色 ID、平台、命名空间、账号和会话组成的分区键。同一角色修改绑定文件版本后仍能读取这个分区。历史 QQ 群记忆可通过原兼容会话和控制台访问，数据继续留在原键。控制台的托付数据页按会话显示记录，删除操作精确定位到所选分区。

普通聊天自动抽取的实体事实、别名和群内说法同样按角色和完整会话地址保存。已保存的记忆随角色保留，兼容群的自动记忆继续通过原路径读取。独立 Core 的显式教学、工作流和称呼按完整会话地址共享，原插件裸群号数据仍留在原群分区，未自动迁移。人物跨场景召回继续遵守账号、角色和来源规则。

普通聊天的待抽取批次记录原绑定版本，开始抽取、提交模型结果及重启恢复时复核。QQ 的 `#我的记忆`、`#群记忆`、`#搜索记忆` 和清理命令使用当前会话分区。显式绑定群的 `#清空群记忆` 只清当前角色在本群学到的记忆，保留隐私设置，二次确认绑定当时的版本。旧群级禁用与退出设置仍适用于显式绑定。

新建定时承诺保存创建它的角色、连接、人设及会话归属。显式绑定的任务按所属角色和会话列表、计数、取消与续期。到期由负责该平台的宿主领取，通过原账号和会话执行。归属匹配的任务跨配置保存与重启继续生效，每次执行固定当时的绑定版本。原归属失效的任务到期取消，已启动且无法确认结果的任务按原规则记为未知。历史 QQ 承诺在原兼容路径继续执行。若原会话已切为显式角色，旧任务到期取消，群友可向新角色重新托付。

独立宿主按接收账号分别领取到期承诺和续约问询。一个账号等待投递或模型回合时，其他已核验且在线的账号仍可处理任务。同一账号串行执行，各账号沿用同一账本的原子领取、回执和恢复规则。

原 QQ 定时提醒工具也记录登记时的角色、连接、人设和会话归属。相同归属可以跨配置保存和进程重启继续执行。到期时重新解析当前绑定，并在调用附带工具和投递前复核。配置暂不可用或账号离线时保留提醒等待恢复，换绑后的提醒到期取消。原有未记录归属的提醒可在兼容会话继续执行。

仿真唤醒队列与重试记录携带绑定版本。角色切换时，旧的唤醒、未读水位和模型上下文失效，已有群内发言仍可按会话权限查询。收到新角色的消息时，会先等待旧回合释放内存状态，再按接收顺序写入。

新显式绑定使用完整会话地址保存仿真状态。平台、命名空间、账号、会话类型或 ID 不同，未读、收发限频、预算和唤醒各自计算。入站、撤回、戳一戳及到期承诺使用同一地址解析规则。重启后调度从已登记的地址恢复，并核对宿主归属与绑定版本。控制台显示平台原始会话 ID 和账号，操作使用该行的完整地址。

已有 QQ 仿真记录由原账号沿用原群键，保留历史、预算和配置。第二个 QQ 账号需要为同群声明自己的显式绑定，才能使用独立会话。新 QQ 分区可继承原群的启停和预算上限作为默认值，状态及实际花费单独记录。

## 独立 QQ 宿主

独立进程通过 OneBot v11 的正向或反向 WebSocket 处理显式绑定的 QQ 群和好友私聊。群聊默认复用仿真，可选配附图识别、联网搜索与网页文字读取，也可为指定会话启用点名和引用触发的文字回复，以及固定文字提醒和委托记忆。好友私聊支持角色文本对话。普通聊天的 smart 触发、会话追踪、识图、其余插件工具和群管理由 TRSS-Yunzai 入口提供。部署时同一个 QQ 账号下的同一会话由一个入口负责回复。

在现有示例的 `agent-bindings.yaml` 同目录新建 `agent-host.yaml`。以下 `qq-main` 对应示例里的连接，`persona` 定义 `default` 人设，其余人设从同目录的 `persona-library.yaml` 读取。

```yaml
version: 1
instance: qq-agent
dataDir: data/qq-agent
model:
  baseUrl: https://model.example.com/v1
  name: your-tool-capable-model
  apiKeyEnv: BL_AGENT_MODEL_KEY
persona:
  name: 希洛
connections:
  - id: qq-main
    url: ws://127.0.0.1:6700/
    accessTokenEnv: BL_AGENT_QQ_TOKEN
```

省略 `transport` 时使用正向连接。NapCat 使用反向 WebSocket 时，将对应连接改为以下配置，并让 NapCat 的 WebSocket 客户端连接该地址，使用相同 access token。每个连接单独配置监听地址和路径。

```yaml
connections:
  - id: qq-main
    transport: reverse-websocket
    url: ws://127.0.0.1:6701/onebot/qq-main
    accessTokenEnv: BL_AGENT_QQ_TOKEN
```

反向监听要求 access token，以及 OneBot 的 `X-Self-ID` 和 `X-Client-Role: Universal` 握手头；只接受精确路径及一个活动连接，随后仍查询 `get_login_info` 核验实际账号。监听地址使用 `ws://`，需要 TLS 时由部署代理提供。初次启动在 15 秒内等待客户端接入并核验；断线后继续监听，由平台客户端重新连接，再次核验后恢复处理。正向与反向连接沿用同一回执、心跳和事件队列。

将模型密钥和 OneBot access token 设为相应环境变量。`BL_AGENT_REDIS_URL` 默认 `redis://127.0.0.1:6379`，支持 `redis://`、`rediss://` 和本地 `unix://`。Redis 的持久化策略决定进程重启之外的存储耐久性。`instance` 决定独立宿主的 Redis 前缀 `bl-agent:<instance>:`，同一个实例同时只运行一个进程。独立入口用自己的 Redis 分区和账本目录。

从仓库直接运行时，先构建后端。

```sh
npm ci
npm run backend:build
npm run agent:start -- --config /path/to/agent-host.yaml
```

也可以在已经安装构建依赖的仓库运行 `npm run agent:pack`。命令输出 `.release/agent-*` 下的发布包目录。将该目录复制到服务器，从包目录安装锁定的运行依赖后启动。

```sh
npm ci --omit=dev --ignore-scripts
npm start -- --config /path/to/agent-host.yaml
```

发布包要求 Node.js 22.12 或更高版本，包含 Core、QQ 适配器、启动入口和依赖锁。启动时核对构建与发布清单。把配置、Redis 数据和 `dataDir` 放在发布包外即可在替换版本时继续使用原绑定和存储分区。

发布包的 `scripts/bl-chat-agent.service` 提供 systemd 模板，默认使用独立的 `bl-chat-agent` 用户和组。先创建该系统用户，将配置目录及 `dataDir` 交给该用户，保持目录 `0700`、凭据文件 `0600`；发布目录由 root 管理，只授予服务用户读取及目录遍历权限。模板使用 `/opt/bl-chat-agent/current`、`/opt/bl-chat-agent/config/agent-host.yaml` 及同目录的 `agent.env`，其他安装位置须同步修改。私有 HOME、XDG 和临时运行目录由 systemd 管理。

文字文档、知识卡和思维导图使用 Chromium，须以非 root 身份保留默认沙箱运行。已安装系统 Chromium 时，在 `agent.env` 中设置 `PUPPETEER_EXECUTABLE_PATH`；安装依赖可设置 `PUPPETEER_SKIP_DOWNLOAD=true` 复用该浏览器。启用渲染前，应使用服务的实际用户验证浏览器及字体可读、HOME 可写。调整现有配置文件的所有权会改变绑定版本；已有状态的 root 实例不应直接递归 chown 迁移。

已有 root 实例可只降低浏览器权限：创建独立渲染用户和其拥有的 `0700` 私有目录，设置 `PUPPETEER_EXECUTABLE_PATH=/opt/bl-chat-agent/current/scripts/start-sandboxed-chromium.mjs`、`BL_AGENT_CHROMIUM_EXECUTABLE=/usr/bin/chromium`、`BL_AGENT_CHROMIUM_UID`、`BL_AGENT_CHROMIUM_GID` 及 `BL_AGENT_CHROMIUM_HOME`。该可执行启动器要求 Linux、Node.js 22.15 或更高版本，仅接管 Puppeteer 新建的空临时 profile，清空补充用户组、切换身份并以精简环境 exec 浏览器，保留原 PID 和退出清理。配置及 dataDir 的原身份不变；启动器拒绝关闭沙箱的参数。上线后同时核对真实渲染、QQ 连接、绑定版本和配置加载状态。

连接真实部署前可以单独检查配置、绑定人设、Redis 连通性和每条 OneBot 连接的实际登录账号。从已安装的独立包运行检查。

```sh
npm start -- --config /path/to/agent-host.yaml --check
```

检查读取启动所需的凭据，以 `PING` 检查 Redis 连通性，并向 OneBot 查询 `get_login_info`。结果列出在本宿主管理的账号下配置的仿真群、文字群和好友绑定数量，同时列出仿真总开关和私聊开关。检查期间丢弃平台入站事件，跳过宿主租约、模型请求及账本写入。配置失效、Redis 无法连接或任一账号不符时退出码非零。部署时仍在启动和每次重连核验登录账号。

反向模式的 `--check` 临时监听同一地址，等待客户端在 15 秒内接入，核验后关闭；该监听地址须空闲。

每次连接及重连核对 `get_login_info` 的 QQ 号，收件按账号与显式会话绑定校验。独立宿主在读取仿真上下文期间保留已落入 Redis 的唤醒，在开始模型调用或动作前领取。断线发生在领取期间时，仍有效的唤醒写回待处理队列，重连后重新检查。已开始的仿真回合按实际动作回执结算，发送结果未知时跳过重发。OneBot WebSocket 没有事件确认与补投递协议，断线期间的事件由平台端决定是否送达。`simulation.enabled: false` 停用独立宿主的新消息处理和到期承诺。绑定文件热读取，连接、模型与 `agent-host.yaml` 设置在下次进程启动时读取。 [OneBot v11 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)

仿真、群文字和好友私聊分别按完整平台账号排队。仿真消息、撤回和互动在同一账号内按收件顺序处理。一个账号的引用查询或收件重试不阻塞其他账号。升级后首次启动会在连接平台之前分批将旧仿真收件队列移入对应账号队列，沿用原收件回执、绑定版本和互动标识。迁移可以从已经提交的批次继续。

OneBot 群消息可用消息段数组或 CQ 字符串。QQ 适配器把两种格式转换为同一种入站消息，按结构识别点名、引用和附件。独立宿主要求消息携带有效的平台发送时间。 [OneBot v11 消息格式](https://github.com/botuniverse/onebot-11/blob/master/message/README.md)

群仿真遇到明确引用的旧消息时，可通过当前 QQ 账号读取该条消息。OneBot 实现须在 `get_msg` 响应中返回与当前群一致的 `group_id`，同时提供匹配的消息 ID、作者和时间。证据齐全且仍可见时，引用切换前的机器人回复也能触发仿真，引用原文最多显示 160 字。响应无法确认群归属时，群仿真只使用本条消息。来源撤回会清除已保存的引用摘录并取消仅依赖该引用的待执行唤醒。 [OneBot v11 获取消息](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#get_msg-获取消息)

独立群仿真可通过 `simGetForward` 查看本回合可见消息中的合并转发，参数是消息序号。适配器先用 `get_msg` 核对原消息的群号、消息 ID 和转发段，再用 `get_forward_msg` 展开最多三层。工具返回有界文字摘录，图片、语音和文件显示为类型标记。转发正文工具结果只用于当前回合。撤回、换绑、原消息无法核验或人物隐私规则变化会使读取失效。 [OneBot v11 合并转发](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#get_forward_msg-获取合并转发消息)

在 `agent-host.yaml` 添加可选的 `vision` 后，独立群仿真可以查看本轮可见消息的附图，也可以通过回复消息查看已核验的同群原图。视觉模型需支持 OpenAI Chat Completions 的图片内容。修改配置后重启。

```yaml
vision:
  baseUrl: https://vision.example.com/v1
  name: your-vision-model
  apiKeyEnv: BL_AGENT_VISION_KEY
```

适配器按原消息重新读取附图。图片链接限于内置的 QQ CDN 地址，通过 HTTPS 下载，每张最多 2 MiB，一次最多两张。支持从 OneBot 返回的图片段读取 `base64://` 内联数据。仅返回文件名或本地路径的 OneBot 实现无法通过这条链路读图。视觉模型收到图片和固定描述提示，文字主模型收到当轮的描述，视觉调用用量计入群账本。撤回、换绑或人物隐私设置变动会阻止回合继续使用失效的图片来源。 [OneBot v11 图片消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md#图片) [NapCat QQ CDN 地址](https://github.com/NapNeko/NapCatQQ/blob/334c4233e6a4f806e1a706c033dccc0b805360f2/packages/napcat-core/types/constant.ts)

QQ 扩展动作与文字触发的同一次纯同步权限判断，共享一份完整配置观察，并在进入和退出时重新核对源文件及事务 fence。观察不会跨越 `await` 或实际投递；后续来源读取、排队、授权和原生发送仍执行新校验。相同内容的文件替换也会使本次判断失效，启用控制台时仍同步退休旧执行实例；未启用控制台时保留原绑定热读取行为。

两种 WebSocket 连接的单条消息上限为 6 MiB，可容纳两张各 2 MiB 图片的 base64 和消息元数据；图片仍逐张校验原有二进制大小、格式和像素限制。

### 人物事实学习

独立 QQ 群仿真可以从群友的新自述学习结构化人物事实。在 `agent-host.yaml` 显式配置提取模型，设置凭据环境变量并重启。

```yaml
personMemoryExtraction:
  baseUrl: https://memory.example.com/v1
  name: your-person-extraction-model
  apiKeyEnv: BL_AGENT_PERSON_EXTRACTION_KEY
```

该配置仅接受 `baseUrl`、`name` 和 `apiKeyEnv` 三个字段。未配置时不装配提取器；不回落到主聊天模型、视觉模型或审核模型。正常启动和 `--check` 要求已声明提取服务的凭据，即使人物提取开关已关闭；迁移预览只校验配置格式，不要求凭据，也不调用模型。

群仿真提取沿用 `simulation.personProfile`：`enabled` 默认开启，设为 `false` 后停止群仿真新事实提取；没有上述模型配置时不会外发。群仿真空闲检查时，从尚未提取的近期消息中选择 20–40 条带真实消息 ID 的完整文本。冷却默认 6 小时，由现有 `extractCooldownMs` 配置控制，范围为 1–24 小时。

私聊和群文字模式使用独立的顶层 `memorySystem`，默认关闭，同时需要上述 `personMemoryExtraction` 后端。只有已确认送达的普通文字回复才收集本轮真实用户原话，工具结果、引用和合并转发正文不学习。默认同一用户静默 90 秒或累计 6 条后提取，可设置以下三个字段：

```yaml
memorySystem:
  enabled: true
  userExtractDebounceSeconds: 90  # 0–3600，0 表示无需等待
  userExtractMaxBatchMessages: 6 # 1–40
```

文字来源缓冲按完整平台账号、会话、角色、绑定版本、作者和已核验私聊对象隔离。原消息 ID、时间及正文先持久化，再运行后台提取；消息 ID 去重，每批最多保留 60 条，整个宿主最多 200 个缓冲。单条超过 4000 字的正文不学习。有效结果在首条事实写入前持久化，重启复用同一批候选；成功只确认捕获的消息，期间新来的消息继续保留。失败最多尝试 3 次，退避从 15 秒开始，耗尽后保留待处理来源并停止自动重试。完成回执保留最近 60 条 ID，空缓冲 7 天后清理。学习入队暂时失败时，已确认的文字回复可从原收件记录补入学习且不重新发送；网络送达与本地确认之间仍不承诺原子性。

私聊会话 ID 与对话者 ID 分别保存，每次恢复和外发前重新核对当前对话者。私聊来源始终只在原私聊向本人提供，模型声明可移植也不跨场景；群文字来源继续服从同角色跨群的窄可移植规则。关闭 `memorySystem.enabled` 停止文字新学习及其在途结果接纳，隐私停用和清空另由原人物记忆命令控制。

模型只收到真实作者标识、群内显示名和本条正文，每条显示名最多 20 字、正文最多 400 字。单次请求拒绝重定向，不在 HTTP 层重试，最多 40 秒、512 KiB 响应和 2000 输出 token；文字队列的失败重试另按上述 3 次上限调度。只接受最多 64000 字符的严格 JSON 数组，不接受工具调用。输入和结果检查已知宿主凭据，错误不包含提供方正文。引用原文、合并转发正文及截断文本不作为本人自述来源。模型提供的原话必须逐字命中对应作者的消息；账号、角色、场景、消息 ID 和时间由宿主确定。通用称呼、稳定兴趣和普通偏好仍须满足低敏及可跨群规则；具体事件、关系和私人事实留在来源场景。人物隐私操作、撤回、换绑或停止使失效请求及迟到结果停止使用，保存前继续复核，已提交给服务的请求无法保证撤回。有效提取用量计入来源会话的 `person-profile` 账本及全局 API 总账。

### 群聊摘要与情节记忆

独立 Core 的群仿真和群文字模式共用按角色及完整会话地址隔离的摘要。普通群文字即使没有点名机器人也会进入来源缓冲，是否回复仍按原触发规则判断；好友私聊不生成群摘要。以下配置显式指定摘要服务，与主模型和人物提取模型分别装配。

```yaml
midtermSummary:
  baseUrl: https://memory.example.com/v1
  name: your-conversation-summary-model
  apiKeyEnv: BL_AGENT_SUMMARY_KEY
midtermMemory:
  enabled: true
  minMessages: 15
  debounceMs: 20000
  maxSummaryChars: 500
  bufferMaxLines: 200
  retentionDays: 3
episodicMemory:
  enabled: true
  maxPerGroup: 200
  recallDays: 7
  proactiveEnabled: true
```

`midtermMemory` 和 `episodicMemory` 上述值为默认值。未配置 `midtermSummary` 时不生成新摘要，也不回落到主模型；本地情节记录仍可使用。摘要累计 15 条合格原消息后固定等待 20 秒，后续消息不重新计时。来源保留原始时间，每批按顺序处理最多 200 条，带入仍有效的上一份摘要。缓冲默认保留最近 200 条，超出配置容量的旧原消息会退出缓冲。摘要最多 500 个 Unicode 码点、有效期 3 天；关闭 `midtermMemory.enabled` 停止生成和读取摘要。

摘要服务仅接收上一份摘要及原消息的时间、作者标识、显示名和有界正文。保留 `at` 为原消息 Unix 毫秒，并派生完整 `Asia/Shanghai` 日期秒 `sourceTime`；“昨天/明天”等按各自来源时间解释，不能按摘要生成、重试或处理时间重新解释。旧摘要缺少完整来源时不猜测日期，派生字段同样经过秘密检查；不改写旧数据。每条显示名最多 24 字、正文最多 160 字；不发送工具、主提示词、引用和附件内容。单次最多 30 秒（包含权限复核与响应体读取）、512 KiB 响应和 `min(8000, 2 × maxSummaryChars)` 输出 token，拒绝重定向及结构化或工具输出，不在 HTTP 层重试。有效用量计入来源会话的 `midterm-summary` 及全局 API 总账。失败最多尝试 3 次，退避从 15 秒开始，耗尽后保留来源并停止自动重试；来源失效水位变化后，新一批允许的消息重新计时并使用自己的尝试次数。

配置仅接受上述字段及严格类型。摘要整数范围依次为 `minMessages: 4–200`、`debounceMs: 5000–3600000`、`maxSummaryChars: 120–4000`、`bufferMaxLines: 50–1000`、`retentionDays: 1–30`；情节为 `maxPerGroup: 20–1000`、`recallDays: 1–30`。已声明摘要服务的启动和 `--check` 会校验凭据，`--check` 不生成摘要。配置修改后重启生效。

情节仅在回复获得有效平台消息 ID 后补记，保留原消息和确认回复的 ID、人设版本及有界正文。明确失败和未知投递不产生情节，情节补记失败也不重新发送已经确认的回复。补记与平台投递并非原子事务，存储故障时仍可能缺少一条情节。好友私聊情节同时约束原会话和当前已核验的对话者，群、账号和角色之间不串用。文字模式在用户提到过去时最多提供 5 条近期情节，否则在允许自然接续时提供当前发言者至少 30 分钟前的最多 2 条；仿真沿用近两天最多 6 条，聚焦单人触发时继续省略群级聚合内容。

仿真、群文字和好友私聊读取情节时，将原始时间戳统一显示为 `Asia/Shanghai` 的完整日期和时间，并保留时区标记，与仿真的北京时间口径一致。展示不依赖服务器本地时区，也不改写存储中的时间戳、排期或反思的 UTC 每日额度。

摘要、来源缓冲及情节存 Redis，目录和详情通过比较版本原子保存，进程重启继续使用。一个宿主最多保存 200 个会话分区。摘要与情节作为用户上下文资料提供，不授予指令或工具权限。任何来源撤回、人物遗忘或隐私变更都推进持久失效水位，使旧聚合整体停止读取；来源已退出有界缓冲也不能绕过该水位。已知的记忆停用会屏蔽无法逐项归属的聚合。在途摘要还受绑定、隐私、连接可用性及停止信号约束，迟到结果不采用。旧人设回复会标注原来源角色与版本，只有账号、角色和人设版本均相同才称为“你回了”。

原插件的摘要文件与全局情节文件缺少完整账号、角色或原消息及确认回执依据，继续保留在源端，不自动导入独立 Core。它们的归属补全与可验证迁移仍待处理。

### 独立语义召回

独立宿主默认关闭语义召回。显式启用后，群仿真、群文字和已启用的好友私聊把真人顶层文字保存到专用的有界来源库；未点名的合格群消息同样可以采集。来源库使用宿主的 Redis 实例前缀，进一步按平台、命名空间、接收账号、Agent 和完整会话地址隔离。它独立于摘要滚动缓冲，也不会读取或猜测旧插件归档的接收角色。

```yaml
semanticMemory:
  enabled: true
  retentionDays: 30
  maxMessagesPerConversation: 1000
  topK: 5
  minScore: 0.35
  timeoutMs: 1000
  embedding:
    baseUrl: https://embedding.example.com/v1/embeddings
    name: your-embedding-model
    apiKeyEnv: BL_AGENT_EMBEDDING_KEY
  # 可选；端点和凭据必须分别声明，不会自动推导或继承
  rerank:
    baseUrl: https://rerank.example.com/v1/rerank
    name: your-rerank-model
    apiKeyEnv: BL_AGENT_RERANK_KEY
```

上述数值是默认值。范围为保留 1–90 天、每会话 50–2000 条、召回 1–10 条、相似度阈值 0–1、查询预算 200–5000 毫秒。最多保存 200 个会话分区；容量或损坏会明确停止该来源库的读写，不覆盖其他角色的数据。每条原文最多 1600 个 UTF-16 单元，只接收适配器提供的本人顶层文字段，不把转发、引用正文、附件描述或机器人输出归为本人原话。原消息时间保留，以 `Asia/Shanghai` 明确显示。超期与超额原文不再参与召回，后台逐分区清理，移除旧绑定后仍会清理过期来源。

采集只提交本地来源；后台每批最多 8 条、同时最多 2 个分区请求 embedding。服务失败保留待索引原文并等待至少 60 秒，重启后可接续。常规巡检至少间隔 60 秒，目录扫描只读取作用域元数据，不每秒搬运全量向量。向量空间用端点与模型的摘要标识；更换后重新索引，不把旧空间向量混入新查询。来源和向量通过比较版本提交，不保存服务凭据。此库有明确的容量和保留期，不是永久或完整聊天归档。

检索结合向量和 BM25 排序，可选重排；关键词仍可在本地检索。群聊只使用原会话资料；群仿真保留原有单人聚焦规则，只在无直接发言锚点的回合请求语义召回。查询排除本次未读或触发消息本身。人物停用、遗忘、撤回、绑定改变及停止在出机前、异步返回、持久化及模型/发送前复核；持久来源被删除或损坏也使已返回投影失效。混合查询无法逐句归属时，若本场景存在人物停用规则，就只做本地 BM25，不向 embedding 或 rerank 发送查询。

已启用好友私聊时，Core 可为真实对话者检索同一接收账号和 Agent 在可访问群中保存的本人顶层原文，连同原私聊资料一起排序；不同作者的群发言不进入这条检索的向量、关键词或重排候选。当前私聊消息的作者、消息 ID 和时间来自适配器，查询正文或模型参数不能切换读取主体。私聊查询使用本人这条真实来源的权限检查，不因来源群其他群友停用而扩大或缩小本人权限；本人在某群的停用/遗忘只剔除该群来源，私聊的全场景操作覆盖该账号和 Agent 下本人的全部场景。

来源群必须当前仍绑定同一 Agent，且适配器能提供机器人自身的最新群成员证据。独立 QQ 宿主使用 `get_group_member_info`，指定当前已验证机器人 QQ 并设置 `no_cache: true`；不要求模型提供群号，也不借默认账号查询。缺少成员读取端口、群访问被拒、绑定不符或证据无效时，不接纳该群。成员证据在向量/重排请求前后、模型与发送前重新读取；撤权、来源群换绑或撤回使在途结果失效。跨群重复的原消息 ID 仍各按完整来源作用域处理。只读取本实例已采集或明确迁入的来源，不自动导入旧归档、旧语义窗口或无接收角色的资料；也不从其他好友私聊读取历史。

召回片段作为用户资料注入，检索失败或超时明确标记未完成，不能推断历史不存在。直接召回正文及基于它产生的回复不另存为文字历史、仿真模型历史、情节或自动群说法，后续仍须从有效来源读取。显式工具保存的角色记忆继续遵守各自的来源契约。已发送内容和已交给外部服务的数据无法保证撤回。

`embedding.baseUrl` 与可选的 `rerank.baseUrl` 必须是完整端点。关闭功能不读取其凭据、不连接服务；启用时缺少配置或凭据会阻止启动。`--check` 只校验，不向量化。每次请求禁止重定向，响应上限 1 MiB，完整输入检查已知宿主秘密，错误不返回提供方正文；不回落到主模型或旧插件配置。embedding 用量未被当前协议记录为 token 账单，不虚构统计。改配置后重启生效。

自定义宿主可从 `bl-chat-agent/semantic` 导入 `createAgentSemanticBackend`，或实现根入口导出的 `AgentSemanticMemoryBackend`，通过 `semanticMemory` 与 `semanticMemoryBackend` 交给 `createAgentRuntime`。自定义后端的 `id` 为随向量空间变化的 64 位小写 SHA-256 摘要，并须在每次实际外部请求前调用 `context.ensureCurrent()`、遵守 `context.signal`；生命周期由创建该后端的宿主管理。

### 显式历史查询

独立 Core 可提供 `chatHistoryTool`，由主模型按当前真人请求选择；不依赖向量、摘要或画像服务。配置默认关闭：

```yaml
history:
  enabled: true
  retentionDays: 30
  maxMessagesPerConversation: 1000
  timeoutMs: 5000
```

保留期范围1–90天、每会话50–2000条，读取总期限100–30000毫秒。最多200个完整账号/Agent/会话分区，每条只保存真实入站顶层文字，最多4000字符。开启后开始积累来源；旧插件归档、旧无来源缓存、转发、引用和机器人派生文字不会自动导入。关闭开关并重启可停止采集与查询；已有本地来源不因关闭立即物理删除。

群仿真真人回合沿用普通工具策略，群文字与已开启的好友私聊也可选择历史工具；自主目标及承诺不获得此能力。群内 `recent` 读取当前会话最近60条有效原文，`memory` 使用当前可见的有来源事实，群内 `archive` 拒绝。私聊只读真实对话者本人；`archive` 只读取同账号、同Agent且仍获准访问群中的本人原话，逐次核验机器人群成员资格，不读取其他好友私聊、其他作者、其他账号或其他角色的正文。

参数保留 `question`、`user_id`、`start_time`、`end_time`、`keywords`、`limit`、`offset`、`source` 与 `memory_ids`。身份只能来自当前请求者、真实点名、核验的引用作者或原话中的完整标识。日期 `YYYY-MM-DD` 表示北京时间整日，时钟须带时区，起止含边界；每来源默认20条、最多50条，按 `next_offsets` 指定单一来源继续分页，以真实 `memory_index.id` 展开详情。原文单条最多返回2000字符，完整JSON最多16000字符，截断与预算不足有明确标记；预算不足可缩小 `limit` 或按单一来源重取偏移。`not_found`、`unavailable` 和 `complete_history:false` 保留实际含义，不能把空结果解释为从未发生。

长期事实可比有界原文保存更久；查询和ID详情沿用相同人物隐私规则，群内可移植事实隐藏其其他群来源、消息ID和摘句。原文来源、记忆详情、持久隐私、撤回和当前绑定在读取后以及每次模型请求、兼容重试和发送前重新检查。结果及派生回复仅在本轮临时使用，不写入文字/仿真历史、角色记忆、目标、作品、情节、自动群学习或工具结果观察。读到历史后只继续查证、回复或安全收尾；新回合重新取源授权。已发送内容或已提交给模型的资料不能保证撤回。

公共宿主从 `bl-chat-agent` 导入 `AgentHistoryConfig`、`AgentHistoryRequestSource` 和 `AgentHistoryRecall`，以 `AgentRuntimeOptions.history` 启用；Core 自行装配工具。`AgentToolContext.readHistory` 是可选的本轮能力，工具结束后失效。原有独立包仍可在关闭此项时运行，完整旧归档的接续或重建另行跟踪。

### 群内说法、显式教学与资料管理

独立 Core 的群文字和仿真可显式开启群学习。服务与主模型、人物提取和摘要服务分别配置；省略后端不回退到其他模型，默认不启用。

```yaml
groupMemoryExtraction:
  baseUrl: https://your-provider.example/v1
  name: your-group-memory-model
  apiKeyEnv: GROUP_MEMORY_API_KEY
groupMemory:
  enabled: true
  groupExtractMinIntervalMinutes: 10
  groupExtractMaxBatchMessages: 12
```

`groupExtractMinIntervalMinutes` 接受 0–1440 的整数，批次为 1–40 条，默认分别为 10 分钟和 12 条。已声明的服务在启动和 `--check` 时校验凭据，`--check` 不调用成员目录或提取模型。配置修改后重启生效。人物隐私命令、撤回、换绑、停止和关闭群学习会限制读取或撤销在途结果。

只启用 `groupMemory.enabled` 而不配置提取后端时，已有和已迁入的资料仍可读取与管理；新捕获、教学提取及自动学习保持关闭，不回落到主模型。

自动提取只在普通回复获有效平台消息 ID 后排队，从最近未处理的原消息提取有来源的群内说法。投递失败和未知结果不触发。记录归当前 Agent 与完整会话，不宣称多人共识或独立核实。显式教学由独立语义模型判断，和本轮回复是否成功分开；只在真人触发的回合准备资料时检查原消息，不通过关键词正则强制判定教学。别名、成员定义、成员集合、群文件名称和通知工作流归完整会话，同一账号、平台命名空间、会话类型及 ID 下切换 Agent 仍可共用，不跨账号或群共享。

普通成员可新增别名和定义，冲突替换只允许原创建者或当前管理员。通知工作流的创建和更新须管理员或群主。成员 ID 与角色通过平台端口重新核验，不接受模型或入站正文自报权限。QQ 使用 `get_group_member_list` 与 `get_group_member_info(no_cache: true)`，后者在提交前刷新；角色证据超过 1.5 秒不再用于发起提交。这是提交前的有界复核，QQ 与 Redis 之间不具备原子权限事务。教学目标只从原消息作者、点名或名称明确且唯一的已核验候选中选择。文件仅保留原文件名及稳定平台引用，不保存临时下载地址或宿主路径。别名资料遵循配置、本人自述、教学、当前提及的优先顺序，不重写人物事实。

每个会话最多保留 20 个 Agent、共享教学 400 条；每个 Agent 保留原来源及任务各 60 条、自动说法 50 条。目录、来源、条目及任务确认通过一个 Redis 文档原子比较版本保存。失败最多尝试 3 次，从 15 秒指数退避；耗尽后停止重试，不阻塞后续新消息。原来源不可原地改写，模型摘句须逐字命中对应原消息。单次后台群说法最多 20 秒，教学最多 900 毫秒，主回合最多等待教学 180 毫秒；超出后主回合可继续，后台任务仍服从独立取消边界。专用服务最多收到 40 条合格原消息、12 位候选成员的 ID/显示名及机器人 ID；自动说法每条正文最多 400 字，教学最多 4000 字，不发送主提示词、工具或转发正文。完整输入及输出检查已知宿主凭据，请求不跟随重定向、不作 HTTP 重试，响应最多 512 KiB、2000 输出 token。有效用量记入 `group-memory` 或 `group-teaching` 以及全局 API 总账。

读取最多提供 6 条自动说法、8 条教学和真人回合的 12 条工作流，全部作为用户资料上下文。来源撤回、人物停用/遗忘及关联成员的隐私规则在模型调用前、提交和读取时复核，共享教学同时遵守来源 Agent 的隐私。相同账号的隐私命令会停止可能使用共享资料的各 Agent 在途回合。主模型及发送前再次核对资料；这段直接召回和基于它的回复不另存入文字历史、仿真模型历史或情节记忆，防止形成脱离来源的生成副本。已经发送的内容和已提交模型服务的数据不能据此撤回。

群文字可在该会话的 `textGroups.tools` 显式加入 `groupKnowledgeTool`。`list` 查看资料，`delete` 按完整编号删除，`forget` 按完整名称遗忘且拒绝歧义；删除共享教学会撤销同一原消息的整组教学和待处理教学任务，删除自动说法只约束当前 Agent。`clear` 要求当前管理员在 30 秒内以另一条真实消息携带确认码再次确认，绑定、账号、会话和真人必须一致。清空共享教学及当前 Agent 的自动说法，保留其他 Agent 的自动说法；持久截止时间阻止清空前仍在等待的来源重新入库。删除墓碑有界，容量不足会拒绝操作而不丢弃旧墓碑。

`notify` 仅由主模型针对当前真人的明确通知请求选择，使用当前可见的工作流编号；通知正文和请求摘句都须逐字来自本条原话。发送前再次核验成员和工作流，走统一点名、净化、绑定及回执边界。每轮先持久化动作尝试，结果未知不自动重发。保存工作流不会自行通知，也不授予自主回合权限。群文字和仿真真人唤醒共用这套管理工具；仿真自主回合仍不装配它。旧插件裸群号的知识/工作流也未自动迁移。

### 联网搜索与网页读取

独立群仿真的联网能力默认关闭。在 `agent-host.yaml` 显式配置以下字段，设置搜索服务的环境变量后重启。两项可分别配置。

```yaml
tools:
  search:
    baseUrl: https://search.example.com/v1
    name: your-search-model
    apiKeyEnv: BL_AGENT_SEARCH_KEY
    webSearch: auto
  web:
    enabled: true
```

`search` 提供 `searchInformationTool`，调用显式配置的 OpenAI 兼容搜索模型，不回落到主聊天模型。`webSearch` 只接受 `auto`、`on`、`off`，服务是否具备真实搜索能力仍由该服务实现。模型不能指定搜索服务地址或密钥，服务请求不跟随重定向、不自动重试，最多 40 秒、512 KiB 响应和 2000 输出 token。有效用量计入当前会话预算及总账。搜索关键词可能包含群聊线索，搜索返回内容按外部资料使用。

`web` 提供 `webParserTool`，仅提取公开 HTTP(S) 网页的静态文字。拒绝 URL 内置凭据、凭据查询参数、私网及保留地址；DNS 解析、实际连接及每次重定向均受地址检查，连接固定到已核验的公网地址。每次最多 15 秒、3 次跳转、2 MiB 响应和 8000 字正文，不接受压缩响应，支持回合取消。此工具不运行浏览器 JavaScript，也不提供登录、截图或本机文件读取。

工具仅在已绑定群的仿真回合装配，私聊和群文字模式继续使用各自原有工具范围。`simulation.toolPolicy` 的全局与按群禁用、`legacy` 模式和显式追加规则继续生效；例如 `simulation.toolPolicy.denyTools: [searchInformationTool, webParserTool]` 可在 `open` 模式禁用两项工具。自主目标和承诺唤醒仍须经过原有自主执行权限检查。Core 在执行前、异步结果返回后及网页每次跳转前复核角色绑定、持久化活动版本和来源权限。换绑、撤回或停止会取消在途调用；其他进程的活动撤销在下一次授权复核时发现，已发出的请求无法保证撤回。

### GitHub 仓库查询

在 `agent-host.yaml` 显式启用公开仓库查询，然后重启。默认以匿名身份访问，不读取插件或部署机已有的 GitHub 凭据。可选 `tokenEnv` 仅用于提高 GitHub API 额度；声明后启动及 `--check` 都要求该环境变量存在，`--check` 不调用 GitHub。

```yaml
tools:
  github:
    enabled: true
    # tokenEnv: BL_AGENT_GITHUB_TOKEN
```

`githubRepoTool` 只接收 `https://github.com/owner/repository` 仓库根地址，可带 `.git` 或末尾斜线；不接受文件/issue 路径、查询参数、片段或 URL 凭据。工具固定读取 `api.github.com` 的公开仓库基本信息，以及最多 5 条最近提交、100 条分支样本和 5 位贡献者样本。可选请求未取得会明确标注；本页分支与贡献者不代表总数，开放 issues 数包含 PR。返回资料附来源与北京时间，不构成指令或事实核实。

工具只在群仿真装配，沿用现有工具策略和真人执行权限，未扩展私聊、群文字或自主执行能力。可通过 `simulation.toolPolicy.denyTools: [githubRepoTool]` 禁用；移除配置或设 `enabled: false` 并重启也可停用。每次实际 GET 前后复核来源和当前绑定，取消或任一次授权拒绝停止后续请求。总期限 15 秒、每个响应最多 1 MiB，无自动重试、重定向或跨域凭据传递；只将仓库标识和可选 GitHub 鉴权送到固定 API，不附聊天历史、QQ 身份或其他服务凭据。输入及完整成功响应检查已知宿主秘密，错误正文不进入日志或模型。

移除 `tools.search` 或将 `tools.web.enabled` 设为 `false` 并重启，即可关闭对应能力。`tools`、`search` 和 `web` 拒绝未知字段及无效类型。正常启动和 `--check` 会检查已配置搜索服务的凭据；迁移预览只校验配置格式，不要求这些凭据，也不调用搜索或网页服务。

### Modrinth 双语查询与合并卡片

在独立宿主声明 Modrinth 和翻译模型，再重启。翻译只收到本次项目的 ID 和英文简介，不读取人设、群史或旧插件任务配置。关闭时不读翻译凭据，`--check` 只校验配置。

```yaml
tools:
  modrinth:
    enabled: true
    translation:
      baseUrl: https://translation.example/v1
      name: compact-translation-model
      apiKeyEnv: BL_AGENT_MODRINTH_TRANSLATION_KEY
```

`modrinthTool` 支持 `query`、`sort`、`limit`、`gameVersion`、`loader`、`category`；默认历史下载量前五项，最多十项，分类用 Modrinth slug，不下载 jar。固定查询公开搜索 API，严格核对统计和项目身份，缺失计数使查询失败；版本、日期、许可证等缺失时明确标注。结果附来源、筛选条件、展示数量和北京时间，不当作已核实事实。

每项保留英文原文、独立中文翻译、项目元数据和项目页，通过一批 QQ 合并消息交付。卡片内嵌离线 HTML，图标为固定占位，不请求外链图片；每卡独立 Chromium、5 秒、980 像素宽、8192 像素高度上限，超限失败。发布包含 Puppeteer 运行依赖，部署机需准备其 Chromium，或用 `PUPPETEER_EXECUTABLE_PATH` 指定已安装浏览器。渲染失败在尚未发送时整批退为双语文字；翻译失败标中文未提供并保留英文。缺合并端口时只返回有界查询资料并标展示未投递。

工具总期限 90 秒，每次查询/翻译最多 15 秒、响应最多 1 MiB，不自动重试或重定向。合并发送沿用本会话配额、词策略、净化与确认预算，一批计一次发送。最多 12 节点、总文字 32000 字符、单图 2 MiB、总图 12 MiB。图文同时附完整文字，需净化改写时拒绝整批，避免图片保留旧文字。有效消息 ID 才算送达，未知停止本回合后续发送；失败或未知均不补发，实际交付前重核账号、连接、绑定和来源权限。

只在群仿真装配并服从真人主体和普通工具策略，不扩展私聊、群文字或自主工具面。设 `tools.modrinth.enabled: false` 并重启，或用 `simulation.toolPolicy.denyTools: [modrinthTool]` 停用。

### MCP 工具

独立宿主支持显式配置 stdio、SSE 和 Streamable HTTP MCP 服务。只连接此处列出的服务，不读取原插件的 `mcp-servers.yaml`；服务启动失败会阻止宿主启动。`--check` 和迁移预览不会启动子进程或访问 MCP 服务。

```yaml
tools:
  mcp:
    servers:
      notes:
        type: http
        baseUrl: https://mcp.example.com/mcp
        headersFromEnv:
          Authorization: BL_AGENT_MCP_AUTH
        includeTools: [lookup]
        connectTimeoutMs: 10000
        toolCallTimeoutMs: 45000
simulation:
  extraTools: [mcp_notes_lookup]
```

示例的 `BL_AGENT_MCP_AUTH` 保存完整头值，例如 `Bearer …`。网络头只允许 `headersFromEnv` 环境变量映射，不接受配置内明文凭据或传输协议头。`type: sse` 使用同样的地址与头字段；`type: stdio` 使用固定 `command`、可选 `args`、`cwd` 和 `envFrom`（子进程变量名到宿主环境变量名的映射），不能混用网络字段。相对工作目录以宿主配置文件目录为基准；子进程只有 SDK 的基本环境白名单和显式环境，仍以宿主权限执行，不提供 OS 沙箱。

工具按 `mcp_<服务名>_<原工具名>` 别名提供，过长或清理后冲突时带稳定哈希。`includeTools`、`excludeTools` 匹配服务的原工具名；实际调用还须在 `extraTools` 或相应工具策略中显式授权别名，遵守全局及按群禁用。MCP 属于自定义能力，只允许真人唤醒的群仿真回合，不自动进入好友私聊、群文字、自主目标或承诺执行面。参数来自主模型选择，宿主不附送账号、群、角色或会话历史；服务返回的 instructions 不进入系统提示。

最多 8 个服务，每个最多 128 个工具和 16 页；连接/列表发现各有最多 30 秒的期限，调用 100–120000 毫秒，缺省 45 秒。模型 schema 经兼容适配后，执行仍按原始 JSON schema 校验。网络拒绝重定向和跨 origin SSE 投递；显式内网/本机服务可以配置。HTTP JSON 或单个 SSE 事件最多 1 MiB，返回文字最多 8000 字符，图片和音频只显示类型标记，不自动发送。输入、元数据和结果过滤已知宿主凭据；服务错误及 stderr 不直接输出到日志。

服务工具列表变化会撤销旧工具定义和在途结果；Core 从动态注册表读到新列表。断线后仅重建连接，不重放工具调用；可设 `autoReconnect: false`，或以 `reconnectMaxAttempts: 0–3` 限制次数。任何已派发调用超时、取消或结果不明都记为未知，须先核实远端结果。关闭、换绑、撤回与配置失效阻止迟到结果；已发送的请求无法保证撤回。移除服务或设 `enabled: false` 后重启停用。

### 图片生成与编辑

独立群仿真可显式装配 `bananaTool` 和 `googleImageEditTool`，分别读取以下后端，省略时不出现该工具，也不回退主聊天模型。

```yaml
tools:
  images:
    generation:
      baseUrl: https://images.example.com/v1
      name: your-image-model
      apiKeyEnv: BL_AGENT_IMAGE_KEY
      protocol: images
      size: 1024x1024
      quality: high
    edit:
      baseUrl: https://images.example.com/v1
      name: your-image-edit-model
      apiKeyEnv: BL_AGENT_IMAGE_EDIT_KEY
      protocol: images
```

`protocol` 为 `images`（默认，OpenAI 兼容图片接口）或 `chat`（聊天接口返回图片）。服务地址、模型和凭据来自宿主配置，工具参数不能改写。`images` 无参考图时使用生成接口，有参考图时使用 multipart 编辑接口；`chat` 只发送当前图片要求及本次参考图。`size` 和 `quality` 是图片接口可选参数，比例参数沿用已有渠道尺寸适配。`provider` 只核对所配置模型名称，不自动选择其他服务。

参考图可来自公开 HTTP(S) 地址，或通过 `sourceSeq` 指向本轮已展示的 QQ 带图消息；编辑至少需要其中一种来源。消息附图经原群、消息 ID、作者、时间、可见范围和撤回检查，只交给图片工具，不放入主模型正文，且不要求另外配置视觉模型。最多 10 张参考图、合计 40 MiB；QQ 附图读取沿用适配器每次两张、每张 2 MiB 的限制。公开图片下载允许 CDN 的签名查询参数，不发送宿主授权头或 Cookie；DNS、实际连接与每次跳转均核验公网并固定地址，最多 15 秒、3 次跳转、20 MiB，不接受压缩响应。

一次任务最多等待 4 分钟，提供方 JSON 响应最多 32 MiB；只交付第一张有效 PNG/JPEG/WebP/GIF 图片。图片检查标准 base64、实际格式及画布，最多 20 MiB、单边 16384 和 6400 万级像素。图片经当前回合的平台无关交付口发送，和文字工具回复共用发送队列、配额及预算；只有平台确认有效消息 ID 才报告送达。迟到、撤权、换绑及停止后的结果不交付。提供方超时、5xx、损坏结果或发送结果未知时不自动重提；明确 400/422 且仅拒绝 `response_format` 时，最多去除此字段重试一次，已读到的有效用量逐次记账。生成数据、签名成图 URL 和提供方正文不返回主模型。

这两项工具沿用普通工具策略。自主回合还须在 `simulation.autonomousTools` 显式授权对应名称；当前不进入好友私聊或群文字模式。移除对应后端并重启即可停用，`--check` 检查已声明的凭据但不调用图片服务。没有生产图片任务迁移；进程中断后的既有动作回执按原规则记为待核实，不自动重新生成或重发。

原群使用角色一致性审核时，可在独立宿主配置单独的 OpenAI 兼容审核模型。将以下字段并入 `agent-host.yaml`，设置对应环境变量并重启。审核密钥通过单独声明的环境变量读取。

```yaml
simulation:
  consistency:
    enabled: true
characterConsistency:
  baseUrl: https://review.example.com/v1
  name: your-review-model
  apiKeyEnv: BL_AGENT_REVIEW_KEY
```

审核沿用仿真回合和反思的提交规则，获得有界草稿和可见依据。每次等待最多 15 秒，要求最多 900 个输出 token。审核拒绝或服务异常会阻止对应提交，模型可按原回合规则修正或收尾。移除 `simulation.consistency.enabled` 或设为 `false` 并重启即可关闭。

独立宿主已经通过主模型装配 `reflectCharacter`，群仿真在允许自主参与的空闲期可执行角色反思。至少间隔 6 小时、UTC 每日最多 2 次，且需要至少两项未处理依据；计入群回合和金额预算。反思只可保存有依据的推测性观点或兴趣、调整一个既有目标的等待或放弃状态，不发送消息或调用工具。`simulation.reflection.enabled: false` 停用此路径。绑定、暂停、来源和隐私复核继续约束迟到提交；独立反思的真实模型验收仍单独跟踪。

独立宿主处理显式绑定群中戳向当前 QQ 账号的“戳一戳”。两个 QQ 入口共用 `triggers.poke` 和仿真唤醒逻辑。独立宿主为每次已接收的通知生成内部收件 ID，重启重读同一条收件时只保留一条互动。OneBot 群戳一戳没有平台事件 ID，协议重复上报会被视为新的互动。 [OneBot v11 群通知](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md#群内戳一戳)

### 文字图片与思维导图

独立宿主可分别启用本地文字图片和使用独立模型的思维导图：

```yaml
tools:
  rendering:
    textImage:
      enabled: true
    mindMap:
      baseUrl: https://map.example.com/v1
      name: your-map-model
      apiKeyEnv: BL_AGENT_MINDMAP_KEY
```

两者默认关闭，工具名沿用 `textImageTool` 与 `aiMindMapTool`，按普通群仿真工具策略装配，不扩大好友私聊、群文字、自主或承诺工具面。文字图片不调用模型；思维导图仅向显式后端发送本次 `prompt` 和固定排版要求，不读取旧插件 YAML、不继承主模型；有效 token 用量记入当前会话账本。预检校验配置与凭据，不调用模型或启动浏览器。移除配置并重启可停用。

文字图片保留 chat、document、knowledge 三套完整模板、上海时区日夜主题、代码高亮、表格、知识步骤/清单/事实卡及 KaTeX 数学排版。Markdown、代码和公式会把显式 chat 升为 document，显式 knowledge 优先。chat 按 Unicode 码点截至5000，另外两种截至12000；输入最多48000个UTF-16代码单元。昵称、头像省略时不显示身份。仅 chat 读取可选公共头像，逐跳校验公网并固定连接地址，15秒内限量下载；不可用时省略头像。头像先解码、缩放成PNG再嵌入，文档正文不能加载外部图片或HTML。宿主出站文字规则和已知凭据检查在文字转图前执行。

思维导图保留 prompt、width、height、waitTime 参数：默认2400×1600，宽320–4096、高240–4096，等待默认8000毫秒、夹限1000–30000，均服从总渲染时限。独立模型只返回有界Markdown，最多24000字符、5层、256节点；HTML、代码围栏或超预算内容明确失败。实际 Transformer 保留普通文字、强调和行内代码，链接/图片语法只作文字；不启用可加载资源的插件。本地锁定 d3 7.9.0 和 markmap-view 0.18.12，关闭动画并等待布局/fit完成后截图，无CDN请求。

渲染器不在工作目录落地HTML或PNG；KaTeX样式及字体来自安装包并内嵌，Chromium阻断网络和任意文件。每次渲染最多20秒，文字工具总计45秒、导图总计90秒；取消、换绑或来源失效阻止后续模型、渲染和发送，迟到浏览器/页面也会关闭。长文先检查实际排版高度和像素预算再截图，超限要求缩短，不自动分片。图片字节通过现有20MiB、16384单边、64*1024*1024像素校验，通过当前绑定的 `sendImage` 共用发送配额；只有有效消息ID才确认送达，结果未知不补发或改发原文。字节不进入模型历史或日志。运行需可用Chromium与中文字体；可用 `PUPPETEER_EXECUTABLE_PATH` 指定浏览器，Sharp原生包随目标平台安装。

### 独立 Excel 读取

```yaml
tools:
  excel:
    enabled: true
```

显式启用后，群仿真按原工具策略提供 `excelWorkbookTool`。公开宿主可从 `bl-chat-agent/excel` 导入 `createAgentExcelTool` 并注册；文件能力通过平台无关的 `AgentToolContext.readFile/listFiles` 接入；读取工具须声明 `dataPolicy: 'ephemeral'`，Core 在执行前进入临时资料模式并跳过持久行动回执，未声明工具拿不到文件端口。不接受原生 QQ event。`--check` 不下载或解析工作簿。

保留五种只读操作：`list_group_excels`、`list_sheets`、`read_cell`、`read_range` 和 `find`。支持工作表名、大小写匹配和从 1 开始的序号；查找保留值/公式、四种匹配、指定区域、附近格和关联词。单次区域最多300格、查找最多100个结果、文本最多12000字。公式只展示原式和工作簿保存的缓存结果，没有缓存时要求用 Excel/WPS 重算保存；不会执行公式或宏。支持 `.xlsx/.xlsm/.xltx/.xltm`，旧 `.xls/.xlt` 需另存，不提供创建或改写。

来源依次为本轮真人明确给出的原始链接、当前文件、已核验引用文件、本人最近30条/30分钟附件和当前群文件仓库。指定 `sourceSeq` 时只使用本轮可见消息，`fileIndex` 是原消息中从1开始的文件序号；直接附件优先，有直接附件时不会静默切到引用。同名文件需给出 `fileName/folderPath`。群上传通知不伪造消息ID，仓库来源使用当前目录中的上传者、时间和文件身份验证。

文件与目录资料仅供当前回合查询和回复，每次模型调用和发送前复核绑定、原消息/目录及隐私状态；解析文本和派生回答不写长期记忆、工具正文回执、agentHistory、群学习或情节。消息入站只存有界名称和数量。下载最多12MiB/20秒，逐跳检查公网并固定实际连接；工作线程先按真实解压量、单元格和合并面积预检ZIP，再用原ExcelJS查询函数解析，默认15秒/256MiB heap，取消后终止并等待退出。单个服务默认1个运行、4个排队，没有跨会话工作簿缓存。独立发布包显式包含线程入口和锁定解析依赖。

### 独立文件文本与文件上传端口

```yaml
tools:
  files:
    enabled: true
    nativeFormats: []
```

默认关闭。群仿真真人回合按原工具策略提供显式 `fileTextTool`；公开宿主从 `bl-chat-agent/files` 导入 `createAgentFileTextTool`。复用上节同一 `readFile` 来源选择、撤回/隐私/绑定复核及临时资料隔离，不自动读取文件入站，不扩大好友私聊或群文字工具面。Excel 单元格与公式查询仍用 `excelWorkbookTool`；通用文件工具只返回文档文本。

保留文本/代码/JSON/CSV、HTML/XML/Markdown、PDF、DOCX、PPTX/POTX、Excel（含旧表格与XLSB）、OpenDocument及EPUB解析。扫描PDF不自动OCR。DOC、RTF、图片OCR和DXF须由宿主在 `nativeFormats` 显式授权 `doc`、`rtf`、`ocr`、`dxf`，并安装对应固定程序：macOS的textutil，其他系统的antiword/unrtf，以及tesseract、drawingtotext。未启用或缺程序明确报告，不把损坏二进制当文字返回。原生能力使用固定命令和参数，模型不能配置程序、路径或环境。

每次解析使用独立进程组、256MiB Node heap与私有临时目录，默认1个运行、4个排队，排队及解析共20秒。退出前终止整个所属进程组并清理临时文件；它是资源和生命周期隔离，不提供操作系统沙箱。ZIP逐项按实际解压量预检，最多2000项、单项16MiB、总64MiB，拒绝路径穿越、重复项、加密、DTD及实体；HTML/XHTML只兼容不含内部子集的已知惰性doctype。文本最多100万Unicode字符，每页最多11000字，完整结果最多12000字；`offset/limit/nextOffset` 可继续读取后部，无跨会话解析缓存。PDF字节使用精确独立视图，避免旧PDF.js的Buffer偏移错误。

`AgentToolContext.sendFile({ name, mime, base64 })` 为可信宿主工具提供当前会话的文件上传原语：最多12MiB，只接受完整字节与安全文件名，禁止路径、URL、平台文件引用及接收者参数。与文本/图片共用回合队列、配额、绑定复核和未知结果闸门；完成后端口撤销，同回合重复文件拒绝。文本文件的名称与正文经过出站规则；二进制生成器须在编码前执行相应内容审核。临时文件读取工具不获得上传端口，读取临时资料后不允许文件导出。

QQ适配器只向固定目标调用 `upload_group_file/upload_private_file`，bytes在适配器内转为 `base64://`。明确API成功且有有效 `file_id` 才返回独立 `FileDeliveryReceipt { state: 'uploaded', fileId }`，真实消息ID仅在确有证据时可选附带；不会把file_id当message_id。空file_id、超时、断线或派发后取消均为unknown，不自动重试或改用另一发送方式。本端口本身不代表torrent群触发后私发原发起人、完整视频或团录导出业务的迁移；网易云完整文件提取另见专节。

### 语音合成与受控音视频

```yaml
tools:
  voice:
    enabled: true
    provider: volcengine
    appId: "your-app-id"
    accessTokenEnv: BL_VOICE_ACCESS_TOKEN
    resourceId: "your-resource-id"
    voiceType: "your-voice-type"
    format: mp3
    maxTextLength: 80
    styles:
      normal: {}
      sleepy:
        speedRatio: 0.9
```

默认关闭。宿主显式启用后，群仿真按原工具策略提供 `voiceTool(text, style)`；公开宿主从 `bl-chat-agent/voice` 导入 `createAgentVoiceTool`。模型只给口播文本与样式名，endpoint、鉴权、资源与音色均由宿主配置。可选 `authorizationEnv` 同样引用环境变量；停用配置不读取凭据，但仍校验字段。工具先使用本回合冻结的人设名称、账号别名与守卫设置处理正文，再清理口播，默认80、最多300个Unicode字符，保留原样式选择和normal合并规则。无自动语音概率或实时流功能。

火山V3请求保留鉴权头、音色、速度/音高/音量、情绪与提示词，接收原始MP3/WAV/OGG及有界JSON、NDJSON、SSE音频块；合成完成后才交付，不是实时流。HTTP期限最多25秒，响应正文和解码音频分别最多20MiB，因此JSON/base64可容纳的实际音频略小；禁止重定向，取消/撤回/换绑前后复核。错误文本脱敏，尾部错误帧使整次合成失败。原文与最终口播在请求前检查已知宿主凭据和出站规则。

可信工具通过 `AgentToolContext.sendAudio({mime,base64,spokenText?})` 或 `sendVideo({mime,base64})` 交付，适配器收到固定目标的 `media.send`。音频最多20MiB、视频最多30MiB，验证规范base64和实际容器标识；拒绝URL、路径、平台引用和接收者参数。与文字/图片/文件共用队列、发送预算、绑定/来源复核及unknown冻结；音频口播执行出站检查，同回合相同字节或相同口播不重复发送，口播也防止普通文字重复。临时资料工具不获得媒体发送端口，临时来源回合拒绝音视频外发。

QQ映射为单个OneBot `record` / `video` 的 `base64://` 字节，仅明确API成功并有真实message_id才确认。NapCat WS1400 / Debug HTTP400是派发前schema失败；WS1200 / Debug HTTP200的handler异常可能发生在派发后，连同其他无法确定未派发的报错均为unknown，文字、合并消息、文件与媒体统一不重试。媒体原生请求最长180秒，实际期限还服从工具回合取消。容器校验和平台回执不能证明客户端能播放：NapCat非Silk语音转换依赖实际Native Addon，单有ffmpeg不足；视频探测失败也可能回退默认元数据。真实合成质量与QQ播放须另行验收。

音乐搜索卡片与网易云完整文件提取见后续专节；自动视频/图集转发、视频分析及torrent私发原发起人仍分别迁移，不能用本节原语代替其业务完成。

### QQ 音乐搜索卡片

```yaml
tools:
  music:
    enabled: true
    # 可选；未配置时匿名搜索并尝试高质量链接，失败用官方试听链接
    cookieEnv: BL_QQ_MUSIC_COOKIE
```

默认关闭。群仿真按既有工具策略提供 `searchMusicTool(keyword,isArtistOnly?)`，其他会话不扩大工具面。指定歌曲仍第一页一首取第一首，只给歌手仍为普通歌曲搜索第一页最多20首中随机选择。保留QQ音乐移动搜索、七档高质量候选、首个非空purl和官方试听回退；没有把音乐搜索改成音频下载。公开宿主从 `bl-chat-agent/music` 导入 `createAgentMusicTool/createAgentMusicProvider`。

仅向固定QQ音乐API发送关键词和宿主显式配置的音乐服务Cookie，不读取聊天历史、全局Bot或另一个接入账号的Cookie。Cookie可为空，启用且声明cookieEnv时必须有对应环境变量；停用只校验声明而不读取凭据。音乐服务凭据是本宿主显式共享的独立服务身份，发送目标仍由当前接收账号与版本化绑定固定。高质量请求guid及试听uin来自本回合账号。

有Cookie时保留十分钟检查和十二小时续期条件，启动与在线后台刷新由宿主独立生命周期授权，至少有一个就绪且仍绑定仿真群的账号才允许后台请求；真人取消不借用该服务授权继续发送。刷新使用旧QQ/微信登录协议的JSON正文和form Content-Type。新凭据先进入动态脱敏集合，再在 `dataDir/music-credentials/qq-music.json` 私有文件原子续存，目录0700/文件0600；环境变量初始Cookie的指纹改变时不复用旧续存结果，不改宿主配置或环境文件。跨调用刷新合并，每个调用者仍各自检查取消与权限。

动态凭据检查同时覆盖模型内容留存与公开工具执行。包含新凭据的正文不进会话历史；被拒的工具调用只留下安全名称/ID、空参数和通用错误，不回显原参数，也不带回下一次模型请求。Unicode转义再经JSON串行化的密钥同样拒绝。这些规则只拦截宿主凭据，不把普通禁词配置扩大为所有工具参数的过滤规则。

可信producer通过 `sendMusic({title,artist?,pageUrl,audioUrl,coverUrl})` 发送闭合卡片；首版QQ只允许群聊，封面必填以符合现有NapCat converter。Core检查全部文本及URL的出站规则，临时资料回合拒绝卡片发送，与文字/媒体共用队列、预算、重复歌曲闸门和unknown冻结，真实message_id才确认。播放签名参数不进入模型工具结果或工具历史，只交给QQ适配器；标题/歌手和真实回执可见。QQ adapter仅接受该provider的官方页面、封面及试听/CDN URL结构，禁止任意native段、headers、接收者、路径或签名端点参数。

QQ音乐卡片本身依赖平台侧签名服务。审计的NapCat源码（SHA256 `69cf1346c466b8b1ab2f2c13c5314af2b3fb54fb9798c015c582db55548006b2`）会把完整标题、歌手、封面、页面及带vkey的播放URL发给 `musicSignUrl`，未配置时使用 `http://106.55.0.102:10087/`，失败后转 `https://ss.xingzhige.com/music_card/card`。它允许签名HTTP重定向且不受Core本机DNS/响应预算控制；本地取消不能保证平台已派发的签名请求或迟到发送停止。Core保证一次原生send_group_msg且unknown不重试，不宣称NapCat内部无fallback或客户端已可播放。启用此功能包含上述平台签名出机边界；签名服务、真实QQ卡片和会员播放质量另行验收。

这项搜索卡片能力与网易云分享提取独立。后者仍须保留自动群触发及主人引用入口、完整文件→信息→试听三阶段，解决20MiB附件、来源授权、持久去重和每阶段回执，不能用音乐卡片或sendAudio替代。

### 网易云完整文件提取

独立宿主通过单独的musicExtraction启用该业务，与tools.music搜索卡片分别控制：

    musicExtraction:
      enabled: true
      operators:
        - platform: qq
          namespace: global
          id: "123456789"

默认关闭。启用后，显式绑定群内非机器人发送的网易云分享自动提取；宿主列出的完整操作员身份还可引用本群或当前好友私聊中的分享，发送“.音乐提取”。群管理身份、模型自报权限及最近发言者都不授予该主人入口。操作员列表为空时只开放群自动入口。关闭宿主、会话或好友准入，以及换绑、撤回或来源隐私变化，都会阻止后续动作；独立宿主配置快照变化也会取消正在准备或交付的提取任务，重新启动后才采用新配置。

适配器的readMusicShare重新读取并核对消息ID、作者、时间及完整会话地址，只返回中立网易云引用，不把原生JSON、下载URL或平台对象放入Core入站与模型历史。兼容旧JSON、标准OneBot嵌套JSON、原始CQ JSON、原生163音乐段及普通官方song/dj链接；短链、hash路由、歌单不自动扩展。私聊额外读取当前好友列表，不能把NapCat的sub_type: friend单独当作好友证据。当前审计的NapCat对机器人自己发出的私聊历史缺少可核验的对端字段，这类引用保守拒绝；入向真实好友分享有完整读取路径。

提供方保持普通歌曲详情、DJ主音频和官方卡片直链三条路径；每次解析全部DNS结果，只连接已核验公网地址，并逐跳检查最多三次官方域名重定向。元数据最多2MiB/10秒，整个准备过程最多60秒，完整音频最多20MiB，MIME与实际容器签名匹配后才形成字节附件；不落临时文件。公开/music-extraction提供受控解析器，模型不能指定网络后端、Cookie、文件路径或接收者。

完整音频附件使用独立audio-file.upload/sendAudioFile，不提高现有12MiB通用文件读取或上传限制。附件与试听拥有同一份已核验音频字节，QQ只向固定当前群或好友调用一次上传API；成功保存uploaded/fileId，不伪造普通messageId。正常流程依次为完整文件、信息合并转发（不支持时文字）、record试听。明确文件失败沿用试听与失败说明；明确合并转发失败可回退一次文字。任何阶段的unknown都会停止全部后续发送，不把未知当明确失败继续回退。

交付账本按完整账号、会话、绑定版本及本次入口消息去重，7天TTL，每个阶段先保存pending再派发。账本只保留有界状态和有效回执，不保存原始分享、音频或模型参数。相同入口并发或重启重读不重复派发；重启遇到未完成领取或pending会冻结为unknown，不自动继续或重发。平台确认后本地结算失败也停止后续步骤。这是有限保留期内的尝试防重，不是跨系统exactly-once或自动恢复送达保证。本节功能的构建、工程与安装包验收状态以文末进度为准。

### 完整媒体搬运的资源与有序计划合同

`bl-chat-agent/media-relay` 提供可信宿主的 `createAgentMediaArtifactStore`、`validateAgentMediaArtifact`、`validateAgentMediaRelayPlan` 和 `createAgentBilibiliRelayProvider`。主入口导出中立资源、计划、`AgentMediaShare`、准备提供器、`AgentMediaRelayConfig`、`MediaShareReadOptions` 及 `SendMediaRelayAction` 类型；子入口另导出仓库、B站提供器及其可信宿主选项。搬运业务由Core持有，渠道负责来源协议解码和中立计划的原生转换。它是显式启用的确定性群分享流程，不注册模型工具；工程与安装包验证状态见文末。

宿主先指定已有受控父目录创建仓库，再将 `AsyncIterable<Uint8Array>` 流式stage。仓库自行创建0700随机子目录，文件写入为0600、完成后0400；返回的租约只有随机资源ID、kind/MIME、真实sizeBytes和SHA256，没有路径、URL或base64。单视频512MiB、单图32MiB，默认全仓16GiB/128资源，可通过 `maxTotalBytes/maxArtifacts` 缩短；内部写入和读取块最多1MiB，不要求完整文件进内存。支持MP4/QuickTime/WebM/FLV和PNG/JPEG/GIF/WebP/AVIF/BMP真实容器头，不把签名验证当作解码或播放证明。

`lease.retain()` 为预热、发送或后续重试保留同一资源；各owner最终等待 `release()`。资源端口 `open(artifact, context)` 仅核准本仓有效完整元数据，返回只能消费一次的chunks和幂等close，先验证真实文件身份及完整hash，再按块复核授权和内容。最后租约、仓库关闭、signal或失效current会停止后续读取；宿主必须提供绑定/来源及隐私复核的context，单有资源ID不授予读取会话资料的权限。仓库close等待并清理自己的临时目录，不扫描或删除邻居；独立宿主的实例租约与精确owner标记负责崩溃遗留清理，见下文。

计划保留有序文字、图像、视频和可选图像缩略图，冻结自有快照并拒绝原生作者、目标、路径、URL或其他额外字段。同ID元数据须一致；最多128节点/512部分，文字单项64000Unicode字、总256000字，不同资源总16GiB，宿主可传入allowsText执行当前出站规则。超出明确拒绝，不静默截页或拆发。该合同独立于原12MiB通用bundle与30MiB sendVideo，尚不证明QQ平台可发送512MiB混合视频。验收状态见文末进度。

### QQ媒体资源桥与原生交付

可信宿主从 `bl-chat-agent/qq` 导入 `openQqMediaRelayBridge`、`createQqMediaRelayDeliveryPort` 及桥类型。桥选项必须显式给出受控 `directory`、`resources`、字面IP/端口的 `listen`、无路径的 `advertisedOrigin` 和1至32个精确IP的 `allowedPeers`。端口0仅供自动分配，公布origin中的端口0会替换为实际监听端口。HTTP公布地址只接受RFC1918、回环与IPv6 ULA；公网/其他域名须HTTPS并由宿主反向代理提供TLS。ACL只认socket对端、不信任转发头；代理、可信网络与NapCat可达性由宿主装配。

`bridge.stage(artifact, context)` 先经原资源端口读取，流式复制到独立私有仓库并完整复核kind/MIME/size/SHA256，才返回适配器内部的 `nativeUrl/release()`。随机256bit资源URL最长90分钟，仅GET/HEAD，无Range，单URL32次请求、GET预留最多8倍完整资源字节；每块最多1MiB并等待背压。释放、失效、deadline或close撤销URL、关闭在途连接、等待清理自有副本。不得把URL写入模型、持久状态或日志。

这是可信宿主的底层端口；宿主须先执行完整出站净化和来源/隐私授权，并以allowsText持续复核文字，模型不直接获得该端口。在 `OneBotEndpoint.mediaRelay: { bridge, allowsText? }` 注入后，连接才提供 `actions.sendMediaRelay`；不注入时不装配。动作 `kind: 'media-relay.send'` 使用固定账号/会话、可选绑定快照、`mode: 'forward' | 'direct-video'` 和中立plan。forward保留所有节点与部分顺序，作者统一机器人；direct-video仅允许视频并单次发送全部视频。QQ两种模式均要求视频缩略图，缺失明确拒绝。不同artifact每次只stage一次；每connection完整准备及发送串行，最多4个等待，入口捕获原socket，排队/复制期间重连后旧任务不能使用新连接。

完整调用独立采用最多90分钟有限期限，既有media/bundle期限保持原值。真正message_id和可选账号/目标一致才sent；schema400/1400及唯一精确的发送前资源预处理AggregateError是failed，其他handler1200/超时/断线/无效回执是unknown。端口自身零重试、零降级，finally释放全部桥租约。平台100MiB混合限制、整文件缓冲和上传时限须真实部署重新核验；字节传输工程验证不能代替QQ投递和客户端播放验收。

### Core自动媒体搬运与持久投递

`createAgentRuntime` 通过 `mediaRelay: { enabled: true }` 和可信宿主提供的 `mediaRelayProvider` 显式启用；缺提供器直接拒绝构造。省略 `providers` 保留原B站启用边界，抖音须显式给出 `providers: ['bilibili', 'douyin']`（也可只选抖音）。默认关闭时不读写媒体队列、不下载或启动桥。流程先于文字/仿真模型和历史采集处理真实群来源，私聊不自动搬运。QQ来源端口只回传完整地址、原作者/时间及闭合BV/b23/EP或抖音video/note/short引用；原生JSON、下载地址和凭据不进入Core队列。固定账号/socket的get_msg及每次副作用前均重新核验来源，撤回、隐私删除、换绑、停用、宿主租约丢失取消后续操作和迟到资源。提供器页面须与来源provider一致，直接作品ID一致；短链允许解析成同provider的规范作品页。

同平台namespace的配置账号中，只考虑当前就绪、具有媒体端口且显式绑定本群的账号。排除所有配置机器人发出的来源；有机器人@时从被@候选中选一个，否则从全部候选中按群号与排序账号列表稳定选择一个。即使同时@多个机器人也只选一个。这与旧插件的在线机器人发现和多@处理不完全相同，不保证不同独立宿主之间全局选主。

B站提供器在Core媒体模块解析官方BV/b23/番剧，获取简介、UP、发布时间、统计、封面及有序分P/durl，默认qn6、匿名优先，仅登录/试看条件允许一次显式授权复试；授权后仍试看时不交付任何视频。匿名试看保留明确提示。大于30分钟或20P明确输出信息，资源数量超预算也明确降级，不静默截断；每durl独立资源，避免同cid多段覆盖。API阶段10秒/2MiB、单下载候选10分钟、单视频512MiB/单图32MiB；官方域名、全部DNS公网、固定实际IP/family和重定向逐跳校验，Cookie只发固定官方API。原始下载URL和私有文件始终留在提供器内部。缩略图使用受控ffmpeg子进程生成；失败时保留完整中立视频及可选缩略图，QQ端口因缺缩略图明确拒绝后，由Core选择原链接回退。其他渠道可直接消费无缩略图的视频。

Core持久账本以完整会话、绑定版本及原消息ID记录任务；另以platform/namespace/物理群/原消息ID的共享归属标记防止同实例其他账号或换绑绕过尝试，引用变化不能创建第二次尝试。该标记只有任务摘要，不共享聊天或计划；群来源撤回同时阻止同实例兄弟账号已有任务的迟到准备与回执，私聊仍按完整账号隔离。全局128/每会话lane32个任务、24小时期限、7天终态防重；只持久化有界来源引用/身份、状态与回执，不写计划、媒体元数据、字节、下载URL或模型参数。准备并发2、预热3分钟，按连接及完整会话FIFO，单连接副作用串行。原账号断线时等待；重启对无副作用的准备重新准备，已有pending/sending按unknown冻结。每阶段先保存pending，再原生调用，再保存sent/failed/unknown；回执保存失败停止后续。

QQ明确缺缩略图时回退原链接。仅精确的派发前资源预处理失败允许一次完整转发重试，再失败则发送介绍及全部视频直发；纯图集没有视频时直接回退链接。明确失败后发原链接。任何阶段unknown立即冻结，禁止重试或继续下游。它是有限保留期内的尝试防重，不能保证跨系统exactly-once。引用provider不进入物理来源防重键，不能把同一原消息换provider当作新尝试。其他提供方、视频分析、搜索卡片及显式高清/扫码授权使用后述独立业务边界与验证状态。

独立宿主配置示例（每个已声明连接都须有独立桥）：

```yaml
mediaRelay:
  enabled: true
  bilibili:
    autoAuthorizedRetry: false
    # cookieEnv: BILIBILI_COOKIE  # 仅确有授权复试需要时配置
  douyin:
    enabled: false  # 只有显式true才装配抖音提供器
  bridges:
    - connectionId: qq-primary
      listen: { host: '127.0.0.1', port: 18911 }
      advertisedOrigin: http://127.0.0.1:18911
      allowedPeers: ['127.0.0.1']
```

示例只适合同机NapCat；远端部署须改为NapCat实际可达的受信网络地址和精确对端IP，公网须可信HTTPS代理。CLI桥端口须1至65535，不用自动端口；所有监听互不重复。Cookie引用环境变量，关闭时不读取。视频缩略图依赖宿主安装ffmpeg；缺少或生成失败时QQ走明确链接回退，不能据此声称已完整视频投递。

抖音提供器同属Core，通过公开 `createAgentDouyinRelayProvider` 准备中立计划，`parseAgentDouyinReference` 只做官方作品/短链语法归一。独立CLI须另设 `mediaRelay.douyin.enabled: true`，省略或false不装配抖音提供器；不新增任意解析端点、Cookie、浏览器地址或执行路径配置。QQ文本、CQ、JSON与旧原生douyin段统一解码为video/note/short，保留旧B站扫描优先和原生段位置规则。QQ不接收作品详情中的任意CDN资源作为可信分享。

Core完成分享页静态解析、目标作品浏览器回退、视频或图集下载、可选配乐轮播和缩略图，再交同一有序媒体计划。视频限30分钟/512MiB；图集保留旧20张护栏，超过明确说明，单图32MiB，失败位置明确提示；信息、图片、配乐视频顺序保留。配乐限32MiB/5分钟，按成功图片数将每图时长限制在2至10秒，输出720×1280 H.264/AAC视频，并探测成品时长/音视频轨道，避免将大小限制造成的截断当作完整成品；配乐失败保留图集。HEIC图片先在Core转成支持格式，宿主解码器不支持时说明对应图片失败。所有临时资源由同一生命周期释放，不把音频中间文件、CDN URL或浏览器会话写入队列。静态和浏览器结果只接受对应作品ID，不能借推荐流填充原作品、图片或配乐。宿主须提供Puppeteer可用的Chrome与固定ffmpeg/ffprobe；缺少Chrome时保留静态解析或原页，缺少编码工具时保留图集及无缩略图的完整中立视频，再由渠道处理其兼容要求。

`--check`只验证配置声明及原有只读Redis/QQ登录核对，不启动桥、不下载媒体。正式启动先取得实例Redis执行租约，再在dataDir下建立按实例摘要隔离、带精确owner标记的0700私有根和随机run。只清理同实例、精确名字/标记且非符号链接的旧run；无标记、其他实例和邻居保留。退出先停Core，再关闭各桥和资源仓库，最后释放Redis；SIGKILL遗留在下一次持有该实例租约时清理，不在通用资源仓库中扫描父目录。

### Core小红书自动搬运

小红书同样由Core完成官方分享识别、静态解析、目标笔记浏览器回退、媒体下载和中立计划。QQ只解码文本、CQ/JSON及原生分享段，并转换为原生交付；保留B站及抖音的既有选择优先级，小红书作为后续候选。Core可显式给出`providers: ['bilibili', 'douyin', 'xiaohongshu']`；省略仍仅启用B站。独立宿主另设：

```yaml
mediaRelay:
  enabled: true
  xiaohongshu:
    enabled: true
    # cookieEnv: XIAOHONGSHU_COOKIE  # 可选，只允许环境变量引用
  # bridges 与既有媒体配置一致，每个连接各一个
```

`parseAgentXiaohongshuReference`仅返回官方note或short引用。直接笔记ID规范为16至32位小写十六进制；短链支持闭合单token及`a/token`路径，保留大小写。分享中的`xsec_token/xsec_source/type`是短效访问上下文，通过`AgentMediaRelayPrepareContext.readSourceAccess`从原账号、原消息、作者和时间重新核验后临时取得，URL解码一次、构造编码一次。队列、prepared页面、介绍与失败链接只保留无查询的官方地址；正文及文字部分入队前清理访问query，模型可见引文和转发同样清理，原文仍先接受来源授权。恢复必须重新读取原平台来源，不能从另一条消息、推荐作品或旧缓存借访问参数。升级前积压收件保留原字节用于确认消费，使用时再次净化，避免扩散到新历史或模型；不宣称即时重写已有持久记录。宿主Cookie只送受控第一方页面；浏览器使用单独匿名私有profile。浏览器除受控GET外，仅允许精确`edith.xiaohongshu.com/api/sns/web/v1/feed`的有界POST：笔记ID和访问token绑定当前任务，仅带受限签名头，保持原请求体字节且不跟随POST重定向。匿名parent Cookie仅在原页面与该feed间按浏览器域规则使用，不传给其它子域或CDN。

中立计划保留信息、独立全文、原作品媒体顺序。全文最多2000Unicode代码点；主视频限1800秒/256MiB、10分钟下载。图集保留20槽护栏，每图32MiB/60秒，超限和失败位置明确说明。实况照片按原槽优先视频，成功替换该槽静态图，失败退回该槽图片，修正旧静态与实况分组拼装造成的乱序。图片先用原始签名URL，失败才按受限fileID重建unsigned候选；图文的实况视频不能成为主视频。静态、浏览器state与DOM都限定原笔记身份，不使用推荐作品或QQ卡标题/封面填充官方内容。媒体、转换、缩略图及资源lease共用取消生命周期；缺缩略图仍保留完整中立视频，再由QQ的兼容要求进入链接回退。默认关闭与unknown不重发规则不变。工程和真实平台验收状态以文末进度为准。

### Core YouTube自动搬运

YouTube沿用同一Core业务边界：官方分享先转为闭合视频引用，Core通过固定yt-dlp提取目标视频、核验官方作品身份，独立下载封面和选定单文件MP4，形成统一文字/图片/视频计划，再由持久outbox交给QQ。QQ只解码文本、CQ/JSON及原生分享URL，不采用卡片自报标题、video_id或CDN作为官方信息。B站和抖音的既有选择优先级保留，YouTube位于小红书之前。默认仍仅启用B站；YouTube须额外显式配置：

```yaml
mediaRelay:
  enabled: true
  youtube:
    enabled: true
    # cookieEnv: YOUTUBE_COOKIE
    # poTokenEnv: YOUTUBE_PO_TOKEN
    # proxyEnv: YOUTUBE_PROXY
  # bridges 与既有媒体配置一致，每个连接各一个
```

Core宿主使用`providers: ['youtube']`或在已有列表显式加入`youtube`。`parseAgentYoutubeReference`识别官方watch、shorts、embed、live及youtu.be形式，ID固定为11位大小写敏感字符；队列只保存provider、kind和ID，安全页面固定为`https://www.youtube.com/watch?v=ID`，不保存分享tracking或播放列表参数。

提取只处理当前一个视频、不下载媒体或执行合并；忽略用户配置、插件、缓存与继承代理，使用私有HOME和有限输出/时间，Cookie及PO Token通过作业私有文件传给固定yt-dlp，不写入原始argv、模型、队列或计划。元数据提取至多两次，只有首次非缺程序/超时的提取失败才等待2秒再试；目标身份或返回结构不符直接拒绝。原生进程通过作业独占的HTTPS CONNECT代理访问闭合官方域，逐连接本地核验公网DNS并固定地址。可选HTTP(S)/SOCKS宿主代理只从显式环境变量取得，代理连接使用已核验的目标数值IP；该出口约束不是OS网络沙箱。

计划保留标题、频道、时长、统计、简介及可用封面。封面8MiB/15秒；非直播且已确认时长不超过30分钟时，尝试选定的同时包含音视频的单文件MP4，最多512MiB/10分钟，不以视频单轨、音频单轨或合并计划替代。CDN只允许受限ytimg图片及googlevideo视频，下载逐跳核验DNS，不传宿主Cookie或任意返回header；部分响应、长度不全和压缩体不能作为完整资源。封面失败保留视频，视频失败保留信息、封面及规范页面；缩略图失败仍保留完整中立视频，由QQ要求决定链接回退。来源撤回、换绑、隐私、停用及宿主租约失效取消后续请求和迟到资源；既有v1去重、pending及unknown不重发规则不变。工程和真实外部验收状态以文末进度为准。

### Core Pixiv自动搬运

Pixiv遵循同一Core边界：QQ只解码当前原消息中的官方作品URL；作品详情、分页、下载、限制判断和失败说明都由Core生成，再产出我们的有序文字/图片计划供各渠道兼容。卡片自报的作品ID、标题和图片地址不作为官方数据。保留B站、抖音、YouTube的既有优先级，Pixiv位于小红书之前。默认仍只启用B站，Pixiv须显式开启：

```yaml
mediaRelay:
  enabled: true
  pixiv:
    enabled: true
    allowRestricted: false
    # cookieEnv: PIXIV_COOKIE
    # proxyEnv: PIXIV_PROXY
  # bridges 沿用既有媒体配置，每个连接各一个
```

可信Core宿主通过`providers: ['pixiv']`及`createAgentPixivRelayProvider`接入。`parseAgentPixivReference`支持官方artworks、双字母语言路径及member_illust.php形式，作品ID为无前导零的1至12位数字；持久引用只有provider/kind/id，准备页和回退页固定为`https://www.pixiv.net/artworks/ID`。安全tracking不进入计划或队列，矛盾作品ID和凭据查询拒绝。

Core并行读取原作品详情和分页（各2MiB、共用7秒期限），仅接受原作品身份及`i.pximg.net`中与原ID/页序号一致的图像；regular、small、original按顺序择优，分页失败或全不可用才尝试详情首页。保留前5页、单图16MiB、合计40MiB、每图90秒；失败页保留其原位置说明，其他有效页按原顺序交付，超页和预算不足明确提示。介绍保留标题、画师、页数、尺寸、标签、统计、短简介与规范链接。默认受限作品仅给信息，不请求图片；无有效受限标记也保守保留元数据。`allowRestricted: true`只能由宿主显式配置，且只覆盖已验证的受限标记。

可选Cookie仅发给原作品固定详情/分页端点，重定向不可换端点，不发CDN；可选HTTP(S)/SOCKS代理仅来自显式环境变量。每跳官方目标、全部DNS公网及实际连接地址均核验，媒体流有完整长度、期限、预算及跨块凭据检查。资源只通过不透明租约进入计划，撤回、换绑、隐私、停用和丢租约取消后续请求与迟到资源；既有v1来源防重和pending/unknown冻结不变。自动搬运不调用模型、不自动处理私聊；模型显式搜索及五分钟选图见下节。工程与真实外部验收以文末进度为准。

### Core Pixiv搜索与选图下载

`pixivSearchTool`和`pixivDownloadTool`由主模型针对当前真人群仿真请求选择，保留原工具策略，不扩大好友私聊、群文字、自主或承诺工具面。搜索、热门与画师识别、列表绘制、五分钟选择、下载和中立计划归Core，QQ只转换当前账号/群的图片卡及完整合并转发。独立公共入口为`bl-chat-agent/pixiv`。

```yaml
tools:
  pixiv:
    enabled: true
    allowRestricted: false
    # cookieEnv: PIXIV_TOOLS_COOKIE
    # proxyEnv: PIXIV_TOOLS_PROXY
mediaRelay:
  enabled: false  # 工具可独立于自动搬运启用
  bridges:
    - connectionId: main
      listen: { host: 127.0.0.1, port: 19080 }
      advertisedOrigin: http://127.0.0.1:19080
      allowedPeers: [127.0.0.1]
```

每个连接都须配置可被对应QQ服务访问的资源桥；桥与自动搬运共享实例租约、私有仓库及清理生命周期，工具提供器和凭据独立于自动提供器。关闭工具不读取其环境凭据、不装配工具；只有Pixiv工具、自动搬运与bilibiliQuality全部关闭时才不启动媒体桥。配置变化使正在执行的工具定义失效，取消后续请求与排队发送，重启后采用新配置。`--check`校验声明与显式凭据，但不调用Pixiv、不创建资源目录或桥；迁移预览允许凭据暂缺。

搜索支持`keyword`、`searchType: artworks|artist`、`orderBy: newest|oldest|popular`。最新/最早沿用原生时间顺序；登录Cookie下热门请求原生`popular_d`，匿名时匹配官方日/周榜及标签译名，并对最多24候选查详情按收藏数重排。结果明确标注`native`、`ranking`或`rerank`，不能把候选重排称为全站热门。画师按搜索页姓名互含及出现次数识别，再从其最近16个作品候选取最多8个有效详情；成功识别后固定最新，未识别回落作品搜索。元数据只访问固定官方搜索、榜单、画师作品及单作品端点；每响应2MiB，普通搜索12秒、画师24秒，Cookie不发图片CDN。

卡片展示前8项缩略图、标题、画师、多图数、收藏、ID及受限标记。Sharp只合成已验证像素和转义文字，不打开浏览器或外部SVG资源；每缩略图3MiB/12秒，最多一次重试，失败、受限或未知受限标记使用占位。卡片明确失败或渲染不可用时返回完整前8项文字；未知回执停止后续动作，不补发文字。

列表按完整账号/会话及Agent、人设和绑定版本保存20项安全元数据，群内共享一个槽，5分钟过期，新搜索立即替换；不保存查询词、缩略图URL或媒体字节。序号仅1至8，兼容`#`、`No.`和`第`前缀；索引下载须重读原搜索的真实消息/作者及隐私、撤回和绑定。5至12位作品ID可独立下载，无旧列表或旧来源失效不阻止这一入口；多选及磁链目标拒绝。下载复用前5页、16MiB单图、40MiB总量的提供器，完整有序计划一次发送，不缩成小图bundle。仅确认图片送达后，仍获授权且未被新搜索替换的原列表才CAS续期；元数据说明、failed和unknown均不续期。

两工具沿用统一发送队列、配额、内容审核、来源/版本及历史临时资料隔离。媒体转发端口只授予真人群回合且固定当前目标；模型不能指定账号、群或交付模式。7天动作尝试在提供方/发送前持久登记，pending、sent、failed、unknown均不自动重试；原生送达与Redis保存不构成跨系统事务，未知结果须核实。真实Pixiv网络、Cookie/代理、模型选用质量及QQ客户端显示另行验收。

### Core B站搜索与中立视频卡片

独立宿主通过`tools.videoSearch.enabled: true`显式装配`searchVideoTool`与`videoShareTool`，默认关闭；配置只接受`enabled`及可选`attachments`布尔开关，不接收Cookie、代理、解析端点或模型指定目标。公开入口`bl-chat-agent/video-search`导出工具工厂、B站元数据提供器、校验器及`AgentVideoCard`、`AgentVideoSearchProvider`、`SendVideoCardAction`合同。搜索、解析和中立元数据归Core；QQ只把审核后的固定卡片转换为一个原生JSON消息段，不接收模型提供的卡片JSON。

`searchVideoTool({keyword})`供当前真人群仿真及显式授权的普通群文字请求查询，按B站相关度返回最多8条元数据，第一条为首选，查询不会发送卡片；普通群文字授权见下节。官方固定搜索接口使用匿名设备标识，fingerprint不可用时以静态诊断说明匿名降级；取消、撤权或超时不走降级。元数据每响应2MiB、一次提供器操作最长15秒，逐跳官方域名、公网DNS与实际数值IP/family固定；查询不下载封面、视频或音轨，也不调用分析模型。

搜索列表按平台、namespace、机器人账号、会话、Agent、人设、连接和完整绑定版本隔离，单槽5分钟绝对过期，不因读取或发送续期。新搜索开始立即替换旧列表并使迟到查询失效。Redis只保存最多8条闭合元数据、原消息/作者和generation，不保存搜索词、原生JSON、设备Cookie、资源URL或媒体字节；只有规范公开作品页面URL可随卡片保留。

真人明确要求发送时由`videoShareTool`单选`id`、`index`、`url`或`query`。ID/序号必须命中仍有效的列表，并在解析、排队及最终投递前复核原搜索与当前请求的真实来源、撤回、隐私和generation；直接URL/关键词须逐字出现在本轮真人请求中，不借旧列表或伪造媒体来源。官方BV/番剧页面和b23短链可解析，直接作品URL的结果必须保持同一作品身份。卡片只含provider、作品ID、标题、作者、秒数和规范公开页面；提供器使用同一公共validator验证，搜索隔离不合格条目，固定作品解析安全失败。HTML命名/数字实体经直接锁定依赖完整解码，最多四轮，控制码、孤立代理及残留实体拒绝。

`AgentToolContext.sendVideoCard(card, guard?)`固定当前群，共用发送队列、额度、净化与unknown冻结。工具把精确来源/generation的signal和检查闭包交给宿主；宿主消费异步授权，再把复合signal/isCurrent传至原生发送边界。只有明确sent且有真实非零message_id才确认；调用前持久登记pending，7天保留pending/sent/failed/unknown，重建工具或重启后不盲目重发，外部投递与Redis不构成跨系统exactly-once。

自主回合沿用`simShareVideoCard`，仅在当前工具清单授予时按话题分享一个卡片，query/url二选一、每群20分钟一张，并受当前绑定、人物隐私、沉默决定和发送额度约束。它通过同一中立卡片合同交付，不向自主或承诺回合授予真人搜索/列表选择工具。同回合pending/unknown重放保持unknown并冻结后续发送，sent/failed只报告已尝试；畸形或不可用账本也关闭发送。卡片分享不代表普通视频下载、完整视频搬运或高清提取迁移。

本批已完成一次集中后端构建（2310文件、TypeScript5.9.3）、完整后端及测试类型检查和Core边界检查。候选`.release/agent-e4Sysl`的真实npm归档在仓库外离线安装，再按包内原始shrinkwrap执行npm ci：491个依赖版本精确一致，19个可选平台依赖省略，无链接替代。安装后的9组137项测试全通过，失败/取消/跳过均零；公共严格TypeScript消费者实际运行查询/解析、既有外部宿主与篡改启动保护也通过。423个运行/声明文件与当前构建逐字节一致，430个发布文件校验通过。证据为`/tmp/bl-video-search-package-proof.json`、`/tmp/bl-video-search-installed-suites.log`和`/tmp/bl-video-search-public-consumer.log`。最终目录只同步本段README与清单，运行/声明文件保持已验候选一致。真实B站服务可用性、模型选用质量与真实QQ卡片显示/读回尚未验收，不把合成HTTP/OneBot回执当作客户端验收。

### Core 视频附件与普通群文字

`tools.videoSearch.enabled`仍只启用搜索和卡片；新增可选`attachments: true`才装配`videoDownloadTool`。搜索只返回按相关度排列的元数据，卡片分享只发送卡片；明确下载视频时才准备完整匿名QN16视频、介绍及封面，最多两段、每段30MiB。附件提供器由Core解析、下载及校验，渠道只消费统一计划并交付。它不读取自动搬运Cookie或高清账号授权，不将两种投递当成同一个成功结果。同一真人请求的卡片/附件共用持久防重，pending/unknown禁止重试或补发。

普通群文字须在`textGroups.tools`显式列出需要的能力，同时相应宿主提供器和平台端口须已配置。未列出的群、好友私聊、自主及承诺回合不因此获得视频附件权限；仿真真人回合沿原工具授权装配。

```yaml
tools:
  videoSearch: {enabled: true, attachments: true}
textGroups:
  - connectionId: main
    conversationId: '90001'
    tools: [searchVideoTool, videoShareTool, videoDownloadTool]
mediaRelay:
  enabled: false
  bridges:
    - connectionId: main
      listen: {host: 127.0.0.1, port: 31587}
      advertisedOrigin: http://127.0.0.1:31587
      allowedPeers: [127.0.0.1]
```

启用附件时所有连接均须声明媒体桥，并与磁链/团录桥检查监听冲突；自动搬运可以保持关闭。`--check`只解析及核验原有Redis/QQ连接，不建附件目录、不启动桥或请求B站。正常启动取得实例租约后才创建独立匿名提供器，其资源与桥按原生命周期释放。

群文字的查询结果只供本轮有限模型续轮，5分钟选择列表仍按完整账号/会话/Agent及绑定版本保存安全元数据。查询后的序号选择固定本轮列表generation；另一查询替换列表即取消旧续轮，不能将旧序号用于新列表。原始触发正文及平台时间变化、原消息撤回、隐私、换绑或配置撤销都取消后续模型及投递。读取显式历史后不允许借视频工具外发；视频结果和派生回答不进入聊天历史、人物学习或情节记录。

群文字一次明确投递在派发前领取原有持久动作槽，只向当前群发送一个完整转发或一个卡片，成功后不追加确认文字。确认状态单独记为`confirmed-media`，不触发文字学习；回执或持久结算未知保留防重且不发错误兜底。确认未派发的准备失败才由模型解释，模型不可用时附查询编号；说明本身也重新核验原始来源。媒体发送端口新增可选异步`ensureCurrent`，Core、工具包装、仿真发送队列及QQ暂存/派发边界均须传递并等待，不能仅靠周期轮询判断列表或来源仍有效。

本批集中后端构建2346文件（TypeScript5.9.3），后端及测试严格类型检查、Core边界与CI YAML检查通过。真实Redis的普通群文字15项验证搜索续轮、单次完整交付、来源正文/时间替换、generation替换、动作槽领取后撤权、暂存后复核、隐私取消、历史回合禁止外发，以及unknown重启防重。新实际CLI3项使用真实独立进程、Redis、OneBot WebSocket和HTTP资源桥：群文字搜索后匿名QN16获取同作品两个不同完整MP4分段，按字节和SHA256核验一个三节点forward；确认后零额外文字，unknown同源重复与重启均不重发或追加模型调用；默认关闭零媒体桥及零官方API请求。官方HTTP响应、媒体与缩略图进程和OneBot回执均为明确本地替身，未请求真实B站。另有152项相邻回归及75项重新编译的仿真领域测试通过。

候选`.release/agent-Om75JX`仅生成一次，真实npm归档在仓库外按锁离线安装，再在安装包自身目录按原始shrinkwrap离线npm ci：512个依赖版本精确一致、19个可选平台依赖省略，无源码或依赖符号链接替代。16组349项安装后专项全部通过，失败/取消/跳过均零，其中包含新附件3项和原搜索3项实际CLI。公共严格TypeScript消费者实际运行、外部宿主及启动篡改保护通过；440个运行/声明文件与当前构建逐字节一致，447个发布文件校验通过。最终发布目录仅同步本段README及清单，运行/声明文件保持已验归档一致。证据：`/tmp/bl-video-attachments-package-proof.json`、`/tmp/bl-video-attachments-{installed-suites,public-consumer,cli,regression,domain}.log`，文档同步后文件一致性见`/tmp/bl-video-attachments-release-equality.json`。

本地首轮346项构建专项为345通过、1项测试同步断言失败：计数在异步来源读取完成前增加，测试提前修改来源，正确拒绝后没有第二次检查。仅改为等待首次核验成功再撤权，保留全部检查次数、发送和配额断言，整份17项复验通过；最终349项安装专项整批全绿，未重新构建。证据：`/tmp/bl-video-attachments-built-suites.log`与`/tmp/bl-video-attachments-relay-test-synchronization.log`。工程红例还核验并修复了来源正文/时间改变后仍发失败说明、旧列表序号跨模型续轮误选新列表、QQ排队/暂存后丢失异步来源复核；单次整批构建后没有修改产品代码。真实B站服务、模型选择质量及QQ客户端显示/播放仍单独待验收，本批无生产部署、数据迁移或新增线上QQ发送。

### Core B站高清命令与扫码授权

`bilibiliQuality`是独立于自动搬运的显式权限边界，默认关闭。真人命令由Core确定性处理，不授予模型高清、凭据或任意收件者工具。可信主人可使用`.B站授权 登录`、`.B站授权 状态`、`.B站授权 退出`，并在当前群用`.高清搬运白名单 添加 @用户`、`.高清搬运白名单 删除 @用户`、`.高清搬运白名单 查看`管理权限；高清命令`.高清搬运 1080P BV1xx411c7mD`仅允许可信主人或本群白名单。质量接受240P、360P、480P、720P、1080P、1080P+、4K或1至127的QN值；作品来源限官方BV/番剧页面或b23短链，不接受任意下载URL。

```yaml
bilibiliQuality:
  enabled: true
  masters:
    - {platform: qq, namespace: global, id: '330001'}
  whitelist:
    - target:
        account: {platform: qq, namespace: global, id: '123456001'}
        kind: group
        id: '90001'
      users:
        - {platform: qq, namespace: global, id: '330002'}
mediaRelay:
  enabled: false
  bridges:
    - connectionId: main
      listen: {host: 127.0.0.1, port: 31487}
      advertisedOrigin: http://127.0.0.1:31487
      allowedPeers: [127.0.0.1]
```

白名单目标必须携带完整账号、会话身份并引用本宿主连接中的账号；启用高清时，所有连接均须有`mediaRelay.bridges`。高清可在自动搬运关闭时单独打开共享制品仓库和资源桥，不读取自动搬运Cookie，也不启用其他自动提供器。高清桥同样参与磁链/团录监听冲突检查。`--check`保留原有Redis/QQ只读核验，只解析高清配置，不启动B站授权请求、目录或媒体桥；正常启动取得实例租约后才可创建缺失的dataDir及授权目录。

扫码授权只访问固定官方passport生成/轮询端点，二维码在本地生成PNG；QQ端口回查原消息、作者、时间和正文SHA256后，只私发原请求者，禁止把二维码发到群或交给模型。原生私发确认后才继续群内确认及最多170秒的有界轮询，成功/过期私发通知也须重核原来源；failed/unknown不冒充确认，不自动补发。授权凭据按完整平台/namespace/账号与Agent持久隔离，同一账号和Agent跨群共用，其他账号/Agent不继承。CLI使用`<dataDir>/.agent-bilibili-auth-<实例SHA256前32位>`，拒绝软链、可写父目录及目录替换；目录0700、文件0600，保存后fsync。凭据不放临时媒体run，不随桥关闭删除；退出授权删除该账号/Agent的凭据并取消待处理扫码。Core停止后关闭授权与媒体，再释放Redis租约。

高清提供器逐次从该绑定的可信授权服务读取凭据，以请求QN直接授权提取，报告请求及实际获得的质量；不回退匿名低清，也不借自动搬运Cookie。仅交付完整有序视频，拒绝预览、未知/不完整时长、缺失分段或不完整分段证据；沿用30分钟、最多20P和每段512MiB边界，签名媒体URL、Cookie、轮询key及二维码字节不进入模型、日志或Redis工作流。每个外部阶段先持久登记，pending/unknown重启按未知处理并禁止盲目重发；原生投递与Redis不构成跨系统事务。来源撤回、隐私、白名单撤销、换绑、配置变化、丢租约与停止持续取消后续请求及投递。普通自动搬运仍保持匿名优先QN6和原有显式授权复试行为。

公开入口`bl-chat-agent/bilibili-quality`导出高清提供器、授权服务、配置校验器及中立合同；`bl-chat-agent/qq`导出原请求者授权通知端口。`createAgentBilibiliSearchAttachmentProvider`提供匿名QN16、完整内容、最多两段且每段30MiB的能力，现由可选`videoDownloadTool`接入普通群文字与仿真真人工具；接线、权限及验证见上节。`searchVideoTool`仍只返回相关度列表；显式`videoShareTool`发送一个卡片，不能把它描述为下载视频。

本批高清/auth提供器、持久工作流、QQ原请求者通知和独立主机接线已实现并完成集中工程验证：一次后端构建2346文件（TypeScript5.9.3）、后端及测试严格类型检查与Core边界检查通过。10组257项专项在构建代码和仓库外安装包各通过一次，零失败、取消或跳过；包含4项实际CLI，覆盖扫码原生私发确认后才轮询、群/好友私聊授权、私有凭据持久化、QN80请求实际QN64完整媒体桥交付，以及QR/媒体unknown冻结。官方HTTP内容、缩略图进程和OneBot服务使用明确合成依赖，Redis、CLI进程、WebSocket及制品桥实际运行。363项不同的安全、仿真域、团录、音乐/磁链/媒体与日志定向回归通过；其中1条旧提示词断言仍要求搜索直接发送，已按当前只返回列表的合同修正，重新编译并复验整个75项域测试通过，未因此重构建后端。

候选`.release/agent-nRziY3`仅打包一次。真实npm归档在仓库外独立安装，再在已安装包自身目录按原始shrinkwrap执行离线npm ci：512个依赖版本精确一致，19个可选平台依赖省略，未使用源码或依赖符号链接替代。440个运行/声明文件与当前构建逐字节一致，447个发布文件校验通过；公共严格TypeScript消费者、外部宿主和启动篡改保护通过。初次离线安装遇到缓存缺项，获取缺失缓存后已完成消费端安装；在父目录使用npm --prefix的嵌套安装超时，改在安装包目录执行原锁离线npm ci后16秒完成，锁和发布代码未改。证据：`/tmp/bl-bili-quality-package-proof.json`、`/tmp/bl-bili-quality-{built-suites,installed-suites,public-consumer,regression,domain-recheck,nested-install}.log`。最终发布目录仅同步本段README和发布清单，运行/声明文件保持已验归档一致。

集成修复保留命令原文（含首尾空格）作SHA256和完整来源复核；团录AI静默仍可处理真人高清/授权命令，后续团录状态恢复不取消合法扫码，但撤回、隐私、换绑等仍取消。好友来源每次在同一已认证socket重新确认好友列表，兼容标准get_msg缺少sub_type，显式TEMP/非好友拒绝。资源释放、HTTP流关闭、缩略图/临时文件清理、轮询、模型说明及账本回执失败均有固定阶段和脱敏错误码；失败说明附同源查询编号，模型不可用改用短服务异常提示。原生派发后账本写入失败按未知冻结，不通过错误说明触发额外发送。真实B站扫码/账号权限/媒体可用性及真实QQ私发、显示和播放均待验收，本批没有生产部署、迁移或新增线上发送。

### Core团录录制、控制与文件交付

团录已接入独立Core的durable inbox、录制/控制工作流及独立CLI生命周期。旧DiceManager与新Core生成器共用`renderLogText`、`renderLogHtml`和`resolveLogForExport`：TXT/HTML字节、骰点着色、HTML转义、当前/倒序历史编号/精确团名优先级保留。共享纯函数不导入骰子engine、插件、平台对象或文件系统；旧方法是薄委托，旧裸群号数据与旧上传回退路径不自动迁移。

`bl-chat-agent/group-logs`公开`createAgentGroupLogRenderer`、共享纯函数及`validateAgentGroupLogArtifact`。可信宿主提供已获授权的结构化标题/起止时间和有序行（at/name/userId/content/type），生成器只返回`AgentGroupLogArtifact {name,mime,base64}`。默认8MiB，可显式配置1至100MiB的整数字节上限；输入和转义后的完整UTF8文件均计预算，超限整体失败，不截断为伪完整文件。闭合普通数据、规范Unicode/UTF8、控制字符与已知秘密检查覆盖单字段、跨行拼接及编码回显；固定HTML模板无脚本和外部资源。工厂不决定资料可见性、管理员身份、原消息真实性或留存策略，这些仍由调用方工作流承担。

```ts
import { createAgentGroupLogRenderer } from 'bl-chat-agent/group-logs'
const render = createAgentGroupLogRenderer({ maxBytes: 8 * 1024 * 1024, secrets: hostSecrets })
const log = render({ title: '本次团录', startedAt: '2026-11-16T12:00:00Z' },
  [{ at: '2026-11-16T12:01:00Z', name: '调查员', userId: 'player', content: '完整正文' }], 'html')
```

QQ显式能力为`openQqGroupLogBridge`及`createQqGroupLogDeliveryPort`，由`/qq`导出。`createOneBotConnection`只有获得`groupLog: {bridge,allowsText}`后才提供`actions.sendGroupLog`；未配置时该端口不存在。`SendGroupLogAction`固定当前群、版本化binding及真人原命令的消息ID/作者/平台时间/正文SHA256，不接受模型选定目标、资源路径或任意URL。读取原命令、桥准备后和平台回执后分别`get_msg`重核，账号、原群、作者、时间、正文和原生内容变化均使操作失效。调用方仍须提供新鲜管理员及来源/隐私守卫；此适配器原语不是管理员授权或命令幂等账本。

专用桥保留100MiB单份团录，默认最多4份/400MiB/10分钟。私有目录0700、暂存文件0600后只读0400，随机能力URL仅进原生参数；精确IP访问、每块及完整SHA256、长度/请求/流量限制、取消/TTL/退出清理与现有ZIP共用内部server。两类公开上限、URL命名空间及错误独立：通用文件仍12MiB，请求者ZIP仍50,000,000字节、4份200,000,000字节，不因团录放宽。QQ只执行一次当前群`upload_group_file`，真实`file_id`才uploaded；超时、断线、派发后撤权或缺回执都unknown，不改私聊、不换通道、不补发截断正文。

`groupLog.enabled`默认关闭，启用后为每连接声明独立私网资源桥，可设1至100MiB的`maxBytes`及完整`platform/namespace/id`可信主人名单。`.log on/new/off/end/status/list/export`及`.骰娘 跑团ai 开/关/状态`由确定性工作流处理，不注册为模型工具；修改和导出要求新鲜管理员或宿主显式可信主人证据，不能由模型自报。录制准入在普通群文字/仿真过滤前，持久状态与消息按完整账号/群和Agent隔离；原消息发生时间、ID去重与命令前flush fence保留录制顺序。录制中默认AI静默，显式跑团AI开关控制继续活动，启动时先恢复静默状态再准入模型。

撤回和人物隐私擦除物理移除已存行，source/subject/account epoch阻止迟到append复活；当前与历史导出均重新核验所有来源。命令状态和发送回执分别CAS，先持久pending再上传，重启后的不确定阶段变为unknown并冻结；明确文件回执才确认，不因模型说明、进程重启或换通道重复投递。CLI在取得实例租约后才创建精确owner标记的私有run并监听，退出先停Core再桥/目录最后Redis；`--check`不创建团录目录或监听。

候选`.release/agent-coFd0A`已从真实npm归档在仓库外按原锁独立安装，录制/命令/隐私/恢复等66项及独立CLI/桥生命周期10项共76项通过，无失败、取消或跳过；证据为`/tmp/bl-group-log-coFd0A-installed-runtime.log`和`/tmp/bl-group-log-coFd0A-installed-cli.log`。这些是隔离Redis、本地真实CLI及合成OneBot证据，真实QQ群文件上传/收件仍待验收。旧团录只有裸群号、缺账号及Agent来源，不自动认领；旧骰子结果及规则事件还须独立可验证producer来源，不能伪造真人消息ID或把交付基础当作骰子业务迁移完成。

### Core视频分析

`videoAnalysisTool`保留原工具名和仅含可选`prompt`的参数：按当前消息、引用消息、当前及引用内嵌套转发的顺序选择首个视频，首视频损坏或无权读取时不偷偷改用第二个。分析诉求依次取显式prompt、本条真人请求、默认“请分析这个视频内容”。Core负责分析编排、输入校验与独立提供器，QQ只负责原生消息证据和中立视频读取；模型不能指定URL、来源消息、平台资源ID或接收者。仅在群仿真真人回合装配，继续服从原工具策略。

```yaml
tools:
  videoAnalysis:
    enabled: true
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    name: glm-4.1v-thinking-flash
    apiKeyEnv: VIDEO_ANALYSIS_API_KEY
    inputMode: inline  # 默认；服务须支持受控data:video输入
    # inputMode: bigmodel-upload  # 需要BigModel临时上传时显式选择
    # uploadHosts: [www.bigmodel.cn, open.bigmodel.cn, cdn.bigmodel.cn]
```

默认关闭，无主模型/视觉模型或旧插件配置回退；启用必须显式提供endpoint、模型及环境凭据名。关闭时仍校验声明但不读取凭据。`--check`不下载视频、不调用分析或上传服务；迁移预览允许凭据暂缺。配置快照变化使工具定义及已经读取视频的整个派生回合失效，取消等待中的独立模型和主模型请求；重启采用新配置。

QQ每次从固定在线连接重读当前群原消息，核对账号、群、消息ID、作者和时间；引用必须有真实引用关系，转发的每层作者和时间都接受Core隐私检查。嵌套最多3层、50节点和每次遍历6个请求。资源仅来自重新核验的平台响应，不使用入站自报URL或本地路径。QQ视频CDN可为动态域名，下载按每跳全部DNS公网校验并固定连接地址，最多3次重定向、64MiB和60秒；拒绝压缩、部分响应及长度不符，校验MP4/WebM实际容器头。容器校验不等于完整解码或可播放证明。

中立`AgentVideoInput`只有MIME及规范base64。inline模式仅提交已下载并校验的字节；bigmodel-upload也必须先读取同一字节，再上传至固定`https://www.bigmodel.cn/api/biz/file/uploadTemporaryImage`，随后把经验证的临时URL交给显式模型。上传URL只接受默认三个精确BigModel域名；宿主可用1至8个精确DNS名替换，拒绝通配符、IP、端口和任意URL。允许服务生成的签名查询，但完整URL及非空查询值作为临时秘密拦截回显；宿主秘密、原视频base64/dataURL和字节回显也拒绝。上传响应64KiB、模型响应2MiB、工具总期限240秒，不跟随重定向或自动HTTP重试。

视频、分析及派生回答属于本轮临时资料，不写持久模型历史、人物记忆、群学习、情节、目标、作品或工具正文回执；入站只保留有界数量及可信引用元数据。后续模型调用、兼容重试和回复前重新核验原视频指纹、来源、撤回、隐私、绑定和定义；复核仅查证据，不再下载媒体。真实纯视频消息可保留元数据，无定向请求不借用真人工具权限。正常结果仍为`{analysis}`并由主模型按既有路径回复。

外部宿主可从`bl-chat-agent/video-analysis`导入`createAgentVideoAnalysisTool`及配置/验证函数，主入口导出`AgentVideoInput`、`AgentMessageVideo`和`MessageVideoReadOptions`；自定义适配器实现`readMessageVideo`并遵守Core提供的来源、取消与inspectOnly合同。工程与真实QQ/服务/模型验收范围见文末。

### Core磁链下载、完整清单与请求者ZIP

磁链搬运遵循同一Core边界：外部缓存/下载器结果先变为`AgentTorrentMetadata`及`AgentTorrentArchive`，Core负责选择、队列、完整性、ZIP和投递编排；渠道只转换为原生交付。没有注册模型下载工具，关键词磁力搜索仍是独立的非下载能力。目前只接QQ，其他平台保留接口。

默认关闭，独立宿主可显式配置：

```yaml
torrentDownload:
  enabled: true
  autoDetect: true
  selectionTtlSeconds: 1800
  # 可选，宿主HTTP(S)代理；peer/DHT仍由aria2直接访问
  # proxyUrl: http://127.0.0.1:7890
  bridges:
    - connectionId: main
      listen: { host: 127.0.0.1, port: 8093 }
      advertisedOrigin: http://127.0.0.1:8093
      allowedPeers: [127.0.0.1]
```

每个已配置QQ连接都需一个ZIP桥声明。桥端口与媒体桥分开，origin需被该OneBot端可达；HTTP仅允许显式私网/loopback origin，其他使用HTTPS和精确peer ACL。宿主需安装固定`aria2c`和`zip`。`--check`只验证声明与既有登录状态，不创建磁链目录、不打开ZIP桥或启动下载。运行期使用Redis实例租约及精确owner标记0700目录，停止或崩溃恢复只清理本实例拥有的run。

群内真实BTIH结构直接触发，兄弟账号稳定选一个处理，排除全部配置机器人；没有任意URL/猜测hash下载。缓存→DHT→固定补充tracker的元数据预算独立于模型期限。每个私有作业的空 DHT 路由表通过固定入口 `dht.transmissionbt.com:6881` 引导，peer/DHT 仍直连。原始info span的SHA1匹配BTIH、完整原始元数据SHA256固定选择版本；保留UTF8/GBK安全路径，剥除外层任意tracker/webseed/nodes。单文件/内容/ZIP上限50,000,000字节，一次最多3文件并预留1,000,000字节归档余量。下载对涉及选中内容的原始piece逐片校验，邻接spill只用于完整性核验，ZIP只含所选文件并复核条目、CRC与SHA256。原生aria2的peer/DHT网络是可信宿主能力，不受JS固定缓存公网DNS检查保护，不构成OS网络沙箱。

整包超限时，Core保留最多2048文件/1MB完整中立清单，分批发送全部名称、大小和可选状态。可选卡图渲染失败在投递前回退完整文字；长清单分页，每批单独持久pending和回执，全部真实sent后才发布30分钟待选。仅原人、原群、原账号及原绑定可用结构化序号或唯一文件名选择，随后重新获取元数据并核对完整指纹；无效选择不能变成整包请求。选择消息及最初来源都持续受撤回/隐私守卫。

Core先持久领取再确认消费入站，最多8个活跃任务、全局下载串行，24小时任务期与7天防重终态。群物理来源摘要和撤回墓碑在同namespace配置账号之间共享，不共享聊天或ZIP。每个notice/listing/archive/confirmation/failure都先登记pending，unknown停止所有下游且重启不自动重发。下载完成后只向原来源作者私发ZIP；确认真实file_id后才群内确认。账号断线、换绑、隐私清空/禁用、来源或选择撤回、停止与租约失效都阻止后续准备/交付。撤回的各账本取消独立执行，一个存储失败不能阻断其它业务内存撤销或入站墓碑。

`/torrent`公开可信宿主provider、校验器及类型；Core选项为`torrentDownload/torrentProvider/isTorrentDownloadCurrent`及可选中立清单renderer。`/qq`公开独立ZIP桥与requester交付端口，OneBot通过`requesterArchive:{bridge,allowsText?}`显式注入。群来源动作始终携带原群地址/绑定/作者证据，Core另固定中立正文SHA256跨适配器首读比对，无模型接收者参数、无需新增私聊绑定。QQ适配器捕获原socket和授权，stage/发送/回执三次核验get_msg，使用能力URL传输完整ZIP以避开50MB base64超出50MiB WebSocket限制。原生仅传`user_id/file/name`，不添加平台不支持的group_id或发额外消息建立TEMP；是否可私发依赖平台当前关系/临时上下文，不能保证任意群成员。file_id只表示上传确认，客户端收件另验。

### 接续现有 QQ 插件的会话状态

独立包的启动入口也提供按会话迁移。将 `BL_AGENT_REDIS_URL` 指向现有插件使用的同一个 Redis 数据库，独立宿主从该数据库下的 `bl-agent:<instance>:` 分区读取。来源与目标配置须显式绑定同一个 QQ 账号、会话、连接 ID、角色和人设。目标仍使用 `agent-host.yaml` 旁的角色绑定文件。

停止会处理所选会话及提醒和承诺账本的源 QQ 插件进程、控制台写入及目标宿主后，先预览。预览读取配置、Redis 和本地用量账本。

```sh
node scripts/start-agent.mjs --config /path/to/agent-host.yaml \
  --migrate-qq-state --source-bindings /path/to/plugin/config/agent-bindings.yaml \
  --connection qq-main --group 111111
```

好友私聊用 `--friend 222222` 接续一次性提醒和本会话中好友自述的结构化事实。目标配置须启用 `privateChat`。预览以 JSON 输出委托记忆、承诺、提醒、人物事实 `personFacts`、迁入的群笔记 `groupNotes` 和留在源分区的笔记 `retainedGroupNotes` 的数量。核对后给同一条命令加 `--apply`。执行时一次提交目标分区写入、需迁出的源记录移除及两端索引更新。目标已有相同任务编号、迁移遇到目标数据冲突，或读取后账本发生变更，都会中止提交。

群迁移覆盖已分区的委托记忆、有效且未领取的固定文字承诺，以及旧 `reminderTool` 中仍有待发索引、带匹配归属的纯文字一次性提醒。一次性提醒沿用原编号、创建人、正文、排期及已消耗的重试次数，群里点名创建人，好友提醒发到原私聊。旧消息引用只留在原流程，迁入后直接发送提醒正文。同一会话的角色变更会停止旧提醒。

对使用仿真模式的群，可以在预览和应用时都加 `--include-agent-commitments`。先确认独立宿主具备原任务需要的工具，例如仅用仿真发送工具就能完成的定时消息。迁移按交接后的实际群开关判断，同时考虑宿主的启用清单、目标群覆盖和接续的源群控制。迁入后仿真仍停用时，这类任务留在源账本，计入 `skipped.unsupported`。符合条件的 `agentCommitments` 计入 `commitments`，继续使用原创建人、归属和排期，到期可通过已验证账号和当前绑定建立仿真会话，无需等群友再发一条消息。账号断线或仿真临时关闭时，已迁入且尚未开始的任务保留原定时间，恢复后继续检查。已开始且执行结果未知的任务会保留待核实记录。

对使用仿真模式的群，预览和应用都可加 `--include-character-state` 接续同一角色的自身记忆、自主目标、作品、作息、反思排期和可核验的管理员初始提示词。`characterState` 报告接续的记忆、目标、回执和暂停目标数量，以及留在源端的记忆和目标数量。目标沿用原排期、期限和尝试次数。外部动作结果未知时，接续的目标保留待核对状态。源端同一目标的调度在提交时停止，源端原记录仍可查。已存在内容的目标角色状态会阻止本次写入。首次交接时，目标宿主会登记可继续检查目标的群，启动后按原群的参与、暂停和预算规则检查到期目标。

能接续的角色记忆和目标必须有完整的可接续依据。依赖原群消息序号、共享偏好或宿主工具文字的记录留在源端。有效修订可以连同必要的引用关系接续，已被替换的旧正文留在源端。仅记录仿真检查和发送结果的回执保留状态和时间，摘要改为对应结果的固定说明。该选项可与 `--include-agent-commitments` 一起使用。

作品按版本核对依据，只有仍能引用目标端可见的有效角色记忆或行动回执的版本可以接续。已撤销、原群消息、共享偏好或外部工作器依据均留在源端。复制保留作品 ID、时间、原版本号和归档状态。版本历史有缺口时使用固定标题，以免复制来源不明的原题名。`characterWorkspace` 只给出接续与留存的作品数及版本数。目标已有作品，或源作品在提交前发生变化，都会阻止覆盖，源端作品保留。

`characterSchedule` 报告已接续的角色作息和反思排期、下次反思时间及 UTC 当日反思次数。作息按原账号、角色和群读取。反思保留已处理依据的标识，旧反思结果正文留在原端。目标已存在对应作息或反思排期时停止写入。交接后的会话由目标宿主运行，原宿主保留这部分数据。

`initialPrompt` 只报告是否已复制或保留模板，以及是否将在首次合格的入站回合使用。仅当源会话可证明从未启动时，迁移会安排首次入站模型调用使用提示词。已经运行的会话会复制模板，可通过独立 Core 的 `runtime.resetGroup` 管理接口重置同一角色的会话，再启用一次。提示词仅加入那次主模型请求，尝试发送请求后不会自动重放。绑定版本变化会使待用提示词失效。

同一账号、角色和群已有的结构化人物事实可在独立宿主的仿真和群文字模式继续使用。仿真模式还接续群笔记。`personFacts` 同时计入与笔记匹配的人物事实和普通聊天单独提取的事实。来源撤回、遗忘和停用约束随数据提交。本群事实保留本群范围，原本可移植的本人档案仍可用于同角色的其他群。已删除、已撤回、已过期或缺少可核验来源的人物笔记留在源分区。待跟进笔记保留到期时间，旧会话序号会清除，随后只在自然聊到时接续。独立宿主收到撤回通知后即可让迁入来源失效。

群会话可另加 `--include-group-teaching`，目标须已设置 `groupMemory.enabled: true`。迁移从 `--source-data-dir` 下的 `message_archive/group/<群号>/*.ndjson` 核验旧裸群号的知识、教学别名和工作流；省略该目录参数时沿用源插件的 `data`。只接纳账号和接收角色、原消息 ID、作者、时间及完整顶层正文均可核验的记录。知识和工作流的旧摘句须匹配原文，工作流还须有原作者当时为群管理或群主的归档证据；群文件只接续同条原消息的已核验顶层附件。引用、转发、截断、冲突、撤回和缺失来源留在原端，原记录的创建时间不会被当成更新后来源消息的时间。

迁移与当前 QQ 入站共用消息解码及来源格式，保留正文空格、提及和稳定文件引用。同一消息 ID 即使只有一份副本合格，另有账号、接收角色或完整性矛盾时也全部留存。机器人输出不能作为真人教学；损坏撤回通知会中止整批。工作流最多接续 20 个目标。部分旧归档写入器未保存附件名，只有 `fid` 的附件也不构成当前平台引用；这类群文件留在源端，不从正文猜测附件证据。

这三类旧分区由多个账号共享，迁移只复制合格条目，保留原键。`groupTeaching` 报告新导入、留存、已导入及各类跳过数量，不输出教学正文。预览不写入；应用将目标群资料、人物隐私和来源登记、持久交接标记放进同一次 Redis 比较提交。旧退出设置按本群继承一次，已停用的源群教学全部留存。导入后的来源删除、清空截止时间和交接标记共同阻止重跑复活；目标同编号内容冲突时中止整批。

归档接收身份不等于教学的提交人格版本。迁入条目使用明确的 `legacy-qq-observation` 来源分支，保留已核验接收身份和旧记录指纹，不生成虚假的 `personaVersion`；模型和资料列表明确标注“旧群教学，提交人格版本未记录”。资料继续受来源账号、群、人物隐私和撤回约束。旧工作流仅作为资料，执行通知仍须当前真人明确请求及新鲜成员核验。

此选项要求源归档写入、源插件、控制台和目标宿主均已停止，或使用不可变的离线导出。扫描最多 1000 个日期命名文件、总计 64 MiB，超限或损坏时拒绝提交。提交前重新核对文件集与内容，但文件系统和 Redis 不是跨系统原子事务，不能用这次复核替代停止源写入。自定义归档目录可离线导出为上述布局。原摘要和情节资料仍不自动迁入。

群迁移从来源绑定文件旁读取 `message.yaml` 的 `pluginSettings.simulation`。令牌账本默认读取该配置目录上一层的 `data/token_usage`。可分别用 `--source-config /path/to/message.yaml` 和 `--source-data-dir /path/to/data` 指定实际路径。省略参数且文件缺失时，配置采用仿真默认值，当日金额从零起算。

报告包含 `simulationControls` 时，目标会按完整账号及会话地址接续群仿真开关、仅被 @ 回复、有效活跃期限、角色自主行动暂停和两端较严格的每日金额及回合上限。回合和金额用量以迁移当天的北京时间计，独立宿主在两种群聊模式中把这部分用量计入各自预算。最近一小时的收发限频只接续同一绑定版本的源会话。源配置、会话状态和令牌明细保留。重复迁移会使用目标的当前仿真控制判断剩余任务，跳过已交接的控制和用量。首次交接时，源仿真群已停用会使目标仿真保持停用，显式配置的群文字模式及固定文字提醒各自按其既有开关运行。独立宿主可用 `simulation.allGroups: false` 进一步将仿真限制在显式启用的已绑定群。

源会话的绑定版本与迁移时一致且目标使用群仿真时，`wakeConfigTransferred` 表示已接续唤醒规则，`nextWakeAt` 给出活跃期结束的唤醒时间（Unix 毫秒）。已有目标会话会阻止覆盖。提交时登记目标群的调度并移除源会话中的对应定时器。目标宿主在账号在线、会话配置允许时检查到期时间，已到期的定时器无需新消息。检查沿用群预算和角色权限，前一轮已读水位与依赖旧消息的回音检查留在源会话。

群文字模式可通过 `delegateMemoryTool` 查询迁入的委托记忆，通过 `commitmentTool` 查看和取消迁入提醒。好友本人可以在私聊查看和取消当前角色下迁入的提醒。等待核实或已离开索引的任务、带附加工具的提醒、未选中迁移的仿真承诺、消息触发的仿真唤醒、聊天历史和无原消息来源的旧画像留在原插件存储。`skipped` 报告已索引任务的缺少归属、绑定不符、可能已执行、能力不匹配以及账本异常或任务过期等情况。

### 启用群文字回复

在 `agent-host.yaml` 声明已有绑定的群及接收账号，然后重启独立进程。同一个群可以在不同账号上使用各自配置。`simulation.enabled` 继续作为独立宿主的消息处理总开关。

```yaml
textGroups:
  - connectionId: qq-main
    conversationId: '111111'
```

配置中的群在被 `@` 或收到对当前账号已确认回复的引用时，生成一条引用当前消息的文字回复。模型收到当前文字、角色人设、同一群友的近期已确认收发，以及最多四条适用于当前群的结构化人物事实。每个会话保留最多 6 轮，最后一次确认后 1 小时过期。命令、附件正文和群友引用的原文不进入该文字回合。回复检查当前绑定、引用来源、文本规则及投递回执。换绑或保存宿主配置后，旧的文字收件和上下文停止使用。

群文字模式期间暂停本群仿真唤醒，仿真状态继续保存在原会话分区。原有定时文字承诺可继续按原归属投递，依赖仿真唤醒的承诺须由仿真模式执行。群消息撤回同时清除该群文字上下文，并使仍在生成的旧回复失效。文字回合使用与仿真相同的 YAML 预算配置和 Redis 群级覆盖，对同群文字模型调用施加 `simulation.turn.minSendGapMs` 间隔。迁移后的文字回合次数单独记账，模型金额与同一会话的仿真共用账本。要停用当前会话的模型处理，可移除该会话的角色绑定。

群文字工具按会话配置。省略 `tools` 时该群只提供文字回复。以下配置启用固定文字提醒和委托记忆。

```yaml
textGroups:
  - connectionId: qq-main
    conversationId: '111111'
    tools: [commitmentTool, delegateMemoryTool]
```

`commitmentTool` 支持一次性或每天的固定文字提醒，以及查看、取消和续期本人登记的提醒。调度使用北京时间，到点在原群点名创建人。`delegateMemoryTool` 保存本条消息里的原话并支持本人查询、删除。两项工具均复用独立宿主的既有账本，按原账号、会话及角色定位记录。每回合最多执行一项工具，账号、群和发言者由入站事件确定。

工具确认由本地执行结果生成并直接回复群里。工具正文不加入后续模型上下文。写入前先持久化尝试标记。进程在执行后、发送前退出时，可在原绑定下恢复已落盘的确认，只有尝试标记时会提示结果待核实。恢复期间不会再次执行该工具。撤回或换绑使未发送的旧回复失效。已经提交的托付和记忆由原账本管理，用户可通过相应工具取消或删除。

### 启用好友私聊

在 `agent-host.yaml` 增加以下设置，然后重启独立进程。私聊默认关闭。示例中的 `qq-secondary` 也需要在独立宿主的 `connections` 中配置对应的 OneBot 连接，或者将私聊绑定指向独立宿主已经配置的账号。

```yaml
privateChat:
  enabled: true
```

好友准入由 `agent-bindings.yaml` 中 `kind: private` 的会话声明。处理 OneBot 上报的好友文字。临时会话不参与，`#` 命令仅接收下述本人记忆操作。附件及引用原文不随私聊文字入队。模型请求使用当前角色人设、好友文字、同一会话的近期对话和最多四条本好友在本会话自述的结构化事实。回复通过 OneBot `send_private_msg` 发给原好友。 [OneBot v11 私聊事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md#私聊消息) [OneBot v11 私聊发送](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#send_private_msg-发送私聊消息)

近期对话按完整会话地址、角色绑定版本、人设版本及人物记忆失效水位核对，每段最多保留 6 轮已确认收发，最后一次确认后 1 小时过期。好友撤回会清空该会话的近期上下文，让匹配的结构化事实及尚未发送的旧回复失效。直接召回结果只进入本轮模型请求。私聊收件按接收账号排队，换绑使已排队的旧消息和未发送的旧回复失效。重启后可处理仍在有效期内且尚未尝试发送的收件。已有投递尝试的收件按去重记录跳过重发。迁入的一次性提醒支持到期投递和本人查看、取消，工具结果直接返回当前好友会话。 [OneBot v11 好友消息撤回](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md#好友消息撤回)

### 本人记忆管理

显式绑定的仿真群、文字群和已启用的好友私聊接受 `#清空我的记忆`、`#禁用我的记忆` 和 `#启用我的记忆`。发送不带点名、引用或附件的完整命令，首次入队要求平台发送时间在一小时以内。群内调整本人在当前群的记忆，好友私聊调整当前接收账号和角色下本人在所有场景的记忆。重新启用从新资料开始，已失效的来源继续不可用。局部启用继续遵守私聊设置的全场景限制。命令在本地执行并回复原会话，命令文字和固定确认不进入模型上下文。同账号的新模型回合等隐私操作处理完成后读取记忆，正在处理的相关角色回合停止后续调用及投递。独立宿主管理的是本实例已接续及之后产生的人物记忆。

## 核心与平台接入

`src/core/agentRuntime.ts` 是独立核心的装配入口。它接收存储、模型及平台连接端口，负责绑定校验、收件、回复和定时承诺。现有 QQ 插件与独立核心共用角色解析、仿真、记忆和承诺模块。`npm run test:boundaries` 检查核心及其内部依赖，阻止对平台适配器、启动层和 Yunzai 宿主的反向依赖。

当前实现 QQ。启动层读取 QQ 配置并创建 OneBot 连接。平台连接通过 `PlatformConnectionAdapter` 提交标准消息、撤回和面向账号的互动事件，通过 `MessageActionPort` 发送。适配器可选实现 `readMessage` 读取明确引用的原消息、`readForward` 展开已核验的转发、`readMessageImages` 读取已核验的消息附图。核心按账号、会话和绑定版本校验。QQ ID、连接协议、消息段转换和图片下载归 QQ 适配器处理。

仿真只向模型声明当前宿主已经实现且当前会话可用的工具。视频卡片按实际提供器与投递端口声明；戳一戳按互动开关、当前连接能力及原有每小时配额声明。空间互动、表情收藏和生活线等未接入能力不会因账号属于 QQ 而自动出现。群成员、转发、附图及情绪更新按实际读取和更新端口提供，角色记忆、收尾与已接通的作息状态继续可用。Yunzai 注入对应实现后保留这些能力，实际执行仍复核原有绑定和权限。

独立宿主装配承诺与委托记忆业务工具，在平台提供成员端口时接通成员资料及精确点名，并可显式放通管理员集合通知，或启用搜索、网页读取、图片生成与编辑、文字图片/思维导图、MCP、GitHub 公开仓库查询、Modrinth 双语查询与合并卡片、人物事实学习、群聊摘要与情节记忆、同群语义及私聊本人跨群召回、群内说法及显式教学。群文字和仿真真人唤醒可显式授权群资料管理与工作流通知；仿真自主回合不获得该管理面。仿真时间视图和角色反思已接通，具有完整归档证据的旧知识与工作流可显式离线接续。其余普通工具，以及缺乏来源的旧资料、摘要、语义索引与情节的迁移或重建仍属后续范围，语义质量、图片、时间语义与反思的完整真实模型验收也尚未完成。现有控制台仍依赖 Yunzai，独立包不含控制台服务。独立聊天闭环或发布包测试通过不表示已有 QQ 功能已经全部迁完。

私聊适配器可以通过 `resolvePrivatePeer` 提供当前会话经过核验的对话者 ID。这个 ID 可与会话 ID 独立，两者共同决定私聊可用的历史和人物记忆。QQ 的好友会话 ID 就是对方 QQ 号，沿用现有键和提醒记录格式。

Core 校验入站消息的账号、发言者命名空间和绑定，附带引文只保留待核对的消息 ID。发送封装携带当前会话的绑定，适配器须在实际投递前调用 `isCurrent`。会话撤回会撤销尚在等待投递的回复许可。有效平台消息 ID 才能确认送达，连接确认前发生异常或收到不完整回执时使用未知结果。频道和话题可由适配器提供自己的成员 ID，QQ 群的点名参数继续校验 QQ 号。

安装独立包后，宿主代码可从 `bl-chat-agent` 导入 `createAgentRuntime`、`createAgentBindingDirectory` 和平台端口的 TypeScript 声明，从 `bl-chat-agent/qq` 导入 `createOneBotConnection`。Core 由宿主注入存储和模型接口，QQ 适配器接收账号、连接地址和鉴权配置。

自定义模型端口的签名为 `YTapi(request, config, signal?, isCurrent?, ensureCurrent?)`。宿主必须在每一次实际提供方请求前等待 `ensureCurrent?.()`，包括参数兼容重试、工具规划器或文字渠道的降级；随后再次检查取消信号和同步 `isCurrent?.()`。异步复核拒绝后停止整个调用，不继续尝试其他后端。此复核会重新检查持久来源、隐私和当前平台访问权限；只在最初调用时检查不足以授权重试。`reviewCharacter`、`reflectCharacter` 和 `judgeSocialPermission` 同样接收第五个异步复核参数。独立 QQ 宿主和旧插件仿真已接通这些检查。

`createAgentRuntime` 接受可选的 `toolRegistry`，类型 `AgentToolRegistry` 从 `bl-chat-agent` 导出。工具接收当前绑定、执行主体、取消信号和复核方法，不接收原生 QQ 事件。实现须在每次外部请求或副作用前检查 `isCurrent()` 并等待 `ensureCurrent?.()`，同时遵守取消信号；Core 始终提供异步复核，完成后上下文立即失效。宿主可从 `bl-chat-agent/web` 导入 `createAgentWebTools`，按搜索和网页配置构建内置工具注册表；内置工具沿用普通工具策略，自定义注册项仍须显式放通且只允许真实用户触发。此注册表接入群仿真，不扩大私聊及群文字模式的能力。

`bl-chat-agent/images` 导出 `createAgentImageTools`、`AgentImageBackend` 和 `AgentImageToolsOptions`。可将其 `builtIn` 与其他工具注册表合并注入 Core。`AgentToolContext.readImages(sourceSeq)` 只读取当前回合可见的已核验附图，`sendImage({mime, base64})` 只向绑定会话提交受配额和回执约束的图片；两者为可选端口，工具完成后不能继续调用。`AgentTool.timeoutMs` 可声明 1–240000 毫秒，缺省仍为 45000 毫秒。

`bl-chat-agent/rendering` 导出 `createAgentRenderingTools`、`AgentRenderingConfig`、`AgentRenderingToolsOptions`、`AgentRenderingContext` 及两个输入类型；`/text-images` 与 `/mindmaps` 分别导出 `createAgentTextImageRenderer` 和 `createAgentMindMapRenderer`。工具通过宿主注入的 `renderTextImage`/`renderMindMap` 获取 `{mime,base64}`，渲染器只接收文字、固定布局参数和当前性检查，不接收平台事件、目标地址、任意路径或模型凭据。自定义宿主须提供 `allowsText` 执行其出站文字规则，`secrets` 提供已知宿主凭据，并将 `builtIn` 合并注入 Core；自定义渲染实现必须在截图/栅格化前调用传入的 `context.assertText(visibleText)`，检查实际解析后的文字，不能仅查Markdown原文。渲染器本身不负责发送。独立QQ启动层已装配这些端口和检查。

`bl-chat-agent/mcp` 导出 `openAgentMcpTools`、`AgentMcpServerConfig`、`AgentMcpToolsOptions` 和 `AgentMcpTools`。打开后将 `handle.registry` 注入 Core，结束时等待 `handle.close()`。混合其他注册表时，用 `get custom() { return handle.registry.custom ?? [] }` 保留动态工具列表，不把初次数组展开为永久快照。可传入宿主 `signal`、`isCurrent` 和已知 `secrets`；公共 API 中的 `headers`/`env` 是宿主已解析的值，不接受模型改写。

`bl-chat-agent/repositories` 导出 `createAgentRepositoryTools`、`AgentGithubOptions` 与 `AgentRepositoryToolsOptions`。传入 `{ github: { enabled: true, token? }, secrets? }` 创建工具注册表；`token` 是宿主已解析的值。将 `builtIn` 合并注入 Core，省略 `github` 时无工具。自定义宿主的测试传输可注入 `fetchImpl`，须遵守取消与固定 API 请求契约，不从模型读取端点或凭据。

`bl-chat-agent/modrinth` 导出 `createAgentModrinthTools`、`AgentModrinthOptions` 与 `AgentModrinthToolsOptions`；将其 `builtIn` 合并注入 Core。`renderCard` 可注入中立渲染端口；`bl-chat-agent/modrinth-cards` 导出 `createAgentModrinthCardRenderer` 与 `buildAgentModrinthCardHtml`，独立宿主默认装配其离线渲染。`MessageActionPort.sendBundle`、`SendMessageBundleAction`、`MessageBundleItem` 和 `MessageBundlePart` 从主入口导出；工具的可选 `sendBundle(items)` 固定当前目标，完成后权限失效。

`MessageImageReadOptions` 可携带 `signal`，平台适配器应将它传至消息查询和图片下载。独立 QQ 入口将工具或视觉回合的取消贯穿 `get_msg`、来源授权等待、DNS 及 HTTPS 响应体；Base64 和 URL 附图均不会因授权挂起而阻塞取消。OneBot 同时每 25 毫秒复核调用方当前性，连接变化或绑定失效会中止下载。五秒读取总期限继续保留，完成时清理监听和轮询；中止后不再读取下一张或使用迟到结果。原生 DNS 和已经开始的底层权限查询不承诺撤销，但迟到结果不能继续下载。

宿主可从 `bl-chat-agent/memory` 导入 `createAgentPersonExtractor`，传入 `{ baseUrl, name, apiKey, secrets }` 创建 `personProfileExtract` 端口并注入 Core。`secrets` 可提供其他已知宿主凭据，阻止其进入提取输入和返回内容。Core 为调用提供真实目标、绑定、取消信号、异步权限复核及用量记录方法；提取器不决定事实的存储身份或来源。宿主自行实现该端口时，也须遵守这些取消和复核要求。

同一 `/memory` 入口还导出 `createAgentConversationSummary`，接受同样的后端与秘密过滤配置，构建 `summarizeConversation` 端口。`ConversationSummaryModel`、`ConversationSummaryInput`、`MidtermMemoryConfig` 和 `EpisodicMemoryConfig` 从主入口导出，外部宿主可配置或替换摘要实现，并须遵守 Core 提供的取消、异步复核及用量记录协议。

`createAgentGroupMemoryModel` 从 `/memory` 导出，构建 `groupMemoryModel` 端口；`GroupMemoryConfig`、`GroupMemoryModel`、`GroupMemoryModelInput` 和 `GroupMemoryProposal` 从主入口导出。平台适配器可实现 `listConversationMembers` 与 `readConversationMember`，返回限定完整目标会话和观测时间的成员快照；缺少可核验成员端口时不接纳教学身份或权限。

同一成员端口也接入独立群仿真的 `memberInfoTool`、`mentionMembersTool` 和显式放通的 `mentionAdminsTool`，沿用原工具策略且仅真人回合执行。成员查询根据本条真实 @、明确本人、核验引用或唯一姓名定位；完整昵称和名片并列匹配，重名或长短姓名冲突须澄清。`ConversationMemberProfile` 从主入口导出，可选字段使用毫秒时间，缺失资料不补默认；列表只保留昵称和名片，单人查询才返回平台提供的其他白名单资料。`simGetGroupMembers` 通过中立端口返回最多40名成员，仍先列近期活跃者。

通知在原群逐个真实 @，最多20人，一条消息算一次配额。管理员集合默认排除机器人与群主；仅本条原话明确要求且模型设置 `includeOwner` 时包含群主，排除对象不唯一则不发送。工具的 `request` 是宿主固定的本条消息、正文、点名与核验引用作者；普通工具不借用旧请求或截断原话。自定义工具可通过可选 `readMember(userId)`、`listMembers()` 与 `sendMessage({text, mentionUserIds})` 使用同一群边界，仍须自己遵守工具权限和请求范围。发送端口复用原队列、净化、去重、配额、取消和未知回执冻结，结束后端口失效；`AgentToolMessage` 和 `AgentToolRequest` 从主入口导出。移除成员端口或在 `simulation.toolPolicy.denyTools` 禁用工具可关闭该能力。

`bl-chat-agent/redis` 导出 `openAgentRedis`，返回可直接注入 Core 的 `storage`、执行租约检查 `isCurrent` 和退出时调用的 `close`。发布包的 `npm-shrinkwrap.json` 随 `npm pack` 保留，可将打包文件安装到其他项目；也可以继续复制发布目录后使用 `npm ci`。

CI 在独立包安装后运行 `tests/agentPackageConsumer.test.js`：重新生成 npm 打包文件，在仓库外的临时项目按发布锁离线安装，严格编译只使用公共导出的 TypeScript 宿主，以测试 Redis 和合成平台消息完成一次确认投递，并检查篡改产物会阻止 CLI 启动。这是包安装和接口集成验证，真实 QQ 与模型联调仍须另行验收。

## 验证范围与继续点

2026-11-15 的工作区构建生成 `.release/agent-IbFPhv`，后端构建、TypeScript 检查、Core 依赖边界和差异空白检查通过。迁移策略、群记忆存储与管理、Core 接入和独立宿主的定向测试共 61 项通过；发布包在仓库外安装后的公共 API、类型声明、启动一致性及群记忆配置与运行测试共 11 项通过，均无跳过。发布包包含当时工作区的未提交实现，其内容以发布清单记录的文件哈希为准。

同日使用已安装 npm 包及仅导入 `bl-chat-agent`、`/qq`、`/redis` 的独立宿主，完成真实 QQ 的提醒迁移和重启恢复验收。来源是一条明确标注的合成操作员提醒，存于临时 Unix socket Redis；预览没有写入，应用保持原编号、排期和已用重试次数，重复应用没有新增记录。到期前停止进程、到期后重启，由 QQ `3094088525` 向已指定好友 `925640859` 确认投递一次，消息 ID 为 `657540026`，并通过平台 `get_msg` 读回正文。第二次重启后未重复投递。此项模型请求数为零。

验收使用独立临时 Redis，生产服务与数据未迁移。临时 NapCat 反向连接已移除，配置恢复后与验收前 SHA256 相同，隔离 Redis 已停止。前序真实模型私聊收发证据单独保留；本次迁移恢复结果不扩展为群学习、群仿真或反思的真实模型验收。`migration:report` 当前源代码边界违规为零，仍报告既有 `functions/functions_tools/WaitTool.js` 缺少迁移基线登记。

随后修复情节使用未标时区 UTC 日期的错误，并生成 `.release/agent-wq2VIQ`。群文字和好友私聊跨午夜测试先在旧产物复现，再在 UTC 与洛杉矶两个进程时区下各通过 2 项；完整 Core 叙事记忆回归 17 项、存储与摘要提供方回归 30 项通过。新包在仓库外安装并编译公共 API 宿主，以及发布目录启动后的摘要、情节恢复和预检共 4 项通过，均无跳过；后端构建、类型检查、Core 边界与差异空白检查通过。这批运行使用隔离 Redis、合成平台和模型服务，未再次发送线上消息，时间修复尚未部署。

本轮补齐显式旧群教学迁移，以及无提取后端时读取和管理已有资料的路径。专项 19 项通过，覆盖 CLI 预览/应用/幂等、隐私与墓碑、原生 QQ 解码后的同来源重入，以及安全审查所发现问题的修复；群资料存储、管理、Core 与迁移策略回归 67 项通过，均无跳过。后端构建、类型检查和 Core 边界通过。发布包在仓库外按锁离线安装后，公共 TypeScript API 宿主的确认投递及实际 CLI 教学迁移的预览/应用/幂等两项验收通过，无跳过。上述测试使用隔离 Redis 和合成平台/模型，真实归档写入器的缺失附件名用例验证留源；没有执行生产教学迁移，也未新增线上发送，测试不替代群教学或通知的真实 QQ 与模型验收。

随后接入独立图片生成与编辑，以及平台无关的可见附图读取和图片交付端口。提供方与配置 37 项、公共图片/网页及工具基类回归 51 项、图片交付与 Core 注册表 13 项、完整仿真运行时 72 项通过，均无跳过。3 项实际 CLI 集成使用隔离 Redis、模拟 OneBot 与 HTTP 图片服务，验证确认送图、未知回执不重发，以及未配置视觉服务时按 `sourceSeq` 读原图并编辑送达；搜索/网页合并装配另有 3 项回归通过。CLI 同时暴露并修复工具基类将整数 schema 当作 JavaScript 类型名的问题，安全整数与范围检查已有定向验证。后端构建、类型检查、Core 边界和差异空白检查通过。发布包在仓库外按锁离线安装后，上述 3 项图片 CLI 流程及公共 TypeScript API 宿主验收共 4 项通过，无跳过，包含 `/images` 公共导出与类型声明；本轮尚无真实图片模型或线上 QQ 图片发送证据。

图片取消后续验证：查询、DNS、来源授权及响应体取消专项与工具/Core 接入共 22 项通过，覆盖 Base64/URL 授权挂起的取消和迟到放行不再下载；授权挂起问题先在旧构建复现失败，再在修复构建通过。QQ 下载/视觉集成与正反向内联图片另选 4 项通过，两个文件内其余 8 项未运行。完整仿真运行时 72 项和图片 CLI 3 项回归通过，均无跳过；后端构建、类型检查、Core 边界和差异空白检查通过。仓库外安装检查使用同一 8 项 OneBot 取消专项、上述 3 项图片 CLI，以及公共 TypeScript API 宿主和篡改启动保护。所有这些图片检查使用合成平台、隔离存储或本地 HTTP/HTTPS 模拟，不替代真实图片服务及线上 QQ 图片验收；本轮未新增线上发送或部署。

随后接通独立 MCP：配置与凭据解析 21 项、真实本地 stdio/HTTP/SSE 及动态注册表专项 14 项、原工具/Core/图片交付与基类回归 32 项、实际 MCP/搜索网页/图片 CLI 流程 6 项通过，均无跳过。覆盖显式真人授权、原始 schema、凭据/环境隔离、列表变化撤销旧定义、初始化失败后等待子进程退出、SSE 断流禁止隐式重连、调用取消与未知结果不重试。实际 wrapper 联调先复现了旧基类误拒合法整数数组，再由同一用例验证修复。后端构建、类型检查、Core 边界和差异空白检查通过；仓库外检查包括已安装包的 MCP CLI 及 `/mcp` 公共 TypeScript 宿主。此处的 MCP 服务、OneBot 和模型均为本地合成验收服务，不代表真实第三方 MCP 或线上 QQ 联调；本轮没有部署及新增线上发送。

随后接通独立同会话语义召回：来源库/并发隐私/后端与配置专项 49 项、实际 Core 与仿真接线 4 项、实际 CLI 重启召回与关闭/检查 2 项通过，均无跳过；记忆与隐私回归 86 项通过，最后运行时检查调整后重跑其中相关 45 项仍通过。后端构建、类型检查、Core 边界和差异空白检查通过。测试分别复现并验证了持久来源删除后旧投影仍有效、文字收件丢失顶层文字段，以及非 durable 仿真调用前遗漏投影复核三个问题的修复。逐次持久化检查确认召回正文及派生回复不写入文字/仿真历史、情节或自动群说法。仓库外从真实 npm 归档按锁离线安装后，重启召回与关闭/检查 CLI 2 项，以及 `/semantic` 公共 TypeScript API、独立宿主确认投递和篡改启动保护 1 项通过。这批证据使用隔离 Redis、合成 OneBot、embedding、rerank 和主模型，不证明真实模型召回质量；本轮未部署、执行生产迁移或新增线上 QQ 发送。

随后接通私聊对话者在同账号、同 Agent 当前可访问群中的本人原文召回。可信私聊查询、原作者、当前群绑定、机器人自身成员资格及持久隐私规则共同决定可用来源；其他作者在关键词、向量和重排前即排除，不读取其他好友私聊。同号消息按完整来源区分，投影每次使用重新授权，相关群换绑会取消在途读取。模型参数兼容重试的验收先复现了撤权后仍第二次外发旧群原文的问题，再由同一用例验证修复：实际 HTTP 从两次降为一次，且没有发送私聊回复。一致性审核、社交许可与后台反思也传递同样的逐请求异步复核，拒绝后不借渠道降级继续外发。

本阶段记忆/隐私/模型与完整仿真回归 181 项、会话记忆/收件/QQ 成员端口回归 32 项、实际模型派发/四个旧宿主 wrapper/Core 语义接线专项 17 项、模型传输 5 项，以及私聊语义/隔离一致性审核实际 CLI 5 项通过，均无跳过。情节测试的完成条件由观察中间历史改为等待实际回合结束，修复后台落盘尚未结束时读取结果的竞态，完整会话记忆回归随后通过。后端构建、类型检查、Core 边界及差异空白检查通过。发布包在仓库外从真实 npm 归档按锁离线安装后，同群和私聊语义 CLI 5 项，以及仅用公共导出的严格 TypeScript 宿主、确认投递及篡改启动保护 1 项通过。上述证据使用隔离 Redis 和本地合成 OneBot、embedding、rerank、主模型与审核服务；不证明真实模型召回质量，本阶段没有部署、生产迁移或新增线上 QQ 发送。

随后接通独立 GitHub 公开仓库查询：固定只读 API、显式匿名/环境变量鉴权、逐请求来源复核与取消、公开身份核对，以及部分失败和样本范围标注。19 项工具边界测试、44 项工具/配置/旧 GitHub/仿真能力回归、4 项实际 CLI 测试均通过，无跳过。首轮专项先复现了字面 Unicode 转义隐藏凭据，以及取消后迟到 Response 未清理的四项失败；修复解析后全量字符串检查和迟到响应取消后，原测试全部通过。后端构建、类型检查、Core 边界及差异空白检查通过。仓库外从真实 npm 归档按锁离线安装后，GitHub CLI 四项，以及 `/repositories` 公共 TypeScript API、四端点调用、独立宿主确认投递和篡改启动保护一项通过。CLI 使用隔离 Redis、合成 OneBot、模型和 GitHub 数据，不代表线上 QQ 或真实 GitHub 成功查询。真实匿名 API 尝试返回 403 且 `x-ratelimit-remaining: 0`，当前出口额度耗尽；未借其他凭据绕过，真实服务成功场景仍待验收。本阶段无部署、生产迁移或新增线上发送。

随后接通独立 Modrinth 公开查询、独立简短翻译、离线 HTML 卡片与中立合并发送端口，保留逐项英文、中文、元数据和项目链接；无 Chromium 时在发送前整批退为双语文字。98 项工具、渲染、QQ bundle、Core 配额/取消/图文净化和旧 Modrinth 回归通过，含本机 Chrome 真实 PNG 与目视检查；6 项实际 CLI 验证通过，均无跳过。专项先复现同节点分片绕过短语/参数过滤、合并检测误伤合法 4000 字分段、真实微秒时区日期误拒，再由同用例验证修复。后端构建、类型、架构边界与差异空白检查通过。仓库外真实 npm 归档按锁离线安装后，6 项 CLI 及公共 TypeScript API/工具/渲染导出/篡改保护一项均通过。首次离线安装因 Puppeteer 的锁定依赖尚未缓存失败，按同版本和完整性补齐缓存后重跑通过。本机直接请求 Modrinth 超时；线上临时目录从真实 npm 归档安装后，公开 API 与显式测试宿主选择的 `glm-5.3-flash` 翻译均返回 200，只发送一项公开英文简介。Linux Chromium 生成 980×1106 PNG 并经目视检查，原文、译文与元数据完整。测试宿主未修改产品默认配置，原插件空的 translation 任务未被当成已配置后端。随后经原 QQ 适配器和 NapCat 调试桥接，向已核验的机器人 `3094088525` 的好友 `925640859` 尝试一批带合成验收标识的卡片；回执为 `unknown`，没有重发。只读查询该好友最近 10 条记录尚未找到对应转发，不能据此证明成功或确定未发送，真实 QQ 交付与读回仍待确认。此证据不替代独立 CLI/Core 群仿真的真实入站模型验收。生产配置哈希前后一致、两项原服务持续 active，未使用生产 Redis，未部署或迁移生产数据。

随后接通独立成员资料查询、精确点名、显式放通的管理员集合通知及中立成员列表。成员工具、真实正反向 WebSocket 适配、Core 注册表与发送、原有仿真运行时等工程回归共193项通过，实际独立 CLI 三项通过，均无跳过。覆盖同一发送配额、未知后禁止补发、能力结束撤销、换绑/撤回迟到结果丢弃，以及账号/群/命名空间/新鲜度/完整性/重复成员的拒绝。专项先复现短昵称误指另一成员、否定或举例仍通知、排除群主却被包含，以及中文紧邻QQ号误拒，再由相同用例验证修复。成员名单仅暴露昵称、名片和角色；单人详情仅返回已确认对象的可选白名单资料，不伪造缺失值或透传原始响应。CLI 同时验证真实入站@优先于模型猜测ID、原生at与正文同条交付、一次配额及管理员默认禁用。测试脚本对工具结果的解析改为在固定运行时回执界标处分离JSON，未知动作测试明确允许模型继续收尾但不执行后续外部工具。

后端构建、类型检查、Core边界与差异空白检查通过。仓库外从真实 npm 归档按锁离线安装后，成员 CLI 三项和公共 TypeScript API/独立宿主确认投递/篡改保护一项均通过；包含新增成员资料、请求及发送上下文类型。这些证据使用隔离 Redis、合成平台与模型，不替代真实 QQ 群成员查询/点名与模型验收。线上另做窄范围只读核查：精确核验原账号与好友，正反顺序各查20条历史，最近记录仍早于原卡片投递窗口，没有找到可核验候选；结论仍为unknown。此轮零新增线上发送、零重试，生产配置哈希未变，远端临时核查目录已清理；未部署或迁移生产数据。

随后接通独立显式历史工具及其有界原文来源库，不依赖 embedding、摘要或画像服务，保留时间范围、分来源分页、真实记忆ID详情与来源覆盖说明。群仿真、群文字和好友私聊均已接线；群内只查当前群原文及可见事实，私聊只查同账号、同Agent当前授权群中的本人原话。读取后及每次模型请求、兼容重试和发送前重新核验来源与隐私；历史结果和本轮派生回复不写入持久模型历史、角色记忆/目标/作品、情节、自动群学习及工具观察。换绑清除旧recent，离线或旧角色分区也按保留期清理原文。旧无来源缓存和完整插件归档未自动导入，不将有界来源视为完整旧历史迁移。

本阶段来源、存储与隐私专项21项，Core实际接线与观察端口专项11项，以及历史/工具/配置/记忆/仿真等回归144项通过，共176项工程检查，无跳过。专项先复现完整JSON预算前丢弃archive证据却漏回分页偏移的问题，改为完整JSON预算内删尾并逐来源回传偏移，同例及单来源重取随后通过；重新启用后的测试改用新时间新来源，避免错误期待旧遗忘记录复活。新增运行时fixture修正了旧工具外壳解码、存储load方法以及合成平台所需发送端口/显式绑定/注册表all清单，最终全部通过。

实际CLI两项验证在无向量和无摘要配置下，重启后仍可跨获准群分页查询本人原文，排除第三人、拒绝群、异Agent与另一接收账号；来源成员权限在含证据HTTP400时撤销后，实际含证据HTTP仅一次，兼容重试与QQ回复均被阻止。仓库外从真实npm归档按锁离线安装后，上述CLI两项及公共TypeScript API宿主/确认投递/篡改保护一项共三项通过，均无跳过。后端构建、类型检查、Core边界与差异空白检查通过，候选包为 `.release/agent-bHuXQO`；最终包仅同步本节进度到README，运行文件与该测试候选保持一致。这些证据使用隔离Redis、合成OneBot与主模型，不证明真实模型查证质量或线上QQ历史验收；本轮未部署、执行生产迁移或新增线上发送。

随后接通独立文字图片和思维导图：新旧文字入口共用完整三模板、代码高亮、Unicode截断和KaTeX排版；独立渲染无cwd临时文件，字体与D3/Markmap资产来自锁定安装包。导图使用显式独立模型，逐次数字用量记账，无主模型或旧插件配置回退。渲染最多20秒，图高/像素在截图前检查，来源/绑定/取消贯穿模型、渲染与当前会话图片交付；未知结果禁止自动补发。

本阶段最终专项及工具/图片/注册表/仿真能力回归118项、原有文字图片回归15项通过，共133项，无跳过。真实Chromium检查document/knowledge公式字体、chat头像解码、导图全部节点与完成fit、零网络/危险DOM、过高画布在截图前拒绝，以及迟到浏览器/页面清理。审查先复现Markdown格式分段和实体解码后拼回禁词/凭据的绕过：旧构建的三模板六场景与导图三场景均未拒绝；现改为原文及实际可见文字双重检查，同例通过且拒绝后不截图。工具单元同时验证取消后迟到模型Response关闭响应体。浏览器缓存缺失改用显式本机Chrome；旧文字测试完成断言后用临时收尾钩子关闭共享浏览器并强制测试进程退出，新渲染器测试自然退出。

最终测试候选包为 `.release/agent-pxvZDH`。仓库外真实npm归档按锁离线安装后，实际CLI文字document/双绑定隔离、独立模型导图/用量及未知发送一次三项，与公共TypeScript API/外部宿主/篡改保护一项共四项通过，无跳过；另只用 `/text-images` 和 `/mindmaps` 公共入口实际生成chat、knowledge和导图PNG，逐张确认尺寸并目视复核。离线安装首次缺少新媒体依赖缓存，按原锁版本和完整性补齐87个当前平台tarball后重新安装通过，未改锁绕过。后端构建、类型、Core边界及差异空白检查通过，CI新增Chromium/中文字体准备及包内渲染验收。最终包仅同步本节进度到README，运行内容与已测候选一致。本阶段使用隔离Redis、本地合成OneBot/模型与真实Chromium，不代表真实思维导图模型质量或线上QQ送图验收；没有部署、生产迁移或新增线上发送。

随后完成可信文件来源与独立 Excel 读取迁移。QQ 文件段保留真实 file_id/busid，平台 URL 和 opaque reference 留在适配器内，Core 入站仅保存有界名称和数量。纯文件、带文文件、可信引用、本人近期文件和当前群目录均可解析；目录每次重列使用稳定且随证据变更的连接私有引用，并受5层、100文件夹、2000总文件和500个Excel文件限制，截断明确显示。上传 notice 不伪造原消息身份，缺上传者/时间或隐私证据的仓库条目保守拒绝。

Excel 保留上述五操作和旧参数，新增可见 sourceSeq/真实 fileIndex；读取工具声明 `dataPolicy: 'ephemeral'`，首次执行前即绕过持久行动回执，非声明工具无文件端口。文件/目录结果及派生答复沿用完整临时隔离；原消息身份、当前请求正文、引用关系、目录证据、隐私、撤回或绑定变化，在下一模型HTTP/兼容重试/发送前失效。公式只读缓存，原查询函数保留；ZIP预检和解析全部在可终止线程，无跨会话缓存。损坏ZIP首次暴露旧yauzl校验流在当前Node上的错误/关闭事件缺失，修复后自行管理实际inflate并等线程退出，五类恶意ZIP与真实忙线程取消/超时反例均已通过。

专项及定向回归共291项通过（其中实际CLI两项），包外真实npm归档按锁离线安装后的公共严格TypeScript/外部宿主/篡改保护、同两条实际CLI流程及签名CDN重定向工作簿共4项通过，均无跳过。工程证据由132项文件/Excel/Core/历史/入站/工具/CLI组合、72项完整角色运行时、28项原Excel策略/查询、58项原QQ接入回归和新增重定向反例组成；最终文件名修复后针对受影响的公共网页/文件、Excel线程和两条CLI再次跑55项，全部通过。三项旧绑定测试改为明确要求新角色模型上下文不保留旧角色近期消息，保留序号递增和两条新入站断言；未放松绑定隔离。后端构建、类型、Core边界与差异空白检查通过。候选包为 `.release/agent-54cEQm`；最终包只同步本节进度到README，运行文件与已测候选一致。发布前审计复现.xlsx链接跳转到无扩展名CDN路径后被误拒；最终读取器优先保留已核验原始URL的安全文件名，该反例先红后绿并在安装包内实际解析通过。包外测试真实运行包内worker，验证本人纯文件→后续真人查询、嵌套目录列表→指定工作簿→当前群答复，Redis/日志/模型请求无文件字节、下载URL或平台文件ID；正文与派生回复未持久化。上述使用隔离Redis、本地合成OneBot/主模型及真实ExcelJS/线程，未部署、执行生产迁移或新增线上发送，不代替真实QQ文件/真实模型验收。

随后完成通用文件文本工具及固定会话文件上传原语。`fileTextTool` 复用已授权文件来源和临时资料模式，支持分页与既有多格式解析；解析子进程受期限、队列和ZIP/XML预算控制，取消后终止整个进程组并清理私有目录。真实PDF小文件使用精确字节视图。审计发现旧PPTX读取的ZIP结束与内容流竞态，修复为顺序读取，PPTX/POTX幻灯片及备注反例随后通过。DOC/RTF/OCR/DXF为固定宿主可选原生能力，缺依赖明确失败；`.xls`真实新增样本为Excel2003 XML，旧CFB二进制XLS仍复用原解析器，未新增该格式的真实样本验收。未发现旧聊天链路实际调用通用抽取helper，因此本次提供显式读取，不宣称恢复旧自动入站行为。

文件上传有独立uploaded/failed/unknown回执，不伪造messageId；与文本和图片共用队列、配额、绑定/撤回复核及未知冻结。专门复现平台已确认上传但本地配额保存失败的反例：旧构建将异常交给producer后可能被误报成功；现改为强制unknown，即使producer捕获错误并声称成功也封锁后续动作，同例先红后绿。独立宿主补上已知凭据的精确和常见编码出站检查，关闭禁词过滤也不绕过；实际CLI验证模型回显主密钥和OneBot token时零QQ发送。QQ适配兼容真实NapCat仅以file字段提供显示名的文件段，真实file_id保持最高优先。

本阶段专项与定向回归164项通过，无跳过：83项Core/工具/Excel/来源/历史/配置回归、55项QQ文件与正反向连接上传、12项通用真实解析与进程/预算、9项上传运行时、5项实际CLI。仓库外真实npm归档按锁离线安装后，12项真实格式/进程检查及5项CLI与1项公共严格TypeScript/宿主/篡改保护，共18项通过，无跳过；真实调用包内child，含DOCX、PPTX/POTX备注、PDF、二进制XLSB、ODF和EPUB。候选包为 `.release/agent-HQkkSD`；后端构建、类型、Core边界与差异空白检查通过。新增107个当前平台依赖tarball按锁定完整性补入离线缓存，未修改依赖锁。上述CLI/模型与OneBot仍为隔离合成服务，不能替代真实模型质量或真实群文件来源验收。

2026-11-15按原会话授权另做一次真实QQ私聊文件验收：核验原机器人3094088525及好友925640859后，通过当前构建的QQ文件适配器和线上NapCat本机WebUI桥接，仅调用一次 `upload_private_file`，发送95字节合成TXT `core-file-acceptance-20261115T130527Z-d0610442af87.txt`。收到明确uploaded文件ID，随后一次好友历史查询精确匹配同一文件ID、名称和机器人发送者。可选下载URL未获得允许访问的结果，没有下载后字节一致性证据；未重发或改走其他发送方式。四份生产配置前后哈希相同，未部署、改生产Redis或服务，远端新临时目录已清理。脱敏证据在本机 `/tmp/bl-core-file-upload-evidence.20261115T130527Z-d0610442af87/result.json`；这是当前适配器真实私聊上传与平台历史读回，不等于完整Core真人入站、真实群仓库/文件抽取或真实模型质量验收。最终包仅同步进度README，运行文件须与上述已测候选保持一致。

随后完成独立 `voiceTool`、火山V3受控字节合成、共享人设守卫，以及固定会话的 `sendAudio/sendVideo` 和 QQ record/video 适配。保留默认80字、五套默认样式、自定义样式、未知样式回normal及守卫轮换；HTTP原始音频、SSE/NDJSON/JSON协议通过真实localhost验证，尾部错误、超限、重定向、撤权和凭据口播均拦截。QQ部署源码审计发现旧文件/文字/bundle将handler异常误当明确失败，本轮改为source证明的schema失败400/1400才可确定未派发，200/1200及其他不明错误为unknown；旧1200断言同步修正，未知后不重试/回退。

本轮工程专项与定向回归174项通过，无跳过：59项新语音/协议及旧语音/人设，20项配置/工具/文件上传回归，72项QQ媒体/文件/bundle/发送节流，16项真实Core媒体运行时，7项实际CLI。Core覆盖固定身份/字节快照、共享预算、双向语音文字去重、临时资料禁止外发、排队撤回/换绑、unknown冻结，以及平台已sent但本地记账保存失败时强制unknown。最终源码修订后受影响的语音/人设/配置63项再次通过；后端构建、类型、Core边界与差异空白检查通过。旧manager对比测试独立保留，neutral工具测试不再静态引用包外legacy模块。

候选包为 `.release/agent-JQoBKl`。仓库外真实npm归档按锁离线安装后，18项真实HTTP协议/工具、7项实际语音CLI和1项公共严格TypeScript/外部宿主/篡改保护，共26项通过，均无跳过。CLI实际将有效WAV交到OneBot record并核验真实message_id；本地TTS pending撤回/换绑会中断HTTP且零晚发，unknown后模型故意重调语音或文字也只派发一次。这些合成服务证据不代表真实火山服务质量或QQ客户端播放。

2026-11-15按原会话授权另做一次真实QQ私聊音频验收，使用当前构建的7模块媒体适配器闭包及本机Tingting生成的84122字节、16kHz单声道16bit WAV（约2.50秒，口播“Core语音验收，无需回复”）。核验机器人3094088525及好友925640859后，仅一次send_private_msg，平台回执为unknown，无真实消息ID，未继续历史查询、未重发或改为文字/文件。四份生产配置前后哈希相同，未部署或改生产Redis，远端临时目录清理完成，永久防重占位保留。脱敏证据在 `/tmp/bl-core-audio-evidence.20261115T132641Z-d1b733fff1ab/result.json`。随后只读检查对应短时间日志窗口未取得可确定的错误线索，不能据此断言转码失败或消息已送达；随后用户在本会话明确确认已收到该条语音且能正常播放，因此这条2.50秒合成WAV的真实QQ客户端收听验收通过；当时原生平台回执仍为unknown且无消息ID，保留防重占位，不重发。该人工确认不代表真实火山合成服务或完整Core真人入站模型验收。

随后完成独立QQ音乐搜索卡片：中立卡片契约与公开 `/music` 入口、固定官方搜索/vkey/试听协议、歌曲第一首与歌手最多20首随机、私有Cookie续期与重启续存、当前群的单次原生custom卡片。Core沿用发送队列、配额、来源/版本绑定与unknown冻结；同曲更换播放签名不能绕过本轮去重，临时资料回合不能借卡片外发。QQ只接受官方页面/封面/播放URL结构，要求非空封面和真实message_id；30秒本地超时实测返回unknown，不声明NapCat签名服务停止或客户端可播放。

本阶段工程专项与定向回归167项通过，无跳过：27项新音乐提供方/工具及旧搜索/共享宿主，40项QQ音乐与真实localhost正反向连接，49项配置/私有续存/动态凭据/公共工具及文件音视频回归，24项仿真入站与工具面，14项Core音乐运行时，13项实际CLI。CLI发现新凭据虽在工具执行前被拒、原参数仍留入agentHistory；新增留存前检查，拒绝调用只留下安全名称/ID、空参数和通用错误，后续模型请求及Redis均无原凭据。同一阶段另先复现Unicode转义经JSON串行化的凭据绕过，修复共享检查后同例通过。最终源码重建后受影响套件重跑通过，类型、Core边界与差异空白检查通过；本机凭据目录0700/文件0600、初始环境指纹隔离及撤权前原子续存另有真实临时文件验证。

测试候选包为 `.release/agent-jDEpii`。仓库外真实npm归档按原锁离线安装后，23项独立协议/工具、13项实际音乐CLI及1项公共严格TypeScript/外部宿主/篡改保护，共37项通过，无跳过。CLI通过固定官方API替身、真实localhost OneBot/模型及隔离Redis执行，涵盖匿名/显式Cookie/歌手查询、启动与点歌合并刷新、新凭据跨公开工具拦截、查询/vkey期间撤回和换绑、unknown后音乐与文字均不补发。最终包只同步本节README，运行文件须与已测候选保持一致；没有部署、生产迁移或新增线上QQ发送。

2026-11-15另从当前编译提供方匿名查询一次“晴天 周杰伦”，仅向固定 `u.y.qq.com` 发出search和vkey两次HTTP，真实返回歌曲“晴天”、歌手“周杰伦”、歌曲ID `0039MnYb0qxYhV`，采用官方c6试听回退；未下载、未播放、未发送QQ卡片。脱敏记录在 `/tmp/bl-core-music-live-provider.json`。这只证明当时匿名搜索及试听引用可取得，不证明会员/vkey质量、真实Cookie登录刷新、平台签名或QQ客户端播放。NapCat签名的默认HTTP地址、备用服务、重定向及迟到发送边界见上节，不扩大本地取消保证。

随后完成独立网易云完整文件提取：群自动分享与完整操作员身份的群/好友引用命令、三种会话模式、官方元数据与有界完整音频准备、独立20MiB音频附件上传，以及完整文件→信息合并转发/文字→record试听。来源每阶段重读，私聊每次核验新鲜好友表；配置变化、来源撤回、换绑、隐私和停机撤销后续许可。持久账本每阶段先登记，unknown及平台确认后本地结算失败停止后续动作，重启遗留尝试不恢复发送；原生JSON、下载引用和音频字节不进入模型或持久资料。

本阶段工程专项与定向回归166项通过，无跳过：16项官方提供方/原生Node连接、51项QQ来源与音频附件、9项旧OneBot连接、22项完整Core流程、10项真实Redis账本、47项配置/工具/文件音视频回归、11项实际CLI。CLI通过真实本地HTTP/WS及隔离Redis核验自动native/JSON分享、群/好友引用、非好友拒绝、每次来源重读、unknown阻断、撤回/换绑确实中断下载socket、默认关闭仍保持普通入站，以及日志/模型/Redis/本地资料无下载引用、音频或宿主凭据。另有准备期间撤销配置、纯卡片群文字入站、可变producer快照、附件与试听字节一致、持久inbox重启重读等Core反例。后端构建、类型、Core边界与差异空白检查通过。

测试候选包为 `.release/agent-tEfKED`。仓库外真实npm归档按原锁离线安装后，16项提供方、11项实际提取CLI与1项公共严格TypeScript/外部宿主/篡改保护，共28项通过，无跳过；CLI运行已安装包的真实入口和生产连接器，仅由测试预加载将固定官方HTTP流量转至本地审计服务，生产配置未新增任意端点。最终包只同步本节README，其他运行文件与已测候选及当前构建核对一致。上述仍是合成音频与本地平台验收，不代表网易云实时可下载、QQ客户端文件完整性或播放验收；本阶段零新增线上发送、零部署或生产迁移。

2026-11-15另对当前编译的网易云提供方执行一次真实匿名完整准备，歌曲ID为186016，零QQ发送。最初读取暴露了Node自动地址族选择与固定DNS回调形状不匹配的问题，补上已核验地址的family后重新读取：官方详情返回200，音频入口经两次官方重定向返回text/html而非音频，格式检查拒绝，未取得可交付音频。脱敏记录在 `/tmp/bl-core-music-extraction-live-provider-final.json`。这证明修复后的原生连接与失败关闭路径，不证明该歌曲或其他歌曲当前可下载，也不代表真实QQ完整文件/介绍/试听验收。

下一阶段的只读定位已完成：自动搬运主链为 `messagePipeline → mediaOutbox → 各provider准备 → QQ deliveryGateway`，保留持久任务、群内串行与准备预热、信息/全文/图集/视频同条混合转发、sending重启转uncertain，以及仅明确未派发时的资源失败重试和降级。当前中立bundle只有text/image、最多12节点且图片2MiB/总12MiB，video最多30MiB，不能直接承载旧B站/YouTube的512MiB、抖音图集配乐或小红书全文/live-photo。基础资源寿命与有序计划合同已有下述实现和验证；QQ临时资源桥与固定目标的混合转发/直发端口已有下述实现；下一步接来源读取、Core守卫和持久队列，再落B站自动搬运完整垂直链及原降级，保留BV/b23/番剧、分段、匿名优先/授权复试、试看保护、缩略图/cleanup和未知冻结；这些业务接线尚未实现。通用VideoAnalysisTool、B站显式高清/账号授权、视频搜索发送、Pixiv搜索后五分钟会话下载及历史媒体重放仍分别计量，不能合并为自动搬运完成。

随后完成完整媒体搬运所需的基础资源合同、流式私有仓库和有序计划校验，并从公共 `/media-relay` 交付；没有接入自动搬运或新增QQ动作。18项真实文件仓库测试与11项计划测试、37项旧bundle/QQ媒体限制及连接回归，共66项通过，无跳过。真实512MiB文件完整写入并校验边界，31MiB逐块读回SHA256一致，32MiB图片边界、并发容量、retained lease、128reader配额、挂起输入/权限取消、最终open撤权、符号链接/改写及自有目录清理均有反例验证。源码复核修复了open返回前撤权双重释放配额、abort后过早移除尚未关闭的reader、未启动迭代器return跳过generator finally，以及外部context/return getter错误逃逸或中断自有清理；专项覆盖并通过。格式检查只证明有界容器头，不是视频解码或客户端播放。

测试候选包为 `.release/agent-83ENnG`。仓库外真实npm归档按原锁离线安装后，18项仓库、11项计划和1项公共严格TypeScript/宿主/篡改保护，共30项通过，无跳过；公共宿主实际stage/open/read/release，释放后拒绝旧ID。后端构建、类型、Core边界与差异空白检查通过。此前音乐提取最终包的278个既有运行/声明文件与本候选逐字节一致，唯一既有变化是Core公共类型声明追加合同；新加入7个资源/计划运行及声明文件。最终包只同步README，其他产物须与该候选保持一致。本阶段没有外部HTTP服务、真实媒体提供方、线上QQ发送、部署或生产迁移。

其后已实现QQ媒体资源桥、原生交付端口和OneBot显式注入：按connection固定account/目标/current，完整stage并核对size/hash，短期资源URL仅进入原生参数；全部视频必须有缩略图，保留混合节点及部分顺序，直发视频一次包含全部视频，端口不自动重试或降级。准备及发送按连接串行、最多4项等待；每项捕获独立调用授权上下文及入口socket，HTTP回调与后续排队任务不能继承其他回合授权。先前缺少包装的Proxy AbortSignal可令原始错误逸出，已用旧构建复现并补统一错误边界及回归。此前保存的NapCat部署源码快照对packet视频转发设100MiB限制，HTTP下载还会整文件缓冲；512MiB不能由当前180秒media、10秒bundle或15分钟旧gateway期限保证，后续实现须按完整字节量采用专用有限预算，并在真实部署重新核验上传期限、内存/磁盘及可达性。保留明确资源预处理失败→一次转发重试→原群信息+完整视频直发→明确失败后原链接；一般handler错误、超时或缺回执仍为unknown并立即停止。容量承载、正确降级与真实512MiB投递/播放分别验收，不能合并计算。

本阶段最终源码构建2064文件、类型、Core边界和差异空白检查通过。21项桥、26项原生端口、14项真实本地HTTP/双向WebSocket整合及54项旧bundle/media/连接回归，共115项通过，无跳过。桥真实stage并完整serve 512MiB校验SHA256；双向OneBot整合各自完整读取101MiB+17字节视频、PNG封面/JPEG缩图，验证顺序和回执、unknown零重试、准备期实际重连零旧发送、排队撤权零后续stage，以及HTTP中途guard/stop/bridge.close断流、路由撤销与临时副本清理。容器头有效的合成字节只证明传输完整性，不是解码或QQ播放。

测试候选包为 `.release/agent-Zhjipb`。真实npm归档在仓库外按原锁离线安装，复制到仓库外的桥/端口/整合测试61项全部通过；另一个真实归档安装通过严格TypeScript公共宿主测试1项，实际调用公开桥stage/fetch/release与公开relay端口，共62项，无跳过。旧资源基础包281个既有产物逐字节一致，变化仅OneBot运行/声明、中立动作/端口/Core公共声明及构建manifest，新增桥与交付实现。最终包只同步README及其发布校验清单，运行与声明文件须与该候选逐字节一致。仍未接B站提供方、自动队列、来源读取与Core配额/隐私守卫，也未装配独立CLI桥配置、进程生命周期或崩溃临时目录清理；下一步从这些接线继续，保留原明确失败降级和任何unknown立即冻结。此次零真实QQ发送、零部署或生产迁移。

随后按用户明确的Core边界实现B站自动搬运垂直链：Core提供方负责官方引用解析、授权复试、完整下载、独立durl资源及中立有序计划，Core持久队列负责准备/FIFO/重试/降级；QQ只负责核验来源协议、资源桥及原生消息转换。缩略图失败不丢中立完整视频，QQ明确拒绝缺缩略图时由Core回退链接。OneBot读取、Core两种群模式、真实Redis账本与独立CLI已接通，默认关闭、凭据环境变量、每连接桥、进程租约及精确owner标记清理均已实现。没有接入其他媒体提供方、私聊自动搬运或任意外部下载工具。

本阶段387项工程专项及定向回归通过，零失败/取消/跳过：B站提供器+outbox86项，真实Redis ledger37项，Core集成24项，QQ来源读取47项，宿主配置/生命周期/CLI9项，共203项新链路；已有QQ媒体桥、交付、网易云来源/音乐/完整音频回归143项，以及Core边界/inbox/旧音乐提取/音视频41项。新链覆盖BV/b23/EP、匿名与授权/试看、分P和多durl真实不同字节、101MiB完整资源与512MiB+1/32MiB+1溢出清理、无缩略图保留完整视频、严格API声明长度、全阶段pending先行/unknown冻结、CAS/ACK丢失、准备并发2/FIFO/预热、取消/停机晚到及精确目录清理。CLI通过真实Redis+本地合成OneBot WS、官方HTTPS/DNS合成响应、完整资源仓库、bridge HTTP字节读回和原生message_id确认，0模型调用；ffmpeg输出及媒体内容是合成夹具，不是视频解码或线上QQ播放证明。

本阶段修复并回归验证了：来源作者/时间/引用变化后错误进入准备重试；初次断线或读来源期间断线提前消费；文字群纯JSON卡片未准入/扩展段丢失；A账号sent/unknown后离线导致B重新搬运；兄弟账号撤回和Redis取消CAS失败未及时中止进程内资源；stop后迟到claim继续打开context。新增物理群来源共享7天归属/撤回栅栏，private与namespace仍隔离。另修复QQ来源Unicode正则的无效转义运行时语法、24小时SPI刷新误拦自身旧设备指纹，以及CDN短body仅凭自身Content-Length冒充API声明完整资源。macOS临时目录别名和测试时钟/周期tick的夹具差异已校正后鲜跑；没有用测试替代真实平台验收。

测试候选包为 `.release/agent-BWfpV2`。真实npm归档在仓库外按原锁离线安装，8组测试复制到仓库外并只读取已安装包，203项全部通过；另一个真实归档安装的严格TypeScript公共API/宿主/篡改保护1项通过，共204项，无跳过。已核对306个运行/声明产物与当前构建逐字节相同。后端构建2094文件、类型、Core边界及差异空白检查均通过。最终包只同步本节README及对应发布校验清单，运行与声明须与该候选逐字节相同。证据：`/tmp/bl-chat-core-provider-runner-review.log`、`/tmp/bl-core-bilibili-{ledger,core-runtime,qq-source,standalone,package-suites,public-consumer}.log` 与 `/tmp/bl-core-bilibili-package-proof.json`。本阶段零真实QQ发送、零部署或生产迁移；真实B站网络/账号授权、真实ffmpeg解码、QQ混合视频/直发/客户端播放仍待外部验收。

随后完成Core磁链下载垂直链：群内真实BTIH→固定缓存/DHT/固定tracker元数据→完整清单或选中文件→独立piece核验→只含所选文件的ZIP→私发原请求者→真实file_id后群内确认。Core持有原人选择、资源与持久阶段，QQ仅做协议来源/中立正文SHA256核验、独立ZIP桥及原生上传转换；默认关闭，宿主显式配置代理/桥/租约和固定aria2c/zip。关键词磁力搜索继续是独立非下载能力。2048文件全部分页、所有页确认后才开放选择，无效选择不变成整包请求，fingerprint变化或来源/选择撤回及换绑/隐私/停机均停止。TEMP私发依赖真实平台上下文，不建立额外私聊绑定或探测发言，不保证任意群成员可达。

本阶段443项工程专项与定向回归通过，零失败/取消/跳过：provider与宿主52项，真实Redis ledger48项/完整workflow22项，Core两种群模式17项，QQ ZIP桥/交付与CLI27项，共166项新链；另80项Core/旧torrent/音乐/inbox/隐私回归及197项QQ文件/音视频/音乐/来源/双向连接回归。50,000,000字节ZIP在双向WebSocket集成中经真实本地HTTP完整读取，原生参数只含URL而非超frame的base64。CLI通过真实Redis、实际系统zip、真实本地OneBot WS和ZIP桥；缓存与aria2 payload是明确的合成夹具，0模型调用，不代表真实P2P或线上QQ收件。

本阶段红例已修并同例复测：整份metadata JSON误被当工具参数净化而拒绝正常结果；长清单固定切片触发trim以及未全部确认就开放选择；无效选择可能退化整包；Core来源读取与QQ首次原生读取间正文替换；另一个媒体ledger取消故障阻断torrent/入站撤回。现在逐名称/路径做文本守卫、按完整行分页和逐批pending、固定中立正文摘要且与QQ共享CQ解析、各撤回链独立完成。Proxy AbortSignal显式拒绝，50MB原生测试的frame度量和连接重置夹具也已校正。公共严格TS消费者首次携带额外ensureCurrent进入闭合发送guard被拒，已改用公开MessageActionOptions字段后复测通过；没有放宽运行边界来迎合测试。

测试候选包为 `.release/agent-IqxEcI`。真实npm归档在仓库外按原锁离线安装，8组复制到仓库外、只读取已安装dist的166项全部通过；另一次真实归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共167项，零跳过。逐个核对329个运行/声明产物与当前构建一致；后端构建2139文件、完整类型、Core边界、CI YAML解析与差异空白检查通过。最终包仅同步本段README和发布清单，运行/声明须与该候选逐字节一致。证据：`/tmp/bl-core-torrent-{runtime,ledger-workflow,qq-archive,core-regression,qq-regression,package-suites,public-consumer}.log`、`/tmp/bl-chat-torrent-provider-standalone-tests.log`及`/tmp/bl-core-torrent-package-proof.json`。未部署、未修改生产状态、零新增真实QQ发送；真实P2P下载/网络环境、QQ原群成员TEMP私发、客户端ZIP下载/解压和字节核验仍待外部验收。全局Core迁移目标保持进行中。

随后按同一Core边界完成抖音自动搬运：官方短链/作品引用→静态分享页→目标作品受控浏览器回退→完整视频或前20张图集（明确数量和失败位置）→可选配乐轮播→中立计划→共用持久队列与QQ交付。抖音须独立显式启用，旧B站配置不扩大出机；video/note/short的闭合引用、对应provider和作品ID检查、物理来源v1归属及unknown防重均沿用。保留匿名一方Cookie、图集有序节点、配乐失败保图、缩略图失败保完整中立视频，并由QQ明确链接降级。没有迁移其他渠道或接入任意外部解析服务。

本阶段557项本地工程专项及定向回归通过，零失败/取消/跳过：抖音提供器29项（含Unicode代码点描述回归）、真实Chrome隔离2项、引用/真实Redis账本/outbox95项、Core与计划/宿主57项、QQ来源58项/实际抖音CLI3项，另B站提供器及磁链八suite227项、旧QQ媒体桥/交付/双向整合/旧抖音与inbox/隐私86项。真实Chrome通过固定匿名Cookie及签名详情→目标图集、真实本地HTTP流上限/取消及原生STUN隔离；真实Redis、OneBot WS和HTTP桥验证完整字节、节点顺序、unknown冻结及退出清理。CDN/作品内容和CLI缩略图仍是合成夹具；原生子进程边界使用合成可执行文件，宿主缺少ffmpeg/ffprobe，所以HEIC解码、H.264/AAC配乐轮播和缩略图真实编解码未验收，真实抖音反爬/完整下载和QQ客户端播放仍待外部证据。

本阶段发现并修复：缩略图失败丢弃完整中立视频、HTTP206部分响应误作整份资源、短链落到挑战页时丢失已核验作品ID、图集配乐受大小限制提前结束、UTF8分块/astral描述边界，以及匿名Cookie跨会话累计。浏览器HTTP拦截外的STUN UDP本地反例先复现4包；仅历史启动switch仍4包，改为私有profile固定WebRTC偏好并配合引擎/页面及子realm限制后，实际生产launcher无JS拦截的原生RTC反例为0包，签名详情仍成功。profile归Core私有作业和精确owner清理，不宣称OS网络沙箱。Redis快照排序、合成child启动预算、拒绝错误种类和srcdoc脚本假设已按实际边界修正后复跑；没有把尚未返回的试验当最终验收。

测试候选包为 `.release/agent-sx4kE7`。真实npm归档在仓库外按原锁离线安装后，12组测试复制到仓库外、只读取已安装dist，294项全部通过；另一次真实归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共295项，无跳过。343个运行/声明文件与当前构建逐字节相同，后端构建2160文件、完整类型、Core边界、CI YAML及差异空白检查通过。最终包仅同步本阶段README和发布清单，其余运行/声明须与已测候选一致。证据：`/tmp/bl-chat-douyin-provider-tests-final.log`、`/tmp/bl-core-douyin-{runtime-host,reference-ledger-outbox,bili-torrent-regression,existing-regression,browser-qq-cli-final,package-suites,public-consumer}.log`及`/tmp/bl-core-douyin-package-proof.json`。零生产部署/迁移、零新增真实QQ发送；全局Core迁移保持进行中。

随后按同一边界完成小红书自动搬运：官方作品/短链及QQ分享先归一为安全引用，Core负责目标笔记静态解析、匿名浏览器与受限签名feed POST、全文独立节点、完整视频或前20槽图集/实况、签名图片优先及逐槽失败回退，再交同一中立计划和持久outbox。访问token从原消息临时核验，share/账本不保存查询，入队、显示名、模型引文/展开转发及旧收件消费重新净化；恢复仍回查原平台来源。既有v1物理来源去重、pending/unknown冻结、默认B站启用边界及QQ原有选择优先级不变。

本阶段最终607项不同的本地工程专项与定向回归通过：小红书32提供器/3真实Chrome、引用与真实Redis账本/outbox137项、Core/宿主59项、QQ来源73项与实际小红书CLI3项、旧B站/抖音/QQ媒体及旧小红书189项、inbox/隐私/历史/出站规则111项。真实Chrome覆盖匿名HTTP/JS Cookie、精确目标GET及原始JSON/签名POST→图集/实况、实际launcher原生RTC零UDP，真实本地HTTP覆盖分流、限额和POST取消。CLI使用真实Redis、OneBot WS与HTTP资源桥，正文、媒体字节、槽位顺序、unknown冻结和清理通过；作品内容/CDN/模型与缩略图是明确的合成夹具，不代表线上反爬、HEIC或真实缩略图编解码、QQ客户端播放已验收。

本阶段反例与同例修复包括：逐跳换笔记先请求后检查、空图集漏封面、浏览器向其它笔记带token、短宿主Cookie未保护、来源normal被重定向升级为video；GET-only浏览器缺失旧页面POST能力也先由真实Chrome复现，再通过闭合16KiB目标feed、原body字节/受限签名及匿名父域Cookie补齐。后续复核阻断token改名进签名/其它字段、Cookie/Set-Cookie以及同note GET置换权限。浏览器测试的清理hook顺序已修并复跑；源码修改期间两项历史CLI被产物一致性保护阻止启动，最终构建后两项均单独通过，不把启动失败当业务失败或成功。

测试候选包为 `.release/agent-FU4wLQ`。真实npm归档在仓库外按原锁离线安装后，16组测试复制到仓库外、只读取已安装dist，391项全部通过；另一次真实归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共392项，零失败/取消/跳过。353个运行/声明文件在归档、安装目录及当前构建间逐字节一致；最终后端构建2175文件、完整类型、Core边界、CI YAML解析及差异空白检查通过。最终包由本段更新后重新打包，除README与发布清单外须与已测候选逐字节一致，具体目录和核对结果见 `/tmp/bl-core-xhs-release-equality.json`。证据：`/tmp/bl-core-xhs-package-proof.json`、`/tmp/bl-core-xhs-{provider-browser-final,reference-outbox,runtime-host,qq-cli,media-regression,privacy-regression,history-retest,package-suites,public-consumer}.log`。本阶段零生产部署/迁移、零新增真实QQ发送；线上小红书反爬、实际媒体下载及QQ客户端播放另行验收，全局Core迁移目标保持进行中。

随后按同一Core边界完成YouTube自动搬运：官方watch/shorts/embed/live/youtu.be引用→固定yt-dlp单视频提取→原作品身份/选定progressive MP4核验→Core独立封面/视频下载→中立计划→共用outbox及QQ。Cookie、PO Token与可选HTTP(S)/SOCKS代理只来自显式环境引用；提取器忽略外部配置、插件和继承环境，授权文件和CONNECT代理归本作业清理。保留30分钟/512MiB、封面、标题/频道/统计/简介及失败页面；缺音轨、HLS/DASH、manifest/fragments不冒充完整MP4。默认B站启用和v1物理来源去重边界不变，PO Token只在当前任务已核验googlevideo播放URL的唯一pot字段使用，不进入输出和持久记录。

本阶段529项本地工程专项及定向回归通过：YouTube提供器47项（含512MiB完整流/读回SHA256）、真实子进程/CONNECT/HTTP与SOCKS/媒体流13项、引用/真实Redis账本/outbox/配置161项、Core与宿主64项、QQ来源81项和实际YouTube CLI3项、旧YouTube/B站/抖音/小红书/outbox/消息管道160项。CLI实际运行Redis、OneBot WS及HTTP资源桥，完整视频、超时长仅元数据及unknown冻结三条链验证原字节/哈希、来源重验、0模型、重复事件不重发、授权文件/提取代理/资源桥退出清理。合成提取器程序验证真实子进程和CONNECT字节传输；CLI的元数据、缩略图及TLS接缝是合成依赖，本机缺少真实yt-dlp、ffmpeg/ffprobe，真实程序版本兼容、线上反爬、编解码与QQ客户端播放另行验收。

复核补齐合法PO query与凭据禁出的字段区分、progressive与分片声明检查、媒体字节跨块秘密检查、尾分号Cookie，以及相对重定向先解析再核验的顺序。公共API的代理语法过宽已在旧产物复现，再统一为2048字符、无原始query/fragment及无解码空白凭据后同例通过。首轮提供器测试使用缺少尺寸SOF的JPEG夹具被真实仓库拒绝，改为有效有界SOF后47项全部通过；网络测试修正升级socket关闭和同步拒绝的捕获方式。首轮CLI3项因代理源码更新被产物一致性保护阻止启动，第二次集中构建后3项全部通过；这些启动拒绝没有计为业务成功。完整类型、Core边界、CI YAML及差异空白检查通过，最终构建2187文件。

测试候选包为 `.release/agent-u2KseS`。真实npm归档在仓库外按原锁离线安装后，20组测试复制到仓库外、只读取已安装dist，497项全部通过；另一次真实归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共498项，零失败/取消/跳过。361个运行/声明文件在归档、安装目录及当前构建间逐字节一致；最终包仅同步本阶段README与发布清单，运行文件须与已测候选一致，最终目录及核对记录见 `/tmp/bl-core-youtube-release-equality.json`。证据：`/tmp/bl-core-youtube-package-proof.json`、`/tmp/bl-core-youtube-{provider-retest,network-final,reference-outbox,runtime-host,qq-cli,cli-final,media-regression,package-suites,public-consumer}.log`。本阶段零生产部署/迁移、零新增真实QQ发送；真实YouTube访问、实际yt-dlp/ffmpeg版本与编解码、QQ客户端播放另行验收，全局Core迁移保持进行中。

随后按同一Core边界完成Pixiv自动搬运：官方作品引用→原作品详情/分页核验→Core按原页顺序下载→中立介绍/图片计划→共用outbox及QQ。保留前5页、16MiB单图、40MiB总量和90秒单图期限，失败已消费字节同样扣总预算；无效或失败页不移动其他页的位置，超页与预算不足明确说明。受限作品默认只发介绍和页面；无有效受限标记始终只保留元数据。宿主可明确允许已验证的受限作品，Cookie及代理仅环境引用、Cookie仅固定元数据端点。QQ不采用卡片自报ID/标题/CDN，统一公开格式继续供其他渠道兼容。

本阶段548项本地工程专项及定向回归通过：Pixiv提供器30项、网络17项（真实loopback HTTP流、超限和取消，外部Pixiv/TLS为合成或注入接缝）、五提供方引用/plan/真实Redis账本/outbox/配置191项、Core与宿主75项、QQ来源89项及实际Pixiv CLI4项、旧Pixiv/YouTube/B站/抖音/小红书/outbox/消息管道142项。四条CLI链分别验证有序三页、中页失败保留首尾、默认受限零CDN请求、unknown冻结；实际使用独立进程、Redis、OneBot WS和HTTP资源桥，逐图字节/哈希、来源重核、0模型、重复事件不重发、SIGTERM退出和资源清理均有断言。类型、2196文件后端构建、Core边界、CI YAML及差异空白检查通过。

初轮提供器24项中5项失败：一项真实问题为资源仓库封装流错误后丢失超限分类，已改按每图实际消费量识别并保持16/40MiB精确提示；另四项为测试误认仓库空目录泄漏、或忽略含秘密的整份分页元数据会被舍弃并回退首页。初个归档候选使用了这组未冻结测试，出现同样5个失败，不作为最终验收。最终源码和测试冻结后重新构建、完整复跑提供器30项和网络17项全绿，后续归档验证以最终候选为准。红例保留在 `/tmp/bl-core-pixiv-provider-red.log`，同例修复在 `/tmp/bl-core-pixiv-provider-final.log`。

最终测试候选为 `.release/agent-n100Hs`。真实npm归档在仓库外按原锁离线安装后，25组测试复制到仓库外且只读取已安装dist，603项通过；另一次归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共604项，零失败、取消或跳过。367个运行/声明文件在候选、安装目录及当前构建间逐字节一致。最终包只同步本节README与发布清单，运行文件须与该候选一致，目录及核对记录见 `/tmp/bl-core-pixiv-release-equality.json`。证据：`/tmp/bl-core-pixiv-final-package-proof.json`、`/tmp/bl-core-pixiv-final-package-suites.log`、`/tmp/bl-core-pixiv-public-consumer-final.log`，本地证据为 `/tmp/bl-core-pixiv-{provider-final,network-final,reference-outbox,runtime-host,qq,cli,media-regression}.log`。本阶段零生产部署/迁移、零新增真实QQ发送；真实Pixiv访问、可选代理与QQ客户端图片显示另行验收，全局Core目标保持进行中。

随后完成Pixiv显式搜索、热门与画师分支、五分钟列表及整图下载迁移，公开`/pixiv`入口并装配`tools.pixiv`。默认关闭，独立于自动搬运配置，桥及私有资源生命周期共享、工具提供器和凭据独立；不扩大真人群仿真以外的工具面。保存20项安全元数据、只显示并开放前8项序号，完整绑定单槽及generation防迟到覆盖；索引重读原搜索来源，直接作品ID独立可用。确认图片送达后授权与CAS续期，完整资源计划接原发送队列/配额/审核/unknown冻结。

本阶段本地专项与定向回归共466项通过，均零失败、取消或跳过：搜索/网络/Sharp绘制47项、工具及真实Redis会话57项、新转发/来源端口与配置19项、既有工具/文件/音视频/音乐/bundle56项、自动搬运宿主/配置/Core/计划104项、实际CLI3项，以及出站净化/角色运行时91项和新编译仿真/角色领域89项。发现并修复两个真实边界问题：文字介绍后纯媒体节点拼出尾换行而被严格净化误拒，现仅合并有文字节点；包装层过宽catch吞掉派发前预算拒绝，现保留明确拒绝、原生发送异常仍由runtime归一unknown。另移除误用的ephemeral工具标记，历史/文件临时回合的媒体外发禁令保留。首轮新端口fixture漏directedToAccount、renderer全局URL遮蔽/正常换行断言和CLI取消后schema快照假设为测试错误，已分别修正；首次并发绘制约6秒后失败，独立及完整串行复跑通过，未放宽5秒栅格期限；具体冷启动或负载原因未进一步证明。源码变化期间旧CLI被构建清单拒绝，不作为业务证据。

测试候选包为`.release/agent-0tVRzy`。真实npm归档在仓库外按原锁离线安装后，16组测试复制到仓库外并仅使用已安装包，286项通过；另一归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共287项，无跳过。公共消费实际通过`/pixiv`完成受控搜索和Sharp JPEG绘制；CLI以隔离Redis、真实localhost OneBot/模型/固定官方端点替身及HTTP桥执行，核验两张列表卡、甲/乙/直接ID完整三图、当前目标与字节哈希、新搜索替换、未知后重复工具及文字冻结、默认关闭零请求/无桥，以及配置变更真实socket取消且零晚发。377个运行/声明文件与当前构建一致；后端构建2217文件、完整类型、Core边界和差异检查通过，卡面目视无溢出。最终包仅同步本段README与发布清单，运行/声明须与已测候选逐字节一致。证据：`/tmp/bl-core-pixiv-search-package-proof.json`、`/tmp/bl-core-pixiv-search-package-suites.log`、`/tmp/bl-core-pixiv-search-public-consumer.log`；本地`/tmp/bl-core-pixiv-{search-suites-final,tools-session,toolports-config-verified,toolports-regressions,host-regression,tools-cli-final,send-safety,domain}.log`。真实Pixiv网络、Cookie/代理、模型选用与QQ客户端卡面/图集未验收；本阶段零部署、生产迁移或新增线上发送。全局Core迁移目标继续进行。

随后完成独立`videoAnalysisTool`工程迁移：保留prompt及当前→引用→嵌套转发的首视频选择，新增中立视频来源/读取、纯视频与引用元数据、64MiB/60秒受控下载、独立inline或BigModel上传提供器和`tools.videoAnalysis`配置。视频和分析按临时资料隔离，来源指纹、隐私、绑定及工具定义有效性贯穿后续模型、兼容重试和发送；不沿用旧远程MP4直传或不受控上传。公开入口为`/video-analysis`，其他渠道仍只需实现中立读取合同。

本阶段最终本地专项与定向回归共397项通过，失败/取消/跳过均为零：视频输入/提供器30项、QQ来源61项、Core来源及隐私34项、文件/注册表27项、实际视频CLI4项、图片/文件/正反向OneBot/bundle/隐私与配置61项，以及出站净化/角色运行时91项和新编译仿真/角色领域89项。CLI实际启动隔离Redis、OneBot WebSocket和主/独立模型HTTP替身，当前视频→引用→嵌套转发三轮验证owned bytes、独立key、无主模型URL/bytes、分析不持久化及下一轮不可见；另验证默认关闭零请求、撤回时取消独立模型，以及配置变更时取消pending主模型socket且零晚发。QQ下载保留公网DNS固定和流/取消逻辑，TLS资源端是注入接缝；合成MP4只证明容器及字节传输，不证明真实编解码或视频理解。

修复并保留真实红例：无关失效引用曾误挡当前视频；纯视频空摘要曾被隐私来源过滤而丢失；工具完成后释放定义计时器曾使配置撤销无法取消派生主模型；临时上传URL的签名值单独回显曾绕过整URL过滤。最终来源33项扩至34项、提供器29项扩至30项和CLI4项均验证修复；相关红证据为`/tmp/bl-core-video-cli{,-final}.log`及`/tmp/bl-core-video-provider-signed-query-red.log`。首次CLI还混淆非定向bootstrap与真人工具权限，现以无正文`@+video`验证真人链，另验真正无@纯视频留存且不扩权；最初提供器来源复核时序断言属于测试错误，已按实际pre-fetch/post-response分别验证。

测试候选包为`.release/agent-P6Bt0O`。真实npm归档在仓库外按原锁离线安装后，14组测试复制到仓库外且只读取已安装dist，217项全部通过；另一归档安装的公共严格TypeScript/API/外部宿主/篡改保护1项通过，共218项，无跳过。384个运行/声明文件在候选、实际安装及当前构建间逐字节一致。后端构建2235文件、完整类型、Core边界及差异检查通过；最终包只同步本段README与发布清单，目录及核对结果见`/tmp/bl-core-video-release-equality.json`。证据为`/tmp/bl-core-video-package-proof.json`、`/tmp/bl-core-video-{package-suites,public-consumer,provider-verified,qq-verified,source-runtime-verified,file-registry-verified,cli-verified,qq-privacy-regression,send-safety,domain}.log`。真实QQ视频来源、BigModel实际上传/CDN和独立模型理解质量另行验收，本阶段零部署、生产迁移或新增线上发送。


随后完成团录迁移的共享生成器及独立QQ交付基础：原TXT/HTML模板与选择器抽为纯函数，旧DiceManager薄委托；Core产出闭合owned UTF8 TXT/HTML，默认8MiB、可显式1至100MiB，超限整体拒绝。专用QQ groupLog端口显式注入才存在，短期资源桥4份400MiB/10分钟，原群/原消息/正文hash与固定socket核验后单次上传；真实file_id才确认，unknown不重试或回退。桥内部与原ZIP复用，原ZIP硬限50,000,000字节及错误/路径保留，通用文件仍12MiB。该基础阶段尚未接独立CLI录制/命令；后续完整工作流及coFd0A独立安装76项证据已记在上方团录专节，不以基础原语证据替代业务验证。

本阶段本地专项与定向回归375项通过：owned artifact/renderer12项、共享格式/原骰子57项、新团录/旧ZIP桥及投递58项、通用文件/音频上传与正反向/bundle68项、出站/角色91项及新编译领域89项，零失败/取消/跳过。新通道真实localhost正反向WebSocket各传输完整100MiB并读取SHA256与尾部，验证来源变更/断线/停止、guard严格true、Proxy/getter零trap、TTL/容量/文件篡改与清理；这些是合成原生响应与本地HTTP资源证据，不是线上QQ接收验收。

审查修复生成文件名清洗后拼回已知秘密、跨字段检查遗漏at/type、标题截断拆开surrogate、显式null预算与secrets数组未闭合；新回归在旧dist确红后通过。artifact另拒孤立surrogate文件名。架构检查曾拒domain导入node:util，现将字节/Proxy验证放回media/infrastructure保留守卫，未放宽边界。旧formatter三组TXT/HTML SHA金标一致；现有legacy无来源JSONL和失败后回退并未因此自动修复或迁移。证据为`/tmp/bl-core-grouplog-renderer-{red,verified}.log`、`/tmp/bl-core-grouplog-{formatter-legacy,qq,transport-regression,send-safety,domain}.log`。

最终测试候选为`.release/agent-HEZMlT`。真实npm归档仓库外按原锁离线安装，10组复制到仓库外并只读已安装dist的测试138项通过；另一归档安装的严格公共TypeScript/API/实际本地桥完整HTML交付及外部宿主/篡改保护1项通过，共139项，无跳过。公共fixture初次多传ensureCurrent字段被strict guard拒绝，修为仅signal/isCurrent后重跑通过，产品合同保持不变。396个运行/声明文件与当前构建、候选、实际安装逐字节一致；后端2256文件构建、完整类型、架构边界、差异检查通过，CI将100MiB组串行运行。最终包仅更新本节README与清单，目录和一致性见`/tmp/bl-core-grouplog-release-equality.json`；安装证据`/tmp/bl-core-grouplog-package-proof.json`、`/tmp/bl-core-grouplog-{package-suites,public-consumer}.log`。本阶段无部署/生产数据迁移/线上发送，全局Core目标保持进行中。

### Core 群互动与来源时间（本批）

Core 统一解析并编排戳一戳、资料点赞及消息表情回应，QQ 适配器仅核验和投递单项动作。`AgentInteractionPlan` 携带同类有序操作，`SendInteractionAction` 携带完整绑定和当前群地址。`InteractionReceipt` 只有 `confirmed/failed/unknown`，非消息动作不制造 `messageId`。公共 `bl-chat-agent/interactions` 导出三工具 factory、计划/动作校验、回执及结果归一化和持久工作流；Core 接受 `interactions.enabled` 和动态 `isInteractionsCurrent`。

独立 QQ 默认关闭，启用与群文字逐群授权分别配置：

```yaml
tools:
  interactions:
    enabled: true
textGroups:
  - connectionId: main
    conversationId: "123456"
    tools: [pokeTool, likeTool, reactionTool]
```

本批真人工具只接群文字与群仿真。目标必须落在当前群真实成员及本条请求、真实@或已核验引用中；重名不能猜。戳最多20人、每人10次、整计划100次，资料点赞1至20赞；随机戳/点赞必须原话同分句明确随机动作，使用真实成员并排除本人和机器人。消息表情最多20项，只接受触发消息、当前引用或原话精确消息ID；Core 重读目标消息并核对隐私与撤回。好友资料点赞仍待接续，不能将本批描述成全部点赞迁完。

完整 binding + 来源 identity + 动作种类领取七天整计划 claim，派发前 pending、逐项确认后存进度；pending/unknown、已完成、已失败及同 identity 变更计划均不重放。重复返回 `completed=0`，不会重复扣本次发送预算；结算失败归 unknown。每次工具、队列及原生调用前重新检查来源正文、原时间、作者、会话、成员/目标消息、隐私、绑定及配置。普通群文字仅从可信重读解析引用作者，并固定其原正文和时间；工具与失败说明的临时上下文共用本轮固定的引用授权，不能在失权后重新绑定到新作者。unknown 停后续动作和说明文字；部分完成停止剩余动作、不额外调用模型或发文字。成功仅结束动作回合，不进入文字历史、人物学习或情节，也不伪造可引用消息。

QQ 使用 `get_group_member_info(no_cache:true)` / `get_msg` 核验，再通过入口捕获的原认证 socket 单次调用 `send_group_poke`、`send_like` 或 `set_msg_emoji_like`。每项30秒，不重试、不借重连后新 socket 接续动作。自主 `simSendPoke` 仅在真实 Core 互动通道可用时放行，保留原每群每小时6次确认上限；此旧额度是进程内窗口，不宣称跨重启持久限流。管理、钱款、空间及旧提醒的限制策略继续保留。

本批源码专项与视频相邻路径158项均有最终通过证据：互动计划/工具40项、QQ单动作及本地正反向socket42项、Core互动与引用30项、仿真深入6项、配置/装配6项、摘要时间19项、原视频群文字15项。完整类型与架构边界通过；引用漏项修复后最终冻结构建2358文件。实际 CLI 五项已在最终构建通过：三动作精确原生参数及非消息回执、unknown剩余计划与跨重启冻结、默认关闭、逐群未授予、配置撤权。使用实际子进程、Redis、WebSocket和模型HTTP通道；QQ原生服务与模型响应为本地替身，没有线上QQ效果或真实模型语义证据。没有部署、生产迁移或新增线上 QQ 发送。

候选为 `.release/agent-PtKXhz`，仅生成一个发布目录及一份真实npm归档。归档在仓库外完成消费方与安装包内部两层原锁离线安装，512个已装生产依赖版本精确匹配，19个当前平台不适用的可选项省略。20组测试完全复制到仓库外，仅读取已安装dist，308项整批全部通过，零失败/取消/跳过。严格公共TypeScript消费者（exactOptionalPropertyTypes / noUncheckedIndexedAccess）实际调用三工具及公开factory/端口，并完成外部宿主与篡改启动拒绝检查。447个运行/声明文件与最终构建、候选、已安装归档逐字节一致；最终仅同步本节README及发布清单，无额外构建、打包或归档。安装与一致性证据为 `/tmp/bl-core-interactions-{package-proof,release-equality}.json`，专项为 `/tmp/bl-core-interactions-installed-suites.log` 和 `/tmp/bl-core-interactions-public-consumer.log`。

本地相邻回归109项均有最终通过观察：首轮107项通过、两项reverse CLI因源码已修改导致manifest过期而被启动守卫拒绝，最终冻结构建后整份reverse9项通过；不将首轮描述为全绿。新编译领域89项通过。完整类型、架构边界和差异检查通过。日志为 `/tmp/bl-core-interactions-{source-final,typecheck-final,boundaries-final,build-frozen,adjacent,reverse-final,domain}.log`、`/tmp/bl-core-agent-interaction-runtime-30-final.log` 及 `/tmp/bl-core-interactions-cli-all-final.log`。

本轮实际反例与修复包括：重复confirmed误报本次完成数、帮我/替我误指向本人、随机参数覆盖明确对象、已确认poke的纯文字回执被判unknown、neutral自主能力被旧QQ格式/策略误挡、缺port仍声明真人工具，以及普通文字引用作者被入口剥离、较早引用失权后新建说明scope丢原身份。引用6个链路红例与2个早失权红例均在同例修复后通过；工具与说明共用本轮WeakMap引用pin，不持久化引用正文。两次提前构建在引用漏项及后续授权修复后作废，只有最终冻结构建作为发布证据。真实CLI首次成员列表漏group_id（3/5），补齐后同群连续case再命中正常800ms节流（4/5）；仅修fixture行及显式测试间隔后5/5通过。包外公共fixture首次漏ConversationMember.role，严格类型拒绝；补齐fixture后沿用同一已装归档继续完成严格编译、实际执行与篡改检查，未放宽产品合同或重跑308项。

### Core 好友点赞与自有消息撤回（本批）

Core 的 `likeTool` 继续使用同一平台无关互动工作流，缺省赞数恢复旧工具声明的10次，显式1至20次保持原值。好友私聊须同时启用私聊、互动通道和私聊工具白名单；默认不开放点赞或撤回。QQ 适配器在原认证 socket 上实时读取好友列表，TEMP、非好友、其他会话对象或失去好友关系均不能派发。Core 使用 `resolvePrivatePeer` 的可信身份，不从平台无关会话ID推导用户；opaque会话ID与peerID不同也保持同一规则。私聊仅能给本条真人明确请求的当前好友本人点赞，不开放随机点赞、群戳或群消息表情。

```yaml
privateChat:
  enabled: true
  allowTools: [likeTool, recallTool]
tools:
  interactions:
    enabled: true
```

`recallTool` 只处理真人当前明确要求撤回的机器人自有消息；引用只提供消息ID定位，显式ID须在本条原话中，省略且无引用时不猜最近消息或触发消息。群文字须在对应 `textGroups.tools` 中加入 `recallTool`；群仿真保留默认restricted，只有显式allow/extra才向真人开放，自主和承诺回合不能借用真人撤回权限。否定、转述、引用示例和同能力正负冲突均不能授权动作。

Core 对同会话的 `sent` 或携带 `messageId` 的 `uploaded` 确收记录保存七天归属标记，键绑定完整账号、会话、binding的source/id/revision/agentId/personaId/connectionId及消息ID，不保存正文，重复确收不延长窗口。旧消息、unknown发送、其他角色或换绑前消息均不自动获得归属；向请求人另发文件或B站授权通知这两种跨会话交付不以来源群登记撤回权限。缺少、损坏或失效的归属记录一律拒绝撤回。

撤回合同是单项 `AgentInteraction { kind: 'message-recall', messageId }`，沿用非消息回执，不能把撤回成功伪造为新消息。Core 先验证归属，再读取 `OwnMessageSnapshot` 的会话/作者/消息ID/原时间元数据；`readOwnMessage` 不返回正文，也不放宽原真人消息读取器。QQ 投递端再次实时 `get_msg` 证明机器人作者及当前会话，私聊还要求 `target_id`、self方向标记及实时好友证明，再单次 `delete_msg`。缺必需字段安全拒绝，不能据机器人作者猜私聊对方。沿用原socket、每项30秒、队列和每次调用前重验，不重试。

原生确认后调用既有入站撤回失效链，取消相关工具、文字、摘要、情节及检索中的来源，清理文字历史；回收自己被引用的消息会同步关闭当前作用域，后续不再调用模型或发送确认。效果以确收回执及持久互动账本为准，作用域取消不能成为重发依据。原生unknown且未确认完成时保留原确收历史并冻结本次操作；原生已确认但结算失败时仍执行来源失效，结果保持unknown。没有对生产数据执行迁移、部署或新增线上QQ发送。

本批最终冻结源码12组198项全部通过，零失败/取消/跳过；覆盖互动合同、四工具、权限策略、七天出站归属、QQ单项与正反socket、宿主配置/装配、群文字/仿真与opaque私聊。完整类型、架构边界和差异检查通过。一次集中构建2364文件后，实际CLI九项首轮全绿；新增好友点赞、先确收文字再撤回、delete unknown跨重启冻结、未授权隐藏及好友撤权路径，使用实际子进程、隔离Redis、WebSocket与模型HTTP通道。来源内容与QQ/模型响应均是本地替身，不能作为真实QQ客户端效果或真实模型选择证据。

候选为 `.release/agent-oAw1bY`，只生成一个发布目录及一份真实npm归档。归档仓库外完成消费方与包内部两层原锁离线安装，512个已装生产依赖版本精确匹配，19个当前平台不适用的可选项省略。23组测试复制到仓库外，仅读取已安装dist，364项整批全部通过，零失败/取消/跳过。严格公共TypeScript消费者（exactOptionalPropertyTypes / noUncheckedIndexedAccess）实际执行四工具、好友私聊工具及公开 `OwnMessageSnapshot/readOwnMessage` 合同，并完成外部宿主与篡改启动拒绝验证。449个运行/声明文件与冻结构建、候选和已安装归档逐字节一致；456个发布文件的完整哈希已核对。最终只同步本节README及发布清单，不追加构建、打包或归档。证据为 `/tmp/bl-core-friend-recall-{source-final,typecheck-final,boundaries-final,build-frozen,cli-final,installed-suites,public-consumer}.log` 及 `/tmp/bl-core-friend-recall-{package-proof,release-equality}.json`。

本轮反例定位出平台无关opaque私聊ID不能等同peerID，以及普通私聊入站队列会丢弃撤回所需引用ID；修正后同一Core专项22项全部通过，包括五种fresh自有消息核验中途撤权、群文字及显式授权仿真撤回。成功撤回实断言持久互动账本 `confirmed/completed=1`、历史失效、零后续模型或文字和重启不重放；unknown为 `unknown/completed=0` 且保留原确收历史。QQ适配器补齐跨peer在只读查询前拒绝，并拒绝回执字段对象的隐式toString执行。首轮类型检查发现异步回执unknown和联合类型收窄两处错误，冻结前已修复，最终完整类型通过。

相邻回归首轮55/57通过，两条旧音乐socket测试仍断言私聊 `readMessage` 不可用；同一原测试在上一候选 `.release/agent-PtKXhz` 正反socket均复现，证明不是本批放宽了真人reader。仅更新测试以验证已存在的好友peer与每次 `get_friend_list → get_msg` 精确顺序后，整份音乐22/22通过，保留非好友与跨peer拒绝；其余35项已有本轮冻结构建通过结果，57项均有最终通过观察，不称首轮全绿。日志为 `/tmp/bl-core-friend-recall-adjacent-final.log`、`/tmp/bl-qq-music-PtKXhz-baseline.log` 和 `/tmp/bl-qq-music-current-full.log`。此测试修正没有改产品、重构建或重打包。

### Core 群禁言、解禁与群名片（当前批）

独立互动合同新增 `member-mute`、`group-mute` 和 `member-card`，分别携带秒数、全体开关和群名片；requester固定来自当前真人消息作者，模型不能传入身份或角色。`jinyanTool` 保留target/time/random/confirm/selfDecision参数，time缺省300秒，整数按旧规则钳至0至30天，0表示解禁。每计划最多20位明确成员、每人一次；无目标不自动随机，只有本条同分句明确随机且没有指定对象时才随机选择普通成员，排除请求者、机器人及管理员；随机解禁还需fresh已禁言状态。`selfDecision:true` 和旧模型自报 `senderRole` 均拒绝。

`target: all` 仅处理当前明确请求的全体禁言开关，开启须 `confirm:true`。QQ原生接口只有开关，不提供自动到期解除；带明确时长的全体请求在调用前拒绝，不伪造定时能力或创建补偿提醒。单人禁言/解禁要求请求者与机器人均为当前群主或管理员，目标必须是已知普通成员且不是机器人。

`changeCardTool` 保留target/cardName；普通请求者仅能请求改自己，改他人须管理权限；机器人改自己可普通成员，改他人须管理权限。新名片须精确来自本条正向请求，最多60个Unicode码点，拒绝C0/C1控制字符及孤立surrogate；空串只用于明确清空。这是应用合同，不宣称QQ平台上限。定位原成员时排除新名片载荷，避免把“把小明名片改成小红”解析成操作已有成员小红；“改成清空”也不能授权空串。否定、转述、示例或正负冲突不授权管理动作。

工具、Core及QQ投递端共用角色权限矩阵。每项重新核验requester、机器人及目标；QQ端通过原认证socket按顺序执行 `get_group_member_info(no_cache:true)`，所有角色须已知且账号/群/成员完全匹配，再单次调用 `set_group_ban`、`set_group_whole_ban` 或 `set_group_card`。逐次观察容差与Core相同，不附加整组三次查询须在1.5秒内完成的限制。外部角色读取和写入并非原子事务，平台最终裁决以严格原生回执为准；每项整体30秒，不重试，冲突字段或伪造消息ID不能确认管理成功。

群文字仅在对应tools中显式授权；群仿真默认restricted，显式allow/extra才向真人开放，自主、承诺和私聊均不开放。缺成员读取或完整列表端口时不声明管理工具。成功、部分完成或unknown都结束管理回合，停止同模型响应中的其他工具和后续模型，不追加确认文字、不伪造messageId或学习记录。配置、换绑、隐私及来源撤回沿用现有每次调用前失效检查。

本批冻结源码13组272项全部通过，零失败/取消/跳过；覆盖共享权限、六工具/合同/正负意图、QQ单项与正反socket、配置/装配、群文字/仿真及好友点赞/自有消息撤回回归。完整类型、架构边界及差异检查通过，一次集中构建2367文件已完成。实际CLI14项首轮全部通过，覆盖六种管理效果无额外文字、fresh请求者降权拒绝、unknown跨重启冻结及默认关闭/未授权隐藏，保留前批九项互动/好友/撤回路径。本地隔离Redis、WebSocket及模型HTTP替身不代表真实QQ或模型语义验收完成。

候选为 `.release/agent-7qH47D`，只生成一个发布目录及一份真实npm归档。仓库外消费方与安装包内部两层原锁离线安装后，512个生产依赖精确匹配，19个当前平台不适用的可选项省略。25组测试复制到外部且仅读已安装dist，457项整批全部通过，零失败/取消/跳过。严格公共TypeScript消费者（exactOptionalPropertyTypes / noUncheckedIndexedAccess）编译通过，实际执行六工具、十组计划、六种公开QQ管理调用以及外部Core宿主；篡改启动拒绝检查通过。450个运行/声明文件与冻结构建、候选、已安装归档逐字节一致；457个发布文件的哈希已核对。最终仅同步本文README与发布清单，不额外构建、打包或归档。证据为 `/tmp/bl-core-group-management-{source-final,typecheck-final,boundaries-final,build-frozen,cli-final,installed-suites,public-consumer}.log` 及 `/tmp/bl-core-group-management-{package-proof,release-equality}.json`。

包外457项首轮全绿后，公共宿主首次因测试临时Unix socket路径达104字符而无法连接Redis；独立bind同路径复现 `AF_UNIX path too long`。仅将测试socket移到短临时目录，在同一已安装归档继续完成公共宿主和篡改检查，没有重跑已绿457项或修改产品。证据为 `/tmp/bl-core-group-management-{package-run,redis-path-failure,package-resume}.log`。

本轮同例修复包括“确认开启全体禁言”被正向前缀漏识别、名片否定句顺序/代词误选、“改成清空”的空串载荷混淆，以及工具层误加整组1.5秒证据期限。最后一项改为逐次与Core观察规则对齐，三次各1100ms及正负2000ms观察值的虚拟时钟反例通过。仿真首次成功后仍调用第二次模型的两例在terminal接线后转绿；最终50项Core管理专项同时覆盖同响应第二工具、部分完成及首项unknown的硬停止和重启不重放。首轮类型检查发现扩大后的operation联合被用于索引原三种正则，已将该函数参数收窄为实际三种key，最终完整检查通过。没有新增线上发送、部署或生产数据迁移。

本批人物卡/代骰/检定的 Core 与 QQ 宿主接线、私密回执事务、控制台单文件持久保存及有完整证据的私聊原文接续已完成独立安装工程验证。当前继续点为 profiles/trusteeship 等旧页面业务端口、真正多文件配置事务、其余旧数据证据审计及各能力真实 QQ/模型验收；JS/Seal 仍等待合格隔离 runner，全局目标保持进行中。

当前剩余项按实际业务区分如下：

| 能力 | 当前工程状态与继续点 |
| --- | --- |
| 戳一戳 | 群真人与受限自主已有本批独立安装工程证据；真实 QQ 验收待办，私聊不扩权 |
| 资料点赞 | 群真人及好友私聊已有独立安装工程证据；真实 QQ 与模型选择验收待办 |
| 消息表情回应 | 群真人已有本批独立安装工程证据；真实客户端显示及模型选择待验收 |
| 撤回 | 当前绑定确收自有消息的真人出站撤回已有本批独立安装工程证据；真实 QQ 验收待办，入站撤回失效链继续复用 |
| 禁言 / 解禁 | 单人及全体开关已有独立安装工程证据；不提供全体定时解除，真实QQ验收待办 |
| 改群名片 | 独立Core真人请求及fresh角色核验已有独立安装工程证据；真实QQ验收待办 |
| 送礼 | 8种既有礼物展示已接独立Core、群文字/真人仿真及NapCat；只凭native packet接受确认，真实客户端显示待验收 |
| 抢红包 | 显式与独立自动producer已接Core、账号级去重和口令/领取分阶段账本；显式权限与自动权限独立，真实NapCat兼容性待验收 |
| QQ 空间 | 自身纯文字发布/稳定ID删除及真人仿真visit/like/comment已接Core；默认关闭，受控HTTP与真实QQ/fs兼容性另验 |
| 提醒 | 冻结extra_action、专用延期戳、本地/custom/MCP执行、可撤销规则和离线原子迁入已接Core；群文字保持静态，私聊仅查/取消；真实工具验收另列 |
| 骰子与规则 | 公开表达式、人物卡/代骰/检定、纯 YAML、统一引擎、显式授权、私密回执事务及 Core/QQ/standalone 接线已有本批独立安装工程证据；真实 QQ 待验，JS/Seal 等待合格隔离 runner |
| 群文字调度 | strict/smart、同用户追踪、连续消息合并及独立无工具侧模型已接 Core/宿主；真实 QQ/模型触发质量待验收 |
| 宿主与数据 | 控制台 HTTP/auth/runtime/ledger、host/模型槽、人设库及 Agent assignment 单文件持久保存已有独立安装工程证据；保存后须重启。旧群及严格私聊纯文字归档已有显式离线 CAS 接续；部分旧页面、多文件事务及缺证据旧数据继续待办 |
| 外部验收 | 各 QQ、媒体服务与真实模型效果分别验收；本地替身测试不能替代 |

### 并行迁移分工（复用既有会话）

用户要求拆分会话加速后，复用以下三条独立开发线，标题保留原名。共享当前 checkout 并按文件所有权隔离；公共 Core/宿主/平台合同/OneBot 入口及本文由协调会话统一接线和写回。各线运行源码专项，冻结后按主会话给定候选验证 CLI；主会话集中构建、打包并组织仓库外安装复验。本批产品源码和包外测试输入已冻结，各线职责已完成本批集成；后续新改动须另行绑定候选与证据。没有部署或迁移生产，模块专项与独立安装工程证据均不替代真实外部验收。

| 会话 | 本轮职责 |
| --- | --- |
| [继续规划多平台聊天 Core 架构](codex://threads/01a1e756-a888-7bc2-b487-cba6a01bf568) | 公共 Core/QQ 接线、文字调度、跨模块撤销边界、最终构建与独立安装复验 |
| [迁移 QQ 空间到独立 Core](codex://threads/01a1e825-ce7a-7f31-8337-0b541771367b) | 控制台 HTTP/auth/runtime、配置/人设/模型槽/Agent assignment 单文件保存及 UI、真实重启合同复验 |
| [迁移提醒 extra_action 到独立 Core](codex://threads/01a1e825-da4c-76f0-8542-81c6673c9e76) | Dice 业务状态、显式授权、YAML/脚本边界、中立宿主桥接及私密队列回执原子闭环 |
| [迁移 QQ 礼物与红包到独立 Core](codex://threads/01a1e825-e0b0-7641-bd3f-24392f726026) | 旧群及严格私聊原文离线接续、来源/隐私/CAS 核验、源码生产器与 portable 安装测试分组 |

### 公开骰子与三线并行迁移（独立安装工程验证完成）

公开骰子仅处理群纯文字 `.r/.roll`，顶层 `dice.enabled` 默认关闭；最多5条子命令，结果合并单条发送。结果先冻结进 `agent:dice:v1`，pending恢复为unknown，不重掷；来源、完整绑定、配置限额或隐私失效永久清除可重发结果。入站控制队列保存dice配置指纹，旧普通控制事件不会在升级后变成骰动作。最终投递await fresh来源核验后再同步guard；确认sent后由私有producer写入团录，保存真实入站messageId，结果事件与投递ID单列。关闭团录或AI静默仍可按显式dice授权执行；人物卡、检定、代骰和规则未宣称完成。

QQ空间、礼物与红包公共服务已接平台adapter、工具注册表、群文字、真人仿真及独立宿主。`tools.qqActions` 默认全关，连接须另显式声明 `qqActions: {driver: napcat, giftDisplay, redPackets, qzone}`，群文字须逐群列出工具。QQ副作用共用本轮发送队列/预算，confirmed或unknown立即结束，不伪造文字messageId或学习；空间文字须人格、安全及原文一致审查。原生关闭标记只能精确可信匹配，伪造或额外字段仍是unknown。自动红包使用单独wallet事件与授权，无raw钱包入普通inbox；撤回或隐私操作清除原生凭据，同socket亦不复用旧packetRef。

礼物只有固定8种protobuf展示，不声明支付、扣费或客户端收件。红包以账号和真实packet identity去重7天，口令确认并持久化后至少500ms、重验授权再领取；unknown或不确定旧阶段冻结。自动领取保留机器人专属与概率/冷却规则，不能借真人工具授权执行。空间own发布/删除只由当前真人触发，删除须稳定postId和本角色确收归属；visit凭证绑定同角色/真人来源、15分钟，正文和凭据不持久化，效果/来源去重账本永久保留。

延期提醒以 `tools.deferredActions.enabled` 和精确 `rules` 默认拒绝，普通 `extraTools` 不自动授予延期权。规则绑定identity、scope、creator、tool、executor、definitionId、revision、最大延迟和独立执行窗口。`reminderTool` 只供真人仿真登记一次性固定参数，到期不重新调用模型；创建与执行均fresh核验原消息、作者、隐私、绑定和工具定义。同账号普通承诺和延期调度串行，停机先drain延期任务；已确认extra只恢复未发正文，unknown停止正文并跨重启不重放。内置专用poke使用 `core:deferred-poke:v1` 与既有持久互动工作流；custom必须显式definition，MCP直接固定SDK generation端口，不伪造user actor，工具列表变化、断开和配置变更撤销。普通群文字保持static commitmentTool，私聊仅本人list/cancel。

离线迁移通过 `--migrate-qq-state --deferred-reminders /path/to/selections.json` 的每记录mapping/grant接入原预览和CAS事务；缺证据留源，冻结/终态不入pending。Standalone还须显式配置 `tools.deferredActions.migrationApprovals`，逐项精确匹配 `{id,sourceHash,authorizedBy,at}`，叠加当前规则、创建者和隐私核验；默认空数组不执行迁入extra。公共宿主可实现 `verifyDeferredMigration`，同样不得由持久化creator推断真人或管理员权限。

本轮源码证据包括：骰子/团录队列/最终投递128项，Core QQ24项、群文字及意图25项、仿真QQ22项、Core延期18项、延期及承诺99项、QQ空间64项（本轮新增own意图反例后工具测试另增1项）、礼物红包120项、OneBot23项、MCP与严格配置18项及迁移授权parser11项、离线迁入23项、旧配置默认值56项和宿主延期配置5项。分组存在邻接重叠，不相加充当独立验收计数。真实CLI骰子6项、延期6项和QQ动作12项已通过；最终安装包同批完整复验见下段。

保留真实失败证据：Core显式红包曾被自身ephemeral标记提前拒绝，修复为仅在自身结果返回后标记，先前history/文件等临时数据仍不能扩权；request新增occurredAt后闭合钱包指纹同步允许、验证并绑定原时间。CLI合理原句“你自己的空间说说”曾被own意图漏识别，原句发布/删除同例先红后绿。骰子关闭场景原测试误等不会产生的普通inbox receipt，已改为等待关闭来源fence并验证零骰动作/准入/模型。QQ CLI组合场景原20秒观察窗口低于45秒产品执行期限，按产品期限及收尾预算调整为55秒后同例23.223秒完成；产品deadline未变。首个候选已安装核对后因own意图修复停止，不作为最终交付。

最终候选为 `.release/agent-aJ6bNa`，后端最终构建2466文件。真实npm归档在仓库外消费方和包内部按原锁分别离线安装，512个生产依赖精确版本匹配、19个当前平台不适用optional省略。62个测试文件仅读已安装dist，1030项全部通过，失败/取消/跳过均为零，包含上述QQ动作、骰子、延期及旧互动/媒体/团录邻接。495个运行/声明文件与当前冻结构建、候选和已安装包逐字节一致，502个发布文件哈希核对；严格公共消费者以exactOptionalPropertyTypes和noUncheckedIndexedAccess编译且实际运行外部Core宿主、公开QQ构造器及延期/离线迁移API，篡改启动拒绝通过。随后只同步本文README和发布清单并复核最终归档文件，不追加源码构建、依赖安装或已绿测试。证据为 `/tmp/bl-core-parallel-migration-package-proof.json`、`/tmp/bl-core-parallel-migration-installed-suites.log`、`/tmp/bl-core-parallel-migration-public-consumer.log`、`/tmp/bl-core-parallel-release-equality.json`、`/tmp/bl-core-parallel-{types-qzone-final,boundaries-final,build-final,package-final-run}.log`；源码与CLI细证据为 `/tmp/bl-core-{dice-integration-final,dice-cli-fixed-final,deferred-actions-source,deferred-cli-final,qq-actions-runtime-source-final,qzone-possessive-red,qzone-possessive-green}.log` 及 `/tmp/bl-core-qq-actions-cli-{replacement-full,combined-final}.log`。测试使用真实本地进程、隔离Redis、WebSocket和模型/原生端口替身，无部署、生产迁移或线上发送；真实QQ/NapCat/空间HTTP/模型效果仍待各自验收，全局迁移目标保持进行中。

### 群文字调度、独立控制台与旧归档（前批 H0tcCn 候选）

普通群文字已接入非阻塞调度器。`textTrigger.mode` 默认 `strict`、`tracking.enabled` 默认关闭；`smart` 可结合独立 `textTriggerModel` 的无工具侧模型决定触发，单次上限 15 秒，无主模型回退。未配置侧模型时仍可处理明确直接触发。群发言概率覆盖只接受完整会话地址或 `bindingId`，拒绝裸群号；私聊及未配置公共 Core 保持原路径。

```yaml
textTrigger:
  mode: smart
  triggerPrefixes: [小白]
  tracking:
    enabled: true
textTriggerModel:
  baseUrl: https://provider.example/v1
  name: gate-model
  apiKeyEnv: TRIGGER_MODEL_KEY
```

连续消息仅作为 JSON 上下文输入，工具权限始终来自最后一条真实入站原件；合并任务对全部来源联合复核，最多 20 条。模式或配置变更使旧队列权限失效，撤回、隐私、换绑、关闭和配置撤销会取消后续模型/工具/发送。`quote: false` 确实不携带 `replyTo`。复读须与真实 `incoming.text` 精确相等，过角色黑名单、配额和持久去重，不调用模型或学习；合并回复及确收重放也不写派生学习。旧群知识、代理记忆、承诺工具已把异步来源守卫贯穿读取、排队、CAS 重试和真实写入前，保留同步旧调用兼容。

独立宿主已装配控制台 HTTP、身份认证、真实 `host.runtime` 管理和 ledger。`console.enabled` 默认关闭，默认监听 `127.0.0.1:8787`，用户文件为 `dataDir/console/users.json`；认证目录独立 0700，令牌仅从显式 `tokenEnv` 读取，setup 须显式开启。旧用户文件只读导入，不修改插件数据。HTTP 监听失败时不启动 Core；关闭先结束 HTTP/auth 再关闭 Core。每请求和每次实际 Redis 边界同时检查身份、完整绑定、连接/实例租约及配置快照；后台调度不继承已结束请求的管理权限。主配置及 `persona-library.yaml` 原文字节均参与 execution epoch，创建、修改或删除人设库都会撤销旧任务。请求结束后守卫失效。

```yaml
console:
  enabled: true
  tokenEnv: AGENT_CONSOLE_TOKEN
```

该候选的前端已具备完整 binding 选择及相关管理调用；HTTP/auth/runtime 接通不等于所有旧页面迁完。该历史候选的配置、人设、provider 持久保存 handler 为 503；后述 rW2F6f 候选已完成单文件保存事务及真实宿主接线。旧裸 group/account assignment、多 provider/明文 key，以及 profiles/trusteeship 等仍需独立宿主业务端口。保存必须使用提交所属的 revision/receipt 正确处理自身 epoch 跃迁，不能为成功返回整体豁免身份撤销；多文件一致性须真实事务，不能把两次 rename 宣称原子提交。

旧消息归档通过 `--migrate-qq-state --include-message-archive --source-archive-dir /path/to/archive` 接入现有离线预览及最终单次 Redis CAS；没有 `--migrate-qq-state` 时拒绝两个归档参数。只迁同账号/Agent/会话、QQ/global 且具有完整 `source_bot_id/source_persona_id` 的群纯文字，复核隐私、撤回和语义遗忘。冲突、模糊遗忘范围和缺来源证据安全拒绝；保留原源文件，重复执行幂等。旧摘要、情节、embedding 缺完整归属及来源证据时继续留源。

Dice 新模块提供人物卡/检定/代骰、内置与纯 YAML、状态事务、统一引擎及中立授权解析器；公开 API 已导出，该候选的 `createAgentRuntime` 和 standalone 仍走已有公开表达式路径，下一批源码接线见后述进展，不能据模块存在宣称业务迁完。新引擎先核对旧 ready/pending/unknown/confirmed 账本，冻结源、seed 和效果；真实原件作者始终保留，代骰/暗骰/人物卡须逐对象显式 grant 与 fresh 成员证据。撤回会封住输出，不回滚已提交人物卡。私密规则业务队列的真实回执原子回写仍待闭环，不自动重试未知投递。

JS/Seal 默认拒绝执行。本阶段没有具备可信 OS 总进程内存硬限制的 runner，Darwin `sandbox-exec`/Node permission 诊断不等于合格生产隔离；17 项 JS/Seal 兼容测试明确 pending skip。宿主 runner 证明合同要求独立进程、禁文件/网络/子进程、总内存 OS 硬限制及 CPU/墙钟/输入输出边界。JS 仅纯标量公式且每次重建，不保留 closure 或开放 IO；Seal 仅命令 solve 子集，原生事件/master、自动 hook/timer 及完整旧插件 API 不在已迁范围。

源码定向证据：文字整合 114 项、邻接 97 项、控制台/配置/policy 93 项、frontend 20 文件 91 项均通过；后续 persona 文件 epoch 8 项和文字尾部异步撤销 27 项通过。Dice 最终为 118 项中的 101 通过、0 失败、17 明确待验 skip，不能把 skip 算通过。最终后端 2529 文件构建、完整类型及架构边界通过。更新候选 `.release/agent-H0tcCn`；前一候选的真实本地 CLI 文字 7/7、控制台 2/2、归档 4/4 通过，使用隔离 Redis、WebSocket/模型替身；没有部署、迁移生产或新增线上发送。严格包外公共 TypeScript 消费方未使用 `skipLibCheck`，编译并实际执行根包与四个控制台子入口通过，原公共宿主及篡改启动保护也通过。更新候选在仓库外按原锁分别完成消费方与包内部离线安装，512 个生产依赖精确匹配，19 个当前平台不适用的 optional 省略；58 个 frontend 发布文件随包安装。冻结的 35 个测试文件仅读取新安装 dist，在明确的 Node 24.14.1 下完成 521 项：504 通过、0 失败/取消、17 项 JS/Seal 明确 pending skip。文字 7 项、控制台 2 项、归档 4 项真实本地 CLI 均包含其中。严格公共 TypeScript/API 消费方以 exactOptionalPropertyTypes/noUncheckedIndexedAccess 且不使用 skipLibCheck 编译并执行成功，根包及四个控制台入口均解析到新安装包；原公共宿主与篡改启动保护 1/1 通过。551 个运行/声明文件与冻结后端、候选、已安装归档一致，616 个发布文件哈希核对；最终归档仅同步本文 README 与发布清单，全部 617 个归档文件逐一核对。下一阶段源码已经并行解冻，其新改动不在本候选证据内，不据此宣称通过。证据为 `/tmp/bl-core-console-trigger-{package-proof,release-equality,frozen-source-proof}.json`、`/tmp/bl-core-console-trigger-{installed-suites-final,public-consumer-final,existing-public-consumer-final,revocation-source-green,memory-cli-source-final,source-compatibility}.log`。这些工程证据不替代真实 QQ/模型验收。

安装专项发现并修复了文字触发接入时的真实队列阻塞：已确定落在隐私删除截止线之前的来源曾抛异常并反复保留收件队头，阻塞同账号其他群的新消息。现在已知失效来源正常出队，存储错误仍保留重试；调度器后续异步守卫保持撤销即中止。新增跨群同例先红后绿，文字 Core 13/13、相关源码回归 74/74、真实隐私 CLI 1/1 通过。测试消息须使用晚于隐私 cutoff 的真实秒级 OneBot 时间，不能将同秒旧来源当作新权限或只放宽超时。包外夹具另去掉了仓库内 `src/dist` 路径依赖；4 项插件源码/旧生产器对照断言完整移至源码专属组并单独 4/4 通过，不以 skip 隐藏，也未为测试扩大发布范围。一次从 `/tmp` 启动误选了 Node 26，导致 7 个 Darwin 诊断子进程失败；确认环境差异后，同一文件在明确 Node 24 下 15/15 通过，再以该运行时完整重跑上述 35 文件全批。Node 26 那轮不计正式通过证据，生产 JS/Seal 默认拒绝执行的边界未变。

### 本批并行实现（独立安装工程验证完成）

三个既有会话按文件边界并行完成控制台配置/人设/模型槽/Agent assignment 保存、Dice 业务与私密状态事务、严格私聊原文归档接续；主会话完成 Core、QQ、standalone 接线、统一候选与本文状态。三个 subagent 先分担接线专项，再分别完成包外安装专项、Dice/QQ 新集成及严格公共消费者验证。本批冻结候选为 `.release/agent-rW2F6f`，证据与前批 `.release/agent-H0tcCn` 分开。

Dice Core 已使用新中立桥接及完整绑定显式 actor/subject grant，真实成员、原消息与引用作者独立重读；内置人物卡/检定/代骰与纯 YAML 经持久 inbox 执行。QQ 私密投递保留原群 binding，重读当前和原始来源、真实群成员与好友证据，并固定同一鉴权 socket，只有真实私信 messageId 才确认；不使用临时会话或伪造私聊 binding。私密队列删除、回执和最新业务 snapshot 在同次 CAS 落地；只有明确 failed 可显式重试，仍须重读原来源与原授权，unknown 不自动重试、补发或补说明。

撤回、停用期间重入和旧队列同时封住新状态与旧 ledger；持久 `hasSourceByTarget` 仅查询来源/索引存在性，避免移除引擎或旧 YAML 前缀后漏撤销，也不为普通未知消息创建永久 fence。forget/disable 按原账号/Agent/场景及主体索引清除 operation、origin/attempt、私密队列和审计正文，保留已提交人物卡及其他游戏值。隐私 epoch 会保守中止同账号/Agent 或场景中其他在途操作的后续效果，物理正文清理仍只作用于命中主体。状态来源指纹位于 infrastructure，保持原闭合 JSON/SHA256 算法，不放宽 domain 边界。

YAML 团务自动团录使用持久 `ownershipId → 确切 logId` 原子控制；手动结束并重开后，旧团务不能停止新团录，已有手动团录也不被自动接管。`record` 仅接受已提交 card_change/rule_event，`archive` 只接受确收的公开 dice_result；均保留真实入站 source/eventId，出站 messageId 单列，私密正文不进团录。团录仍使用现有工作流刷新 AI gate，不伪造真人 `.log` 入站消息。

Standalone 保留原 dice 四字段，新增可选 `dice.engine`；顶层及引擎双开关、inline YAML 内容哈希/版本/结构校验与启动重验、完整绑定与 actor/subject 显式 grants 均已接线，缺授权拒绝。当前宿主仅开放纯 YAML，JS/Seal 不因配置而绕过 runner 边界。控制台仍只编辑原四字段并保留 engine 内容；绑定 revision 改变会使旧完整 grant 失效，须显式更新授权，当前 UI 不编辑 engine grants。候选验证与真实启动使用同一 source snapshot；不变的 bindings 字节复用实际版本，避免内容摘要与运行版本混淆后错拒普通 host 保存。

控制台 host 与六个模型槽、人设库模板、Agent assignments 分别使用单文件保存事务，完整 source read-set revision、跨进程根锁、rename/fsync 均进入提交边界。保存或外部源文件变化永久退休旧 execution epoch，UI 等待真实重启后的新 process epoch；无变化保存不退休。提交 receipt 仅豁免本次提交自身引起的 epoch 变化，仍核身份、会话、租约、断开和秘密状态；unknown 不盲重试。启动直接解析实际 source snapshot，并使用 canonical hostFile，避免 `/var` 与 `/private/var` 路径别名冲突。人设库未知扩展原 YAML 保留，仅已知字段投影到 runtime/public，不泄漏扩展内容；已知字段、ID 和引用仍严格校验。跨多个源文件的真正原子事务尚未实现。

私聊归档已接显式迁移入口：只在开启归档接续时允许 `--friend --source-config`，私聊仍不允许 `--source-data-dir`。逐行账号、Agent、人/对端、真实时间/消息 ID、完整原文与 parts 一致性以及双端隐私、撤回和最终 CAS 均须证明；目录名不能证明 Agent，旧生产器缺 `source_persona_id` 的记录继续留源。私聊不复用同号群隐私范围。旧摘要、episode、embedding 不扩展准入。源码迁移 33/33、真实源码 main CLI 5/5 通过；新安装包归档 stage 18/18 及 CLI/集成均已通过，包含在下述包外组合证据中。

源码证据分组存在重叠，不相加充当验收总数：Dice owned 全集 184 项为 167 pass、0 fail、17 项既定 runner pending skip；Core/旧骰子/团录定向 107/107；QQ 私密 adapter/OneBot 正反向本机 WS 65/65；Core 新引擎与自动团录 49/49；standalone 配置与旧启动 34/34；新 Dice 启动与旧启动合计 17/17；源码生产器兼容 5/5。后端 noEmit、测试类型、架构边界和差异检查通过。日志为 `/tmp/bl-dice-stage-final-source.log`、`/tmp/bl-core-dice-host-wiring-source-progress.log`、`/tmp/bl-qq-onebot-dice-private-source-final.log`、`/tmp/bl-agent-dice-core-group-log-source-final.log`、`/tmp/bl-core-dice-host-config-source-final.log`、`/tmp/bl-dice-engine-startup-integration.log`、`/tmp/source-compatibility-final.log`、`/tmp/bl-core-next-stage-{backend-types-final,test-types-final,boundaries-final}.log`。

本批冻结后完成一次后端构建 2553 文件（TypeScript 5.9.3）、一次前端构建和一次发布目录生成。新候选 `.release/agent-rW2F6f` 在仓库外消费方及包内部按原锁分别离线安装，512 个生产依赖精确匹配、19 个当前平台不适用 optional 省略。Node 24.14.1 下原 35 文件首轮为 519 项、500 pass、2 fail、17 skip；保留该红日志，修正两处测试后仅在实际包外冻结目录重跑两文件 20/20，通过替换原三项观察（含一项 file-load placeholder）形成 536 项、519 pass、0 fail、17 pending 的有效组合证据，不宣称原整轮全绿。新增控制台/配置五文件 81/81、Dice/QQ 十文件 185/185，三组文件互不重复，合计 50 文件、802 项、785 pass、0 fail/取消、17 pending skip。真实 console 保存 main 启动、CLI 重启及归档接续均包含在各自包外专项中；没有仓库 src/TypeScript 回退。

严格公共 TypeScript/API 消费方以 strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess 且不使用 skipLibCheck 编译并执行；279 个声明均来自新安装包，根包、QQ 与四个 console 入口全部解析到该包。公开 Dice 桥接、Core 启停和 console HTTP 生命周期通过，原外部宿主及篡改启动保护 1/1 通过；内存状态和原生 API 替身不能证明 Redis 原子性或真实 QQ 投递。564 个运行/声明文件与冻结源码构建、候选和已安装包逐字节一致；629 个 manifest 文件、630 个 npm 归档文件及 58 个 frontend 文件核对。最终仅同步本文 README 与 release-manifest，再生成并逐文件核对最终 npm 归档，不重新构建或重复已绿 runtime 测试。证据为 `/tmp/bl-core-next-stage-{package-proof,frozen-source-proof,release-equality,installed-suites-evidence,resolution-audit,dice-qq-installed-proof,public-consumer-evidence}.json` 与 `/tmp/bl-core-next-stage-{installed-suites,focused-installed,incremental-suites,dice-qq-installed,public-consumer,existing-public-consumer,final-archive}.log`。

本轮修复了引擎关闭时旧识别只覆盖 `.r/.roll`、漏掉人物卡/暗骰/YAML 来源而可能恢复旧结果的问题；撤销识别独立于执行授权，并以已知来源索引覆盖整个引擎或规则包删除。候选保存修复 bindings 实际版本与字节摘要混淆、人设扩展误拒和公开投影问题，实际启动回归通过。包外两红分别是 portable 归档测试错误加载未发布的旧生产器、console CLI 仍期待热刷新：完整 producer 用例移至源码兼容组，其余 18 项原样保留；CLI 改为验证 409/restart-required、真实重启及新旧 epoch/token 隔离，保留账号隔离和零发送断言。产品在包外测试期间保持冻结，没有为测试扩大发布范围。没有部署、生产迁移或新增线上发送；真实 QQ/模型与合格脚本隔离验收继续单列，全局目标保持进行中。

### 操作与错误诊断（本轮优先收口）

独立宿主默认启用 `dataDir/operations/YYYY-MM-DD.NNNNNN.ndjson`。操作开始、结束、模型/工具失败、降级、取消及投递 unknown 进入同一结构化时间线，可按 `traceId` 查阅一次请求的完整链路。真人文字、仿真实际唤醒及确定性媒体/音乐/磁链工作流在解析真实绑定后建立 scope，保留 Agent、平台账号、会话、绑定版本和触发消息引用。公共 Core 提供 `createAgentDiagnostics` 和事件/sink 类型；`bl-chat-agent/logging` 导出 `openAgentOperationJournal`，嵌入宿主可自行注入 sink；未注入时使用安全 console 诊断。

日志仅允许阶段、静态操作/错误码、状态、耗时、HTTP 状态和安全异常类型，不存 prompt、聊天/工具正文、参数、provider 错误 body、URL、原始堆栈或临时媒体字节。已知秘密及常见编码另过整行检查，命中记录替换为无原 scope/编号的固定脱敏事件。兼容 logger 不输出自由文案；关键请求、回执、上下文保存和来源读取失败使用明确静态码，不能把转换为 failed/unknown 的返回值当成功。启动检查只输出固定安全诊断，不直接回显异常。

普通模型 throw、error 和空回复都记录失败；向原触发会话的说明优先交一次无工具模型调用组织，不重新执行工具。所有模型不可用或说明无有效正文时，使用短提示并附查询编号。说明沿用原 persona/发送/来源权限/撤回与去重边界；unknown 投递后不补发，重启也不能重跑已尝试操作。自动活动失败记录日志；可降级检索保留其降级行为并记录原因。失败说明不写历史、情节、群学习或角色记忆。确定性工作流沿用原有有界重试和原子回执，只在可确认的失败阶段模型化说明。

日志目录 0700、文件 0600，拒绝符号链接、硬链接及目录身份替换；单行 8KiB，前端和文件队列各有界。文件 append + fsync 才确认写入，关闭等待排队写入；启动截断半行。按 UTC 日期/大小轮转，默认单文件 8MiB、最多 14 份、保留 14 天，数量/期限先到即清理；文件 sink 写失败/拥塞通过安全 stderr 和 journal health 显式暴露；其前置队列拥塞或自定义 sink 超时通过安全 stderr 显式暴露，不递归记日志，也不改变已有业务回执。进程内只允许一个相同 dataDir writer，跨进程必须由宿主外部租约保证，CLI 使用现有 Redis 实例租约；日志不是外部动作的事务账本。

```yaml
logging:
  maxFileBytes: 8388608 # 65536..67108864
  maxFiles: 14          # 1..128
  retentionDays: 14     # 1..365
```

`--check` 和只读配置解析不建日志目录。运行后可用 `rg '查询编号中的traceId' <dataDir>/operations` 排查；`outcome=failed/unknown` 是错误与待核实记录。当前兼容日志的通用静态码不等于原插件所有历史 catch 都已审计；新增迁移能力须同时接诊断和失败说明，并保留真实外部验收。

本轮验证：日志/文字/历史/安全启动40项，实际独立CLI/配置/只读检查/音乐/视频23项，出站净化与沉默协议19项、新编译领域89项通过；运行时8组226项的首次最终批次223通过，新增两项测试误用了silent回执及legacy confirmedMessageIds结构，按实际合同修正后仿真13项全部通过，另2048文件目录text分支在原负载下超时，未改源码单独2项重跑通过。因此226项均有最终通过观察，不宣称该次完整批次全绿。证据：`/tmp/bl-core-diagnostics-{focused-verified,cli-verified,send-safety,domain,runtime-final,sim-final,catalogue-rerun}.log`。日志本身红例复现并修复了前置无界队列、DOMException实例getter干扰异常分类、关闭失败跳过日志刷盘；Core边界检查拒绝直接process访问后改回安全console出口，保留架构守卫。

候选包`.release/agent-4aE1ep`的真实npm归档在仓库外按原锁离线安装，12组复制到外部且只读取已安装dist的81项全部通过；另一归档安装的严格公共TypeScript/API日志factory实际fsync、独立宿主及篡改启动保护1项通过，共82项，零失败/取消/跳过。首轮外部测试误依赖发布包不包含的legacy一致性路由和utils shim；移除新专项的未用import，并将原插件专用测试保留在本地，没有为测试扩大发布范围。404个运行/声明文件在当前、候选、实际安装及最终包中逐字节一致，最终包仅同步本段README与清单。后端2268文件构建、完整类型、架构边界和差异检查通过。安装与文件一致性证据为`/tmp/bl-core-diagnostics-{package-proof,release-equality}.json`，专项`/tmp/bl-core-diagnostics-package-suites.log`及`/tmp/bl-core-diagnostics-public-consumer.log`。所有QQ/模型故障验收仍是本地真实CLI+隔离Redis+合成OneBot/provider；没有部署、生产数据迁移或新增线上发送，整体Core迁移继续进行。

完整Core团录录制/控制、隐私擦除、静默恢复及独立CLI生命周期已完成上述76项独立安装工程验证；真实QQ群文件收件另待验收。本批B站搜索/显式视频卡片及自主中立卡片已完成上述独立安装验证；显式高清/授权已完成257项独立安装工程验证；普通搜索视频附件及普通群文字接线已完成上述349项独立安装工程验证，剩余QQ动作及真实B站/QQ显示和播放分别验收。旧裸群ID记录缺account/Agent，不自动认领；骰子结果和规则事件仍需独立可验证producer来源，不伪造真人消息ID。

接续时保留 Modrinth 未知投递与语音未知原生回执，不自动重发；该语音已有用户确认收到且可播放，客户端验收通过。可信文件来源、Excel读取/搜索、通用抽取/当前会话上传，以及语音与受控音视频原语、音乐搜索卡片、网易云完整文件提取、B站自动搬运及磁链下载/原请求者ZIP、抖音、小红书、YouTube及Pixiv自动搬运，以及Pixiv显式搜索/选图下载和视频分析已完成上述各自工程验证；本阶段安装包验证见对应证据。团录工作流已有独立安装工程证据，本批显式视频搜索/卡片已有独立安装工程验证；显式高清/授权、普通搜索视频附件及普通群文字已完成各自独立安装工程验证；群戳、群资料点赞、群消息表情及受限自主戳已完成本批独立安装工程验证；好友点赞、当前绑定自有消息撤回及群禁言/解禁/名片已有各自独立安装工程证据；礼物展示、显式/自动红包、QQ空间及延期extra_action已有上述独立安装工程证据；本批进一步完成公开表达式、人物卡/检定/代骰、纯 YAML、私密回执与规则 producer 的 Core/QQ/standalone 接线、控制台单文件保存及严格私聊原文接续的独立安装工程验证。下一接续点是部分旧页面业务端口、真正多文件配置事务、其余旧数据证据审计及分别完成外部验收，不能把原语或B站一条链路当作全部业务迁移完成。创建/改写Excel仍是新增能力，不能把现有只读路径描述为无损编辑。QQ文件来源、群上传后查询及真实模型结果另需线上证据。显式历史已有上述本地来源与三种会话模式的工程验证，旧群及严格私聊纯文字归档已有显式离线接续，缺证据的旧摘要/情节/索引继续留源，真实 QQ/模型查证另行验收。成员查询/点名通知已完成上述工程接线，真实 QQ 与模型验收单独待办。私聊跨群本人召回已有宿主授权实现，真实语义质量另行验收。旧教学已有上述显式离线接续路径；缺少证据的记录、旧摘要、旧语义索引与情节继续留源。GitHub 成功查询、语义模型质量、MCP、图片、群知识、工作流通知、仿真真人路径及角色反思仍需各自的真实外部服务、QQ 或模型证据；两个原插件记忆模块的时间口径已核对：旧 `MidtermSummaryManager` 使用本机时区，旧 `episodicMemory` 使用 UTC 日期及滚动24小时“今天”，它们仍属插件遗留；Core 情节已按 `Asia/Shanghai` 展示且保留确认回复尾声时间，摘要已补齐原消息时间语义。摘要3天、情节7天和本人回勾30分钟均按毫秒时长执行；旧无完整来源记录留源。独立控制台 HTTP/auth/runtime/ledger 及配置/人设/模型槽/Agent assignment 单文件保存已接通；人物与托付的工作区接线进展见下节，真正多文件事务继续待办。QQ 取图取消已贯穿查询和下载，当前配置的图片服务为未监听的本机测试地址，不能作为真实图片模型证据。微信、飞书及其他平台当前只保留接入接口。

当前范围仍为独立Core与现有QQ能力，其他平台只留接口。此前按剩余工作量粗估，工程迁移约75%–80%，完整线上替换约60%–65%；本批未重新估算，这不是代码行数或测试通过率。本批人物卡/检定/代骰的 Core/QQ/宿主接线、纯 YAML 与私密规则队列回执闭环、控制台单文件保存及严格私聊原文接续已有独立安装工程证据。团录真实收件、合格脚本 runner、其余旧页面端口、真正多文件配置事务、缺证据旧数据接续与各能力真实外部验收仍未完成；不能据本批工程验证宣称全部QQ迁移或线上替换完成。全局目标保持进行中。

本批验证另包括出站安全/角色与提示词97项、团录/工具端口/操作错误诊断邻接48项及新编译领域89项，共234项回归全部通过。首轮本地视频专项137项有1项CLI fixture错误：同群连续卡片分享命中正常20分钟冷却，未进入预期unknown回执；只为unknown回合增加独立测试群后，实际CLI3项全过，最终安装包137项整批全绿。没有修改产品冷却或重新构建。审查还补齐了提供器C1/时长合同不一致（旧实现4组红例后29项通过）、HTML实体完整解码及同回合pending/unknown恢复时继续冻结，不能将未知当确定未发放行补发。测试loader默认读取dist或已安装包，源码转译仅显式BL_CHAT_AGENT_SOURCE_TEST=1，仓库外验证不复制src或TypeScript。一次后端构建、一次发布目录生成及一份npm归档完成此批；没有部署、生产迁移或新增线上发送。


### 2026-11-18：以机器人本人为中心的控制台工作区

已确认的完整方向是按机器人本人组织管理：人设模板可复用，经历和成长按本人隔离；同一本人可连接多个 QQ 账号，会话操作使用完整账号、场景地址和绑定版本。一级入口为总览、机器人、连接、资源库、运行中心、系统；本人详情为主页、会话、自我与记忆、行动、能力与边界。自我、人物、经历和行动应有真实来源关联，统一认知仍处于设计状态，不能由一个聚合页面推定已经实现。

本批源码已接入 `/api/workspace`、六入口及五标签、完整版本化会话深链、真实 capability 目录和配置 loaded/stored 状态。工作区使用本进程已加载快照，配置执行退休后仍可认证读取；原业务读写继续拒绝，等待真实新进程 epoch。目录权限与逐会话权限分别检查，按钮按 `authorizedScopes` 判断；只有已装 handler 的管理操作才可标为可用。适配器原语与宿主管理能力分别展示，目前尚不是完整的机器人工具和限制目录。目录有各 256 条及响应 1MiB 的显式资源上限。

人物管理使用真实 Core Store 的来源 entries，聚合只改变管理员查看方式，不扩大机器人跨场景使用资料的权限。删除只覆盖所选完整来源场景，以 Store 墓碑及原子 CAS 提交；无来源旧 profile 不自动认领。删除获准后先取消原账号已有来源消费者，再访问存储；请求拒绝或已撤销时不取消已有任务，另一账号不受影响。人物页精确删除使用真实 entry ID，保留 evidence 类型和来源。托付管理复用原 commitment store，保留在途取消监听、原任务 ID 和 unknown；委托记忆使用完整分区 CAS，失败日志只删除获准的精确记录并保留并发新行及无来源旧行。没有新增调度器或未知结果补发。

本批工程验证包括中立管理上下文、请求/身份/宿主/执行及绑定撤销、同群不同账号和不同本人、人物墓碑及来源撤回、真实在途 worker 取消、真实媒体任务在隐私删除时取消，以及本地 CLI 的工作区/配置状态退休与重启。后端 2568 文件集中构建、完整类型和架构边界通过；宿主定向 46 项、Core 管理真实集成 14 项、构建后 CLI/持久化/配置及邻接 59 项、来源与承诺存储邻接 72 项均通过。另一轮 195 项为 194 通过、1 项测试时钟混用失败，修复夹具后人物专项 19 项通过；保留原红例，不将局部重跑称为原整批全绿。

前端先完成 25 文件 200 项全批通过；浏览器发现破坏性确认缺少账号区分、列表刷新后陈旧确认静默失效，修复后新增 10 项组件用例，相关 5 文件 116 项通过，最终类型、格式与差异检查通过。确认框统一列出连接、完整账号及会话；旧确认拒绝时提示重新核对，不放宽原守卫。搜索按钮在窄屏保留可访问名称。前端初次构建后按这些实际发现重建，最终发布只使用修复后的字节。

真实本地浏览器使用独立 CLI、隔离 Redis、两个共享同一模板的本人、两个 QQ 连接及三个绑定，会话、记忆和承诺均由真实 Store 生成。已观察六入口、五标签、同名本人区分、完整会话深链、同群两账号人物隔离、精确删除一条、取消承诺及删除委托；另一账号和本人记录保留。删除 research 的来源自我记忆后，其两个依赖目标均显示已放弃及来源删除原因；这证明现有来源依赖撤销，不等于统一认知或完整遗忘进度已实现。待确认回执没有计作成功。配置将最大骰子数量从 100 改为 90，保存后业务入口等待重启而目录可读；真实重启后恢复已加载状态并读到 90。浅色、深色及 390px 窄屏检查通过，没有文档横向溢出；最终页面未记录 JavaScript error。确认框跨过自动刷新后显示失效提示，五条剩余人物记录没有被误删。整个 harness 禁止模型和原生业务发送，只允许合成 OneBot 登录取证。

源码/构建证据为 `/tmp/bl-console-workspace-{build,backend-typecheck,tests-typecheck,boundaries,host-source,built-integration,adjacent-built,source-final,profile-clock-fixed}.log`、`/tmp/bl-core-management-source.log`、`/tmp/bl-robot-console-final-all-tests.log`、`/tmp/bl-robot-console-confirmation-{tests,typecheck}.log` 及 `/tmp/bl-console-workspace-frontend-build-final.log`。浏览器记录为 `/tmp/bl-console-workspace-browser-{proof,backend-proof}.json`，最终总览、窄屏、完整来源确认、陈旧确认、遗忘依赖和待重启截图分别保留在 `/tmp/bl-console-workspace-*.jpg`。候选归档及包外验证接续记录在本节，不复用前批包的通过结果。

首候选 `.release/agent-ryUZuw` 的真实归档在仓库外安装后，25 文件 332 项为 331 通过、1 项失败，没有取消或 skip。继续诊断在原安装字节稳定复现两个问题：旧测试只监听 warning，实际故障已改走 error；纠正观察后，确实存在学习入队持久失败被 best-effort catch 吞掉、原收件被 ACK，重启无法补学的产品缺口。该候选明确不作最终交付，原归档、失败日志和公共接口/篡改证明保留为历史证据，不覆盖。修复将已发送历史的 best-effort 保存置于学习准入之前，学习持久异常传播给原 Core 消费者以保留来源；重启仅恢复已确认来源的学习，不重复模型或发送。私聊与无触发器群聊同例先红后绿，另核对隐私删除、撤回、换绑及私聊对象变更不会恢复旧来源，最终源码人物学习 17 项及两个 strict noEmit 通过。证据 `/tmp/bl-text-admission-source-{red,green,regression}.log`、`/tmp/bl-text-admission-strict-types.log`；旧安装证据 `/tmp/bl-console-workspace-installed-suites-2026-11-17T17-16-53-993Z.json`、`/tmp/bl-console-workspace-public-agent-ryUZuw-proof.json`。修复后重新集中构建并生成新的候选，最终安装验证必须绑定新字节。

最终候选为 `.release/agent-mHjTI9/bl-chat-agent-0.0.1.tgz`，SHA-256 为 `b778369f481bbdafbb0ac387caf535012033487fdbf8ebf4c0054e0a07e46c92`。在同一仓库外项目实际重新安装该归档后，28 个测试文件仅消费已安装 dist，最终整批 392 项全部通过，零失败、取消或 skip；运行前后 644 个发布清单文件哈希相同。新增的文字触发回归暴露旧用例仍要求学习前历史为空；测试改为核对确收历史先保存、撤销时快照与结束时完全一致，单独 27 项及最终整批通过。中间一轮还保留了测试克隆带函数对象错误及长时间进程停顿导致的超时，修正夹具后按原产品期限复查邻接 21 项通过；不将这些失败轮记作通过。最终证据为 `/tmp/bl-console-workspace-installed-suites-2026-11-18T02-16-16-089Z.json`，旧失败日志均保留，产品未因本次测试修正而重构建。

同一已安装新包的严格公开消费者使用 NodeNext、strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess 和 skipLibCheck=false，九个公共入口均解析至包内声明与实现；真实隔离 Redis 上核对 Core 启停、七项中立管理调用与关闭拒绝、真实 HTTP 认证和退休边界。531 个锁定依赖记录对应 512 个实装包与 19 个有完整平台排除证据的 optional；573 个运行/声明文件、63 个前端产物及归档 645 个文件与冻结构建和候选一致。包含 build-manifest 的 64 个前端文件与浏览器截图所用版本逐字节相同；启动脚本篡改后拒绝，恢复后全包哈希相等。证据为 `/tmp/bl-console-workspace-public-agent-mHjTI9-proof.json`，该工作区候选工程验证完成；后续配置事务批次另记如下，不能将此包的 392 项结果计作事务新候选验收。

| 已确认的最终验收例 | 本批落地 | 继续点 |
| --- | --- | --- |
| 同一本人新增第二 QQ 连接 | 已实现新增连接、明确群/好友绑定和 host+bindings 事务；本地浏览器完成预览、提交、旧实例退休及真实重启 | 真实 QQ 连接与权限验收 |
| 两个本人复用模板，成长仍隔离 | 已按 agentId 分区；支持复用模板或连同新模板创建本人，本地浏览器完成两种创建流程并核对原有来源保留 | 真实长期成长验收 |
| 异常能追到会话、配置与回执 | 已保留完整 scope、绑定版本和真实行动回执 | standalone 观测端口、回执配置版本及跳转关联 |
| 修改前知道影响，提交后确认生效 | 已实现服务端候选预览、可读差异及本人/连接/完整会话/权限影响清单；三份权威 YAML 按完整 read-set 和候选摘要事务提交，保存与加载分开确认；新候选包外 508 项、公共消费者及文件一致性验收通过 | 真实部署加载验收 |
| 遗忘后观察相关认知处理状态 | 已有来源墓碑、迟到任务取消及重读；本地浏览器观察来源记忆删除后两个依赖目标被撤销 | 遗忘操作回执、完整受影响对象和处理进度；统一认知继续按设计实现 |

工作区原候选已完成上述独立安装验证；新增 QQ、本人创建与配置事务的本批实现、新候选 508 项包外回归及公共消费者证据记录如下。后续补 standalone 观测、完整追溯与遗忘影响状态。微信、飞书和其他平台继续只保留接口。没有部署、生产数据迁移或新增真实 QQ/模型发送；整体 Core 迁移和控制台完整方案均保持进行中。

配置事务已保留三份 YAML 的权威语义，不将原文件降为导入入口。机器人页支持复用模板或连同新模板创建本人，连接页支持同一本人新增第二 QQ，只绑定明确填写的群/好友，不复制旧账号权限。`GET /api/configuration/catalog` 提供版本化目录，`POST /api/configuration/preview` 返回可读差异、受影响本人/连接/完整会话及权限变化；候选原文留在服务端，`POST /api/configuration/commit` 只接收 `previewId`、`revision`、`candidateDigest` 和 host/personas/bindings 的完整 `readSet`，最终重新校验当前来源和身份。提交成功与新进程实际加载分别记录；当前启动器没有 supervisor，不能用保存成功冒充在线生效。

持久协议已实现 journal+active/commit fence：old/new 全组原文及文件身份先持久保存，active 发布后退休旧 execution，配置读取并入统一 snapshot，在读取前后核对事务 fence，不返回逐文件 materialize 期间的混合配置。commit 记录决定恢复方向，发布可见和目录 fsync 成功分别处理；提交后目录持久化失败返回结果未知，不能自动补交。事务开始后继续核对有效的 host/auth/request 及本事务所有权，不再依赖已退休 execution，也不豁免身份撤销。真实令牌认证曾暴露每次请求 principal 不稳定导致同一有效令牌无法提交预览的问题；已改为 TTL 内复用服务端身份，不延长 TTL，退出、轮换或撤权后旧候选不能复活。认证 17 项和真实 auth+configuration HTTP 37 项均全批通过，证据为 `/tmp/bl-config-token-identity-{red,green}.log` 与 `/tmp/bl-config-transaction-real-auth-green.log`。

事务异常已接入显式离线恢复：无有效 commit 恢复 old，有有效 commit 完成 new；损坏记录或未知文件身份保留现场并拒绝覆盖。安装与恢复动作在执行前登记文件身份，恢复自身再崩溃后仍能判断已完成步骤；write lock 发布前持久化 owner-anchor，恢复核对确切 inode，准备文件使用随机名称。每次 action 的 fresh read 必须符合 manifest 或前一 action 的期望 inode 轨迹，不能认领外部替换或删除。正常启动不抢残留锁、不按 PID 自动删除，离线恢复由独立 maintenance 所有权序列化。外部编辑器不参与协议，不能承诺对其任意并发写入也具有整组 CAS；已观察到的外部新文件和 displaced 内容保留。

CLI 先以 `node scripts/start-agent.mjs --config /path/to/agent-host.yaml --inspect-config-transaction` 查看安全状态；需要恢复时先停止宿主，再以 `node scripts/start-agent.mjs --config /path/to/agent-host.yaml --recover-config` 单独执行。检查、恢复、`--check` 和迁移等命令不可混用，检查与恢复不启动 QQ、Redis 或模型。恢复只输出 phase/txId/direction/configRevision/requiresRestart 等安全回执，不输出原文和凭据；回归位于 `tests/standaloneAgentConfigRecoveryCli.test.js`。

本地浏览器以真实 CLI、隔离 Redis、HTTP 和 WebSocket fixture 完成了复用模板创建本人、同一本人新增第二 QQ、新模板与本人一起创建三条 preview→commit→旧进程退休→真实重启流程。读回四个本人（daily/default、research/default、studio/default、writer/writer-template）、三个 connected 连接（main/extra/third）和四个绑定（daily 的 main/extra、research 的 main/third）；原三组人物记忆各三条、三条承诺和三条委托均保留。`loadedRevision=storedRevision`、`requiresRestart=false`、运行 phase 为 active、transaction 为 clean，证据为 `/tmp/bl-console-configuration-browser-backend-proof.json`。三条完整交互使用 cleanup/read-envelope 修复前构建；修复后已真实重启最终 backend，再核对上述本人、连接、绑定、记忆、承诺、委托及配置状态，并补齐每组人物记忆的完整 account/scene/connectionId，证据为 `/tmp/bl-console-configuration-browser-final-backend-proof.json`，桌面和窄屏截图为 `/tmp/bl-console-configuration-persons-final-desktop.jpg`、`/tmp/bl-console-configuration-persons-mobile.jpg`。这些是本地合成 OneBot/provider 的行为和重启状态证据，没有生产 QQ 或模型动作；最终源码、构建与前端字节关系由下述包外证据核对。

首个事务候选 `.release/agent-hMaVE1` 的真实归档在仓库外安装后，完整批次 505 项为 501 通过、4 失败、零取消或 skip，原归档及 `/tmp/bl-config-transaction-installed-suites-2026-11-18T03-25-21-289Z.json` 保留。三项产品红例是只读或无变化操作留下空 `.agent-config.claims`（`standaloneAgentConfigCandidate.test.js:41,168`、`standaloneAgentConsolePersistence.test.js:287`），另有一项超时；原账号测试在同包单独 3 项通过不能替代原整批结果，该候选不作最终交付。

修复后只清理本次新建、同 inode、权限一致且确空的 claims 目录；预存目录、被替换目录、非空目录、竞争新增内容及恢复 anchor 均保留。同步读取统一为 root 前检→fence 前读→三文件完整双读及强 metadata 校验→fence 后读相等→root 后检，该读取包络不缓存结果或减少文件读取。源码诊断中 root pin 从六轮降到两轮、共 16 次根目录 stat，三文件仍各读两次；计数见 `/tmp/bl-config-root-envelope-count.json`，不据此宣称稳定倍率提速。相关回归含原安装红例 85 项全批通过，后端 noEmit 与差异检查通过，证据为 `/tmp/bl-config-transaction-cleanup-envelope-source-final.log` 和 `/tmp/bl-config-cleanup-envelope-types.log`。

独立审查在冻结的 `standaloneAgentConfigTransaction.ts` SHA-256 `6fc40eb614d22e212c1d811e5948689cf988185e929c03ad0ba597a78cf3f9d9`、`standaloneAgentConfigSources.ts` SHA-256 `271b478199be904021d12589a1bcd4fc1cbf59a208ed5bbb8dea4ba7a0ced95b` 上完成 26 个定向场景，覆盖读取包络/claims 清理及外部冲突/恢复竞争，证据为 `/tmp/bl-config-transaction-cleanup-envelope-frozen-review-proof.json`。原完整故障矩阵 272 场景保留于 `/tmp/bl-config-transaction-review-frozen-proof.json`，只对应原 hash；不将这 272 场景写作新 hash 重跑。

最终事务候选为 `.release/agent-FCtJKI`，实际归档 `/tmp/bl-config-transaction-archive-FCtJKI/bl-chat-agent-0.0.1.tgz` 的 SHA-256 为 `b6ccf1a9c054daf956dee71f991ca617d89f9606557a37d58de359a9be9ceeb1`。仓库外重新安装同一归档后，34 文件完整批次 508 项全部通过，fail/cancel/skip/todo 均为零；运行前后 648 个发布清单文件哈希一致。证据为 `/tmp/bl-config-transaction-installed-suites-2026-11-18T03-45-47-316Z.json` 与 `/tmp/bl-config-transaction-installed-FCtJKI-launch.log`。不以 hMaVE1 的局部重跑、旧工作区候选 392 项或旧 hash 的 272 场景替代新候选结果。

同一已安装 FCtJKI 的 configuration 公共消费者通过严格 TypeScript 检查与实际执行，核对 read/preview/commit 路由、提交时复核授权、未知字段及撤销身份拒绝；实际公开 CLI 使用真实 token 认证完成三类候选提交和三次重启，分别确认保存、执行退休及新进程加载。CLI 还在 persona 目标 link 后、目录 fsync 前，以及 commit marker link 后、目录 fsync 前两处实际 SIGKILL，分别核对 undo/redo、整组来源一致、重复恢复 clean 和恢复后正常检查。648 个发布清单文件在运行前后哈希相同，证据为 `/tmp/bl-config-transaction-public-proof-2026-11-18T03-48-47-998Z.json`。进程崩溃恢复不等于已证明断电持久性；该验证模型调用为零，合成 OneBot 仅核对登录。

最终九入口严格公共消费者使用 NodeNext、strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess 和 skipLibCheck=false，425 个类型输入不含仓库源码，入口均解析至已安装包。真实隔离 Redis 核对 Core 启停及七项中立管理方法、HTTP 未认证 401、退休后 workspace/config-state 200 而 profiles 409；没有模型调用或原生发送。575 个运行/声明文件、65 个前端产物、release 648 个清单文件及归档 649 个文件一致，含 build-manifest 的 66 个前端文件与浏览器使用的 hMaVE1 前端逐字节相同；18 项直接依赖、531 个锁记录对应 512 个实装包与 19 个有完整 OS/CPU 排除证据的 optional。启动器篡改后拒绝，恢复后全清单再次匹配，证据为 `/tmp/bl-console-workspace-public-agent-FCtJKI-proof.json` 与 `/tmp/bl-console-workspace-public-agent-FCtJKI-verify-launch.log`。

事务候选 FCtJKI 的浏览器 fixture 曾单次观察人物接口 7.291 秒、托付总览 19.287 秒，见 `/tmp/bl-console-configuration-browser-final-backend-proof.json`；root pin 减少本身未解决深层 guard 的重复全组读取。后续使用相同输入、固定 Store seed 时间的独立夹具建立可比基线，优化结果见下节，不把不同 fixture 的单次耗时直接比较。

本批配置事务候选的源码回归、三条浏览器交互、最终 backend 重启观察、独立安装及公共消费者工程验证已分别记录完成。后续继续点为真实 QQ 连接与权限、模型效果和长期成长、真实部署加载，以及控制台性能、观测追溯与完整遗忘影响状态；整体 Core 迁移仍进行中。

### 2026-11-18：人物与托付读取的同步守卫优化

HTTP、认证、中立管理适配、Core、人物和托付此前分别组合 `ensureCurrent` 与 `isCurrent`，深层组合反复展开父校验。现在仅对内部 factory 生成、完整 signal/current/ensure 方法元组仍匹配的 guard 合并等价观察；外部 guard 保留原来的两方法语义、调用顺序及 receiver，不能将较强的 ensure 简化成 boolean current。捕获不执行回调，每次观察均校验元组前后身份；整体替换成另一组合法内部方法也使已捕获的旧观察失效。没有 TTL、请求缓存或微任务缓存，不跨同步回调或 await 复用授权结果。

同步审计回调可以带 busy 保护回读所持 guard。初版将这类重入额外判为冲突，已由旧/新 differential 复现并修正；最终每个重入帧仍完整执行 validator，前后检查取消，Promise/thenable 不能提供同步授权，失败不被记为可复用的成功。Core、人物、托付和中立管理适配均有真实路径回归。为早期重入限制添加的 ConsoleOwnership 临时方案已删除，不作为最终架构或验收证据。真实授权、每个 await 前后、Redis 访问、最终隐私 CAS 及原 Store 在途取消均保留；Core 执行 hook 两侧仍观察父请求，防止 hook 同步撤权后继续派发。

standalone 的控制台分支由 persistence execution 统一验证同一个已加载的完整 source snapshot，不再紧随它重复读取 host/personas 子集；无控制台分支保持原配置校验。`standaloneAgentConfigSources.ts` 与 `standaloneAgentConfigTransaction.ts` 未改，仍使用完整双读、root pin、fence 和文件身份检查。最终 helper SHA-256 为 `3f05c0a19e32f3cb80a250d55d323b020c9b7fc683c8b8199003ce68d2105862`；源码九文件 219 项全部通过，完整类型、架构边界及差异检查通过，证据为 `/tmp/bl-console-perf-source-final.log`、`/tmp/bl-console-perf-types-final.log`、`/tmp/bl-console-perf-boundaries-final.log`。独立审查在最终 hash 上完成 helper 47 项、四个业务层旧/新 8 个对照及公共 HTTP 审计回读，另确认 foreign 方法序列与未改的来源/事务定向回归，汇总为 `/tmp/bl-console-performance-independent-final-review-proof.json`。中间重入 barrier 的 3 个业务红例及旧 helper 的 5 个专项红例保留，分别见 `/tmp/bl-console-perf-opaque-business-prehelper.log` 与 `/tmp/bl-sync-guard-reentry-red.log`。

新候选为 `.release/agent-NjuGVo`，一次 backend 构建生成 2577 文件，前端没有重建。相同夹具为两个本人、两个连接、三个绑定、三组人物各三条来源记录、三条承诺及三条委托；正常请求无 instrumentation 两轮结果如下。每次响应保留完整正文、entry ID、来源、权限、任务状态和排期，仅对明确列出的请求时间、进程 epoch、来源文件身份版本及其派生 token 规范化，三接口全部业务 JSON 与基线逐项一致。

| 接口 | FCtJKI 基线两轮 | NjuGVo 两轮 |
| --- | --- | --- |
| 工作区 | 133 / 66 ms | 77.464 / 64.885 ms |
| 人物 | 2824 / 2485 ms | 1078.647 / 990.557 ms |
| 托付总览 | 4271 / 4614 ms | 1792.792 / 1812.224 ms |

正常请求证据为 `/tmp/bl-console-perf-baseline-2026-11-18T04-00-19-980Z.json` 与 `/tmp/bl-console-perf-candidate-2026-11-18T04-41-59-980Z.json`。单独 instrumentation 中，人物 lstat/readFile 从 372018/34788 降至 157422/13632，托付从 667884/64644 降至 278984/26224，完整业务 JSON 同样一致，见 `/tmp/bl-console-perf-baseline-fs-2026-11-18T04-01-35-493Z.json` 与 `/tmp/bl-console-perf-candidate-fs-2026-11-18T04-42-34-405Z.json`。计数用于定位，instrumentation 耗时不作性能比较；两轮正常观察也不代表稳定生产倍率。人物约一秒、托付约 1.8 秒仍有可见延迟，下一性能边界是复合 guard 与完整绑定目录的重复来源复核，需保留真实异步及 opaque 回调边界，不能以缓存或删授权换取更短耗时。

NjuGVo 实际 npm 归档为 `/tmp/bl-console-perf-archive-NjuGVo-XcZVkK/bl-chat-agent-0.0.1.tgz`，SHA-256 `4544718bc1379221077c94ba20574eeb36989d246d476d5dc70f49bb8578a4b0`。仓库外安装同一归档后，35 文件完整批次 549 项全部通过，fail/cancel/skip/todo 均为零；4 个 helpers 与测试按当前 hash 冻结，仅消费已安装 dist。649 个清单文件运行前后相同，证据为 `/tmp/bl-console-perf-installed-suites-2026-11-18T04-45-09-768Z.json`。Configuration 公共消费者重新严格编译，实际 token 完成三类提交及三次新进程加载，真实 SIGKILL 两个窗口的 undo/redo、重复 clean 与恢复后检查均通过，证据为 `/tmp/bl-config-transaction-public-proof-2026-11-18T04-47-32-232Z.json`；没有复用 FCtJKI 的公共编译或恢复结果。

同一已安装归档的九入口严格 TypeScript、真实隔离 Redis 的七项管理方法及 HTTP 退休语义、依赖锁/平台 optional、归档与安装字节、启动器篡改拒绝及恢复后全清单一致检查通过，证据为 `/tmp/bl-console-workspace-public-agent-NjuGVo-proof.json`。576 个运行/声明文件与本轮 backend 匹配，65 个前端产物加 build-manifest 共 66 文件与 FCtJKI 的浏览器已验版本逐字节一致；未将旧浏览器动作写作本轮重新操作。最终 18 个源码/测试/前端 manifest 冻结项未变，测试与 CLI 子进程、进程组、锁均清理；没有部署、生产数据迁移、模型调用或真实 QQ 业务发送。SIGKILL 覆盖进程崩溃恢复，不证明断电持久性。

本批同步守卫优化已完成源码、独立审查、同输入性能观察、仓库外安装及公共消费者工程验证。整体目标保持进行中，接续范围仍是剩余管理读取延迟、运行观测与配置回执追溯、完整遗忘影响状态，以及真实 QQ/模型、长期成长和实际部署加载的分别验收。

本节完成时的两个继续点是 `standaloneAgentConsoleServices.project` 的同 predicate guard，以及托付一次 validate 中 list 加逐条 resolve 的重复完整来源读取；这两个点由下节继续实施和量测。通用外部 bindings 的 list/resolve 合同必须保留，不能用列表缓存替代它。现有元组品牌也不证明回调纯度或祖先包含关系，不能据此删除 Core 的整段父 guard；更大的有序组合归一须独立设计 barrier 语义后再实施。

### 2026-11-18：standalone 完整绑定目录与托付复核

`standaloneAgentConsoleServices.project` 已改用同 predicate 的内部同步 guard factory，保留逐行授权、await 后复核和最终 row binding 检查。standalone 的 management bindings 改由私有 `createAgentManagementBindings` 装配；该精确 factory 定义 list 和 resolve 都来自一次完整同步目录读取，每个公共调用仍重新读取，不增加公共可选端口或 package export。返回目录及绑定各层深复制冻结；完整比较包含 source、ID、revision、本人、人设、连接及全部场景地址，忽略目录顺序但拒绝重复会话地址。

托付 validate 只对该 factory 的精确端口，将原 list 加 N 次 resolve 改为一次 fresh 完整目录比较；捕获的期望值是静态值，每次 guard 观察仍重读。spread、foreign、Proxy、继承或 accessor 端口保持原 list/resolve 调用、顺序和 receiver。人物产品代码未改：其 list 与后续 resolve 之间有 live `context.binding` 读取，可能执行 opaque getter，不能跨过它复用观察。Core 执行 hook 两侧的父授权、完整来源双读、root/fence、每次 await、Redis CAS 和原 Store 在途取消均保留。

请求还绑定最初 ports holder 的 own data property 身份，每次 fresh 读取前后纯 descriptor 确认同一个 factory。等待期间整体替换成另一合法 factory、较强的 foreign resolver 或 accessor 时，旧请求冲突退出；不能继续旧闭包，也不能将旧请求的授权转移到新端口。初始 getter/Proxy holder 不进入优化，保留原方法序列，不为捕获再求值一次 getter。支持合法 busy observer 同步回读，每个重入帧完整复核，无缓存或 reentry barrier。

审查曾复现 thenable 数组被当作同步目录，以及 holder 被替换后旧闭包仍成功，两项均已修复。原生 Promise 使用 intrinsic then 处理拒绝而不调用覆写方法；own/inherited callable 或 accessor then、sparse/accessor/Proxy 目录均拒绝且不执行 getter/trap。holder 的 helper 四项旧实现红例与真实 Redis 的六种等待后替换红例保留于 `/tmp/bl-agent-management-bindings-holder-red.log`、`/tmp/bl-console-binding-holder-trust-red.log`；修后 helper 16 项、托付 46 项全绿。最终源码五文件 113 项全绿，类型和架构边界检查通过，见 `/tmp/bl-console-binding-perf-source-holder-final.log`、`/tmp/bl-console-binding-perf-types-holder-final.log`、`/tmp/bl-console-binding-perf-boundaries-holder-final.log`。独立审查在冻结 hash 上完成 helper 51、holder 6、Trust/Services 对照 12，共 69 个场景，见 `/tmp/bl-coherent-bindings-independent-final-proof.json`；没有将初版 hash 的证据冒充修后结果。

新候选为 `.release/agent-uLR3JJ`，一次 backend 构建生成 2580 文件，前端未重建。使用上一节相同夹具和固定 Store seed 时间，无 instrumentation 两轮结果如下；三个接口完整业务 JSON 与 NjuGVo 基线一致，规范化字段及边界沿用上一节。

| 接口 | NjuGVo 基线两轮 | uLR3JJ 两轮 |
| --- | --- | --- |
| 工作区 | 77.464 / 64.885 ms | 87.153 / 62.231 ms |
| 人物 | 1078.647 / 990.557 ms | 1020.819 / 1032.702 ms |
| 托付总览 | 1792.792 / 1812.224 ms | 1491.653 / 1373.458 ms |

正常请求见 `/tmp/bl-console-perf-binding-candidate-2026-11-18T05-21-24-580Z.json`。独立 instrumentation 中，人物 lstat/readFile 为 156486/13536，托付为 208772/17992（上批为 157422/13632、278984/26224），工作区仍为 17632/16，完整业务 JSON 一致，见 `/tmp/bl-console-perf-binding-candidate-fs-2026-11-18T05-21-58-575Z.json`。正常两轮只说明本机同输入观察，不证明稳定生产倍率；内部计数和 instrumentation 耗时不作端到端性能结论。人物约一秒、托付约 1.4 秒仍有可见延迟。

最终归档为 `/tmp/bl-console-binding-perf-archive-uLR3JJ-7h4t672a/bl-chat-agent-0.0.1.tgz`，SHA-256 `720e055f2db31aaed214e28cebc655967ffe9931b84242abe88fe218d966cea0`。仓库外安装同一归档后，36 文件与 4 个 helpers 全批 582 项全部通过，fail/cancel/skip/todo 均为零；650 个清单文件前后相同。完整批次见 `/tmp/bl-console-binding-perf-installed-suites-2026-11-18T05-24-13-826Z.json`，测试/helper 的 40 项冻结 hash 与源码保持一致，不从仓库源码执行。新增 helper 的初始 configured-only 夹具假设已按真实 legacy 合同修正；装配时误删 loadedBindings 仍依赖的 type import 已恢复，最终完整类型检查与本次全批均通过。

同包 Configuration 公共消费者重新严格编译并实际执行，真实 token 完成三类 preview/commit、保存与加载版本区分、旧执行退休及三次真实重启。两个实际 SIGKILL 窗口分别验证 undo/redo、完整来源组恢复、重复 clean 及恢复后的正常检查，见 `/tmp/bl-config-transaction-public-proof-2026-11-18T05-26-48-003Z.json`。650 文件在前后保持相同；所有 fixture、子进程、进程组、锁和安装 reader 清理后，才由主线程独占执行九入口和篡改检查。进程崩溃恢复不代表断电持久性。

最终九入口公共消费者通过 NodeNext、strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess、skipLibCheck=false，425 个类型输入均不含仓库源码，入口解析到同一已安装包。真实隔离 Redis 验证 Core 启停、七项中立管理方法及退休后的 HTTP 语义；18 项直接依赖、531 个锁记录对应 512 个实装包和 19 个有完整 OS/CPU 排除证据的 optional。577 个运行/声明文件、650 个清单文件与 651 个归档文件一致；65 个前端产物加 build-manifest 共 66 文件与上一包逐字节相同，沿用浏览器已验前端而未重新操作 UI。启动器拒绝实际篡改，恢复后再次验证全清单一致，见 `/tmp/bl-console-workspace-public-uLR3JJ-proof.json`。

本批完整绑定目录优化已完成源码、独立审查、同输入性能观察、独立安装和公共运行验证；22 个源码/测试/前端 manifest 冻结项未变，汇总为 `/tmp/bl-console-binding-perf-delivery-uLR3JJ-proof.json`。本轮无部署、生产数据迁移、模型调用或真实 QQ 业务发送。整体目标继续进行中：下一接续为运行观测与配置回执追溯、完整遗忘影响状态；剩余读取延迟须继续尊重 opaque/await 边界，真实 QQ/模型、长期成长和实际部署加载仍需分别验收。

### 2026-11-18：直接切换独立 Core 的发布准备

用户已授权提交、推送、合并 main 和生产测试，并明确取消旧插件继续处理聊天的并行方案。发布采用停用旧插件宿主与旧控制台、现有在线 QQ 连接只连接 Core 的直接切换；新控制台沿用 8787 端口，配置声明 18 个群与 2 个私聊。原插件文件和 Redis 状态保留并另行备份。

生产原状态使用隐式 legacy 键，没有可供现有显式绑定迁移器验证的来源绑定；本次不伪造迁移来源。Core 使用独立数据分区，沿用人设、模型配置和会话白名单，旧历史记忆尚未自动导入。另两个原 QQ 容器目前未在线，不能以配置存在代替连接恢复证据。

新一轮工程门禁中，后端类型、架构边界及构建通过；前端类型、29 文件 347 项测试和构建通过。完整后端批次记录为 8199 项、8129 通过、49 失败、21 跳过，并非全绿。已修复安全日志、有效绑定、退休语义及来源引用等过期测试夹具，相关六文件 79 项通过；Chromium 真实渲染 28 项通过。群记忆独立 CLI 两项通过，视频搜索完整正常及未知回执流程单独复验通过。

部分媒体、QQ 动作与定时任务 CLI 仍存在耗时超限：性能采样证明嵌套 guard 的 fresh 配置文件复核占据主要执行时间，后台来源复核也会产生大量 get_msg；该证据不证明所有失败均由并发造成。保留授权、未知回执防重和取消边界，不以延长所有超时或跳过失败宣称全量通过。按用户允许先上线测试的决定，此类耗时问题保留为后续修复项；生产启动、认证、实际连接和加载版本另取真实证据。

### 2026-11-18：生产已直接切换至 Core

实现提交 `5acd1eecd2215d9ea0db4c9167beb56ed0f6f384` 已推送到开发分支并快进合并至远端 main。该提交构建的独立发布包包含 650 个清单文件，在服务器完成生产依赖安装与逐文件 SHA-256 校验后部署到 `/opt/bl-chat-agent/releases/5acd1eecd2215d9ea0db4c9167beb56ed0f6f384`，`/opt/bl-chat-agent/current` 指向该版本。后续测试或交付记录的提交不等于运行版本已改变，以实际发布清单为准。

`trss-yunzai`、`bl-console` 已停止并禁用自启，旧 2536 端口不再监听；原宿主以退出码 15 停止留下的 failed 状态已清理，未重新启动。`bl-chat-agent` 已启用并运行，首次核对 MainPID 为 3526044、NRestarts 为 0。NapCat 的反向连接列表仅保留 Core 一项，实际 QQ 3094088525 已认证并显示 connected。当前只有该账号上线，另外两个离线账号没有冒充已迁移上线。

实际 HTTP 核对：前端 200、未认证绑定请求 401、原令牌认证 200、工作区 200、绑定列表 200、配置版本状态 200；工作区为 standalone，3 个本人、1 条真实在线连接、18 个群及 2 个私聊绑定，加载与存储版本一致、phase=active、无需重启。新控制台继续监听 8787，浏览器已实际加载生产页面。原控制台没有可导入的用户名密码文件，本次沿用原访问令牌，没有创建或更换凭据。真实主模型接口另以中性探测输入取得 HTTP 200 和有效 completion，约 3.4 秒；该探测不等于真实 QQ 用户聊天验收。

停旧写入后生成的备份位于 `/opt/bl-chat-agent/backups/2026-11-18T06-43-28Z-direct-core`，含旧配置及 data 归档、完整 Redis RDB、NapCat 原配置和旧服务定义；归档约 198 MB、RDB 约 12 MB，均为 0600，gzip 与 redis-check-rdb 实际校验通过。旧插件目录及数据仍在原处，Core 使用新分区；不能将备份或新绑定装配称为历史记忆已导入。

生产回执为服务器的 `staging/direct-cutover-receipt.json`、`staging/direct-production-verification.json` 与 `staging/direct-production-final-readback.json`。本轮没有主动向群或私聊发送测试消息，真实用户入站、模型续聊与 QQ 业务回执尚需分别验收；部分重型工具链的超时和未装配能力继续保留，不能据启动及控制台通过宣称旧插件全部能力已经完成生产验收。

切换后的继续观察已出现自然业务证据：39 次 simulation_ingest 完成、9 次 simulation_main 成功，以及一次 simSendMessage 和原生 delivery 成功；这不是人工向群注入的测试。服务再次核对仍为 active、NRestarts=0，连接 connected、配置 active。该观察仅证明已有真实入站及一次发送路径，不覆盖所有群、私聊、工具或长期运行。模型日志中 `provider_error` 还会被旧执行器的成功响应 `logger.error` 误标，不能将该行数当作真实失败次数；初始回合也存在模型异常与运行警告，仍需后续按实际回合排查。

进一步只读确认该新实例存在一条仅由真实确认回执建立的 `agent:outbound:v1` 消息归属记录，未读取或公开聊天正文。初始三个真实模型异常均为 45 秒 TimeoutError，而非启动失败；这项超时与成功响应日志误标分别保留为后续修复问题。

配置差异已单独核对：旧开启的 BT 下载、磁力搜索尚未在新宿主装配，B站旧授权自动重试未延续（新配置为 false）；语音与四个 MCP 服务在旧配置中均关闭。图片及 QQ 动作的旧配置不足以确认启用状态，不推定能力已完整接续。历史自动导入、这些能力补齐及重型工具超时为下一继续点，整体 Core 目标保持进行中。

发布包的基础回归三文件本轮为 13/14 通过，长恢复用例未全绿。该用例的旧图片 URL/私聊媒体持久化预期已对齐为按来源重新读图、保留 text part，私聊撤回零发送断言已走过；恢复消息停止前增加真实历史提交及收件确认等待，避免把前一进程尚未确认的消息混入关闭私聊的断言。仅启动就绪窗口由 8 秒调至 15 秒，业务回执窗口及总时限不变。最终同例在后续装配文字群夹具时因 `groupState.recent` 已为空、旧夹具仍直接取末项 seq 而退出，日志 `/tmp/bl-production-essential-recovery-owned-final.log`；不能将已走过的私聊及恢复片段称为整条恢复测试通过。这些测试与交付记录修订不改变已部署的产品源码或发布包。
