# 群聊串线与主动跟进回放

已发布提交 `69d6a0bdfacb03ab7fcc94ec3e80362d22e403df`。在服务器隔离目录中使用生产 YAML 副本和合成群聊，模型调用走线上渠道。回放为每轮新建内存存储，发送由测试捕获。既有 QQ 群、生产 Redis 和工作器均未参与。

| 场景 | 核对内容 |
| --- | --- |
| 饼干、烤箱和 403 | 烤箱问题单独回答。回到饼干时保留工资与分半的语境。切到 403 时停止延续玩笑。 |
| 同时点名 | 同一合并窗口收到两次不同群友点名，两人都得到针对各自话题的回复。 |
| 只在自然聊天时接续 | 原话「碰巧聊到再问」仅保存为聊天记忆。两次空闲检查无主回合、无发言、无角色目标，群友说出结果后能正常接上。 |
| 明确邀请主动问 | 保存原话许可，到期只发一句文字、不带 @，重启后不再次追问。 |

`candidate-*` 保存初轮 15 个样本。`final-*` 保存之后的并发回放，含 5 个上游超时事件和 1 个正文写在发送参数外的行为漏回。修复正文问题后，用 `verified-*` 保存同一可发布构建的串行复测。自动化检查核对调用、持久化和发送，话题归属还逐条核对了捕获的回复。主模型 `glm-5.3`，社交许可审核模型 `glm-5.3-flash`。

串行复测每组 3 轮，共 12 轮、42 个事件、79 次实际模型请求，0 失败、0 跳过、0 行为未达。报告完整性、工程执行和预期行为均通过离线复核。发布工作树全量检查后端通过 3,309 项，2 项因缺 Chromium 跳过。前端 73 项通过。

烤箱和 403 是隔离话题的夹具。这些回放未针对建议的专业准确性设断言。部分烤箱回复包含把手伸入预热炉腔感受温度的做法，评审时没有计作合格的设备使用建议。

## 上线核验

部署脚本完成安装与健康检查。服务器回读为 `69d6a0bdfacb03ab7fcc94ec3e80362d22e403df`，编译清单 SHA-256 为 `b19264fff2c913171dd61641eb64d4749a2d5d65c197db5208ef42913fa71dc4`，与本地发布产物一致。Yunzai 与控制台均 active、NRestarts 为 0；插件加载错误 0，消息管线启动，命令页与控制台返回 HTTP 200。回滚快照 `20261113-121103`。生产 YAML 逐字节核对与回放副本一致。

## 回放文件

| 记录 | 事件数 | 失败 | 行为未达 | 实际请求 |
| --- | ---: | ---: | ---: | ---: |
| [candidate-cookies](candidate-cookies/results.json) | 25 | 0 | 0 | 43 |
| [candidate-quiet](candidate-quiet/results.json) | 20 | 0 | 0 | 26 |
| [candidate-welcome](candidate-welcome/results.json) | 20 | 0 | 0 | 40 |
| [final-cookies](final-cookies/results.json) | 25 | 1 | 1 | 39 |
| [final-quiet](final-quiet/results.json) | 20 | 1 | 0 | 30 |
| [final-simultaneous](final-simultaneous/results.json) | 5 | 1 | 0 | 19 |
| [final-welcome](final-welcome/results.json) | 20 | 2 | 0 | 45 |
| [verified-cookies](verified-cookies/results.json) | 15 | 0 | 0 | 24 |
| [verified-quiet](verified-quiet/results.json) | 12 | 0 | 0 | 16 |
| [verified-simultaneous](verified-simultaneous/results.json) | 3 | 0 | 0 | 12 |
| [verified-welcome](verified-welcome/results.json) | 12 | 0 | 0 | 27 |
