# AgentHub

[简体中文](README.md) | [English](README.en.md)

## 个人 AI Agent 控制台

[![CI](https://img.shields.io/badge/CI-GitHub_Actions-334155)](.github/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-public_preview-f97316)](docs/OPEN_SOURCE_LAUNCH.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-0ea5e9.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-first-16a34a)](docs/SELF_HOST_QUICKSTART.md)
[![Tailscale](https://img.shields.io/badge/Tailscale-friendly-4f46e5)](docs/TAILSCALE_PRIVATE_MODE.md)

AgentHub 用来统一管理你自己机器上的 Codex、Claude、Kimi、OpenCode 等本地 agent runtime。

你可以把 server 跑在笔记本、本地工作站或 VM 上，通过 Tailscale 或自己的 HTTPS 域名接入；然后在 Web、Android、Windows 桌面端统一控制多台电脑、多条终端 session、多个 agent backend。

AgentHub 不是托管 SaaS，也不是任意远程 shell。agent 继续运行在你的机器上，使用你的文件、工具和运行环境；AgentHub 负责会话收件箱、控制界面、worker 接入和审计记录。

## 它解决什么

- **统一会话收件箱。** 把本机和远程机器上的 Codex、Claude、Kimi、OpenCode 会话放到同一个入口。
- **多机器控制。** Windows 和 Linux worker 都可以接入，消息、健康检查和任务会路由到对应机器。
- **手机和桌面都能用。** Web、Android APK、Windows 桌面端都可以接入同一个 AgentHub server；其中 Android APK 首启会先要求填写 server URL。
- **Tailscale-first 私有模式。** 不需要把 worker 端口暴露到公网，也能从手机控制本机 agent。
- **配置优先。** 语音识别、服务器地址、worker 根目录、provider 密钥都走配置，不写死维护者环境。

## 快速开始

### 推荐方式：直接给另一个 agent 一份部署提示词

如果你想最快部署，优先从这两个文件开始，让另一个 agent 或实施人员直接照着执行：

- [AI deployment runbook](docs/AI_DEPLOYMENT_RUNBOOK.md)
- [Deployment brief template](docs/DEPLOYMENT_BRIEF.example.json)

这条路径适合：

- 你想把部署交给 Codex、Claude Code 或其他工程 agent
- 你不想自己手动拼接安装命令和配置项
- 你要在本机、Tailscale 或 VM 三种模式之间快速切换

部署完成后：

- Android APK 首启先填写 AgentHub server URL
- 然后进入对应站点的登录页
- 不是免登录，而是先选自己的 server，再登录自己的账号

### 没有 VM：直接跑在自己的电脑上

适合已经在用 Tailscale，只想先让手机或桌面端接管本机 agent 的场景。

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
npm run api:dev
npm run web:dev
```

打开 `http://localhost:5173`，用 `AGENTHUB_BOOTSTRAP_TOKEN` 创建第一个 owner，然后在 Android 或 Windows 桌面端填入本机或 Tailscale 地址。

指南：[Local server mode](docs/LOCAL_SERVER_MODE.md)

### 有公网入口：用 HTTPS 自托管到 VM

适合需要长期在线、worker bundle 下载、公网入口或 public relay 的场景。

```bash
sudo bash scripts/install-selfhost-linux.sh \
  --domain agenthub.example.com \
  --install-root /opt/agenthub \
  --admin-email you@example.com
```

指南：[Self-host quickstart](docs/SELF_HOST_QUICKSTART.md)

## 当前支持范围

| 端 | 状态 | 说明 |
| --- | --- | --- |
| Web self-host | 已支持 | 主控制台和 API |
| Android APK | 已支持 | 首启先配置 server URL，再进入登录 |
| Windows desktop | 已支持 | Electron 客户端，首启配置服务器 |
| Windows worker | 已支持 | bundle + PowerShell 安装脚本 |
| Linux worker | 已支持 | bundle + shell/systemd 安装脚本 |
| iOS client | 欢迎社区贡献 | `CONTRIBUTING.md` 里已有可直接开工的提示词 |
| macOS desktop | 欢迎社区贡献 | `CONTRIBUTING.md` 里已有可直接开工的提示词 |

## 文档入口

- [English README](README.en.md)
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

## 构建

```powershell
npm run web:build
npm run desktop:build
npm run desktop:package:win
npm run mobile:build:debug
npm run mobile:build:release
```

生成可下载的 worker bundles：

```powershell
.\.venv\Scripts\python.exe scripts\build-worker-bundle.py --output-root .runtime\worker-bundles
```

## 验证

```powershell
npm run api:test
npm run web:test
npm run web:build
npm run desktop:test
npm run mobile:test
.\.venv\Scripts\python.exe scripts\audit-public-export.py
```

公开仓不应该包含私有生产域名、部署凭据、本地数据库、运行日志、签名密钥或生成出的 release 产物。
