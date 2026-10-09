import type { ReactNode } from "react";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import Markdown from "react-native-markdown-display";
import { MARKDOWN_STYLE } from "../theme/markdown";

/** I marcatori di blocco a inizio riga si "escapano": restano testo, come col `parseInline` del web. */
function escapeBlockMarkers(source: string): string {
  return source.replace(/^([ \t]{0,3})([#>*+\-=]|~{3,}|`{3,}|\d+(?=[.)]))/gm, (_m, indent, marker) =>
    `${indent}\\${marker}`,
  );
}

/**
 * Markdown INLINE per testi che stanno dentro un controllo (etichetta e
 * conseguenza delle opzioni di una domanda). Stesso renderer e tema di
 * `SafeMarkdown`, ma:
 * - lo stile del chiamante VINCE: è il `body` della mappa di stile, e la
 *   libreria lo fa ereditare a ogni foglia (altrimenti ogni foglia tornerebbe
 *   al corpo del markdown); il codice inline tiene il mono;
 * - corpo e paragrafo sono `Text` (non `View` con margini di blocco), un link è
 *   il suo testo (niente `onPress` dentro un `Pressable`), un'immagine è il suo
 *   `alt` (niente caricamenti remoti);
 * - titoli, elenchi, citazioni e blocchi di codice non si formano: la sintassi
 *   di blocco resta testo, in parità con `InlineMarkdown` del web.
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
  const literal = (node: { key: string; content?: string }) => (
    <Text key={node.key} style={style}>
      {node.content ?? ""}
    </Text>
  );
  return (
    <Markdown
      style={{ ...MARKDOWN_STYLE, body: StyleSheet.flatten(style) ?? MARKDOWN_STYLE.body }}
      rules={{
        body: inline,
        paragraph: inline,
        link: (node, content) => <Text key={node.key}>{content}</Text>,
        image: (node) => <Text key={node.key}>{node.attributes?.alt ?? ""}</Text>,
        fence: literal,
        code_block: literal,
      }}
    >
      {escapeBlockMarkers(children)}
    </Markdown>
  );
}
