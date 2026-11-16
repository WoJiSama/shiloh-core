# LLBot OneBot 层深拆：go-cqhttp 扩展 API 语义 + 消息段转换边界（吸纳路线图）

> 日期：2026-11-10
> 来源：LuckyLilliaBot v8.3.2（LLOneBot 系，QQ 协议端，GPL-2.0）
> 目的：把其 OneBot 11 实现的 **API 语义**与**消息段转换边界处理**吸纳进本项目，并排出落地路线。

## 0. 结论与红线

- LLBot 与本项目是上下游关系：它是协议端（等价 NapCat 的角色），我们是消费端。**我们吸纳的是语义知识与防御性处理，不是代码**。
- ⚠️ **许可证红线**：LLBot 为 GPL-2.0，本项目 MIT。禁止复制其任何代码；本文档为独立撰写的语义记录，落地实现须自行编写。
- LLBot 源码参考路径均以 `llbot:` 前缀标注（仓库根 = github.com/LLOneBot/LuckyLilliaBot）；本项目路径以 `src/` 直接标注。
- 核心判断：**我们不缺单个 API，缺一个类型化的 OB11 客户端层**。当前成功判定逻辑有 4 种重复实现（见 §1.2），先收敛骨架，再按 P1 清单补 API 才不会继续摊大饼。

## 1. 现状盘点（本项目）

### 1.1 已调用的 action 全集

发送类：`send_group_msg` / `send_private_msg` / `send_group_forward_msg` / `upload_group_file` / `upload_private_file`。
查询类：`get_msg` / `get_group_msg_history` / `get_private_msg_history` / `get_forward_msg` / `get_group_member_info` / `get_group_member_list` / `get_group_file_url` / `get_private_file_url` / `get_group_root_files` / `get_group_files_by_folder` / `get_group_notice`（读）/ `get_credentials`（NapCat 扩展）。
群管类：`delete_msg` / `set_group_ban` / `set_group_kick` / `set_group_card` / `set_group_leave`。
NapCat 扩展：`set_msg_emoji_like` / `send_like` / `send_group_poke` / `send_packet` / `grab_red_bag` / `nc_get_rkey`。

### 1.2 结构性欠账

- **无类型化客户端**：全部裸字符串 `sendApi(action, params)`，接口分散在 `src/contracts/qqTools.ts`、`groupAdmin.ts`、`reminder.ts`、`bananaTool.ts`、`commitments.ts`、`dice.ts` 等处。
- **成功判定 4 处重复**：`verifyOneBotReceipt`（`src/modules/messaging/infrastructure/deliveryGateway.ts:190`）、`normalizeDeliveryReceipt`（`src/modules/messaging/domain/deliveryReceipt.ts:3`）、`apiOk`（`src/modules/qqTools/infrastructure/qqToolRuntime.ts:4`）、内联 `status==="failed"||retcode!==0`（DiceManager / GroupGuardManager）。
- 兼容性约束：`src/modules/messaging/application/outboundThrottle.ts:258-357` monkey-patch 了所有 adapter 的 `sendApi`（审查+延迟+令牌桶，action 白名单 `:25-31`），任何新封装必须保持走 `sendApi` 通道。

## 2. LLBot go-cqhttp 扩展 API 语义目录

通用信封：`{status:"ok"|"failed", retcode:0, data|null, message, wording, echo}`。**判成功只看 `retcode===0 && status==="ok"`，不要看 HTTP 状态码**（LLBot 处理器错误 HTTP 也回 200/retcode 200，WS 回 1200；schema 错 400/1400）。每个 action 注册三个 wire 名：`<action>`、`<action>_async`、`<action>_rate_limited`。布尔参数普遍接受 bool 或字符串。

### 2.1 消息 / 历史 / 转发

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `get_group_msg_history` | `message_seq` 是 **seq 而非 message_id**；`count` 默认 20，`count:0` 返回空数组；默认旧→新，`reverseOrder` 翻转；协议端按 30 条窗口补洞直到凑够 count | 已用；注意我们 `GrabRedBagTool`/`excelFileContext` 传 `{group_id,count}` 未传 seq，语义正确 |
| `send_group_forward_msg` | 节点两种风格都收：gocq 式 `{name,uin}` 与 ob11 式 `{nickname,user_id}`；`data.id` 可引用已存在消息自动展开；缺 `seq`/`time` 自动补齐（随机 seq 基数）；响应含 `message_id` + **`forward_id`（resId 字符串）** | 已用 gocq 式节点（`deliveryGateway.ts:78-87`）；`forward_id` 目前被我们丢弃，可留档用于二次转发 |
| `get_forward_msg` | **参数必须传 `forward_id`（resId 字符串），不是整数 message_id**；响应 `{messages:[{content, sender:{nickname,user_id}, time, message_format, message_type}]}` | 已用；`GroupModerationManager.flattenForwardNodes` 的多形态兼容（`data.messages||data||messages`）保留 |
| `send_private_forward_msg` | 同 forward 语义，私聊侧 | **未用**——`outboundThrottle.ts:25-31` 白名单里有但从不派发；P1 采纳（风控证据私发管理员可改为合并转发，省屏幕） |
| `get_msg` | 响应含扩展字段 `message_seq`/`real_id`(=seq)/`status:"normal"|"deleted"`（服务器查不到但缓存有 → `deleted`） | 已用；可顺手消费 `status` 判断"已撤回" |
| `mark_msg_as_read` | `{message_id}`，`data:null` | **未用**；P2（仿真潜水行为可选项） |

### 2.2 精华消息

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `get_essence_msg_list` | **LLBot 未暴露分页参数，底层 webapi 默认只取前 20 条**；响应是裸数组（不包 `data.list`）：`sender_id/sender_nick/sender_time/operator_id/operator_nick/operator_time/message_id`。**注意：`message_id` 是读取时新铸造的 shortId，非消息原 id**；解析不到原消息的条目被静默跳过 | **未用**；P1。NapCat 实现支持分页（gocq 原版有 `page/pageSize`），封装时参数可选、消费端按"最多 N 条"处理，不假设全集 |
| `set_essence_msg` / `delete_essence_msg` | `{message_id}`；需群管理权限；`data:null` | **未用**；P1（群管面板） |

### 2.3 群公告

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `_send_group_notice` | **wire 名带前导下划线**（gocq 遗产）。参数：`group_id, content, image?(URI), pinned=false, confirm_required=true, is_show_edit_card=false, tip_window=false(注意语义反转), send_new_member=false`。`send_new_member→typ 20`，`tip_window` 取反映射 | **未用**；P1。封装时同 action 双名尝试（`send_group_notice` / `_send_group_notice`），与我们读公告的双名兼容一致（`hostGroupContext.ts:22`） |
| `_get_group_notice` | 响应数组：`notice_id(fid), sender_id, publish_time, message:{text, images:[{id,width,height}]}`（宽高是**字符串**），`settings:{...五个布尔}`；`feeds` 与 `inst` 合并后按 `publish_time` 降序；空时字段缺失默认 `[]` | 读侧已有防御性解析（`hostGroupContext.ts` 挖掘式取 text），无需改 |

### 2.4 群文件

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `get_group_root_files` | `{files, folders}`；协议端**自动翻页拉全**，客户端无需分页；`file_size` 是 number | 已用（`excelFileContext.ts` BFS 深度 8） |
| `get_group_files_by_folder` | **`folders` 恒为 `[]`**（QQ 目录内不返回子目录） | 已用；消费端不要依赖 folder 内的子目录 |
| `get_group_file_system_info` | `{file_count, limit_count, used_space, total_space}` | **未用**；P2（控制台群文件容量展示） |
| `get_group_file_url` | `{group_id, file_id}`（`busid` 被忽略）；URL 是 **rkey 签名的、会过期**，每次现取，必须立刻下载；缓存命中时 URL 末尾附加编码后的 fileName | 已用；我们已有 rkey 过期重建逻辑（`fileUtils.ts:26-169`），继续保持"取 URL 即下载"模式 |
| `upload_group_file` | `folder` 与 `folder_id` 同义（`folder` 优先）；上传同时发一条群文件消息；响应 `{file_id}`；文件名含 `/` 或 `\` 报错 | 已用 |
| `create_group_file_folder` / `delete_group_file`(busid 默认 102) / `delete_group_folder` | 均 `data:null`，错误为 `clientWording` | **未用**；P2（群文件管理工具完整化） |

### 2.5 媒体 / 文件获取

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `get_file` | `file`/`file_id` 二选一；响应 `file`(本地绝对路径)、`url`(仅 Pic/Video/Ptt 有)、`file_size`(**字符串**)、`file_name`；rkey 每次刷新 | **未用**；P1。作为 `nc_get_rkey` 重建失败后的兜底通道（协议端代下载） |
| `get_record` | `{file, out_format}`；silk 经 silk-wasm 解码、amr 经 ffmpeg；响应同上 | **未用**；P2（语音转文字工具链的取源步骤，若接 ASR） |
| `ocr_image` | `{image}`（http URL / 缓存名 / 本地 URI 均可）；响应 `{texts:[{text, confidence, coordinates:[{x,y}]}], language}` | **未用**；P1。作为模型识图前置/兜底（成本低、结构化坐标可用于遮挡判断） |
| `download_file` | `base64` 优先于 `url`；`thread_count` 被忽略；无名文件落盘后**重命名为 md5**；响应 `{file}`(协议端本地路径) | **未用**；P2。注意：返回的是协议端机器上的路径，对我们价值有限（除非与 NapCat 同机） |

### 2.6 资料 / 系统

| action | 关键语义 | 采纳 |
| --- | --- | --- |
| `get_stranger_info` | 富字段：`nickname/sex/age/qid/level/login_days/reg_time/long_nick(bio)/city/country/birthday_*/labels/is_vip/is_svip/vip_level/remark` | **未用**；P1。画像模块（人物画像自动注入）的数据增强源 |
| `get_group_at_all_remain` | `{can_at_all, remain_at_all_count_for_group, remain_at_all_count_for_uin}` | **未用**；P1。**发送含 @全体 消息前的预检**（LLBot 对超限 @全体 是静默丢弃，见 §4.2） |
| `get_group_system_msg` | `{invited_requests:[{request_id,invitor_uin,invitor_nick,group_id,group_name,checked,actor}], join_requests:[{request_id,requester_uin,requester_nick,message,group_id,group_name,checked,actor}]}`；`checked`=已处理，`actor`=处理人 uin（0=无人） | **未用**；P1。补强 `GroupGuardManager`：入群验证的可审计名单（谁处理了、谁没处理） |
| `set_group_special_title` | `{group_id,user_id,special_title}`（空串清除） | P2 |
| `send_group_sign` / `set_qq_profile` / `set_group_portrait` / `delete_friend` | 均 `data:null`；`set_qq_profile` 常触发风控 `UpdateUdcFail` | 不采纳（玩具/风险项） |
| `.handle_quick_operation` | **wire 名带前导点**；fire-and-forget（`data:null` 立即返回，动作异步执行）；`ban` 默认时长 **1800 秒** | 不采纳——我们已有原生化等价操作（`delete_msg`/`set_group_ban`/`set_group_kick` 同步可验证回执），quick-op 的不可确认性与我们"回执必须可验证"原则冲突 |

## 3. Wire 层陷阱清单（封装层必须防御）

1. **`message_id` 是有符号 int32，可为负数**（LLBot 用 md5 前 4 字节 `readInt32BE` 铸造）。`message_id || seq` 的 falsy 判断在 id=0 时误落 seq——现有 `RecallTool.ts:53` 写法恰有此理论边界，封装层统一为 `?? ` 语义。
2. **三个 action 带特殊前缀**：`_send_group_notice`、`_get_group_notice`（下划线）、`.handle_quick_operation`（点）。封装层对公告读写做双名兼容。
3. **`get_forward_msg` 吃 resId 字符串**；`forward` 段的 `id` 就是 resId。我们 `extractForwardIdFromSegment` 已兼容 `resid` 字段（`conversation/domain/messageSegments.ts:43-58`），保持。
4. **媒体 URL 必过期**（rkey 签名）：任何持久化 url 的地方都要视为"短暂有效"。归档层（`messageArchive.ts`）已只存摘要键，维持现状。
5. **`file_size` 类型不统一**：`get_file`/`get_record`/公告图片宽高是**字符串**，群文件列表里是 number。解析统一 `Number()` 归一。
6. **响应形态不统一**：`get_essence_msg_list`/`_get_group_notice` 返回**裸数组**，其余包 `data` 对象。封装层对 `Array.isArray(data)?data:data.list??[]` 归一。
7. 空列表也是 `retcode:0`——"没数据"不是错误。

## 4. 消息段转换：边界目录与对照

LLBot 的转换层是"NTQQ 原始元素 ↔ OB11 段"的完整映射（`llbot:src/onebot11/transform/message/incoming.ts` / `outgoing.ts`）。我们消费 NapCat 上报，两者同源（NTQQ），**LLBot 的边界行为即 NapCat 行为的高保真投影**，防御口径应向它对齐。

### 4.1 入站（协议端 → 我们）边界

| # | 边界行为 | 我们现状 | 动作 |
| --- | --- | --- | --- |
| I1 | **`reply` 段解析失败被静默丢弃**——被引用消息过期/缓存 miss 时，整条消息照常上报但没有 reply 段 | 未见显式防御 | P0：引用上下文构建（`messageFormatting.ts` buildMessageContent）不得假设 reply 存在；缺失时降级为普通消息 |
| I2 | `reply` 段**只有 `id` 字段**（无 seq/sender/uin/time）——跨实现只保证 `data.id` | `taskStatus.ts:309` 已双写 `id`；读取侧 | P0：引用读取只依赖 `data.id`，其余字段当增强信息 |
| I3 | `image` 段 `subType` 是**驼峰**（CQ 里也是 `subType=…`），而 `face` 段是 `sub_type`——同协议两风格 | 贴纸检测读 `sub_type`（`expressionSequence.ts:14-38`） | P0：读侧兼容 `sub_type \|\| subType`（顶层与 data 双处） |
| I4 | `mface`（商城表情）段：`summary` 即**降级文本**（旧客户端显示的字面文案），`url` 是本地合成的 `gxh.vip.qq.com/…/raw300.gif`，`emoji_id/emoji_package_id/key` | 检测到 mface 但文本化时丢弃 | P1：`extractReadableTextFromSegments` 对 mface 输出 `[表情:${summary}]`，归档与记忆链路获得可检索文案 |
| I5 | `forward` 段 `id`=resId 字符串；**事件不展开嵌套内容**，必须二次调 `get_forward_msg` | 已兼容（`resid` 读取 + 深度 4 递归展开上限 120 行/9000 字） | 保持 |
| I6 | `face` 段 `sub_type`=faceType（数字，非标准）；`faceIndex 358→dice`（`result` 为字符串 1-6）、`359→rps`；`faceType 5 & faceIndex 1→shake`（窗口抖动） | face 一律 `[表情:id]` | P1：dice/rps 单列 `[骰子:点数]`/`[石头剪刀布]`，喂给骰娘语境与记忆 |
| I7 | 群文件消息**同时产生** `message` 事件（file 段）+ `notice.group_upload` 事件 | 未确认去重 | P0：核查统计/记忆链路是否双计（`riskSignalMonitor`/`messageArchive`） |
| I8 | `video.url` 可为空串回退 `file://` 本地路径；群 `file` 段 `url` 恒为 `''`（群文件真 URL 要走 `get_group_file_url`） | fileUtils 已有 rkey 重建与多字段回退 | P1：`file` 段 url 为空时明确走 `get_group_file_url(group_id, file_id)` 通道，而非拼 URL |
| I9 | sender 链：群 `card` 可为**空串**（不回填昵称）；昵称链 `member.nick → sendMemberName → sendNickName`；`level` 可为 `'0'`；role 由消息侧而非成员列表（手表协议下成员接口可能被拒） | `hostEvent.ts` 已裁剪 sender；`getForwardSenderName` 链正确 | P0：确认裁剪前 card 为空串时的昵称回填（`card \|\| nickname`，防 `card:''` 穿透） |
| I10 | `post_type:"message_sent"` 自身消息事件（连接级 opt-in），带 `target_id`；`font` 恒 14；debug 模式有 `raw`/`raw_pb` 额外字段 | — | 知悉即可；自身消息过滤维持 user_id===self 判定 |
| I11 | CQ 文本转义：**文本段逗号不转义**、`[`/`]`/`&` 转义；CQ 参数键仅 `\w+`（不支持连字符）；未转义 `,`/`]` 破坏解析 | 我们不以 CQ 字符串为主通道 | 知悉；raw_message 兜底解析时注意 |
| I12 | 未知元素**静默丢弃**（location/music/share/contact 入站即弃或仅 json 承载）；钱包红包段 LLBot 无分支（NapCat 有 `wallet`） | GrabRedBagTool 已消费 wallet | 保持 NapCat 特有分支 |

### 4.2 出站（我们 → 协议端）边界

| # | 边界行为 | 我们现状 | 动作 |
| --- | --- | --- | --- |
| O1 | `send_msg` 拒绝 `node` 段（硬错误，提示走 forward 专用 action） | 已分离（`deliveryGateway.ts:325`） | 保持 |
| O2 | forward 节点：gocq 式 `{name,uin,content}` / ob11 式 `{nickname,user_id,content}` 均可；`data.id` 引用已有消息自动展开；seq/time 自动补齐 | 已用 gocq 式 + `uin` 匿名回退 80000000 | 保持；`forward_id` 响应字段 P1 留档（`compactReceipt` 可选记录） |
| O3 | **`@全体` 超配额或非管理时被静默丢弃**（不打招呼） | 未知 | P1：发送含 `at:all` 前调 `get_group_at_all_remain` 预检，不满足则降级为文本"(@全体成员)"并告警一次 |
| O4 | 私聊中 `at` 段（非 all）被静默丢弃 | 私聊路径未发 at | 知悉；私聊模板禁用 at |
| O5 | 图片发送 `url` 字段优先于 `file`（协议端代下载，403 时带 Referer 重试一次）；裸文件名/uuid 会查协议端缓存再代下载 | `toOneBotContent` 是反向：url→file 拷贝（`deliveryGateway.ts:73`）——让我们优先走 `file`（file:///base64://），避免协议端回环下载我们自己的 URL | 保持现方向，语义更优 |
| O6 | `music` 自定义卡在 LLBot 需签名服务器（失败**整体抛错**）；NapCat 原生支持 `{type:"custom"}` | SearchMusicTool 已用 NapCat 原生 | 保持；失败路径注意回执校验即可 |
| O7 | `record` 发送：非 silk 音频协议端自动转码（ffmpeg→silk）；`video` 1GB 硬限 | 发 record 走本地路径 | 知悉 |
| O8 | 超级表情/骰子类（serviceType 37）**仅单元素消息存活**，混排被腾讯降级或拒绝 | — | 知悉（若做表情工具避免混排） |

## 5. 吸纳路线图

### P0 — 解析加固与骨架收敛（纯防御，零新功能）

1. **新增 `src/contracts/onebot.ts`**：类型化 action 名/参数/响应接口 + 单一 `isObOk(res)` 判定（`retcode===0&&status==="ok"`），四处重复收敛于此。实现层各模块 `infrastructure/` 继续自带调用，但成功判定与响应归一（裸数组、字符串数字、`??` id 语义）统一引用。
2. 入站防御四项：I1（reply 静默缺失容忍）、I2（reply 只依赖 `id`）、I3（subType 驼峰兼容）、I9（空 card 回填昵称）。
3. I7 排查：群文件 message+notice 双事件是否在统计/记忆双计，双计则按 `file_id` 幂等。
4. §3 陷阱 1：`message_id || seq` → 显式 `?? / !== undefined` 语义（RecallTool 等）。

### P1 — 新 API 封装（对齐模块落位）

| 新能力 | action | 落位 |
| --- | --- | --- |
| 协议级 OCR | `ocr_image` | `qqTools/infrastructure/OcrTool.ts`（识图工具兜底） |
| 群公告写入 | `send_group_notice` 双名 | `groupAdmin/infrastructure/GroupNoticeManager`（管理面板） |
| 精华消息管理 | `get_essence_msg_list` / `set_essence_msg` / `delete_essence_msg` | `groupAdmin/infrastructure/`（面板 + 群管工具） |
| 陌生人资料 | `get_stranger_info` | `memory/`（画像增强，bio/城市/注册时间入用户事实） |
| @全体预检 | `get_group_at_all_remain` | `messaging/application/outboundThrottle`（at:all 前置闸） |
| 入群请求审计 | `get_group_system_msg` | `groupAdmin/infrastructure/GroupGuardManager` |
| 私聊合并转发 | `send_private_forward_msg` | `deliveryGateway`（风控证据私发管理员改转发） |
| 媒体兜底取回 | `get_file` | `shared/infrastructure/fileUtils`（rkey 重建失败后的第二通道） |
| 转发 resId 留档 | （响应字段 `forward_id`） | `compactReceipt` 可选记录 |

### P2 — 观察项（有场景再动）

`mark_msg_as_read`（仿真潜水）、`get_group_file_system_info` + 文件夹增删（控制台群文件页完整化）、`get_record`（接 ASR 时）、`download_file`（与协议端同机部署时才有意义）、`set_group_special_title`。

### 不采纳

`.handle_quick_operation`（异步不可验证，与回执原则冲突）、`set_qq_profile`/`send_group_sign`/`delete_friend`（风控/玩具）、`set_group_portrait`（无场景）、`message_style` 等非标准 forward 节点扩展（NapCat 不支持，写了对端也不认）。

## 6. 验证方式

- P0 各防御点配单测：构造协议端最小事件样本（含负 message_id、空 card、驼峰 subType、无 reply 段的引用消息）过 `messageSegments`/`messageFormatting`/`expressionSequence`。
- P1 每个 action 封装先过影子机器人 E2E（注入假 OneBot 客户端，伪造 §2 表中的响应形态——注意裸数组与字符串数字两个坑），再灰度单群。
- `at:all` 预检与精华/公告类操作在管理群留观测流水（`#观测日志` 格式）。
