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
    expect(favicon).toContain('#0d66d0');
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

    expect(mobileBlock).toContain('--mobile-topbar-height: 54px');
    expect(mobileBlock).toContain('--mobile-nav-height: 64px');
    expect(mobileBlock).toContain('--mobile-composer-clearance: 240px');
    expect(mobileBlock).toMatch(/\.topbar\s*{[^}]*height:\s*var\(--mobile-topbar-height\)/s);
    expect(mobileBlock).toMatch(/\.workspace\s*{[^}]*height:\s*calc\(100dvh - var\(--mobile-topbar-height\) - var\(--mobile-nav-height\)/s);
    expect(mobileBlock).toMatch(/\.message-block\s*{[^}]*padding:\s*6px 0 var\(--mobile-composer-clearance\)/s);
    expect(mobileBlock).toMatch(/\.load-older-button\s*{[^}]*margin-bottom:\s*28px/s);
  });
});
