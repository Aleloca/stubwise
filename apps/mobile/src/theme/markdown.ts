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
 * Le taglie di una DOMANDA dell'agente, ovunque nell'app (sessione, card e
 * foglio d'inbox, ticket, chat del backlog) — un solo posto per i valori.
 * Testo 15/21 SemiBold (10 ott 2026; era 16/22, e prima ancora lo stile
 * titolo 20/26 Bold: una domanda di 8-10 righe occupava mezzo schermo).
 */
export const QUESTION_TEXT_STYLE = {
  color: colors.fg,
  fontFamily: fontFamily.sansSemiBold,
  fontSize: 15,
  fontWeight: "600",
  lineHeight: 21,
} as const;

/** Etichetta di un'opzione (anche «Other (free text)»): 14/20 SemiBold (era 16). */
export const QUESTION_OPTION_LABEL_STYLE = {
  color: colors.fg,
  fontFamily: fontFamily.sansSemiBold,
  fontSize: 14,
  fontWeight: "600",
  lineHeight: 20,
} as const;

/** Conseguenza di un'opzione: 12.5/17 muted (era 13/18). */
export const QUESTION_OPTION_CONSEQUENCE_STYLE = {
  color: colors.muted,
  fontFamily: fontFamily.sans,
  fontSize: 12.5,
  lineHeight: 17,
} as const;

/** Padding interno di un'opzione (era 14). */
export const QUESTION_OPTION_PADDING = 12;

/**
 * Il codice inline dentro un testo di una domanda (testo, etichetta,
 * conseguenza) è ~90% della taglia del testo che lo circonda — il mono a
 * parità di taglia sembra più grande —, arrotondato in su al mezzo punto
 * (15 → 13.5, 14 → 13, 12.5 → 11.5) e mai più grande del testo. L'interlinea è
 * QUELLA del testo, così una riga col codice non si allarga; il peso è
 * `normal`, quello del mono Regular. Regola unica, la
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
    // IBMPlexMono-Regular: senza, eredita il "600" del testo della domanda
    // (falso grassetto o font di ripiego su Android).
    fontWeight: "normal" as const,
    ...(typeof text?.lineHeight === "number" ? { lineHeight: text.lineHeight } : {}),
  };
}
