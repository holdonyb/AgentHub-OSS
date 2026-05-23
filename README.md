# AgentHub

## Personal Agent Control Plane / 个人 AI Agent 控制台

[![CI](https://img.shields.io/badge/CI-GitHub_Actions-334155)](.github/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-public_preview-f97316)](docs/OPEN_SOURCE_LAUNCH.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-0ea5e9.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-first-16a34a)](docs/SELF_HOST_QUICKSTART.md)
[![Tailscale](https://img.shields.io/badge/Tailscale-friendly-4f46e5)](docs/TAILSCALE_PRIVATE_MODE.md)

AgentHub unifies Codex, Claude, Kimi, OpenCode, and other local agent runtimes across your own machines.

AgentHub 把 Codex、Claude、Kimi、OpenCode 等本地 agent runtime 统一到一个私有控制面里。

Run the server on a laptop or a VM. Connect through Tailscale or your own HTTPS domain. Control many computers, many terminal sessions, and many agent backends from Web, Android, or Windows desktop.

你可以把自己的笔记本当 server，也可以部署到 VM；可以走 Tailscale，也可以走自己的 HTTPS 域名。多个电脑、多个终端、多个 agent 后端，统一在 Web、Android 和 Windows 桌面端里管理。

AgentHub is not a hosted SaaS and not a generic remote shell. Your agents keep running on your machines, with your files, your tools, and your runtime environment. AgentHub is the session inbox, control surface, worker relay, and audit trail around them.

AgentHub 不是托管 SaaS，也不是任意远程 shell。agent 仍然运行在你的机器上，使用你的文件、工具和环境；AgentHub 负责会话收件箱、控制界面、worker 接入和审计记录。

## What It Does / 它解决什么

- **One inbox for every agent session.** See local Codex, Claude, Kimi, and OpenCode sessions in one place.
- **统一会话收件箱。** 把本机和远程机器上的 Codex、Claude、Kimi、OpenCode 会话放到同一个入口。
- **Multi-machine control.** Register Windows and Linux workers, then route session input and health jobs to the right machine.
- **多机器控制。** Windows/Linux worker 都可以接入，消息、健康检查和任务会发到对应机器。
- **Phone and desktop access.** Use Web, Android APK, or Windows desktop to continue work away from the terminal.
- **手机和桌面都能用。** Web、Android APK、Windows 桌面端都可以接入同一个 AgentHub server。
- **Tailscale-first private mode.** Start without opening worker ports to the public internet.
- **Tailscale-first 私有模式。** 不需要把 worker 端口暴露到公网，也能从手机控制本机 agent。
- **Configurable providers and secrets.** Voice ASR, server URL, worker roots, and provider credentials are configuration, not hardcoded maintainer defaults.
- **配置优先。** 语音识别、服务器地址、worker 根目录、provider 密钥都走配置，不写死维护者环境。

## Start Here / 快速开始

### No VM: run AgentHub on your own machine / 没有 VM：直接跑在自己的电脑上

Use this when you already have Tailscale and just want phone access to local agents.

适合已经在用 Tailscale，只想先让手机接管本机 agent 的场景。

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

Open `http://localhost:5173`, create the first owner with `AGENTHUB_BOOTSTRAP_TOKEN`, then point Android or Windows desktop at your local or Tailscale URL.

打开 `http://localhost:5173`，用 `AGENTHUB_BOOTSTRAP_TOKEN` 创建 owner，然后在 Android 或 Windows 桌面端填入本机/Tailscale 地址。

Guide: [Local server mode](docs/LOCAL_SERVER_MODE.md)

### Public VM: self-host with HTTPS / 有 VM：公网 HTTPS 自托管

Use this when you want always-on access, worker downloads, and optional public relay.

适合需要长期在线、worker bundle 下载、公网入口或 public relay 的场景。

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --install-root /opt/agenthub \
  --admin-email you@example.com
```

Guide: [Self-host quickstart](docs/SELF_HOST_QUICKSTART.md)

### Agent-friendly deployment brief / 给其他 agent 的部署输入

If another agent or operator is deploying AgentHub for you, start from:

如果让另一个 agent 或实施人员帮你部署，直接从这个模板开始：

- [AI deployment runbook](docs/AI_DEPLOYMENT_RUNBOOK.md)
- [Deployment brief template](docs/DEPLOYMENT_BRIEF.example.json)

## Supported Surface / 当前支持范围

| Surface | Status | Notes |
| --- | --- | --- |
| Web self-host | Supported | Main console and API surface |
| Android APK | Supported | WebView client with configurable server URL |
| Windows desktop | Supported | Electron client with first-launch server setup |
| Windows worker | Supported | Bundle + PowerShell installer |
| Linux worker | Supported | Bundle + shell/systemd installer |
| iOS client | Community welcome | Prompt and guardrails are in `CONTRIBUTING.md` |
| macOS desktop | Community welcome | Prompt and guardrails are in `CONTRIBUTING.md` |

| 端 | 状态 | 说明 |
| --- | --- | --- |
| Web 自托管 | 已支持 | 主控制台和 API |
| Android APK | 已支持 | 可配置 server URL 的 WebView 客户端 |
| Windows 桌面端 | 已支持 | Electron 客户端，首启配置服务器 |
| Windows worker | 已支持 | bundle + PowerShell 安装脚本 |
| Linux worker | 已支持 | bundle + shell/systemd 安装脚本 |
| iOS 客户端 | 欢迎社区贡献 | `CONTRIBUTING.md` 里已有可直接开工的提示词 |
| macOS 桌面端 | 欢迎社区贡献 | `CONTRIBUTING.md` 里已有可直接开工的提示词 |

## Docs / 文档

- [Local server mode](docs/LOCAL_SERVER_MODE.md)
- [Self-host quickstart](docs/SELF_HOST_QUICKSTART.md)
- [Tailscale private mode](docs/TAILSCALE_PRIVATE_MODE.md)
- [Configuration reference](docs/CONFIGURATION_REFERENCE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security model](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [OSS release flow](docs/OSS_RELEASE.md)
- [Open-source launch checklist](docs/OPEN_SOURCE_LAUNCH.md)
- [Contributing](CONTRIBUTING.md)

## Build / 构建

```powershell
npm run web:build
npm run desktop:build
npm run desktop:package:win
npm run mobile:build:debug
npm run mobile:build:release
```

Generate downloadable worker bundles:

```powershell
.\.venv\Scripts\python.exe scripts\build-worker-bundle.py --output-root .runtime\worker-bundles
```

## Verification / 验证

```powershell
npm run api:test
npm run web:test
npm run web:build
npm run desktop:test
npm run mobile:test
.\.venv\Scripts\python.exe scripts\audit-public-export.py
```

The public repo should never contain private production domains, deployment credentials, local databases, runtime logs, signing keys, or generated release artifacts.

公开仓不应该包含私有生产域名、部署凭据、本地数据库、运行日志、签名密钥或生成出的 release 产物。
