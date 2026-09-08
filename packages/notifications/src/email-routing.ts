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
  /**
   * Gli header usati dall'ammissione (fase 6c) per riconoscere la posta
   * automatica: `List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`.
   * Chiavi già in minuscolo, come le normalizza `packages/google/src/gmail.ts`
   * (`headers[header.name.toLowerCase()] = header.value`). **Opzionale**: un
   * chiamante che non lo passa (es. codice scritto prima della fase 6c) non
   * rompe nulla — {@link admit} con `denyAutomated` acceso si comporta come
   * "nessun header automatico presente", cioè non rifiuta per quel motivo.
   */
  headers?: Record<string, string>;
}

/** L'esito del routing di un messaggio. */
export interface EmailRoutingResult {
  /**
   * @deprecated dalla fase 6c: l'ingresso di un'email nel sistema è deciso da
   * {@link admit}, non più da `inScope`. Questo campo resta SOLO perché il
   * calendario (`apps/worker/src/google/calendar.ts` e dintorni, che non ha
   * ammissione, solo attribuzione) lo usa ancora — non rimuoverlo.
   *
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
  /**
   * TUTTI i progetti con almeno una regola soddisfatta (`matchedRuleCount[id]
   * > 0`), non solo il vincitore: è il PERIMETRO ammesso alla classificazione
   * (fase 6b) — un'email può parlare di più progetti insieme. Ordinato per
   * conteggio DECRESCENTE e, a parità, per `projectId` CRESCENTE (ordine
   * deterministico, non quello di lettura delle regole dal DB). Include
   * sempre `projectId` (il vincitore) quando risolto, e anche i progetti che
   * NON entrano in `candidateProjectIds` (i pari merito minori del vertice).
   * Vuoto quando il messaggio è fuori perimetro.
   */
  scopeProjectIds: string[];
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
    const key = `${rule.projectId}\x1f${rule.kind}\x1f${value}`;
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    if (!ruleMatches(rule.kind, value, addresses, domains, labels, haystack)) continue;
    matchedRuleCount[rule.projectId] = (matchedRuleCount[rule.projectId] ?? 0) + 1;
  }

  const entries = Object.entries(matchedRuleCount);
  // Il perimetro: tutti i progetti con almeno un match, per conteggio
  // decrescente e poi per id crescente — deterministico indipendentemente
  // dall'ordine di iterazione dell'oggetto `matchedRuleCount`.
  const scopeProjectIds = [...entries]
    .sort(([aId, aCount], [bId, bCount]) => {
      if (aCount !== bCount) return bCount - aCount;
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    })
    .map(([projectId]) => projectId);

  if (entries.length === 0) {
    return { inScope: false, projectId: null, candidateProjectIds: [], matchedRuleCount, scopeProjectIds };
  }

  const best = Math.max(...entries.map(([, count]) => count));
  // Ordinamento stabile: l'esito non deve dipendere dall'ordine in cui il
  // chiamante ha letto le regole dal DB.
  const winners = entries
    .filter(([, count]) => count === best)
    .map(([projectId]) => projectId)
    .sort();

  if (winners.length === 1) {
    return {
      inScope: true,
      projectId: winners[0]!,
      candidateProjectIds: [],
      matchedRuleCount,
      scopeProjectIds,
    };
  }
  return {
    inScope: true,
    projectId: null,
    candidateProjectIds: winners,
    matchedRuleCount,
    scopeProjectIds,
  };
}

// ---------------------------------------------------------------------------
// AMMISSIONE (Fase 6c) — separata dall'attribuzione qui sopra.
//
// `matchRoutes` risponde "di quale progetto parla questa email?". `admit`
// risponde a una domanda diversa e PRECEDENTE: "questa email è lavoro, o va
// nemmeno guardata?". Prima della fase 6c le due domande condividevano lo
// stesso meccanismo (`inScope` di `matchRoutes`), il che costringeva a
// scrivere una regola `sender_domain` per ogni dominio dei propri Workspace
// su OGNI progetto — quattro domini, dodici progetti, quarantotto regole per
// esprimere quattro fatti. Qui i due passi sono separati: `admit` decide se
// il messaggio entra, `matchRoutes` (invariata sopra, usata anche da `admit`
// per il fallback `project_rule`) decide dove.
// ---------------------------------------------------------------------------

/**
 * Configurazione d'istanza per {@link admit}, letta una volta per tick del
 * poller accanto alle regole di progetto (vedi `apps/worker/src/google/poller.ts`).
 */
export interface AdmissionConfig {
  /** `instance_settings.email_admit_workspace_domains`. */
  admitWorkspaceDomains: boolean;
  /**
   * TUTTI i domini di TUTTI i Workspace registrati — non solo quello della
   * casella che ha ricevuto il messaggio: un'email ammette per QUALUNQUE
   * Workspace dell'istanza, non solo per il proprio (`google_workspaces.domains`
   * di ogni riga, unite).
   */
  workspaceDomains: string[];
  /** `instance_settings.email_admission_deny_labels`. */
  denyLabels: string[];
  /** `instance_settings.email_admission_deny_automated`. */
  denyAutomated: boolean;
  /**
   * Le stesse regole di TUTTI i progetti che userebbe {@link matchRoutes}:
   * `admit` le usa internamente come fallback `project_rule` (i domini dei
   * clienti esterni, che non sono un Workspace registrato, continuano ad
   * ammettere esattamente come oggi).
   */
  routes: EmailRoute[];
}

/** L'esito dell'ammissione di un messaggio: entra nel sistema, o no e perché. */
export type AdmissionResult =
  | { admitted: true; reason: "workspace_domain" | "project_rule" }
  | { admitted: false; reason: "denied_label" | "automated" | "no_match" };

/** Il valore di un header, cercato senza distinzione di maiuscole/minuscole. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  return headers[name.toLowerCase()];
}

/**
 * Un messaggio ha l'aria di posta automatica? Vedi il docblock di
 * {@link AdmissionConfig.denyAutomated} per l'elenco degli header e i valori
 * che scattano. Nessun header presente (`headers` assente o vuoto) → `false`:
 * un chiamante che non passa ancora `headers` non deve vedersi rifiutare
 * nulla per questo motivo.
 */
function looksAutomated(headers: Record<string, string> | undefined): boolean {
  if (headerValue(headers, "List-Unsubscribe") !== undefined) return true;
  if (headerValue(headers, "List-Id") !== undefined) return true;
  const precedence = headerValue(headers, "Precedence")?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const autoSubmitted = headerValue(headers, "Auto-Submitted")?.trim().toLowerCase();
  if (autoSubmitted !== undefined && autoSubmitted !== "no") return true;
  return false;
}

/**
 * Un'email entra nel sistema, o no? A differenza di {@link matchRoutes} (di
 * quale progetto parla), questa è la domanda "è lavoro?", decisa a livello di
 * istanza. In ordine:
 *
 * 1. **Una regola di progetto che combacia ammette SUBITO, esclusioni
 *    comprese** (riusa la stessa logica di match di {@link matchRoutes},
 *    chiamata qui internamente UNA volta sola — nessuna duplicazione delle
 *    regole `sender_domain`/`sender_address`/`gmail_label`/`keyword`, e il
 *    risultato è quello che rende ammessi i domini dei clienti esterni, che
 *    non sono un Workspace registrato, esattamente come prima della fase
 *    6c). **Decisione del maintainer (8 set 2026), esplicita**: una regola
 *    di progetto è una scelta DELIBERATA dell'admin su un mittente preciso —
 *    non un'ammissione LARGA come quella per dominio di lavoro al passo 3 —
 *    e deve ammettere SEMPRE. Le esclusioni (`denyLabels`, `denyAutomated`)
 *    esistono per CONTENERE l'ammissione larga per dominio di lavoro, non
 *    per limitare quella MIRATA: un'email che una regola di progetto ammette
 *    e che porta `List-Unsubscribe` (comune in notifiche di CRM, ticketing o
 *    piattaforme aziendali legittime) o l'etichetta `CATEGORY_PROMOTIONS`
 *    resta ammessa.
 * 2. Altrimenti, **le esclusioni vincono**: un'etichetta in `denyLabels`
 *    (confronto case-insensitive, stesso stile della regola `gmail_label` di
 *    {@link matchRoutes}) rifiuta SUBITO.
 * 3. Se `denyAutomated`: gli header della posta automatica (vedi
 *    {@link looksAutomated}) rifiutano.
 * 4. Se `admitWorkspaceDomains`: il dominio del **mittente**, O quello di
 *    QUALUNQUE destinatario (`toAddresses` **o** `ccAddresses`,
 *    indifferentemente — Task 2, 8 set 2026: l'esito non deve dipendere da
 *    come il mittente ha compilato i campi, un'email che coinvolge due
 *    identità aziendali diverse è lavoro sia che la seconda sia in copia
 *    sia che sia fra i destinatari diretti) DIVERSO dal dominio di
 *    `receivingDomain` (la casella che sta ricevendo), in `workspaceDomains`
 *    ammette. Il confronto è sul DOMINIO, non sull'indirizzo: la casella
 *    ricevente è nota (`account.email` nel poller) e si esclude a priori —
 *    altrimenti OGNI email diretta a quella casella ammetterebbe per il solo
 *    fatto che la casella stessa compare fra i suoi destinatari (è sempre
 *    così: è lei che la riceve), il motivo preciso per cui `toAddresses` non
 *    c'era affatto prima di questo task. La fix corretta non è "includere
 *    `toAddresses` sempre", è "includere `to`+`cc` ESCLUDENDO il dominio
 *    della casella ricevente": ciò che resta, se non vuoto, è un SECONDO
 *    dominio di lavoro coinvolto nella conversazione — e la posta ordinaria
 *    diretta a una sola casella non entra da questo criterio (per quella
 *    restano le regole di progetto del passo 1).
 * 5. Altrimenti, rifiutato `no_match`.
 *
 * Con `admitWorkspaceDomains: false` il passo 4 si salta interamente. Per un
 * messaggio SENZA etichette escluse né header automatici l'esito coincide
 * ancora con `matchRoutes(message, routes).inScope` di prima della fase 6c
 * (vedi il test "interruttore spento") — ma un messaggio CON un'etichetta
 * esclusa o un header automatico differisce ora da `inScope` per
 * costruzione quando nessuna regola di progetto combacia: `inScope` di
 * `matchRoutes` non conosce le esclusioni, `admit` sì.
 *
 * @param receivingDomain il dominio (non l'indirizzo) della casella che ha
 *   ricevuto il messaggio — `domainOf(account.email)` nel poller. È un
 *   PARAMETRO A SÉ e non un campo di {@link AdmissionConfig} perché
 *   `AdmissionConfig` è caricata UNA volta per tick (`loadAdmissionConfig`)
 *   e riusata per OGNI casella di quel tick, mentre questo valore cambia per
 *   casella: infilarlo in `AdmissionConfig` avrebbe richiesto ricostruire
 *   l'oggetto a ogni casella per un campo che, concettualmente, non è
 *   configurazione d'istanza. Ogni chiamata reale (dal poller) ce l'ha
 *   sempre disponibile da `account.email`: non è opzionale.
 */
export function admit(
  message: EmailForRouting,
  config: AdmissionConfig,
  receivingDomain: string,
): AdmissionResult {
  // Passo 1 — vedi il docblock sopra per il PERCHÉ: `matchRoutes` è calcolata
  // una volta sola qui, e se combacia si ammette SENZA guardare le
  // esclusioni. Una regola di progetto non passa mai dai passi 2-4.
  if (matchRoutes(message, config.routes).inScope) {
    return { admitted: true, reason: "project_rule" };
  }

  const labels = new Set(
    message.labels.map((label) => label.trim().toLowerCase()).filter((label) => label !== ""),
  );
  const denyLabels = config.denyLabels
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label !== "");
  if (denyLabels.some((label) => labels.has(label))) {
    return { admitted: false, reason: "denied_label" };
  }

  if (config.denyAutomated && looksAutomated(message.headers)) {
    return { admitted: false, reason: "automated" };
  }

  if (config.admitWorkspaceDomains) {
    const workspaceDomains = new Set(
      config.workspaceDomains.map((domain) => domain.trim().toLowerCase()).filter((domain) => domain !== ""),
    );
    const normalizedReceivingDomain = receivingDomain.trim().toLowerCase();
    const senderDomain = domainOf(normalizeAddress(message.fromAddress));
    // to + cc, ESCLUSO il dominio della casella ricevente — vedi il docblock
    // sopra per il perché dell'esclusione (senza, ogni email diretta alla
    // casella ammetterebbe da sola, visto che la casella è sempre fra i suoi
    // stessi destinatari).
    const recipientDomains = [...message.toAddresses, ...(message.ccAddresses ?? [])]
      .map((address) => domainOf(normalizeAddress(address)))
      .filter((domain) => domain !== "" && domain !== normalizedReceivingDomain);
    const fromWorkspace =
      (senderDomain !== "" && workspaceDomains.has(senderDomain)) ||
      recipientDomains.some((domain) => workspaceDomains.has(domain));
    if (fromWorkspace) {
      return { admitted: true, reason: "workspace_domain" };
    }
  }

  return { admitted: false, reason: "no_match" };
}
