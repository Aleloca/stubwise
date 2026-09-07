/**
 * ROUTING DELLA POSTA verso un progetto (Fase 6) — logica PURA.
 *
 * Sta in `@stubwise/notifications` e non nel worker perché ha due lati che non
 * devono divergere: il **server** valida e normalizza le regole che l'admin
 * scrive (`PUT /api/projects/:id/email-routes`), il **worker** le applica a ogni
 * messaggio che Gmail restituisce. Se la normalizzazione vivesse solo nella
 * rotta, una regola scritta a mano nel DB — o scritta da una versione futura
 * della UI — verrebbe confrontata con un'altra grafia della stessa cosa.
 *
 * Nessuna dipendenza da DB o rete: si testa con oggetti in memoria.
 *
 * ## Come il poller (Task 7) la usa — DUE volte, ed è il punto
 *
 * Gmail costa: scaricare il corpo di ogni messaggio di ogni casella sarebbe la
 * spesa più grossa del tick. Quindi il poller chiama {@link matchRoutes} una
 * PRIMA volta sui soli **metadati** (header ed etichette, `format=metadata`),
 * **senza `text`**: se `inScope` è `false` il messaggio non viene nemmeno
 * scaricato e non esiste in `email_messages`. Solo per i messaggi in perimetro
 * scarica il `full`, estrae il testo e richiama `matchRoutes` col corpo — che
 * può far combaciare una `keyword` in più e quindi risolvere un progetto che
 * sui soli metadati era ambiguo.
 *
 * ⚠️ Conseguenza da tenere a mente: una regola `keyword` che combacia SOLO nel
 * corpo non fa entrare il messaggio in perimetro, perché al pre-filtro il corpo
 * non c'è ancora. È una scelta di costo, non una svista: per catturare un
 * messaggio serve almeno una regola visibile nei metadati (mittente,
 * destinatario, etichetta, o la keyword nell'oggetto).
 */

/** I quattro tipi di regola, gli stessi del CHECK su `project_email_routes.kind`. */
export type EmailRouteKind = "sender_domain" | "sender_address" | "gmail_label" | "keyword";

/**
 * Una regola di routing: "i messaggi che soddisfano questo criterio parlano di
 * questo progetto". `value` è confrontato SEMPRE normalizzato (vedi
 * {@link normalizeRouteValue}), quindi passarlo già lowercase — come lo scrive
 * il server — o con le maiuscole dell'admin dà lo stesso esito.
 */
export interface EmailRoute {
  projectId: string;
  kind: EmailRouteKind;
  value: string;
}

/**
 * Il messaggio come lo vede il routing. Tutti i campi accettano la forma grezza
 * degli header Gmail (`Mario Rossi <m@acme.com>`): la normalizzazione è qui.
 *
 * `text` è **opzionale** apposta: al pre-filtro sui metadati non c'è ancora
 * (vedi il docblock del modulo).
 */
export interface EmailForRouting {
  /** Header `From`, grezzo o già normalizzato. */
  fromAddress: string;
  /** Header `To`, già spezzato in indirizzi (vedi {@link parseAddressList}). */
  toAddresses: string[];
  /** Header `Cc`, se presente. */
  ccAddresses?: string[];
  /** Le etichette Gmail del messaggio (`labelIds`: `INBOX`, `Label_42`, …). */
  labels: string[];
  /** Header `Subject`. */
  subject: string;
  /** Testo del corpo già estratto. Assente al pre-filtro sui metadati. */
  text?: string;
}

/** L'esito del routing di un messaggio. */
export interface EmailRoutingResult {
  /**
   * `true` se ALMENO una regola di ALMENO un progetto combacia. È questo — e
   * non `projectId !== null` — il criterio di "in perimetro": un messaggio può
   * essere in perimetro e insieme ambiguo.
   */
  inScope: boolean;
  /**
   * Il progetto risolto: quello che soddisfa il numero MAGGIORE di regole.
   * `null` sia fuori perimetro sia in parità (li distingue `inScope`).
   */
  projectId: string | null;
  /**
   * I progetti a pari merito quando le regole non decidono, ordinati in modo
   * stabile. Vuoto quando il progetto è risolto o il messaggio è fuori
   * perimetro. È il valore di `email_messages.candidate_project_ids`.
   */
  candidateProjectIds: string[];
  /**
   * Quante regole DISTINTE di ciascun progetto combaciano. Serve ai test e alla
   * diagnosi ("perché questa mail è finita lì?"); i progetti con zero regole
   * soddisfatte non compaiono.
   */
  matchedRuleCount: Record<string, number>;
}

/**
 * Un indirizzo email normalizzato: estratto dalle parentesi angolari se
 * l'header porta anche il nome visualizzato, senza spazi ai bordi, minuscolo.
 * Stringa vuota se non c'è nulla di utile.
 */
export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  const angled = /<([^<>]*)>/.exec(raw);
  const address = (angled?.[1] ?? raw).trim().toLowerCase();
  return address;
}

/** Il dominio di un indirizzo (dopo l'ultima chiocciola), o stringa vuota. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1);
}

/**
 * Spezza un header `To`/`Cc` nei suoi indirizzi normalizzati, senza doppioni.
 *
 * Le virgole dentro un nome fra virgolette (`"Rossi, Mario" <m@acme.com>`) NON
 * sono separatori: è il caso che rompe lo `split(",")` ingenuo, ed è il motivo
 * per cui questa funzione esiste invece di stare inline nel poller.
 */
export function parseAddressList(header: string | null | undefined): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngles = false;
  for (const char of header) {
    if (char === '"' && !inAngles) {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "<" && !inQuotes) inAngles = true;
    else if (char === ">" && !inQuotes) inAngles = false;
    if (char === "," && !inQuotes && !inAngles) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const part of parts) {
    const address = normalizeAddress(part);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    addresses.push(address);
  }
  return addresses;
}

/**
 * La forma canonica del `value` di una regola: è ciò che il server scrive in
 * `project_email_routes.value` e ciò con cui il routing confronta.
 *
 * - `sender_address`: l'indirizzo estratto e minuscolo — un admin che incolla
 *   `Mario <Mario@Acme.com>` intende la casella, non la stringa.
 * - `sender_domain`: minuscolo, senza una eventuale `@` iniziale (`@acme.com`
 *   è come lo si scrive a mente) e senza un punto finale.
 * - `gmail_label` e `keyword`: solo trim + minuscolo. Gli spazi interni di una
 *   keyword contano (`"portale clienti"` è una frase, non due parole).
 */
export function normalizeRouteValue(kind: EmailRouteKind, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (kind === "sender_address") return normalizeAddress(trimmed);
  if (kind === "sender_domain") return trimmed.replace(/^@+/, "").replace(/\.+$/, "");
  return trimmed;
}

/**
 * Un carattere "di parola", Unicode-aware: lettera, cifra o `_`.
 *
 * `\b` di una regex JS è ASCII-only e non basta — tratterebbe l'inizio o la
 * fine di "città" come un confine, facendo combaciare una keyword incollata a
 * una lettera accentata. `\p{L}`/`\p{N}` (col flag `u`) coprono l'alfabeto che
 * conta qui.
 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * `haystack` contiene `needle` su un confine di PAROLA, non come una
 * sottostringa qualunque: `"api"` non deve combaciare dentro `"capitale"`. Si
 * scorrono a mano i caratteri adiacenti a ogni occorrenza — vedi
 * {@link isWordChar} sul perché non basta `\b`. `needle` può contenere spazi
 * interni (`"portale clienti"` è una frase): il confine si controlla solo agli
 * estremi della frase intera, non a ogni parola che la compone.
 */
export function containsWholeWord(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
}

/** Una regola combacia con questo messaggio? Tutto già normalizzato. */
function ruleMatches(
  kind: EmailRouteKind,
  value: string,
  addresses: string[],
  domains: Set<string>,
  labels: Set<string>,
  haystack: string,
): boolean {
  switch (kind) {
    case "sender_domain":
      return domains.has(value);
    case "sender_address":
      return addresses.includes(value);
    case "gmail_label":
      return labels.has(value);
    case "keyword":
      return containsWholeWord(haystack, value);
  }
}

/**
 * Decide a quale progetto appartiene un messaggio, date TUTTE le regole di
 * TUTTI i progetti.
 *
 * Il criterio è il numero di regole soddisfatte, non l'ordine: il progetto che
 * ne soddisfa di più vince. In parità nessuno vince e i pari merito finiscono
 * in `candidateProjectIds`, perché indovinare fra due progetti è peggio che
 * chiedere. Se nessuna regola combacia il messaggio è fuori perimetro
 * (`inScope: false`) e il poller non ne scarica nemmeno il corpo.
 *
 * @param message il messaggio (header grezzi ammessi; `text` assente al pre-filtro)
 * @param routes le regole di tutti i progetti, in qualunque ordine
 */
export function matchRoutes(message: EmailForRouting, routes: EmailRoute[]): EmailRoutingResult {
  const addresses: string[] = [];
  for (const raw of [message.fromAddress, ...message.toAddresses, ...(message.ccAddresses ?? [])]) {
    const address = normalizeAddress(raw);
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  const domains = new Set(addresses.map(domainOf).filter((domain) => domain !== ""));
  const labels = new Set(
    message.labels.map((label) => label.trim().toLowerCase()).filter((label) => label !== ""),
  );
  // Oggetto e corpo sono un solo pagliaio: una keyword vale in entrambi, e il
  // separatore evita che la fine dell'oggetto e l'inizio del corpo formino per
  // caso una frase che nessuno dei due contiene.
  const haystack = `${message.subject ?? ""}\n${message.text ?? ""}`.toLowerCase();

  const matchedRuleCount: Record<string, number> = {};
  // Deduplica le regole: l'unique `(project_id, kind, value)` lo garantisce già
  // nel DB, ma il conteggio non deve dipendere da chi ha costruito la lista.
  const seenRules = new Set<string>();
  for (const rule of routes) {
    const value = normalizeRouteValue(rule.kind, rule.value);
    // Una regola vuota non è "combacia con tutto": è una riga senza contenuto,
    // e con `includes("")` farebbe entrare in perimetro l'intera casella.
    if (value === "") continue;
    const key = `${rule.projectId} ${rule.kind} ${value}`;
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    if (!ruleMatches(rule.kind, value, addresses, domains, labels, haystack)) continue;
    matchedRuleCount[rule.projectId] = (matchedRuleCount[rule.projectId] ?? 0) + 1;
  }

  const entries = Object.entries(matchedRuleCount);
  if (entries.length === 0) {
    return { inScope: false, projectId: null, candidateProjectIds: [], matchedRuleCount };
  }

  const best = Math.max(...entries.map(([, count]) => count));
  // Ordinamento stabile: l'esito non deve dipendere dall'ordine in cui il
  // chiamante ha letto le regole dal DB.
  const winners = entries
    .filter(([, count]) => count === best)
    .map(([projectId]) => projectId)
    .sort();

  if (winners.length === 1) {
    return { inScope: true, projectId: winners[0]!, candidateProjectIds: [], matchedRuleCount };
  }
  return { inScope: true, projectId: null, candidateProjectIds: winners, matchedRuleCount };
}
