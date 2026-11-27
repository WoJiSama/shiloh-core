# bl-chat 控制台

本文负责控制台使用与配置操作。当前实现、部署快照及待验收项统一见[项目当前状态](../docs/project-status.md)；阶段候选与验证证据见[历史记录](../docs/architecture/agent-bindings-history.md)。

控制台前端采用 Vue 3、TypeScript、Vite、Vue Router 和 Naive UI。当前生产由独立 Core 宿主内置的 HTTP 服务提供控制台，与聊天共同运行在 `bl-chat-agent.service`。旧 `bl-console.service` 已退役并移除；`console/server.js` 仅保留兼容插件入口。

独立 Agent 的内置 HTTP 宿主复用这份前端，通过认证的 `/api/workspace` 返回已加载的机器人本人、连接、版本化会话及真实管理能力。工作区有总览、机器人、连接、功能、资源库、运行中心和系统七个入口，机器人详情有主页、会话、自我与记忆、行动、能力与边界五个标签。插件模式继续走原导航。接口错误不会切换成空工作区。

各分类页及其模块内保留功能导航；`⌘K` / `Ctrl+K` 可按名称和关键词直达模块、机器人、连接或会话。连接分类可直接进入群管理。人物记忆和托付面板由机器人详情的 `panel=person-profiles` / `panel=trusteeship` 保存到地址，刷新和返回可恢复；从会话卡片进入“管理此会话”会自动打开对应详情，保留完整会话地址与绑定版本。机器人到人设资源的链接会选中当前模板，并保留返回来源。

人物页显示已有来源的记忆条目，删除仅作用于所选完整来源会话；托付页保留原任务 ID、未知结果和真实取消状态。管理员可见的聚合不会授予机器人跨场景使用原始资料的权限。新增 QQ 连接、本人创建和配置候选预览使用原子配置提交；统一认知与完整遗忘影响状态仍按 [项目当前状态](../docs/project-status.md) 推进。

## QQ 掉线后重新登录

打开总览顶部的 QQ 掉线提示，点对应账号的「扫码登录」。也可以从侧栏进入「连接」，在账号卡片打开同一个弹窗。用该账号的手机 QQ 扫码并确认。弹窗会显示等待扫码、等待确认和连接恢复的状态。二维码过期时点「获取二维码」。

「连接」页可为已有连接选择机器人并绑定群聊或好友。宿主配置了账号容器管理时，账号卡片提供启用、停用和重启，页面也可为新 QQ 开通容器。开通后的账号在应用配置后出现，可扫码并单独接入会话。

独立宿主通过 `console.qqLogin` 为对应账号配置 NapCat 的本机 WebUI 端口和令牌环境变量名。初始配置包在 `host.console.qqLogin` 声明同名字段。配置需要匹配已有连接和 QQ 号，加载后扫码页面在 OneBot 离线时也可用。

```yaml
console:
  qqLogin:
    - connectionId: qq-main
      accountId: "123456789"
      port: 6099
      tokenEnv: BL_AGENT_NAPCAT_WEBUI_TOKEN
```

## 功能与资源库

展开「功能」可进入「骰子」和「游戏」。骰子页管理跑团掷骰开关与上限。游戏页可以管理海龟汤题库，设置赛马娘和三角洲参数。海龟汤按完整账号和机器人选择题库，生成与审核使用当前宿主的游戏模型配置。

资源库的创作工作台使用 Core 的图片渠道。历史成图通过认证的图片接口读取。

表达学习支持浏览旧规则和群词库，修剪与屏蔽保存在独立的归档视图设置中。记忆检索可查看 Core 当前会话的语义来源和旧版归档。旧版语义块按原群检索，并过滤旧遗忘记录及当前会话遗忘水位。

运维人员用发布包的 scripts/import-legacy-console-resources.py 从冻结的配置与数据归档、Redis 快照和旧成图目录导入控制台资料。脚本默认预演，加 --apply 以原子方式发布资源目录。它使用独立 Redis 进程读取快照，保留各文件的内容校验记录。导入时通过 `--legacy-account` 指明旧资料所属的 QQ 接收账号。

## 独立 Agent 的运行观测

运行中心的“运行观测”读取本实例已有的持久操作日志。每次最多显示 200 条近期记录，可按本人、完整账号、会话、状态或 trace 筛选，查看同一来源在本次返回范围内的时间线。记录显示当时加载的配置版本和平台实际回执；结果未知与已确认发送分别展示。当前完整绑定仍匹配时可跳转到本人会话，历史版本只供追溯。

`GET /api/observe/summary` 受 `observe.read` 及逐会话授权约束，宿主事件与全局日志健康另外要求 `observe.host`。页面标明读取截断、损坏记录、日志降级或查看权限不足，不把有限记录当作完整时段统计。日志仅保存操作元数据，不保存聊天正文、模型提示词或工具参数；旧记录没有配置版本或发送回执时显示未记录。

## 独立 Agent 的配置变更与恢复

在 **系统 → 工具与功能开关** 配置全局或按群的使用范围。控制台列出自动搬运等独立功能、内置工具和已注册的 MCP 工具。保存使用宿主的配置版本校验，重启后生效。 [宿主配置示例](../docs/architecture/agent-bindings.md#工具与功能开关)

在机器人页创建本人时，可复用已有模板，也可连同新模板一起创建；经历和成长仍按本人隔离。在连接页可为既有本人新增 QQ，只绑定明确填写的群和好友，不复制旧账号权限。

流程依次使用 `GET /api/configuration/catalog`、`POST /api/configuration/preview` 和 `POST /api/configuration/commit`。预览展示字段差异、受影响本人、连接、完整会话及权限变化，完整候选保留在服务端；提交只携带 `previewId`、`revision`、`candidateDigest` 和包含 host/personas/bindings 的完整 `readSet`。候选过期、身份撤销或配置变化后须重新预览，不能用旧预览覆盖新配置。

默认把宿主设置、人设库和绑定一起提交到 `agent-config.sqlite`，分别记录已保存和已加载的版本。涉及启动期装配的提交可通过「重启并应用配置」生效。使用标准启动器且由它管理应用生命周期时，提交先交付响应，再释放 Redis 租约并重新装配。控制台等宿主重新核验账号后恢复编辑。钉钉回复规则按账号保存，即时生效。 [初始化和旧配置导入](../docs/architecture/agent-bindings.md#独立-core-配置库)

提交结果未知时先核对配置状态。SQLite 在下次可写打开时处理上次未完成的事务。以下命令检查能否读到有效配置。

```sh
node scripts/start-agent.mjs --config /path/to/agent-config.sqlite --inspect-config-transaction
```

需要恢复时先停止宿主，再单独运行以下命令。

```sh
node scripts/start-agent.mjs --config /path/to/agent-config.sqlite --recover-config
```

检查和恢复独立运行，只输出状态和版本回执。使用旧 YAML 路径的部署沿用其原有离线恢复流程。配置库损坏时保留现场，以可用的数据库备份恢复。

## 安装、构建和启动

SQLite 配置需要 **Node 22.13 及以上**，建议使用受支持的 LTS。从源码仓库根目录安装根目录和前端的锁定依赖。

```sh
npm ci
npm --prefix console/frontend ci
npm run agent:pack
```

`agent:pack` 会检查并构建前后端，生成含控制台的 `.release/agent-*` 独立发布包。`dist`、前端 `node_modules` 和 Vite 缓存不提交 Git。安装发布包与生产依赖、校验 `release-manifest.json` 后，由同一个宿主启动聊天和控制台：

```sh
node scripts/start-agent.mjs --config /path/to/agent-config.sqlite
```

宿主配置须显式开启 `console.enabled`，默认监听 `127.0.0.1:8787`；认证及初始化按 [独立 QQ 宿主](../docs/architecture/agent-bindings.md#独立-qq-宿主) 配置。

生产更新先交付完整独立包，再切换 `/opt/bl-chat-agent/current`，最后运行 `sudo systemctl restart bl-chat-agent`。宿主与控制台共同加载新版本，无需单独控制台服务。旧 `scripts/deploy.sh` 只返回退役说明，不再操作服务器。

构建产物不存在或首页不可读时，首页返回 HTTP 503，并提示安装、构建命令。服务不会回退到旧模板；配置 API 与鉴权仍可用。HTML 使用 `no-store`，带内容哈希的资源使用长期 immutable 缓存。

插件根目录提供快捷脚本：

| 命令 | 用途 |
| --- | --- |
| `npm run console:dev` | 启动 Vite 开发服务，`/api`、`/img`、`/bl-chat` 代理至本机 8787 |
| `npm run console:build` | 类型检查并构建前端 |
| `npm run console:check` | 仅运行前端 TypeScript 检查 |
| `npm run console:test` | 运行前端 Vitest 测试 |
| `npm run console:smoke` | 用构建产物、localhost 假 API 和 Chrome 运行跨页/主题/宽度浏览器检查 |
| `npm run agent:start -- --config /path/to/agent-config.sqlite` | 启动独立宿主及内置控制台 |
| `npm run console:start` | 兼容插件模式的旧 Node 服务入口 |

开发模式下分别启动配置了控制台的 `agent:start` 和 `console:dev`，Vite 默认代理到本机 8787。

## 兼容插件模式的页面和地址

继续使用 hash 路由，原 `#/`、`#/persona`、`#/ai`、`#/draw`、`#/commands`、`#/observe`、`#/semantic` 地址保持可用。新增 `#/conversation`（对话设置）、`#/groups`、`#/group-admin`（群管理）、`#/pipeline`、`#/risk` 和 `#/bot/<QQ>` 等页面。

命令 / 骰子与语义记忆已经使用原生 Vue 页面，通过现有 `/bl-chat/*` API 代理访问 Yunzai；命令表、骰子回复、牌堆规则和表情包等能力沿用已有后端。骰子基础设置、对话追踪和记忆策略使用独立控制台配置 API，不依赖这些运营 API。运行观测 `#/observe` 展示聚合概览，`#/observe/details` 保留原工具的完整运行明细入口，可在嵌入页查看或在新窗口打开。

`#/observe/details` 在独立宿主中归属运行中心；当前独立宿主尚未提供完整明细服务，页面明确提示可用性，不请求插件模式的 Yunzai iframe。其他模块也按当前宿主实际报告的能力显示可用状态。

群聊页在群号旁显示群名，并支持按群名搜索。名称优先读取 Yunzai 各机器人已有群列表；上游不可用时回退插件与 Yunzai 主目录的 `data/group_names.json` 缓存，仍未知的名称显示“群名未获取”。群聊列表汇总白名单、今日活动和已配置群管的群；未启用的群管配置也可被发现。

群管理支持入群验证、广告与刷屏处理、欢迎与退群通知三个页签。`#/group-admin?scope=defaults` 设置默认策略和各模块总开关，`#/group-admin?group=<群号>` 配置单群覆盖；可从群聊列表或详情进入，再返回对应群聊。支持直接输入群号，提前配置尚无活动的群。

## 认证和配置保存

账密登录使用服务端 scrypt 密码哈希和 HttpOnly、SameSite=Lax 的会话 Cookie；现有控制台令牌仍支持查询参数 `token` 和 `x-console-token`，方便脚本和受保护图片访问。浏览器进入带令牌链接后会移除地址栏中的查询参数。首次创建管理员、修改密码、退出登录沿用现有认证 API。

已认证的 `/bl-chat/*` 请求由控制台在服务端装配对应 Yunzai 页面凭据，不需要前端读取 `commands-web.json`。向 Yunzai 转发时剔除控制台令牌头、会话 Cookie 和 referer；`/api/apps` 返回不含页面令牌的路径。独立原工具使用自身页面令牌的访问方式仍兼容。

通用配置页以 `src/modules/config/domain/schemas/shared/` 为字段声明源，`models/configSchemas/` 提供独立导出，`message.yaml` 为持久化配置源。控制台已完整覆盖的对话、权限、模型、人设、管道、群管、骰子基础、追踪和记忆策略配置已从锅巴移除，清理台账见 `docs/console-guoba-migration.md`。锅巴只保留尚无控制台编辑入口的设置；其读取和保存也限定于剩余字段，旧页面提交已迁移字段时会拒绝保存并提示刷新。

控制台配置保存约定：

- GET 返回字段分组、组件约束、`revision`、`applyMode` 和 `applyHint`。明确的密码字段返回 `value: ''`、`secret: true` 和 `configured`，不返回原凭据。
- PUT 提交 `{ values, secrets, revision }`，`values` 仅包含变更字段。凭据使用 `{ action: 'keep' }`、`{ action: 'replace', value: '...' }` 或 `{ action: 'clear' }`；脱敏占位符不能写成真实凭据。
- 服务端校验数字必填、范围和步长、子表组件与必填约束。校验失败返回 400；当前配置与提交 revision 不同返回 409，前端保留草稿供核对。
- 仅在有变化时备份，再通过 YAML 定点更新写入；保留无关字段和注释，最多保留 10 份控制台备份。
- 保存成功表示已持久化。消息管道初始化参数与搬运授权初始化项需要重启机器人服务；健康报告配置在下一调度周期读取；风控约 10 秒内读取更新。字段说明给出具体生效时机，保存不会自动重启机器人。

骰子基础位于 `#/commands` 的“骰子基础”，对话追踪位于 `#/conversation` 的“对话追踪”，记忆策略位于 `#/semantic` 的“记忆策略”。对应 `GET/PUT /api/config/dice`、`/api/config/tracking`、`/api/config/memory`，PUT 必须携带 revision。任务页签间切换保留各自草稿，离开页面提醒未保存修改。骰子目录保存后切到新目录且不自动迁移文件；追踪已有计时器沿用原计划；记忆运行时重装会让尚未摘要的中期缓冲重新累积，已落盘摘要和归档保留。详见 `../docs/console-policy-config-2026-10-16.md`。

群管理默认策略使用 `GET/PUT /api/config/groupAdmin`，单群配置使用 `GET/PUT /api/groups/:id/admin`。单群 PUT 提交 `{ revision, values, resets }`：`values` 为变更字段，`resets` 为恢复默认的字段名。新接口必须携带 revision；本群或默认策略变化返回 409，修改其他群不会使当前群的版本失效。前端保留冲突草稿，刷新后可核对再保存。

单群覆盖保存在 `pluginSettings.groupAdmin.overrides`，未覆盖字段继承默认策略，支持明确关闭开关、清空文案和清空本群通知名单。原模块 `enabled` 保留为全局总开关，单群还需启用对应能力；单群“恢复默认”保留这三个启用状态。旧锅巴启用名单、欢迎/退群模板与通知名单继续生效，恢复相关字段时会同步清理本群旧值。通知接收人是全局通知 QQ 与本群通知 QQ 的并集。

保存仅更新本群节点及其变更字段，保留其他群、未知扩展字段和未改动注释。后续群事件读取新配置；进行中的入群验证保留原题目和截止时间，关闭验证后不再执行其超时处理。入群验证和广告处理仍受机器人群权限限制。

AI 渠道提供不含凭据的稳定 `_consoleId`，按 ID 保留各行原 API Key，重排不会把其他行凭据套进当前行。API Key 支持 `apiKeyAction: 'keep' | 'replace' | 'clear'`，脱敏行探测由服务端恢复原 key。AI 配置各组与人设库也返回 revision，保存可携带 revision 防止旧页面覆盖新配置。旧客户端未携带 revision 的提交仍兼容。

`GET /api/pipeline/jobs` 支持 `kind=all|event|delivery`、`status` 和 `limit=1..200`。返回的是 Redis TTL 内仍保留的任务记录，状态表示最后持久化结果，不能据此确认 worker 当前存活。扫描达到上限会标明 `scanTruncated`；Redis 不可达返回 503，不伪造任务量或运行状态。

## 服务环境变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `CONSOLE_HOST` | `0.0.0.0`，监听地址 |
| `CONSOLE_PORT` | `8787`，监听端口 |
| `CONSOLE_YUNZAI_HOST` | `127.0.0.1`，Yunzai 页面服务地址 |
| `CONSOLE_YUNZAI_PORT` | `2536`，Yunzai 页面服务端口 |
| `CONSOLE_DRAW_DIR` | `/var/lib/bl-console/draw`，生图历史文件目录 |
| `CONSOLE_PLUGIN_ROOT` | 当前代码的插件根目录；用于部署根目录覆盖或隔离测试 fixture |

## 后端定向验证

以下测试使用纯模块、本地临时 fixture 和 localhost 假上游，不读取真实 `config` 或访问生产：

```sh
node --test tests/consolePolicyConfig.test.js tests/consoleConversationConfig.test.js tests/groupAdminPolicy.test.js tests/groupAdminConsole.test.js tests/consoleSchemaConfig.test.js tests/consoleProviderCredentials.test.js tests/consoleRuntimeRead.test.js tests/consoleFrontendStatic.test.js tests/consoleServerIntegration.test.js tests/guobaAiProviderConfig.test.js tests/aiProviderProbe.test.js tests/personaLibrary.test.js tests/diceRulePackManager.test.js tests/commandsWebApp.test.js
```

浏览器回归先执行 `npm run console:build`，再运行 `npm run console:smoke`。默认使用系统 Google Chrome（macOS 路径），其他环境可通过 `CHROME_PATH` 指定可执行文件；输出报告与截图写入 `/tmp/bl-console-vue-review`，可通过 `CONSOLE_SMOKE_OUTPUT` 覆盖。夹具只读取默认 schema 与非密默认配置，不连接真实控制台、Redis、Docker 或外部模型。测试覆盖的界面行为不能代替实际服务联调。

前端使用 `npm --prefix console/frontend run format` 与 `format:check` 统一源码格式。桌面侧栏底部显示构建 Git revision 和日期，鼠标悬停显示完整 UTC 构建时间。

规则包预检返回 `stageId`，原生页面与原工具确认时携带 `{ id, stageId }`。服务端在索引锁内比较暂存编号，预检被其他页面替换或已经确认时返回 409，不会导入与审核报告不一致的源码。无编号的旧客户端仍兼容。前端拒绝非法文件名，并在牌堆替换、规则确认及删除时给出确认提示。
