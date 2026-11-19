#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MESSAGE'
旧 Yunzai / bl-console 部署入口已退役，本脚本不会连接或修改服务器。

当前生产使用独立 Core，由 bl-chat-agent.service 同时运行聊天宿主和控制台。
在源码仓库完成验证后构建独立包：
  npm run verify:phase
  npm run agent:pack

将生成的 .release/agent-* 包及其生产依赖交付到新的发布目录，校验
release-manifest.json 后切换 /opt/bl-chat-agent/current，再重启 bl-chat-agent。
宿主配置继续使用 /opt/bl-chat-agent/config/agent-host.yaml。
服务定义见 scripts/bl-chat-agent.service；配置、校验与启动说明见
docs/architecture/agent-bindings.md 的“独立 QQ 宿主”一节。
MESSAGE
exit 1
