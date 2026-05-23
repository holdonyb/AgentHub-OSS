# Assistant Render Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AgentHub 的 `assistant message` 增加安全的 `原文 / Markdown / HTML` 全文预览，同时保持主 timeline 继续使用纯文本展示。

**Architecture:** 保持 `TimelineText` 的主消息流行为不变，只在 `全文阅读` 模态里增加预览模式。将内容识别、Markdown 转换、HTML 清洗和 `srcdoc` 构造拆到独立 helper 文件，避免把安全策略继续堆进超大的 `App.tsx`。HTML 预览使用沙箱 iframe，并将富文本能力限制在 `assistant message`。

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, `marked`, `dompurify`

---

### Task 1: Add render preview helpers and dependency coverage

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/messageRenderPreview.ts`
- Create: `apps/web/src/messageRenderPreview.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add `apps/web/src/messageRenderPreview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildSandboxedSrcDoc,
  detectMessageRenderKind,
  sanitizeHtmlPreview,
} from './messageRenderPreview';

describe('messageRenderPreview helpers', () => {
  it('detects markdown content', () => {
    expect(detectMessageRenderKind('# Title\n\n- item')).toBe('markdown');
  });

  it('detects html content before markdown when structured tags are present', () => {
    expect(detectMessageRenderKind('<div><h1>Title</h1><p>Body</p></div>')).toBe('html');
  });

  it('sanitizes dangerous html while keeping style attributes', () => {
    const html =
      '<div style="color:red;position:fixed" onclick="alert(1)"><script>alert(1)</script><p>Hello</p></div>';
    const sanitized = sanitizeHtmlPreview(html);
    expect(sanitized).toContain('style=');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('position:fixed');
  });

  it('removes iframe and form content from html preview', () => {
    const sanitized = sanitizeHtmlPreview('<iframe src="https://evil"></iframe><form action="/x"><input /></form>');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('<form');
  });

  it('builds a sandboxable srcdoc shell', () => {
    const srcDoc = buildSandboxedSrcDoc('<p>Hello</p>');
    expect(srcDoc).toContain('<!doctype html>');
    expect(srcDoc).toContain('<p>Hello</p>');
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm --workspace @agenthub/web run test -- --run src/messageRenderPreview.test.ts
```

Expected: FAIL because `./messageRenderPreview` does not exist yet.

- [ ] **Step 3: Add dependencies and minimal helper implementation**

Update `apps/web/package.json` dependencies:

```json
{
  "dependencies": {
    "dompurify": "^3.2.6",
    "marked": "^15.0.12"
  }
}
```

Create `apps/web/src/messageRenderPreview.ts`:

```ts
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type MessageRenderKind = 'plain' | 'markdown' | 'html';

const HTML_TAG_PATTERN =
  /<(html|body|main|article|section|div|span|p|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|pre|code|h[1-6])(\s|>)/i;
const MARKDOWN_PATTERN = /(^|\n)\s{0,3}(#{1,6}\s|\-\s|\*\s|\d+\.\s|```|\|.+\|)/m;

export function detectMessageRenderKind(text?: string | null): MessageRenderKind {
  const value = String(text ?? '').trim();
  if (!value) return 'plain';
  if (HTML_TAG_PATTERN.test(value) && /<\/[a-z0-9]+>/i.test(value)) return 'html';
  if (MARKDOWN_PATTERN.test(value) || /\[[^\]]+\]\([^)]+\)/.test(value)) return 'markdown';
  return 'plain';
}

function filterStyle(styleValue: string) {
  return styleValue
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.split(':', 1)[0]?.trim().toLowerCase();
      return !['position', 'z-index', 'inset', 'top', 'right', 'bottom', 'left'].includes(key);
    })
    .join('; ');
}

export function sanitizeHtmlPreview(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onsubmit', 'srcset'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  return sanitized.replace(/style="([^"]*)"/gi, (_, styleValue: string) => {
    const filtered = filterStyle(styleValue);
    return filtered ? `style="${filtered}"` : '';
  });
}

export function renderMarkdownPreview(text: string) {
  return sanitizeHtmlPreview(marked.parse(text) as string);
}

export function buildSandboxedSrcDoc(html: string) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>body{font-family:Inter,system-ui,sans-serif;padding:16px;line-height:1.6;word-break:break-word;}pre{white-space:pre-wrap;}table{border-collapse:collapse;max-width:100%;}td,th{border:1px solid #d7dce5;padding:6px 8px;}img,video,audio{display:none !important;}</style>',
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}
```

- [ ] **Step 4: Install dependencies**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm install
```

Expected: install succeeds and updates lockfile in this worktree.

- [ ] **Step 5: Run helper tests to verify they pass**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm --workspace @agenthub/web run test -- --run src/messageRenderPreview.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
git add apps/web/package.json package-lock.json apps/web/src/messageRenderPreview.ts apps/web/src/messageRenderPreview.test.ts
git commit -m "feat: add assistant render preview helpers"
```

### Task 2: Wire assistant-only preview modes into TimelineText

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

Add tests in `apps/web/src/App.test.tsx`:

```ts
it('shows html preview only for assistant messages in full reader', async () => {
  const htmlTimelinePayload = {
    items: [
      {
        session_id: 'sess-1',
        seq: 1,
        item_type: 'assistant_message',
        role: 'assistant',
        text: '<div style="color:red"><h1>Report</h1><p>Hello</p></div>',
        created_at: '2026-04-26T10:00:00Z',
      },
    ],
  };

  vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/me')) return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
    if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
    if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
    if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
    if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
    if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
    if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
    if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
    if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(htmlTimelinePayload);
    return jsonResponse({}, 404);
  });

  render(<App />);
  await screen.findByRole('heading', { name: '修复移动控制台' });
  await userEvent.click(await screen.findByRole('button', { name: '全文阅读' }));
  expect(screen.getByRole('tab', { name: 'HTML' })).toBeInTheDocument();
});

it('does not show html or markdown preview tabs for tool content', async () => {
  const toolTimelinePayload = {
    items: [
      {
        session_id: 'sess-1',
        seq: 1,
        item_type: 'tool_call',
        role: 'assistant',
        tool_name: 'observer',
        text: '<div><p>tool result</p></div>',
        created_at: '2026-04-26T10:00:00Z',
      },
    ],
  };
  // same fetch setup...
});
```

- [ ] **Step 2: Run the focused UI tests to verify they fail**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm run web:test -- --run apps/web/src/App.test.tsx -t "shows html preview only for assistant messages in full reader"
```

Expected: FAIL because preview tabs do not exist yet.

- [ ] **Step 3: Implement assistant-only preview state in `TimelineText`**

Update `apps/web/src/App.tsx` so `TimelineText` takes preview metadata:

```tsx
type TimelineTextProps = {
  text?: string | null;
  allowRenderPreview?: boolean;
};

function TimelineText({ text, allowRenderPreview = false }: TimelineTextProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const { value, wasTruncated } = timelineTextState(text);
  const detectedKind = allowRenderPreview ? detectMessageRenderKind(value) : 'plain';
  const [viewerMode, setViewerMode] = useState<'plain' | 'markdown' | 'html'>(() =>
    detectedKind === 'plain' ? 'plain' : detectedKind,
  );
  // keep existing collapse and copy logic
}
```

Add the full reader tabs and content branches:

```tsx
<header>
  <strong>全文阅读</strong>
  <button className="icon-button" type="button" aria-label="关闭全文阅读" onClick={() => setViewerOpen(false)}>
    <X size={18} />
  </button>
</header>
{allowRenderPreview && detectedKind !== 'plain' ? (
  <div className="viewer-tabs" role="tablist" aria-label="预览模式">
    <button role="tab" aria-selected={viewerMode === 'plain'} type="button" onClick={() => setViewerMode('plain')}>
      原文
    </button>
    {detectedKind === 'markdown' && (
      <button role="tab" aria-selected={viewerMode === 'markdown'} type="button" onClick={() => setViewerMode('markdown')}>
        Markdown
      </button>
    )}
    {detectedKind === 'html' && (
      <>
        <button role="tab" aria-selected={viewerMode === 'markdown'} type="button" onClick={() => setViewerMode('markdown')}>
          Markdown
        </button>
        <button role="tab" aria-selected={viewerMode === 'html'} type="button" onClick={() => setViewerMode('html')}>
          HTML
        </button>
      </>
    )}
  </div>
) : null}
{viewerMode === 'plain' && <pre>{value || '暂无输出'}</pre>}
{viewerMode === 'markdown' && (
  <div className="rich-preview" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(value) }} />
)}
{viewerMode === 'html' && (
  <iframe
    className="html-preview-frame"
    sandbox=""
    srcDoc={buildSandboxedSrcDoc(sanitizeHtmlPreview(value))}
    title="HTML 预览"
  />
)}
```

- [ ] **Step 4: Pass `allowRenderPreview` only for assistant messages**

Change the assistant message call site:

```tsx
<TimelineText text={message.text} allowRenderPreview={message.item_type === 'assistant_message'} />
```

Keep tool, plan, permission detail and other `TimelineText` calls as plain:

```tsx
<TimelineText text={planText} allowRenderPreview={false} />
```

- [ ] **Step 5: Add minimal styles for modal tabs and iframe**

In `apps/web/src/App.tsx` existing style block, add:

```tsx
.viewer-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.viewer-tabs button {
  border: 1px solid var(--panel-border);
  background: var(--panel-surface);
  color: var(--text-primary);
  border-radius: 999px;
  padding: 8px 12px;
  font: inherit;
}

.viewer-tabs button[aria-selected='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}

.rich-preview {
  line-height: 1.65;
}

.html-preview-frame {
  width: 100%;
  min-height: 420px;
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  background: var(--panel-surface);
}
```

- [ ] **Step 6: Run the focused UI tests to verify they pass**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm run web:test -- --run apps/web/src/App.test.tsx -t "html preview only for assistant messages"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: add assistant-only preview modes"
```

### Task 3: Harden behavior and run full verification

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/messageRenderPreview.test.ts`

- [ ] **Step 1: Add regression coverage for security and copy behavior**

Add tests:

```ts
it('keeps copy text on original raw content', async () => {
  // open full reader on assistant html message
  // switch to html tab
  // click 复制全文
  // expect clipboard payload to equal original message text
});

it('renders markdown tab for markdown assistant messages', async () => {
  // timeline with '# Heading'
  // expect Markdown tab
});

it('strips javascript links from html preview', () => {
  const sanitized = sanitizeHtmlPreview('<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>');
  expect(sanitized).not.toContain('javascript:');
});
```

- [ ] **Step 2: Run the targeted tests to verify failures**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm --workspace @agenthub/web run test -- --run src/messageRenderPreview.test.ts apps/web/src/App.test.tsx
```

Expected: at least the newly added assertions fail before code is completed.

- [ ] **Step 3: Implement any missing minimal fixes**

Examples of expected finishing changes:

```ts
// messageRenderPreview.ts
export function sanitizeHtmlPreview(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onsubmit', 'srcset'],
  });
  return sanitized.replace(/href="javascript:[^"]*"/gi, '');
}
```

```tsx
// App.tsx copy handler remains bound to original value
const copyText = async () => {
  if (!hasText) return;
  if (await writeTextToClipboard(value)) {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
};
```

- [ ] **Step 4: Run full web verification**

Run:

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
npm run web:test
npm run web:build
git diff --check
```

Expected:

- `web:test` passes
- `web:build` passes
- `git diff --check` returns no output

- [ ] **Step 5: Commit**

```powershell
cd E:/AppDataRedirects/superpowers/worktrees/AgentHub/feature/assistant-render-preview
git add apps/web/src/App.test.tsx apps/web/src/messageRenderPreview.test.ts apps/web/src/messageRenderPreview.ts
git commit -m "test: cover assistant render preview security"
```

## Spec Coverage Check

- `assistant-only`：Task 2 通过 `allowRenderPreview` 限定
- 主 timeline 纯文本：Task 2 保持 `displayText` 路径不变
- `全文阅读` 三态：Task 2 实现
- HTML 沙箱：Task 2 `iframe srcDoc + sandbox`
- `style` 保留但收敛：Task 1 helper 实现
- `script/iframe/form` 禁止：Task 1 helper + Task 3 regression
- “消息又没了”独立排查：本计划没有触碰同步链，符合 spec

