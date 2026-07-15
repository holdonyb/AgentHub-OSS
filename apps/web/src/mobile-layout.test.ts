import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile WebView layout guardrails', () => {
  it('uses safe-area aware viewport and avoids fixed mobile body width', () => {
    const index = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');

    expect(index).toContain('viewport-fit=cover');
    expect(styles).not.toMatch(/body\s*{[^}]*min-width:\s*320px/s);
    expect(styles).toContain('env(safe-area-inset-top');
    expect(styles).toContain('overflow-x: clip');
  });

  it('declares a branded browser tab icon', () => {
    const index = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');
    const favicon = readFileSync(resolve(process.cwd(), 'public/favicon.svg'), 'utf-8');

    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(index).toContain('<meta name="theme-color" content="#0d66d0" />');
    expect(favicon).toContain('<title>AgentHub</title>');
    expect(favicon).toContain('#79D1FF');
    expect(favicon).toContain('#3EA5FF');
    expect(favicon).toContain('rotate(-45 512 512)');
    expect(favicon).not.toContain('agenthub-icon-mask');
  });

  it('uses per-instance ids for inline brand mark gradients', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

    expect(app).toContain('useId');
    expect(app).toContain('id={gradientId}');
    expect(app).toContain('fill={`url(#${gradientId})`}');
    expect(app).not.toContain('id="agenthubBrandMarkGradient"');
    expect(app).not.toContain('fill="url(#agenthubBrandMarkGradient)"');
  });

  it('keeps the fulltext reader above all mobile chrome', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const backdrop = styles.match(/\.fulltext-backdrop\s*{(?<body>[^}]+)}/s)?.groups?.body ?? '';
    const zIndex = Number(backdrop.match(/z-index:\s*(\d+)/)?.[1] ?? 0);

    expect(backdrop).toContain('position: fixed');
    expect(backdrop).toContain('inset: 0');
    expect(backdrop).toContain('isolation: isolate');
    expect(backdrop).toContain('height: 100dvh');
    expect(zIndex).toBeGreaterThan(1000000);
  });

  it('keeps mobile chrome compact and lets thread content scroll above the composer', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toContain('--mobile-topbar-height: 50px');
    expect(mobileBlock).toContain('--mobile-nav-height: 60px');
    expect(mobileBlock).toContain('--mobile-toast-clearance: 0px');
    expect(mobileBlock).toContain('--mobile-composer-clearance: 224px');
    expect(mobileBlock).toContain('--mobile-message-bottom-gutter: 20px');
    expect(mobileBlock).toMatch(/\.topbar\s*{[^}]*height:\s*var\(--mobile-topbar-height\)/s);
    expect(mobileBlock).toMatch(/\.workspace\s*{[^}]*height:\s*calc\([^}]*var\(--mobile-toast-clearance\)/s);
    expect(mobileBlock).toMatch(/\.message-block\s*{[^}]*padding:\s*6px 0 var\(--mobile-message-bottom-gutter\)/s);
    expect(mobileBlock).not.toMatch(/\.message-block\s*{[^}]*padding:\s*6px 0 var\(--mobile-composer-clearance\)/s);
    expect(mobileBlock).toMatch(/\.load-older-button\s*{[^}]*margin-bottom:\s*22px/s);
  });

  it('keeps the mobile session detail message-first instead of showing desktop summary cards', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toMatch(/\.thread-pane\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(mobileBlock).toMatch(/\.thread-status-strip\s*{[^}]*max-height:\s*30px[^}]*overflow:\s*hidden/s);
    expect(mobileBlock).toMatch(/\.timeline-tabs\s*{[^}]*min-height:\s*30px/s);
    expect(styles).not.toContain('.task-summary-card');
  });

  it('keeps the mobile thread and composer inside the viewport width', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toMatch(
      /\.thread-pane > \*:not\(\.scroll-to-bottom-button\)\s*{[^}]*min-width:\s*0[^}]*width:\s*100%[^}]*max-width:\s*100%/s,
    );
    expect(mobileBlock).toMatch(/\.scroll-to-bottom-button\s*{[^}]*width:\s*42px[^}]*height:\s*42px/s);
    expect(mobileBlock).toMatch(/\.thread-head\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s);
    expect(mobileBlock).toMatch(/\.thread-head-actions\s*{[^}]*min-width:\s*0[^}]*flex-wrap:\s*nowrap[^}]*overflow:\s*visible/s);
    expect(mobileBlock).toMatch(/\.thread-head-actions \.mobile-control-shortcut\s*{[^}]*flex:\s*0 0 40px[^}]*font-size:\s*0/s);
    expect(mobileBlock).toMatch(/\.reply-box,\s*\n\s*\.reply-box textarea,\s*\n\s*\.reply-box \.reply-actions,\s*\n\s*\.reply-mode-tabs\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
    expect(mobileBlock).toMatch(/\.reply-send-button\s*{[^}]*flex:\s*0 0 40px/s);
  });

  it('keeps mobile controls readable while exposing secondary thread actions through a menu', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toMatch(/\.session-count-inline\s*{[^}]*display:\s*none/s);
    expect(mobileBlock).toMatch(/\.mobile-session-menu\s*{[^}]*display:\s*block/s);
    expect(mobileBlock).toMatch(/\.thread-head-actions \.desktop-session-action\s*{[^}]*display:\s*none/s);
    expect(mobileBlock).toMatch(/\.notification-toast\s*{[^}]*position:\s*static/s);
    expect(mobileBlock).toMatch(/\.notification-toast \+ \.workspace\s*{[^}]*--mobile-toast-clearance:\s*74px/s);
    expect(mobileBlock).toMatch(/\.ops-rail\s*{[^}]*overflow-y:\s*auto/s);
    expect(mobileBlock).toMatch(/\.rail-panel summary,\s*\n\s*\.rail-panel-summary\s*{[^}]*color:\s*#e5edf6/s);
    expect(mobileBlock).toMatch(/\.editor-panel input,\s*\n\s*\.editor-panel select,\s*\n\s*\.editor-panel textarea\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#e5edf6/s);
    expect(mobileBlock).toMatch(/\.rail-panel summary,\s*\n\s*\.rail-panel-summary\s*{[^}]*min-height:\s*48px[^}]*overflow:\s*visible/s);
    expect(mobileBlock).toMatch(/\.rail-panel summary > span,\s*\n\s*\.rail-panel-summary > span\s*{[^}]*white-space:\s*nowrap/s);
  });

  it('keeps Cockpit filters and runtime actions touch-safe without widening the viewport', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toMatch(/\.app-mode-switch\s*{[^}]*display:\s*none/s);
    expect(mobileBlock).toMatch(/\.mobile-mode-menu\s*{[^}]*display:\s*block/s);
    expect(mobileBlock).toMatch(/\.mobile-mode-popover\s*{[^}]*position:\s*fixed[^}]*max-width:\s*calc\(100vw - 24px\)/s);
    expect(mobileBlock).toMatch(/\.runtime-cockpit\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
    expect(mobileBlock).toMatch(/\.runtime-cockpit-filters\s*{[^}]*overflow-x:\s*auto/s);
    expect(mobileBlock).toMatch(/\.runtime-cockpit-row-main\s*{[^}]*min-height:\s*72px/s);
    expect(mobileBlock).toMatch(/\.runtime-cockpit-task-link\s*{[^}]*width:\s*44px[^}]*height:\s*44px/s);
    expect(mobileBlock).toMatch(/\.app-shell\.mode-cockpit,\s*\n\s*\.app-shell\.mode-workbench\s*{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/s);
    expect(mobileBlock).toMatch(/\.app-shell\.mode-cockpit\s+\.runtime-cockpit\s*{[^}]*height:\s*calc\(\s*100dvh\s*-\s*var\(--mobile-topbar-height\)/s);
    expect(mobileBlock).toMatch(/\.app-shell\.mode-workbench\s+\.workbench-layout\s*{[^}]*height:\s*calc\(\s*100dvh\s*-\s*var\(--mobile-topbar-height\)/s);
    expect(mobileBlock).toMatch(/\.notification-toast \+ \.runtime-cockpit,\s*\n\s*\.notification-toast \+ \.workbench-layout\s*{[^}]*--mobile-toast-clearance:\s*74px/s);
    expect(mobileBlock).toMatch(/\.app-shell\.mode-cockpit\s+\.runtime-cockpit\s*{[^}]*var\(--mobile-toast-clearance\)/s);
  });

  it('lets the mobile status strip and composer expand on demand', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8');
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';

    expect(mobileBlock).toMatch(/\.thread-status-strip\.expanded\s*{[^}]*max-height:\s*none[^}]*flex-wrap:\s*wrap/s);
    expect(styles).toContain('.thread-pane.is-reading .thread-head p');
    expect(styles).toContain('.thread-pane.is-reading .thread-status-strip:not(.expanded) span:not(.state-pill):not(:nth-child(3))');
    expect(styles).toContain('.reply-box.is-compact .reply-mode-tabs');
    expect(styles).toContain('.reply-box.is-compact .voice-mode-bar');
    expect(styles).toContain('.reply-box.is-compact .quick-reply-strip');
    expect(mobileBlock).toMatch(/\.reply-box\.is-expanded textarea\s*{[^}]*min-height:\s*142px/s);
    expect(mobileBlock).toMatch(/\.reply-box\.is-expanded textarea\s*{[^}]*max-height:\s*min\(42dvh,\s*260px\)/s);
  });
});
