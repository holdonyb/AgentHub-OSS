import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../ui/theme';
import { parseMarkdownBlocks, type MarkdownSpan } from './richMarkdownPresentation';

interface RichMarkdownProps {
  value: string;
  onLinkPress?(url: string): void;
}

function InlineMarkdown({ spans, onLinkPress }: { spans: MarkdownSpan[]; onLinkPress?: (url: string) => void }) {
  return (
    <Text selectable style={styles.body}>
      {spans.map((span, index) => {
        const key = `${span.kind}-${index}-${span.text}`;
        if (span.kind === 'strong') return <Text key={key} style={styles.strong}>{span.text}</Text>;
        if (span.kind === 'code') return <Text key={key} style={styles.code}>{span.text}</Text>;
        if (span.kind === 'link') {
          return (
            <Text
              accessibilityLabel={`链接 ${span.text}`}
              accessibilityRole="link"
              key={key}
              onPress={() => onLinkPress?.(span.url)}
              style={styles.link}
            >
              {span.text}
            </Text>
          );
        }
        return <Text key={key}>{span.text}</Text>;
      })}
    </Text>
  );
}

export function RichMarkdown({ value, onLinkPress }: RichMarkdownProps) {
  const blocks = parseMarkdownBlocks(value);
  return (
    <View accessibilityLabel="Markdown 内容" style={styles.container}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === 'heading') {
          const headingStyle = block.level === 1 ? styles.headingOne : block.level === 2 ? styles.headingTwo : styles.headingThree;
          return <Text key={key} selectable style={[styles.heading, headingStyle]}>{block.text}</Text>;
        }
        if (block.kind === 'code_block') {
          return (
            <View key={key} style={styles.codeBlock}>
              {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
              <Text selectable style={styles.codeBlockText}>{block.text}</Text>
            </View>
          );
        }
        if (block.kind === 'unordered_list' || block.kind === 'ordered_list') {
          return (
            <View key={key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`${key}-${itemIndex}`} style={styles.listRow}>
                  <Text style={styles.listMarker}>{block.kind === 'ordered_list' ? `${itemIndex + 1}.` : '•'}</Text>
                  <View style={styles.listContent}><InlineMarkdown onLinkPress={onLinkPress} spans={item} /></View>
                </View>
              ))}
            </View>
          );
        }
        return <InlineMarkdown key={key} onLinkPress={onLinkPress} spans={block.spans} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  body: { color: colors.text, fontSize: 15, lineHeight: 24 },
  strong: { fontWeight: '800' },
  code: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 4, borderWidth: 1, fontFamily: 'monospace', paddingHorizontal: 4 },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  heading: { color: colors.text, fontWeight: '800' },
  headingOne: { fontSize: 23, lineHeight: 30 },
  headingTwo: { fontSize: 19, lineHeight: 26 },
  headingThree: { fontSize: 16, lineHeight: 23 },
  list: { gap: 7 },
  listRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  listMarker: { color: colors.accent, fontSize: 16, lineHeight: 24, width: 16 },
  listContent: { flex: 1 },
  codeBlock: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 8, borderWidth: 1, gap: 6, padding: 10 },
  codeLanguage: { color: colors.muted, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  codeBlockText: { color: colors.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 20 },
});
