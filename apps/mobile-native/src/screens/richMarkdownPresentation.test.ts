import { parseMarkdownBlocks } from './richMarkdownPresentation';

describe('native rich markdown presentation', () => {
  it('parses headings, lists, code, emphasis, and safe links without executing HTML', () => {
    expect(parseMarkdownBlocks([
      '# 发布计划',
      '',
      '- **构建** Android APK',
      '- 查看 [Release](https://github.com/holdonyb/AgentHub-OSS/releases)',
      '',
      '执行 `npm run mobile:native:test`。',
      '',
      '```sh',
      'npm run mobile:native:build:android:debug',
      '```',
      '<script>alert(1)</script>',
    ].join('\n'))).toEqual([
      { kind: 'heading', level: 1, text: '发布计划' },
      {
        kind: 'unordered_list',
        items: [
          [
            { kind: 'strong', text: '构建' },
            { kind: 'text', text: ' Android APK' },
          ],
          [
            { kind: 'text', text: '查看 ' },
            { kind: 'link', text: 'Release', url: 'https://github.com/holdonyb/AgentHub-OSS/releases' },
          ],
        ],
      },
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: '执行 ' },
          { kind: 'code', text: 'npm run mobile:native:test' },
          { kind: 'text', text: '。' },
        ],
      },
      { kind: 'code_block', language: 'sh', text: 'npm run mobile:native:build:android:debug' },
      { kind: 'paragraph', spans: [{ kind: 'text', text: '<script>alert(1)</script>' }] },
    ]);
  });

  it('keeps only http, https, and worker-local file links actionable', () => {
    const [paragraph] = parseMarkdownBlocks(
      '[安全](https://example.com) [本地](E:/Work/AgentHub-OSS/README.md) [危险](javascript:alert(1))',
    );

    expect(paragraph).toEqual({
      kind: 'paragraph',
      spans: [
        { kind: 'link', text: '安全', url: 'https://example.com' },
        { kind: 'text', text: ' ' },
        { kind: 'link', text: '本地', url: 'E:/Work/AgentHub-OSS/README.md' },
        { kind: 'text', text: ' 危险' },
      ],
    });
  });
});
