# WorkBuddy Control

## 用途和状态

`workbuddy-control` 是一个 MCP（Model Context Protocol，模型上下文协议）插件，通过 WorkBuddy 官方 Jobs API（任务接口）让 Codex 启动、查看、取消和继续 WorkBuddy Agent（WorkBuddy 智能体）任务。

当前状态：Jobs API 后台模式**可用**。已在 Windows 上通过真实 MCP E2E（端到端）验证；MCP `initialize` 和 `tools/list` 均通过，并确认五个后台工具已注册。

## 架构

```text
Codex
  ↓ MCP（模型上下文协议）
workbuddy-control
  ↓ 启动本地 codebuddy --serve
Jobs API（任务接口）
  ↓
WorkBuddy Agent（WorkBuddy 智能体）
```

上述稳定模式通过本地 `codebuddy --serve` 暴露的官方 Jobs API 工作，不连接 WorkBuddy Desktop 的私有 IPC（进程间通信）。

### Desktop Mode POC（桌面模式概念验证）

可选 Desktop Mode 当前是 **WIP / 开发中**，仅锁定 WorkBuddy 5.5.2，不是稳定可用功能。它通过当前用户的 Windows Named Pipe（Windows 命名管道）连接随插件安装的 WorkBuddy Desktop Extension（桌面扩展），再调用 WorkBuddy Desktop 的 `session:*` RPC（远程过程调用）与精确的 `conversations.requestEntries` 只读历史投影，使任务使用真实 Desktop Session（桌面会话），而不是把 Jobs API 结果镜像到 GUI（图形用户界面）。

POC 已实现 `workbuddy_run_desktop`、`workbuddy_status_desktop`、`workbuddy_result_desktop`、`workbuddy_resume_desktop` 和 `workbuddy_cancel_desktop`。真实 Session 创建、左侧会话列表出现、文件修改、状态、同会话续接和取消已验证；完整 Prompt、Assistant 消息、Tool Call（工具调用）和 Tool Result（工具结果）的 GUI 展示仍未完成完整自动化 E2E 验收，因此不能把 Desktop Mode 作为稳定功能使用。

`workbuddy_resume_desktop` 在发送前读取真实 Session；Session 仍在处理时会拒绝续接，不排队、不取消，也不创建新 Session。`workbuddy_status_desktop` 直接返回 WorkBuddy 5.5.2 可取得的处理、输入等待、活动工具和活动时间字段，并在持续处理且五分钟没有 Assistant / Tool 活动时只报告 `stalled`。活动工具是 `TaskOutput` 时会返回 `waitingTaskOutput: true`；插件不会猜测 PID、解析命令或自动终止进程。

## MCP 工具

- `workbuddy_run`：提交 `cwd`（工作目录）和 `prompt`（任务提示），返回 `jobId`（WorkBuddy 任务 ID）。
- `workbuddy_status`：读取任务状态、是否已结束以及可用的状态详情。
- `workbuddy_result`：读取任务结果；任务未结束时返回 `ready: false`。
- `workbuddy_cancel`：向官方 Jobs API 发送停止请求。
- `workbuddy_resume`：向同一个任务发送下一条提示，保留原有 `jobId` 和 WorkBuddy `sessionId`（会话 ID）。

## 前置条件

- Windows，并能运行 PowerShell 7（`pwsh`）。
- 已安装 Node.js（JavaScript 运行时），并能运行 `pnpm` 或 `corepack pnpm`。
- 已安装 WorkBuddy，并且当前用户至少启动过一次 WorkBuddy，使其生成本地产品配置文件。

## 安装和检查

从仓库根目录克隆后进入插件目录：

```powershell
git clone https://github.com/wwxst/coding-agent-controllers.git
cd coding-agent-controllers\workbuddy-control
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

标准安装只配置稳定的 Jobs API 模式，不安装可选 Desktop Extension：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

只在 WorkBuddy Desktop 版本恰为 5.5.2 且需要验证 WIP POC 时显式启用 Desktop Mode：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -EnableDesktopMode
```

版本检查在复制 Desktop Extension 前完成；其他版本会停止 Desktop POC 安装，但标准 Jobs API 安装不受影响。安装完成后，必须完全退出并重新启动 Codex，才能加载 WorkBuddy MCP 工具；启用 Desktop Mode POC 后还必须完全退出并重新启动 WorkBuddy Desktop，使扩展生效。

使用 Doctor（诊断脚本）检查本地依赖、构建输出、WorkBuddy 路径、Desktop Extension、Named Pipe 和 MCP 握手：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

卸载 MCP 配置、插件生成的启动器和本插件拥有的 Desktop Extension：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载不会修改仓库源码或 WorkBuddy。

### 非交互 PowerShell 权限

外层命令使用 `-NoProfile -ExecutionPolicy Bypass` 运行脚本；`setup.ps1` 编译本地启动器时，会调用 `powershell.exe -NoProfile -NonInteractive`。`-NonInteractive` 表示该步骤不能等待交互式确认，`-ExecutionPolicy Bypass` 也只作用于当前 PowerShell 进程，不会授予管理员权限或修改系统执行策略。运行账号需要能够写入仓库目录和当前用户的 Codex 配置目录；如果企业策略阻止脚本执行，应先按本机策略允许该命令。

## 多电脑部署

每台 Windows 电脑都应独立完成以下步骤：安装 Node.js 和 WorkBuddy、至少启动一次 WorkBuddy、单独克隆本仓库，然后在该电脑上运行 `scripts/setup.ps1` 并完全重启 Codex。

配置文件、WorkBuddy 产品配置、Node.js 路径和 Codex 启动器路径都属于当前用户和当前电脑，不应直接复制另一台电脑生成的 `config.toml`、启动器或路径配置。移动仓库目录后，需要在新位置重新运行 `setup.ps1`。

## Directory Trust（目录信任）

WorkBuddy 可能要求任务工作目录先获得目录信任。此时 `workbuddy_status` 会报告 `blocked`（阻塞）状态，并保留 WorkBuddy 返回的详情，例如 `Directory trust required`。插件不会绕过这项安全检查；请先按 WorkBuddy 的提示完成目录信任，再重新发起或继续任务。

## 安全边界

- 不复制或持久化 Token（令牌）和 Cookie（会话 Cookie）。
- 稳定的 Jobs API 后台模式不连接 WorkBuddy Desktop 私有 IPC。
- Desktop Mode POC 只通过本插件的 Named Pipe 薄桥调用 WorkBuddy Desktop `session:*` RPC 与 `conversations.requestEntries` 只读历史投影；Pipe 使用受保护的 DACL（Discretionary Access Control List，自主访问控制列表），只授予当前 Windows 用户 SID（安全标识符）。它不连接 sidecar 私有 token（边车私有令牌），不直接调用 ACP（Agent Client Protocol，智能体客户端协议），也不复制 WorkBuddy 登录态。
- 不通过浏览器控制 GUI（图形用户界面）。
- 产品配置通过 `ACC_PRODUCT_CONFIG_PATH`（配置文件路径）传递，不把完整配置内容复制到 Windows 环境变量。

## 当前限制

- 当前版本仍依赖插件目录中的本地 `node_modules`（Node.js 依赖）和 `lib`（构建输出）；移动或删除仓库目录后需要重新运行 `setup.ps1`。
- 自包含 bundle（自包含打包）尚未完成。
- Marketplace（插件市场）尚未作为完整安装方式支持；当前安装方式是克隆仓库后运行 `scripts/setup.ps1`。
- Desktop Mode 仅验证 WorkBuddy 5.5.2，仍是 WIP POC，尚未完成完整 GUI E2E 验收。

## 最小使用示例

在 Codex 中调用：

```text
workbuddy_run
{
  "cwd": "E:/work/my-project",
  "prompt": "运行测试，修复失败并报告验证结果"
}
```

工具返回 `jobId` 后，可按需读取：

```text
workbuddy_status({ "jobId": "<jobId>" })
workbuddy_result({ "jobId": "<jobId>" })
```

任务仍在运行时，继续执行：

```text
workbuddy_resume({
  "jobId": "<jobId>",
  "prompt": "继续处理上一个失败点，并重新运行相关测试"
})
```
