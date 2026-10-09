import { isSafeWebUrl } from "@stubwise/shared";
import { Linking, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { MARKDOWN_STYLE } from "../theme/markdown";

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
const LITERAL_PARSER = MarkdownIt({ typographer: false });

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
   * `false` = niente sostituzioni tipografiche (`--` → `–`, `'` → `’`…): per
   * il testo di una DOMANDA dell'agente, dove un comando o un nome devono
   * restare come scritti. Default `true`, il comportamento di sempre.
   */
  typographer?: boolean;
}

export function SafeMarkdown({ children, style, typographer = true }: SafeMarkdownProps) {
  const own = StyleSheet.flatten(style);
  const merged =
    own === undefined
      ? MARKDOWN_STYLE
      : {
          ...MARKDOWN_STYLE,
          body: { ...MARKDOWN_STYLE.body, ...own },
          paragraph: { marginTop: 0, marginBottom: 0 },
        };
  return (
    <Markdown
      style={merged}
      {...(typographer ? {} : { markdownit: LITERAL_PARSER })}
      onLinkPress={(url) => {
        if (isSafeWebUrl(url)) void Linking.openURL(url);
        return false;
      }}
    >
      {children}
    </Markdown>
  );
}
