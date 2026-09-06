import { colors } from "./tokens";
import { fontSize } from "./typography";

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
 */
export const MARKDOWN_STYLE = {
  body: { color: colors.fg, fontSize: fontSize.body },
  heading1: { color: colors.fg },
  heading2: { color: colors.fg },
  heading3: { color: colors.fg },
  strong: { color: colors.fg },
  bullet_list: { marginTop: 4 },
  code_inline: { backgroundColor: colors.ink800, color: colors.fg },
  fence: { backgroundColor: colors.ink800, borderColor: colors.line },
  code_block: { backgroundColor: colors.ink800, borderColor: colors.line },
};
