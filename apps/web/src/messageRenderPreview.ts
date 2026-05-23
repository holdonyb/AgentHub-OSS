import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type MessageRenderKind = 'plain' | 'markdown' | 'html';

const HTML_TAG_PATTERN =
  /<(html|body|main|article|section|div|span|p|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|pre|code|h[1-6])(\s|>)/i;
const MARKDOWN_PATTERN = /(^|\n)\s{0,3}(#{1,6}\s|\-\s|\*\s|\d+\.\s|```|\|.+\|)/m;
const BLOCKED_STYLE_PROPERTIES = new Set([
  'position',
  'z-index',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
]);

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
      return !BLOCKED_STYLE_PROPERTIES.has(key);
    })
    .join('; ');
}

function stripUnsafeLinks(html: string) {
  return html.replace(/\s(href|src)\s*=\s*(['"])\s*(javascript:|data:)[^'"]*\2/gi, '');
}

function stripBlockedContainers(html: string) {
  return html
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<form\b[\s\S]*?<\/form>/gi, '');
}

function stripInlineEventHandlers(html: string) {
  return html.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
}

function filterStyleAttributes(html: string) {
  return html.replace(/style="([^"]*)"/gi, (_match: string, styleValue: string) => {
    const filtered = filterStyle(styleValue);
    return filtered ? `style="${filtered}"` : '';
  });
}

export function sanitizeHtmlPreview(html: string) {
  const preStripped = stripBlockedContainers(html);
  const sanitized = DOMPurify.sanitize(preStripped, {
    FORBID_TAGS: ['script', 'iframe', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onsubmit', 'srcset'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const strippedLinks = stripUnsafeLinks(stripBlockedContainers(sanitized));
  return filterStyleAttributes(strippedLinks);
}

export function sanitizeRunnableHtml(html: string) {
  const stripped = stripBlockedContainers(stripUnsafeLinks(stripInlineEventHandlers(html)));
  return filterStyleAttributes(stripped);
}

export function renderMarkdownPreview(text: string) {
  return sanitizeHtmlPreview(marked.parse(text) as string);
}

export function buildSandboxedSrcDoc(html: string, options?: { allowScripts?: boolean }) {
  const allowScripts = options?.allowScripts ?? false;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<style>body{font-family:Inter,system-ui,sans-serif;padding:16px;line-height:1.6;word-break:break-word;}pre{white-space:pre-wrap;}table{border-collapse:collapse;max-width:100%;}td,th{border:1px solid #d7dce5;padding:6px 8px;}${
      allowScripts ? '' : 'img,video,audio{display:none !important;}'
    }</style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}
