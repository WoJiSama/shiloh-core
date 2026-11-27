# 项目当前状态

记录日期：2026-11-20。本文汇总仓库中已保存的交付与验证证据，供判断当前实现、部署范围和剩余工作；生产观察属于当时的快照，不表示实时监控结果。

## 运行与交付范围

| 项目 | 已有状态 | 边界 |
| --- | --- | --- |
| 独立 Core | 独立 QQ 宿主、显式 Agent/账号/会话绑定和发布包已实现。运行告警增量前的生产版本为 `c5d0636fc4caf18191363e7ff8c9dbf818698ae3`，其产品源码与归并前远端 main `a7c70bf66a8c7d6f0626c66c0668069217fc1603` 一致 | 包含独立观测、控制台、沙箱浏览器启动器、B站、BT 引导、QQ/视频/图片同步配置观察、视频来源校验及网页/视觉失败诊断。工具参数及动作授权、控制台易用性、检索评估和默认关闭的统一认知已归并至 main，部署范围以上线记录为准 |
| 生产入口 | 已直接切换至 Core；旧 Yunzai 宿主及旧控制台的 systemd 服务定义已删除，自启入口为零，查询为 `not-found`；本批另清理旧插件目录内两项 11 月 3 日遗留孤儿进程 | 旧服务及旧运行目录已删除；独立备份保留，其中仍有未满足来源证明的历史记忆。Core 无旧目录运行依赖 |
| QQ 连接 | 一条连接已实际认证；配置声明 18 个群、2 个私聊 | 另外两个旧账号的 NapCat 容器运行中，但登录读回均为 `waiting_qrcode`、未登录，且没有 Core 显式连接及绑定；配置数量不代表每个会话均已验收 |
| Web 控制台 | 独立宿主内置 HTTP 服务，复用 Vue 前端；六个入口、本人详情五个标签、配置预览/提交及独立运行观测已实现并部署 | 观测包含配置版本、原生投递回执、unknown 和完整会话深链；旧插件模式继续使用原页面 |
| 配置保存 | 当前工作区默认用 SQLite 一次提交宿主设置、人设库及绑定，支持旧 YAML 离线导入和版本化 JSON 导出 | 生产切换需先导入再调整启动路径。宿主配置保存沿用应用流程，钉钉回复规则可在控制台即时保存生效 |
| 历史资料 | 旧配置、data 和 Redis 已备份；从 10 个旧群状态的 51 条长期记忆中，已核验导入 4 条及其引用的 8 条回执，并复核目标内容与来源证明一致 | 其余 47 条保留在旧分区；未迁移旧 session、消息序号、决策、目标或待执行任务；隐式来源使用独立的真实配置、归档、解析器及隔离 RDB 证明 |
| 检索评估 | 固定数据集的 Core v2 离线评估，独立检索对照、来源诊断和上下文完整覆盖已实现；旧在线评估已停用 | 合成后端用于回归验证；真实模型质量与整个回答链路仍须分别评估，旧插件数字不可直接比较 |

配置方法见[角色与会话绑定](architecture/agent-bindings.md)和[控制台使用说明](../console/README.md)。部署与备份证据见[直接切换记录](architecture/agent-bindings-history.md#core-production-cutover)。

2026-11-20 运行告警增量已部署到独立 Core，生产版本为 `11da9eea7c0ed766804a624531a1ddca9abdfc25`，基底为 `c5d0636fc4caf18191363e7ff8c9dbf818698ae3`。`qq-main` 向现有配置的唯一 QQ 主人投递私聊告警。生产回读确认账号已重连、加载与存储版本一致，首个实际告警批次已取得 QQ 成功回执。95 项专项测试通过，线上独立暂存验证覆盖合成 QQ 投递及操作日志落盘。验证记录位于 `/opt/bl-chat-agent/staging/runtime-alert-20261120.8dScZk/production-alert-verification.json`。

同日 13:05（北京时间）上线修复 `f7e49e8b721863f0087c1e1344ed575dad50c0f1`。群梗提取对有效空结果保存进度，对失败保留进度并等待冷却后再尝试。同一次仿真工具失败记一次告警。智谱官方 `glm-5.3-flash` 的唤醒预判和群梗提取关闭推理并用合成输入验证了真实模型 JSON 响应。73 项专项测试通过。13:05:45 至 13:08:42 的生产观察记录两批空结果成功、一次上游超时、两条未分类后台警告及四批 QQ 确认回执。Core 启动完成，`qq-main` 已连接，绑定及宿主配置校验一致。验证记录位于 `/opt/bl-chat-agent/staging/qq-alert-repair-20261120.BjUK1p/production-verification.json`。

Core 检索评估的运行方法、指标和证据边界见[语义检索离线评估](evals/semantic-retrieval.md)。这项本地实现不表示生产宿主已部署新版本。

## 已有验证及其范围

下列结果来自各自记录的运行或测试批次，不能相加成一次全量通过，也不能用较早候选的通过结果覆盖后续失败。

| 证据 | 已保存的结果 | 可以据此判断的范围 |
| --- | --- | --- |
| 前批发布 `6ed2b09` | 后端构建 2,604 文件、类型及架构边界通过；脱离仓库安装的最终发布包六文件 78/78 通过，660 个发布清单文件校验通过；CLI help 和工件门禁通过 | 覆盖独立观测、完整身份隔离、历史配置版本、日志边界、真实回执和原有控制台/磁力运行路径；不是完整后端全绿 |
| 发布工程门禁 | 后端类型、架构边界及构建通过；前端曾完成 30 文件、362 项全量测试，最终时间线修复后专项 16/16 及前端构建通过 | 浏览器复验同毫秒顺序、unknown 及完整会话跳转；未把早期全量与最终新增专项相加成一次全量通过 |
| 完整后端批次 | 8,199 项：8,129 通过、49 失败、21 跳过；修正部分夹具后六文件 79 项定向通过 | 最新记录没有修复后全量全绿证据；耗时与夹具问题仍须分别关闭 |
| 发布包基础回归 | 原 90 秒聚合用例拆为 13 个顺序持久化检查点后，完整源码恢复链 13/13 通过（296 秒），独立 `6ed2b09` 发布包恢复链 13/13 通过（145 秒）；两轮均零失败、取消和跳过。测试修复 `7201317` 已推送 main，后段筛选的依赖缺失守卫也通过定向验证 | 运行与 CLI 使用实际发布包；旧 ReminderTool producer 作为显式编译迁移来源夹具，Core 重叠文件哈希与发布包一致。这是测试结构与旧夹具修复，不表示产品性能优化；该恢复链批次使用的功能包为 `6ed2b09` |
| 实际部署检查 | 清单校验、服务启动、QQ 认证、控制台 HTTP/浏览器加载及配置 loaded/stored 一致性均有记录 | 证明该发布版本能启动并接入，不覆盖全部功能 |
| 自然业务观察 | 较早快照有 39 次入站、9 次主模型成功及一次确认发送；本批 `6317c5b` 进程自 12:07 启动至 12:16 的只读快照有 21 次入站成功、5 次主模型成功、两条原生 `sent` 回执及一次 44.040 秒的成功回合 | 按实际进程启动时间及配置版本筛选；扫描窗口为 2,000 条、接口样本最多 200 条，不能当全历史。该回合有读图和网页解析失败，后续继续并确认投递；具体原因待定位。未人工发送 QQ 消息，不覆盖所有群、私聊和工具 |
| 渲染及 B站发布 `6813aa6` | 后端类型、架构边界及 2,604 文件构建通过；662 个清单文件校验通过；B站完整两文件在源码及最终发布包 dist 各 99/99 通过，均无失败、取消或跳过 | 修复 SPI `b_4` 的 `/` 字符兼容，以及自动搬运缺必需分段时错误发送残片；源码与包测试是两批，不代表完整后端全绿 |
| 沙箱浏览器 | 启动器在真实 Linux root 环境 30/30 通过，无跳过；最终生产包真实完成 chat、document、knowledge、mindmap 四类非空 PNG 渲染，观察到浏览器 UID 999 | Core 主进程仍以 root 运行；只有浏览器降权，未关闭沙箱；渲染输出不等于 QQ 客户端显示验收 |
| QQ 原生动作复验 | 六个群管理动作在实际发布包 CLI 的一个完整用例 1/1 通过；相关交互、unknown、撤权及重启防重另批 5/5 通过，均无失败、取消或跳过 | 保留六动作原失败批次；使用合成 OneBot/模型，不能称为六项真实线上 QQ 验收或完整 QQ 动作全绿 |
| 独立发布 `7ae17bf` | 后端 2,604 文件构建、完整类型、架构边界和 662 文件清单通过；生产独立安装、工件门禁和 CLI help 通过；最终包 BT 提供器 49/49、提醒 unknown/撤权重启 2/2 通过，零失败或跳过 | 固定 DHT 引导解决每作业空路由表没有入口的问题；提醒仅修复退休旧进程的测试预期。尚未通过的 QQ 扩展动作优化未进入提交或发布包 |
| 独立发布 `50dee79` | 后端 2,607 文件构建、完整类型及架构边界通过；配置事务/恢复/控制台等 135/135、Core 邻接 60/60 通过；同一构建 QQ 完整礼物/空间/口令领取 1/1、安全复验 9/9，另批未变的 gift unknown/模型等待撤权 2/2。663 文件独立包安装、归档外部 TypeScript 公共消费者 1/1、工件门禁与 CLI help 通过 | 同步判断共享完整配置观察并在进出重新读完整来源，不跨 await；品牌只复用来源校验器身份，每次仍新鲜验证。产品期限未改变，修正部分夹具 20 秒观察早于业务期限的问题；这些 QQ 用例使用本地合成模型/OneBot，不代替实际线上动作验收 |
| 视频与骰子收尾 `6317c5b` | 完整类型及架构边界通过；视频/来源/文本运行回归 155/155，另批配置观察/文件/文本邻接 42/42；新观察边界定向 6/6、来源品牌定向 17/17。视频分析 current→reply→嵌套转发整链 1/1、禁用/撤回/宿主撤权 3/3；实际独立包附件成功、unknown 重放重启、默认关闭 3/3；外部 TypeScript 公共消费者 1/1，均无取消或跳过 | 骰子撤权夹具在 `50dee79` 独立包 1/1 通过，明确验证退休旧队列保留、新禁用配置重启排空及安全重放；不改退休进程 ACK 合同。视频每次仍 fresh 读来源，异来源及列表 generation 分别核验。附件观察窗由 25 秒修正为覆盖既有 240 秒业务期限，产品期限未改。均为本地合成 OneBot/模型，非线上客户端验收 |
| 本批余项复验 | 当前 `6317c5b` 独立包抖音 note、Excel repository、凭据输出阻断各 1/1；同提交后端产物配系统 Chrome 的渲染/取消/格式化可见文字专项 9/9，均零失败、取消、跳过。启动器审核登记修正后 `migrationTooling` 全文件 12/12，25 个宿主入口全部审核匹配、当前源码边界违规为 0 | 浏览器首次运行因本地缺少 Puppeteer 指定版本失败，显式选择已安装系统 Chrome 后通过，未修改渲染产品。启动器差异仅四条固定脱敏提示，业务仍在 TS；只更新精确审核登记，拒绝未审核变更的规则保留。独立控制台操作规范同步修正；`8cf7a27` 已推送 main，生产运行代码未变，未为文档及审核登记重启服务 |
| 图片与失败诊断 `29f7bb7` | 完整类型及架构边界通过；图片 Core 4/4、OneBot 图片取消 8/8、网页/公共图片 41/41、独立包视觉 CLI 1/1、外部公共 TypeScript 消费者 1/1 均零失败/取消/跳过。网页新增三项、图片观察及视觉缺日志均先红后绿；恢复夹具移资源初始化到 before，首检查点 1/1、视觉筛选运行均正常退出 | 视觉 CLI 覆盖 HTTP 401、200 空内容、正常响应、撤回/换绑及日志白名单；原权限、来源双读、SSRF、超时及 250 tokens 不变。仅在纯同步图片 predicate 内共享配置观察，不跨 await；不将历史自然失败直接宣称修复 |
| 本批生产复核 | 实际进程目录为 `29f7bb7`，663 文件清单一致；QQ 已连接、20 个绑定；首页、认证、工作区及观测 200，未认证观测 401，loaded/stored 一致；观测日志健康，自动重启计数为 0；两个旧服务均为 `not-found` | host/bindings/personas 及 agent.env 的字节、inode、ctime、UID、GID、mode 均保留；复核未发送 QQ 测试消息。13:07 启动至 13:09:55 的新进程样本有 4 次真实入站，尚无主模型或新读图/网页诊断，不能确认历史自然失败根因 |

本轮独立证据：`/tmp/bl-core-browser-final-{types,boundaries,backend-build}.log`、`/tmp/bl-bilibili-final-source-review.log`、`/tmp/bl-core-browser-final-bilibili-package-tests.log`、`/tmp/bl-sandboxed-launcher-linux-root-proof.json`、`/tmp/bl-group-management-current-package{-green,}.log` 及 `/tmp/bl-interaction-current-package-regression.log`；最终生产回执位于服务器 `staging/core-sandboxed-browser-20261118/{deployment-receipt,verification}.json`。

本轮 BT 与提醒交付证据：`/tmp/bl-bt-delivery-{backend-build,types,boundaries,package-provider,package-deferred}.log`、`/tmp/bl-core-bt-release-proof.json`；服务器 `staging/core-bt-bootstrap-20261119/{deployment-receipt,verification}.json`。QQ 同步校验交付见 `/tmp/bl-parent-observation-built-qq-{success,safety-final}.log`、`/tmp/bl-parent-observation-built-core-regression.log`、`/tmp/bl-config-observation-owner-final.log`、`/tmp/bl-qq-delivery-public-consumer.log`，服务器 `staging/core-qq-current-20261119/{deployment-receipt,verification}.json`。公网原生分片探针见 `/tmp/bl-public-bt-reachable-discovery-payload-proof.json`，生产公共提供器下载及 ZIP 证据见 `/tmp/bl-public-provider-acceptance-proof.json`；旧服务删除回执见 `/tmp/bl-legacy-service-removal-20261119.json`。

本批视频/骰子证据：`/tmp/bl-video-source-owner-runtime-regression.log`、`/tmp/bl-video-observation-adjacent.log`、`/tmp/bl-video-observation-original-red-cases.log`、`/tmp/bl-video-observation-cli-safety.log`、`/tmp/bl-dice-revocation-current-package-fixed.log`、`/tmp/bl-video-source-owner-package-attachment-cli.log`、`/tmp/bl-video-source-owner-public-consumer.log`。最初 25 秒附件观察批次与 120 秒诊断观察分别保留；诊断完整成功为 60.681 秒，正式独立包附件全文件 3/3 为 124.295 秒。干净提交的 874 个源码校验值和全部 2,607 个后端输出与已测试候选相同，663 文件最终发布清单仅后端 manifest 的提交字段变化；见 `/tmp/bl-video-source-owner-clean-build-proof.json`、`/tmp/bl-core-video-source-release-proof.json`。生产回执及验证在服务器 `staging/core-video-source-20261119/{deployment-receipt,verification}.json`，本地 `/tmp/bl-core-video-source-{deployment-receipt,verification}.json`。

本批余项证据：`/tmp/bl-6317c5b-{douyin-note,excel-repository,files-credentials}-current.log`、`/tmp/bl-6317c5b-renderer-explicit-browser-regression.log`、`/tmp/bl-migration-bootstrap-reviewed-20261119.log`、`/tmp/bl-migration-bootstrap-current-report-20261119.json`。原启动器审核 red 及缺本地 Chrome 的渲染 red 均保留；脱敏自然业务快照为 `/tmp/bl-core-readonly-observe-20261119.json`。

本批图片与失败诊断证据：`/tmp/bl-read-diagnostics-{types,boundaries,web-image-regression}-20261119.log`、`/tmp/bl-image-source-observation-built-green-20261119.log`、`/tmp/bl-onebot-image-cancellation-built-20261119.log`、`/tmp/bl-vision-cli-diagnostics-{red-lifecycle-fixed,green}-20261119.log`、`/tmp/bl-qq-recovery-fixture-lifecycle-green-20261119.log`、`/tmp/bl-read-diagnostics-public-consumer-20261119.log`。干净提交的 874 个源码校验值及 2,607 个后端输出与已测候选一致，最终 663 文件包仅后端 manifest 的提交字段不同，见 `/tmp/bl-read-diagnostics-clean-build-proof-20261119.json` 与 `/tmp/bl-core-read-diagnostics-release-proof-20261119.json`。生产回执在服务器 `staging/core-read-diagnostics-20261119/{deployment-receipt,verification,legacy-orphan-removal,natural-observation}.json`；本地自然样本 `/tmp/bl-core-read-diagnostics-natural-observation-20261119.json` 按显式 UTC 启动时间及配置版本筛选。

工程批次见[发布准备记录](architecture/agent-bindings-history.md#core-cutover-preparation)，基础恢复用例见[最后复验记录](architecture/agent-bindings-history.md#core-package-recovery)，线上观察见[生产切换记录](architecture/agent-bindings-history.md#core-production-cutover)。历史记录中的 `/tmp` 路径是当时环境的证据位置，不保证在其他机器或后续时刻仍可读取。

## 未完成工作与待验收项

- **能力接续**：BT 下载、磁力搜索及 B站旧授权自动重试已显式装配到生产 Core；B站凭据已通过真实认证检查，磁力搜索真实外部请求已返回结果。隔离 loopback 的真实 aria2/P2P 下载及 ZIP 解包校验通过；公网原生 P2P 已从官方 Ubuntu 种子取得 1 MiB、四个分片 SHA1 全部一致（禁用 web seed）。随后在生产 `7ae17bf` 的实际公共提供器完成官方 Sintel 小字幕选择、P2P payload 下载、产品分片校验及 ZIP 打包，共 10.655 秒；独立 ZIP CRC、唯一条目及 1,514 字节大小一致。元数据命中产品默认 HTTP 缓存，不代表纯 DHT 元数据发现通过；QQ 上传及客户端显示仍待验收。语音与四个 MCP 服务在旧配置中关闭，图片及 QQ 动作的旧配置不足以确认启用状态。
- **历史接续**：已导入 4 条来源闭包可核验的旧长期记忆及 8 条必要回执；47 条仍留源（31 条非 portable 回执、9 条旧消息 seq、6 条兼有、1 条被替代祖先）。补审搜索候选 13 条仍缺可关联原调用、query 和真实来源，且均早于目标隐私水位；目标还保留来源撤回，不补造或重搜旧证据。本轮新增可迁移数为 0。目标既有状态及防重迁移回执保留。
- **稳定性**：QQ 六个群管理动作、相关交互、礼物/空间/口令整链及撤权/unknown 已按上述批次通过；定时任务的三个历史失败已分批关闭。上一轮 7 个媒体/骰子优先用例现已分批复验通过：`50dee79` 包中 Pixiv、视频分析宿主撤权、YouTube unknown 通过，骰子夹具修正后同包通过；本批视频分析整链及最终包附件成功/unknown 重启亦通过。`29f7bb7` 已推送 main 并上线，不再将历史 49 直接称为当前失败数，也不将分批结果冒称完整全量一次通过。最初真实模型回合的三次 45 秒超时及长期改善仍需自然生产回合证据。
- **观测**：独立运行观测、配置版本、原生投递回执及完整会话追溯已部署；按本人、完整账号、会话、状态和 trace 筛选，并明确展示 unknown。网页受控阶段/原因及视觉 HTTP/响应终态诊断已随 `29f7bb7` 上线，历史自然失败根因仍待新回合证明。成功响应误标日志及旧 `reasoningEffort=low` 已在前批修复；长期超时是否改善仍需更多自然回合证据。
- **体验验收**：所有目标群、好友私聊、媒体客户端显示/播放、真实工具服务、长期运行和成长体验仍须分别验收，不能从一次成功发送外推。另两个旧账号尚需完成真实登录、Core 连接路由和明确的本人/会话绑定；其中一个旧账号保有人设绑定，不能自动套用主账号权限。这是未满足的接入前置条件，当前证据不能归为 Core 代码缺陷。
- **认知与管理**：统一认知首版已实现来源关系、跨场景自我、后台整理、文字/仿真接线和离线导入，随本轮归并；`cognition.enabled` 默认关闭，未部署或导入生产认知。实模对照、跨天体验与性能费用仍待验收。人物遗忘已接通持久分区清理及可恢复回执；总来源消费者仍有 unsupported 时不宣称全部资料物理清除。

上述状态依据[生产切换记录](architecture/agent-bindings-history.md#core-production-cutover)及[控制台阶段记录](architecture/agent-bindings-history.md#2026-11-18以机器人本人为中心的控制台工作区)。

## 文档分工与更新方式

| 入口 | 负责内容 |
| --- | --- |
| 本页 | 当前实现、部署、验证边界与尚未完成事项；状态变化时直接更新对应条目 |
| [角色与会话绑定](architecture/agent-bindings.md) | 宿主区别、配置示例、公共接口和运行合同 |
| [控制台使用说明](../console/README.md) | 两种宿主的界面、认证、配置保存与恢复操作 |
| [插件消息管道](architecture/message-pipeline.md) | Yunzai 插件管道的持久化、重试和可靠性边界 |
| [Core 历史验证记录](architecture/agent-bindings-history.md) | 按阶段保留候选、失败、复验、部署及原始证据位置；其中“当前”“下一步”只描述当时阶段 |

后续更新先在本页写明实现、验证或部署中哪一项发生变化，再将批次、版本与证据留在历史记录。设计提案与历史指标不自动升级为当前能力；README 和其他入口引用本页，不各自维护一套交付状态。
