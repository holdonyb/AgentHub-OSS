# AgentHub Settings Center Design

**Scope**

把目前散落在 localStorage、语音请求 payload、worker env 变量里的设置，收口成一个正式的 Settings Center。第一版覆盖三类配置：

1. 用户偏好：界面语言、外观、语音识别模式、语音识别语言
2. 空间级默认项：worker 运行参数默认值
3. worker 下发：控制面把运行参数发给 worker，worker 按最新配置生效

**Why**

当前用户看到的现状是：

- 语言切换没有 UI，也没有真正的 i18n 资源层
- 语音识别语言在前端写死为 `zh-CN`
- worker 并发、poll、heartbeat 只能改 env，控制面无法配置

这会让产品行为和用户预期脱节。修复目标不是做一个巨大的“设置系统”，而是先把最常用、最容易感知、最影响运行行为的配置补成真实入口。

## Design

### 1. 数据模型

新增一个通用设置表，按 `(scope_type, scope_id, key)` 存储：

- `scope_type = user`：用户偏好
- `scope_type = space`：空间级默认值

键值使用稳定 key：

- `ui.locale`
- `ui.theme_mode`
- `voice.mode`
- `voice.language`
- `worker.max_concurrent_jobs`
- `worker.job_poll_interval_seconds`
- `worker.heartbeat_interval_seconds`

这样不用一开始就把 schema 固化成大量列，后面继续加配置时也不需要频繁迁移表结构。

### 2. API

新增 `GET /api/settings`，返回当前用户和当前空间的合并设置：

- `preferences`
- `worker_runtime_defaults`
- `options`
- `limits`

新增两个 mutation：

- `PATCH /api/settings/preferences`
  - 任意已登录用户可改自己的偏好
- `PATCH /api/settings/worker-runtime`
  - 仅 `admin/owner` 可改空间级 worker 默认运行参数

### 3. Worker 生效路径

worker heartbeat 接口返回 `runtime_settings`。

worker runtime 在每次 heartbeat 后读取服务端默认值：

- `max_concurrent_jobs`
- `job_poll_interval_seconds`
- `heartbeat_interval_seconds`

其中：

- poll/heartbeat 间隔可以直接更新
- 并发值更新后，若后台 executor 空闲则立即重建；若仍有 active job，则延迟到空闲时切换

这样避免“必须重启 worker 才能生效”的硬伤，同时也不强行中断正在跑的任务。

### 4. 前端入口

在 `我的` 页新增：

- 语言
- 外观
- 语音识别模式
- 语音识别语言

在 Worker 安装 / 控制面新增：

- Worker 运行参数默认值编辑区
- 新生成的安装命令带上当前默认参数

### 5. 多语言策略

第一版不是全站彻底国际化，而是：

- 建一个轻量 `messages` 字典
- 把高频 chrome 文案接到 `t()`
- 先覆盖设置中心、顶部、底部导航、主要按钮和控制面关键标题

这样用户能看到语言切换真实生效，也不会把这次改动扩成整站重写。

## Validation

- API settings 测试
- worker runtime 应用远端设置测试
- Web 设置保存和 UI 切换测试
- `npm run api:test`
- `npm run web:test`
- `npm run web:build`
- 相关 worker 单测
