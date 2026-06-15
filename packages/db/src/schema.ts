import {
  gitProviderKindSchema,
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Converte le opzioni di uno z.enum nella tupla non vuota richiesta da pgEnum,
 * preservando i tipi letterali. Gli schemi Zod in @stubwise/shared restano
 * l'unica fonte di verità per i valori: enum Postgres e validazione non
 * possono divergere.
 */
function enumValues<T extends string>(schema: { options: readonly T[] }): [T, ...T[]] {
  return schema.options as [T, ...T[]];
}

export const userRole = pgEnum("user_role", ["admin", "member"]);
export const gitProviderKind = pgEnum("git_provider_kind", enumValues(gitProviderKindSchema));
export const ticketType = pgEnum("ticket_type", enumValues(ticketTypeSchema));
export const ticketPriority = pgEnum("ticket_priority", enumValues(ticketPrioritySchema));
export const ticketStatus = pgEnum("ticket_status", enumValues(ticketStatusSchema));
export const ticketSource = pgEnum("ticket_source", enumValues(ticketSourceSchema));
// "system" copre le notifiche automatiche (es. "PR mergiata → ticket chiuso"):
// non hanno un autore umano né l'AI dietro, e vanno distinte nella timeline.
export const commentAuthorType = pgEnum("comment_author_type", ["user", "ai", "system"]);
// Dominio del worker AI, ma vive nel DB: definito qui.
export const aiJobStatus = pgEnum("ai_job_status", [
  "queued",
  "triaging",
  "fixing",
  // "held": il triage ha deciso "fix" ma il gate di automazione non lo
  // consente (auto-fix disattivato per il tipo, oppure effort sopra soglia).
  // Il job resta in attesa di un avvio manuale (POST /run-ai).
  "held",
  "pr_opened",
  "pr_merged",
  "failed",
  "skipped",
  // "pr_closed": la PR aperta dal fix è stata chiusa senza merge (rifiutata da
  // un umano). Stato terminale, distinto da "pr_merged".
  "pr_closed",
  // "awaiting_plan_approval": la pianificazione ha prodotto un piano che
  // supera la soglia di effort configurata; il job è parcheggiato in attesa
  // dell'approvazione umana prima di eseguirlo.
  "awaiting_plan_approval",
]);
// Le due fasi AI di cui tracciamo i consumi (token + costo): triage e fix.
export const agentRunPhase = pgEnum("agent_run_phase", ["triage", "fix"]);

// Modalità di ripresa di un job rimesso in coda da un intervento umano:
//  null     → job normale: triage → (gate) → fix;
//  "fix"    → salta il triage, va al fix (può ri-fermarsi sul gate del piano);
//  "execute"→ salta triage E pianificazione, esegue usando plan_text.
export const resumeMode = pgEnum("resume_mode", ["fix", "execute"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable("invites", {
  token: text("token").primaryKey(),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Istante di creazione dell'invito: serve alla pagina Team per mostrare
  // "invitato il …" e ordinare la lista degli inviti in sospeso.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  // Lookup delle sessioni di un utente (logout globale, pulizia in cascata).
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * Account git riutilizzabile: contiene le credenziali (cifrate AES-256-GCM)
 * di accesso a un provider, slegate dal singolo progetto. Un account può
 * essere usato da più progetti; il worker e la configurazione webhook leggono
 * le credenziali da qui (via projects.git_account_id), mai più dal progetto.
 * Il provider è ridondato sul progetto (denormalizzato) per comodità di lettura,
 * ma la fonte di verità delle credenziali è l'account.
 */
export const gitAccounts = pgTable("git_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  provider: gitProviderKind("provider").notNull(),
  // JSON { username?, email?, token } cifrato AES-256-GCM (vedi secrets.ts).
  // Non esce MAI dall'API: si legge solo per validare/decifrare lato server.
  encryptedCredentials: text("encrypted_credentials").notNull(),
  // Slug del workspace Bitbucket. Obbligatorio per usare le feature repo di un
  // account Bitbucket con API token: Bitbucket Cloud (CHANGE-2770) ha dismesso
  // gli endpoint account/globali (410 Gone), quindi i repo si elencano solo
  // per workspace (GET /2.0/repositories/{workspace}). Null per GitHub, che
  // continua a usare /user/repos.
  workspace: text("workspace"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  provider: gitProviderKind("provider").notNull(),
  // Account git che fornisce le credenziali del progetto. ON DELETE RESTRICT:
  // un account in uso da almeno un progetto non può essere eliminato (il
  // server risponde 409). Le credenziali NON vivono più qui: stanno sull'account.
  gitAccountId: uuid("git_account_id")
    .notNull()
    .references(() => gitAccounts.id, { onDelete: "restrict" }),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  ingestionKey: text("ingestion_key").notNull().unique(),
  // Segreto HMAC del webhook git (chiusura automatica al merge): 32 hex
  // generati alla creazione del progetto. Il default '' copre le righe
  // pre-esistenti alla migrazione; un progetto con segreto vuoto rifiuta i
  // webhook (non li può verificare).
  webhookSecret: text("webhook_secret").notNull().default(""),
  // Istante in cui il webhook git è stato configurato automaticamente sul
  // provider (POST /configure-webhook). Nullable: null = mai configurato, la
  // UI mostra l'azione di configurazione; valorizzato = stato "configurato".
  webhookConfiguredAt: timestamp("webhook_configured_at", { withTimezone: true }),
  // Contatore per i numeri ticket sequenziali per-progetto: l'applicazione
  // lo incrementa in transazione quando crea un ticket.
  nextTicketNumber: integer("next_ticket_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    type: ticketType("type").notNull(),
    priority: ticketPriority("priority").notNull(),
    status: ticketStatus("status").notNull().default("open"),
    source: ticketSource("source").notNull(),
    // Stima di sforzo 1–5 prodotta dal triage AI (null finché non triagiato).
    // Alimenta il gate di automazione (auto-fix solo se effort <= maxEffort).
    effort: integer("effort"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    labels: text("labels").array().notNull().default([]),
    // Payload tecnico per i ticket da SDK: stack trace, browser, URL,
    // release, breadcrumbs.
    technicalPayload: jsonb("technical_payload"),
    occurrences: integer("occurrences").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("tickets_project_id_number_unique").on(table.projectId, table.number),
    // Board e liste filtrano sempre per progetto e stato.
    index("tickets_project_id_status_idx").on(table.projectId, table.status),
  ],
);

export const errorGroups = pgTable(
  "error_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("error_groups_project_id_fingerprint_unique").on(
      table.projectId,
      table.fingerprint,
    ),
    // FK: risalita dal ticket al gruppo di errori e delete in cascata.
    index("error_groups_ticket_id_idx").on(table.ticketId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    authorType: commentAuthorType("author_type").notNull(),
    // Nullo per i commenti dell'AI; nullato se l'autore viene eliminato.
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // I commenti si caricano sempre per ticket.
  (table) => [index("comments_ticket_id_idx").on(table.ticketId)],
);

export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    status: aiJobStatus("status").notNull().default("queued"),
    // Avvio manuale dell'AI da parte di un umano (POST /run-ai): scavalca il
    // gate di automazione, quindi un fix procede anche con auto-fix off o
    // effort sopra soglia. False per i job nati automaticamente dall'ingest.
    manualTrigger: boolean("manual_trigger").notNull().default(false),
    log: text("log").notNull().default(""),
    prUrl: text("pr_url"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Heartbeat del worker: toccato da claim, transizioni e appendLog. È la
    // base del recupero dei job orfani (requeueStale): un job che logga è
    // vivo anche se in lavorazione da molto.
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    // Modalità di ripresa di un job rimesso in coda da un intervento umano:
    //  null     → job normale: triage → (gate) → fix;
    //  "fix"    → salta il triage, va al fix (può ri-fermarsi sul gate del piano);
    //  "execute"→ salta triage E pianificazione, esegue usando plan_text.
    resumeMode: resumeMode("resume_mode"),
    // Piano prodotto dalla fase di pianificazione, persistito tra il parcheggio
    // in awaiting_plan_approval e la ripresa in esecuzione (resume_mode="execute").
    planText: text("plan_text"),
  },
  (table) => [
    // Lookup dei job di un ticket (storico e dettaglio).
    index("ai_jobs_ticket_id_idx").on(table.ticketId),
    // Claim del worker: il job in coda più vecchio. Indice parziale, resta
    // minuscolo perché copre solo i job ancora in stato "queued".
    index("ai_jobs_queued_created_at_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
  ],
);

/**
 * Consumi (token + costo) di un singolo run dell'agente, una riga per
 * (job, fase, modello). Un run può usare più modelli (subagent): il worker
 * registra una riga per ciascun modello riportato dal CLI. Best-effort: la
 * registrazione non deve mai far fallire il job, quindi una mancanza di righe
 * significa semplicemente "nessun dato di consumo" (CLI vecchio o output non
 * parsabile), non un errore.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    phase: agentRunPhase("phase").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    // Costo in USD del modello per questo run. Nullable: il CLI può non
    // riportarlo (vecchie versioni, chiave senza usage nel JSON).
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Aggregazione dei consumi per job (e, via join, per ticket).
    index("agent_runs_job_id_idx").on(table.jobId),
  ],
);

/**
 * Regole di automazione AI per tipo di ticket: l'admin decide in Settings se
 * l'auto-fix è attivo e fino a quale sforzo. Una riga per ciascun ticket_type
 * (il tipo è chiave primaria). Il gate del triage le legge dopo aver
 * (ri)classificato il tipo: auto-fix parte solo se `auto_fix` è true e
 * `effort <= max_effort`. Le 4 righe sono seedate dalla migrazione con default
 * sensati; il server fa comunque fallback a un default se una riga mancasse.
 */
export const automationRules = pgTable("automation_rules", {
  type: ticketType("type").primaryKey(),
  autoFix: boolean("auto_fix").notNull().default(true),
  maxEffort: integer("max_effort").notNull().default(3),
  // Approvazione umana del piano richiesta quando l'effort stimato è >= a
  // questo valore. null = mai (default): il fix procede senza fermarsi.
  planApprovalMinEffort: integer("plan_approval_min_effort"),
});

// Formato del messaggio del webhook di notifica in uscita: Slack (mrkdwn),
// Discord (markdown) o un payload JSON generico machine-readable.
export const notificationFormat = pgEnum("notification_format", ["slack", "discord", "generic"]);

/**
 * Configurazione (riga singola) del webhook di notifica in uscita: Stubwise
 * posta un messaggio su eventi chiave (nuovo ticket SDK, PR aperta, job in
 * attesa, fix fallito). È un singleton: l'id è fissato a 1 e la migrazione
 * seeda l'unica riga, così il server fa upsert su id=1 e non ci sono righe
 * multiple da riconciliare. `enabled` è l'interruttore generale; i toggle
 * per-evento permettono di scegliere quali notifiche inviare. `webhookUrl`
 * nullo (o `enabled` false) = nessuna notifica.
 */
export const notificationSettings = pgTable("notification_settings", {
  // Singleton: id fissato a 1. Il server fa upsert su questa PK; la migrazione
  // seeda la riga, quindi esiste sempre esattamente una configurazione.
  id: integer("id").primaryKey().default(1),
  // URL HTTPS del webhook (Slack/Discord/endpoint generico). Null = non
  // configurato: il dispatch è un no-op.
  webhookUrl: text("webhook_url"),
  format: notificationFormat("format").notNull().default("slack"),
  // Interruttore generale: false = nessuna notifica, qualunque sia il toggle.
  enabled: boolean("enabled").notNull().default(true),
  notifyTicketCreated: boolean("notify_ticket_created").notNull().default(true),
  notifyPrOpened: boolean("notify_pr_opened").notNull().default(true),
  notifyJobHeld: boolean("notify_job_held").notNull().default(true),
  notifyJobFailed: boolean("notify_job_failed").notNull().default(true),
  notifyPrClosed: boolean("notify_pr_closed").notNull().default(true),
  notifyPlanReview: boolean("notify_plan_review").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
