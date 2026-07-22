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
    expect(styles).toMatch(/\.app-shell\.theme-light \.reply-mode-tabs button\.selected\s*{[^}]*background:\s*#1269d3[^}]*color:\s*#ffffff/s);
  });

  it('keeps the mobile topbar create and refresh actions visible instead of hiding them with desktop overflow rules', () => {
    expect(styles).toMatch(/\.topbar \.icon-button:not\(\.mobile-only\):not\(\.primary-top-action\):not\(\.refresh-button\):not\(\.notification-button\)\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.topbar \.primary-top-action,\s*\n\s*\.topbar \.refresh-button\s*{[^}]*display:\s*inline-flex/s);
  });

  it('keeps the mobile topbar from overflowing narrow Android screens', () => {
    expect(styles).toMatch(/\.topbar\s*{[^}]*grid-template-columns:\s*36px minmax\(0,\s*1fr\) auto/s);
    expect(styles).toMatch(/\.topbar \.brand-row\s*{[^}]*min-width:\s*36px/s);
    expect(styles).toMatch(/\.topbar \.brand-row > span\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.mobile-worker-signal\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.topbar-actions\s*{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.mobile-mode-trigger\s*{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s);
  });

  it('keeps tablet and foldable topbars compact before the phone layout takes over', () => {
    expect(styles).toMatch(/@media \(min-width:\s*761px\) and \(max-width:\s*1100px\)\s*{[\s\S]*?\.topbar\s*{[^}]*padding:\s*0 12px/s);
    expect(styles).toMatch(/@media \(min-width:\s*761px\) and \(max-width:\s*1100px\)\s*{[\s\S]*?\.topbar \.sync-chip,[\s\S]*?\.topbar \.role-chip,[\s\S]*?\.topbar \.theme-switch-button,[\s\S]*?\.topbar-actions > \.icon-button:last-child\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/@media \(min-width:\s*761px\) and \(max-width:\s*1100px\)\s*{[\s\S]*?\.topbar \.primary-top-action span,[\s\S]*?\.topbar \.refresh-button span\s*{[^}]*display:\s*none/s);
  });

  it('gives remote workspace commands phone-sized touch targets on compact screens', () => {
    expect(styles).toMatch(/@media \(max-width:\s*1100px\)\s*{[\s\S]*?\.file-toolbar \.message-action-button\s*{[^}]*min-height:\s*40px/s);
  });

  it('keeps remote workspace surfaces on the active tonal theme at every viewport', () => {
    expect(styles).toMatch(/\.file-context-card,[\s\S]*?\.worker-diagnostic-card\s*{[^}]*border:\s*1px solid var\(--ah-border[^}]*background:\s*var\(--ah-surface[^}]*color:\s*var\(--ah-text/s);
    expect(styles).toMatch(/\.file-browser-card,[\s\S]*?\.file-preview-card\s*{[^}]*border:\s*1px solid var\(--ah-border[^}]*background:\s*var\(--ah-surface[^}]*color:\s*var\(--ah-text/s);
    expect(styles).toMatch(/\.file-search-row\s*{[^}]*border:\s*1px solid var\(--ah-border[^}]*background:\s*var\(--ah-surface-soft/s);
    expect(styles).toMatch(/\.file-browser-title span,[\s\S]*?\.file-preview-title\s*{[^}]*color:\s*var\(--ah-text/s);
    expect(styles).toMatch(/\.file-browser-title small,[\s\S]*?\.file-preview-summary\s*{[^}]*color:\s*var\(--ah-muted/s);
  });

  it('restores dark selected states for mobile reply and question controls', () => {
    expect(styles).toMatch(/\.reply-mode-tabs button\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#d6e0ec/s);
    expect(styles).toMatch(/\.reply-mode-tabs button\.selected\s*{[^}]*background:\s*rgba\(90,\s*167,\s*255,\s*0\.2\)[^}]*color:\s*#dcebff/s);
    expect(styles).toMatch(/\.question-options button\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#e5edf6/s);
    expect(styles).toMatch(/\.question-options button\.selected\s*{[^}]*background:\s*rgba\(90,\s*167,\s*255,\s*0\.2\)[^}]*color:\s*#dcebff/s);
    expect(styles).toMatch(/\.question-options button\.selected small\s*{[^}]*color:\s*rgba\(220,\s*235,\s*255,\s*0\.78\)/s);
  });

  it('prioritizes the desktop transcript over collapsible session chrome', () => {
    expect(styles).toMatch(/\.thread-pane\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(styles).toMatch(/\.thread-status-strip\s*{[^}]*max-height:\s*34px/s);
    expect(styles).not.toContain('.task-summary-card');
    expect(styles).toMatch(/\.message-block\s*{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.timeline-tabs\s*{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*background:\s*var\(--ah-bg-elevated\)/s);
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';
    expect(mobileBlock).toMatch(/\.timeline-tabs\s*{[^}]*position:\s*static/s);
  });

  it('uses explicit, layout-stable disclosure for the desktop quiet cockpit', () => {
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.session-filter-drawer:not\(\.is-open\)\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.ops-rail\[data-inspector-mode='overview'\] > \.rail-panel\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.message-actions\s*{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.message-line:hover \.message-actions,[\s\S]*?pointer-events:\s*auto/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.composer-options\s*{[^}]*position:\s*absolute/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.composer-options:not\(\.is-open\)\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.timeline-tabs\s*{[^}]*background:\s*var\(--ah-bg-elevated\)/s);
    expect(styles).not.toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.reply-box:not\(\.is-focused\)[^}]*\.voice-mode-bar/s);
    expect(styles).toMatch(/@media \(min-width:\s*1101px\)\s*{[\s\S]*?\.message-block > \*\s*{[^}]*max-width:\s*920px/s);
  });

  it('keeps mobile composer options visible as an overlay in compact mode', () => {
    const mobileBlock = styles.match(/@media \(max-width: 760px\) \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';
    expect(mobileBlock).toMatch(/\.composer-options\s*{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 8px\)/s);
    expect(mobileBlock).toMatch(/\.composer-options:not\(\.is-open\)\s*{[^}]*display:\s*none/s);
    expect(mobileBlock).toMatch(/\.reply-box\.is-compact \.composer-options\.is-open \.voice-mode-bar,[\s\S]*?\.quick-reply-strip\s*{[^}]*display:\s*flex/s);
  });

  it('keeps desktop dark theme surfaces readable instead of mixing white admin cards', () => {
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-box\s*{[^}]*background:\s*rgba\(20,\s*29,\s*42,\s*0\.96\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.permission-card,\s*\n\.app-shell\.theme-dark \.rail-panel,\s*\n\.app-shell\.theme-dark \.inspector-overview\s*{[^}]*background:\s*#141d2a/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-box textarea\s*{[^}]*background:\s*#1b2736/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.timeline-tabs button,\s*\n\.app-shell\.theme-dark \.native-icon-button,\s*\n\.app-shell\.theme-dark \.secondary-action,\s*\n\.app-shell\.theme-dark \.message-action-button/s);
  });

  it('keeps Workbench and its task composer on the shared tonal theme', () => {
    expect(styles).toMatch(/\.workbench-layout\s*{[^}]*height:\s*calc\(100dvh - 60px\)[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.task-composer\s*{[^}]*background:\s*var\(--ah-surface\)[^}]*color:\s*var\(--ah-text\)/s);
    expect(styles).toMatch(/\.task-composer-fields\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(styles).toMatch(/\.task-composer input,\s*\n\.task-composer select,\s*\n\.task-composer textarea\s*{[^}]*background:\s*var\(--ah-surface-soft\)[^}]*color:\s*var\(--ah-text\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.task-composer\s*{[^}]*box-shadow:\s*0 28px 80px rgba\(0,\s*0,\s*0,\s*0\.46\)/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)\s*{[\s\S]*?\.task-composer\s*{[^}]*width:\s*100%[^}]*max-height:\s*calc\(100dvh/s);
    expect(styles).toMatch(/\.artifact-card-head\s*{[^}]*display:\s*flex/s);
    expect(styles).not.toMatch(/\.artifact-card > div\s*{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.task-composer \.dialog-head \.icon-button\s*{[^}]*background:\s*var\(--ah-surface-soft\)[^}]*color:\s*var\(--ah-text\)/s);
    expect(styles).toMatch(/\.task-composer-actions button\s*{[^}]*min-height:\s*38px[^}]*padding:\s*0 14px/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)\s*{[\s\S]*?\.task-composer \.dialog-head\s*{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*2/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)\s*{[\s\S]*?\.task-composer-actions\s*{[^}]*position:\s*sticky[^}]*bottom:\s*0[^}]*z-index:\s*2/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)\s*{[\s\S]*?\.task-composer-fields\s*{[^}]*padding-bottom:\s*8px/s);
  });

  it('gives the runtime cockpit a contained, keyboard-visible operational layout', () => {
    expect(styles).toMatch(/\.runtime-cockpit\s*{[^}]*height:\s*calc\(100dvh - 60px\)[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.runtime-cockpit-row\s*{[^}]*min-height:\s*72px/s);
    expect(styles).toMatch(/\.runtime-cockpit-row-main:focus-visible\s*{[^}]*outline:\s*2px solid var\(--ah-accent\)/s);
    expect(styles).toMatch(/\.runtime-cockpit-state-icon\s*{[^}]*width:\s*36px[^}]*height:\s*36px/s);
    expect(styles).toMatch(/\.runtime-cockpit-row\.lane-attention\s+\.runtime-cockpit-state-icon\s*{[^}]*color:\s*var\(--ah-status-approval\)/s);
  });

  it('keeps desktop dark chrome from mixing in light topbar and filter controls', () => {
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*color-scheme:\s*dark/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.topbar\s*{[^}]*background:\s*rgba\(15,\s*23,\s*34,\s*0\.96\)[^}]*border-bottom-color:\s*rgba\(91,\s*141,\s*184,\s*0\.18\)/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.topbar \.icon-button,\s*\n\.app-shell\.theme-dark \.topbar \.role-chip,\s*\n\.app-shell\.theme-dark \.topbar \.sync-chip\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#e5edf6/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.search-box input,\s*\n\.app-shell\.theme-dark \.search-clear-button\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#e5edf6/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.provider-filter\s*{[^}]*scrollbar-color:\s*rgba\(90,\s*167,\s*255,\s*0\.38\) transparent/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-mode-tabs button\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#d6e0ec/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.reply-mode-tabs button\.selected\s*{[^}]*background:\s*rgba\(90,\s*167,\s*255,\s*0\.2\)[^}]*color:\s*#dcebff/s);
  });

  it('keeps the desktop dark notification inbox on the tonal palette', () => {
    expect(styles).toMatch(/\.app-shell\.theme-dark \.notification-inbox\s*{[^}]*background:\s*#141d2a[^}]*color:\s*#e5edf6/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.notification-inbox-item\s*{[^}]*background:\s*#1b2736[^}]*color:\s*#e5edf6/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.notification-inbox-item\.unread\s*{[^}]*background:\s*#132236/s);
  });

  it('uses a tonal dark palette instead of harsh pure black and white contrast', () => {
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-bg:\s*#0b1118/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-bg-elevated:\s*#0f1722/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-surface:\s*#141d2a/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-surface-soft:\s*#1b2736/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-text:\s*#e5edf6/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-muted:\s*#92a3b8/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-accent:\s*#5aa7ff/s);
    expect(styles).not.toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-bg:\s*#(?:000|000000)\b/s);
    expect(styles).not.toMatch(/\.app-shell\.theme-dark\s*{[^}]*--ah-text:\s*#f8fafc/s);
    expect(styles).not.toMatch(/\.app-shell\.theme-dark\s*{[^}]*background:\s*#050607/s);
  });

  it('allows the control pane to scroll independently on web and Android', () => {
    expect(styles).toMatch(/\.ops-rail\s*{[^}]*min-height:\s*0[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+minmax\(320px,\s*1fr\)/);
    expect(styles).toMatch(/@media \(max-width: 1120px\)\s*{[\s\S]*?\.workspace\s*{[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/@media \(max-width: 1120px\)\s*{[\s\S]*?\.ops-rail\s*{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*max-height:\s*none/s);
    expect(styles).toMatch(/\.ops-rail > \*\s*{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/\.rail-panel\s*{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/\.workspace\.mobile-pane-controls \.ops-rail\s*{[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.workspace\.mobile-pane-controls \.ops-rail\s*{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
    expect(styles).toMatch(/\.workspace\.mobile-pane-controls \.rail-panel\s*{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/\.workspace\.mobile-pane-controls \.rail-panel\.is-open \.rail-panel-body\s*{[^}]*display:\s*grid/s);
  });

  it('keeps the mobile scroll-to-bottom affordance as a compact floating circle', () => {
    expect(styles).toMatch(/\.scroll-to-bottom-button\s*{[^}]*width:\s*38px[^}]*height:\s*38px[^}]*padding:\s*0/s);
    expect(styles).toMatch(/\.scroll-to-bottom-button\s*{[^}]*min-width:\s*38px[^}]*min-height:\s*38px/s);
    expect(styles).toMatch(/\.thread-pane > \*:not\(\.scroll-to-bottom-button\)\s*{[^}]*width:\s*100%/s);
    expect(styles).toMatch(/@media \(max-width: 760px\)\s*{[\s\S]*?\.scroll-to-bottom-button\s*{[^}]*width:\s*42px[^}]*height:\s*42px/s);
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

  it('restores markdown document formatting inside the full text preview', () => {
    expect(styles).toMatch(/\.rich-preview ul,\s*\n\.rich-preview ol\s*{[^}]*padding-left:\s*1\.35em[^}]*margin:\s*0\.75em 0/s);
    expect(styles).toMatch(/\.rich-preview ul\s*{[^}]*list-style:\s*disc/s);
    expect(styles).toMatch(/\.rich-preview ol\s*{[^}]*list-style:\s*decimal/s);
    expect(styles).toMatch(/\.rich-preview code\s*{[^}]*font-family:\s*ui-monospace/s);
    expect(styles).toMatch(/\.rich-preview h1,\s*\n\.rich-preview h2,\s*\n\.rich-preview h3\s*{[^}]*font-weight:\s*800/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.rich-preview code,\s*\n\.app-shell\.theme-dark \.rich-preview pre\s*{[^}]*background:\s*#0a1018/s);
    expect(styles).toMatch(/\.app-shell\.theme-dark \.rich-preview th,\s*\n\.app-shell\.theme-dark \.rich-preview td\s*{[^}]*border-color:\s*rgba\(91,\s*141,\s*184,\s*0\.18\)/s);
  });

  it('uses one Files navigation stack on phones and a list-detail workspace on larger screens', () => {
    expect(styles).toMatch(/\.remote-workspace-layout\s*{[^}]*display:\s*grid/s);
    expect(styles).toMatch(/@media \(min-width:\s*761px\)[\s\S]*?\.remote-workspace-layout\s*{[^}]*grid-template-columns:\s*minmax\(280px,\s*0\.85fr\) minmax\(0,\s*1\.4fr\)/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.remote-workspace-layout\.view-preview \.remote-workspace-explorer\s*{[^}]*display:\s*none/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.remote-workspace-layout\.view-explorer \.remote-workspace-preview\s*{[^}]*display:\s*none/s);
  });
});
