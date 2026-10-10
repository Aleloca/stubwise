import { isSafeWebUrl } from "@stubwise/shared";
import { Linking, StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { MARKDOWN_STYLE, QUESTION_TEXT_STYLE, questionInlineCodeStyle } from "../theme/markdown";

/**
 * Markdown reso col tema dell'app e coi link che passano dall'allowlist degli
 * schemi (16 set 2026).
 *
 * ⚠️ **Esiste per non ripetere la guardia.** `react-native-markdown-display`,
 * lasciato a sé, apre QUALUNQUE `href` con `Linking.openURL` — `javascript:`,
 * `file:`, lo schema di un'altra app installata. Quattro schermate rendono
 * markdown (Docs, dettaglio progetto, piano di un ticket, voce di backlog) e
 * fino a oggi nessuna controllava: una regola di sicurezza scritta in quattro
 * posti è una regola che prima o poi diverge, e la copia che diverge è quella
 * che lascia passare.
 *
 * `isSafeWebUrl` (`@stubwise/shared`) ammette solo `http`/`https` — la stessa
 * funzione che difende i link dentro il corpo di un'email. NON è
 * `isSafeJoinUrl`, che ammette anche `tel:`: quello vale per un campo
 * STRUTTURATO che Google dichiara come telefono, non per un href scritto in
 * mezzo a un documento.
 *
 * `onLinkPress` torna sempre `false`: l'apertura la decidiamo noi, mai la
 * libreria.
 */
/**
 * Parser senza tipografia: `--force` resta `--force` (non `–force`) e
 * l'apostrofo resta `'`. Uno solo, condiviso: la libreria memoizza sull'istanza.
 */
export const LITERAL_MARKDOWN_PARSER = MarkdownIt({ typographer: false });

export interface SafeMarkdownProps {
  children: string;
  /**
   * Stile di testo del chiamante, fuso nel `body` (lo ereditano tutte le
   * foglie; il codice inline resta mono, il grassetto resta bold). Con lo
   * stile, i paragrafi perdono i margini: un testo di una riga tiene il
   * riquadro che aveva come `Text`.
   */
  style?: StyleProp<TextStyle>;
  /**
   * Il testo di una DOMANDA dell'agente (sessione, inbox, ticket, backlog):
   * - niente sostituzioni tipografiche (`--` → `–`, `'` → `’`…): un comando o
   *   un nome restano come scritti;
   * - le immagini NON si caricano, resta l'alt (niente se vuoto): il contenuto
   *   del ticket non è fidato e può far scrivere all'agente un'immagine remota
   *   che fa da pixel di tracciamento — stessa dottrina della posta.
   * - il testo è `QUESTION_TEXT_STYLE` (16/22 SemiBold), sotto lo `style` del
   *   chiamante, e il codice inline è ~90% della taglia con la stessa
   *   interlinea (`questionInlineCodeStyle`).
   * Default `false`: altrove (testo dell'agente, piano, Docs) tutto come prima.
   */
  question?: boolean;
}

/** Un'immagine resa come il suo alt: nessun `FitImage`, nessuna richiesta. */
const IMAGE_AS_ALT_RULES = {
  image: (node: { key: string; attributes?: Record<string, string> }) => (
    <Text key={node.key}>{node.attributes?.alt ?? ""}</Text>
  ),
};

export function SafeMarkdown({ children, style, question = false }: SafeMarkdownProps) {
  const own = StyleSheet.flatten(style);
  const text = question ? { ...QUESTION_TEXT_STYLE, ...own } : own;
  const merged =
    text === undefined
      ? MARKDOWN_STYLE
      : {
          ...MARKDOWN_STYLE,
          body: { ...MARKDOWN_STYLE.body, ...text },
          paragraph: { marginTop: 0, marginBottom: 0 },
          ...(question ? { code_inline: questionInlineCodeStyle(text) } : {}),
        };
  return (
    <Markdown
      style={merged}
      {...(question ? { markdownit: LITERAL_MARKDOWN_PARSER, rules: IMAGE_AS_ALT_RULES } : {})}
      onLinkPress={(url) => {
        if (isSafeWebUrl(url)) void Linking.openURL(url);
        return false;
      }}
    >
      {children}
    </Markdown>
  );
}
