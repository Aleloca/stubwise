import type { ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import Markdown from "react-native-markdown-display";
import { MARKDOWN_STYLE } from "../theme/markdown";

/**
 * Markdown INLINE per testi che stanno dentro un controllo (etichetta e
 * conseguenza delle opzioni di una domanda). Stesso renderer e stesso tema di
 * `SafeMarkdown`, con tre regole sostituite: il corpo e il paragrafo diventano
 * `Text` (la libreria li fa `View` con margini di blocco, che spaccherebbero il
 * layout dell'opzione), e un link diventa il suo testo — niente `onPress` dentro
 * un `Pressable`. Il nome accessibile resta il testo senza i segni del markdown.
 */
export function InlineMarkdown({
  children,
  style,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
}) {
  const inline = (node: { key: string }, content: ReactNode) => (
    <Text key={node.key} style={style}>
      {content}
    </Text>
  );
  return (
    <Markdown
      style={MARKDOWN_STYLE}
      rules={{
        body: inline,
        paragraph: inline,
        link: (node, content) => <Text key={node.key}>{content}</Text>,
      }}
    >
      {children}
    </Markdown>
  );
}
