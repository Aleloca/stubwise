import {
  gitProviderKindSchema,
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { sql } from "drizzle-orm";
import {
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
  "pr_opened",
  "pr_merged",
  "failed",
  "skipped",
]);
// Le due fasi AI di cui tracciamo i consumi (token + costo): triage e fix.
export const agentRunPhase = pgEnum("agent_run_phase", ["triage", "fix"]);

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

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  provider: gitProviderKind("provider").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
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
