import { colors } from "./tokens";
import { fontFamily, fontSize } from "./typography";

/**
 * Stile condiviso per `react-native-markdown-display`: unica definizione,
 * riusata da ogni renderer markdown mobile (`PlanSection.tsx` — Task 16,
 * "Leggi il piano completo" — e `DocsPageScreen.tsx` — Task 18, la pagina
 * Docs). Prima era duplicato char-per-char nei due file, tenuto sincronizzato
 * solo da un commento — estratto qui per avere una SOLA fonte di verità.
 *
 * Sanitizzazione: markdown-it (la libreria sotto al renderer) ha `html: false`
 * di DEFAULT — un tag HTML nel testo viene escapato a testo letterale, mai
 * interpretato — verificato nella sorgente del pacchetto prima di aggiungerlo
 * (Task 16); nessuna config esplicita necessaria, ma NESSUNO tolga questa nota
 * pensando che manchi una configurazione.
 *
 * Fix di review (11 set 2026, Task 1 del piano di fix): `body` non aveva
 * `fontFamily` — era il caso PEGGIORE del gap di copertura del Sans, perché
 * `body` è lo stile di default di OGNI testo markdown (brief settimanale,
 * pagine Docs, documenti del backlog, risposte della chat "Chiedi al
 * progetto"): tutto quel testo restava nel font di sistema anche dopo il
 * Task 7. `heading1`/`heading2`/`heading3`/`strong` prendono `sansBold` (la
 * libreria li rende già `fontWeight: "bold"` di default — verificato nel suo
 * sorgente — ma un font statico custom non sintetizza il grassetto da sé, va
 * nominato il peso). `code_inline`/`fence`/`code_block` prendono `mono`
 * ESPLICITO: non erano nello scope segnalato, ma verificato nello stesso
 * sorgente che la libreria non applica un monospace di default — senza
 * questa riga il codice inline/a blocchi sarebbe finito anche lui nel Sans,
 * lo stesso difetto una porta più in là.
 */
export const MARKDOWN_STYLE = {
  body: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: fontSize.body },
  heading1: { color: colors.fg, fontFamily: fontFamily.sansBold },
  heading2: { color: colors.fg, fontFamily: fontFamily.sansBold },
  heading3: { color: colors.fg, fontFamily: fontFamily.sansBold },
  strong: { color: colors.fg, fontFamily: fontFamily.sansBold },
  bullet_list: { marginTop: 4 },
  code_inline: { backgroundColor: colors.ink800, color: colors.fg, fontFamily: fontFamily.mono },
  fence: { backgroundColor: colors.ink800, borderColor: colors.line, fontFamily: fontFamily.mono },
  code_block: { backgroundColor: colors.ink800, borderColor: colors.line, fontFamily: fontFamily.mono },
};
