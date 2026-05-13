import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/styles.css', 'utf-8');

describe('AgentHub responsive layout styles', () => {
  it('prevents session inbox rows from creating horizontal mobile pan', () => {
    expect(styles).toMatch(/\.session-list,\s*\n\.ops-rail\s*{[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/\.session-row-top,\s*\n\.session-row-bottom\s*{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.session-row\s*{[^}]*max-width:\s*100%/s);
  });

  it('keeps the reply action toolbar on one compact icon row', () => {
    expect(styles).toMatch(/\.reply-box \.reply-actions\s*{[^}]*flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.reply-icon-button\s*{[^}]*width:\s*38px[^}]*height:\s*38px/s);
    expect(styles).toMatch(/\.reply-send-button\s*{[^}]*width:\s*40px[^}]*height:\s*40px/s);
  });

  it('fully restores readable mobile surfaces in light appearance mode', () => {
    expect(styles).toMatch(/\.app-shell\.theme-light \.thread-head h2,\s*\n\s*\.app-shell\.theme-light \.mobile-panel-head h2\s*{[^}]*color:\s*#111827/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.file-browser-title span,\s*\n\s*\.app-shell\.theme-light \.file-preview-head strong,\s*\n\s*\.app-shell\.theme-light \.file-row-main strong,\s*\n\s*\.app-shell\.theme-light \.file-preview-title,\s*\n\s*\.app-shell\.theme-light \.mobile-panel-card strong,\s*\n\s*\.app-shell\.theme-light \.worker-diagnostic-card strong\s*{[^}]*color:\s*#111827/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.mobile-panel-card small,\s*\n\s*\.app-shell\.theme-light \.me-update-card small,\s*\n\s*\.app-shell\.theme-light \.worker-diagnostic-card small\s*{[^}]*color:\s*#64748b/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.reply-box\s*{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.96\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.reply-box textarea\s*{[^}]*background:\s*#ffffff/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.notification-inbox\s*{[^}]*background:\s*#ffffff/s);
    expect(styles).toMatch(/\.app-shell\.theme-light \.notification-inbox-item\.unread\s*{[^}]*background:\s*#eff6ff/s);
  });
});
