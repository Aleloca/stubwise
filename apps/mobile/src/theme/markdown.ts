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
  code_inline: { backgroundColor: colors.ink800, borderColor: colors.line, color: colors.fg, fontFamily: fontFamily.mono },
  fence: { backgroundColor: colors.ink800, borderColor: colors.line, fontFamily: fontFamily.mono },
  code_block: { backgroundColor: colors.ink800, borderColor: colors.line, fontFamily: fontFamily.mono },
  // Fix 5 ott 2026: la libreria dà a citazioni, righe e tabelle colori pensati
  // per uno sfondo CHIARO (`#F5F5F5` dietro la citazione, nero su `hr` e sui
  // bordi): su questo tema la citazione era testo chiaro su fondo bianco,
  // illeggibile. Ogni colore di default va sovrascritto qui —
  // `markdown.test.ts` lo verifica leggendo gli stili della libreria.
  blockquote: { backgroundColor: colors.ink800, borderColor: colors.lineStrong },
  hr: { backgroundColor: colors.line },
  table: { borderColor: colors.line },
  tr: { borderColor: colors.line },
  blocklink: { borderColor: colors.line },
};

/**
 * Il testo di una DOMANDA dell'agente, ovunque nell'app (sessione, card e
 * foglio d'inbox, ticket, chat del backlog): 16/22 SemiBold (9 ott 2026).
 * Prima era lo stile titolo 20/26 Bold, e una domanda di 8-10 righe occupava
 * mezzo schermo. Le etichette delle opzioni (16) e le conseguenze (13) non
 * cambiano: stanno nei loro componenti.
 */
export const QUESTION_TEXT_STYLE = {
  color: colors.fg,
  fontFamily: fontFamily.sansSemiBold,
  fontSize: 16,
  fontWeight: "600",
  lineHeight: 22,
} as const;

/**
 * Il codice inline dentro un testo di una domanda (testo, etichetta,
 * conseguenza) è ~90% della taglia del testo che lo circonda — il mono a
 * parità di taglia sembra più grande —, arrotondato in su al mezzo punto
 * (16 → 14.5, 15 → 13.5, 13 → 12) e mai più grande del testo. L'interlinea è
 * QUELLA del testo, così una riga col codice non si allarga. Regola unica, la
 * usano `SafeMarkdown` (modalità domanda) e `InlineMarkdown`.
 */
export function inlineCodeSize(textSize: number): number {
  return Math.min(textSize, Math.ceil(textSize * 0.9 * 2) / 2);
}

/** Le sole due proprietà del testo che contano; `null`/`undefined` = corpo di default. */
type SurroundingText = { fontSize?: unknown; lineHeight?: number | undefined } | null | undefined;

export function questionInlineCodeStyle(text: SurroundingText) {
  const size = typeof text?.fontSize === "number" ? text.fontSize : fontSize.body;
  return {
    ...MARKDOWN_STYLE.code_inline,
    fontSize: inlineCodeSize(size),
    ...(typeof text?.lineHeight === "number" ? { lineHeight: text.lineHeight } : {}),
  };
}
