/**
 * Chunking markdown-aware di `@stubwise/docs-engine`: spezza un documento in chunk
 * dimensionati per l'embedding, rispettando i confini di heading e con overlap.
 *
 * Logica PURA e deterministica. Strategia:
 *  1. il documento è diviso in SEZIONI ai confini degli heading markdown
 *     (`#`, `##`, …). Ogni sezione ricorda l'heading di provenienza (testo
 *     dell'heading, senza i `#`); il testo che precede il primo heading ha
 *     `heading: null`;
 *  2. ogni sezione viene impacchettata in chunk fino a ~`targetTokens` token. Una
 *     sezione che eccede il target viene spezzata su confine di parola in più
 *     chunk; quelle piccole restano un chunk a sé (NON si accorpano sezioni con
 *     heading diversi, così l'heading di ogni chunk resta univoco);
 *  3. tra chunk consecutivi della STESSA sezione si ripetono in testa le ultime
 *     `overlap` parole del chunk precedente (continuità di contesto per il RAG).
 *
 * STIMA TOKEN. Si stima il numero di token dal numero di PAROLE con il rapporto
 * `TOKENS_PER_WORD` (~1.33 token/parola, cioè ~0.75 parole/token): un'euristica
 * comune per testo inglese/italiano con tokenizer BPE. Quindi una sezione entra in
 * un chunk finché `parole * TOKENS_PER_WORD <= targetTokens`, ovvero finché
 * `parole <= targetTokens / TOKENS_PER_WORD`. È volutamente approssimata: serve a
 * dimensionare i chunk, non a contare token esatti.
 *
 * AVVERTENZE.
 *  - Lo split avviene su confine di PAROLA: una singola parola più lunga del target
 *    non viene spezzata, quindi un token oversize (codice, base64, URL lunghi) può
 *    far superare il target a quel chunk.
 *  - La stima 1.33 token/parola è grossolana e SOTTOSTIMA i token per contenuti
 *    densi di codice o accentati (più subword per parola): chi chiama a valle per
 *    l'embedding dovrebbe dimensionare `targetTokens` in modo conservativo.
 */

/** Token stimati per parola (~0.75 parole/token). Vedi doc-header per il razionale. */
const TOKENS_PER_WORD = 1.33;

/** Un chunk di markdown con l'heading di provenienza (o `null` se pre-heading). */
export interface MarkdownChunk {
  content: string;
  heading: string | null;
}

export interface ChunkOptions {
  /** Dimensione target del chunk, in token stimati. */
  targetTokens: number;
  /** Numero di parole ripetute in overlap tra chunk consecutivi della stessa sezione. */
  overlap: number;
}

interface Section {
  heading: string | null;
  /** Righe della sezione, incluso l'heading se presente. */
  lines: string[];
}

/** Riconosce una riga di heading markdown ATX (`#`…`######`) e ne estrae il testo. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Divide il markdown in sezioni ai confini degli heading. */
function splitSections(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      current = { heading: m[2]!.trim(), lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      // testo prima del primo heading: apre una sezione `heading: null`; le righe
      // pre-heading successive vi si accumulano tramite il ramo `current` qui sopra.
      current = { heading: null, lines: [line] };
      sections.push(current);
    }
  }
  return sections;
}

/** Numero massimo di parole per chunk, derivato dal target in token. */
function maxWords(targetTokens: number): number {
  return Math.max(1, Math.floor(targetTokens / TOKENS_PER_WORD));
}

/**
 * Spezza una sezione in uno o più chunk rispettando il limite di parole e
 * applicando l'overlap tra chunk consecutivi.
 */
function chunkSection(section: Section, opts: ChunkOptions): MarkdownChunk[] {
  const text = section.lines.join("\n").trim();
  if (text === "") return [];

  const words = text.split(/\s+/).filter(Boolean);
  const limit = maxWords(opts.targetTokens);

  if (words.length <= limit) {
    return [{ content: text, heading: section.heading }];
  }

  const overlap = Math.max(0, Math.min(opts.overlap, limit - 1));
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + limit, words.length);
    const slice = words.slice(start, end);
    chunks.push({ content: slice.join(" "), heading: section.heading });
    if (end >= words.length) break;
    // avanza lasciando `overlap` parole di sovrapposizione
    start = end - overlap;
  }
  return chunks;
}

/**
 * Spezza `md` in chunk markdown-aware. Vedi il doc-header del modulo per la
 * strategia, la stima dei token e la semantica dell'overlap.
 */
export function chunkMarkdown(
  md: string,
  opts: ChunkOptions,
): MarkdownChunk[] {
  if (md.trim() === "") return [];
  const sections = splitSections(md);
  const chunks: MarkdownChunk[] = [];
  for (const section of sections) {
    chunks.push(...chunkSection(section, opts));
  }
  return chunks;
}
