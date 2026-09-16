# WorkBuddy Control

`workbuddy-control` 通过 WorkBuddy 官方 Jobs API 为 Codex 提供任务启动、状态查询、结果读取、取消和继续执行能力。

## 前提

- 已安装 WorkBuddy。
- 已至少启动一次 WorkBuddy，使当前用户目录生成产品配置。
- 已安装 Node.js，并能通过 `pnpm` 或 `corepack pnpm` 运行 pnpm。

## 安装

```powershell
git clone https://github.com/wwxst/coding-agent-controllers.git
cd coding-agent-controllers\workbuddy-control
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

安装完成后，完全退出并重新启动 Codex，使 WorkBuddy MCP 工具生效。

## 检查

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

## 卸载

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载脚本只移除 WorkBuddy MCP 配置和本插件生成的启动器，不修改仓库源码或 WorkBuddy。

## 当前限制

- 当前版本仍依赖仓库目录中的本地 `node_modules` 和 `lib` 构建输出；移动或删除仓库目录后需要重新运行 `setup.ps1`。
- Marketplace 尚未作为完整安装方式支持；当前以 clone 仓库后运行 `setup.ps1` 为准。
