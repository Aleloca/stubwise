import {
  docGenerationStatusSchema,
  docGenerationTriggerSchema,
  docJobStatusSchema,
  docNodeStatusSchema,
  docPageKindSchema,
  docTreeSchema,
  gitProviderKindSchema,
  heldReasonSchema,
  languageSchema,
  prStateSchema,
  searchEntityTypeSchema,
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
 * Tipo `vector` di pgvector, non modellato nativamente da drizzle. La dimensione
 * è parametrica (fissata a 1024 per bge-m3 nelle colonne che lo usano). In TS è
 * un `number[]`; sul driver è la rappresentazione testuale `[n,n,...]` che
 * pgvector accetta/restituisce. `toDriver`/`fromDriver` fanno la conversione.
 */
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      // pgvector restituisce "[n,n,...]"; il vettore vuoto è "[]". Senza guard
      // "".split(",") darebbe [""] → [NaN]: si gestisce esplicitamente il caso.
      const inner = value.slice(1, -1);
      return inner === "" ? [] : inner.split(",").map(Number);
    },
  })("embedding");

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
// Le fasi AI di cui tracciamo i consumi (token + costo): triage, fix e review.
export const agentRunPhase = pgEnum("agent_run_phase", ["triage", "fix", "review"]);

// Motivo per cui un job è parcheggiato in "held": i valori derivano da
// `heldReasonSchema` (shared = unica fonte di verità). Solo "limit" (limite di
// utilizzo del provider) è auto-ripristinabile dal resume poller.
export const heldReason = pgEnum("held_reason", enumValues(heldReasonSchema));

// Modalità di ripresa di un job rimesso in coda da un intervento umano:
//  null     → job normale: triage → (gate) → fix;
//  "fix"    → salta il triage, va al fix (può ri-fermarsi sul gate del piano);
//  "execute"→ salta triage E pianificazione, esegue usando plan_text.
export const resumeMode = pgEnum("resume_mode", ["fix", "execute"]);

// Stato della PR aperta dal fix su un singolo repo di un ticket multi-repo:
//  "open"            → PR aperta, in attesa di merge;
//  "merged"          → PR mergiata (il gate aggregato può chiudere il ticket);
//  "closed_unmerged" → PR chiusa senza merge (rifiutata): rimette in lavorazione
//                      solo quel repo, senza toccare gli altri.
// I valori derivano da `prStateSchema` (shared = unica fonte di verità), come
// gli altri enum del dominio: l'enum Postgres resta in sync con lo Zod.
export const prState = pgEnum("pr_state", enumValues(prStateSchema));

// Tipo di credenziale di un provider AI: "api_key" (chiave API a consumo) o
// "account" (login a un piano/abbonamento, es. Claude Max). Determina come il
// worker prepara l'ambiente per il CLI. Lista letterale locale al DB, come gli
// altri enum del dominio AI (ai_job_status, agent_run_phase, resume_mode).
export const aiProviderKind = pgEnum("ai_provider_kind", ["api_key", "account"]);
// Origine di uno snapshot di consumo: "deterministic" (estratto da un output
// strutturato/parsabile del CLI) o "llm_fallback" (dedotto da un modello quando
// il parsing deterministico fallisce). Marca l'affidabilità del dato.
export const aiUsageSource = pgEnum("ai_usage_source", ["deterministic", "llm_fallback"]);

// Enum del dominio Docs (documentazione autogenerata). I valori derivano dagli
// schema Zod condivisi in @stubwise/shared: enum Postgres e validazione non
// possono divergere.
export const docPageKind = pgEnum("doc_page_kind", enumValues(docPageKindSchema));
export const docGenerationStatus = pgEnum(
  "doc_generation_status",
  enumValues(docGenerationStatusSchema),
);
export const docGenerationTrigger = pgEnum(
  "doc_generation_trigger",
  enumValues(docGenerationTriggerSchema),
);
export const docJobStatus = pgEnum("doc_job_status", enumValues(docJobStatusSchema));
export const docNodeStatus = pgEnum("doc_node_status", enumValues(docNodeStatusSchema));
export const docTree = pgEnum("doc_tree", enumValues(docTreeSchema));
// Tipo di entità nella cronologia di ricerca unificata (spotlight globale):
// ticket, progetto, repository o pagina di documentazione.
export const searchEntity = pgEnum("search_entity", enumValues(searchEntityTypeSchema));

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

/**
 * Progetto (gruppo): raggruppa uno o più repository (relazione 1:N). È il
 * livello "prodotto" — vi appartengono ticket e milestone — e porta le
 * impostazioni di prodotto che valgono per tutti i suoi repository: il provider
 * AI (`aiProviderId`, salito dal vecchio progetto/repo) e il toggle di
 * auto-aggiornamento della documentazione (`docAutoUpdate`). Lo `slug` è unico.
 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Descrizione libera del progetto, opzionale (mostrata nella UI di dettaglio).
  description: text("description"),
  // Provider AI generale del progetto, valido per Docs e fix di tutti i suoi
  // repository; null = automatico (primo abilitato al momento dell'esecuzione).
  // ON DELETE SET NULL: rimuovere il provider non blocca il progetto, ricade
  // sull'automatico.
  aiProviderId: uuid("ai_provider_id").references(() => aiProviders.id, {
    onDelete: "set null",
  }),
  // Aggiornamento automatico della documentazione ai push (changelog/release):
  // false = disattivo (i push non innescano nulla). Toggle per-progetto, vale
  // per tutti i repository del progetto.
  docAutoUpdate: boolean("doc_auto_update").notNull().default(false),
  // Chiave di ingestion del progetto (salita da repositories in Fase 3): gli
  // errori via SDK e i feedback sono del prodotto/progetto, non di un repo — è
  // l'agente a capire quale repo sistemare. La chiave esistente è stata migrata
  // identica dal repo 1:1 al suo progetto, così gli SDK già installati continuano
  // a funzionare senza riconfigurazione. UNIQUE: identifica il progetto in ingest.
  ingestionKey: text("ingestion_key").notNull().unique(),
  // Contatore per i numeri ticket sequenziali per-PROGETTO (salito da
  // repositories in Fase 3): l'applicazione lo incrementa in transazione quando
  // crea un ticket. Il branch `stubwise/ticket-N` usa N di progetto ed è pushato
  // su ciascun repo modificato dal fix multi-repo.
  nextTicketNumber: integer("next_ticket_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Repository: un singolo repo git (l'ex "progetto", rinominato). Appartiene a
 * esattamente un progetto (`projectId`, NOT NULL, cascade). Porta tutto ciò che
 * è specifico del repo git/ingest/webhook/docs. Le impostazioni di prodotto
 * (provider AI, auto-update docs) NON vivono più qui: sono salite al progetto.
 */
export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Progetto (gruppo) a cui il repository appartiene. NOT NULL: un repo sta
  // sempre in un progetto. ON DELETE CASCADE: eliminare il progetto porta via i
  // suoi repository.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  provider: gitProviderKind("provider").notNull(),
  // Account git che fornisce le credenziali del repository. ON DELETE RESTRICT:
  // un account in uso da almeno un repository non può essere eliminato (il
  // server risponde 409). Le credenziali NON vivono più qui: stanno sull'account.
  gitAccountId: uuid("git_account_id")
    .notNull()
    .references(() => gitAccounts.id, { onDelete: "restrict" }),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  // Segreto HMAC del webhook git (chiusura automatica al merge): 32 hex
  // generati alla creazione del repository. Il default '' copre le righe
  // pre-esistenti alla migrazione; un repository con segreto vuoto rifiuta i
  // webhook (non li può verificare).
  webhookSecret: text("webhook_secret").notNull().default(""),
  // Istante in cui il webhook git è stato configurato automaticamente sul
  // provider (POST /configure-webhook). Nullable: null = mai configurato, la
  // UI mostra l'azione di configurazione; valorizzato = stato "configurato".
  webhookConfiguredAt: timestamp("webhook_configured_at", { withTimezone: true }),
  // Comando di test del repository (es. "pnpm test"), eseguito dall'agente per
  // verificare il fix prima di aprire la PR (self-repair). Null = nessun
  // comando configurato: l'agente non esegue la fase di verifica.
  testCommand: text("test_command"),
  // Comando di install del repository (es. "pnpm install"), eseguito dall'agente
  // nel worktree effimero prima della fase di fix/verifica. Override opzionale:
  // null = nessun comando configurato, l'agente usa il default/euristica.
  installCommand: text("install_command"),
  // Generazione di documentazione "corrente" del repository: puntatore soft alla
  // doc_generations attiva (si imposta dopo lo swap). Niente reference circolare
  // hard (repositories↔doc_generations) per evitare problemi d'ordine in
  // migrazione: l'integrità è validata a livello applicativo. Null = nessuna doc.
  currentDocGenerationId: uuid("current_doc_generation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Milestone di progetto: raggruppa i ticket verso un obiettivo (release,
 * sprint) con una scadenza opzionale. È a livello di PROGETTO (gruppo):
 * `projectId` punta a `projects`. `repositoryId` è il repository d'origine
 * (ereditato dalla migrazione 1:1) e resta valorizzato in Fase 1; cancellata in
 * cascata col progetto. `dueDate` null = nessuna scadenza. L'unique
 * (project_id, name) impedisce milestone omonime nello stesso progetto, ma
 * ammette lo stesso nome in progetti diversi.
 */
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Progetto (gruppo) a cui la milestone appartiene.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Repository d'origine della milestone (ex project_id, ora → repositories).
    // Tenuto per continuità con i dati esistenti; in Fase 1 sempre valorizzato.
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
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
    // Progetto (gruppo) a cui il ticket appartiene: il ticket è product-level.
    // In Fase 3 questo è l'UNICO legame del ticket con la gerarchia repo: il
    // ticket non ha più un "repo di origine" (RIMOSSO). Il legame ticket↔repo
    // vive solo in `ticketRepositories`, popolato dopo l'esecuzione del fix.
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

/**
 * Gruppo di errori per la dedup dell'ingestion: un `fingerprint` (firma
 * dell'errore) mappa al ticket generato. In Fase 3 l'ingestion è a livello di
 * PROGETTO (D8): gli errori via SDK sono del prodotto, non di un repo — quindi
 * `projectId` (salito da `repositoryId`) e l'unicità del fingerprint è
 * per-progetto. Cancellato in cascata col progetto.
 */
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
    // Fingerprint univoco per progetto: lo stesso errore in progetti diversi è
    // un gruppo distinto, ma un duplicato nello stesso progetto è deduplicato.
    uniqueIndex("error_groups_project_id_fingerprint_unique").on(
      table.projectId,
      table.fingerprint,
    ),
    // FK: risalita dal ticket al gruppo di errori e delete in cascata.
    index("error_groups_ticket_id_idx").on(table.ticketId),
  ],
);

/**
 * Stato PR per-repo di un ticket (Fase 3, fix multi-repo): una riga per ogni
 * repository effettivamente modificato dal fix, con il branch, la PR aperta e il
 * suo stato. È l'UNICO legame ticket↔repo (tickets.repositoryId è stato rimosso):
 * il ticket appartiene solo al progetto, e questa tabella traccia su quali repo
 * ha prodotto una PR. Popolata DOPO l'esecuzione dell'agente. Il ticket va a
 * `done` solo quando TUTTE le sue righe sono `merged` (gate aggregato). L'unique
 * (ticket_id, repository_id) impedisce due righe per lo stesso repo di un ticket.
 * Cancellata in cascata sia col ticket sia col repository.
 */
export const ticketRepositories = pgTable(
  "ticket_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Branch del fix su questo repo (es. `stubwise/ticket-N`, N di progetto).
    branch: text("branch").notNull(),
    // URL della PR aperta su questo repo; null finché non è stata aperta.
    prUrl: text("pr_url"),
    prState: prState("pr_state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Una sola riga per (ticket, repo): il fix apre al più una PR per repo.
    uniqueIndex("ticket_repositories_ticket_id_repository_id_unique").on(
      table.ticketId,
      table.repositoryId,
    ),
    // Lo stato per-repo si legge sempre per ticket (dettaglio, gate aggregato).
    index("ticket_repositories_ticket_id_idx").on(table.ticketId),
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
    // Motivo dell'ultimo `held`: SOLO `limit` viene riaccodato automaticamente
    // dal resume poller; budget/gate restano decisioni umane. Null per gli
    // held storici (mai riaccodati: conservativo).
    heldReason: heldReason("held_reason"),
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
    // Provider AI con cui il job è stato (o sarà) eseguito. Nullable: i job
    // pre-esistenti alla feature provider non lo hanno, e un job può essere in
    // coda prima che il worker scelga la credenziale. ON DELETE SET NULL: il job
    // sopravvive all'eliminazione del provider (lo storico resta consultabile).
    providerId: uuid("provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
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
    // Job AI del fix/triage; null per i run dell'automazione PR Review (che
    // referenziano pr_review_id). Esattamente uno dei due è valorizzato.
    jobId: uuid("job_id").references(() => aiJobs.id, { onDelete: "cascade" }),
    // Run dell'automazione PR Review; null per triage/fix.
    prReviewId: uuid("pr_review_id").references(() => prReviews.id, { onDelete: "cascade" }),
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
    // Aggregazione del costo per review + cascade delete da pr_reviews.
    index("agent_runs_pr_review_id_idx").on(table.prReviewId),
    // Esattamente uno tra job_id e pr_review_id valorizzato (vedi commenti
    // sulle colonne): l'invariante è garantita dal DB, non solo dal codice.
    check("agent_runs_owner_check", sql`num_nonnulls(job_id, pr_review_id) = 1`),
  ],
);

/**
 * Provider AI configurati dall'admin: una credenziale (chiave API o account)
 * usata dal worker per eseguire i job. L'ordine di failover è dato da
 * `position` (intero crescente): il worker prova i provider abilitati in ordine
 * e passa al successivo al raggiungimento del limite. Il riordino è applicativo
 * (riscrittura delle position in transazione), quindi `position` resta un intero
 * semplice senza unique, per non creare attriti durante lo swap. `secretEncrypted`
 * è il blob cifrato AES-256-GCM (vedi secrets.ts): non esce mai in chiaro dall'API.
 */
// Stato del test di una credenziale: il server registra la richiesta
// (test_requested_at) e il worker — l'unico che può lanciare `claude` — la
// raccoglie, esegue un `claude -p` minimale con quella credenziale e scrive
// l'esito. `idle` = nessun test richiesto/eseguito; `pending` = richiesto, in
// attesa del worker; `passed`/`failed` = esito dell'ultimo test.
export const aiProviderTestStatus = pgEnum("ai_provider_test_status", [
  "idle",
  "pending",
  "passed",
  "failed",
]);

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Ordine di failover (intero crescente). Niente unique: il riordino è
  // applicativo e riscrive le position in transazione.
  position: integer("position").notNull(),
  kind: aiProviderKind("kind").notNull(),
  label: text("label").notNull(),
  // Credenziale cifrata AES-256-GCM (chiave API o blob di login dell'account).
  // Non esce MAI dall'API: si legge solo per decifrare lato worker.
  secretEncrypted: text("secret_encrypted").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // --- Test della credenziale (richiesta dal server, eseguita dal worker) ---
  // Stato dell'ultimo test (vedi aiProviderTestStatus). `pending` = il worker
  // deve raccoglierlo ed eseguire un `claude -p` di prova con questa credenziale.
  testStatus: aiProviderTestStatus("test_status").notNull().default("idle"),
  // Istante in cui l'admin ha richiesto il test (server). Il worker raccoglie i
  // `pending` ordinati per questo campo. NULL quando non c'è una richiesta.
  testRequestedAt: timestamp("test_requested_at", { withTimezone: true }),
  // Istante in cui il worker ha scritto l'esito (passed/failed). NULL finché
  // non ha ancora processato la richiesta.
  testCheckedAt: timestamp("test_checked_at", { withTimezone: true }),
  // Messaggio d'errore dell'ultimo test fallito (mai il segreto). NULL su
  // successo o quando non c'è ancora un esito.
  testError: text("test_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Istantanea dei consumi/residui di un provider AI a un dato momento: alimenta
 * la diagnosi del consumo residuo (sessione + finestra settimanale) e i banner
 * di stato. `sessionRemaining`/`weeklyRemaining` sono jsonb liberi (formato del
 * provider, normalizzato lato applicazione); i `*ResetAt` sono gli istanti di
 * reset delle due finestre, nullable. `source` distingue il dato estratto in
 * modo deterministico dal CLI da quello dedotto via LLM di fallback; `parseOk`
 * dice se l'estrazione è andata a buon fine; `rawText` conserva l'output grezzo
 * (nullable) per diagnosi. Cancellati in cascata col provider.
 */
export const aiUsageSnapshots = pgTable(
  "ai_usage_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => aiProviders.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    // Residuo della finestra di sessione (formato provider, normalizzato lato app).
    sessionRemaining: jsonb("session_remaining"),
    // Residuo della finestra settimanale (formato provider, normalizzato lato app).
    weeklyRemaining: jsonb("weekly_remaining"),
    sessionResetAt: timestamp("session_reset_at", { withTimezone: true }),
    weeklyResetAt: timestamp("weekly_reset_at", { withTimezone: true }),
    source: aiUsageSource("source").notNull(),
    parseOk: boolean("parse_ok").notNull(),
    // Output grezzo da cui è stato estratto lo snapshot; null = non conservato.
    rawText: text("raw_text"),
  },
  (table) => [
    // Lo storico consumi si legge sempre per provider, in ordine cronologico
    // (ultimo snapshot, andamento). Copre anche il delete in cascata.
    index("ai_usage_snapshots_provider_id_captured_at_idx").on(table.providerId, table.capturedAt),
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
  // Notifica al completamento di una PR Review automatica.
  notifyReviewCompleted: boolean("notify_review_completed").notNull().default(true),
  // Notifica quando una generazione Docs va in pausa per limite di utilizzo del
  // provider AI (unico evento senza ticket).
  notifyDocsLimitPaused: boolean("notify_docs_limit_paused").notNull().default(true),
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
  // Automazione PR Review: interruttore globale (default spento) e tetto di
  // costo USD per singola review (null = nessun limite). Il gate vive nel
  // webhook (accodamento) e nel worker (claim + verifica post-run del cap).
  prReviewEnabled: boolean("pr_review_enabled").notNull().default(false),
  prReviewMaxCostUsd: numeric("pr_review_max_cost_usd", { precision: 12, scale: 6 }),
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

/**
 * File d'ambiente configurato per un progetto (es. ".env", ".env.local"): un
 * percorso relativo nel worktree in cui il worker materializza le variabili
 * cifrate prima della fase di fix/verifica. `path` è il percorso relativo del
 * file. Cancellato in cascata col progetto. L'unique (project_id, path) vieta
 * due file omonimi nello stesso progetto, ma ammette lo stesso path in progetti
 * diversi.
 */
export const projectEnvFiles = pgTable(
  "project_env_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Percorso univoco per repository.
    uniqueIndex("project_env_files_project_id_path_unique").on(table.repositoryId, table.path),
  ],
);

/**
 * Variabile d'ambiente di un file di progetto: `key` è il nome della variabile,
 * `valueEncrypted` è il valore cifrato AES-256-GCM (vedi secrets.ts), che non
 * esce mai in chiaro dall'API e viene decifrato solo dal worker al momento di
 * materializzare il file. Cancellata in cascata col file. L'unique (file_id,
 * key) vieta due variabili omonime nello stesso file, ma ammette la stessa key
 * in file diversi.
 */
export const projectEnvVars = pgTable(
  "project_env_vars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => projectEnvFiles.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Nome variabile univoco per file.
    uniqueIndex("project_env_vars_file_id_key_unique").on(table.fileId, table.key),
  ],
);

/**
 * Una generazione di documentazione di un progetto: l'esecuzione (map-reduce
 * agentico) che produce l'insieme di pagine/chunk a partire da un commit. Lo
 * stato segue il ciclo pending→running→succeeded/failed. `commitSha` registra
 * il commit documentato (fase incrementale futura); `cost`/`stats` tracciano il
 * consumo aggregato. La generazione "corrente" del progetto è puntata da
 * projects.current_doc_generation_id (swap applicativo). Cascata col progetto.
 */
export const docGenerations = pgTable(
  "doc_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    status: docGenerationStatus("status").notNull().default("pending"),
    // Commit documentato da questa generazione; null finché il job non lo fissa.
    commitSha: text("commit_sha"),
    trigger: docGenerationTrigger("trigger").notNull().default("manual"),
    // Provider AI scelto per blindare la generazione; null = automatico (primo abilitato).
    pinnedProviderId: uuid("pinned_provider_id").references(() => aiProviders.id, {
      onDelete: "set null",
    }),
    // Modello AI usato per la generazione; null finché non avviata.
    model: text("model"),
    // Costo aggregato in USD della generazione. Nullable (stesso tipo di
    // agentRuns.costUsd): null finché non calcolato.
    cost: numeric("cost", { precision: 12, scale: 6 }),
    // Breakdown libero (per-modulo, token, durate) in jsonb.
    stats: jsonb("stats"),
    error: text("error"),
    // Pausa per limite di utilizzo del provider: la generazione resta viva (i
    // nodi tornano pending, il claim li salta) e il resume poller la rimette
    // running quando l'utilizzo si libera. Il worktree è in-memoria: un
    // riavvio del worker durante la pausa la fallisce (fail-on-restart,
    // rischio accettato dal design).
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Le generazioni si elencano sempre per repository (storico, prune).
  (table) => [index("doc_generations_project_idx").on(table.repositoryId)],
);

/**
 * Coda di debounce per l'auto-aggiornamento docs ai push. Un solo job pending
 * per progetto (unique su `project_id`): il webhook fa upsert accumulando i
 * push ravvicinati invece di accodarne uno per ciascuno. `fromSha` è il commit
 * fino a cui la documentazione è ferma (base del diff), `toSha` la head
 * dell'ultimo push accumulato; un nuovo push aggiorna solo `toSha`/`notBefore`
 * lasciando `fromSha` invariato. `notBefore` è l'istante prima del quale il
 * poller del worker non reclama il job (finestra di debounce): ogni push lo
 * sposta in avanti, così il lavoro parte solo quando i push si fermano.
 */
export const docAutoUpdateJobs = pgTable(
  "doc_auto_update_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Commit da cui calcolare il diff: la documentazione è ferma qui.
    fromSha: text("from_sha").notNull(),
    // Head dell'ultimo push accumulato: la documentazione va portata fin qui.
    toSha: text("to_sha").notNull(),
    // Il poller del worker reclama il job solo quando questo istante è scaduto.
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Un solo job pending per repository: il webhook fa upsert su questo vincolo.
  (table) => [uniqueIndex("doc_auto_update_jobs_project_unique").on(table.repositoryId)],
);

export const prReviewStatus = pgEnum("pr_review_status", ["running", "completed", "failed"]);
export const prReviewVerdict = pgEnum("pr_review_verdict", ["approve", "request_changes"]);

/**
 * Coda di debounce dell'automazione PR Review (pattern doc_auto_update_jobs):
 * un solo job pending per (repository, PR). Il webhook fa upsert ad ogni
 * opened/synchronize aggiornando head e finestra; il poller del worker reclama
 * con DELETE...RETURNING quando `not_before` è scaduto. I metadati della PR
 * (titolo, corpo, branch) viaggiano nel job così il worker non deve richiamare
 * l'API del provider per costruire il prompt.
 */
export const prReviewJobs = pgTable(
  "pr_review_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    prTitle: text("pr_title").notNull(),
    prBody: text("pr_body").notNull().default(""),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    headSha: text("head_sha").notNull(),
    // Il poller reclama il job solo quando questo istante è scaduto (debounce).
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Un solo pending per (repo, PR): il webhook fa upsert su questo vincolo.
    uniqueIndex("pr_review_jobs_repository_pr_unique").on(table.repositoryId, table.prNumber),
  ],
);

/**
 * Storico delle review eseguite: una riga per run. `ticketId` punta al ticket
 * di Stubwise che ospita l'analisi (quello esistente per le PR aperte dal fix,
 * o il ticket di tipo `review` creato per le PR esterne); set null se il ticket
 * viene eliminato (lo storico sopravvive). `lastActivityAt` è l'heartbeat per
 * il recovery delle righe `running` orfane (riavvio del worker a metà review).
 */
export const prReviews = pgTable(
  "pr_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    prTitle: text("pr_title").notNull(),
    headSha: text("head_sha").notNull(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    status: prReviewStatus("status").notNull().default("running"),
    verdict: prReviewVerdict("verdict"),
    // Analisi in markdown prodotta dall'agente (null finché running/failed).
    summary: text("summary"),
    error: text("error"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // Lookup del ticket riusabile per le re-review della stessa PR.
    index("pr_reviews_repository_pr_idx").on(table.repositoryId, table.prNumber),
  ],
);

/**
 * Una pagina di documentazione: nodo dell'albero (technical/functional/manual).
 * Le pagine autogenerate appartengono a una `generationId` e vengono sostituite
 * a ogni rigenerazione; le pagine `isManual` hanno `generationId` null e
 * sopravvivono alle rigenerazioni (curate a mano). `parentId` modella la
 * gerarchia (soft, niente FK self per ordine in migrazione); `searchTsv` è il
 * vettore full-text generato da titolo+corpo.
 *
 * UNICITÀ slug: gli slug autogenerati sono DETERMINISTICI (`overview`,
 * `capabilities`, baseSlug del modulo) e si ripetono identici a ogni
 * rigenerazione. Un'unicità (project_id, slug) collidereberbe alla 2ª
 * generazione (le pagine della precedente coesistono fino al prune). Quindi:
 *  - pagine AUTOGENERATE: unique (generation_id, slug) — ogni generazione porta
 *    i suoi slug, generazioni diverse possono condividerli;
 *  - pagine MANUALI (generation_id null): unique parziale (project_id, slug)
 *    WHERE generation_id IS NULL — restano uniche per progetto.
 */
export const docPages = pgTable(
  "doc_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Generazione di appartenenza; null per le pagine manuali (non rigenerate).
    // Cascata: una generazione rimossa porta via le sue pagine autogenerate.
    generationId: uuid("generation_id").references(() => docGenerations.id, {
      onDelete: "cascade",
    }),
    kind: docPageKind("kind").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    // Genitore nell'albero; soft (niente FK self) per evitare ordini in migrazione.
    parentId: uuid("parent_id"),
    position: integer("position").notNull().default(0),
    // Path del sorgente documentato (modulo/file); null per overview/manuali.
    sourcePath: text("source_path"),
    body: text("body").notNull().default(""),
    // Cross-link risolti a fine generazione: [{type,slug,title}] raggruppabili
    // per type (implements/implemented_by/related). Null finché non calcolati.
    links: jsonb("links"),
    isManual: boolean("is_manual").notNull().default(false),
    // Autore della pagina manuale; null per le autogenerate o autore eliminato.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Vettore full-text generato (stored) da titolo + corpo: alimenta la ricerca
    // testuale via `@@ websearch_to_tsquery`. Sola lettura per l'applicazione.
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${docPages.title}, '') || ' ' || coalesce(${docPages.body}, ''))`,
    ),
  },
  (table) => [
    index("doc_pages_project_idx").on(table.repositoryId),
    index("doc_pages_generation_idx").on(table.generationId),
    // Slug univoco per generazione (pagine autogenerate): generazioni diverse
    // condividono gli stessi slug deterministici, ma una generazione non può
    // avere due pagine con lo stesso slug.
    uniqueIndex("doc_pages_generation_slug_unique").on(table.generationId, table.slug),
    // Slug univoco per repository SOLO tra le pagine manuali (generation_id null):
    // indice parziale, non collide con gli slug autogenerati.
    uniqueIndex("doc_pages_manual_slug_unique")
      .on(table.repositoryId, table.slug)
      .where(sql`generation_id IS NULL`),
    // Ricerca full-text sul vettore generato.
    index("doc_pages_search_tsv_idx").using("gin", table.searchTsv),
  ],
);

/**
 * Chunk di una pagina di documentazione con il suo embedding (pgvector, 1024
 * dim / bge-m3): alimenta la ricerca semantica e il retrieval della chat RAG.
 * `metadata` jsonb porta heading di provenienza e simili. L'indice HNSW
 * sull'embedding NON è generabile da drizzle: vive a mano nella migrazione.
 */
export const docChunks = pgTable(
  "doc_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => docPages.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Generazione di appartenenza; null per chunk di pagine manuali. Cascata.
    generationId: uuid("generation_id").references(() => docGenerations.id, {
      onDelete: "cascade",
    }),
    content: text("content").notNull(),
    embedding: vector(1024),
    metadata: jsonb("metadata"),
    tokenCount: integer("token_count"),
  },
  (table) => [
    // I chunk si filtrano sempre per repository nel retrieval (per-repo v1).
    index("doc_chunks_project_idx").on(table.repositoryId),
    // Il retrieval filtra per (repository, generazione corrente) prima
    // dell'ordinamento <=>: l'HNSW non può portare questa uguaglianza, serve
    // un btree dedicato.
    index("doc_chunks_project_generation_idx").on(table.repositoryId, table.generationId),
  ],
);

/**
 * Job di doc-generation (project-scoped): coda dedicata con claim/loop propri
 * (riusa i pattern di ai_jobs ma non li tocca, per preservare l'invariante
 * staleness). `lastActivityAt` è l'heartbeat per il recupero dei job orfani.
 * `generationId` collega il job alla generazione che produce (set null: il job
 * sopravvive alla rimozione della generazione).
 */
export const docGenerationJobs = pgTable(
  "doc_generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    generationId: uuid("generation_id").references(() => docGenerations.id, {
      onDelete: "set null",
    }),
    status: docJobStatus("status").notNull().default("queued"),
    trigger: docGenerationTrigger("trigger").notNull().default("manual"),
    log: text("log").notNull().default(""),
    error: text("error"),
    // Motivo dell'ultimo `held`: SOLO `limit` viene riaccodato automaticamente
    // dal resume poller; budget/gate restano decisioni umane. Null per gli
    // held storici (mai riaccodati: conservativo).
    heldReason: heldReason("held_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Heartbeat del worker: base del recupero dei job orfani (requeueStale).
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Claim del worker: il job in coda più vecchio (FOR UPDATE SKIP LOCKED,
    // ordinato per created_at). Indice parziale come ai_jobs: resta minuscolo
    // perché copre solo i job ancora in stato "queued".
    index("doc_generation_jobs_queued_created_at_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
    // Lookup dei job di un repository (storico, serializzazione per-repository).
    index("doc_generation_jobs_project_idx").on(table.repositoryId),
  ],
);

/**
 * Nodo del DAG di documentazione ricorsivo. Modella sia i rami (radici
 * technical/functional e nodi intermedi) sia le foglie del grafo durabile usato
 * dal motore: explore e synthesize sono job claimabili distinti che fanno
 * progredire lo `status`. `parentId` è una self-ref soft (radici = null, niente
 * FK per evitare ordini in migrazione); `pendingChildren` è il contatore del
 * join atomico (decrementato dai figli completati). `links` porta i cross-link
 * (implements/implemented_by/related) risolti a fine generazione.
 */
export const docNodes = pgTable(
  "doc_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => docGenerations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Genitore nel DAG; soft self-ref (radici = null), niente FK per ordine.
    parentId: uuid("parent_id"),
    tree: docTree("tree").notNull(),
    status: docNodeStatus("status").notNull().default("pending"),
    // Contatore del join atomico: figli ancora non completati.
    pendingChildren: integer("pending_children").notNull().default(0),
    depth: integer("depth").notNull().default(0),
    position: integer("position").notNull().default(0),
    // Riferimento all'unità documentata: path (tecnico) o nome capability.
    unitRef: text("unit_ref"),
    title: text("title").notNull().default(""),
    slug: text("slug").notNull().default(""),
    sourcePaths: jsonb("source_paths").notNull().default([]),
    body: text("body").notNull().default(""),
    // Cross-link risolti a fine generazione: [{type,slug,title}]. Null finché non calcolati.
    links: jsonb("links"),
    error: text("error"),
    cost: numeric("cost", { precision: 12, scale: 6 }),
    // Heartbeat del nodo: base del recupero dei nodi orfani (requeueStaleNodes).
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // I nodi si elencano e finalizzano sempre per generazione.
    index("doc_nodes_generation_idx").on(table.generationId),
    // Join atomico: lookup dei figli di un padre.
    index("doc_nodes_parent_idx").on(table.parentId),
    // Claim del worker: nodi processabili (pending/ready_to_synthesize),
    // oldest-first (FOR UPDATE SKIP LOCKED su status, ordinato per created_at).
    index("doc_nodes_claimable_idx").on(table.status, table.createdAt),
  ],
);

/**
 * Sessione di chat RAG sulla documentazione, di un utente. Raggruppa i messaggi.
 *
 * Scope a DUE livelli (Fase 2 multi-repo): una sessione è *o* repository-level
 * (`repository_id` valorizzato, `project_id` NULL) *o* project-level
 * (`project_id` valorizzato, `repository_id` NULL) — la chat di progetto recupera
 * cross-repo dai repo del gruppo. Il CHECK `doc_chat_sessions_scope_chk` impone
 * l'XOR (esattamente uno dei due valorizzato). Le righe pre-Fase 2 sono tutte
 * repo-level e lo soddisfano già. Cascata col repository/progetto e con l'utente.
 */
export const docChatSessions = pgTable(
  "doc_chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: valorizzato per le sessioni repo-level, NULL per quelle di progetto.
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    // Nullable: valorizzato per le sessioni project-level, NULL per quelle repo-level.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Le sessioni repo-level si elencano per repository.
    index("doc_chat_sessions_project_idx").on(table.repositoryId),
    // Le sessioni project-level si elencano per progetto.
    index("doc_chat_sessions_project_id_idx").on(table.projectId),
    // XOR: esattamente uno tra repository_id e project_id valorizzato.
    check(
      "doc_chat_sessions_scope_chk",
      sql`("repository_id" IS NOT NULL) <> ("project_id" IS NOT NULL)`,
    ),
  ],
);

/**
 * Messaggio di una sessione di chat RAG: `role` "user" | "assistant",
 * `citations` jsonb porta i riferimenti ai chunk/pagine usati nella risposta.
 * Cascata con la sessione.
 */
export const docChatMessages = pgTable(
  "doc_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => docChatSessions.id, { onDelete: "cascade" }),
    // "user" | "assistant": registro libero (non enum) per estensibilità futura.
    role: text("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // I messaggi si caricano sempre per sessione, in ordine cronologico.
  (table) => [index("doc_chat_messages_session_idx").on(table.sessionId)],
);

/**
 * Cronologia UNIFICATA di ricerca (spotlight globale Cmd/K): i risultati
 * cliccati da un utente, poliformi (ticket/progetto/repository/pagina doc),
 * denormalizzati (title/subtitle/route) per il render diretto senza join. Una
 * riga per (utente, tipo, entityId): l'upsert aggiorna `clickedAt` e i campi
 * denormalizzati a ogni click; oltre le N più recenti per utente si potano.
 * `repositoryId` è valorizzato per le voci Docs (filtra i recenti in scope
 * "questa documentazione"), null per gli altri tipi. Generalizza la vecchia
 * la vecchia `doc_search_history` (migrazione 0036, dati Docs preservati come type='doc').
 * Cascata con l'utente; il repository eliminato azzera `repositoryId` (set null).
 */
export const searchHistory = pgTable(
  "search_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: searchEntity("type").notNull(),
    // Id dell'entità nel suo dominio: id del ticket/progetto/repo, oppure
    // `repositoryId:slug` per una pagina doc (una doc è identificata da repo+slug).
    entityId: text("entity_id").notNull(),
    title: text("title").notNull(),
    // Contesto secondario denormalizzato: progetto del ticket, kind della pagina,
    // ecc. Null quando non applicabile.
    subtitle: text("subtitle"),
    // Route verso cui navigare al click sul recente (già risolta lato client).
    route: text("route").notNull(),
    // Repository d'appartenenza per le voci Docs (filtro in scope); null per
    // ticket/progetti/repository. Set null se il repository viene eliminato.
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Una sola voce per (utente, tipo, entità): target dell'upsert.
    uniqueIndex("search_history_user_type_entity_unique").on(
      table.userId,
      table.type,
      table.entityId,
    ),
    // Cronologia recente globale di un utente: i click più nuovi prima.
    index("search_history_recent_idx").on(table.userId, table.clickedAt.desc()),
    // Cronologia recente in scope Docs (per repository): i click più nuovi prima.
    index("search_history_repo_recent_idx").on(
      table.userId,
      table.repositoryId,
      table.clickedAt.desc(),
    ),
  ],
);

/**
 * Widget di assistenza embeddabile: N per progetto (molti a uno), ciascuno con
 * la propria `key` univoca (identifica il widget nella superficie pubblica e
 * negli snippet di embed). Governa aspetto e comportamento del widget sul sito
 * del cliente: `enabled` accende la superficie pubblica, `enabled_repository_ids`
 * restringe il retrieval RAG ai soli repo scelti (jsonb array di uuid; vuoto =
 * chat disabilitata, nessun repo esposto); gli altri campi sono presentazione
 * (titolo, messaggio di benvenuto, colore accento, lingua). `daily_message_cap`
 * e `daily_ticket_cap` (null = vale il default d'istanza dalle env
 * WIDGET_DAILY_MESSAGE_CAP/WIDGET_DAILY_TICKET_CAP) mettono un tetto giornaliero
 * per-widget. Cascata col progetto.
 */
export const widgets = pgTable(
  "widgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull().unique(),
    enabled: boolean("enabled").notNull().default(false),
    enabledRepositoryIds: jsonb("enabled_repository_ids").$type<string[]>().notNull().default([]),
    title: text("title").notNull().default("Assistenza"),
    welcomeMessage: text("welcome_message").notNull().default("Ciao! Come posso aiutarti?"),
    accentColor: text("accent_color").notNull().default("#22c55e"),
    language: text("language").notNull().default("it"),
    dailyMessageCap: integer("daily_message_cap"),
    dailyTicketCap: integer("daily_ticket_cap"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Elenco dei widget di un progetto.
  (t) => [index("widgets_project_idx").on(t.projectId)],
);

/**
 * Conversazione di un utente esterno (visitatore del sito ospite) col widget di
 * un progetto. L'identità è *dichiarata* dal sito ospite, non autenticata:
 * `external_user_id` è obbligatorio, email/nome opzionali. `last_message_at`
 * ordina l'elenco delle conversazioni (lato viewer interno). Cascata col progetto.
 */
export const widgetConversations = pgTable(
  "widget_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    externalUserEmail: text("external_user_email"),
    externalUserName: text("external_user_name"),
    // Widget da cui è nata la conversazione. SET NULL alla cancellazione del
    // widget: lo storico resta consultabile come "widget eliminato".
    widgetId: uuid("widget_id").references(() => widgets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Elenco delle conversazioni di un progetto, le più recenti prima.
  (table) => [index("widget_conversations_project_idx").on(table.projectId, table.lastMessageAt)],
);

/**
 * Messaggio di una conversazione widget: `role` "user" | "assistant",
 * `citations` jsonb porta i riferimenti ai chunk/pagine Docs usati nella
 * risposta RAG, `ticket_id` (opzionale) collega il messaggio al ticket
 * eventualmente creato dalla conversazione (set null se il ticket viene
 * eliminato). Cascata con la conversazione.
 */
export const widgetMessages = pgTable(
  "widget_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => widgetConversations.id, { onDelete: "cascade" }),
    // "user" | "assistant": registro libero (non enum) per estensibilità futura.
    role: text("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // I messaggi si caricano sempre per conversazione, in ordine cronologico.
  (table) => [index("widget_messages_conversation_idx").on(table.conversationId)],
);
