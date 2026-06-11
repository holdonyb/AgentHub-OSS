# AgentHub Launch Copy

This file keeps the public-facing launch copy aligned across the website, README, GitHub Release, and community posts.

## One-line Positioning

Chinese:

> AgentHub 是一个 self-hosted control plane，用来统一管理你自己机器上的 Codex、Claude、Kimi、OpenCode 等本地 agent session，并通过 Web、Android、Windows Desktop 远程接管。

English:

> AgentHub is a self-hosted control plane for managing Codex, Claude, Kimi, OpenCode, and other local agent sessions across your own machines, with Web, Android, and Windows desktop access.

## Chinese Launch Post

Long version:

> 开源了 `AgentHub`。  
> 它不是托管 SaaS，也不是远程 shell 平台，而是一个给自己机器用的 AI agent 控制台。
>
> 你可以把 server 跑在本机、Docker 或 VM 上，让 Windows / Linux worker 接入，然后通过 Web、Android、Windows Desktop 统一查看和控制多台机器上的 Codex、Claude、Kimi、OpenCode session。
>
> 当前这版已经把几条最关键的链路收口到能复现的程度：
>
> - Local / Docker / VM 三种安装路径
> - Android APK、Windows Desktop、Windows/Linux worker bundle
> - `npx agenthub-worker` 安装 worker
> - Tailscale private mode 和 HTTPS public relay
> - 官网下载页、版本说明页、安装选择页
>
> 如果你想要的是“agent 继续跑在你自己的机器上，但我能在别的电脑或手机上接管它”，那这套东西就是为这个场景做的。
>
> 官网：
> `https://myagenthub.dev`
>
> 下载：
> `https://myagenthub.dev/download/`
>
> 安装：
> `https://myagenthub.dev/install/`
>
> Release：
> `https://myagenthub.dev/release/`

Short version:

> 开源了 `AgentHub`。  
> 一个 self-hosted AI agent 控制台，用来统一管理你自己机器上的 Codex / Claude / Kimi / OpenCode session。  
> 支持本机、Docker、VM 三种 server 路径，也支持 Android、Windows Desktop 和 Windows/Linux worker。  
> 官网：`https://myagenthub.dev`

Friend-group version:

> 最近把 `AgentHub` 开源了。  
> 本质上是我自己在用的 AI agent 控制台：server 跑在自己机器或 VM 上，worker 跑在自己的 Windows / Linux 上，再用 Web、Android、Windows Desktop 去接这些 Codex / Claude / Kimi / OpenCode session。  
> 如果你也有多台电脑、想让 agent 继续留在本机环境里跑，这个项目应该能直接用上。

## English Launch Post

Long version:

> Open sourced `AgentHub`.
>
> It is not a hosted SaaS and not a generic remote shell. It is a self-hosted control plane for the local agent runtimes you already use on your own machines.
>
> You can run the server on a laptop, through Docker, or on a VM, attach Windows and Linux workers, and then manage Codex, Claude, Kimi, and OpenCode sessions from Web, Android, or Windows desktop.
>
> The current release is focused on reproducible install and control paths:
>
> - Local / Docker / VM server modes
> - Android APK, Windows desktop, Windows/Linux worker bundles
> - `npx agenthub-worker` for worker install
> - Tailscale private mode and HTTPS public relay
> - public download, install, and release pages
>
> If you want your agents to keep running on your own machines, with your own files and tools, while still being reachable from your phone or another desktop, that is the problem AgentHub is built for.
>
> Website: `https://myagenthub.dev`  
> Download: `https://myagenthub.dev/download/`  
> Install: `https://myagenthub.dev/install/`  
> Release: `https://myagenthub.dev/release/`

Short version:

> Open sourced `AgentHub`.  
> A self-hosted control plane for Codex, Claude, Kimi, OpenCode, and other local agent sessions across your own machines.  
> Supports Local / Docker / VM server modes plus Web, Android, Windows desktop, and Windows/Linux workers.  
> `https://myagenthub.dev`

## X Post

Chinese:

> Open sourced `AgentHub`.\n\nA self-hosted AI agent control plane for Codex / Claude / Kimi / OpenCode on your own machines.\n\n- Local / Docker / VM server modes\n- Android + Windows desktop clients\n- Windows / Linux workers\n- Tailscale private mode + HTTPS public relay\n\nWebsite: https://myagenthub.dev

English:

> Open sourced `AgentHub`.\n\nA self-hosted control plane for Codex / Claude / Kimi / OpenCode sessions on your own machines.\n\n- Local / Docker / VM server modes\n- Android + Windows desktop clients\n- Windows / Linux workers\n- Tailscale private mode + HTTPS public relay\n\nhttps://myagenthub.dev

## Hacker News

Title options:

- Show HN: AgentHub, a self-hosted control plane for local AI agent sessions
- Show HN: AgentHub, manage Codex, Claude, and Kimi sessions across your own machines

Body:

> I open sourced AgentHub, a self-hosted control plane for local AI agent runtimes.
>
> The problem it tries to solve is simple: agents should keep running on your own machine, with your own files, tools, and environment, but still be reachable from another desktop or a phone.
>
> The current public release supports:
>
> - Local / Docker / VM server modes
> - Tailscale private mode and HTTPS public relay
> - Web self-host console
> - Android APK
> - Windows desktop
> - Windows / Linux workers
>
> It currently targets Codex, Claude, Kimi, and OpenCode style local session workflows.
>
> Website: https://myagenthub.dev  
> Release: https://myagenthub.dev/release/  
> Install: https://myagenthub.dev/install/

## Screens and Assets

Public assets currently suitable for launch:

- `docs/assets/agenthub-readme-hero.png`
- `docs/assets/agenthub-architecture-overview.png`
- `docs/assets/agenthub-release-showcase.svg`

The bilingual showcase asset already includes:

- Chinese project labels
- English project labels
- Claude / Codex / Kimi mixed session chips
