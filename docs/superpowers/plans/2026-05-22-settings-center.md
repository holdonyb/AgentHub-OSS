# Settings Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 AgentHub 补一个真实可见、可保存、可下发的设置中心，覆盖语言、语音默认项和 worker 运行参数。

**Architecture:** 后端增加通用设置存储和 settings API；前端 `我的` 页和 worker 控制入口读取并保存设置；worker heartbeat 返回 runtime defaults，worker 在运行时应用最新参数。

**Tech Stack:** FastAPI, SQLAlchemy, React + TypeScript, worker shared runtime

---

### Task 1: 后端设置存储

**Files:**
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/core/database.py`
- Create: `apps/api/app/core/settings_store.py`

- [ ] 增加通用设置模型，支持 `user` / `space` scope
- [ ] 补 settings store 的 `get_setting` / `set_setting` / `get_merged_settings`
- [ ] 让 SQLite 现有实例启动时自动创建 settings 表

### Task 2: 后端 settings API

**Files:**
- Modify: `apps/api/app/schemas.py`
- Create: `apps/api/app/routers/settings.py`
- Modify: `apps/api/app/main.py`

- [ ] 增加 settings 相关 schema
- [ ] 实现 `GET /api/settings`
- [ ] 实现 `PATCH /api/settings/preferences`
- [ ] 实现 `PATCH /api/settings/worker-runtime`
- [ ] 加 role 校验和审计事件

### Task 3: worker runtime 下发

**Files:**
- Modify: `apps/api/app/routers/workers.py`
- Modify: `apps/api/app/routers/worker_relay.py`
- Modify: `workers/shared/agenthub_worker/client.py`
- Modify: `workers/shared/agenthub_worker/runtime.py`

- [ ] heartbeat 响应带回 `runtime_settings`
- [ ] worker client 透传 heartbeat 响应
- [ ] runtime 应用 poll / heartbeat / 并发设置
- [ ] 并发 executor 在空闲时安全切换

### Task 4: Web 设置入口

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] 增加 settings 类型和 `/api/settings` 数据流
- [ ] `我的` 页增加语言、语音模式、语音语言设置卡片
- [ ] worker 控制面增加运行参数默认值编辑区
- [ ] Worker 安装命令带默认 runtime 参数

### Task 5: 轻量多语言

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] 建最小 `messages` 字典
- [ ] 覆盖顶部、底部导航、我的页、设置中心、控制面标题等关键文案
- [ ] 语言切换立即生效，并持久化到 settings + 本地状态

### Task 6: 测试与验证

**Files:**
- Modify: `apps/api/tests/test_control_plane.py`
- Modify: `apps/api/tests/test_worker_runtime.py`
- Modify: `apps/web/src/App.test.tsx`

- [ ] 增加 settings API 测试
- [ ] 增加 runtime settings 应用测试
- [ ] 增加 Web 设置切换测试
- [ ] 跑 `npm run api:test`
- [ ] 跑 `npm run web:test`
- [ ] 跑 `npm run web:build`
