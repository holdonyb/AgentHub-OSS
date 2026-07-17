# AgentHub 架构图

## 总览

![AgentHub 架构总览](assets/agenthub-architecture-overview.png)

这张图把 AgentHub 的三层关系放在一起：

- **方案 A：本地笔记本 Self-Host**
  - 适合没有 VM、已经在用 Tailscale 的个人环境
  - 本机既可以跑 `AgentHub Server`，也可以同时跑 `Local Worker`
  - 手机、Web、Windows/macOS 桌面端通过本机地址、Tailscale 地址或可选 HTTPS 入口接入
- **方案 B：云端 VM Self-Host**
  - 适合固定域名、长期在线、多台机器协作
  - Linux VM 可以通过 HTTPS public relay 对外提供 Web/App 入口，也可以只放在 Tailscale private mode 里
  - Windows / Linux / macOS worker 继续跑在各自机器上，通过 Tailscale private mode 或 public relay 接入
- **跨平台客户端**
  - Web 和 Windows desktop 是稳定控制面
  - React Native Android 覆盖会话、任务、文件、语音、图片、审批和通知
  - React Native iOS 已纳入源码与 CI Simulator 编译，真机签名和分发仍待完成
  - macOS desktop 已纳入 DMG/ZIP 自动打包，公开分发需要签名与 notarization
- **核心关系：Server / Worker / Agent Runtime**
  - `AgentHub Server` 负责认证、权限、会话索引、任务队列、事件审计、配置和 memory
  - `Worker` 负责发现本机 session、执行任务、回传状态
  - `Codex / Claude / Kimi / OpenCode` 这些 runtime 继续运行在 worker 机器上，而不是运行在控制平面里

## 怎么理解这几个角色

### AgentHub Server

控制平面。它不直接替你运行 agent，而是统一负责：

- 登录和权限控制
- session inbox 和时间线
- job queue 和 worker 调度
- 审批、事件、审计记录
- 配置和跨设备访问入口

### Worker

执行平面。它部署在真正跑 agent 的机器上，负责：

- 发现本机已有 session
- 把 Web / App 发来的输入转成对应 runtime 的操作
- 采集状态和事件，再同步回 server

### Agent Runtime

真正做事的还是你机器上的 runtime，例如：

- Codex
- Claude
- Kimi
- OpenCode

所以 AgentHub 的设计重点不是“托管你的 agent”，而是“统一控制和同步这些已经在你机器上运行的 agent”。

## Remote Workspace 文件传输数据面

Remote Workspace v2 不引入 SSH、SFTP、RDP，也不要求 worker 开放新的入站端口。文件传输复用现有控制面和 worker 的出站认证链路：

```text
Web / App
    | 1. authenticated HTTPS: create transfer
    v
AgentHub API + temporary transfer directory
    ^
    | 2. worker polls an authorized job
    | 3. worker uploads/downloads bytes over authenticated HTTPS
    |
Worker -> registered workspace root
```

- API 先按用户空间、worker、workspace root 和操作创建短期 transfer，并把 transfer 元数据记录到数据库。
- worker 继续通过 `/api/internal/*` 或 public relay 的 `/api/worker/*` 主动轮询；下载由 worker 向 API 上传文件，上传则由 worker 从 API 拉取临时文件后原子落盘。
- 文件正文临时存放在 API 主机的 `AGENTHUB_FILE_TRANSFER_DIR`，不会写入 `file_transfers` 数据库行；目录、TTL 和单次大小上限见 [Configuration Reference](CONFIGURATION_REFERENCE.md#remote-workspace-file-transfer)。
- 面向用户的读取支持 HTTP byte ranges，并返回 `Cache-Control: private, no-store` 和 `Content-Encoding: identity`。禁用内容编码可确保 Range 字节偏移对应原始文件；这是低缓存策略，不代表客户端内存或 API 临时目录中完全没有短期副本。
- API 在响应头 `X-AgentHub-SHA256` 中返回完整临时正文的 SHA-256。worker 拉取上传正文后必须核对该摘要；不匹配时删除本地临时结果并拒绝落盘。
- 上传正文只允许被原子领取一次，重复或并发写入会被拒绝。下载正文则在 ticket 有效期内允许重复和 Range 读取，以支持媒体预览、断点请求与 worker 重试；每次读取仍受用户/worker 绑定和过期时间约束。
- API 后台维护器周期清理过期正文和崩溃遗留的传输分片；创建新 transfer 时也会执行当前空间的即时清理。

能力协商用于滚动升级：

- 新 worker 明确上报 `file_transfer_v2: true` 后，客户端才会为图片、音视频、下载和上传使用 transfer 数据面。
- 文本和 Markdown 预览当前仍使用有大小上限的 legacy file job，以保留编辑兼容性。
- 未声明能力的旧 worker 继续使用 legacy file job。创建 transfer 返回 `TRANSFER_UNSUPPORTED`，或旧 API 尚无 transfer 路由时，客户端回退到该路径。
- Web 的 legacy 二进制回退在读取响应体前还有 16 MiB 客户端上限，避免旧 worker 的 Base64 响应把浏览器内存无界放大。worker 和 API 的服务端上限仍然是主边界。
- 超时、过期、权限、完整性或大小错误不会自动回退，避免同一操作绕过 transfer 的失败状态和限制。
- React Native 客户端当前仍使用有界 session file API；`file_transfer_v2` 的原生缓存和流式传输属于后续兼容层扩展。

## 两种推荐拓扑

### 1. 本机 Self-Host

适合：

- 只有一台主要工作电脑
- 不想买 VM
- 想直接通过 Tailscale 从手机控制本机 agent
- 或者想先在本机验证，再决定是否迁移到 VM

配套文档：

- [Local server mode](LOCAL_SERVER_MODE.md)
- [Tailscale private mode](TAILSCALE_PRIVATE_MODE.md)

### 2. VM Self-Host

适合：

- 需要稳定公网域名
- 想把 Web / App 入口长期在线暴露出来
- 有多台 worker 机器需要接入
- 或者想把云端 VM 放进 Tailscale，只给自己和团队访问

配套文档：

- [Self-host quickstart](SELF_HOST_QUICKSTART.md)
- [Deployment](DEPLOYMENT.md)
- [Security model](SECURITY.md)
