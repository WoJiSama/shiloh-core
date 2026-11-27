# 角色与会话绑定

本文负责配置、接口与运行合同，分别说明 Yunzai 插件入口和独立 QQ 宿主。当前实现、部署快照和剩余事项统一见[项目当前状态](../project-status.md)；候选包、阶段失败与复验保存在[历史验证记录](agent-bindings-history.md)。配置示例不表示生产已启用相应能力。

- [Yunzai 插件中的绑定](#yunzai-插件中的绑定)
- [消息与投递](#消息与投递)
- [记忆与调度](#记忆与调度)
- [独立 QQ 宿主与功能配置](#独立-qq-宿主)
- [独立控制台配置](#独立控制台)
- [Core 与平台公共接口](#核心与平台接入)
- [控制台使用与配置恢复](../../console/README.md)

## Yunzai 插件中的绑定

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

独立进程通过 OneBot v11 的正向或反向 WebSocket 处理显式绑定的 QQ 群和好友私聊。群聊默认使用仿真，也可显式切换普通文字触发模式；已接入的附图、搜索、文件、图片、媒体和 QQ 动作由各自独立提供器与权限策略装配。普通文字群和好友私聊的通用工具须另有会话授权，见下文。旧 TRSS-Yunzai 与旧控制台已从生产移除，冻结配置及数据备份独立保留；新增接续不再依赖旧入口运行。仍在迁移或待真实验收的范围见[项目当前状态](../project-status.md)。

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

### 运行告警

在独立宿主的 `agent.env` 中设置 `BL_AGENT_ALERT_QQ_OWNER_CONNECTION=qq-main`，并重启，即可通过该 QQ 连接向 `bilibiliQuality.masters` 声明的唯一可信主人发私聊。同一已核验连接须能确认对方为好友。该用途仅授权宿主发送脱敏告警。接收人由配置确定，QQ 告警结果未知时保留待核实记录。连接断开或确认未发出时，宿主保留待发告警并退避重试。

也可设置 `BL_AGENT_ALERT_WEBHOOK_URL=https://alerts.example.com/agent` 使用 Webhook。每个宿主选择一个告警渠道。Webhook 接收端需要接受 JSON `POST` 并以 HTTP 2xx 确认，地址支持 HTTPS 和本机回环 HTTP。`--check` 校验告警配置，跳过告警投递。移除所选环境变量并重启可停用推送。

推送覆盖 Core 记录的工具失败、模型和 OneBot 接口故障、MCP 连接故障、控制台服务端错误、后台任务异常、操作日志故障，以及无法确认结果的操作。正常取消和控制台预期的客户端错误不触发推送。同类故障首次立即提交，随后在 60 秒窗口内累计次数，到期推送汇总。接收端暂不可用时以 5 至 60 秒的间隔退避重试，失败写入服务日志。

Webhook 请求体形如 `{"version":1,"id":"<batch-id>","alerts":[{"stage":"model","operation":"provider_http","outcome":"failed","code":"http_error","httpStatus":503,"traceId":"<trace-id>","firstAt":0,"lastAt":0,"count":1}]}`。时间为 Unix 毫秒。重试沿用批次的 `id` 和 `Idempotency-Key`，接收端可据此去重。QQ 私聊先用中文说明发生故障的操作、状态、次数和已知原因，再给出错误码、HTTP 状态及追踪编号。追踪编号对应运行观测中的 `traceId`。外发字段仅含运行元数据，队列有界，溢出汇总附带次数。

待推送队列保存在进程内。正常退出时，停止 QQ 业务收发，并在配置及宿主租约有效时保留已核验的连接，最多给已排队的 QQ 告警 12 秒提交回执。重启后的追溯使用 `dataDir/operations` 中已提交的记录。整机宕机、强制终止和进程卡死由独立于宿主的存活监控检测。

### 连接与入站队列

每次连接及重连核对 `get_login_info` 的 QQ 号，收件按账号与显式会话绑定校验。独立宿主在读取仿真上下文期间保留已落入 Redis 的唤醒，在开始模型调用或动作前领取。断线发生在领取期间时，仍有效的唤醒写回待处理队列，重连后重新检查。已开始的仿真回合按实际动作回执结算，发送结果未知时跳过重发。OneBot WebSocket 没有事件确认与补投递协议，断线期间的事件由平台端决定是否送达。`simulation.enabled: false` 停用独立宿主的新消息处理和到期承诺。绑定文件热读取，连接、模型与 `agent-host.yaml` 设置在下次进程启动时读取。 [OneBot v11 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)

仿真和群文字分别按完整平台账号排队，好友私聊按完整会话地址排队，每个账号最多同时处理四段私聊。OneBot 普通收件保持顺序，撤回和明确的隐私命令有独立的优先队列。WebSocket 缓冲达到水位会背压，等待 OneBot API 应答期间仍会读取帧；超出有界收件容量和普通入队出错分别记录。一个账号的引用查询或收件重试不阻塞其他账号。升级后首次启动会在连接平台之前分批将旧仿真收件队列移入对应账号队列，沿用原收件回执、绑定版本和互动标识。迁移可以从已经提交的批次继续。

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

群仿真人物事实提取失败时保留游标，至少等待 60 秒后再尝试。智谱官方 `glm-5.3-flash` 人物事实提取使用关闭推理的请求参数，仍按来源核验后保存结构化结果。

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

检索评估使用[固定数据集的 Core 离线工具](../evals/semantic-retrieval.md)，运行同一读取入口并记录最终上下文中的证据。合成后端用于回归检查，真实模型质量需要另行离线评估；旧插件的自出题报告保留为旧方法历史。

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

工具在已绑定群仿真按原策略装配；普通文字群/好友私聊另须 `textGroups[].tools` / `privateChat.allowTools` 显式授权。`simulation.toolPolicy` 的全局与按群禁用、`legacy` 模式和显式追加规则继续生效；例如 `simulation.toolPolicy.denyTools: [searchInformationTool, webParserTool]` 可在 `open` 模式禁用两项工具。自主目标和承诺唤醒仍须经过原有自主执行权限检查。Core 在执行前、异步结果返回后及网页每次跳转前复核角色绑定、持久化活动版本和来源权限。换绑、撤回或停止会取消在途调用；其他进程的活动撤销在下一次授权复核时发现，已发出的请求无法保证撤回。

### GitHub 仓库查询

在 `agent-host.yaml` 显式启用公开仓库查询，然后重启。默认以匿名身份访问，不读取插件或部署机已有的 GitHub 凭据。可选 `tokenEnv` 仅用于提高 GitHub API 额度；声明后启动及 `--check` 都要求该环境变量存在，`--check` 不调用 GitHub。

```yaml
tools:
  github:
    enabled: true
    # tokenEnv: BL_AGENT_GITHUB_TOKEN
```

`githubRepoTool` 只接收 `https://github.com/owner/repository` 仓库根地址，可带 `.git` 或末尾斜线；不接受文件/issue 路径、查询参数、片段或 URL 凭据。工具固定读取 `api.github.com` 的公开仓库基本信息，以及最多 5 条最近提交、100 条分支样本和 5 位贡献者样本。可选请求未取得会明确标注；本页分支与贡献者不代表总数，开放 issues 数包含 PR。返回资料附来源与北京时间，不构成指令或事实核实。

工具在群仿真沿现有策略和真人执行权限装配，普通文字群/好友私聊须另有会话工具名单授权；不扩展自主执行能力。可通过 `simulation.toolPolicy.denyTools: [githubRepoTool]` 禁用；移除配置或设 `enabled: false` 并重启也可停用。每次实际 GET 前后复核来源和当前绑定，取消或任一次授权拒绝停止后续请求。总期限 15 秒、每个响应最多 1 MiB，无自动重试、重定向或跨域凭据传递；只将仓库标识和可选 GitHub 鉴权送到固定 API，不附聊天历史、QQ 身份或其他服务凭据。输入及完整成功响应检查已知宿主秘密，错误正文不进入日志或模型。

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

群仿真及另获会话工具名单授权的普通文字群/好友私聊均服从真人主体和普通工具策略，不扩展自主工具面。设 `tools.modrinth.enabled: false` 并重启，或用 `simulation.toolPolicy.denyTools: [modrinthTool]` 停用。

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

两者默认关闭，工具名沿用 `textImageTool` 与 `aiMindMapTool`，群仿真按原工具策略装配，普通文字群/好友私聊须另有会话工具名单授权，不扩大自主或承诺工具面。文字图片不调用模型；思维导图仅向显式后端发送本次 `prompt` 和固定排版要求，不读取旧插件 YAML、不继承主模型；有效 token 用量记入当前会话账本。预检校验配置与凭据，不调用模型或启动浏览器。移除配置并重启可停用。

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

默认关闭。群仿真真人回合按原工具策略提供显式 `fileTextTool`；公开宿主从 `bl-chat-agent/files` 导入 `createAgentFileTextTool`。复用上节同一 `readFile` 来源选择、撤回/隐私/绑定复核及临时资料隔离，不自动读取文件入站；普通文字群/好友私聊另须会话工具名单授权，群目录端口仍只授予群会话。Excel 单元格与公式查询仍用 `excelWorkbookTool`；通用文件工具只返回文档文本。

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

交付账本按完整账号、会话、绑定版本及本次入口消息去重，7天TTL，每个阶段先保存pending再派发。账本只保留有界状态和有效回执，不保存原始分享、音频或模型参数。相同入口并发或重启重读不重复派发；重启遇到未完成领取或pending会冻结为unknown，不自动继续或重发。平台确认后本地结算失败也停止后续步骤。这是有限保留期内的尝试防重，不是跨系统exactly-once或自动恢复送达保证。本节功能的构建、工程与安装包验收状态以[项目当前状态](../project-status.md)为准，阶段证据见[历史记录](agent-bindings-history.md)。

### 完整媒体搬运的资源与有序计划合同

`bl-chat-agent/media-relay` 提供可信宿主的 `createAgentMediaArtifactStore`、`validateAgentMediaArtifact`、`validateAgentMediaRelayPlan` 和 `createAgentBilibiliRelayProvider`。主入口导出中立资源、计划、`AgentMediaShare`、准备提供器、`AgentMediaRelayConfig`、`MediaShareReadOptions` 及 `SendMediaRelayAction` 类型；子入口另导出仓库、B站提供器及其可信宿主选项。搬运业务由Core持有，渠道负责来源协议解码和中立计划的原生转换。它是显式启用的确定性群分享流程，不注册模型工具；工程与安装包验证状态见[项目当前状态](../project-status.md)，各阶段证据见[历史记录](agent-bindings-history.md)。

宿主先指定已有受控父目录创建仓库，再将 `AsyncIterable<Uint8Array>` 流式stage。仓库自行创建0700随机子目录，文件写入为0600、完成后0400；返回的租约只有随机资源ID、kind/MIME、真实sizeBytes和SHA256，没有路径、URL或base64。单视频512MiB、单图32MiB，默认全仓16GiB/128资源，可通过 `maxTotalBytes/maxArtifacts` 缩短；内部写入和读取块最多1MiB，不要求完整文件进内存。支持MP4/QuickTime/WebM/FLV和PNG/JPEG/GIF/WebP/AVIF/BMP真实容器头，不把签名验证当作解码或播放证明。

`lease.retain()` 为预热、发送或后续重试保留同一资源；各owner最终等待 `release()`。资源端口 `open(artifact, context)` 仅核准本仓有效完整元数据，返回只能消费一次的chunks和幂等close，先验证真实文件身份及完整hash，再按块复核授权和内容。最后租约、仓库关闭、signal或失效current会停止后续读取；宿主必须提供绑定/来源及隐私复核的context，单有资源ID不授予读取会话资料的权限。仓库close等待并清理自己的临时目录，不扫描或删除邻居；独立宿主的实例租约与精确owner标记负责崩溃遗留清理，见下文。

计划保留有序文字、图像、视频和可选图像缩略图，冻结自有快照并拒绝原生作者、目标、路径、URL或其他额外字段。同ID元数据须一致；最多128节点/512部分，文字单项64000Unicode字、总256000字，不同资源总16GiB，宿主可传入allowsText执行当前出站规则。超出明确拒绝，不静默截页或拆发。该合同独立于原12MiB通用bundle与30MiB sendVideo，尚不证明QQ平台可发送512MiB混合视频。验收状态见[项目当前状态](../project-status.md)。

### QQ媒体资源桥与原生交付

可信宿主从 `bl-chat-agent/qq` 导入 `openQqMediaRelayBridge`、`createQqMediaRelayDeliveryPort` 及桥类型。桥选项必须显式给出受控 `directory`、`resources`、字面IP/端口的 `listen`、无路径的 `advertisedOrigin` 和1至32个精确IP的 `allowedPeers`。端口0仅供自动分配，公布origin中的端口0会替换为实际监听端口。HTTP公布地址只接受RFC1918、回环与IPv6 ULA；公网/其他域名须HTTPS并由宿主反向代理提供TLS。ACL只认socket对端、不信任转发头；代理、可信网络与NapCat可达性由宿主装配。

`bridge.stage(artifact, context)` 先经原资源端口读取，流式复制到独立私有仓库并完整复核kind/MIME/size/SHA256，才返回适配器内部的 `nativeUrl/release()`。随机256bit资源URL最长90分钟，仅GET/HEAD，无Range，单URL32次请求、GET预留最多8倍完整资源字节；每块最多1MiB并等待背压。释放、失效、deadline或close撤销URL、关闭在途连接、等待清理自有副本。不得把URL写入模型、持久状态或日志。

这是可信宿主的底层端口；宿主须先执行完整出站净化和来源/隐私授权，并以allowsText持续复核文字，模型不直接获得该端口。在 `OneBotEndpoint.mediaRelay: { bridge, allowsText? }` 注入后，连接才提供 `actions.sendMediaRelay`；不注入时不装配。动作 `kind: 'media-relay.send'` 使用固定账号/会话、可选绑定快照、`mode: 'forward' | 'direct-video'` 和中立plan。forward保留所有节点与部分顺序，作者统一机器人；direct-video仅允许视频并单次发送全部视频。QQ两种模式均要求视频缩略图，缺失明确拒绝。不同artifact每次只stage一次；每connection完整准备及发送串行，最多4个等待，入口捕获原socket，排队/复制期间重连后旧任务不能使用新连接。

完整调用独立采用最多90分钟有限期限，既有media/bundle期限保持原值。真正message_id和可选账号/目标一致才sent；schema400/1400及唯一精确的发送前资源预处理AggregateError是failed，其他handler1200/超时/断线/无效回执是unknown。端口自身零重试、零降级，finally释放全部桥租约。平台100MiB混合限制、整文件缓冲和上传时限须真实部署重新核验；字节传输工程验证不能代替QQ投递和客户端播放验收。

### Core自动媒体搬运与持久投递

`createAgentRuntime` 通过 `mediaRelay: { enabled: true }` 和可信宿主提供的 `mediaRelayProvider` 显式启用；缺提供器直接拒绝构造。省略 `providers` 保留原B站启用边界，抖音须显式给出 `providers: ['bilibili', 'douyin']`（也可只选抖音）。默认关闭时不读写媒体队列、不下载或启动桥。流程先于文字/仿真模型和历史采集处理真实群来源，私聊不自动搬运。QQ来源端口只回传完整地址、原作者/时间及闭合BV/b23/EP或抖音video/note/short引用；原生JSON、下载地址和凭据不进入Core队列。固定账号/socket的get_msg及每次副作用前均重新核验来源，撤回、隐私删除、换绑、停用、宿主租约丢失取消后续操作和迟到资源。提供器页面须与来源provider一致，直接作品ID一致；短链允许解析成同provider的规范作品页。

媒体准备失败达到重试上限后，在原会话用固定说明和原作品链接结束本次任务。回退仍走相同的发送队列和来源核验。每次失败只记录一次，抖音只取得部分媒体或作品页时另有固定降级码。

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

以root运行Core并使用专用Chromium启动器时，抖音复用Puppeteer创建的空临时profile。启动器在交给浏览器用户前写入禁用非代理WebRTC UDP的固定偏好，浏览器退出时由Puppeteer清理。发布包的启动器使用LF换行，部署时确认该文件具有Linux执行权限。

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

中立计划保留信息、独立全文、原作品媒体顺序。全文最多2000Unicode代码点；主视频限1800秒/256MiB、10分钟下载。图集保留20槽护栏，每图32MiB/60秒，超限和失败位置明确说明。实况照片按原槽优先视频，成功替换该槽静态图，失败退回该槽图片，修正旧静态与实况分组拼装造成的乱序。图片先用原始签名URL，失败才按受限fileID重建unsigned候选；图文的实况视频不能成为主视频。静态、浏览器state与DOM都限定原笔记身份，不使用推荐作品或QQ卡标题/封面填充官方内容。媒体、转换、缩略图及资源lease共用取消生命周期；缺缩略图仍保留完整中立视频，再由QQ的兼容要求进入链接回退。默认关闭与unknown不重发规则不变。工程和真实平台验收状态以[项目当前状态](../project-status.md)为准，阶段证据见[历史记录](agent-bindings-history.md)。

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

计划保留标题、频道、时长、统计、简介及可用封面。封面8MiB/15秒；非直播且已确认时长不超过30分钟时，尝试选定的同时包含音视频的单文件MP4，最多512MiB/10分钟，不以视频单轨、音频单轨或合并计划替代。CDN只允许受限ytimg图片及googlevideo视频，下载逐跳核验DNS，不传宿主Cookie或任意返回header；部分响应、长度不全和压缩体不能作为完整资源。封面失败保留视频，视频失败保留信息、封面及规范页面；缩略图失败仍保留完整中立视频，由QQ要求决定链接回退。来源撤回、换绑、隐私、停用及宿主租约失效取消后续请求和迟到资源；既有v1去重、pending及unknown不重发规则不变。工程和真实外部验收状态以[项目当前状态](../project-status.md)为准，阶段证据见[历史记录](agent-bindings-history.md)。

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

可选Cookie仅发给原作品固定详情/分页端点，重定向不可换端点，不发CDN；可选HTTP(S)/SOCKS代理仅来自显式环境变量。每跳官方目标、全部DNS公网及实际连接地址均核验，媒体流有完整长度、期限、预算及跨块凭据检查。资源只通过不透明租约进入计划，撤回、换绑、隐私、停用和丢租约取消后续请求与迟到资源；既有v1来源防重和pending/unknown冻结不变。自动搬运不调用模型、不自动处理私聊；模型显式搜索及五分钟选图见下节。工程与真实外部验收以[项目当前状态](../project-status.md)为准，阶段证据见[历史记录](agent-bindings-history.md)。

### Core Pixiv搜索与选图下载

`pixivSearchTool`和`pixivDownloadTool`由主模型针对当前真人请求选择，保留原工具策略；普通文字群/好友私聊另须会话工具名单授权，实际媒体交付仍需对应平台端口，不扩大自主或承诺工具面。搜索、热门与画师识别、列表绘制、五分钟选择、下载和中立计划归Core，QQ只转换当前账号/群的图片卡及完整合并转发。独立公共入口为`bl-chat-agent/pixiv`。

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

B站搜索与视频卡片的阶段验证见[历史记录](agent-bindings-history.md#video-search-verification)；当前部署与验收范围见[项目当前状态](../project-status.md)。

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

该功能的阶段验证见[历史记录](agent-bindings-history.md#video-attachments-verification)；当前交付和待验收范围见[项目当前状态](../project-status.md)。

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

该功能的阶段验证见[历史记录](agent-bindings-history.md#bilibili-quality-verification)；当前交付和待验收范围见[项目当前状态](../project-status.md)。

集成修复保留命令原文（含首尾空格）作SHA256和完整来源复核；团录AI静默仍可处理真人高清/授权命令，后续团录状态恢复不取消合法扫码，但撤回、隐私、换绑等仍取消。好友来源每次在同一已认证socket重新确认好友列表，兼容标准get_msg缺少sub_type，显式TEMP/非好友拒绝。资源释放、HTTP流关闭、缩略图/临时文件清理、轮询、模型说明及账本回执失败均有固定阶段和脱敏错误码；失败说明附同源查询编号，模型不可用改用短服务异常提示。原生派发后账本写入失败按未知冻结，不通过错误说明触发额外发送。真实平台与模型的验收范围见[项目当前状态](../project-status.md)。

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

旧团录只有裸群号、缺账号及Agent来源，不自动认领；旧骰子结果及规则事件还须独立可验证producer来源，不能伪造真人消息ID或把交付基础当作骰子业务迁移完成。

该功能的阶段验证见[历史记录](agent-bindings-history.md#group-log-verification)；当前交付和待验收范围见[项目当前状态](../project-status.md)。

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

外部宿主可从`bl-chat-agent/video-analysis`导入`createAgentVideoAnalysisTool`及配置/验证函数，主入口导出`AgentVideoInput`、`AgentMessageVideo`和`MessageVideoReadOptions`；自定义适配器实现`readMessageVideo`并遵守Core提供的来源、取消与inspectOnly合同。工程与真实QQ/服务/模型验收范围见[项目当前状态](../project-status.md)。

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

配置中的群在被 `@` 或收到对当前账号已确认回复的引用时，生成一条引用当前消息的文字回复。模型收到当前文字、角色人设、同一群友的近期已确认收发，以及最多四条适用于当前群的结构化人物事实。每个会话保留最多 6 轮，最后一次确认后 1 小时过期。命令、附件字节和群友引用的原文不直接进入文字历史；显式授权工具可在当前回合按原消息重新核验后读取来源。回复检查当前绑定、引用来源、文本规则及投递回执。换绑或保存宿主配置后，旧的文字收件和上下文停止使用。

群文字模式期间暂停本群仿真唤醒，仿真状态继续保存在原会话分区。原有定时文字承诺可继续按原归属投递，依赖仿真唤醒的承诺须由仿真模式执行。群消息撤回同时清除该群文字上下文，并使仍在生成的旧回复失效。文字回合使用与仿真相同的 YAML 预算配置和 Redis 群级覆盖，对同群文字模型调用施加 `simulation.turn.minSendGapMs` 间隔。迁移后的文字回合次数单独记账，模型金额与同一会话的仿真共用账本。要停用当前会话的模型处理，可移除该会话的角色绑定。

群文字工具按会话配置。省略 `tools` 时该群只提供文字回复。以下配置启用固定文字提醒和委托记忆。

```yaml
textGroups:
  - connectionId: qq-main
    conversationId: '111111'
    tools: [commitmentTool, delegateMemoryTool]
```

`commitmentTool` 支持一次性或每天的固定文字提醒，以及查看、取消和续期本人登记的提醒。调度使用北京时间，到点在原群点名创建人。`delegateMemoryTool` 保存本条消息里的原话并支持本人查询、删除。两项工具均复用独立宿主的既有账本，按原账号、会话及角色定位记录。这两项账本工具每回合最多执行一项，账号、群和发言者由入站事件确定；下述通用查询工具使用各自有界续轮。

工具确认由本地执行结果生成并直接回复群里。工具正文不加入后续模型上下文。写入前先持久化尝试标记。进程在执行后、发送前退出时，可在原绑定下恢复已落盘的确认，只有尝试标记时保留结果未知，不自动补执行或另发待核实通知。恢复期间不会再次执行该工具。撤回或换绑使未发送的旧回复失效。已经提交的托付和记忆由原账本管理，用户可通过相应工具取消或删除。

通用工具同样在 `textGroups[].tools` 中逐名授权，再与实际注册表及 `simulation.toolPolicy` / `simulation.extraTools` 取交集；deny 优先，自定义 `mcp_...` 别名还须原策略显式放通。已支持搜索/网页、表情/Bing 找图、本地表情、图片生成编辑、文字图片/思维导图、Excel/文件只读、音乐/语音、GitHub/Modrinth、Pixiv、三角洲和群视频分析。配置某名称不会自动创建提供器或读取旧插件凭据，群文件目录及群视频端口仍只授予群会话。

通用查询每回合最多三轮，执行前先取得原持久动作槽；一次媒体成功即结束，不再追加确认文字。文字结果及其派生回复不写入后续文字历史、人物学习、情节或工具结果回执。复用群仿真的 schema 校验、动态定义撤销、取消、秘密检查和 unknown 封口；每次外部请求、来源读取及排队发送均复核完整账号、会话、Agent、真人与原消息。敏感 QQ 动作和群成员管理继续走既有专门入口及权限。

### 启用好友私聊

在 `agent-host.yaml` 增加以下设置，然后重启独立进程。私聊默认关闭。示例中的 `qq-secondary` 也需要在独立宿主的 `connections` 中配置对应的 OneBot 连接，或者将私聊绑定指向独立宿主已经配置的账号。

```yaml
privateChat:
  enabled: true
```

好友准入由 `agent-bindings.yaml` 中 `kind: private` 的会话声明。处理 OneBot 上报的好友文字。临时会话不参与，`#` 命令仅接收下述本人记忆操作。附件字节及引用原文不随私聊文字入队；已显式授权的工具可按当前或引用原消息重新核验读取。模型请求使用当前角色人设、好友文字、同一会话的近期对话和最多四条本好友在本会话自述的结构化事实。回复通过 OneBot `send_private_msg` 发给原好友。 [OneBot v11 私聊事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md#私聊消息) [OneBot v11 私聊发送](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#send_private_msg-发送私聊消息)

近期对话按完整会话地址、角色绑定版本、人设版本及人物记忆失效水位核对，每段最多保留 6 轮已确认收发，最后一次确认后 1 小时过期。好友撤回会清空该会话的近期上下文，让匹配的结构化事实及尚未发送的旧回复失效。直接召回结果只进入本轮模型请求。私聊按完整地址排队，同会话保序，不同会话在账号内可并行。旧账号队列的待处理项在平台连接前按会话迁移，原收件回执与消息内容保持一致。换绑使已排队的旧消息和未发送的旧回复失效。重启后可处理仍在有效期内且尚未尝试发送的收件。已有投递尝试的收件按去重记录跳过重发。迁入的一次性提醒支持到期投递和本人查看、取消，工具结果直接返回当前好友会话。 [OneBot v11 好友消息撤回](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md#好友消息撤回)

私聊通用工具通过 `privateChat.allowTools` 显式列名，缺省为 `[]`；仍与已装配提供器和原工具策略取交集，继承上述临时资料和撤权边界。群专有成员、目录、视频或 QQ 敏感端口不会因列名而授予好友。冻结旧私聊 `allowTools` 为空，旧 `allowEmojiTool: true` 是独立的旧入口开关，不据此把所有工具开放给好友；当前生产维持原空名单。

### 本人记忆管理

显式绑定的仿真群、文字群和已启用的好友私聊接受 `#清空我的记忆`、`#禁用我的记忆` 和 `#启用我的记忆`。发送不带点名、引用或附件的完整命令，首次入队要求平台发送时间在一小时以内。群内调整本人在当前群的记忆，好友私聊调整当前接收账号和角色下本人在所有场景的记忆。重新启用从新资料开始，已失效的来源继续不可用。局部启用继续遵守私聊设置的全场景限制。命令在本地执行并回复原会话，命令文字和固定确认不进入模型上下文。同账号的新模型回合等隐私操作处理完成后读取记忆，正在处理的相关角色回合停止后续调用及投递。独立宿主管理的是本实例已接续及之后产生的人物记忆。

### 独立控制台

独立发布包包含控制台前端和宿主内置 HTTP 服务，无需启动 Yunzai 或单独执行 `console:start`。在 `agent-host.yaml` 中显式开启：

```yaml
console:
  enabled: true
  host: 127.0.0.1
  port: 8787
  allowSetup: true
```

```sh
node scripts/start-agent.mjs --config /path/to/agent-host.yaml
```

此配置在 `http://127.0.0.1:8787` 提供控制台，首次访问可创建用户名和密码，之后通过登录会话访问。`allowSetup` 默认关闭，且只允许回环监听地址；已有用户时不能再次初始化。用户文件默认位于 `dataDir` 下的 `console/users.json`。可用 `legacyUserFile` 指定兼容格式的旧用户文件，仅在目标用户文件不存在时导入，源文件保留。

`tokenEnv` 可选，值为环境变量名；配置后正常启动要求该变量有值。令牌可通过 `X-Console-Token` 请求头认证，也可在尚无用户时授权首次创建用户。`host` 默认 `127.0.0.1`，`port` 默认 `8787`；`frontendDir` 默认使用包内前端，`userFile`、`legacyUserFile` 和自定义 `frontendDir` 的相对路径以宿主配置目录为基准。

控制台通过候选预览和事务提交宿主配置、人设库及绑定文件。实际保存变更后，已加载版本与已保存版本分别记录，当前执行实例退休，须真实重启 Agent 才会加载新配置；启动器不会自动重启。退休期间仍可认证读取工作区、配置状态和运行观测，其他业务操作等待新进程。提交结果未知时先检查事务状态，停止宿主后再离线恢复：

```sh
node scripts/start-agent.mjs --config /path/to/agent-host.yaml --inspect-config-transaction
node scripts/start-agent.mjs --config /path/to/agent-host.yaml --recover-config
```

两条命令须分别运行，也不能与 `--check` 或迁移参数混用；它们不启动 QQ、Redis 或模型。无有效 commit 时恢复旧配置，有有效 commit 时完成新配置；损坏记录或未知文件身份会保留现场并拒绝覆盖。正常启动不会抢残留锁，不应通过删除锁或事务文件绕过恢复。恢复后再正常启动宿主。

### 统一认知

`cognition: { enabled: true }` 显式启用 Core 内的统一认知，省略时默认关闭。同一 Agent 的普通自我偏好按来源规则跨群和私聊延续，真人事实仍受完整来源场景限制；低频整理复用仿真反思调度及预算，没有新增第三方记忆服务、模型渠道或凭据。关闭后停止新认知读写并保留状态。

新状态位于现有实例前缀的 `agent:cognition:v1:<agentId>`。`scripts/import-cognition.mjs` 只处理显式映射后的离线来源 JSON，不读取旧 Redis 或连接生产。认知失效会撤销来源和依赖的可读性，节点历史并非全部物理擦除；现有遗忘分区回执不能替代认知物删证明。实现及待验收项见[统一认知方案第 14 节](ai-brain-construction-2026-11-17.md#14-2026-11-18-首版实现与交接)。

## 核心与平台接入

`src/core/agentRuntime.ts` 是独立核心的装配入口。它接收存储、模型及平台连接端口，负责绑定校验、收件、回复和定时承诺。现有 QQ 插件与独立核心共用角色解析、仿真、记忆和承诺模块。`npm run test:boundaries` 检查核心及其内部依赖，阻止对平台适配器、启动层和 Yunzai 宿主的反向依赖。

当前实现 QQ。启动层读取 QQ 配置并创建 OneBot 连接。平台连接通过 `PlatformConnectionAdapter` 提交标准消息、撤回和面向账号的互动事件，通过 `MessageActionPort` 发送。适配器可选实现 `readMessage` 读取明确引用的原消息、`readForward` 展开已核验的转发、`readMessageImages` 读取已核验的消息附图。核心按账号、会话和绑定版本校验。QQ ID、连接协议、消息段转换和图片下载归 QQ 适配器处理。

仿真只向模型声明当前宿主已经实现且当前会话可用的工具。视频卡片按实际提供器与投递端口声明；戳一戳按互动开关、当前连接能力及原有每小时配额声明。空间互动、表情收藏和生活线等未接入能力不会因账号属于 QQ 而自动出现。群成员、转发、附图及情绪更新按实际读取和更新端口提供，角色记忆、收尾与已接通的作息状态继续可用。Yunzai 注入对应实现后保留这些能力，实际执行仍复核原有绑定和权限。

独立宿主按显式配置装配工具、记忆、群文字调度、骰子与内置 HTTP 控制台。是否可用还取决于当前连接的端口和会话权限；群文字、仿真真人与自主回合分别核验授权。控制台服务包含在独立发布包中，复用 Vue 前端，不依赖 Yunzai 服务；插件模式继续使用原入口。具体配置见前文各功能小节及[控制台说明](../../console/README.md)，已部署、已验证和未接续范围见[项目当前状态](../project-status.md)。

私聊适配器可以通过 `resolvePrivatePeer` 提供当前会话经过核验的对话者 ID。这个 ID 可与会话 ID 独立，两者共同决定私聊可用的历史和人物记忆。QQ 的好友会话 ID 就是对方 QQ 号，沿用现有键和提醒记录格式。

Core 校验入站消息的账号、发言者命名空间和绑定，附带引文只保留待核对的消息 ID。发送封装携带当前会话的绑定，适配器须在实际投递前调用 `isCurrent`。会话撤回会撤销尚在等待投递的回复许可。有效平台消息 ID 才能确认送达，连接确认前发生异常或收到不完整回执时使用未知结果。频道和话题可由适配器提供自己的成员 ID，QQ 群的点名参数继续校验 QQ 号。

安装独立包后，宿主代码可从 `bl-chat-agent` 导入 `createAgentRuntime`、`createAgentBindingDirectory` 和平台端口的 TypeScript 声明，从 `bl-chat-agent/qq` 导入 `createOneBotConnection`。Core 由宿主注入存储和模型接口，QQ 适配器接收账号、连接地址和鉴权配置。

自定义模型端口的签名为 `YTapi(request, config, signal?, isCurrent?, ensureCurrent?)`。宿主必须在每一次实际提供方请求前等待 `ensureCurrent?.()`，包括参数兼容重试、工具规划器或文字渠道的降级；随后再次检查取消信号和同步 `isCurrent?.()`。异步复核拒绝后停止整个调用，不继续尝试其他后端。此复核会重新检查持久来源、隐私和当前平台访问权限；只在最初调用时检查不足以授权重试。`reviewCharacter`、`reflectCharacter` 和 `judgeSocialPermission` 同样接收第五个异步复核参数。独立 QQ 宿主和旧插件仿真已接通这些检查。

`createAgentRuntime` 接受可选的 `toolRegistry`，类型 `AgentToolRegistry` 从 `bl-chat-agent` 导出。工具接收当前绑定、执行主体、取消信号和复核方法，不接收原生 QQ 事件。实现须在每次外部请求或副作用前检查 `isCurrent()` 并等待 `ensureCurrent?.()`，同时遵守取消信号；Core 始终提供异步复核，完成后上下文立即失效。宿主可从 `bl-chat-agent/web` 导入 `createAgentWebTools`，按搜索和网页配置构建内置工具注册表；内置工具沿用普通工具策略，自定义注册项仍须显式放通且只允许真实用户触发。此注册表接入群仿真；普通文字群/好友私聊仅接入显式会话名单、实际注册表及原工具策略共同允许的通用子集，来源端口与群专有能力继续分别授权。

Core 执行工具前校验模型提交的有界 JSON 对象。宿主注册工具沿用每次调用 16,000 个序列化字符的上限。`parameters` 是工具的 JSON Schema，建议用 `required`、`additionalProperties` 和嵌套规则描述输入。对模型协议必须简化 Schema 的提供方可另设 `inputSchema` 作为执行定义，MCP 使用发现时的原始版本。调用中的 JSON、参数类型或约束出错会在进入工具和登记动作尝试之前被拒绝。群文字与私聊仍沿用各自已有的工具名单。延期动作还须通过定义版本、原请求和延期委托的复核。 独立宿主在一次同步授权中复用配置快照，跨异步步骤使用各执行路径的实时复核。

`AgentTool.effect` 可以声明动作所需的 `actor`、`conversation`、`required`、`optional` 和 `metadata`。声明函数根据已校验参数和会话类型选择权限，不执行外部请求。例如 `excelWorkbookTool` 列出群文件时需要 `listFiles`，读取工作簿时需要 `readFile`。缺少必要端口或不满足主体要求时，工具实现不会运行。读取上传文件、历史等临时资料应声明 `dataPolicy: 'ephemeral'`，按现有来源权限提供读取端口并阻止资料进入持久记录。已接入的可信宿主扩展可以继续使用省略 `effect` 的旧接口，新实现应声明实际所需权限。

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
