# Core 历史验证记录

本页保留截至 2026-11-18 的阶段记录及当时证据。候选包、局部通过、失败与复验各自保留；文中的“当前”“本批”“下一步”均指相应历史阶段，不作为今天的项目状态。

当前交付范围、部署快照与剩余工作统一见[项目当前状态](../project-status.md)，配置与接口见[角色与会话绑定](agent-bindings.md)。`/tmp` 证据路径属于原验证环境，迁移记录不保证这些临时文件长期存在。

## 功能专项的历史验证

<a id="video-attachments-verification"></a>

### 视频附件与普通群文字的阶段验证

本批集中后端构建2346文件（TypeScript5.9.3），后端及测试严格类型检查、Core边界与CI YAML检查通过。真实Redis的普通群文字15项验证搜索续轮、单次完整交付、来源正文/时间替换、generation替换、动作槽领取后撤权、暂存后复核、隐私取消、历史回合禁止外发，以及unknown重启防重。新实际CLI3项使用真实独立进程、Redis、OneBot WebSocket和HTTP资源桥：群文字搜索后匿名QN16获取同作品两个不同完整MP4分段，按字节和SHA256核验一个三节点forward；确认后零额外文字，unknown同源重复与重启均不重发或追加模型调用；默认关闭零媒体桥及零官方API请求。官方HTTP响应、媒体与缩略图进程和OneBot回执均为明确本地替身，未请求真实B站。另有152项相邻回归及75项重新编译的仿真领域测试通过。

候选`.release/agent-Om75JX`仅生成一次，真实npm归档在仓库外按锁离线安装，再在安装包自身目录按原始shrinkwrap离线npm ci：512个依赖版本精确一致、19个可选平台依赖省略，无源码或依赖符号链接替代。16组349项安装后专项全部通过，失败/取消/跳过均零，其中包含新附件3项和原搜索3项实际CLI。公共严格TypeScript消费者实际运行、外部宿主及启动篡改保护通过；440个运行/声明文件与当前构建逐字节一致，447个发布文件校验通过。最终发布目录仅同步本段README及清单，运行/声明文件保持已验归档一致。证据：`/tmp/bl-video-attachments-package-proof.json`、`/tmp/bl-video-attachments-{installed-suites,public-consumer,cli,regression,domain}.log`，文档同步后文件一致性见`/tmp/bl-video-attachments-release-equality.json`。

本地首轮346项构建专项为345通过、1项测试同步断言失败：计数在异步来源读取完成前增加，测试提前修改来源，正确拒绝后没有第二次检查。仅改为等待首次核验成功再撤权，保留全部检查次数、发送和配额断言，整份17项复验通过；最终349项安装专项整批全绿，未重新构建。证据：`/tmp/bl-video-attachments-built-suites.log`与`/tmp/bl-video-attachments-relay-test-synchronization.log`。工程红例还核验并修复了来源正文/时间改变后仍发失败说明、旧列表序号跨模型续轮误选新列表、QQ排队/暂存后丢失异步来源复核；单次整批构建后没有修改产品代码。真实B站服务、模型选择质量及QQ客户端显示/播放仍单独待验收，本批无生产部署、数据迁移或新增线上QQ发送。

<a id="bilibili-quality-verification"></a>

### B站高清与扫码授权的阶段验证

本批高清/auth提供器、持久工作流、QQ原请求者通知和独立主机接线已实现并完成集中工程验证：一次后端构建2346文件（TypeScript5.9.3）、后端及测试严格类型检查与Core边界检查通过。10组257项专项在构建代码和仓库外安装包各通过一次，零失败、取消或跳过；包含4项实际CLI，覆盖扫码原生私发确认后才轮询、群/好友私聊授权、私有凭据持久化、QN80请求实际QN64完整媒体桥交付，以及QR/媒体unknown冻结。官方HTTP内容、缩略图进程和OneBot服务使用明确合成依赖，Redis、CLI进程、WebSocket及制品桥实际运行。363项不同的安全、仿真域、团录、音乐/磁链/媒体与日志定向回归通过；其中1条旧提示词断言仍要求搜索直接发送，已按当前只返回列表的合同修正，重新编译并复验整个75项域测试通过，未因此重构建后端。

候选`.release/agent-nRziY3`仅打包一次。真实npm归档在仓库外独立安装，再在已安装包自身目录按原始shrinkwrap执行离线npm ci：512个依赖版本精确一致，19个可选平台依赖省略，未使用源码或依赖符号链接替代。440个运行/声明文件与当前构建逐字节一致，447个发布文件校验通过；公共严格TypeScript消费者、外部宿主和启动篡改保护通过。初次离线安装遇到缓存缺项，获取缺失缓存后已完成消费端安装；在父目录使用npm --prefix的嵌套安装超时，改在安装包目录执行原锁离线npm ci后16秒完成，锁和发布代码未改。证据：`/tmp/bl-bili-quality-package-proof.json`、`/tmp/bl-bili-quality-{built-suites,installed-suites,public-consumer,regression,domain-recheck,nested-install}.log`。最终发布目录仅同步本段README和发布清单，运行/声明文件保持已验归档一致。

<a id="group-log-verification"></a>

### 团录的阶段验证

候选`.release/agent-coFd0A`已从真实npm归档在仓库外按原锁独立安装，录制/命令/隐私/恢复等66项及独立CLI/桥生命周期10项共76项通过，无失败、取消或跳过；证据为`/tmp/bl-group-log-coFd0A-installed-runtime.log`和`/tmp/bl-group-log-coFd0A-installed-cli.log`。这些是隔离Redis、本地真实CLI及合成OneBot证据，真实QQ群文件上传/收件仍待验收。旧团录只有裸群号、缺账号及Agent来源，不自动认领；旧骰子结果及规则事件还须独立可验证producer来源，不能伪造真人消息ID或把交付基础当作骰子业务迁移完成。

<a id="video-search-verification"></a>

### B站搜索与视频卡片的阶段验证

本批已完成一次集中后端构建（2310文件、TypeScript5.9.3）、完整后端及测试类型检查和Core边界检查。候选`.release/agent-e4Sysl`的真实npm归档在仓库外离线安装，再按包内原始shrinkwrap执行npm ci：491个依赖版本精确一致，19个可选平台依赖省略，无链接替代。安装后的9组137项测试全通过，失败/取消/跳过均零；公共严格TypeScript消费者实际运行查询/解析、既有外部宿主与篡改启动保护也通过。423个运行/声明文件与当前构建逐字节一致，430个发布文件校验通过。证据为`/tmp/bl-video-search-package-proof.json`、`/tmp/bl-video-search-installed-suites.log`和`/tmp/bl-video-search-public-consumer.log`。最终目录只同步本段README与清单，运行/声明文件保持已验候选一致。真实B站服务可用性、模型选用质量与真实QQ卡片显示/读回尚未验收，不把合成HTTP/OneBot回执当作客户端验收。

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

<a id="core-cutover-preparation"></a>

### 2026-11-18：直接切换独立 Core 的发布准备

用户已授权提交、推送、合并 main 和生产测试，并明确取消旧插件继续处理聊天的并行方案。发布采用停用旧插件宿主与旧控制台、现有在线 QQ 连接只连接 Core 的直接切换；新控制台沿用 8787 端口，配置声明 18 个群与 2 个私聊。原插件文件和 Redis 状态保留并另行备份。

生产原状态使用隐式 legacy 键，没有可供现有显式绑定迁移器验证的来源绑定；本次不伪造迁移来源。Core 使用独立数据分区，沿用人设、模型配置和会话白名单，旧历史记忆尚未自动导入。另两个原 QQ 容器目前未在线，不能以配置存在代替连接恢复证据。

新一轮工程门禁中，后端类型、架构边界及构建通过；前端类型、29 文件 347 项测试和构建通过。完整后端批次记录为 8199 项、8129 通过、49 失败、21 跳过，并非全绿。已修复安全日志、有效绑定、退休语义及来源引用等过期测试夹具，相关六文件 79 项通过；Chromium 真实渲染 28 项通过。群记忆独立 CLI 两项通过，视频搜索完整正常及未知回执流程单独复验通过。

部分媒体、QQ 动作与定时任务 CLI 仍存在耗时超限：性能采样证明嵌套 guard 的 fresh 配置文件复核占据主要执行时间，后台来源复核也会产生大量 get_msg；该证据不证明所有失败均由并发造成。保留授权、未知回执防重和取消边界，不以延长所有超时或跳过失败宣称全量通过。按用户允许先上线测试的决定，此类耗时问题保留为后续修复项；生产启动、认证、实际连接和加载版本另取真实证据。

<a id="core-production-cutover"></a>

### 2026-11-18：生产已直接切换至 Core

实现提交 `5acd1eecd2215d9ea0db4c9167beb56ed0f6f384` 已推送到开发分支并快进合并至远端 main。该提交构建的独立发布包包含 650 个清单文件，在服务器完成生产依赖安装与逐文件 SHA-256 校验后部署到 `/opt/bl-chat-agent/releases/5acd1eecd2215d9ea0db4c9167beb56ed0f6f384`，`/opt/bl-chat-agent/current` 指向该版本。后续测试或交付记录的提交不等于运行版本已改变，以实际发布清单为准。

`trss-yunzai`、`bl-console` 已停止并禁用自启，旧 2536 端口不再监听；原宿主以退出码 15 停止留下的 failed 状态已清理，未重新启动。`bl-chat-agent` 已启用并运行，首次核对 MainPID 为 3526044、NRestarts 为 0。NapCat 的反向连接列表仅保留 Core 一项，实际 QQ 3094088525 已认证并显示 connected。当前只有该账号上线，另外两个离线账号没有冒充已迁移上线。

实际 HTTP 核对：前端 200、未认证绑定请求 401、原令牌认证 200、工作区 200、绑定列表 200、配置版本状态 200；工作区为 standalone，3 个本人、1 条真实在线连接、18 个群及 2 个私聊绑定，加载与存储版本一致、phase=active、无需重启。新控制台继续监听 8787，浏览器已实际加载生产页面。原控制台没有可导入的用户名密码文件，本次沿用原访问令牌，没有创建或更换凭据。真实主模型接口另以中性探测输入取得 HTTP 200 和有效 completion，约 3.4 秒；该探测不等于真实 QQ 用户聊天验收。

停旧写入后生成的备份位于 `/opt/bl-chat-agent/backups/2026-11-18T06-43-28Z-direct-core`，含旧配置及 data 归档、完整 Redis RDB、NapCat 原配置和旧服务定义；归档约 198 MB、RDB 约 12 MB，均为 0600，gzip 与 redis-check-rdb 实际校验通过。旧插件目录及数据仍在原处，Core 使用新分区；不能将备份或新绑定装配称为历史记忆已导入。

生产回执为服务器的 `staging/direct-cutover-receipt.json`、`staging/direct-production-verification.json` 与 `staging/direct-production-final-readback.json`。本轮没有主动向群或私聊发送测试消息，真实用户入站、模型续聊与 QQ 业务回执尚需分别验收；部分重型工具链的超时和未装配能力继续保留，不能据启动及控制台通过宣称旧插件全部能力已经完成生产验收。

切换后的继续观察已出现自然业务证据：39 次 simulation_ingest 完成、9 次 simulation_main 成功，以及一次 simSendMessage 和原生 delivery 成功；这不是人工向群注入的测试。服务再次核对仍为 active、NRestarts=0，连接 connected、配置 active。该观察仅证明已有真实入站及一次发送路径，不覆盖所有群、私聊、工具或长期运行。模型日志中 `provider_error` 还会被旧执行器的成功响应 `logger.error` 误标，不能将该行数当作真实失败次数；初始回合也存在模型异常与运行警告，仍需后续按实际回合排查。

进一步只读确认该新实例存在一条仅由真实确认回执建立的 `agent:outbound:v1` 消息归属记录，未读取或公开聊天正文。初始三个真实模型异常均为 45 秒 TimeoutError，而非启动失败；这项超时与成功响应日志误标分别保留为后续修复问题。

配置差异已单独核对：旧开启的 BT 下载、磁力搜索尚未在新宿主装配，B站旧授权自动重试未延续（新配置为 false）；语音与四个 MCP 服务在旧配置中均关闭。图片及 QQ 动作的旧配置不足以确认启用状态，不推定能力已完整接续。历史自动导入、这些能力补齐及重型工具超时为下一继续点，整体 Core 目标保持进行中。

<a id="core-package-recovery"></a>

发布包的基础回归三文件本轮为 13/14 通过，长恢复用例未全绿。该用例的旧图片 URL/私聊媒体持久化预期已对齐为按来源重新读图、保留 text part，私聊撤回零发送断言已走过；恢复消息停止前增加真实历史提交及收件确认等待，避免把前一进程尚未确认的消息混入关闭私聊的断言。仅启动就绪窗口由 8 秒调至 15 秒，业务回执窗口及总时限不变。最终同例在后续装配文字群夹具时因 `groupState.recent` 已为空、旧夹具仍直接取末项 seq 而退出，日志 `/tmp/bl-production-essential-recovery-owned-final.log`；不能将已走过的私聊及恢复片段称为整条恢复测试通过。这些测试与交付记录修订不改变已部署的产品源码或发布包。

<a id="core-read-diagnostics-20261119"></a>

### 2026-11-19：图片同步观察、失败诊断与旧运行残留清理

`29f7bb7cd143dc88850f0c19e050c6c45a4a5312` 已提交、推送工作分支并快进远端 main，生产从 `6317c5b` 切至该提交的独立 663 文件包。Core 图片来源 predicate 复用已有纯同步配置观察；网页补 URL/授权/DNS/请求/重定向/响应的受控失败 metadata；视觉补 HTTP 与描述请求的开始/终态及安全状态码，不记录 URL、正文、图像、凭据或原始异常。权限、来源双读、取消、SSRF、原业务期限及 250 tokens 保留。

图片 Core 4/4、取消邻接 8/8、网页/公共图片 41/41、独立包视觉 CLI 1/1、外部 npm 归档公共 TypeScript 消费者 1/1 分批通过，均无失败/取消/跳过。旧视觉包同例明确失败于缺少 HTTP started 日志，新包同例全绿。筛选测试时定位到 recovery describe 在异步定义阶段提前启动 Redis，未选中 suite 的 after 不执行，导致报告后进程不退出；现将有副作用的 setup 移至 before，初始化顺序及 13 检查点的执行/跳过规则不变，首恢复检查点及视觉筛选均正常退出。未使用 force-exit 或延长业务期限。

干净提交重新构建后，874 个源码校验值及全部 2,607 个后端输出与已测候选一致；最终包 663 文件仅后端 manifest 提交字段改变。服务器生产依赖安装、工件门禁、CLI help、清单校验、QQ 认证、20 绑定、首页/认证/工作区/观测接口通过，未认证观测 401，配置四文件字节及 inode/ctime/UID/GID/mode 均保留。旧 Yunzai 与旧控制台仍为 not-found；另按 PID/startTicks/cwd/exe 校验后终止两项 11 月 3 日旧目录孤儿进程，Core PID 未变，未删除旧数据与迁移来源。

13:07 启动至 13:09:55 的只读样本有 4 次真实 QQ 入站，尚无新主模型或读图/网页诊断，未人工发送 QQ。历史自然回合缺少足以确认根因的 metadata；真实公共网页和合成纯色图模型探针成功只能证明基础传输/提供器可用，不能外推原目标已修复。采样显式以 UTC 读取进程启动时间；初次 CST 歧义样本不计业务证据。工程日志、归档等价证明及生产回执路径见项目当前状态本批记录。整体迁移仍进行中，真实媒体客户端、全部目标会话、另两账号前置条件、历史记忆来源及认知/完整遗忘保持原边界。
