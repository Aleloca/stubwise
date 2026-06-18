import {
  gitProviderKindSchema,
  languageSchema,
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  customType,
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
 * Tipo `tsvector` di Postgres, non modellato nativamente da drizzle. Usato per
 * la colonna generata `tickets.search_tsv` (ricerca full-text): drizzle non
 * deve mai scriverlo (è GENERATED ALWAYS), serve solo a dichiararne il tipo
 * nello schema così che lo snapshot e l'indice GIN risultino coerenti.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
export const language = pgEnum("language", enumValues(languageSchema));
export const gitProviderKind = pgEnum("git_provider_kind", enumValues(gitProviderKindSchema));
export const ticketType = pgEnum("ticket_type", enumValues(ticketTypeSchema));
export const ticketPriority = pgEnum("ticket_priority", enumValues(ticketPrioritySchema));
export const ticketStatus = pgEnum("ticket_status", enumValues(ticketStatusSchema));
export const ticketSource = pgEnum("ticket_source", enumValues(ticketSourceSchema));
// "system" copre le notifiche automatiche (es. "PR mergiata → ticket chiuso"):
// non hanno un autore umano né l'AI dietro, e vanno distinte nella timeline.
export const commentAuthorType = pgEnum("comment_author_type", ["user", "ai", "system"]);
// Tipi di evento registrati nell'audit/timeline di un ticket. Lista letterale
// (non passa da uno schema Zod di shared): per ora resta locale al DB. Valori
// futuri (milestone_changed, relation_*) li aggiungeranno le feature successive.
export const ticketEventKind = pgEnum("ticket_event_kind", [
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "type_changed",
  "labels_changed",
  "title_changed",
  "body_changed",
  "relation_added",
  "relation_removed",
  "milestone_changed",
]);
// Tipi di relazione tra ticket: "blocks" (il source blocca il target),
// "relates_to" (relazione generica), "parent" (il source è genitore del target).
// Lista letterale locale al DB (come ticketEventKind).
export const ticketLinkKind = pgEnum("ticket_link_kind", ["blocks", "relates_to", "parent"]);
// Stato di una milestone: "open" (attiva, raccoglie i ticket pianificati) o
// "closed" (chiusa/archiviata). Lista letterale locale al DB.
export const milestoneStatus = pgEnum("milestone_status", ["open", "closed"]);
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
  // Lingua preferita dell'utente per la UI. Default "en"; ogni utente la
  // sceglie indipendentemente dalla lingua dei contenuti generati.
  language: language("language").notNull().default("en"),
  // Identità Slack del membro: lo user id dell'utente nel workspace Slack.
  // Unique perché un'identità Slack mappa a un solo membro; nullable perché i
  // membri creati fuori da Slack (es. invito email) non hanno un id Slack. In
  // Postgres l'unique ignora i NULL, quindi più membri senza Slack convivono.
  slackUserId: text("slack_user_id").unique(),
  // URL dell'avatar Slack del membro, mostrato nella UI quando disponibile.
  slackAvatarUrl: text("slack_avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable("invites", {
  token: text("token").primaryKey(),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Identità Slack opzionale propagata all'utente quando l'invito viene
  // accettato (invito originato da Slack). NON unique: più inviti pendenti
  // possono fare riferimento alla stessa identità Slack.
  slackUserId: text("slack_user_id"),
  // URL dell'avatar Slack da copiare sull'utente all'accettazione dell'invito.
  slackAvatarUrl: text("slack_avatar_url"),
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
  // Comando di test del progetto (es. "pnpm test"), eseguito dall'agente per
  // verificare il fix prima di aprire la PR (self-repair). Null = nessun
  // comando configurato: l'agente non esegue la fase di verifica.
  testCommand: text("test_command"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Milestone di progetto: raggruppa i ticket verso un obiettivo (release,
 * sprint) con una scadenza opzionale. Cancellata in cascata col progetto.
 * `dueDate` null = nessuna scadenza. L'unique (project_id, name) impedisce
 * milestone omonime nello stesso progetto, ma ammette lo stesso nome in
 * progetti diversi.
 */
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Scadenza opzionale della milestone: null = nessuna data.
    dueDate: timestamp("due_date", { withTimezone: true }),
    status: milestoneStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Le milestone si elencano sempre per progetto.
    index("milestones_project_id_idx").on(table.projectId),
    // Nome univoco per progetto.
    uniqueIndex("milestones_project_id_name_unique").on(table.projectId, table.name),
  ],
);

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
    // Milestone a cui il ticket è assegnato; null = nessuna milestone. La
    // milestone eliminata libera il ticket (set null) senza cancellarlo.
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
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
    // Vettore full-text generato (stored) da titolo + corpo: alimenta la ricerca
    // testuale via `@@ websearch_to_tsquery`. `to_tsvector('english', …)` a 2
    // argomenti è IMMUTABLE, requisito per una generated column. La colonna è
    // sola lettura per l'applicazione (drizzle non la scrive mai).
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${tickets.title}, '') || ' ' || coalesce(${tickets.body}, ''))`,
    ),
  },
  (table) => [
    uniqueIndex("tickets_project_id_number_unique").on(table.projectId, table.number),
    // Board e liste filtrano sempre per progetto e stato.
    index("tickets_project_id_status_idx").on(table.projectId, table.status),
    // Lookup dei ticket di una milestone (e set null in cascata).
    index("tickets_milestone_id_idx").on(table.milestoneId),
    // Ricerca full-text sul vettore generato.
    index("tickets_search_tsv_idx").using("gin", table.searchTsv),
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

/**
 * Eventi di audit/timeline di un ticket: traccia chi (o il sistema/AI) ha
 * cambiato cosa e quando. `actorId` null = evento di sistema o generato
 * dall'AI (nessun autore umano). `payload` jsonb opzionale porta il dettaglio
 * della transizione (es. { from, to }). Cancellazione in cascata col ticket.
 */
export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // Null = evento di sistema/AI; nullato se l'autore umano viene eliminato.
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    kind: ticketEventKind("kind").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // La timeline si carica sempre per ticket, ordinata cronologicamente.
  (table) => [
    index("ticket_events_ticket_id_created_at_idx").on(table.ticketId, table.createdAt),
  ],
);

/**
 * Relazioni dirette tra ticket: il `source` è in relazione `kind` col `target`
 * (es. source "blocks" target, source "parent" di target). Cancellazione in
 * cascata su entrambe le direzioni: rimuovere un ticket elimina i link in cui
 * è source O target. L'unique su (source, target, kind) impedisce duplicati
 * della stessa relazione, ma ammette relazioni di tipo diverso tra gli stessi
 * due ticket.
 */
export const ticketLinks = pgTable(
  "ticket_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceTicketId: uuid("source_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    targetTicketId: uuid("target_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: ticketLinkKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_links_source_target_kind_unique").on(
      table.sourceTicketId,
      table.targetTicketId,
      table.kind,
    ),
    index("ticket_links_source_idx").on(table.sourceTicketId),
    index("ticket_links_target_idx").on(table.targetTicketId),
  ],
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
  // Tetto di costo in USD per un singolo run di questo tipo: se la stima/consumo
  // supera la soglia il job viene parcheggiato (budget held). Stesso tipo di
  // agentRuns.costUsd. null = nessun limite (default).
  maxCostUsd: numeric("max_cost_usd", { precision: 12, scale: 6 }),
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
  // Notifica quando un job viene parcheggiato per superamento del budget di
  // costo (budget held).
  notifyBudgetHeld: boolean("notify_budget_held").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Impostazioni globali dell'istanza (riga singola). Singleton come
 * notificationSettings: id fissato a 1, la migrazione seeda l'unica riga e il
 * server fa upsert su id=1. `contentLanguage` è la lingua dei contenuti
 * generati dall'AI (titoli, descrizioni, commenti), distinta dalla lingua di
 * UI scelta dal singolo utente (users.language).
 */
export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  contentLanguage: language("content_language").notNull().default("en"),
  // Budget di costo mensile complessivo in USD per l'intera istanza. Stesso
  // tipo di agentRuns.costUsd. null = nessun limite (default).
  monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 6 }),
  // Configurazione dello storage S3-compatibile per gli allegati. Tutte
  // nullable: lo storage è opzionale; con queste colonne a null la feature
  // allegati è disattivata. La secret key è cifrata a riposo (AES-256-GCM, vedi
  // secrets.ts), come le credenziali git: non esce mai in chiaro dall'API.
  s3Endpoint: text("s3_endpoint"),
  s3Region: text("s3_region"),
  s3Bucket: text("s3_bucket"),
  s3AccessKey: text("s3_access_key"),
  s3SecretKeyEncrypted: text("s3_secret_key_encrypted"),
  // Credenziali Slack per l'ingestion (slash command / interazioni) e per la
  // verifica delle richieste in arrivo. Entrambe nullable: l'integrazione Slack
  // è opzionale; con queste colonne a null la feature è disattivata. Cifrate a
  // riposo (AES-256-GCM, vedi secrets.ts) come le altre secret: non escono mai
  // in chiaro dall'API.
  slackSigningSecretEncrypted: text("slack_signing_secret_encrypted"),
  slackBotTokenEncrypted: text("slack_bot_token_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Allegati di un ticket (o di uno specifico commento del ticket): file caricati
 * dagli utenti o screenshot prodotti dall'SDK. Il binario vive nello storage
 * S3-compatibile (vedi le colonne s3_* di instance_settings); qui si tiene solo
 * il metadato e la chiave (`storage_key`) per recuperarlo. `commentId` null =
 * allegato del ticket non legato a un commento; `uploaderId` null = caricato
 * dall'SDK o uploader eliminato. Cascata dal ticket e dal commento; lo uploader
 * eliminato lascia l'allegato (set null). `storage_key` è unico: una chiave di
 * storage mappa esattamente un oggetto.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // Allegato legato a un commento specifico; null = allegato del ticket.
    // Cancellato in cascata col commento.
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    // Autore del caricamento; null per gli screenshot SDK o se l'utente viene
    // eliminato (set null: l'allegato sopravvive).
    uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Gli allegati si caricano sempre per ticket, ordinati cronologicamente.
    index("attachments_ticket_id_created_at_idx").on(table.ticketId, table.createdAt),
    // Lookup degli allegati di un commento (e delete in cascata).
    index("attachments_comment_id_idx").on(table.commentId),
    // Una chiave di storage mappa esattamente un oggetto.
    uniqueIndex("attachments_storage_key_unique").on(table.storageKey),
  ],
);

/**
 * Vista salvata di un utente: un set di filtri della lista ticket riusabile
 * (es. "I miei bug aperti"). `filters` è un oggetto jsonb con i criteri di
 * filtraggio (tutti opzionali). `shared` true = visibile agli altri utenti
 * dell'istanza; false (default) = privata del proprietario. Cancellata in
 * cascata con l'utente. L'unique (owner_id, name) impedisce viste omonime per
 * lo stesso proprietario.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Criteri di filtraggio della lista ticket; tutti opzionali.
    filters: jsonb("filters")
      .notNull()
      .$type<{
        projectId?: string;
        status?: string;
        type?: string;
        priority?: string;
        assigneeId?: string;
        milestoneId?: string;
        q?: string;
      }>(),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Le viste si elencano sempre per proprietario.
    index("saved_views_owner_id_idx").on(table.ownerId),
    // Nome univoco per proprietario.
    uniqueIndex("saved_views_owner_id_name_unique").on(table.ownerId, table.name),
  ],
);
