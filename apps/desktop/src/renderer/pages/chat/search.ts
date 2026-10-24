import { daysFromToday } from "../../data/dates";
import type { ChatMessageHit, ChatSearchFilters } from "../../data/types";

// La ricerca della Chat come dato (shape chat-search.md): i parametri
// dell'indirizzo (`#/chat?view=search&q=…`) e i filtri che ne nascono, le
// parole da evidenziare, i gruppi per canale, il ritorno ai risultati e
// l'evidenza del messaggio raggiunto. Cosa si cerca lo decide solo
// `searchChat` (livello dati): qui niente filtra per visibilità.

/** Sotto, niente ricerca: «Type at least 2 characters». */
export const MIN_QUERY = 2;

export const DATE_RANGES = ["today", "7d", "30d", "custom"] as const;
export type DateRange = (typeof DATE_RANGES)[number];

/** I parametri della pagina dei risultati, come stanno nell'indirizzo. */
export interface ChatSearchParams {
  q?: string | undefined;
  /** Il canale («In»). */
  in?: string | undefined;
  /** La persona («From»), Claude compreso. */
  by?: string | undefined;
  when?: DateRange | undefined;
  /** Con `when=custom`: giorni ISO inclusi. */
  since?: string | undefined;
  until?: string | undefined;
  /** Con allegati, con citazioni, solo persone (`1`). */
  att?: "1" | undefined;
  cit?: "1" | undefined;
  ppl?: "1" | undefined;
}

export const SEARCH_PARAM_KEYS = [
  "q",
  "in",
  "by",
  "when",
  "since",
  "until",
  "att",
  "cit",
  "ppl",
] as const satisfies readonly (keyof ChatSearchParams)[];

/** Un parametro della ricerca ha una forma valida (il router scarta il resto). */
export function isSearchParamValue(key: string, value: string): boolean {
  switch (key) {
    case "q":
      return value.length > 0 && value.length <= 200;
    case "in":
    case "by":
      return /^[\w-]+$/.test(value);
    case "when":
      return (DATE_RANGES as readonly string[]).includes(value);
    case "since":
    case "until":
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "att":
    case "cit":
    case "ppl":
      return value === "1";
    default:
      return false;
  }
}

/** I filtri di `searchChat` dai parametri (le date dall'oggi fisso del prototipo). */
export function filtersOf(p: ChatSearchParams): ChatSearchFilters {
  const out: ChatSearchFilters = {};
  if (p.in) out.channelId = p.in;
  if (p.by) out.authorId = p.by;
  if (p.att) out.withAttachments = true;
  if (p.cit) out.withCitations = true;
  if (p.ppl) out.peopleOnly = true;
  const range = dateRangeOf(p);
  if (range.from) out.from = range.from;
  if (range.to) out.to = range.to;
  return out;
}

export function dateRangeOf(p: ChatSearchParams): { from?: string; to?: string } {
  switch (p.when) {
    case "today":
      return { from: daysFromToday(0), to: daysFromToday(0) };
    case "7d":
      return { from: daysFromToday(-6), to: daysFromToday(0) };
    case "30d":
      return { from: daysFromToday(-29), to: daysFromToday(0) };
    case "custom":
      return {
        ...(p.since ? { from: p.since } : {}),
        ...(p.until ? { to: p.until } : {}),
      };
    default:
      return {};
  }
}

/** C'è almeno un filtro («Clear filters»). */
export const hasFilters = (p: ChatSearchParams): boolean =>
  !!(p.in || p.by || p.when || p.att || p.cit || p.ppl);

/** I parametri senza i filtri (resta la query). */
export const withoutFilters = (p: ChatSearchParams): ChatSearchParams => (p.q ? { q: p.q } : {});

/** Senza maiuscole né accenti: la stessa piegatura del livello dati. */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Le parole della ricerca, piegate. */
export const searchWords = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean);

export interface TextPart {
  text: string;
  hit: boolean;
}

/**
 * Il testo diviso in pezzi trovati e non: una parola si trova senza
 * maiuscole né accenti («caffe» evidenzia «Caffè»), e i pezzi sono sempre
 * del testo originale.
 */
export function highlightParts(text: string, words: readonly string[]): TextPart[] {
  if (words.length === 0 || text === "") return text ? [{ text, hit: false }] : [];
  // Il testo piegato e, per ogni suo carattere, da quale carattere originale viene.
  let folded = "";
  const origin: number[] = [];
  const chars = [...text];
  let offset = 0;
  for (const ch of chars) {
    const f = fold(ch);
    for (let i = 0; i < f.length; i++) origin.push(offset);
    folded += f;
    offset += ch.length;
  }
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    let at = folded.indexOf(word);
    while (at >= 0) {
      const start = origin[at]!;
      const lastOrigin = origin[at + word.length - 1]!;
      let end = lastOrigin + (text.codePointAt(lastOrigin)! > 0xffff ? 2 : 1);
      // Gli accenti scritti a parte restano con la loro lettera.
      while (end < text.length && /\p{M}/u.test(text[end]!)) end++;
      for (let i = start; i < end; i++) marked[i] = true;
      at = folded.indexOf(word, at + Math.max(1, word.length));
    }
  }
  const out: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked[i]!;
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i]!, hit });
  }
  return out;
}

/** Un messaggio come riga di testo, senza markdown: per i risultati e la palette. */
export function plainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:[#>]+|[-*+]|\d+\.)\s+/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}

export interface HitGroup {
  channelId: string;
  hits: ChatMessageHit[];
}

/**
 * I risultati per canale: i gruppi nell'ordine della corrispondenza più
 * recente, dentro il più recente in alto (i risultati arrivano già così).
 */
export function groupByChannel(hits: readonly ChatMessageHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.channelId) ?? { channelId: hit.channelId, hits: [] };
    group.hits.push(hit);
    groups.set(hit.channelId, group);
  }
  return [...groups.values()];
}

// --- il ritorno ai risultati ----------------------------------------------------
//
// Saltando a un messaggio dalla pagina dei risultati si ricorda (in memoria,
// per la sessione) dove tornare: la pillola «Back to results» del canale e
// ⌘[ la usano finché si guarda quel messaggio.

interface ResultsMark {
  personId: string;
  messageId: string;
  href: string;
  /** Il risultato selezionato, per ritrovarlo tornando. */
  selected: string;
}

let resultsMark: ResultsMark | null = null;

export function rememberResults(mark: ResultsMark): void {
  resultsMark = { ...mark };
}

/** Dove tornare se `messageId` è il messaggio raggiunto dalla ricerca di `personId`. */
export function resultsFor(personId: string, messageId: string | undefined): ResultsMark | null {
  if (!resultsMark || !messageId) return null;
  return resultsMark.personId === personId && resultsMark.messageId === messageId
    ? resultsMark
    : null;
}

/** Il risultato da riselezionare tornando alla pagina (una volta sola). */
export function takeSelectedResult(personId: string, href: string): string | null {
  if (!resultsMark || resultsMark.personId !== personId || resultsMark.href !== href) return null;
  return resultsMark.selected;
}

export function forgetResults(): void {
  resultsMark = null;
}

// --- l'evidenza del messaggio raggiunto ----------------------------------------

/** Quanto dura l'evidenza (anche con movimento ridotto, senza dissolvenza). */
export const FOUND_MS = 2000;

/**
 * Evidenzia un messaggio raggiunto (ricerca, menzione, link): fondo
 * d'inchiostro al 10% che svanisce in 2 s; con movimento ridotto resta 2 s e
 * sparisce senza dissolvenza (lo decide il CSS di `[data-found]`).
 */
export function flashMessage(el: HTMLElement): void {
  el.removeAttribute("data-found");
  // Un riflusso, perché l'animazione riparta se lo stesso messaggio torna.
  void el.offsetWidth;
  el.setAttribute("data-found", "");
  window.setTimeout(() => el.removeAttribute("data-found"), FOUND_MS);
}
