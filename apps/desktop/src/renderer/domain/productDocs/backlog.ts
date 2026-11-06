import type { ProductBlock } from "../../data/model";
import { anchorIdsOf, isTextBlock } from "./blocks";
import { sectionRange } from "./sections";

// Le voci di backlog che una pagina di prodotto può proporre (11b, Task 7;
// shape product-claude-backlog.md §3.1–3.2, P35): pura, senza stato. Sono le
// voci di elenco (puntato, numerato) e le liste di controllo con una frase,
// della pagina intera o della sola sezione di un titolo. Il titolo è la
// frase, parola per parola (anti-obiettivo «decisioni inventate»: niente
// riassunti, niente urgenza né stima che la pagina non dice); la
// descrizione cita la frase e il titolo della sezione.

export interface BacklogCandidate {
  anchorId: string;
  title: string;
  description: string;
  /** La frase intera, senza segni (la riga del perché della scheda). */
  sentence: string;
}

/** Il titolo di una richiesta: al più 120 caratteri, con «…» (la frase intera è nella descrizione). */
const TITLE_MAX = 120;

const LIST_TYPES: ReadonlySet<ProductBlock["type"]> = new Set(["bullet", "numbered", "todo"]);

const titleOf = (sentence: string): string =>
  sentence.length <= TITLE_MAX ? sentence : `${sentence.slice(0, TITLE_MAX - 1).trimEnd()}…`;

/**
 * Le candidate, nell'ordine della pagina. `fromAnchorId` = l'id di un
 * titolo: solo ciò che gli sta sotto, fino al titolo di livello uguale o più
 * alto (`sectionRange`); un id che non è un titolo della pagina non ha
 * sezione (nessuna candidata). `page` mette in testa alla descrizione
 * «From <codice> <titolo>».
 */
export function backlogCandidatesOf(
  blocks: readonly ProductBlock[],
  fromAnchorId: string | null,
  page?: { code: string; title: string },
): BacklogCandidate[] {
  let range: ReadonlySet<string> | null = null;
  if (fromAnchorId !== null) {
    const heading = blocks.find((b) => b.id === fromAnchorId);
    if (heading?.type !== "heading") return [];
    range = new Set(sectionRange(blocks, fromAnchorId));
  }
  const out: BacklogCandidate[] = [];
  let section: string | null = null;
  for (const block of blocks) {
    if (block.type === "heading") section = block.content.text.trim() || null;
    if (!LIST_TYPES.has(block.type) || !isTextBlock(block)) continue;
    if (range !== null && !anchorIdsOf(block).every((id) => range.has(id))) continue;
    const sentence = block.content.text.trim();
    if (sentence === "") continue;
    const where = [page ? `From ${page.code} ${page.title}` : null, section].filter((x) => x !== null);
    const quoted = `“${sentence}”`;
    out.push({
      anchorId: block.id,
      title: titleOf(sentence),
      description: where.length > 0 ? `${where.join(" › ")}: ${quoted}` : quoted,
      sentence,
    });
  }
  return out;
}
