import { isSafeWebUrl } from "@stubwise/shared";
import { Linking } from "react-native";
import Markdown from "react-native-markdown-display";
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
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      style={MARKDOWN_STYLE}
      onLinkPress={(url) => {
        if (isSafeWebUrl(url)) void Linking.openURL(url);
        return false;
      }}
    >
      {children}
    </Markdown>
  );
}
