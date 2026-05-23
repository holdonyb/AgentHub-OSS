# Assistant Message Render Preview Design

## Summary

AgentHub 只对 `assistant message` 提供受限富文本预览能力，不改变主 timeline 的文本优先模型。主消息流继续显示纯文本摘要和折叠内容；`全文阅读` 弹层新增三种查看模式：

- `原文`
- `Markdown 预览`
- `HTML 预览`

其中 HTML 预览采用沙箱隔离，不直接渲染进主页面 DOM。这个功能只解决“如何安全预览 assistant 输出”；“消息偶发丢失/不同步”仍按独立同步问题排查，不与本功能耦合。

## Goals

- 让 `assistant message` 在需要时可以更自然地阅读 Markdown/HTML 输出
- 保持主 timeline 稳定，不因为富文本预览破坏布局、折叠、复制、排序和搜索
- 在不暴露脚本执行和表单交互面的前提下，尽量保留 HTML 内容的视觉信息
- 把富文本预览限制在 `全文阅读` 范围内，避免扩大 trust boundary

## Non-Goals

- 不对 `user message`、`tool message`、`error message` 做 HTML/Markdown 渲染
- 不在主消息流 inline 渲染任意 HTML
- 不把“消息丢失/不同步”作为本功能的一部分一起修改
- 不实现完整 artifact runtime、iframe app 容器、表单提交或脚本执行

## Scope

### In Scope

- `assistant message` 的正文预览
- `TimelineText` 现有 `全文阅读` 模态框扩展
- 基于内容特征的 Markdown/HTML 自动识别
- 安全 HTML 预览
- 复制全文仍复制原文，不复制渲染后的 DOM 文本

### Out of Scope

- 工具结果卡片的 HTML 渲染
- 文件预览页的渲染策略重构
- timeline 同步链路修复
- OpenCode/Codex/Claude provider 能力差异处理

## User Experience

### Main Timeline

主消息流保持当前行为：

- 显示纯文本内容
- 继续支持折叠/展开
- 继续支持 `复制全文`
- 继续支持 `全文阅读`

这里不做 inline HTML 渲染。原因是 timeline 是控制台核心区域，必须优先保证稳定、可扫描、可搜索。

### Full Reader Modal

`全文阅读` 打开后，顶部出现模式切换，仅对 `assistant message` 显示：

- `原文`
- `Markdown`
- `HTML`

行为规则：

- 默认模式按内容自动选择：
  - 明显是 HTML：默认打开 `HTML`
  - 明显是 Markdown：默认打开 `Markdown`
  - 其他内容：默认打开 `原文`
- 用户可以手动切换模式
- 切换模式不修改原始消息内容，不写回 session

### Copy Behavior

- `复制全文` 始终复制原始文本
- 不复制渲染后的 HTML 结构
- 这样可以保证复制结果与 session 原始输出一致

## Detection Strategy

### Markdown Detection

满足以下任一组合时，判定为 Markdown 候选：

- 存在标题、列表、代码块、表格等 Markdown 结构
- 存在多个 Markdown link/image 语法
- 文本标签密度低，但格式标记明显

### HTML Detection

满足以下条件时，判定为 HTML 候选：

- 出现成对结构化标签，如 `html/body/div/article/section/table/p/h1-ul-li`
- 标签密度高于普通代码块
- 文本整体不像“展示 HTML 源码的代码示例”

### Tie-Break Rule

如果同时像 Markdown 和 HTML：

- 优先按 HTML 候选处理
- 但仍允许用户切回 `原文` 或 `Markdown`

## Rendering Architecture

### Markdown Preview

流程：

1. 原始 assistant 文本
2. Markdown parser 转为 HTML
3. HTML sanitizer 清洗
4. 渲染到预览容器

要求：

- 保留标题、段落、列表、表格、引用、代码块
- 链接可点击，但必须 `target=_blank` 且带 `rel=noopener noreferrer`
- 图片默认不走远程自动加载；优先显示占位信息或仅保留文本链接

### HTML Preview

流程：

1. 原始 assistant 文本
2. HTML sanitizer 清洗
3. 写入 `iframe srcdoc`
4. `sandbox` 限制能力

HTML 预览不直接插入主文档 DOM。必须通过单独沙箱 iframe 承载。

## HTML Security Model

### Allowed

- 常见结构标签：`div`, `span`, `p`, `h1-h6`, `ul`, `ol`, `li`, `table`, `thead`, `tbody`, `tr`, `td`, `th`, `blockquote`, `pre`, `code`, `hr`, `br`
- 基础语义标签：`article`, `section`, `main`, `header`, `footer`
- 受限链接标签：`a`
- 内联样式 `style` 保留，但仍需属性级过滤

### Denied

- `script`
- `iframe`
- `form`
- 事件属性，例如 `onclick`, `onerror`
- 会引入主动交互或执行上下文的标签

### URL Policy

- 禁止 `javascript:` 协议
- 禁止危险 `data:` URL
- 禁止自动远程资源拉取型标签，尤其是会直接发请求的媒体/嵌入内容
- 对链接仅保留安全 `http/https/mailto` 白名单

### CSS Policy

用户已明确希望不要把 `style` 全禁掉，因此这里采用“保留 style，但做收敛”：

- 允许基础排版和颜色相关样式
- 过滤明显破坏宿主布局或制造欺骗的样式能力，例如固定定位、极端 z-index、全屏覆盖等

实现上不追求完整 CSS 沙箱，而是利用 iframe 隔离 + 属性过滤达成“足够安全且可读”。

### Sandbox Policy

iframe 使用受限 `sandbox`，目标是：

- 不执行脚本
- 不允许表单提交
- 不允许顶层导航接管
- 不允许弹窗、下载、权限请求

这样即使 HTML 内容复杂，也被限制在预览壳层里。

## Component Changes

### `TimelineText`

这是主入口。需要增加：

- 内容类型检测
- 预览模式状态
- `全文阅读` 模态中的 tab/toggle
- Markdown 渲染容器
- HTML iframe 预览容器

保持不变的行为：

- 折叠逻辑
- 纯文本摘要逻辑
- `复制全文`

### Shared Helpers

增加几个纯函数助手：

- `detectMessageRenderKind(text)`
- `sanitizeHtmlPreview(html)`
- `renderMarkdownPreview(text)`
- `buildSandboxedSrcDoc(html)`

这样可以把渲染策略和 UI 组件拆开，便于单测。

## Error Handling

- 如果 Markdown 解析失败，回退到 `原文`
- 如果 HTML 清洗失败，回退到 `原文`
- 如果 iframe 预览构造失败，显示“HTML 预览不可用”，仍可查看原文
- 不允许因为预览失败影响消息本身的展示

## Testing

### Unit / Component

- assistant 纯文本消息：只显示 `原文`
- assistant Markdown 消息：显示 `Markdown` tab，渲染正常
- assistant HTML 消息：显示 `HTML` tab，渲染正常
- tool/error/user 消息：不显示富文本预览 tab
- `复制全文` 复制原文而非渲染结果
- HTML 中 `script`、事件属性、`iframe`、`form` 被去除

### Security-Focused

- 带 `onclick` / `onerror` 的 HTML 不执行
- 含 `javascript:` 链接被移除或降级
- 恶意全屏覆盖 CSS 无法污染宿主页面
- HTML 预览失败时不影响主 timeline

### Manual QA

- Web 深色/浅色主题下预览可读
- 移动端 `全文阅读` 弹层内切换模式不破版
- 超长 HTML/Markdown 内容滚动正常

## Rollout Plan

### Phase 1

- 先做 `assistant-only`
- 主 timeline 不变
- `全文阅读` 支持 `原文 / Markdown / HTML`

### Phase 2

- 评估是否要在主消息流 inline 渲染 Markdown
- 这一阶段单独评审，不跟 Phase 1 一起做

## Open Issue Tracked Separately

用户反馈“有些内容又没了、同步不到消息正文”。这个问题不应归因于渲染预览。

单独排查方向：

- worker 是否只同步了 summary 没同步 timeline
- timeline 是否已写入但前端合成/筛选时丢失
- optimistic message 是否被旧 timeline 覆盖

这部分另开 bugfix，不在本设计内修改。

