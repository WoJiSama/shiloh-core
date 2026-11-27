# 钉钉接入与 Core 仓库知识库实施方案

2026-11-27 · Core 实现与试点配置 · 首个项目为 Chaos

**一个代码仓库在 Core 中只有一份库记忆。** 管理员把仓库接入钉钉群或 QQ 群后，该会话立即获得已授权、已建好的库记忆。后加入的渠道可以直接回答问题，无需重新阅读整库。人设决定回答口吻，会话记忆空间决定它能接上哪些聊天，仓库绑定决定它能引用哪些项目资料。

开发工作放在希洛，Chaos 提供首批试点源码。若后续支持查询客户环境当前运行的版本，可再接公司授权的发布记录接口。

## 试点配置

保留现有 Redis 和模型设置。在钉钉开放平台配置企业机器人 Stream 回调、群内发送权限，并把机器人添加到试点群。私聊还需宿主启用 `privateChat.enabled`。用运行 Core 的系统账号预先配置云效只读凭据和 SSH 主机验证。

### 账号和会话

「连接 → 新增钉钉连接」可以登记企业、机器人和试点群。填写实际的 Robot Code、企业 Corp ID 和群的 Open Conversation ID。应用凭据由运行环境提供。保存后重新装配连接，日常回复规则可直接保存生效。

首次用配置包建库时，也可在 `host.connections` 声明 Stream 连接，在对应的 `bindings.connections` 和 `bindings.bindings` 登记账号和会话。两个连接条目须使用同一 ID。项目知识的启用项属于 `host.projectKnowledge`。 [独立 Core 配置库](agent-bindings.md#独立-core-配置库)

```json
{
  "connections": [
    {
      "id": "dingtalk-work",
      "transport": "dingtalk-stream",
      "name": "Chaos 答疑",
      "clientIdEnv": "DINGTALK_CLIENT_ID",
      "clientSecretEnv": "DINGTALK_CLIENT_SECRET"
    }
  ],
  "projectKnowledge": {
    "enabled": true,
    "allowModel": true,
    "syncIntervalSeconds": 300
  }
}
```

`allowModel` 允许已选源码片段交给宿主配置的模型。重启后打开「项目知识库」，登记两个云效仓库。Chaos 试点可选后端的 `web`、`biz`、`common/service/integration`、`skills/chaos/references`，以及前端的 `src`、`skills/chaos-web/references`。创建 Chaos 项目并授权给试点群。界面显示当前同步版本、仓库概览和已有库记忆数量。

配置也支持用 `projectKnowledge.catalog` 提供初始目录。仓库含 `id`、`remote`、`branch`、`paths`，项目含 `id`、`name`、`repositories`，授权含 `target`、`projectId`、`repositories`。控制台保存过的目录由 Core 数据目录下的 `repositories/catalog.json` 接续。

### 钉钉回复规则

在「连接 → 对应钉钉连接 → 回复规则」选择私聊和群聊、只回私聊或只回群聊。点击「保存规则」后，该账号立即使用新规则。页面配置保存到 Core 的 Redis，重启后继续沿用。启用私聊回复还需在宿主设置 `privateChat.enabled: true`，并绑定成员私聊。宿主私聊开关也影响已绑定的 QQ 私聊。

成员名单使用钉钉 Staff ID，群名单使用 Open Conversation ID。非空白名单只放行名单中的对象，空白名单允许该项通过。黑名单优先。群消息需要发送人和所在群同时通过名单，所有回复都要求对应会话已绑定。

配置包的钉钉连接条目支持初始 `replyPolicy`。同一账号已有页面设置时优先使用已保存的规则。可在页面选「只回群聊」，设置成员与群聊白名单，并开启「群聊只回复 @ 本机器人」。

省略规则时 `mode` 默认为 `both`，群消息须有钉钉回调的 @ 标记，四个名单默认为空。关闭 `requireMention` 后，已绑定群中钉钉实际投递的普通文字也可触发答疑。标准企业机器人 Stream 通常接收被 @ 的群消息和私聊，普通群消息能否收到取决于钉钉实际开通的事件投递范围。[官方机器人说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/0d2f0ffecc56f3f9f2a31e70612ef9d11d70e98e/docs/robot-quickstart.md)

### 会话记忆空间

在「连接 → 人设与记忆空间」分配空间并选择可以共享笔记的群。群里 @ 机器人后发 `#记到共享空间 文字`，会提炼并保存可共享笔记。要让同一人换账号后接着聊，在配置包的 `host.memorySpaces` 登记实名映射。两个账号及相应私聊都须已有绑定，且两个账号的 `memorySpaceId` 一致。

```json
{
  "memorySpaces": [
    {
      "id": "engineering",
      "groups": [{ "connectionId": "dingtalk-work", "conversationId": "cid-example" }],
      "privateUsers": [
        {
          "id": "verified-person",
          "aliases": [
            { "connectionId": "dingtalk-work", "conversationId": "dingtalk-staff-id" },
            { "connectionId": "qq-work", "conversationId": "123456789" }
          ]
        }
      ]
    }
  ]
}
```

笔记保存 90 天，闲聊中识别的未完话题保存 48 小时。来源同时接受现有的撤回和本人记忆禁用检查。

### 钉钉 MCP

在 Core 的运行账号下安装 DWS，并用对应钉钉成员的 profile 完成授权。先运行 `dws auth status --readonly --profile <profile> --format json` 核对企业和成员，再用 `dws mcp published tools <mcpId> --profile <profile> --format json` 核对工具及参数定义。在配置包的 `host.dingtalkMcp` 填入实际选择的只读工具和固定资料参数。

```json
{
  "dingtalkMcp": {
    "enabled": true,
    "grants": [
      {
        "connectionId": "dingtalk-work",
        "kind": "group",
        "conversationId": "cid-example",
        "userId": "dingtalk-staff-id",
        "profile": "approved-profile",
        "mcpId": "42",
        "tool": "read_document",
        "label": "读取研发群已授权的项目手册",
        "readOnly": true,
        "fixed": { "documentId": "approved-document-id" },
        "resultFields": ["title", "content"]
      }
    ]
  }
}
```

以上 MCP 工具名、参数名和输出字段是占位示例。可选的 `command` 用于指定已安装的 DWS 可执行文件，`configDir` 用于选择已授权的 DWS 配置目录。本人私聊可另加 `queryParameter`，群聊按固定资料读取。连接异常时仓库问答照常工作。

## 用户怎么用

1. 在控制台登记项目「Chaos」，加入云效后端仓库 `chaos` 和前端仓库 `chaos_web`，分别选择跟踪分支。Core 首次同步后给出项目概览、各仓库的提交版本和可用状态。
2. 把两个仓库绑定到一个公司钉钉研发群。成员可以直接问「新建迭代为什么看不到研发自测？」。机器人给出业务结论，附上对应版本的依据。询问具体环境时，再核对该环境的发布版本和配置。
3. 把同样的仓库绑定到一个 QQ 研发群。即使 QQ 用希洛人设、钉钉选「无人设」、两个账号各用独立的会话记忆空间，QQ 也能读到钉钉提问时已核实并写入的库记忆。微信将来接入后沿用同一套绑定。

| 试点配置举例 | 账号人设 | 会话记忆空间 | 该会话可读的仓库 |
| --- | --- | --- | --- |
| 钉钉研发群 | 无，使用通用助手 | 钉钉工作 | `chaos`、`chaos_web` |
| QQ 研发群 | 希洛 | QQ 研发 | `chaos`、`chaos_web` |
| 另一个钉钉账号的协作群 | 工作助理 | QQ 研发 | 仅 `chaos_web` |

第三个群可以查前端如何展示选项。需要同时读取前端和后端才能下的结论，只发到获准使用两仓的会话。会话记忆空间负责可共享的长期记忆和未完话题，私聊原文按原会话的可见范围处理。

账号的人设设置区分「继承现有绑定」「无」「指定模板」。现有 QQ 配置缺少新字段时沿用原规则和原记忆分区。「无」保留稳定的运行角色 ID，以通用助手口吻服务。新账号默认使用独享会话记忆空间，管理员可以选择已有空间。调整人设或会话记忆空间时，仓库知识仍按仓库绑定读取。

## 钉钉消息与 MCP 接入

| 链路 | 实施方式 | 交付结果 |
| --- | --- | --- |
| 钉钉成员向机器人提问 | 企业机器人通过 Stream 接收群内 @，适配为 Core 的 `IncomingMessage` | Core 得到经过平台确认的企业、机器人账号、会话、发送人和消息 ID，并能向原会话回复 |
| Core 调用钉钉 MCP | 通过当前企业授权的已发布 MCP 发现并调用选定工具 | 真人提问时可以使用获准的钉钉能力，例如读取一份已授权给试点群的项目文档 |
| Core 回答代码问题 | 从当前会话绑定的仓库读取库记忆和固定提交的源码 | 同一套问答可供钉钉、QQ 和后续渠道使用 |

### 企业机器人收发消息

先用 `dws dev connect` 在试点群验证 @ 和回复。正式接入使用机器人 Stream 回调，将企业映射到平台命名空间，将机器人、会话、发送人分别映射到 Core 身份。官方自定义命令桥主要把问题作为命令参数交给本地程序，仓库授权需要的会话和身份信息应直接取自回调。Core 宿主还需将当前的 QQ 专用连接校验和创建逻辑扩展为按平台创建适配器。[官方机器人说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/0d2f0ffecc56f3f9f2a31e70612ef9d11d70e98e/docs/robot-quickstart.md) · [Stream 回调实现](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/0d2f0ffecc56f3f9f2a31e70612ef9d11d70e98e/internal/helpers/connect_stream.go) · [Core 平台连接接口](../../src/contracts/platformConnection.ts)

入站按企业、机器人、会话、消息 ID 去重。符合回复规则的消息经 Core 持久化受理后向 Stream 确认，再异步检索。过滤的回调直接确认，无需写入 Core 收件箱。回复经过 Core 现有出站检查，使用原会话的有效回复凭据或已授权发送接口。平台能提供可核验消息 ID 时记录送达，明确拒绝时记录失败，超时或仅有无法核验的回执时记录结果未知，停止自动补发。[Core 投递回执](../../src/contracts/delivery.ts)

### Core 调用已发布的钉钉 MCP 工具

首版建议在 Core 现有 MCP 客户端下配置一个本地 stdio 适配器，由钉钉 Workspace CLI（DWS）管理登录与刷新。

1. 在目标企业完成 DWS 授权，通过 `dws mcp market search` 选择服务，用 `dws mcp published tools <mcpId>` 核实该身份实际可用的工具和参数。试点先选一个只读工具，在预先授权的测试资料上核对返回值。
2. 适配器通过 `tools/list` 公布选中工具及真实参数定义，把 `tools/call` 映射到 `dws mcp published invoke <mcpId> <tool>`。现有通用 MCP 调用不会自动附带消息发送人，需由 Core 在派发前按已验证的身份选择专属连接和 DWS profile。服务 ID、身份和凭据由宿主提供。个人授权仅用于该成员，群内展示还须符合该群获准的资料范围。`dws mcp url get <mcpId>` 返回的个人连接地址可能含凭据，应按密钥保管。
3. 将只读工具显式授权给试点群的真人提问回合，验证工具发现、调用、授权过期和重连。现有宿主会在已配置 MCP 启动失败时中止。实施时将这个可选服务的启动和重连单独处理，使钉钉 MCP 暂不可用时，机器人仍能调用 Core 的本地仓库查询能力。

[DWS 已发布工具调用](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/0d2f0ffecc56f3f9f2a31e70612ef9d11d70e98e/internal/app/mcp_published_command.go) · [DWS 连接地址与凭据说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/0d2f0ffecc56f3f9f2a31e70612ef9d11d70e98e/internal/app/mcp_url_command.go) · [希洛 MCP 配置与授权](agent-bindings.md#mcp-工具) · [Core MCP 客户端](../../src/modules/tools/infrastructure/agentMcpTools.ts)

## 仓库和库记忆如何存放

Core 以组织和代码托管平台的稳定仓库标识登记仓库，分配 `repoId`。同一仓库通过 SSH 或 HTTPS 登记时解析到同一个 ID。建议在 Core 数据目录的 `repositories/<repoId>/` 下放置 Git 镜像、检索索引和库记忆，统一备份与恢复。企业源码仓库由云效维护，Core 通过只读凭据拉取。项目「Chaos」保存前后端仓库的关联和各自的跟踪版本。

| 同一仓库目录内的数据 | 用途 |
| --- | --- |
| Git 镜像 | 按提交 SHA 读取原文、比较版本，生成对应提交的云效文件链接 |
| 文件和符号索引 | 按业务词、路径、类、函数、接口、页面文案定位实现，支持从镜像重建 |
| 库记忆 | 保存项目概览、术语、规则和已核实问答。每条含稳定记录 ID、结论、适用条件、状态、源文件、符号或行号、提交 SHA 和核实时间 |
| 同步记录 | 保存跟踪分支、上次成功版本、已发现的新版本、处理进度和失败原因 |

### 库记忆的写入与共享

首次整理和后续答疑都可以产生库记忆。对话里一句「我印象里是这样」可以作为查证线索。读到当前版本的实现或明确的项目约定后，再将有出处的结论写回。并发提问按仓库、版本、主题和证据去重。群聊原文、提问人和个人偏好留在原会话。

跨仓结论在回答时组合各仓证据。如果缓存合成答案，记录全部来源仓库和版本，在检索、送给模型及发出回复前复核授权。写进会话摘要的项目结论也保留来源，后续追问只加载仍有权访问的部分。钉钉 MCP 读到的个人文档沿用原授权范围，进入共享库的事实须由仓库材料独立证实。

### 控制台与绑定

「项目知识库」管理仓库来源、跟踪分支、最近成功的提交、同步状态和记忆出处。「连接」管理账号人设、会话记忆空间，以及账号下哪些群或私聊可使用哪些仓库。可以一次给账号选定的一组会话授权，也可以只绑定一个群。新增渠道仅创建关联，解绑只移除关联。单个群撤销绑定后，后续读取和在途回复都按新权限执行，其他获准渠道继续访问原库。

## 怎样读代码并回答

Core 提供平台无关的只读查询。当前希洛自查工作器主要读取自身 `src` 下的 TypeScript。项目仓库问答需支持外部仓库以及 Java、TS/TSX、页面配置、文档和测试。首版直接读取固定提交中的 Git 对象。索引范围由仓库配置确定，跳过凭据、生产配置中的敏感值、客户数据附件和构建产物。需要模型提炼的片段只交给该仓库获准使用的模型服务。[现有源码工作器](../../src/bootstrap/standaloneAgentCodingWorker.ts)

1. **先建项目地图。** 从仓库现有的业务领域索引、页面入口、模块说明和测试整理出「业务词 → 实现入口 → 证据」。Chaos 先覆盖产品迭代、测试方式和交付流程。业务术语用于找入口，历史需求文档标明版本，当前行为回到实际调用路径核实。
2. **提问时按范围检索。** Core 根据会话仓库绑定和前文选择项目，固定本次各仓 SHA。先查这个版本已核实的库记忆，证据不足时按业务词、符号、接口路径和页面文案找原文，沿前端表单、后端控制器、服务或测试核实。多个项目对同一问题有不同答案且前文无法区分时，再问用户指哪一个。
3. **回答带出处。** 给出结论、适用条件及可点击的固定提交链接。涉及两个仓库时分别引用。问「线上当前是否开启」需要对应环境的发布记录或运行配置，源码能证明实现和默认值。首版用文本和符号检索做 RAG，收集真实漏查问题后，再评估语义向量检索的收益。

以「为什么新建迭代时看不到研发自测」为例。抽查时，前端 `chaos_web@e3c262d79f92` 的 `src/pages/productbuild/index.tsx` 读取开关，查询失败也按关闭处理，`schema.ts` 据此展示选项。后端 `chaos@5e17ebe90f32` 的 `BizSwitch.isEnabledIterationSelfTest` 默认关闭，`IterationController.createIteration` 会在创建时校验。验收答案应引用两端实现，并指出确认某个环境的实际开关值还需要什么证据。

## 新提交如何更新知识

| 时机 | Core 的处理 |
| --- | --- |
| 首次同步 | 拉取管理员选定的分支，固定提交，建立索引和首批记忆。成功后原子发布可查询版本 |
| 有新提交 | 定期 fetch 并比较上次成功提交与新提交。按新增、修改、删除、重命名的文件及符号找出受影响的主题，沿调用方、配置、测试和已记录的跨仓依赖标记待核对。遇到大范围重构或分支历史改写时扩大到模块或整仓复核 |
| 正在更新时有人问 | 涉及待核对主题时直接读取已发现的新 SHA 原文。暂时无法核实时，说明当前能证实的版本和同步状态。新增实现影响范围不明确时，把所属模块一并列入复核 |
| 完成或中断 | 新索引和记忆核实后按仓库原子切换。旧结论保留历史版本。任务按仓库和目标 SHA 幂等，失败可恢复，较早任务晚到时不能覆盖较新版本 |
| 用户追问或指定版本 | 同一问题的追问沿用前一次回答的提交组合。用户问「最新呢」或明确给出发布 Tag 时，重新定位版本。发布 Tag 有前后端版本清单时以该清单为准 |

跨仓答案缓存按完整的「仓库 ID、提交 SHA」组合查找。只要任一来源仓库更新，用于回答新版本的结论就须复核。后台刷新一份库记忆即可服务所有绑定渠道。控制台区分「上次成功同步」与「已发现、正在处理」，Codeup 暂时不可达时显示最后核实版本。

## 交付顺序与验收

| 阶段 | 交付内容 | 验收场景 |
| --- | --- | --- |
| 1 · Core 仓库知识 | 登记两仓、版本化读源码、持久化库记忆和项目检索 | 用十几道真实问题覆盖业务规则、跨仓实现、版本差异和资料不足。每个有关代码行为的结论能打开对应提交的依据 |
| 2 · 渠道绑定 | 控制台配置可选人设、会话记忆空间、仓库及会话授权 | 两个不同人设、不同会话空间的绑定读取同一条库记忆，记录 ID 和来源相同。新增绑定无需重新索引。仅绑定前端的会话无法读取后端或双仓派生结论 |
| 3 · 钉钉试点 | 企业机器人收发、按连接过滤回复、按授权主体调用 MCP、与 QQ 共用 Core | 受邀钉钉群 @ 后收到有出处的回答。验证私聊和群聊模式、黑白名单、普通群消息投递范围、一个真实只读 MCP 调用和重复事件去重。绑定同仓的 QQ 群可复用库记忆 |
| 4 · 更新与回归 | 自动增量刷新、版本回溯、权限撤销和失败恢复 | 在测试分支改变一条业务规则，验证两渠道读到新结论，固定旧版本仍可追溯。再测试删除来源文件、同步中断、连续两次提交和撤销绑定期间的在途查询 |

本方案依据本地两份 `master` 快照、希洛现有接口和公开的 DWS 实现编写。真实钉钉企业授权、MCP 工具清单、发送回执以及公司环境的发布版本映射，列入试点联调验收。
