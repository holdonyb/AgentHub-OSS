// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  buildSandboxedSrcDoc,
  detectMessageRenderKind,
  sanitizeHtmlPreview,
  sanitizeRunnableHtml,
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

  it('strips unsafe javascript links from html preview', () => {
    const sanitized = sanitizeHtmlPreview('<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>');
    expect(sanitized).not.toContain('javascript:alert');
    expect(sanitized).toContain('https://example.com');
  });

  it('keeps script for runnable html while still stripping forms iframes and inline handlers', () => {
    const runnable = sanitizeRunnableHtml(
      '<div onclick="alert(1)"><script>window.__ok=1</script><iframe src="x"></iframe><form></form></div>',
    );
    expect(runnable).toContain('<script>window.__ok=1</script>');
    expect(runnable).not.toContain('onclick=');
    expect(runnable).not.toContain('<iframe');
    expect(runnable).not.toContain('<form');
  });

  it('builds a sandboxable srcdoc shell', () => {
    const srcDoc = buildSandboxedSrcDoc('<p>Hello</p>');
    expect(srcDoc).toContain('<!doctype html>');
    expect(srcDoc).toContain('<p>Hello</p>');
  });

  it('builds a runnable srcdoc shell without hiding media when scripts are allowed', () => {
    const srcDoc = buildSandboxedSrcDoc('<img src="a.png" />', { allowScripts: true });
    expect(srcDoc).not.toContain('display:none !important');
  });
});
