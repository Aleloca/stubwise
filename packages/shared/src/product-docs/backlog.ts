import type { ProductBlock } from "../schemas/product-docs.js";
import { anchorIdsOf, isTextBlock } from "./blocks.js";
import { sectionRange } from "./sections.js";

/**
 * Area 11, F6 — le voci di backlog che una pagina di prodotto può proporre
 * (il prototipo: `domain/productDocs/backlog.ts`, shape
 * product-claude-backlog.md §3.1–3.2, P35). Pura. Sono le voci di elenco
 * (puntato, numerato) e le liste di controllo con una frase, della pagina
 * intera o della sola sezione di un titolo. Il titolo è la frase, parola per
 * parola (niente riassunti, niente urgenza né stima che la pagina non dice);
 * la descrizione è la frase intera e NIENT'ALTRO: né il codice né il titolo
 * della pagina, né quello della sezione (R-G5: la descrizione si salva, e la
 * legge anche chi non vede la pagina).
 */
export interface BacklogCandidate {
  anchorId: string;
  title: string;
  /** La frase intera: la descrizione della richiesta. */
  description: string;
  /** La frase intera, senza segni (la riga del perché della scheda). */
  sentence: string;
}

/** Il titolo di una richiesta: al più 120 caratteri, con «…» (la frase intera è nella descrizione). */
const TITLE_MAX = 120;
const LIST_TYPES: ReadonlySet<ProductBlock["type"]> = new Set(["bullet", "numbered", "todo"]);

const titleOf = (sentence: string): string => (sentence.length <= TITLE_MAX ? sentence : `${sentence.slice(0, TITLE_MAX - 1).trimEnd()}…`);

/**
 * Le candidate, nell'ordine della pagina. `fromAnchorId` = l'id di un
 * titolo: solo ciò che gli sta sotto, fino al titolo di livello uguale o più
 * alto; un id che non è un titolo della pagina non ha sezione (nessuna).
 */
export function backlogCandidatesOf(blocks: readonly ProductBlock[], fromAnchorId: string | null): BacklogCandidate[] {
  let range: ReadonlySet<string> | null = null;
  if (fromAnchorId !== null) {
    const heading = blocks.find((b) => b.id === fromAnchorId);
    if (heading?.type !== "heading") return [];
    range = new Set(sectionRange(blocks, fromAnchorId));
  }
  const out: BacklogCandidate[] = [];
  for (const block of blocks) {
    if (!LIST_TYPES.has(block.type) || !isTextBlock(block)) continue;
    if (range !== null && !anchorIdsOf(block).every((id) => range.has(id))) continue;
    const sentence = block.content.text.trim();
    if (sentence === "") continue;
    out.push({ anchorId: block.id, title: titleOf(sentence), description: sentence, sentence });
  }
  return out;
}
