import type { ProductBlock, ProductPage, RichText } from "../../data/model";
import { languageName } from "./codeLanguages";
import { richSegments, safeLinkHref } from "./richText";

// Il modello dell'esportazione (area 11a, Task 12): puro, senza stato. Il
// PDF (`PrintView`) e il Word (`docx.ts`) leggono questo modello solo, così
// le due uscite dicono la stessa cosa. Entrano i blocchi della pagina come li
// legge chi esporta: grassetto, corsivo e link (http/https soltanto), le
// immagini, i file del Drive e le decisioni come una riga già composta, e
// (11b) le bozze di schermata come immagine. Non entrano mai commenti,
// presenza, chi segue, segni di Claude.

export interface ExportDoc {
  title: string;
  pages: { code: string; title: string; depth: number; blocks: ExportBlock[] }[];
}

/** Un pezzo di frase coi suoi segni (da `richSegments`; un codice è testo semplice). */
export interface ExportRun {
  text: string;
  bold: boolean;
  italic: boolean;
  href: string | null;
}

export type ExportBlock =
  | { kind: "heading"; level: 1 | 2 | 3; runs: ExportRun[] }
  | { kind: "paragraph" | "quote"; runs: ExportRun[] }
  | { kind: "list"; ordered: boolean; indent: 0 | 1 | 2; runs: ExportRun[] }
  | { kind: "todo"; checked: boolean; runs: ExportRun[] }
  | { kind: "divider" }
  /** Il blocco di codice: testo semplice su più righe e il nome del linguaggio (`null` = testo semplice). */
  | { kind: "code"; language: string | null; text: string }
  | { kind: "table"; rows: ExportRun[][][] }
  | { kind: "image"; src: string; caption: string }
  /** Un file del Drive o una decisione del registro: una riga già composta per chi esporta. */
  | { kind: "line"; line: string }
  /**
   * 11b (Task 7, P36): la bozza di schermata di Claude come immagine — l'SVG
   * del seme (PNG per il Word con `svgToPng`, il PDF lo stampa com'è) —
   * senza testata né bottoni. `label` = mai tenuta: sotto va «Bozza di
   * Claude · Bozza di schermata», composta da chi stampa (`PrintView`,
   * `docx.ts`); tenuta, esce come le altre figure (maintainer, 6 nov 2026).
   * `svg: null` = un disegno che il seme non ha più.
   */
  | { kind: "sketch"; svg: string | null; label: boolean };

export interface ExportResolve {
  driveLine(fileId: string, code: string): string;
  decisionLine(decisionId: string): string;
  /** L'SVG di una bozza di schermata (`ProductExportView.wireframes`); `null` se il seme non l'ha più. */
  wireframe(wireframeId: string, variant: number): string | null;
}

/**
 * I pezzi di una frase. Ogni `href` ripassa da `safeLinkHref`: un indirizzo
 * che non è http(s) (scritto nello stato saltando la validazione) esce
 * come testo. Due pezzi vicini coi segni uguali diventano uno (un codice è
 * un pezzo a sé in `richSegments`, qui è testo come gli altri).
 */
export function exportRunsOf(rt: RichText): ExportRun[] {
  const out: ExportRun[] = [];
  for (const s of richSegments(rt)) {
    const run: ExportRun = {
      text: s.text,
      bold: s.bold,
      italic: s.italic,
      href: s.href === null ? null : safeLinkHref(s.href),
    };
    const last = out.at(-1);
    if (last && last.bold === run.bold && last.italic === run.italic && last.href === run.href) {
      last.text += run.text;
    } else out.push(run);
  }
  return out;
}

/**
 * I livelli dei titoli nelle due uscite, perché l'indice del Word e i titoli
 * del PDF dicano lo stesso albero. Il titolo del documento sta sopra tutto
 * (livello 0). Una pagina sola non ripete il suo titolo (è quello del
 * documento): i suoi titoli valgono 1–3. Nello spazio intero ogni pagina
 * prende il livello della sua profondità (1, 2, 3 al più) e i suoi titoli
 * stanno sotto di lei; mai oltre 6.
 */
export function pageHeadingLevel(doc: ExportDoc, depth: number): number | null {
  return doc.pages.length > 1 ? Math.min(depth + 1, 3) : null;
}

export function blockHeadingLevel(doc: ExportDoc, depth: number, level: 1 | 2 | 3): number {
  return Math.min((pageHeadingLevel(doc, depth) ?? 0) + level, 6);
}

function blockOf(block: ProductBlock, resolve: ExportResolve): ExportBlock {
  switch (block.type) {
    case "heading":
      return { kind: "heading", level: block.level, runs: exportRunsOf(block.content) };
    case "paragraph":
    case "quote":
      return { kind: block.type, runs: exportRunsOf(block.content) };
    case "bullet":
    case "numbered":
      return {
        kind: "list",
        ordered: block.type === "numbered",
        indent: block.indent,
        runs: exportRunsOf(block.content),
      };
    case "todo":
      return { kind: "todo", checked: block.checked, runs: exportRunsOf(block.content) };
    case "divider":
      return { kind: "divider" };
    case "code":
      return {
        kind: "code",
        language: block.language === undefined ? null : languageName(block.language),
        text: block.content.text,
      };
    case "table":
      return { kind: "table", rows: block.rows.map((r) => r.cells.map((c) => exportRunsOf(c.content))) };
    case "image":
      return { kind: "image", src: block.src, caption: block.caption };
    case "drive":
      return { kind: "line", line: resolve.driveLine(block.fileId, block.code) };
    case "decision":
      return { kind: "line", line: resolve.decisionLine(block.decisionId) };
    case "wireframe":
      return { kind: "sketch", svg: resolve.wireframe(block.wireframeId, block.variant), label: block.kept !== true };
  }
}

/** Pagina o spazio intero (ordine dell'albero), come lo legge chi esporta; grassetto, corsivo e link sì (ogni `href` ripassa da `safeLinkHref`); mai commenti, presenza o segni di Claude. */
export function exportModelOf(
  input: { title: string; pages: { page: ProductPage; depth: number }[] },
  resolve: ExportResolve,
): ExportDoc {
  return {
    title: input.title,
    pages: input.pages.map(({ page, depth }) => ({
      code: page.code,
      title: page.title,
      depth,
      blocks: page.blocks.map((b) => blockOf(b, resolve)),
    })),
  };
}
