import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backlogItems,
  emailMessages,
  projects,
  tickets,
  type Db,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import {
  ticketPrioritySchema,
  ticketStatusSchema,
  type TicketPriority,
  type TicketStatus,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import { capText, parseAgentJson, textFromRun } from "../agent/text.js";
import { loadProviderChain, type ResolvedProvider } from "../providers/chain.js";
import { recordAgentRun } from "../queue.js";
import { getContentLanguage } from "../settings.js";

/**
 * FASE 2 del tick delle caselle Google (fase 6, Task 8): da un messaggio
 * ingerito ai **segnali** e alle **proposte** che la fase D pubblicherà.
 *
 * ## Il run: testo non fidato, e si vede
 *
 * Il corpo di un'email lo scrive chi vuole, compreso chi vuole male. La
 * dottrina è quella dell'intake del backlog
 * (`apps/worker/src/backlog/prompts.ts`), qui applicata alla lettera:
 * `permissionMode: "default"` (MAI `"plan"`, che è la modalità di esplorazione
 * read-only e invita l'agente a leggere il filesystem del container), una
 * directory temporanea VUOTA come cwd, nessun tool, pochi turni, uno schema di
 * output con cap su ogni stringa. Il testo non fidato viaggia dentro
 * delimitatori espliciti ({@link EMAIL_DELIMITER_START}) e le istruzioni
 * dicono, PRIMA del blocco, che lì dentro ci sono dati e non comandi.
 *
 * ## Ma la difesa vera non è il prompt: è la RIVALIDAZIONE
 *
 * Un prompt lo si convince; una `where` no. Ogni referente che l'agente
 * nomina — il progetto, il numero di ticket, la data di scadenza — viene
 * riconfrontato QUI con ciò che il codice sa: il progetto deve essere quello
 * risolto dal routing (o uno dei candidati), il ticket deve essere uno dei
 * ticket APERTI di quel progetto che gli abbiamo passato, la data deve essere
 * nel futuro. Un'azione che perde un referente obbligatorio sparisce
 * dall'elenco; se non ne resta nessuna, il messaggio finisce `ignored` senza
 * proposta. È così che un'email ostile non riesce a far comparire una proposta
 * su un progetto che non la riguarda.
 *
 * ## Un messaggio malformato non è un guasto della casella
 *
 * {@link classifyEmail} NON LANCIA MAI: JSON illeggibile, exit non-zero,
 * runner che esplode, output fuori schema → `status: 'failed'` con un errore
 * TECNICO su quella riga (mai il testo dell'email: finirebbe in un log o in
 * una pagina), e nessun ritentativo automatico. La riga resta `failed` finché
 * un umano non la ripropone dalla pagina Posta. Se invece l'eccezione salisse
 * fino a `runAccountTick`, il gestore d'errore del poller la leggerebbe come un
 * verdetto sulla CASELLA e, dopo abbastanza tentativi, la spegnerebbe: una
 * mail rotta metterebbe fuori uso la posta di una persona.
 *
 * ## Il costo è visibile
 *
 * Ogni run scrive `agent_runs` con owner `email_message_id` e phase
 * `email_classify` (il terzo owner ammesso dal check `num_nonnulls = 1`),
 * BEST-EFFORT come gli altri: la posta entra nel conto del mese col metro dei
 * fix invece di essere una spesa che non compare da nessuna parte.
 */

/** Delimitatore d'apertura del blocco NON FIDATO (mittente, oggetto, testo). */
export const EMAIL_DELIMITER_START = "<<<EMAIL>>>";

/** Delimitatore di chiusura del blocco non fidato. */
export const EMAIL_DELIMITER_END = "<<<END_EMAIL>>>";

/** Turni del run: è un one-shot testo→JSON, tre bastano e avanzano. */
export const CLASSIFY_MAX_TURNS = 3;

/** Timeout del run di classificazione. */
export const CLASSIFY_TIMEOUT_MS = 90_000;

/** Messaggi classificati per tick quando `maxPerTick` non è passato. */
export const DEFAULT_CLASSIFY_MAX_PER_TICK = 20;

/** Caratteri del corpo email che entrano nel prompt (il resto è troncato). */
export const CLASSIFY_TEXT_MAX_CHARS = 8_000;

/** Titoli di backlog e ticket aperti passati come contesto (design: 20). */
export const CLASSIFY_CONTEXT_ROWS = 20;

/** Proposte tenute dopo la rivalidazione (design: 1..3). */
export const CLASSIFY_MAX_PROPOSALS = 3;

/** I tipi di azione che una proposta può avere. `choose_project` e `ignore`
 * NON sono qui: non li propone il modello, li aggiunge la fase D in modo
 * deterministico (Task 10). */
export const EMAIL_PROPOSAL_TYPES = [
  "create_backlog_item",
  "create_milestone",
  "update_ticket",
  "comment_ticket",
  "record_decision",
] as const;

export type EmailProposalType = (typeof EMAIL_PROPOSAL_TYPES)[number];

/** I segnali che la classificazione può assegnare a un messaggio. */
export const EMAIL_SIGNALS = ["decision", "request", "deadline", "blocker", "none"] as const;

export type EmailSignal = (typeof EMAIL_SIGNALS)[number];

/**
 * UNA proposta come l'agente la produce. I cap sono gli stessi degli altri
 * output dell'agente (title 300 come `createBacklogItemSchema`, decision 2000
 * come `riskNote`): respingono un output degenere o iniettato prima che
 * finisca in DB.
 *
 * `consequence` è obbligatoria su TUTTE: è la frase che la card mostra sotto
 * l'opzione, e un'opzione senza "cosa succede se la scegli" non è
 * confermabile con un tap consapevole.
 */
const emailProposalSchema = z.object({
  type: z.enum(EMAIL_PROPOSAL_TYPES),
  projectId: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(5_000).optional(),
  name: z.string().min(1).max(300).optional(),
  dueDate: z.string().min(1).max(40).optional(),
  ticketNumber: z.number().int().positive().max(1_000_000).optional(),
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  decision: z.string().min(1).max(2_000).optional(),
  consequence: z.string().min(1).max(300),
});

/**
 * L'output del run.
 *
 * ⚠️ `proposals` è `unknown[]` DI PROPOSITO, e non un array di
 * {@link emailProposalSchema}: una singola proposta malformata (tipo
 * inventato, titolo di 10 KB) deve poter essere buttata da sola, non far
 * fallire l'intero messaggio. La validazione per-elemento avviene nella
 * rivalidazione, insieme a quella dei referenti — un solo posto in cui una
 * proposta viene scartata, invece di due che possono divergere.
 *
 * `proposals` può essere VUOTO: è il caso `signal: "none"`, dove chiedere al
 * modello almeno una proposta significherebbe chiedergli di inventarne una.
 */
export const emailSignalsSchema = z.object({
  signal: z.enum(EMAIL_SIGNALS),
  summary: z.string().max(400).default(""),
  proposals: z.array(z.unknown()).max(20).default([]),
  recommendedIndex: z.number().int().min(0).catch(0).default(0),
});

export type EmailSignalsOutput = z.infer<typeof emailSignalsSchema>;

/** Una proposta SOPRAVVISSUTA alla rivalidazione: i referenti qui sono veri. */
export interface RevalidatedProposal {
  type: EmailProposalType;
  /** Cosa succede se si sceglie questa opzione (una frase). */
  consequence: string;
  projectId?: string;
  title?: string;
  body?: string;
  name?: string;
  /** Scadenza normalizzata in ISO, garantita FUTURA rispetto a `now`. */
  dueDate?: string;
  ticketNumber?: number;
  /**
   * Id del ticket risolto dal numero, così la fase D non deve rifare la query
   * (e non può risolverlo diversamente da come l'abbiamo validato qui).
   */
  ticketId?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  decision?: string;
}

/** Ciò che finisce in `email_messages.classification`. */
export interface EmailClassification {
  signal: EmailSignal;
  summary: string;
  proposals: RevalidatedProposal[];
  /** Indice (già rimappato sulle proposte sopravvissute) dell'opzione consigliata. */
  recommendedIndex: number;
}

/** L'input del prompt: tutto ciò che l'agente vede, fidato e non. */
export interface EmailSignalsInput {
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  text: string;
  /** Progetti fra cui l'agente può scegliere: il risolto, o i candidati. */
  projects: { id: string; name: string; description: string | null }[];
  /** Titoli delle voci di backlog aperte del progetto risolto. */
  backlogTitles: string[];
  /** Ticket APERTI del progetto risolto. */
  openTickets: { number: number; title: string; status: string }[];
  /** Numeri `#N` citati nel messaggio. */
  citedTicketNumbers: number[];
  /** Il testo è stato troncato per lunghezza. */
  truncated: boolean;
}

/** Log minimale, strutturalmente compatibile col `GoogleLogger` del poller. */
export interface ClassifyLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ClassifyEmailDeps {
  db: Db;
  runner: AgentRunner;
  /** Lingua dei contenuti dell'istanza: sta nel TESTO delle istruzioni. */
  lang: Language;
  /** Modello del run (`GMAIL_MODEL`); omesso = default del CLI. */
  model?: string;
  /** Provider AI risolto (chain[0]); omesso = auth di default del container. */
  provider?: ResolvedProvider;
  logger?: ClassifyLogger;
  /** "Adesso" iniettabile: decide quali `dueDate` sono future. */
  now?: () => Date;
}

/** Esito della classificazione di UN messaggio. */
export type ClassifyOutcome = "classified" | "ignored" | "failed";

export interface ClassifyBatchDeps extends Omit<ClassifyEmailDeps, "lang"> {
  /** Lingua dei contenuti; assente = letta una volta dalle impostazioni. */
  lang?: Language;
  /** Chiave AES-256: serve a decifrare i segreti della catena di provider. */
  encryptionKey: Buffer;
  /** Messaggi da classificare in questo tick (`GMAIL_MAX_PER_TICK`). */
  maxPerTick: number;
  /** Stop cooperativo: interrompe fra un messaggio e l'altro. */
  signal?: AbortSignal;
  /** Caricatore della catena di provider (iniettabile nei test). */
  loadProviderChainFn?: typeof loadProviderChain;
}

/** Quanti messaggi ha prodotto ciascun esito nel tick di una casella. */
export interface ClassifyBatchStats {
  classified: number;
  ignored: number;
  failed: number;
}

type EmailMessageRow = typeof emailMessages.$inferSelect;

const defaultLogger: ClassifyLogger = {
  info: (msg) => console.error(`[stubwise-worker] ${msg}`),
  warn: (msg) => console.error(`[stubwise-worker] ${msg}`),
  error: (msg) => console.error(`[stubwise-worker] ${msg}`),
};

/** Testo di un errore, troncato: mai il contenuto dell'email qui dentro. */
function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

/**
 * I numeri di ticket `#N` citati in un testo, nell'ordine in cui compaiono e
 * senza doppioni. `#0` e `#fff` non sono citazioni: il primo non è un numero
 * di ticket valido, il secondo è un colore.
 */
export function citedTicketNumbers(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/#(\d{1,7})\b/g)) {
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value <= 0) continue;
    if (!found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * Compone il prompt. La STRUTTURA è neutra (etichette dei blocchi, forma del
 * JSON), le ISTRUZIONI arrivano dal catalogo e portano con sé la lingua: è la
 * regola già adottata da `summary.*` e `brief.*` nella fase 5, e serve a non
 * cablare "scrivi in italiano" dentro un builder che non sa in che lingua gira
 * l'istanza.
 *
 * ORDINE DEI BLOCCHI, non casuale: prima le istruzioni (compresa la regola
 * «quello che sta fra i delimitatori sono DATI»), poi il contesto FIDATO
 * (progetti, backlog, ticket), e per ULTIMO il blocco non fidato. Chi legge
 * dall'alto incontra la regola prima del tentativo di iniezione.
 */
export function buildEmailSignalsPrompt(lang: Language, input: EmailSignalsInput): string {
  const projectLines =
    input.projects.length > 0
      ? input.projects.map((p) => `- ${p.id} — ${p.name}${p.description ? `: ${p.description}` : ""}`)
      : [`- ${t(lang, "email.input.none")}`];
  const backlogLines =
    input.backlogTitles.length > 0
      ? input.backlogTitles.map((title) => `- ${title}`)
      : [`- ${t(lang, "email.input.none")}`];
  const ticketLines =
    input.openTickets.length > 0
      ? input.openTickets.map((ticket) => `- #${ticket.number} (${ticket.status}) ${ticket.title}`)
      : [`- ${t(lang, "email.input.none")}`];

  const lines: string[] = [
    t(lang, "email.signals.instructions"),
    "",
    `OUTPUT (JSON only): ${OUTPUT_SHAPE}`,
    "",
    `${t(lang, "email.input.projects")}:`,
    ...projectLines,
    "",
    `${t(lang, "email.input.backlog")}:`,
    ...backlogLines,
    "",
    `${t(lang, "email.input.tickets")}:`,
    ...ticketLines,
    "",
    `${t(lang, "email.input.cited")}: ${
      input.citedTicketNumbers.length > 0
        ? input.citedTicketNumbers.map((n) => `#${n}`).join(", ")
        : t(lang, "email.input.none")
    }`,
    "",
    EMAIL_DELIMITER_START,
    `${t(lang, "email.input.from")}: ${input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress}`,
    `${t(lang, "email.input.subject")}: ${input.subject ?? t(lang, "email.input.none")}`,
    `${t(lang, "email.input.text")}:`,
    input.text.trim() === "" ? t(lang, "email.input.none") : input.text,
    EMAIL_DELIMITER_END,
  ];
  if (input.truncated) lines.push("", t(lang, "email.input.truncated"));
  return lines.join("\n");
}

/**
 * La forma del JSON richiesto. Sta nel builder e non nel catalogo perché è un
 * PROTOCOLLO fra worker e agente, non testo da leggere: tradurne le chiavi
 * romperebbe il parse (stessa ragione dei marcatori `<<WHERE>>` del brief).
 */
const OUTPUT_SHAPE =
  '{"signal":"decision|request|deadline|blocker|none","summary":"<=400 chars",' +
  '"proposals":[{"type":"create_backlog_item|create_milestone|update_ticket|comment_ticket|record_decision",' +
  '"projectId":"<id from the list>","title":"…","body":"…","name":"…","dueDate":"YYYY-MM-DD",' +
  '"ticketNumber":123,"status":"open|triaged|in_progress|in_review|done|closed",' +
  '"priority":"low|medium|high|urgent","decision":"…","consequence":"…"}],"recommendedIndex":0}';

/** Il contesto con cui i referenti dell'agente vengono riconfrontati. */
export interface ClassifyContext {
  /** Progetti su cui una proposta può insistere: il risolto, o i candidati. */
  allowedProjectIds: Set<string>;
  /**
   * Il progetto RISOLTO dal routing, o `null` se il messaggio è ambiguo
   * (parità di regole). Serve a completare un'azione a cui il modello ha
   * scordato il `projectId`: quando il progetto è uno solo il referente non è
   * un'informazione che il modello debba indovinare, lo sappiamo già noi.
   */
  resolvedProjectId: string | null;
  projects: { id: string; name: string; description: string | null }[];
  /** Ticket APERTI del progetto risolto, per numero. Vuoto se non risolto. */
  openTickets: Map<number, { id: string; title: string; status: string }>;
  backlogTitles: string[];
  citedTicketNumbers: number[];
}

/**
 * Carica il contesto di UN messaggio.
 *
 * I ticket aperti sono quelli del PROGETTO RISOLTO e basta: con un progetto
 * ambiguo (parità di regole) non esiste una lista sensata di ticket da citare,
 * e infatti ogni azione che ne cita uno verrà scartata dalla rivalidazione.
 *
 * Ai 20 più recenti si aggiungono i ticket CITATI nel messaggio (`#N`): senza
 * di loro, rispondere a un'email che parla del ticket #3 di sei mesi fa
 * produrrebbe sempre e solo proposte scartate.
 */
async function loadContext(
  db: Db,
  message: EmailMessageRow,
): Promise<ClassifyContext> {
  const allowed = message.projectId ? [message.projectId] : message.candidateProjectIds;
  const allowedProjectIds = new Set(allowed);
  const cited = citedTicketNumbers(`${message.subject ?? ""}\n${message.textExcerpt ?? ""}`);

  if (allowed.length === 0) {
    return {
      allowedProjectIds,
      resolvedProjectId: message.projectId,
      projects: [],
      openTickets: new Map(),
      backlogTitles: [],
      citedTicketNumbers: cited,
    };
  }

  const projectRows = await db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(inArray(projects.id, allowed));

  if (!message.projectId) {
    return {
      allowedProjectIds,
      resolvedProjectId: null,
      projects: projectRows,
      openTickets: new Map(),
      backlogTitles: [],
      citedTicketNumbers: cited,
    };
  }

  const backlogRows = await db
    .select({ title: backlogItems.title })
    .from(backlogItems)
    .where(
      and(
        eq(backlogItems.projectId, message.projectId),
        notInArray(backlogItems.status, ["converted", "archived"]),
      ),
    )
    .orderBy(desc(backlogItems.updatedAt))
    .limit(CLASSIFY_CONTEXT_ROWS);

  const openWhere = and(
    eq(tickets.projectId, message.projectId),
    notInArray(tickets.status, ["done", "closed"]),
  );
  const recentTickets = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      title: tickets.title,
      status: tickets.status,
    })
    .from(tickets)
    .where(openWhere)
    .orderBy(desc(tickets.number))
    .limit(CLASSIFY_CONTEXT_ROWS);
  const citedTickets =
    cited.length > 0
      ? await db
          .select({
            id: tickets.id,
            number: tickets.number,
            title: tickets.title,
            status: tickets.status,
          })
          .from(tickets)
          .where(and(openWhere, inArray(tickets.number, cited)))
      : [];

  const openTickets = new Map<number, { id: string; title: string; status: string }>();
  for (const row of [...recentTickets, ...citedTickets]) {
    openTickets.set(row.number, { id: row.id, title: row.title, status: row.status });
  }

  return {
    allowedProjectIds,
    resolvedProjectId: message.projectId,
    projects: projectRows,
    openTickets,
    backlogTitles: backlogRows.map((row) => row.title),
    citedTicketNumbers: cited,
  };
}

/**
 * Una data ISO nel FUTURO, normalizzata, o `null`.
 *
 * "Futura" si misura su `now` iniettabile: una scadenza già passata non è una
 * milestone da creare, è un residuo di un thread vecchio — e proporla
 * significherebbe far confermare con un tap una data sbagliata.
 */
export function futureIsoDate(raw: string, now: Date): string | null {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? `${raw.trim()}T00:00:00.000Z` : raw);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() <= now.getTime()) return null;
  return parsed.toISOString();
}

/**
 * Rivalida UNA proposta: forma (schema con cap) + referenti (progetto, ticket,
 * data). `null` = da scartare.
 *
 * REGOLA UNICA, e vale anche per i referenti OPZIONALI: un referente PRESENTE
 * deve essere valido, altrimenti l'azione se ne va. Tenere un'azione "quasi
 * buona" ripulita del pezzo sbagliato significherebbe far confermare con un
 * tap qualcosa di diverso da ciò che la card ha mostrato.
 */
export function revalidateProposal(
  raw: unknown,
  ctx: ClassifyContext,
  now: Date,
): RevalidatedProposal | null {
  const parsed = emailProposalSchema.safeParse(raw);
  if (!parsed.success) return null;
  const input = parsed.data;

  // Progetto: se c'è, deve essere uno di quelli che gli abbiamo passato. Se
  // NON c'è e il routing ne ha risolto uno solo, lo mettiamo noi: è un dato
  // che sappiamo, non una lacuna da punire scartando l'azione. Con un
  // messaggio ambiguo, invece, l'omissione resta tale — indovinare fra due
  // progetti è esattamente ciò che il routing si rifiuta di fare.
  const projectId = input.projectId ?? ctx.resolvedProjectId ?? undefined;
  if (projectId !== undefined && !ctx.allowedProjectIds.has(projectId)) return null;

  // Ticket: se c'è, deve essere un ticket APERTO del progetto risolto.
  let ticketId: string | undefined;
  if (input.ticketNumber !== undefined) {
    const ticket = ctx.openTickets.get(input.ticketNumber);
    if (!ticket) return null;
    ticketId = ticket.id;
  }

  // Data: se c'è, deve essere ISO e futura.
  let dueDate: string | undefined;
  if (input.dueDate !== undefined) {
    const normalized = futureIsoDate(input.dueDate, now);
    if (!normalized) return null;
    dueDate = normalized;
  }

  const proposal: RevalidatedProposal = { type: input.type, consequence: input.consequence };
  if (projectId !== undefined) proposal.projectId = projectId;
  if (input.title !== undefined) proposal.title = input.title;
  if (input.body !== undefined) proposal.body = input.body;
  if (input.name !== undefined) proposal.name = input.name;
  if (dueDate !== undefined) proposal.dueDate = dueDate;
  if (input.ticketNumber !== undefined) proposal.ticketNumber = input.ticketNumber;
  if (ticketId !== undefined) proposal.ticketId = ticketId;
  if (input.status !== undefined) proposal.status = input.status;
  if (input.priority !== undefined) proposal.priority = input.priority;
  if (input.decision !== undefined) proposal.decision = input.decision;

  // Campi OBBLIGATORI per tipo: un'azione a cui manca ciò che serve per
  // eseguirla non è confermabile, quindi non deve nemmeno comparire.
  switch (input.type) {
    case "create_backlog_item":
      return proposal.projectId && proposal.title ? proposal : null;
    case "create_milestone":
      return proposal.projectId && proposal.name ? proposal : null;
    case "update_ticket":
      return proposal.ticketId && (proposal.status || proposal.priority) ? proposal : null;
    case "comment_ticket":
      return proposal.ticketId && proposal.body ? proposal : null;
    case "record_decision":
      return proposal.projectId && proposal.title && proposal.decision ? proposal : null;
  }
}

/**
 * Rivalida l'intero output: tiene le prime {@link CLASSIFY_MAX_PROPOSALS}
 * proposte sopravvissute e rimappa `recommendedIndex` su di esse (se la
 * consigliata è stata scartata, si consiglia la prima rimasta: un indice che
 * punta al vuoto farebbe evidenziare l'opzione sbagliata).
 */
export function revalidateClassification(
  output: EmailSignalsOutput,
  ctx: ClassifyContext,
  now: Date,
): EmailClassification {
  const kept: RevalidatedProposal[] = [];
  let recommendedIndex = 0;
  for (const [index, raw] of output.proposals.entries()) {
    if (kept.length >= CLASSIFY_MAX_PROPOSALS) break;
    const proposal = revalidateProposal(raw, ctx, now);
    if (!proposal) continue;
    if (index === output.recommendedIndex) recommendedIndex = kept.length;
    kept.push(proposal);
  }
  return {
    signal: output.signal,
    summary: output.summary,
    proposals: output.signal === "none" ? [] : kept,
    recommendedIndex: kept.length > 0 ? recommendedIndex : 0,
  };
}

/** Chiude un messaggio con `failed` e un errore TECNICO (mai il testo email). */
async function markFailed(db: Db, messageId: string, reason: string): Promise<void> {
  await db
    .update(emailMessages)
    .set({ status: "failed", error: reason })
    .where(eq(emailMessages.id, messageId));
}

/**
 * Classifica UN messaggio e ne scrive l'esito. Non lancia mai (vedi il
 * docblock del modulo): ogni strada finisce in uno stato scritto sulla riga.
 */
export async function classifyEmail(
  deps: ClassifyEmailDeps,
  message: EmailMessageRow,
): Promise<ClassifyOutcome> {
  const logger = deps.logger ?? defaultLogger;
  const now = (deps.now ?? (() => new Date()))();

  try {
    const ctx = await loadContext(deps.db, message);
    if (ctx.allowedProjectIds.size === 0) {
      // Nessun progetto a cui agganciare un'azione: non c'è niente da
      // proporre, e lasciarlo `new` lo farebbe ripescare a ogni tick per
      // sempre, occupando uno slot del tetto per-tick.
      await deps.db
        .update(emailMessages)
        .set({ status: "ignored" })
        .where(eq(emailMessages.id, message.id));
      return "ignored";
    }

    const raw = message.textExcerpt ?? "";
    const truncated = raw.length > CLASSIFY_TEXT_MAX_CHARS;
    const text = capText(raw, CLASSIFY_TEXT_MAX_CHARS, t(deps.lang, "email.input.truncated"));
    const prompt = buildEmailSignalsPrompt(deps.lang, {
      fromAddress: message.fromAddress,
      fromName: message.fromName,
      subject: message.subject,
      text,
      projects: ctx.projects,
      backlogTitles: ctx.backlogTitles,
      openTickets: [...ctx.openTickets.entries()].map(([number, ticket]) => ({
        number,
        title: ticket.title,
        status: ticket.status,
      })),
      citedTicketNumbers: ctx.citedTicketNumbers,
      truncated,
    });

    // Il run: nessun tool, una cwd temporanea VUOTA (l'agente non deve avere
    // niente da leggere), `default` e non `plan`. Vedi il docblock del modulo.
    const cwd = await mkdtemp(join(tmpdir(), "stubwise-email-classify-"));
    let result;
    try {
      result = await deps.runner.run({
        cwd,
        prompt,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
        permissionMode: "default",
        maxTurns: CLASSIFY_MAX_TURNS,
        timeoutMs: CLASSIFY_TIMEOUT_MS,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    // Costo tracciato con l'owner `email_message_id` e phase `email_classify`
    // (best-effort: `recordAgentRun` inghiotte i propri errori). Si registra
    // PRIMA di guardare l'output: un run pagato va contato anche quando il suo
    // output è inservibile.
    await recordAgentRun(deps.db, {
      emailMessageId: message.id,
      phase: "email_classify",
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });

    const output = textFromRun(result);
    if (output === null) {
      await markFailed(
        deps.db,
        message.id,
        `classificazione: agente uscito con exit ${result.exitCode} o senza output`,
      );
      return "failed";
    }

    const parsed = parseAgentJson(emailSignalsSchema, output);
    if (parsed === null) {
      // Nessun ritentativo: il messaggio resta `failed` finché un umano non lo
      // ripropone. Ritentare in automatico su un output che non rispetta lo
      // schema è il modo di pagare lo stesso run all'infinito.
      await markFailed(deps.db, message.id, "classificazione: output non parsabile o fuori schema");
      return "failed";
    }

    const classification = revalidateClassification(parsed, ctx, now);
    const status: ClassifyOutcome =
      classification.proposals.length > 0 ? "classified" : "ignored";
    await deps.db
      .update(emailMessages)
      .set({
        status,
        signal: classification.signal,
        classification: classification as unknown as Record<string, unknown>,
        error: null,
      })
      .where(eq(emailMessages.id, message.id));
    return status;
  } catch (err) {
    // Timeout, spawn fallito, limite del provider, errore di scrittura: è un
    // problema di QUESTO messaggio, non della casella.
    const reason = `classificazione: ${errText(err)}`;
    try {
      await markFailed(deps.db, message.id, reason);
    } catch (inner) {
      logger.error(
        `google: esito della classificazione non registrato per il messaggio ${message.id}: ${errText(inner)}`,
      );
    }
    return "failed";
  }
}

/**
 * FASE 2 del tick di UNA casella: i messaggi `new`, dai più vecchi, fino al
 * tetto per tick.
 *
 * SEQUENZIALE come il resto del poller: i run costano, e mandarne venti in
 * parallelo è il modo più rapido di prendere un limite del provider per tutti
 * insieme.
 *
 * La lingua e il provider si risolvono UNA volta per casella, non per
 * messaggio: sono due query che non cambierebbero risposta venti volte di
 * fila. Non lancia mai — `classifyEmail` chiude ogni strada su una riga.
 */
export async function classifyNewMessages(
  deps: ClassifyBatchDeps,
  accountId: string,
): Promise<ClassifyBatchStats> {
  const stats: ClassifyBatchStats = { classified: 0, ignored: 0, failed: 0 };
  if (deps.maxPerTick <= 0) return stats;

  const pending = await deps.db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.accountId, accountId), eq(emailMessages.status, "new")))
    .orderBy(asc(emailMessages.receivedAt), asc(emailMessages.id))
    .limit(Math.trunc(deps.maxPerTick));
  if (pending.length === 0) return stats;

  const lang = deps.lang ?? (await getContentLanguage(deps.db));
  let provider = deps.provider;
  if (provider === undefined) {
    const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
    provider = (await loadChain(deps.db, deps.encryptionKey))[0];
  }

  for (const message of pending) {
    if (deps.signal?.aborted) break;
    const outcome = await classifyEmail(
      {
        db: deps.db,
        runner: deps.runner,
        lang,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      },
      message,
    );
    stats[outcome] += 1;
  }
  return stats;
}
