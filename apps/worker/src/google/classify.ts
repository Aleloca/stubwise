import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentRuns,
  backlogItems,
  emailMessages,
  emailProposals,
  googleAccounts,
  instanceSettings,
  monthlyCostUsd,
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
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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

/**
 * Fase 6c — Task 6: tetto giornaliero di classificazioni PER CASELLA
 * (`GMAIL_MAX_PER_DAY`), usato quando {@link ClassifyBatchDeps.maxPerDay} non
 * è passato. `0` = nessun tetto.
 */
export const DEFAULT_GMAIL_MAX_PER_DAY = 200;

/**
 * Fase 6c — Task 6: cooldown in minuti fra due classificazioni dello STESSO
 * thread (`GMAIL_THREAD_COOLDOWN_MINUTES`), usato quando
 * {@link ClassifyBatchDeps.threadCooldownMinutes} non è passato. `0` =
 * disattivato.
 */
export const DEFAULT_GMAIL_THREAD_COOLDOWN_MINUTES = 60;

/** Caratteri del corpo email che entrano nel prompt (il resto è troncato). */
export const CLASSIFY_TEXT_MAX_CHARS = 8_000;

/**
 * Titoli di backlog e ticket aperti passati come contesto, PER PROGETTO
 * (design: 10, ridotto da 20 in fase 6b perché il contesto ora cresce in
 * modo lineare col numero di progetti del perimetro).
 */
export const CLASSIFY_CONTEXT_ROWS = 10;

/** Proposte tenute dopo la rivalidazione, PER PROGETTO (design: 1..3). */
export const CLASSIFY_MAX_PROPOSALS = 3;

/**
 * Fase 6b: tetto sul FAN-OUT di un messaggio. Senza questo limite, una mail
 * in copia a dieci progetti genererebbe dieci card. Applicato DOPO la
 * partizione per progetto: se i progetti con almeno una proposta valida sono
 * più di questo numero, sopravvivono quelli con PIÙ proposte (a parità,
 * decide l'ordine del perimetro — `scopeProjectIds`/`allowed` — per
 * determinismo). Valore di default; `GMAIL_MAX_PROJECTS_PER_MESSAGE` in
 * `apps/worker/src/config.ts` porta lo stesso default e sarà il punto da cui
 * il poller lo passerà (Task 5).
 */
export const GMAIL_MAX_PROJECTS_PER_MESSAGE = 5;

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

/**
 * Fase 6c — Task 5: ciò che finisce in `email_messages.classification` per un
 * messaggio «da smistare» — un SEGNALE reale (`signal !== 'none'`) ma NESSUNA
 * proposta sopravvissuta alla rivalidazione per NESSUN progetto, e quindi
 * NESSUN figlio creato (vedi {@link writeClassification}).
 *
 * FORMA DIVERSA da {@link EmailClassification} DI PROPOSITO — non è
 * un'estensione, è un'unione discriminata sullo stesso campo jsonb: il
 * marcatore `triage: true` è ciò che distingue questo padre (nessun figlio,
 * in attesa di una proposta di SMISTAMENTO — Task 5, `proposal.ts`) da un
 * padre `classified` CON figli (dove `classification` resta nella forma
 * "normale", con `proposals[]`). Nessuno stato nuovo, nessuna tabella nuova:
 * solo una forma diversa dello stesso campo. Chi rilegge questo jsonb
 * (`apps/worker/src/google/poller.ts`, `apps/worker/src/google/proposal.ts`)
 * lo fa in modo TOLLERANTE (zod `.catch`/`.safeParse`), come ogni altra
 * lettura di un jsonb scritto da una fase precedente.
 */
export interface EmailTriageClassification {
  /** Il marcatore. SEMPRE `true` qui — mai scritto `false`, l'assenza del campo è il "no". */
  triage: true;
  signal: EmailSignal;
  summary: string;
  /**
   * I progetti che le proposte SCARTATE nominavano (fino a
   * {@link TRIAGE_MAX_SUGGESTED_PROJECTS}), non un elenco arbitrario — vedi
   * {@link extractSuggestedProjectIds}. Può essere VUOTO: il modello ha visto
   * un segnale ma non ha nominato nessun progetto specifico, e la proposta di
   * smistamento nascerà con la sola opzione «Nessuno di questi».
   */
  suggestedProjectIds: string[];
}

/**
 * Fase 6c: quanti progetti suggeriti porta al massimo una proposta di
 * smistamento — stesso tetto di {@link MAX_PROPOSAL_OPTIONS} in
 * `./proposal.ts` (non importato da lì per non introdurre una dipendenza
 * ciclica fra i due moduli: sono la stessa costante per ragioni diverse, e
 * tenerle allineate è responsabilità di chi le tocca).
 */
export const TRIAGE_MAX_SUGGESTED_PROJECTS = 3;

/**
 * L'input del prompt: tutto ciò che l'agente vede, fidato e non.
 *
 * Fase 6b: `projects` non è più una lista di soli id fra cui scegliere, ma
 * porta con sé il contesto (backlog, ticket aperti) DI CIASCUN progetto del
 * perimetro — il prompt lo stampa sotto intestazioni separate, una per
 * progetto.
 */
export interface EmailSignalsInput {
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  text: string;
  /** Progetti del PERIMETRO (`scopeProjectIds`), ciascuno col suo contesto. */
  projects: {
    id: string;
    name: string;
    description: string | null;
    /** Titoli delle voci di backlog aperte DI QUESTO progetto. */
    backlogTitles: string[];
    /** Ticket APERTI DI QUESTO progetto. */
    openTickets: { number: number; title: string; status: string }[];
  }[];
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
  /**
   * Tetto sul fan-out (`GMAIL_MAX_PROJECTS_PER_MESSAGE`); omesso =
   * {@link GMAIL_MAX_PROJECTS_PER_MESSAGE}.
   */
  maxProjectsPerMessage?: number;
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
  /**
   * Fase 6c — Task 6: tetto giornaliero di classificazioni per questa casella
   * (`GMAIL_MAX_PER_DAY`); omesso = {@link DEFAULT_GMAIL_MAX_PER_DAY}. `0` =
   * nessun tetto. Contato dai run `agent_runs` con `phase = 'email_classify'`
   * il cui `email_message_id` appartiene a questa casella, nelle ultime 24
   * ore da `now`.
   */
  maxPerDay?: number;
  /**
   * Fase 6c — Task 6: cooldown in minuti fra due classificazioni dello STESSO
   * thread (`GMAIL_THREAD_COOLDOWN_MINUTES`); omesso =
   * {@link DEFAULT_GMAIL_THREAD_COOLDOWN_MINUTES}. `0` = disattivato. Un
   * messaggio `new` il cui thread ha già avuto una classificazione entro
   * questa finestra viene SALTATO (resta `new`, nessun run) e il ciclo passa
   * al successivo — un thread attivo non deve bloccare la coda.
   */
  threadCooldownMinutes?: number;
  /**
   * Fase 6c — Task 6: iniettabile per i test, stesso ruolo di
   * `monthlyCostUsdFn` in `apps/worker/src/pipeline/fix.ts` — default
   * `monthlyCostUsd` da `@stubwise/db`. Usato dal gate del budget mensile,
   * la STESSA verifica che usano i fix (stesso tetto, letto da
   * `instance_settings.monthly_budget_usd`): la posta non deve poter erodere
   * il budget senza esserne frenata.
   */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
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
  // Fase 6b: un blocco PER PROGETTO del perimetro, con intestazione propria
  // (nome + id, così il modello sa quale id usare in `proposals[].projectId`)
  // e sotto il SUO contesto — non un'unica lista condivisa.
  const projectBlocks: string[] =
    input.projects.length > 0
      ? input.projects.flatMap((p) => {
          const backlogLines =
            p.backlogTitles.length > 0
              ? p.backlogTitles.map((title) => `- ${title}`)
              : [`- ${t(lang, "email.input.none")}`];
          const ticketLines =
            p.openTickets.length > 0
              ? p.openTickets.map((ticket) => `- #${ticket.number} (${ticket.status}) ${ticket.title}`)
              : [`- ${t(lang, "email.input.none")}`];
          return [
            "",
            t(lang, "email.input.projectHeading", { name: p.name, id: p.id }),
            ...(p.description ? [p.description] : []),
            `${t(lang, "email.input.backlog")}:`,
            ...backlogLines,
            `${t(lang, "email.input.tickets")}:`,
            ...ticketLines,
          ];
        })
      : ["", `- ${t(lang, "email.input.none")}`];

  const lines: string[] = [
    t(lang, "email.signals.instructions"),
    "",
    `OUTPUT (JSON only): ${OUTPUT_SHAPE}`,
    ...projectBlocks,
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

/** Il contesto DI UN progetto: ticket aperti (per numero) e titoli di backlog. */
interface ProjectContext {
  openTickets: Map<number, { id: string; title: string; status: string }>;
  backlogTitles: string[];
}

/** Il contesto con cui i referenti dell'agente vengono riconfrontati. */
export interface ClassifyContext {
  /** Progetti su cui una proposta può insistere: il PERIMETRO del messaggio. */
  allowedProjectIds: Set<string>;
  /**
   * L'ordine del perimetro (`scopeProjectIds`/`allowed`), per il tie-break
   * deterministico del tetto sul fan-out (`GMAIL_MAX_PROJECTS_PER_MESSAGE`).
   */
  perimeterOrder: string[];
  /**
   * Il progetto RISOLTO dal routing (il vincitore), o `null` se il messaggio
   * è ambiguo (parità di regole, nessun vincitore). Serve a completare
   * un'azione a cui il modello ha scordato il `projectId`: quando esiste un
   * vincitore il referente non è un'informazione che il modello debba
   * indovinare, lo sappiamo già noi.
   */
  resolvedProjectId: string | null;
  projects: { id: string; name: string; description: string | null }[];
  /**
   * Contesto (ticket aperti, titoli di backlog) PER OGNI progetto del
   * perimetro — fase 6b: prima c'era un solo contesto (quello del progetto
   * risolto), ora ce n'è uno per ciascun progetto ammesso, chiavato per id.
   */
  contextByProject: Map<string, ProjectContext>;
  citedTicketNumbers: number[];
}

/**
 * Carica il contesto di UN messaggio: ticket aperti e titoli di backlog PER
 * CIASCUN progetto del PERIMETRO (`allowed` = `scopeProjectIds`, con
 * fallback per le righe pre fase 6b — vedi sotto), non solo del progetto
 * risolto. Due query totali (una per i ticket, una per il backlog) con un
 * `WHERE project_id IN (...)`, non una per progetto in un loop: il risultato
 * si raggruppa poi in memoria.
 *
 * Ai {@link CLASSIFY_CONTEXT_ROWS} più recenti PER PROGETTO si aggiungono i
 * ticket CITATI nel messaggio (`#N`): senza di loro, rispondere a un'email
 * che parla del ticket #3 di sei mesi fa produrrebbe sempre e solo proposte
 * scartate.
 *
 * Fase 6c: se il perimetro derivato (`scopeProjectIds`/fallback) è VUOTO —
 * un messaggio ammesso per dominio Workspace senza nessuna regola di
 * progetto — non si degrada più subito a "niente da proporre": i candidati
 * diventano TUTTI i progetti dell'istanza. Il messaggio è «da attribuire»,
 * non «non è lavoro», e solo l'analisi (col contesto, ancora capato a
 * {@link CLASSIFY_CONTEXT_ROWS} per progetto) può dirlo. Un'istanza SENZA
 * alcun progetto resta comunque vuota: non c'è niente su cui attribuire
 * nulla, e {@link classifyEmail} continua a ignorare senza chiamare il
 * modello.
 */
async function loadContext(
  db: Db,
  message: EmailMessageRow,
): Promise<ClassifyContext> {
  // Fallback per le righe pre fase 6b: `scopeProjectIds` ha default `'{}'`
  // (sempre un array, mai null/undefined), ma può essere VUOTO per i
  // messaggi ingeriti prima che il routing lo popolasse. In quel caso si
  // ricade sul comportamento precedente: il progetto risolto, o i candidati.
  const derivedAllowed =
    message.scopeProjectIds.length > 0
      ? message.scopeProjectIds
      : message.projectId
        ? [message.projectId]
        : message.candidateProjectIds;
  const cited = citedTicketNumbers(`${message.subject ?? ""}\n${message.textExcerpt ?? ""}`);

  // Perimetro vuoto (fase 6c): i candidati diventano tutti i progetti
  // dell'istanza. Nessun filtro su stato/archiviazione — lo schema non ne ha
  // uno (verificato su `projects`, come già fanno il pulse e la `GET
  // /api/projects/pulse`, che leggono l'istanza intera senza un filtro
  // "attivo"). Ordinati per data di creazione: stesso ordine di `GET
  // /api/projects`, e dà al tie-break del tetto sul fan-out
  // (`perimeterOrder`, vedi {@link revalidateClassification}) un ordine
  // deterministico anche in questo caso.
  const projectRows =
    derivedAllowed.length > 0
      ? await db
          .select({ id: projects.id, name: projects.name, description: projects.description })
          .from(projects)
          .where(inArray(projects.id, derivedAllowed))
      : await db
          .select({ id: projects.id, name: projects.name, description: projects.description })
          .from(projects)
          .orderBy(asc(projects.createdAt));
  const allowed = derivedAllowed.length > 0 ? derivedAllowed : projectRows.map((p) => p.id);
  const allowedProjectIds = new Set(allowed);

  if (allowed.length === 0) {
    return {
      allowedProjectIds,
      perimeterOrder: allowed,
      resolvedProjectId: message.projectId,
      projects: [],
      contextByProject: new Map(),
      citedTicketNumbers: cited,
    };
  }

  const contextByProject = new Map<string, ProjectContext>();
  for (const id of allowed) contextByProject.set(id, { openTickets: new Map(), backlogTitles: [] });

  const backlogRows = await db
    .select({ projectId: backlogItems.projectId, title: backlogItems.title })
    .from(backlogItems)
    .where(
      and(
        inArray(backlogItems.projectId, allowed),
        notInArray(backlogItems.status, ["converted", "archived"]),
      ),
    )
    .orderBy(desc(backlogItems.updatedAt));

  const openWhere = and(
    inArray(tickets.projectId, allowed),
    notInArray(tickets.status, ["done", "closed"]),
  );
  const recentTickets = await db
    .select({
      id: tickets.id,
      projectId: tickets.projectId,
      number: tickets.number,
      title: tickets.title,
      status: tickets.status,
    })
    .from(tickets)
    .where(openWhere)
    .orderBy(desc(tickets.number));
  const citedTickets =
    cited.length > 0
      ? await db
          .select({
            id: tickets.id,
            projectId: tickets.projectId,
            number: tickets.number,
            title: tickets.title,
            status: tickets.status,
          })
          .from(tickets)
          .where(and(openWhere, inArray(tickets.number, cited)))
      : [];

  // Cap PER PROGETTO: la query è globale (ordinata per data/numero decrescente
  // su TUTTO il perimetro), ma per ogni projectId la sotto-sequenza filtrata
  // resta nello stesso ordine — un semplice contatore per progetto basta a
  // tenere solo i CLASSIFY_CONTEXT_ROWS più recenti di ciascuno.
  const backlogCount = new Map<string, number>();
  for (const row of backlogRows) {
    const ctx = contextByProject.get(row.projectId);
    if (!ctx) continue;
    const count = backlogCount.get(row.projectId) ?? 0;
    if (count >= CLASSIFY_CONTEXT_ROWS) continue;
    ctx.backlogTitles.push(row.title);
    backlogCount.set(row.projectId, count + 1);
  }

  const ticketCount = new Map<string, number>();
  for (const row of recentTickets) {
    const ctx = contextByProject.get(row.projectId);
    if (!ctx) continue;
    const count = ticketCount.get(row.projectId) ?? 0;
    if (count >= CLASSIFY_CONTEXT_ROWS) continue;
    ctx.openTickets.set(row.number, { id: row.id, title: row.title, status: row.status });
    ticketCount.set(row.projectId, count + 1);
  }
  // I ticket CITATI entrano sempre, anche oltre il cap: sono la ragione
  // stessa per cui esistono (vedi il docblock).
  for (const row of citedTickets) {
    const ctx = contextByProject.get(row.projectId);
    if (!ctx) continue;
    ctx.openTickets.set(row.number, { id: row.id, title: row.title, status: row.status });
  }

  return {
    allowedProjectIds,
    perimeterOrder: allowed,
    resolvedProjectId: message.projectId,
    projects: projectRows,
    contextByProject,
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

  // Progetto: se c'è, deve essere uno di quelli del PERIMETRO. Se NON c'è e il
  // routing ha risolto un vincitore, lo mettiamo noi: è un dato che sappiamo,
  // non una lacuna da punire scartando l'azione. Con un messaggio ambiguo
  // (nessun vincitore), invece, l'omissione resta tale — indovinare fra più
  // progetti è esattamente ciò che il routing si rifiuta di fare.
  const projectId = input.projectId ?? ctx.resolvedProjectId ?? undefined;
  if (projectId !== undefined && !ctx.allowedProjectIds.has(projectId)) return null;

  // Ticket: se c'è, deve essere un ticket APERTO del progetto DELLA PROPOSTA
  // (fase 6b), non di un ipotetico "progetto risolto" unico — la mappa dei
  // ticket è ora chiavata per progetto. Senza un progetto risolvibile non
  // c'è un insieme di ticket contro cui validare, quindi l'azione se ne va.
  let ticketId: string | undefined;
  if (input.ticketNumber !== undefined) {
    if (projectId === undefined) return null;
    const ticket = ctx.contextByProject.get(projectId)?.openTickets.get(input.ticketNumber);
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
 * Rivalida l'intero output e lo PARTIZIONA per progetto (fase 6b), tutto nel
 * CODICE — il protocollo di output del modello non cambia, ogni proposta
 * porta già il proprio `projectId` (rivalidato da {@link revalidateProposal},
 * che lo garantisce SEMPRE presente su ogni proposta sopravvissuta: ogni
 * ramo del suo `switch` finale richiede `proposal.ticketId` — che a sua volta
 * richiede un `projectId` risolto — o `proposal.projectId` direttamente).
 *
 * Tre passi, in ordine:
 *  1. rivalida ogni proposta grezza, nell'ordine del modello;
 *  2. cap PER PROGETTO: le prime {@link CLASSIFY_MAX_PROPOSALS} sopravvissute
 *     di ciascun progetto (non dell'intero messaggio);
 *  3. tetto sul FAN-OUT (`maxProjectsPerMessage`): se i progetti con almeno
 *     una proposta valida sono più del tetto, sopravvivono quelli con PIÙ
 *     proposte — a parità decide l'ordine del perimetro, per determinismo.
 *
 * Il risultato resta un'unica lista PIATTA (proposte di progetti diversi
 * mescolate, ciascuna col suo `projectId`): è la fase D (Task 4) a
 * ripartizionarla per la scrittura sui figli. `recommendedIndex` è rimappato
 * su questa lista finale (se la consigliata è stata scartata — dalla
 * rivalidazione, dal cap o dal tetto — si consiglia la prima rimasta: un
 * indice che punta al vuoto farebbe evidenziare l'opzione sbagliata).
 */
export function revalidateClassification(
  output: EmailSignalsOutput,
  ctx: ClassifyContext,
  now: Date,
  maxProjectsPerMessage: number = GMAIL_MAX_PROJECTS_PER_MESSAGE,
): EmailClassification {
  // Passo 1: rivalidazione, nell'ordine originale del modello.
  const validated: { proposal: RevalidatedProposal; originalIndex: number }[] = [];
  for (const [index, raw] of output.proposals.entries()) {
    const proposal = revalidateProposal(raw, ctx, now);
    if (proposal) validated.push({ proposal, originalIndex: index });
  }

  // Passo 2: cap PER PROGETTO. `proposal.projectId` è sempre definito qui
  // (vedi il docblock), quindi il `!` è sicuro.
  const byProject = new Map<string, (typeof validated)[number][]>();
  for (const entry of validated) {
    const projectId = entry.proposal.projectId!;
    const list = byProject.get(projectId) ?? [];
    if (list.length >= CLASSIFY_MAX_PROPOSALS) continue;
    list.push(entry);
    byProject.set(projectId, list);
  }

  // Passo 3: tetto sul fan-out, tenendo i progetti con più proposte valide.
  let projectIds = [...byProject.keys()];
  if (projectIds.length > maxProjectsPerMessage) {
    const perimeterIndex = new Map(ctx.perimeterOrder.map((id, i) => [id, i]));
    projectIds = [...projectIds]
      .sort((a, b) => {
        const byCount = byProject.get(b)!.length - byProject.get(a)!.length;
        if (byCount !== 0) return byCount;
        return (perimeterIndex.get(a) ?? 0) - (perimeterIndex.get(b) ?? 0);
      })
      .slice(0, maxProjectsPerMessage);
  }
  const keptProjectIds = new Set(projectIds);
  const keptEntries = new Set(
    [...byProject.entries()]
      .filter(([projectId]) => keptProjectIds.has(projectId))
      .flatMap(([, list]) => list),
  );

  // Riappiattisce, nell'ordine ORIGINALE del modello (non raggruppato per
  // progetto): è ciò che rende `recommendedIndex` rimappabile in modo
  // coerente con l'indice che il modello aveva scelto.
  const kept: RevalidatedProposal[] = [];
  let recommendedIndex = 0;
  for (const entry of validated) {
    if (!keptEntries.has(entry)) continue;
    if (entry.originalIndex === output.recommendedIndex) recommendedIndex = kept.length;
    kept.push(entry.proposal);
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

/** Lettura TOLLERANTE del solo `projectId` di UNA proposta grezza (fase 6c). */
const rawProposalProjectIdSchema = z.object({ projectId: z.string().min(1).optional() }).loose();

/**
 * Fase 6c: i progetti che le proposte SCARTATE nominavano — non un elenco
 * arbitrario. Guarda l'output GREZZO del modello (`raw`, PRIMA della
 * rivalidazione: quando questa funzione serve, ZERO proposte sono
 * sopravvissute, quindi ogni proposta qui dentro è per forza una proposta
 * scartata), nell'ordine in cui il modello le ha scritte, e tiene solo gli id
 * che sono REALMENTE nel perimetro allargato (`allowedProjectIds`) — un id
 * che il modello ha inventato non ha un nome da mostrare su un'opzione, e
 * mostrarlo comunque sarebbe un'opzione rotta, non "generosa". Senza
 * doppioni, fino a `cap`.
 */
export function extractSuggestedProjectIds(
  raw: unknown[],
  allowedProjectIds: Set<string>,
  cap: number = TRIAGE_MAX_SUGGESTED_PROJECTS,
): string[] {
  const found: string[] = [];
  for (const item of raw) {
    if (found.length >= cap) break;
    const parsed = rawProposalProjectIdSchema.safeParse(item);
    if (!parsed.success || !parsed.data.projectId) continue;
    const projectId = parsed.data.projectId;
    if (!allowedProjectIds.has(projectId) || found.includes(projectId)) continue;
    found.push(projectId);
  }
  return found;
}

/**
 * Fase 6b — Task 4: scrive l'esito della classificazione sui FIGLI
 * (`email_proposals`), un upsert PER PROGETTO, non più un unico UPDATE sul
 * padre. Tutto in UNA transazione, in tre passi:
 *
 *  1. **upsert per progetto**, guardato su `status = 'classified'`: l'`ON
 *     CONFLICT` trova comunque la riga esistente (serve per il match), ma la
 *     clausola `setWhere` blocca l'UPDATE se quella riga non è più
 *     `classified` — una riclassificazione non deve MAI toccare un figlio
 *     già `proposed`, `actioned`, `ignored` o `failed` (l'utente ha già
 *     agito, o la card è già aperta in una inbox);
 *  2. **delete dei soli figli `classified` non più nella nuova partizione**:
 *     MAI un `DELETE` totale (senza il filtro su `status`), che
 *     cancellerebbe anche una card `proposed`/`actioned` lasciando la sua
 *     notifica orfana — è esattamente l'anti-pattern che questa fase vieta;
 *  3. **il padre**: `signal` sempre aggiornato (proprietà del messaggio),
 *     `status` derivato da "esiste almeno un figlio (qualunque stato) per
 *     questo messaggio, dopo i passi 1-2" — non dalla sola nuova partizione,
 *     perché un figlio `proposed` più vecchio, lasciato intatto dal passo 1,
 *     conta comunque come "il messaggio ha prodotto qualcosa". Quando NESSUN
 *     figlio resta (fase 6c, Task 5), lo `status` NON è più sempre `ignored`:
 *     si biforca su `classification.signal` — vedi sotto. `error` è sempre
 *     `null`: la classificazione è riuscita anche quando tutto è stato
 *     scartato.
 *
 * `notInArray` con un array VUOTO genera `sql\`true\`` in drizzle-orm (non un
 * `NOT IN ()` letterale, che sarebbe un errore di sintassi Postgres —
 * verificato nel sorgente installato, non assunto): con una nuova
 * partizione vuota il passo 2 elimina correttamente TUTTI i figli
 * `classified` rimasti, che è l'esito voluto quando nessuna proposta è
 * sopravvissuta per nessun progetto.
 *
 * ## Fase 6c — Task 5: il terzo esito, quando NESSUN figlio resta
 *
 * Prima di questo task, "zero figli" degradava SEMPRE a `ignored` — vedi il
 * design §4, "Tre esiti". Ora si biforca su `classification.signal` E su
 * `resolvedProjectId`:
 *
 *  - `signal === 'none'`: **invariato**, `ignored` — nessun segnale, niente
 *    da smistare;
 *  - `signal !== 'none'` MA `resolvedProjectId !== null` (un progetto era
 *    già risolto dal routing, senza ambiguità): **invariato**, `ignored` —
 *    zero proposte sopravvissute qui non è "nessun progetto attribuibile",
 *    è "nessuna azione utile per un progetto che già conoscevamo con
 *    certezza" (un ticket citato che non esiste, una data già passata…).
 *    ⚠️ **DEVIAZIONE deliberata dal testo del piano**, che non distingue
 *    esplicitamente questo caso: proporre "a quale progetto appartiene?"
 *    quando il progetto è GIÀ certo produrrebbe una card senza senso — la
 *    domanda che la proposta di smistamento fa è letteralmente quella a cui
 *    si sa già la risposta. Verificato che i tre test preesistenti che
 *    rientrano in questo ramo (progetto risolto, referente non di progetto
 *    che fallisce) si aspettavano `ignored`: è la lettura coerente col resto
 *    del sistema, non solo con quei test;
 *  - `signal !== 'none'` E `resolvedProjectId === null` (nessun vincitore:
 *    perimetro vuoto da ammissione senza regole — Task 4 — O regole in
 *    PARITÀ, candidati multipli senza vincitore — il caso ambiguo che la
 *    fase 6 ORIGINALE risolveva con «Riguarda …», poi deprecato in
 *    generazione dalla 6b): **nuovo**, resta `classified` — nessuna proposta
 *    ha superato la rivalidazione per NESSUN progetto, e senza un vincitore
 *    non c'è modo di completare un `projectId` mancante (vedi
 *    `revalidateProposal`). Il padre porta la forma
 *    {@link EmailTriageClassification} (marcatore `triage: true`) invece
 *    della {@link EmailClassification} normale: NESSUN figlio viene creato
 *    qui (il fan-out ha già scritto zero righe, ai passi 1-2 sopra — questo
 *    branch non fa altro che scegliere la FORMA del padre), e il messaggio
 *    resta `classified` apposta perché il poller
 *    (`apps/worker/src/google/poller.ts`, `runProposePhase`) lo selezioni al
 *    giro successivo e costruisca la proposta di SMISTAMENTO
 *    (`./proposal.ts`, `buildTriageProposalEvent`) — che vive SUL PADRE,
 *    riusando `email_messages.proposal_notification_id`.
 */
async function writeClassification(
  db: Db,
  messageId: string,
  classification: EmailClassification,
  now: Date,
  /** Fase 6c: l'output GREZZO del modello (prima della rivalidazione) e il
   * perimetro allargato, per calcolare {@link EmailTriageClassification.suggestedProjectIds}
   * SOLO quando serve (nel branch "zero figli, signal !== 'none', nessun
   * vincitore"). */
  rawProposals: unknown[],
  allowedProjectIds: Set<string>,
  /** Fase 6c: il progetto RISOLTO dal routing (`ClassifyContext.resolvedProjectId`),
   * o `null` se ambiguo/assente — decide se "zero figli" è `ignored` o «da
   * smistare» (vedi il docblock qui sopra). */
  resolvedProjectId: string | null,
): Promise<ClassifyOutcome> {
  // Ripartiziona la lista piatta per progetto (`proposal.projectId` è sempre
  // definito su ogni proposta sopravvissuta, vedi il docblock di
  // `revalidateClassification`).
  const byProject = new Map<string, RevalidatedProposal[]>();
  for (const proposal of classification.proposals) {
    const projectId = proposal.projectId!;
    const list = byProject.get(projectId) ?? [];
    list.push(proposal);
    byProject.set(projectId, list);
  }
  // L'opzione CONSIGLIATA dal modello (se ce n'è una), per rimappare
  // `recommendedIndex` dentro il sottoinsieme di CIASCUN figlio.
  const recommended =
    classification.proposals.length > 0 ? classification.proposals[classification.recommendedIndex] : undefined;

  return db.transaction(async (tx) => {
    const keptProjectIds = [...byProject.keys()];

    for (const projectId of keptProjectIds) {
      const proposals = byProject.get(projectId)!;
      const localRecommendedIndex = recommended ? Math.max(proposals.indexOf(recommended), 0) : 0;
      const childClassification: EmailClassification = {
        signal: classification.signal,
        summary: classification.summary,
        proposals,
        recommendedIndex: localRecommendedIndex,
      };
      await tx
        .insert(emailProposals)
        .values({
          emailMessageId: messageId,
          projectId,
          status: "classified",
          classification: childClassification as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [emailProposals.emailMessageId, emailProposals.projectId],
          set: {
            classification: childClassification as unknown as Record<string, unknown>,
            updatedAt: now,
          },
          setWhere: eq(emailProposals.status, "classified"),
        });
    }

    await tx
      .delete(emailProposals)
      .where(
        and(
          eq(emailProposals.emailMessageId, messageId),
          eq(emailProposals.status, "classified"),
          notInArray(emailProposals.projectId, keptProjectIds),
        ),
      );

    const remainingChildren = await tx
      .select({ id: emailProposals.id })
      .from(emailProposals)
      .where(eq(emailProposals.emailMessageId, messageId))
      .limit(1);

    // Fase 6c — Task 5: il terzo esito (vedi il docblock qui sopra). Con
    // figli il padre resta `classified` come sempre; senza figli si biforca
    // su `signal` E su `resolvedProjectId` invece di degradare sempre a
    // `ignored`.
    let parentStatus: ClassifyOutcome;
    let parentClassification: Record<string, unknown>;
    if (remainingChildren.length > 0) {
      parentStatus = "classified";
      parentClassification = classification as unknown as Record<string, unknown>;
    } else if (classification.signal === "none" || resolvedProjectId !== null) {
      // Invariato: nessun segnale, O un progetto era già risolto (nessuna
      // ambiguità da smistare) — vedi il docblock, "DEVIAZIONE deliberata".
      parentStatus = "ignored";
      parentClassification = classification as unknown as Record<string, unknown>;
    } else {
      // NUOVO: segnale reale, nessun vincitore, nessuna proposta attribuita
      // a nessun progetto. Il padre resta `classified` — SENZA figli —
      // apposta perché il poller lo selezioni per la proposta di
      // smistamento (`proposal.ts`).
      parentStatus = "classified";
      const triage: EmailTriageClassification = {
        triage: true,
        signal: classification.signal,
        summary: classification.summary,
        suggestedProjectIds: extractSuggestedProjectIds(rawProposals, allowedProjectIds),
      };
      parentClassification = triage as unknown as Record<string, unknown>;
    }

    await tx
      .update(emailMessages)
      .set({
        status: parentStatus,
        signal: classification.signal,
        classification: parentClassification,
        error: null,
      })
      .where(eq(emailMessages.id, messageId));

    return parentStatus;
  });
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
      // Fase 6b: un blocco di contesto PER OGNI progetto del perimetro.
      projects: ctx.projects.map((p) => {
        const projectCtx = ctx.contextByProject.get(p.id);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          backlogTitles: projectCtx?.backlogTitles ?? [],
          openTickets: [...(projectCtx?.openTickets.entries() ?? [])].map(([number, ticket]) => ({
            number,
            title: ticket.title,
            status: ticket.status,
          })),
        };
      }),
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

    const classification = revalidateClassification(
      parsed,
      ctx,
      now,
      deps.maxProjectsPerMessage ?? GMAIL_MAX_PROJECTS_PER_MESSAGE,
    );
    return await writeClassification(
      deps.db,
      message.id,
      classification,
      now,
      parsed.proposals,
      ctx.allowedProjectIds,
      ctx.resolvedProjectId,
    );
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

/** Formatta un importo USD come `fix.ts` (4 decimali) — stesso stile del log del budget dei fix. */
function fmtUsd(n: number): string {
  return n.toFixed(4);
}

/**
 * L'email di una casella, per i log dei tetti (Task 6): quelli guardano una
 * casella, non un id opaco. `accountId` come fallback SOLO se la riga è
 * sparita fra il claim e questo controllo (caso limite, mai visto in pratica).
 */
async function loadAccountEmail(db: Db, accountId: string): Promise<string> {
  const [row] = await db
    .select({ email: googleAccounts.email })
    .from(googleAccounts)
    .where(eq(googleAccounts.id, accountId));
  return row?.email ?? accountId;
}

/**
 * Fase 6c — Task 6: quante classificazioni (`agent_runs.phase =
 * 'email_classify'`) ha fatto QUESTA casella nelle ultime `hours` ore — un
 * JOIN su `email_messages` per risalire alla casella, dato che `agent_runs`
 * non porta `account_id` direttamente.
 *
 * La finestra usa `now()` DI POSTGRES, non un `now` iniettato: le righe che
 * conta sono scritte da `recordAgentRun` con `created_at` a `defaultNow()`
 * (il timestamp REALE del DB), quindi confrontarle con un orologio finto
 * romperebbe il confronto — stessa scelta di {@link monthlyCostUsd} (mese
 * corrente via `date_trunc('month', now())`) e di `pruneOldEmails` in
 * `poller.ts` (`make_interval`).
 */
async function countClassifyRunsSince(db: Db, accountId: string, hours: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(agentRuns)
    .innerJoin(emailMessages, eq(agentRuns.emailMessageId, emailMessages.id))
    .where(
      and(
        eq(agentRuns.phase, "email_classify"),
        eq(emailMessages.accountId, accountId),
        sql`${agentRuns.createdAt} >= now() - make_interval(hours => ${Math.trunc(hours)})`,
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Fase 6c — Task 6: il THREAD di un messaggio ha già avuto una
 * classificazione entro `minutes` minuti da adesso? Stesso JOIN e stessa
 * scelta di `now()` DI POSTGRES di {@link countClassifyRunsSince} — vedi lì
 * il motivo.
 */
async function threadClassifiedRecently(db: Db, threadId: string, minutes: number): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(emailMessages, eq(agentRuns.emailMessageId, emailMessages.id))
    .where(
      and(
        eq(agentRuns.phase, "email_classify"),
        eq(emailMessages.threadId, threadId),
        sql`${agentRuns.createdAt} >= now() - make_interval(mins => ${Math.trunc(minutes)})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Fase 6c — Task 6: il tetto di budget MENSILE d'istanza, la STESSA colonna
 * che legge `apps/worker/src/pipeline/fix.ts` prima di un fix
 * (`instance_settings.monthly_budget_usd`, singleton id=1). `null` = nessun
 * tetto configurato. I numeric di Postgres arrivano come stringa.
 */
async function loadMonthlyBudgetUsd(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return row?.monthlyBudgetUsd != null && row.monthlyBudgetUsd !== ""
    ? Number(row.monthlyBudgetUsd)
    : null;
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
 *
 * ## Fase 6c — Task 6: tre difese di costo, in ordine di granularità decrescente
 *
 * 1. **Tetto giornaliero PER CASELLA** (`maxPerDay`/`GMAIL_MAX_PER_DAY`): un
 *    controllo UNA VOLTA, prima di guardare qualunque messaggio. Raggiunto,
 *    la classificazione si ferma qui: nessun run, nessuna query dei
 *    pendenti, i messaggi `new` restano `new` e vengono ripresi al giro (o
 *    al giorno) dopo.
 * 2. **Gate del budget MENSILE** (`instance_settings.monthly_budget_usd`, la
 *    STESSA verifica dei fix): anche questo un controllo UNA VOLTA, subito
 *    dopo il tetto giornaliero. È per-ISTANZA, non per-casella — ma essendo
 *    verificato a ogni chiamata di questa funzione (una per casella per
 *    tick) e la spesa non potendo MAI diminuire durante un tick, un budget
 *    già sforato blocca automaticamente anche le caselle ancora da
 *    processare in questo giro, senza bisogno di un controllo separato a
 *    monte del loop sulle caselle (`pollGoogleOnce`).
 * 3. **Cooldown PER THREAD** (`threadCooldownMinutes`/
 *    `GMAIL_THREAD_COOLDOWN_MINUTES`): un controllo PER MESSAGGIO, dentro il
 *    loop. Un thread già classificato nella finestra viene saltato (resta
 *    `new`, nessun run) e il ciclo passa al successivo — un thread attivo
 *    non deve bloccare il resto della coda.
 */
export async function classifyNewMessages(
  deps: ClassifyBatchDeps,
  accountId: string,
): Promise<ClassifyBatchStats> {
  const stats: ClassifyBatchStats = { classified: 0, ignored: 0, failed: 0 };
  if (deps.maxPerTick <= 0) return stats;

  const logger = deps.logger ?? defaultLogger;

  // 1. Tetto giornaliero per casella (0 = nessun tetto: comportamento di prima).
  const maxPerDay = deps.maxPerDay ?? DEFAULT_GMAIL_MAX_PER_DAY;
  if (maxPerDay > 0) {
    const runsToday = await countClassifyRunsSince(deps.db, accountId, 24);
    if (runsToday >= maxPerDay) {
      const email = await loadAccountEmail(deps.db, accountId);
      logger.warn(
        `google: casella ${email}: tetto giornaliero di classificazione raggiunto (${runsToday}/${maxPerDay}), riprendo domani`,
      );
      return stats;
    }
  }

  // 2. Gate del budget mensile d'istanza (la stessa verifica dei fix).
  const monthlyCostUsdFn = deps.monthlyCostUsdFn ?? monthlyCostUsd;
  const monthlyBudgetUsd = await loadMonthlyBudgetUsd(deps.db);
  if (monthlyBudgetUsd != null) {
    const monthlySpent = await monthlyCostUsdFn(deps.db);
    if (monthlySpent >= monthlyBudgetUsd) {
      const email = await loadAccountEmail(deps.db, accountId);
      logger.warn(
        `google: casella ${email}: budget mensile superato ($${fmtUsd(monthlySpent)}/$${fmtUsd(monthlyBudgetUsd)}), classificazione sospesa per questo tick`,
      );
      return stats;
    }
  }

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

  // 3. Cooldown per thread (0 = disattivato: comportamento di prima).
  const threadCooldownMinutes = deps.threadCooldownMinutes ?? DEFAULT_GMAIL_THREAD_COOLDOWN_MINUTES;

  for (const message of pending) {
    if (deps.signal?.aborted) break;

    if (threadCooldownMinutes > 0) {
      const inCooldown = await threadClassifiedRecently(
        deps.db,
        message.threadId,
        threadCooldownMinutes,
      );
      if (inCooldown) {
        logger.info(
          `google: messaggio ${message.id} saltato (thread ${message.threadId} classificato meno di ${threadCooldownMinutes}' fa), riprovo al prossimo giro`,
        );
        continue;
      }
    }

    const outcome = await classifyEmail(
      {
        db: deps.db,
        runner: deps.runner,
        lang,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.maxProjectsPerMessage !== undefined
          ? { maxProjectsPerMessage: deps.maxProjectsPerMessage }
          : {}),
      },
      message,
    );
    stats[outcome] += 1;
  }
  return stats;
}
