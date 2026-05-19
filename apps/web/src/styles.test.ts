import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/styles.css', 'utf-8');

describe('AgentHub responsive layout styles', () => {
  it('defines Agent Ops design tokens and semantic status colors', () => {
    expect(styles).toContain('--ah-bg:');
    expect(styles).toContain('--ah-surface:');
    expect(styles).toContain('--ah-accent:');
    expect(styles).toContain('--ah-status-running:');
    expect(styles).toContain('--ah-status-approval:');
    expect(styles).toContain('--ah-status-idle:');
    expect(styles).toContain('--ah-radius-card:');
  });

  it('prevents session inbox rows from creating horizontal mobile pan', () => {
    expect(styles).toMatch(/\.session-list,\s*\n\.ops-rail\s*{[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/\.session-row-top,\s*\n\.session-row-bottom,\s*\n\.session-row-meta\s*{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.session-row\s*{[^}]*max-width:\s*100%/s);
  });

  it('keeps the reply action toolbar on one compact icon row', () => {
    expect(styles).toMatch(/\.reply-box \.reply-actions\s*{[^}]*flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.reply-icon-button\s*{[^}]*width:\s*38px[^}]*height:\s*38px/s);
    expect(styles).toMatch(/\.reply-send-button\s*{[^}]*width:\s*40px[^}]*height:\s*40px/s);
  });

  it('keeps mobile Agent Ops chrome light instead of oversized admin controls', () => {
    expect(styles).toMatch(/--mobile-topbar-height:\s*50px/);
    expect(styles).toMatch(/--mobile-nav-height:\s*60px/);
    expect(styles).toMatch(/\.session-view-tabs\s*{[^}]*min-height:\s*40px/s);
    expect(styles).toMatch(/\.provider-filter button,\s*\n\.timeline-tabs button\s*{[^}]*border-radius:\s*999px/s);
    expect(styles).toMatch(/\.session-row\s*{[^}]*border-radius:\s*var\(--ah-radius-card\)/s);
  });

  it('fully restores readable mobile surfaces in light appearance mode', () => {
    expect(styles).toMatch(/\.app-shell\.theme-light \.thread-head h2,\s*\n\s*\.app-shell\.theme-light \.mobile-panel-head h2\s*{[^}]*color:\s*#111827/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.file-browser-title span,\s*\n\s*\.app-shell\.theme-light \.file-preview-head strong,\s*\n\s*\.app-shell\.theme-light \.file-row-main strong,\s*\n\s*\.app-shell\.theme-light \.file-preview-title,\s*\n\s*\.app-shell\.theme-light \.mobile-panel-card strong,\s*\n\s*\.app-shell\.theme-light \.worker-diagnostic-card strong\s*{[^}]*color:\s*#111827/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.file-context-card span,\s*\n\s*\.app-shell\.theme-light \.file-browser-title small,\s*\n\s*\.app-shell\.theme-light \.file-preview-head small,\s*\n\s*\.app-shell\.theme-light \.file-row-main small,\s*\n\s*\.app-shell\.theme-light \.file-note,\s*\n\s*\.app-shell\.theme-light \.file-preview-summary\s*{[^}]*color:\s*#64748b/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.mobile-panel-card small,\s*\n\s*\.app-shell\.theme-light \.me-update-card small,\s*\n\s*\.app-shell\.theme-light \.worker-diagnostic-card small\s*{[^}]*color:\s*#64748b/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.reply-box\s*{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.96\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.reply-box textarea\s*{[^}]*background:\s*#ffffff/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.notification-inbox\s*{[^}]*background:\s*#ffffff/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.notification-inbox-item\.unread\s*{[^}]*background:\s*#eff6ff/s);
  });

  it('keeps the mobile topbar create and refresh actions visible instead of hiding them with desktop overflow rules', () => {
    expect(styles).toMatch(/\.topbar \.icon-button:not\(\.mobile-only\):not\(\.primary-top-action\):not\(\.refresh-button\):not\(\.notification-button\)\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.topbar \.primary-top-action,\s*\n\s*\.topbar \.refresh-button\s*{[^}]*display:\s*inline-flex/s);
  });

  it('keeps the mobile topbar from overflowing narrow Android screens', () => {
    expect(styles).toMatch(/\.topbar\s*{[^}]*grid-template-columns:\s*36px minmax\(0,\s*1fr\) auto/s);
    expect(styles).toMatch(/\.topbar \.brand-row\s*{[^}]*min-width:\s*36px/s);
    expect(styles).toMatch(/\.topbar \.brand-row > span\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.mobile-worker-signal\s*{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
    expect(styles).toMatch(/\.topbar-actions\s*{[^}]*min-width:\s*0/s);
  });

  it('restores dark selected states for mobile reply and question controls', () => {
    expect(styles).toMatch(/\.reply-mode-tabs button\s*{[^}]*background:\s*#171a20[^}]*color:\s*#d8dee8/s);
    expect(styles).toMatch(/\.reply-mode-tabs button\.selected\s*{[^}]*background:\s*#0d66d0[^}]*color:\s*#ffffff/s);
    expect(styles).toMatch(/\.question-options button\s*{[^}]*background:\s*#171a20[^}]*color:\s*#f8fafc/s);
    expect(styles).toMatch(/\.question-options button\.selected\s*{[^}]*background:\s*#0d66d0[^}]*color:\s*#ffffff/s);
    expect(styles).toMatch(/\.question-options button\.selected small\s*{[^}]*color:\s*rgba\(255,\s*255,\s*255,\s*0\.82\)/s);
  });

  it('prioritizes the desktop transcript over collapsible session chrome', () => {
    expect(styles).toMatch(/\.thread-pane\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(styles).toMatch(/\.thread-status-strip\s*{[^}]*max-height:\s*34px/s);
    expect(styles).not.toContain('.task-summary-card');
    expect(styles).toMatch(/\.message-block\s*{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.timeline-tabs\s*{[^}]*position:\s*relative/s);
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';
    expect(mobileBlock).toMatch(/\.timeline-tabs\s*{[^}]*position:\s*sticky/s);
  });

  it('keeps desktop dark theme surfaces readable instead of mixing white admin cards', () => {
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-box\s*{[^}]*background:\s*rgba\(17,\s*19,\s*23,\s*0\.96\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.permission-card,\s*\n\.app-shell\.theme-dark \.rail-panel,\s*\n\.app-shell\.theme-dark \.inspector-overview\s*{[^}]*background:\s*#111317/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-box textarea\s*{[^}]*background:\s*#171a20/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.timeline-tabs button,\s*\n\.app-shell\.theme-dark \.native-icon-button,\s*\n\.app-shell\.theme-dark \.secondary-action,\s*\n\.app-shell\.theme-dark \.message-action-button/s);
  });

  it('allows the control pane to scroll independently on web and Android', () => {
    expect(styles).toMatch(/\.ops-rail\s*{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+minmax\(220px,\s*38vh\)/);
    expect(styles).toMatch(/\.ops-rail\s*{[^}]*max-height:\s*38vh/s);
    expect(styles).toMatch(/\.workspace\.mobile-pane-controls \.ops-rail\s*{[^}]*overflow-y:\s*auto/s);
  });

  it('keeps the desktop control rail inside the viewport with long paths and summaries', () => {
    expect(styles).toMatch(/\.workspace\s*{[^}]*max-width:\s*100vw/s);
    expect(styles).toMatch(/\.session-list,\s*\n\.ops-rail\s*{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.ops-rail\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
    expect(styles).toMatch(/\.rail-panel\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
    expect(styles).toMatch(/\.rail-panel-body\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
    expect(styles).toMatch(/\.inspector-overview\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
    expect(styles).toMatch(/\.inspector-overview p,\s*\n\.local-resume-panel p,\s*\n\.provider-row,\s*\n\.event-row,\s*\n\.secret-row\s*{[^}]*overflow-wrap:\s*anywhere/s);
  });
});
