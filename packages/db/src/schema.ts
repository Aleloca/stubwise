import {
  type AgentQuestionAnswer,
  type AlertThresholds,
  type BacklogJobPayload,
  type BacklogSuggested,
  type DiscoveredService,
  type PluginInventory,
  aiJobStatusSchema,
  aiProviderKindSchema,
  backlogCodeSessionStatusSchema,
  backlogItemSourceSchema,
  backlogItemStatusSchema,
  backlogJobKindSchema,
  backlogJobStatusSchema,
  backlogMessageRoleSchema,
  backlogRiskSchema,
  backlogTicketRoleSchema,
  checkStatusSchema,
  checkTypeSchema,
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
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
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
 *
 * REGOLA per scegliere dove nasce un enum: **se i suoi valori compaiono in una
 * forma pubblica** (risposta API, notifica, payload letto dalla SPA o dall'app
 * mobile) lo schema Zod va in `@stubwise/shared` e il pgEnum ne deriva con
 * questo helper; se invece resta interno al database, la lista letterale sta
 * qui. Ogni enum dichiara nel proprio commento da quale delle due parti viene.
 *
 * Oggi il file è misto, ed è normale: la conversione è graduale. Alcuni enum
 * letterali RISALGONO già verso Zod nelle rotte (`z.enum(x.enumValues)` in
 * `tickets.ts` e `milestones.ts`) — sono quelli che stanno per capovolgersi:
 * `ticketEventKind`, `commentAuthorType`, `ticketLinkKind` e `milestoneStatus`
 * entreranno in shared quando l'app mobile leggerà la timeline di un ticket.
 *
 * In nessuno dei due versi questo helper fa esistere il tipo in Postgres: è
 * sempre una migrazione scritta a mano a crearlo o ad aggiungerci un valore
 * (`enum-parity.test.ts` verifica che le due cose combacino).
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
export const backlogItemStatus = pgEnum("backlog_item_status", enumValues(backlogItemStatusSchema));
export const backlogRisk = pgEnum("backlog_risk", enumValues(backlogRiskSchema));
export const backlogItemSource = pgEnum("backlog_item_source", enumValues(backlogItemSourceSchema));
export const backlogJobKind = pgEnum("backlog_job_kind", enumValues(backlogJobKindSchema));
export const backlogJobStatus = pgEnum("backlog_job_status", enumValues(backlogJobStatusSchema));
export const backlogCodeSessionStatus = pgEnum(
  "backlog_code_session_status",
  enumValues(backlogCodeSessionStatusSchema),
);
// Ruolo del legame voce↔ticket: i valori derivano da `backlogTicketRoleSchema`
// (shared = unica fonte di verità), perché entrano nella forma pubblica del
// dettaglio di una voce.
export const backlogTicketRole = pgEnum("backlog_ticket_role", enumValues(backlogTicketRoleSchema));
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
// Stato del job AI: i valori derivano da `aiJobStatusSchema` (shared = unica
// fonte di verità), dove vive anche il commento su ciascuno stato. Sta in
// shared perché è la forma pubblica dei job, letta anche dai client.
export const aiJobStatus = pgEnum("ai_job_status", enumValues(aiJobStatusSchema));
// Le fasi AI di cui tracciamo i consumi (token + costo): triage, fix, review e
// — dalla fase 6 — la classificazione dei segnali di una email
// (`email_classify`). L'ordine è quello di `enumsortorder` in Postgres: i valori
// nuovi si aggiungono in CODA, perché `ALTER TYPE ... ADD VALUE` li appende
// (vedi `enum-parity.test.ts`, che verifica anche l'ordine).
export const agentRunPhase = pgEnum("agent_run_phase", [
  "triage",
  "fix",
  "review",
  "email_classify",
]);

// Motivo per cui un job è parcheggiato in "held": i valori derivano da
// `heldReasonSchema` (shared = unica fonte di verità). Solo "limit" (limite di
// utilizzo del provider) è auto-ripristinabile dal resume poller.
export const heldReason = pgEnum("held_reason", enumValues(heldReasonSchema));

// Modalità di ripresa di un job rimesso in coda da un intervento umano:
//  null           → job normale: triage → (gate) → fix;
//  "fix"          → salta il triage, va al fix (può ri-fermarsi sul gate del piano);
//  "execute"      → salta triage E pianificazione, esegue usando plan_text;
//  "plan_continue"→ salta il triage e CONTINUA la pianificazione dalla risposta
//                   umana a una domanda dell'agente (riprende la sessione CLI).
export const resumeMode = pgEnum("resume_mode", ["fix", "execute", "plan_continue"]);

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
// worker prepara l'ambiente per il CLI.
// I valori derivano da `aiProviderKindSchema` (shared = unica fonte di verità):
// il tipo di credenziale entra nella forma pubblica di un job AI.
export const aiProviderKind = pgEnum("ai_provider_kind", enumValues(aiProviderKindSchema));
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

// Stato di un report di attività giornaliero: "queued" (creato dal gate
// notturno, in attesa del worker), "running" (l'agente sta riassumendo),
// "done" (completato) o "failed" (errore, con `error` valorizzato).
export const activityReportStatus = pgEnum("activity_report_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

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
  // Username Bitbucket linkato al membro (speculare a slackUserId): un solo
  // membro per username, nullable (l'unique ignora i NULL in Postgres).
  bitbucketUsername: text("bitbucket_username").unique(),
  // Preferenza di recapito: se true le notifiche destinate a questo utente
  // vengono anche inviate come DM Slack (oltre a comparire nella sua inbox).
  // Default true; senza `slackUserId` il canale resta comunque muto.
  notifySlackDm: boolean("notify_slack_dm").notNull().default(true),
  // Preferenza di recapito speculare a `notifySlackDm`, per le push sui device
  // mobili (fase 4). Default true; senza device attivi in `device_tokens` il
  // canale resta comunque muto.
  notifyPush: boolean("notify_push").notNull().default(true),
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
 * Personal Access Token: autentica l'API di Stubwise senza cookie di sessione
 * (es. Claude Code / MCP). Il token in chiaro `stw_pat_…` è mostrato una sola
 * volta alla creazione e NON viene mai persistito: qui si salva soltanto il suo
 * sha256 (hex), usato per il confronto ad ogni richiesta.
 */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Lookup dei token di un utente (lista/revoca in UI) + pulizia in cascata.
  (table) => [index("personal_access_tokens_user_id_idx").on(table.userId)],
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
export const projects = pgTable(
  "projects",
  {
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
    // Se true, il poller notturno genera lo standup giornaliero per questo
    // progetto. Default false: opt-in esplicito per non generare report (e
    // consumare run dell'agente) su progetti non interessati.
    dailyReportEnabled: boolean("daily_report_enabled").notNull().default(false),
    // Se true, i ticket feedback/feature del progetto vengono deviati verso il
    // backlog di discovery (voci dedup + raffinamento AI) invece di finire
    // direttamente nella pipeline di fix. Default false: opt-in esplicito.
    backlogEnabled: boolean("backlog_enabled").notNull().default(false),
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
    // Pulse proattivo (Fase 2): quando il progetto è fermo, un poller propone
    // 2–3 voci del backlog da cui ripartire. Default false: opt-in esplicito,
    // al deploy nessun progetto riceve il pulse.
    pulseEnabled: boolean("pulse_enabled").notNull().default(false),
    // Cadenza minima fra due pulse dello stesso progetto, in giorni (1..30).
    pulseEveryDays: integer("pulse_every_days").notNull().default(3),
    // Istante dell'ultimo pulse inviato; null = mai. È il gate di idempotenza:
    // il poller lo aggiorna con UPDATE condizionato sul valore letto, nella
    // stessa transazione in cui pubblica la notifica, così due tick concorrenti
    // non mandano due volte lo stesso ping.
    pulseLastSentAt: timestamp("pulse_last_sent_at", { withTimezone: true }),
    // Brief settimanale (Fase 5): un resoconto per non-tecnici, generato dal
    // poller una volta a settimana. Default false, opt-in esplicito. NON
    // dipende dal backlog (a differenza del pulse): un progetto ha sempre
    // qualcosa da raccontare, anche senza voci da proporre.
    weeklyBriefEnabled: boolean("weekly_brief_enabled").notNull().default(false),
  },
  () => [
    // Sotto 1 giorno il pulse diventerebbe un ping continuo, sopra 30 un
    // promemoria che non arriva mai.
    check("projects_pulse_every_days_chk", sql`pulse_every_days BETWEEN 1 AND 30`),
  ],
);

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
  // Integrazione graphify: attiva la costruzione del knowledge graph del codice
  // per questo repository (build al push + tab "Grafo" nella sezione Docs).
  // Default false: nessun repository esistente cambia comportamento al deploy.
  graphEnabled: boolean("graph_enabled").notNull().default(false),
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
    // NULLABLE dalla fase 5: una milestone appartiene al PROGETTO, il repo è un
    // dettaglio d'origine che la UI non ha mai chiesto (ed è per questo che la
    // creazione dalla web app era rotta). Le righe storiche restano valorizzate.
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    // Descrizione libera della milestone: null = nessuna.
    description: text("description"),
    // Scadenza opzionale della milestone: null = nessuna data.
    dueDate: timestamp("due_date", { withTimezone: true }),
    status: milestoneStatus("status").notNull().default("open"),
    // Quando la milestone è stata chiusa; null se aperta (riaprirla lo azzera).
    // `status` dice CHE è chiusa, questo QUANDO: senza data la timeline di
    // progetto non saprebbe dove collocare l'evento.
    closedAt: timestamp("closed_at", { withTimezone: true }),
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
    // Piano di implementazione dedicato (null finché non prodotto) e corpo
    // originale preservato quando un design doc ne sostituisce il corpo. Il
    // corpo principale resta `body`. Entrambe additive/nullable.
    implementationPlan: text("implementation_plan"),
    originContent: text("origin_content"),
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
    // Pre-approvazione del piano (fase 7): un maintainer può approvare in
    // anticipo il piano CORRENTE di un ticket, così un operatore (member) può
    // far partire il fix senza fermarsi sul gate. `planApprovedDigest` è lo
    // SHA-256 del testo del piano al momento dell'approvazione (planDigest,
    // packages/db/src/plan-digest.ts): il gate confronta il digest con quello
    // del piano ATTUALE, non si fida solo di `planApprovedAt`. L'approvazione
    // DECADE DA SOLA a ogni riscrittura del piano (MCP set_plan, PUT /plan,
    // riscrittura del worker) perché il digest smette di combaciare — più
    // robusto che azzerare il campo a ogni scrittura, perché non dipende dal
    // ricordarsi di farlo in ogni percorso che tocca il piano.
    planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
    // ON DELETE SET NULL: l'approvazione (e il suo digest) restano leggibili
    // anche se il maintainer che l'ha data viene eliminato.
    planApprovedByUserId: uuid("plan_approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    planApprovedDigest: text("plan_approved_digest"),
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
    /**
     * Fase 8, Task 6: l'esito del test INTERNO (quello che la pipeline di fix
     * esegue nel proprio container prima di aprire la PR) — prima solo testo
     * nel log del job, ora un dato interrogabile per la coda di rilascio.
     * `null` = riga scritta prima di questa fase (storica, nessun dato) O un
     * fix senza self-repair/test risolvibile che non ha mai girato nulla
     * PRIMA di questa fase. Il writer (fix.ts) scrive solo 'passed'/'skipped'
     * — non apre mai una PR su un test rosso — ma il CHECK ammette anche
     * 'failed' per non restringere un domani in cui una riga viene
     * riverificata dopo l'apertura.
     */
    testStatus: text("test_status").$type<"passed" | "failed" | "skipped">(),
    /**
     * Fase 8, Task 7: il rischio del FIX che ha aperto questa PR — una
     * REGOLA (`apps/worker/src/pipeline/release-risk.ts`), mai un giudizio
     * del modello (CLAUDE.md, l'invariante del registro decisioni). Scritto
     * una volta all'apertura, insieme a `riskReason` (la spiegazione in una
     * riga che la UI mostra verbatim). `null` = riga storica, prima di
     * questa fase.
     */
    risk: text("risk").$type<"low" | "medium" | "high">(),
    riskReason: text("risk_reason"),
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
    check(
      "ticket_repositories_test_status_chk",
      sql`test_status is null or test_status in ('passed', 'failed', 'skipped')`,
    ),
    check("ticket_repositories_risk_chk", sql`risk is null or risk in ('low', 'medium', 'high')`),
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
  (table) => [index("ticket_events_ticket_id_created_at_idx").on(table.ticketId, table.createdAt)],
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
    // Riassunto "in breve" del piano per non-tecnici (fase 5). Vive e muore con
    // `plan_text`: lo scrive lo STESSO UPDATE guardato che parcheggia il job
    // sul gate, e il rifiuto del piano azzera entrambi. Null = riassunto non
    // generato (run fallito o riassunti spenti); il gate funziona lo stesso.
    planSummary: text("plan_summary"),
    // Sessione del claude CLI dell'ultimo run di pianificazione, salvata al
    // parcheggio in awaiting_input per riprenderla con `--resume` quando la
    // domanda riceve risposta. Null quando non c'è nulla da riprendere (run mai
    // fermato su una domanda, oppure sessione non estratta: si ripianifica da
    // zero col blocco delle decisioni già prese).
    cliSessionId: text("cli_session_id"),
    // Provider AI con cui il job è stato (o sarà) eseguito. Nullable: i job
    // pre-esistenti alla feature provider non lo hanno, e un job può essere in
    // coda prima che il worker scelga la credenziale. ON DELETE SET NULL: il job
    // sopravvive all'eliminazione del provider (lo storico resta consultabile).
    providerId: uuid("provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
    // Operatore che ha lanciato il job dalla UI. Null per i job nati
    // automaticamente dall'ingest (nessun umano dietro). ON DELETE SET NULL: lo
    // storico del job sopravvive all'eliminazione dell'utente.
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Il job deve fermarsi sul gate del piano prima di eseguire. Acceso per i
    // job richiesti dagli operatori (`role='member'`), che non possono far
    // partire un fix senza che il piano sia approvato. Default false: i job
    // esistenti e quelli automatici mantengono il comportamento di oggi.
    planApprovalRequired: boolean("plan_approval_required").notNull().default(false),
    // Riassunto in italiano/inglese del perché il job è fallito (fase 7):
    // cosa si stava facendo, cosa non ha funzionato, cosa si può fare adesso —
    // e se serve un maintainer. Generato best-effort quando il job entra in
    // `failed` (stessa forma di `planSummary`/`prSummary`, ma FUORI dalla
    // transazione che scrive lo stato: un riassunto fallito non deve mai far
    // fallire la registrazione del fallimento stesso). Null = non generato
    // (run non fallito, generazione fallita o riassunti spenti): la card
    // degrada al log tecnico come prima di questa fase.
    failureSummary: text("failure_summary"),
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
    // Messaggio di posta classificato (fase 6); null per tutti gli altri run.
    // TERZO owner possibile, così la classificazione dei segnali email compare
    // in Usage col metro dei fix invece di essere un costo invisibile.
    //
    // CASCADE come gli altri due, e non SET NULL: il check qui sotto vuole
    // esattamente un owner valorizzato, quindi un run svuotato lo violerebbe e
    // la retention dei messaggi non riuscirebbe più a cancellarne nessuno.
    emailMessageId: uuid("email_message_id").references((): AnyPgColumn => emailMessages.id, {
      onDelete: "cascade",
    }),
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
    // Aggregazione del costo per messaggio + cascade delete da email_messages.
    index("agent_runs_email_message_id_idx").on(table.emailMessageId),
    // Esattamente uno tra job_id, pr_review_id ed email_message_id valorizzato
    // (vedi commenti sulle colonne): l'invariante è garantita dal DB, non solo
    // dal codice.
    check(
      "agent_runs_owner_check",
      sql`num_nonnulls(job_id, pr_review_id, email_message_id) = 1`,
    ),
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

// Tipo di evento dietro una notifica dell'inbox. Speculare ai `kind` di
// `NotificationEvent` (@stubwise/notifications/pure): la lista è ripetuta qui
// come letterale perché `db` NON può importare da `notifications` (è
// `notifications` a dipendere da `db`; l'inverso sarebbe un ciclo).
// Aggiungere un kind richiede `ALTER TYPE ... ADD VALUE` in una migrazione che
// NON usa il valore nuovo nello stesso batch: il migratore esegue tutte le
// migrazioni pendenti in UNA transazione e Postgres rifiuta l'uso di un valore
// enum aggiunto nella stessa (vedi CLAUDE.md, "Trappola migrazioni drizzle").
export const notificationKind = pgEnum("notification_kind", [
  "ticket.created",
  "job.pr_opened",
  "job.pr_closed",
  "job.held",
  "job.plan_review",
  "job.budget_held",
  "review.completed",
  "job.failed",
  "docs.limit_paused",
  "monitor.alert",
  "monitor.recovered",
  // Fase 1: l'agente che pianifica un fix si è fermato con una domanda per un
  // umano (il job è parcheggiato in `awaiting_input`).
  "job.awaiting_input",
  // Fase 2: il pulse proattivo su un progetto fermo, con le proposte prese dal
  // backlog. Ancorato al PROGETTO: non ha né ticket né job dietro.
  "project.pulse",
  // Fase 5: il brief settimanale del progetto, scritto per non-tecnici.
  // Ancorato al PROGETTO come il pulse: né ticket né job dietro.
  "project.brief",
  // Fase 6: una proposta nata da una email o da un evento di calendario. Il
  // destinatario è UNO SOLO — il proprietario della casella (audience
  // `mailbox_owner`) — e nemmeno gli admin la vedono.
  "google.proposal",
]);

// Stato di una notifica nell'inbox del destinatario: `open` (da smaltire),
// `handled` (chiusa, a mano o perché l'evento è stato risolto) o `snoozed`
// (rinviata fino a `snoozedUntil`, poi torna a galla).
export const notificationStatus = pgEnum("notification_status", ["open", "handled", "snoozed"]);

// Canale di recapito di una consegna: `webhook` (il webhook d'istanza di
// notification_settings, per EVENTO), `slack_dm` (messaggio diretto al
// destinatario), `slack_update` (aggiornamento di un DM già inviato,
// identificato dal `ts` in `externalRef`) o `push` (notifica ai device mobili
// del destinatario, fase 4).
// Lista LETTERALE per scelta: questi valori non escono mai dall'API — vivono
// solo in `notification_deliveries`, che nessuna rotta serializza. Se un giorno
// lo stato di recapito comparisse in una risposta, la regola di `enumValues`
// qui sopra impone di far nascere lo schema Zod in `@stubwise/shared`.
export const deliveryChannel = pgEnum("delivery_channel", [
  "webhook",
  "slack_dm",
  "slack_update",
  "push",
]);

// Stato di una consegna in outbox: `pending` (da tentare, non prima di
// `nextAttemptAt`), `sent`, `failed` (tentativi esauriti, `error` valorizzato) o
// `skipped` (canale non applicabile, es. destinatario senza identità Slack).
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sent", "failed", "skipped"]);

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
  // Notifica alert/ripristino del monitoraggio server (unico toggle per entrambi
  // gli eventi monitor.alert e monitor.recovered).
  notifyMonitor: boolean("notify_monitor").notNull().default(true),
  // Notifica quando la pianificazione AI si ferma con una domanda per un umano
  // (`job.awaiting_input`).
  notifyAwaitingInput: boolean("notify_awaiting_input").notNull().default(true),
  // Notifica del pulse proattivo su un progetto fermo (`project.pulse`).
  notifyPulse: boolean("notify_pulse").notNull().default(true),
  // Notifica del brief settimanale di un progetto (`project.brief`).
  notifyBrief: boolean("notify_brief").notNull().default(true),
  // Notifica di una proposta nata dalla posta o dal calendario
  // (`google.proposal`).
  notifyGoogleProposal: boolean("notify_google_proposal").notNull().default(true),
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
  // Configurazione d'istanza dell'AMMISSIONE della posta (fase 6c), separata
  // dall'ATTRIBUZIONE (project_email_routes, fase 6, invariata). I default
  // sono un ALLARGAMENTO del perimetro di oggi, mai un restringimento: chi ha
  // già regole di progetto continua ad ammettere esattamente come prima.
  // I mittenti — o un SECONDO dominio di lavoro fra i destinatari, `to` o
  // `cc` indifferentemente (Task 2, fase 6c) — dei domini di un Google
  // Workspace registrato ammettono senza bisogno di una regola di progetto.
  emailAdmitWorkspaceDomains: boolean("email_admit_workspace_domains").notNull().default(true),
  // Etichette Gmail che escludono la posta ammessa per DOMINIO DI LAVORO
  // (colonna sopra): una regola di progetto è una scelta deliberata
  // dell'admin su un mittente preciso e ammette SEMPRE, esclusioni comprese
  // — vedi `admit()` in packages/notifications/src/email-routing.ts.
  emailAdmissionDenyLabels: text("email_admission_deny_labels")
    .array()
    .notNull()
    .default(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"]),
  // Scarta la posta automatica (List-Unsubscribe, List-Id, Precedence: bulk,
  // Auto-Submitted diverso da "no"). Default true: prima di questa fase il
  // poller non aveva alcuna difesa contro mailing list e notifiche automatiche.
  emailAdmissionDenyAutomated: boolean("email_admission_deny_automated").notNull().default(true),
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
    filters: jsonb("filters").notNull().$type<{
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
 * AMBIENTE di un progetto (fase 8): `test` | `staging` | `production`, con URL
 * facoltativo e collegamento facoltativo a un server già monitorato
 * (`servers.id`, SET NULL: scollegare/cancellare il server non cancella
 * l'ambiente, lo lascia solo senza il campione «cosa gira lì»).
 *
 * Ogni progetto riceve un ambiente `test` dalla migrazione 0074 (backfill):
 * non è opzionale, è la destinazione di ogni riga di `projectEnvFiles`
 * esistente prima di questa fase. Gli ambienti `staging`/`production` sono
 * opt-in, creati dal maintainer.
 *
 * **Stubwise non esegue né rilascia ambienti** (design §1/§6): questa riga è
 * solo un'ANAGRAFICA — nome, tipo, dove sta, cosa ci gira (letto
 * dall'agente di monitoraggio via `serverId`, fase 8 §3). L'unico ambiente
 * che la pipeline di fix può mai leggere è `test`, e non per questa tabella
 * ma per il controllo in `apps/worker/src/pipeline/env-files.ts`
 * (`loadProjectEnvFiles`, invariante della fase).
 */
export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<"test" | "staging" | "production">().notNull(),
    url: text("url"),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Nome univoco per progetto (es. due "staging" nello stesso progetto non
    // avrebbero senso: quale dei due leggerebbe la pipeline?).
    uniqueIndex("project_environments_project_id_name_unique").on(table.projectId, table.name),
    check(
      "project_environments_kind_chk",
      sql`kind in ('test', 'staging', 'production')`,
    ),
  ],
);

/**
 * File d'ambiente configurato per un progetto (es. ".env", ".env.local"): un
 * percorso relativo nel worktree in cui il worker materializza le variabili
 * cifrate prima della fase di fix/verifica. `path` è il percorso relativo del
 * file. Cancellato in cascata col progetto.
 *
 * `environmentId` (fase 8): la chiave guadagna la dimensione AMBIENTE — non è
 * più "il .env del repository", è "il .env del repository IN QUELL'ambiente".
 * L'unique (repository, ambiente, path) vieta due file omonimi nello stesso
 * ambiente dello stesso repository, ma ammette lo stesso path in ambienti (o
 * repository) diversi — uno `staging/.env` e un `production/.env` con le
 * stesse chiavi e valori diversi sono il caso normale, non un conflitto.
 */
export const projectEnvFiles = pgTable(
  "project_env_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Percorso univoco per repository E ambiente.
    uniqueIndex("project_env_files_repository_environment_path_unique").on(
      table.repositoryId,
      table.environmentId,
      table.path,
    ),
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
    // PROJECT BRIEF del "documentarista": identità/attori/superfici/glossario/
    // invarianti/fatti riservati/journey/fonti (ProjectBrief di @stubwise/docs-engine).
    // Nullable: prodotto nel primo step dell'orientamento; se il run brief fallisce o
    // l'output non è parsabile resta null e la generazione prosegue senza brief. Tipo
    // libero (come `stats`): il db non dipende da docs-engine, il tipo vive lì.
    brief: jsonb("brief"),
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
    // Riassunto "in breve" della PR per non-tecnici (fase 5), scritto nella
    // stessa transazione di `verdict`/`summary`. Null = review scartata dal cap
    // di costo o run di sintesi fallito.
    prSummary: text("pr_summary"),
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
    // Contatore visualizzazioni (increment fire-and-forget all'apertura pagina).
    viewCount: integer("view_count").notNull().default(0),
    // Solo per kind="releases": true se la release è "significativa" (calcolata dal
    // worker via parseReleaseNotes). Null per le pagine non-release. Sostituisce il
    // prefisso "[minore]" nel titolo come segnale filtrabile.
    significant: boolean("significant"),
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
    /** Istruzioni aggiuntive dell'admin iniettate nel system prompt della chat; "" = nessuna. */
    instructions: text("instructions").notNull().default(""),
    accentColor: text("accent_color").notNull().default("#22c55e"),
    language: text("language").notNull().default("it"),
    dailyMessageCap: integer("daily_message_cap"),
    dailyTicketCap: integer("daily_ticket_cap"),
    // Raffinamento opzionale di `enabled_repository_ids`: per i repo che hanno
    // un'entry qui, la ricerca passa solo ciò che matcha `paths` (prefissi su
    // `sourcePath`), `slugs` o `kinds` (interi gruppi doc_page_kind, semantica
    // viva); fail-closed (entry con tutte e tre vuote = niente passa). Le chiavi
    // sono `repositoryId`. I repo senza entry restano interamente esposti.
    // `kinds` è OPZIONALE nel tipo: le righe già salvate NON lo hanno (nessuna
    // migrazione, jsonb) — il codice deve trattarne l'assenza come `[]`.
    repositoryFilters: jsonb("repository_filters")
      .$type<Record<string, { paths: string[]; slugs: string[]; kinds?: string[] }>>()
      .notNull()
      .default({}),
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

// ---------------------------------------------------------------------------
// Monitoraggio server (agente → metriche host + check di servizio)
// ---------------------------------------------------------------------------

export const checkType = pgEnum("check_type", enumValues(checkTypeSchema));
export const checkStatus = pgEnum("check_status", enumValues(checkStatusSchema));

/**
 * Un server monitorato. La chiave dell'agente (`sk_…`) non è persistita in
 * chiaro: si salva solo `key_hash` (sha256 hex), confrontato all'ingest. Non
 * c'è colonna `status`: lo stato online/offline si deriva da `last_seen_at` e
 * `sample_interval_seconds`. `active_alerts` è lo stato anti-spam degli alert.
 */
export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  hostname: text("hostname"),
  keyHash: text("key_hash").notNull().unique(), // sha256 hex della chiave sk_…
  sampleIntervalSeconds: integer("sample_interval_seconds").notNull().default(30),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  agentVersion: text("agent_version"),
  alertThresholds: jsonb("alert_thresholds")
    .$type<AlertThresholds>()
    .notNull()
    .default({ cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 }),
  // Stato anti-spam degli alert: chiavi "offline"|"cpu"|"mem"|"disk", valore
  // { since, notifiedAt } — evita ri-notifiche mentre l'allarme resta attivo.
  activeAlerts: jsonb("active_alerts")
    .$type<Record<string, { since: string; notifiedAt: string | null }>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Legame N:M server↔progetto: un server può essere condiviso tra più progetti,
 * un progetto può avere più server. Cascata da entrambi i lati.
 */
export const serverProjects = pgTable(
  "server_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un solo legame per (server, progetto).
    uniqueIndex("server_projects_server_id_project_id_unique").on(t.serverId, t.projectId),
    // I server di un progetto si leggono per progetto.
    index("server_projects_project_id_idx").on(t.projectId),
  ],
);

/**
 * Campione di metriche host a un istante `ts` (generato dall'agente, UTC). I
 * byte sono `bigint` in modalità `number` (JS number regge fino a 2^53).
 * `net_rx_bytes`/`net_tx_bytes` sono DELTA nell'intervallo, non contatori.
 * L'unique su (server_id, ts) rende l'ingest idempotente (upsert on conflict).
 */
export const serverMetrics = pgTable(
  "server_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    cpuPct: real("cpu_pct").notNull(),
    load1m: real("load_1m").notNull(),
    memUsedBytes: bigint("mem_used_bytes", { mode: "number" }).notNull(),
    memTotalBytes: bigint("mem_total_bytes", { mode: "number" }).notNull(),
    swapUsedBytes: bigint("swap_used_bytes", { mode: "number" }).notNull(),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }).notNull(),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
    netRxBytes: bigint("net_rx_bytes", { mode: "number" }).notNull(),
    netTxBytes: bigint("net_tx_bytes", { mode: "number" }).notNull(),
    disks: jsonb("disks")
      .$type<{ mount: string; usedBytes: number; totalBytes: number }[]>()
      .notNull()
      .default([]),
    services: jsonb("services").$type<DiscoveredService[]>().notNull().default([]),
  },
  (t) => [
    // Idempotenza dell'ingest: un solo campione per (server, ts).
    uniqueIndex("server_metrics_server_ts_unique").on(t.serverId, t.ts),
    // Rollup/retention filtrano per solo-ts (`ts < cutoff`, senza server_id):
    // l'unique composita (server_id, ts) non serve quei predicati → indice dedicato.
    index("server_metrics_ts_idx").on(t.ts),
  ],
);

/**
 * Rollup aggregato delle metriche host (bucket per `ts`): coppie avg/max delle
 * misure istantanee e somme dei delta di rete. Niente jsonb (né disks né
 * services): il rollup è solo numerico. Sostituisce i campioni grezzi in
 * retention lunga.
 */
export const serverMetricsRollup = pgTable(
  "server_metrics_rollup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    cpuPctAvg: real("cpu_pct_avg").notNull(),
    cpuPctMax: real("cpu_pct_max").notNull(),
    load1mAvg: real("load_1m_avg").notNull(),
    load1mMax: real("load_1m_max").notNull(),
    memUsedBytesAvg: bigint("mem_used_bytes_avg", { mode: "number" }).notNull(),
    memUsedBytesMax: bigint("mem_used_bytes_max", { mode: "number" }).notNull(),
    memTotalBytes: bigint("mem_total_bytes", { mode: "number" }).notNull(),
    diskUsedBytesAvg: bigint("disk_used_bytes_avg", { mode: "number" }).notNull(),
    diskUsedBytesMax: bigint("disk_used_bytes_max", { mode: "number" }).notNull(),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
    netRxBytesSum: bigint("net_rx_bytes_sum", { mode: "number" }).notNull(),
    netTxBytesSum: bigint("net_tx_bytes_sum", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("server_metrics_rollup_server_ts_unique").on(t.serverId, t.ts),
    // Retention per solo-ts (vedi server_metrics).
    index("server_metrics_rollup_ts_idx").on(t.ts),
  ],
);

/**
 * Check periodico di servizio (HTTP/TCP/process/DB) su un server. `target` è
 * l'URL/host:porta/pattern per http/tcp/process; per postgres/mysql resta vuoto
 * e il DSN cifrato vive in `dsn_encrypted`. I campi `last_*` e `down_*` tengono
 * lo stato corrente e la finestra di down per l'anti-spam delle notifiche.
 */
export const serviceChecks = pgTable(
  "service_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    type: checkType("type").notNull(),
    name: text("name").notNull(),
    // http/tcp/process; per postgres/mysql resta "" (il DSN sta in dsn_encrypted).
    target: text("target").notNull().default(""),
    dsnEncrypted: text("dsn_encrypted"),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    lastStatus: checkStatus("last_status").notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastLatencyMs: integer("last_latency_ms"),
    lastError: text("last_error"),
    downSince: timestamp("down_since", { withTimezone: true }),
    downNotifiedAt: timestamp("down_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("service_checks_server_id_idx").on(t.serverId)],
);

/**
 * Esito di un check a un istante `ts`. `metrics` porta le metriche specifiche
 * del check (connessioni DB, cpu/mem del processo…), null quando non ne produce.
 * Unique su (check_id, ts) per l'idempotenza dell'ingest.
 */
export const checkSamples = pgTable(
  "check_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => serviceChecks.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    status: checkStatus("status").notNull(),
    latencyMs: integer("latency_ms"),
    metrics: jsonb("metrics").$type<Record<string, number>>(),
  },
  (t) => [
    uniqueIndex("check_samples_check_ts_unique").on(t.checkId, t.ts),
    // Retention per solo-ts (vedi server_metrics).
    index("check_samples_ts_idx").on(t.ts),
  ],
);

/**
 * Rollup aggregato degli esiti di un check (bucket per `ts`): conteggi up/down
 * e statistiche di latenza. Sostituisce i sample grezzi in retention lunga.
 */
export const checkSamplesRollup = pgTable(
  "check_samples_rollup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => serviceChecks.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    upCount: integer("up_count").notNull(),
    downCount: integer("down_count").notNull(),
    latencyMsAvg: real("latency_ms_avg"),
    latencyMsMax: integer("latency_ms_max"),
  },
  (t) => [
    uniqueIndex("check_samples_rollup_check_ts_unique").on(t.checkId, t.ts),
    // Retention per solo-ts (vedi server_metrics).
    index("check_samples_rollup_ts_idx").on(t.ts),
  ],
);

/**
 * Alias email git → membro. Un membro può committare con più email (lavoro,
 * personale, noreply del provider): relazione 1 membro : N email. Distinta da
 * users.slackUserId (colonna singola) proprio per questo. L'email è memorizzata
 * lowercase; l'unique impedisce che la stessa email sia linkata a due membri.
 */
export const gitIdentities = pgTable(
  "git_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    authorName: text("author_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("git_identities_user_id_idx").on(table.userId)],
);

/**
 * Autori git realmente osservati nei repo (auto-raccolti dal poller), per
 * alimentare il picker di link in /team (analogo a slack workspace-users). La
 * risoluzione a membro passa da git_identities, non serve un userId qui.
 */
export const gitAuthorsSeen = pgTable("git_authors_seen", {
  email: text("email").primaryKey(),
  authorName: text("author_name"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Un report di attività per (progetto, giorno UTC). L'unique (project_id, date)
 * rende idempotente il gate notturno: più tick concorrenti non creano doppioni.
 * NB: il poller crea la riga direttamente in `running` (gate + generazione in un
 * colpo solo); `queued` resta il default della colonna ma non è prodotto dal
 * flusso attuale (riservato a un eventuale futuro gate a due fasi).
 */
export const activityReports = pgTable(
  "activity_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    status: activityReportStatus("status").notNull().default("queued"),
    error: text("error"),
    // Riassunto narrativo del progetto per la giornata (markdown), generato
    // aggregando le descrizioni per-commit. Null se non ancora generato o se il
    // run di sintesi è fallito.
    summary: text("summary"),
    // Commit con committer-date di questo giorno presenti nel repo ma ASSENTI dal
    // report (pushati dopo la generazione). Aggiornato dalla fase di recount;
    // azzerato alla (ri)generazione. > 0 → il report è potenzialmente incompleto.
    staleCommitCount: integer("stale_commit_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("activity_reports_project_date_unique").on(table.projectId, table.date)],
);

/** Una riga per commit (non-merge) del giorno, con la descrizione AI dal suo
 * diff. Le viste (per progetto / per persona) sono raggruppamenti di queste
 * righe: repoId e authorEmail sono campi del commit. */
export const activityCommits = pgTable(
  "activity_commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => activityReports.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    authorEmail: text("author_email").notNull(),
    authorName: text("author_name"),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    subject: text("subject").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    // Descrizione tecnica generata dal diff del commit (markdown). Null se il
    // run dell'agente è fallito: la UI mostra il subject come fallback.
    aiDescription: text("ai_description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_commits_report_repo_sha_unique").on(
      table.reportId,
      table.repoId,
      table.sha,
    ),
    index("activity_commits_report_id_idx").on(table.reportId),
    index("activity_commits_author_email_idx").on(table.authorEmail),
  ],
);

/**
 * Riassunto narrativo per SVILUPPATORE per un giorno, aggregando le descrizioni
 * dei suoi commit su tutti i progetti. Il gruppo è un membro risolto (`userId`)
 * oppure, per un autore git non associato, la sua email (`gitEmail`). Esattamente
 * uno dei due è valorizzato.
 */
export const activityDevSummaries = pgTable(
  "activity_dev_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    gitEmail: text("git_email"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Un riassunto per (giorno, membro) e uno per (giorno, email non risolta).
    // Unique parziali: userId e gitEmail sono mutuamente esclusivi.
    uniqueIndex("activity_dev_summaries_date_user_unique")
      .on(table.date, table.userId)
      .where(sql`user_id is not null`),
    uniqueIndex("activity_dev_summaries_date_email_unique")
      .on(table.date, table.gitEmail)
      .where(sql`git_email is not null`),
    index("activity_dev_summaries_date_idx").on(table.date),
  ],
);

/**
 * Segna che il rollup dei riassunti-per-sviluppatore di un giorno è stato
 * generato (tutti i report del giorno erano `done`). Gating idempotente: la
 * fase di rollup nel poller salta i giorni già presenti qui. Rimossa quando un
 * report del giorno torna queued/running (rigenerazione), per riattivare il
 * rollup.
 */
export const activityDayRollups = pgTable("activity_day_rollups", {
  date: date("date").primaryKey(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Debounce dei job di recount dei report attività: un push su un repo di un
 * progetto con report abilitato accoda/rinfresca qui (upsert per projectId,
 * notBefore in avanti). Il poller reclama i job scaduti (not_before <= now) e
 * ricalcola stale_commit_count dei report done del progetto. Pattern identico a
 * doc_auto_update_jobs / pr_review_jobs.
 */
export const activityRecountJobs = pgTable("activity_recount_jobs", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Voce del backlog di discovery (product-level): un'idea/feature deviata da un
 * ticket (`source=ticket`) o creata a mano (`source=manual`). `document` è il
 * testo canonico raffinato via chat; `embedding` (pgvector 1024-dim, bge-m3)
 * serve al dedup semantico. `requestCount` conta quante richieste distinte hanno
 * alimentato la voce. `similarToId`/`mergedIntoId` sono self-reference (una voce
 * simile suggerita, o la voce in cui questa è stata fusa): set null alla
 * rimozione del riferimento. `suggested` sono i metadati proposti dall'AI in
 * attesa di conferma umana (separati dai campi confermati effort/risk/urgency).
 */
export const backlogItems = pgTable(
  "backlog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    document: text("document").notNull().default(""),
    // Piano di implementazione dedicato (null finché non prodotto) e corpo
    // originale preservato quando un design doc ne sostituisce il corpo. Il
    // corpo canonico resta `document`. Entrambe additive/nullable.
    implementationPlan: text("implementation_plan"),
    originContent: text("origin_content"),
    status: backlogItemStatus("status").notNull().default("new"),
    effort: integer("effort"),
    risk: backlogRisk("risk"),
    riskNote: text("risk_note"),
    // L'urgenza riusa l'enum ticket_priority esistente (low/medium/high/urgent).
    urgency: ticketPriority("urgency"),
    requestCount: integer("request_count").notNull().default(1),
    similarToId: uuid("similar_to_id").references((): AnyPgColumn => backlogItems.id, {
      onDelete: "set null",
    }),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => backlogItems.id, {
      onDelete: "set null",
    }),
    suggested: jsonb("suggested").$type<BacklogSuggested | null>(),
    // Volutamente SENZA indice HNSW (a differenza di doc_chunks): il dedup
    // filtra per projectId su decine-centinaia di voci e calcola la distanza
    // esatta — sub-millisecondo ed esatto. Un HNSW qui sarebbe approssimato e
    // inefficiente con un filtro così selettivo. Da rivalutare solo oltre
    // ~decine di migliaia di voci per progetto.
    embedding: vector(1024),
    source: backlogItemSource("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("backlog_items_project_status_idx").on(table.projectId, table.status)],
);

/**
 * Legame N:N voce↔ticket: i ticket che hanno originato la voce (`origin`) e
 * l'eventuale ticket in cui la voce è stata convertita (`converted_to`).
 * Chiave composta (itemId, ticketId); cascata su entrambi i lati.
 */
export const backlogItemTickets = pgTable(
  "backlog_item_tickets",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => backlogItems.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    role: backlogTicketRole("role").notNull().default("origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.ticketId] })],
);

/**
 * Messaggi della chat di raffinamento di una voce del backlog. `citations`
 * (jsonb) porta gli eventuali riferimenti RAG del turno assistant. Cascata sulla
 * voce; indicizzati per (itemId, createdAt) per rileggere la conversazione in
 * ordine.
 */
export const backlogChatMessages = pgTable(
  "backlog_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => backlogItems.id, { onDelete: "cascade" }),
    // Colonna text (non pgEnum) storica: i valori ammessi derivano comunque da
    // `backlogMessageRoleSchema` in shared, unica fonte di verità.
    role: text("role", { enum: enumValues(backlogMessageRoleSchema) }).notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("backlog_chat_messages_item_idx").on(table.itemId, table.createdAt)],
);

/**
 * Coda di job del backlog (project-scoped): `intake` (prima elaborazione di una
 * voce: dedup + metadati suggeriti) o `deep_dive` (approfondimento sul repo).
 * Il `payload` (jsonb) varia per kind: intake da ticket `{ ticketId }`, intake
 * manuale `{ title, body }`, deep_dive `{ itemId, repositoryId }`. Indicizzata
 * per (status, createdAt) per il claim in ordine FIFO.
 */
export const backlogJobs = pgTable(
  "backlog_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: backlogJobKind("kind").notNull(),
    status: backlogJobStatus("status").notNull().default("queued"),
    // Payload tipizzato (union per-forma: intake da ticket / intake manuale /
    // deep_dive). `.$type` è solo compile-time; il worker rivalida al dequeue.
    payload: jsonb("payload").$type<BacklogJobPayload>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    // itemId prodotto dall'intake (o item su cui è avvenuto l'auto-merge). Null
    // finché il job non è done; set null se l'item viene poi cancellato.
    resultItemId: uuid("result_item_id").references(() => backlogItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  // Claim del worker: il job in coda più vecchio (FIFO). Indice PARZIALE (come
  // `ai_jobs_queued_created_at_idx`): resta minuscolo perché copre solo i job
  // ancora `queued`, che è l'unico stato su cui il claim ordina per created_at.
  (table) => [
    index("backlog_jobs_queued_created_at_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
  ],
);

/**
 * Sessione di analisi sul codice di una voce del backlog: quando è `active`,
 * ogni messaggio della chat di raffinamento diventa un turno dell'agente claude
 * CLI che investiga in diretta il repository scelto (worktree read-only). Una
 * sola sessione `active` per voce (indice unico PARZIALE su `item_id` filtrato
 * su status='active'): le sessioni `closed` restano come storico, senza vincolo.
 * `cliSessionId` è null finché il primo turno non lo assegna (il worker vi
 * salva l'id della sessione CLI per il `--resume` dei turni successivi).
 * `lastActivityAt` alimenta lo sweep TTL del worker (chiusura per inattività).
 */
export const backlogCodeSessions = pgTable(
  "backlog_code_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => backlogItems.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    status: backlogCodeSessionStatus("status").notNull().default("active"),
    // Id della sessione claude CLI, assegnato dal primo turno del worker
    // (`--resume`). Null finché nessun turno è stato eseguito.
    cliSessionId: text("cli_session_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // Al più una sessione attiva per voce. Indice unico PARZIALE (filtrato su
    // status='active'): le righe `closed` non partecipano, quindi la storia può
    // accumulare N sessioni chiuse sulla stessa voce.
    uniqueIndex("backlog_code_sessions_active_item_unique")
      .on(table.itemId)
      .where(sql`status = 'active'`),
  ],
);

/**
 * Domande a bottoni poste dall'agente durante un turno CODE della chat di
 * raffinamento del backlog (fase 7): GEMELLA di `agentQuestions`, ma ancorata
 * a `backlog_item_id` invece che a un job/ticket — una voce di backlog non ha
 * né l'uno né l'altro finché non viene convertita. Stessa forma di `options`/
 * `answer` (riusa {@link AgentQuestionAnswer}) e stessa disciplina di
 * unicità della risposta (UPDATE guardato su `answered_at IS NULL`), ma
 * aggiunge `dismissedAt`: qui l'uscita "non ora" è OBBLIGATORIA (il sistema
 * ha già pagato il prezzo di domande senza via d'uscita, vedi
 * `agent_questions` e la nota in `actions.ts`), quindi una domanda si chiude
 * anche senza risposta. Nessun `round`: la chat del backlog non ha round
 * numerati come `ask_user` nel fix, è una domanda alla volta nel flusso
 * naturale della conversazione.
 */
export const backlogQuestions = pgTable(
  "backlog_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backlogItemId: uuid("backlog_item_id")
      .notNull()
      .references(() => backlogItems.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    // Le alternative proposte dall'agente (2..4), ognuna con la sua etichetta e
    // l'eventuale conseguenza mostrata sotto il bottone. Stessa forma di
    // `agentQuestions.options`, validata dal servizio (non dal DB).
    options: jsonb("options").$type<{ label: string; consequence?: string }[]>().notNull(),
    // Indice dell'opzione consigliata dall'agente, se ne ha una. Marcata nella
    // UI ma MAI preselezionata: la scelta resta dell'umano.
    recommendedIndex: integer("recommended_index"),
    // L'agente accetta anche una risposta in testo libero ("Altro…").
    allowFreeText: boolean("allow_free_text").notNull().default(true),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    // Risposta umana: `{ optionIndex }` per una delle opzioni, `{ text }` per il
    // testo libero. Null finché la domanda è aperta (né risposta né "non ora").
    answer: jsonb("answer").$type<AgentQuestionAnswer>(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Chi ha risposto. ON DELETE SET NULL: lo storico della domanda sopravvive
    // all'utente.
    answeredByUserId: uuid("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // "Non ora": chiude la domanda SENZA rispondere, lasciando la conversazione
    // libera. Anche la conversione della voce in ticket e la sua archiviazione
    // chiudono così — nella stessa transazione — un'eventuale domanda ancora
    // aperta: nessuna domanda può restare aperta senza via d'uscita.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (table) => [
    // Una sola domanda APERTA per voce: né risposta né "non ora". Indice unico
    // PARZIALE — le domande chiuse (in un modo o nell'altro) non vi
    // partecipano, quindi la conversazione può accumulare più domande nel
    // tempo, mai due aperte insieme.
    uniqueIndex("backlog_questions_open_item_unique")
      .on(table.backlogItemId)
      .where(sql`answered_at IS NULL AND dismissed_at IS NULL`),
    index("backlog_questions_item_idx").on(table.backlogItemId, table.askedAt),
    // Una domanda è risposta se e solo se ha una risposta (indipendente da
    // dismissedAt: "non ora" non è una risposta, answer resta null).
    check("backlog_questions_answer_chk", sql`(answer IS NULL) = (answered_at IS NULL)`),
  ],
);

/** Riga di `backlog_questions`: una domanda a bottoni sulla voce di backlog. */
export type BacklogQuestion = typeof backlogQuestions.$inferSelect;

/**
 * Metadati del knowledge graph di un repository (integrazione graphify). I file
 * veri del grafo (nodi, archi, comunità) NON stanno qui: vivono su un volume
 * accanto al worker; questa riga è solo lo stato osservabile dalla UI. Una riga
 * per repository (`repository_id` è anche la primary key), cancellata in cascata
 * col repository. I contatori sono null finché la prima build non li popola;
 * `labeled` dice se le comunità hanno già un'etichetta leggibile.
 */
export const repoGraphs = pgTable("repo_graphs", {
  repositoryId: uuid("repository_id")
    .primaryKey()
    .references(() => repositories.id, { onDelete: "cascade" }),
  // Stato dell'ultima build: none (mai costruito) | queued | running | done |
  // failed. Colonna `text` (nessun enum Postgres): il vincolo è compile-time.
  status: text("status", { enum: ["none", "queued", "running", "done", "failed"] })
    .notNull()
    .default("none"),
  // Commit del repository da cui il grafo è stato estratto: serve a capire se il
  // grafo è aggiornato rispetto al default branch.
  commitSha: text("commit_sha"),
  nodeCount: integer("node_count"),
  edgeCount: integer("edge_count"),
  communityCount: integer("community_count"),
  labeled: boolean("labeled").notNull().default(false),
  // PR di setup aperta sul repository (config graphify); null se mai aperta.
  setupPrUrl: text("setup_pr_url"),
  // Errore dell'ultima build fallita, mostrato in UI. Null quando status != failed.
  error: text("error"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Coda di job del grafo (repository-scoped): `build` (estrazione del grafo dal
 * worktree) o `setup_pr` (apertura della PR di configurazione graphify). Il
 * poller del worker li claima con `FOR UPDATE SKIP LOCKED` rispettando
 * `notBefore` (debounce del webhook push).
 */
export const graphJobs = pgTable(
  "graph_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Colonne `text` con enum compile-time (come `backlog_chat_messages.role`):
    // nessun enum Postgres né CHECK, il worker rivalida al dequeue.
    kind: text("kind", { enum: ["build", "setup_pr"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    // Non prima di questo istante: il debounce del webhook push lo sposta in
    // avanti sul job queued esistente invece di accodarne un secondo. Null =
    // claimabile subito.
    notBefore: timestamp("not_before", { withTimezone: true }),
    // Passa `--force` a graphify: rifà l'estrazione da zero ignorando il
    // manifest incrementale. È solo l'escape hatch manuale ("Rigenera da zero"
    // del POST generate); il webhook push non lo accende mai.
    force: boolean("force").notNull().default(false),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Al più un job ATTIVO per (repository, kind). Indice unico PARZIALE
    // (filtrato sugli stati vivi): i job done/failed non partecipano, quindi lo
    // storico può accumulare N build sullo stesso repository. È il vincolo su
    // cui poggia il debounce del webhook (UPDATE del queued esistente).
    uniqueIndex("graph_jobs_active_unique")
      .on(table.repositoryId, table.kind)
      .where(sql`status IN ('queued', 'running')`),
  ],
);

/** Riga di `repo_graphs`: stato del knowledge graph di un repository. */
export type RepoGraph = typeof repoGraphs.$inferSelect;
/** Riga di `graph_jobs`: un job di build/setup del grafo in coda. */
export type GraphJob = typeof graphJobs.$inferSelect;

/**
 * Inbox di notifiche PER-UTENTE: una riga per (destinatario, evento). È la
 * lista di ciò che un utente deve ancora smaltire, non un log dell'istanza —
 * l'evento che tocca tre persone genera tre righe, ognuna con il proprio stato.
 * `projectId`/`ticketId`/`jobId` sono le ancore verso l'entità di origine
 * (nullable: `docs.limit_paused` e `monitor.*` non hanno un ticket), e servono
 * a chiudere in blocco le notifiche di un job risolto. Il progetto è
 * ON DELETE SET NULL (la notifica resta leggibile), ticket e job cascatano.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => aiJobs.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    // Payload dell'evento, già completo di tutto ciò che serve a renderlo
    // (titolo del ticket, url, dettaglio). Il tipo forte è `NotificationEvent`
    // di @stubwise/notifications/pure: qui resta `Record<string, unknown>`
    // perché `db` non può importare da `notifications` (ciclo di dipendenze); i
    // consumatori castano al tipo dell'unione dopo aver letto `kind`.
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    status: notificationStatus("status").notNull().default("open"),
    // Fino a quando la notifica resta fuori dall'inbox (status "snoozed").
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    // Prima apertura da parte del destinatario. Distinto da `handledAt`: letta
    // non vuol dire smaltita.
    readAt: timestamp("read_at", { withTimezone: true }),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    // Chi ha chiuso la notifica: di norma il destinatario, ma un'azione su
    // un'entità condivisa può chiudere anche le notifiche altrui. Null quando a
    // chiudere è stato il sistema (evento risolto).
    handledByUserId: uuid("handled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Inbox di un utente filtrata per stato, dalla più recente. NON parziale su
    // 'open': lo stesso indice serve le liste per stato e la riapertura lazy
    // degli snooze scaduti (che leggono status <> 'open'). `id DESC` è il
    // tiebreaker della paginazione keyset, `created_at` non è univoco.
    index("notifications_user_status_created_idx").on(
      table.userId,
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // Fan-in dal job: da un evento si risale a tutti i destinatari avvisati.
    index("notifications_job_id_idx").on(table.jobId),
    // Stesso fan-in per gli eventi ancorati a un ticket (nessun job dietro).
    index("notifications_ticket_id_idx").on(table.ticketId),
    // Claim di una PROPOSTA (fase 6): `propagateHandled` chiude tutte le copie
    // della notifica con lo stesso `event->>'proposalId'`. Indice
    // sull'ESPRESSIONE, parziale su `IS NOT NULL` — e NON su
    // `kind = 'google.proposal'`, che nella migrazione userebbe un valore di
    // enum aggiunto nella stessa transazione (Postgres lo rifiuta). Indicizza
    // comunque le sole righe che portano un `proposalId`, e il planner lo usa
    // perché `event->>'proposalId' = $1` implica `IS NOT NULL`.
    index("notifications_proposal_id_idx")
      .on(sql`(${table.event}->>'proposalId')`)
      .where(sql`(event->>'proposalId') is not null`),
    // Una notifica rinviata ha sempre una scadenza, altrimenti resterebbe fuori
    // dall'inbox per sempre.
    check("notifications_snoozed_until_chk", sql`status <> 'snoozed' OR snoozed_until IS NOT NULL`),
    // `handled_at` valorizzato se e solo se lo stato è `handled`.
    check("notifications_handled_at_chk", sql`(status = 'handled') = (handled_at IS NOT NULL)`),
  ],
);

/**
 * Outbox delle consegne verso i canali esterni, una riga per (evento, canale).
 * Separata da `notifications` perché le due cose hanno cardinalità diverse: il
 * webhook d'istanza è UNO per evento (riga con `notificationId` null e l'evento
 * copiato in `event`), il DM Slack è uno per destinatario (riga legata alla sua
 * notifica, che porta già il payload). Il poller claima le righe `pending`
 * dovute e riprova con backoff su `nextAttemptAt`.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Notifica di cui questa è il recapito. Null per le consegne per-evento
    // (webhook d'istanza), che non hanno un destinatario.
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "cascade",
    }),
    // Payload dell'evento, valorizzato SOLO per le consegne senza notifica
    // dietro (channel "webhook"): le altre lo leggono da `notifications.event`.
    // Stesso tipo forte (`NotificationEvent`) e stesso cast lato consumatore.
    event: jsonb("event").$type<Record<string, unknown>>(),
    channel: deliveryChannel("channel").notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // Non prima di questo istante: il backoff dei ritentativi lo sposta in
    // avanti. Default now() = consegna dovuta subito.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    error: text("error"),
    // Riferimento del messaggio sul canale esterno: il `ts` del messaggio Slack,
    // così una consegna `slack_update` può aggiornarlo invece di ripostarlo.
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    // Claim del poller: la prossima consegna dovuta. Indice parziale sulle sole
    // pending, lo storico di inviate/fallite non vi partecipa.
    index("notification_deliveries_pending_idx")
      .on(table.nextAttemptAt)
      .where(sql`status = 'pending'`),
    // Consegne di una notifica: sostiene la cascata del delete e la lettura
    // dello stato di recapito dal dettaglio di una notifica.
    index("notification_deliveries_notification_id_idx").on(table.notificationId),
    // Forma della riga garantita dal DB, non solo dal codice: `webhook` è per
    // EVENTO (nessuna notifica dietro, payload in `event`), gli altri canali
    // sono per DESTINATARIO (notifica obbligatoria, payload letto da lì).
    check(
      "notification_deliveries_channel_shape_chk",
      sql`(channel = 'webhook') = (notification_id IS NULL)`,
    ),
    check(
      "notification_deliveries_webhook_event_chk",
      sql`channel <> 'webhook' OR event IS NOT NULL`,
    ),
  ],
);

/**
 * Progetti seguiti da un utente: è il criterio di instradamento delle notifiche
 * non indirizzate a una persona precisa (un evento su un progetto raggiunge chi
 * lo segue). Chiave composta (utente, progetto), cascata su entrambi i lati.
 */
export const projectFollows = pgTable(
  "project_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    // Follower di UN progetto: è la query del routing delle notifiche, che
    // filtra per il solo `project_id`. La PK (user_id, project_id) non la serve
    // (project_id non è il suo prefisso), quindi serve un indice dedicato.
    index("project_follows_project_id_idx").on(table.projectId),
  ],
);

/**
 * Un'installazione dell'app mobile che può ricevere notifiche push (fase 4).
 * È il "dove" del canale `push`: l'instradamento sceglie il destinatario, qui
 * si trovano i suoi telefoni.
 *
 * `token` è il token del servizio di notifica del sistema operativo ed è unico
 * GLOBALMENTE, non per utente: il sistema lo riassegna, e la stessa stringa su
 * due righe manderebbe la push due volte o alla persona sbagliata. Registrare
 * di nuovo un device è quindi un upsert su questa unique, non una riga in più
 * — e quell'upsert deve RIATTIVARE la riga (`disabledAt` e `disabledReason` a
 * NULL), altrimenti un telefono il cui token era stato dichiarato invalido, o
 * il cui PAT era stato revocato, resterebbe muto per sempre pur avendo appena
 * rifatto l'accesso dall'app.
 *
 * La disattivazione è un soft delete con motivo (`disabledAt` +
 * `disabledReason`, es. token rifiutato dal provider, o `pat_revoked`): serve
 * a smettere di provarci senza perdere la traccia del perché. I due campi
 * vivono e muoiono insieme, e il CHECK in fondo lo impone.
 */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // PAT con cui l'app si è autenticata registrando il device. SET NULL e non
    // CASCADE perché un device registrato via cookie di sessione non ha PAT e
    // non deve morire con quello di nessun altro.
    // ⚠️ Ma il SET NULL da solo NON basta: dopo la revoca la riga resterebbe
    // `pat_id` null e ATTIVA, indistinguibile da un device registrato via web,
    // e il telefono continuerebbe a ricevere push — cioè il contrario di ciò
    // che si aspetta chi revoca il token dopo aver perso il telefono. A
    // chiudere il buco è la revoca stessa (`routes/pat.ts`), che disabilita i
    // device di quel PAT nella stessa transazione e PRIMA del delete; qui il
    // SET NULL resta solo come rete se qualcuno cancellasse una riga di
    // `personal_access_tokens` per altre vie.
    patId: uuid("pat_id").references(() => personalAccessTokens.id, { onDelete: "set null" }),
    // Colonna text con CHECK invece di un enum Postgres. NON è la stessa scelta
    // di `plugins`/`graph_jobs`, che stanno senza enum E senza CHECK: qui il
    // vincolo nel DB c'è. Il motivo di non usare un pgEnum è un altro —
    // aggiungere un valore a un enum Postgres obbliga a una migrazione SEPARATA
    // dal resto del batch (`ALTER TYPE … ADD VALUE` non è usabile nella stessa
    // transazione che lo aggiunge), mentre un CHECK si sostituisce in DROP +
    // ADD CONSTRAINT dentro la migrazione che serve. Il risparmio è sulla
    // separazione, non sulla migrazione: quella serve comunque.
    // Il prezzo è che `enum-parity.test.ts` non copre questa lista (guarda i
    // `pgEnum`, e qui non c'è un tipo Postgres da confrontare) — al suo posto
    // c'è `device-tokens.test.ts`, che confronta questi `enumValues` con la
    // definizione reale del CHECK letta da `pg_get_constraintdef`.
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    token: text("token").notNull().unique(),
    // Versione dell'app che ha registrato il device, utile a diagnosticare le
    // push che non arrivano. Nullable: non è un dato di cui si dipende.
    appVersion: text("app_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Destinatari di una push: i device ATTIVI di un utente. Indice parziale,
    // così i device disattivati non pesano su una query che sta sul percorso di
    // ogni notifica.
    index("device_tokens_user_active_idx")
      .on(table.userId)
      .where(sql`disabled_at is null`),
    check("device_tokens_platform_chk", sql`platform in ('ios', 'android')`),
    // Un device è disattivato se e solo se sappiamo perché. Senza questo
    // vincolo esisterebbero due righe senza senso: una con `disabled_reason` ma
    // `disabled_at` NULL, che l'indice parziale qui sopra considererebbe un
    // destinatario valido pur avendo un motivo di esclusione scritto sopra; e
    // una disattivata senza motivo, che perde esattamente la traccia per cui il
    // soft delete esiste. Stesso pattern di `notifications_handled_at_chk` e
    // `agent_questions_answer_chk`.
    check(
      "device_tokens_disabled_chk",
      sql`(disabled_at IS NULL) = (disabled_reason IS NULL)`,
    ),
  ],
);

/** Riga di `notifications`: una notifica nell'inbox di un utente. */
export type Notification = typeof notifications.$inferSelect;
/** Riga di `notification_deliveries`: una consegna verso un canale esterno. */
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
/** Riga di `project_follows`: un progetto seguito da un utente. */
export type ProjectFollow = typeof projectFollows.$inferSelect;
/** Riga di `device_tokens`: un'installazione dell'app mobile che riceve push. */
export type DeviceToken = typeof deviceTokens.$inferSelect;

/**
 * Domande poste dall'agente durante la pianificazione di un fix (fase 1,
 * pianificazione interattiva): una riga per domanda, con la risposta umana
 * accanto. Il job che l'ha posta resta parcheggiato in `awaiting_input` finché
 * `answered_at` non è valorizzato; un round successivo nasce solo dopo che il
 * precedente ha avuto risposta (indice unico parziale). `ticketId` è ridondante
 * rispetto al job ma serve alla timeline del ticket, che legge le Q&A di TUTTI
 * i job del ticket senza join.
 */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // Round di domande dentro lo stesso job, da 1: l'agente ne ha a
    // disposizione un numero limitato (AGENT_QUESTION_MAX_ROUNDS).
    round: integer("round").notNull(),
    question: text("question").notNull(),
    // Le alternative proposte dall'agente (2..4), ognuna con la sua etichetta e
    // l'eventuale conseguenza mostrata sotto il bottone.
    options: jsonb("options").$type<{ label: string; consequence?: string }[]>().notNull(),
    // Indice dell'opzione consigliata dall'agente, se ne ha una. Marcata nella
    // UI ma MAI preselezionata: la scelta resta dell'umano.
    recommendedIndex: integer("recommended_index"),
    // L'agente accetta anche una risposta in testo libero ("Altro…").
    allowFreeText: boolean("allow_free_text").notNull().default(true),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    // Risposta umana: `{ optionIndex }` per una delle opzioni, `{ text }` per il
    // testo libero. Null finché la domanda è aperta.
    //
    // Tipata sulla UNION e non su `Record<string, unknown>`: il contratto è
    // stretto e noto (lo scrive `answerQuestion`, lo rilegge il prompt di
    // ripresa del worker), quindi il tipo Drizzle e lo schema Zod condiviso
    // nascono dalla stessa dichiarazione. Chi LEGGE la colonna resta comunque
    // difensivo (il jsonb può venire da una versione precedente): il tipo
    // descrive ciò che scriviamo, non una garanzia del DB.
    answer: jsonb("answer").$type<AgentQuestionAnswer>(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Chi ha risposto: il richiedente del job o un maintainer. ON DELETE SET
    // NULL, lo storico della domanda sopravvive all'utente.
    answeredByUserId: uuid("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    // Una sola domanda APERTA per job. Indice unico PARZIALE: le domande già
    // risposte non vi partecipano, quindi i round successivi si accumulano.
    uniqueIndex("agent_questions_open_job_unique")
      .on(table.jobId)
      .where(sql`answered_at IS NULL`),
    // Q&A di un ticket in ordine cronologico (timeline della pagina ticket e
    // blocco "Decisioni già prese" del fallback di ripresa).
    index("agent_questions_ticket_idx").on(table.ticketId, table.askedAt),
    // Una domanda è chiusa se e solo se ha una risposta.
    check("agent_questions_answer_chk", sql`(answer IS NULL) = (answered_at IS NULL)`),
  ],
);

/** Riga di `agent_questions`: una domanda dell'agente e la risposta umana. */
export type AgentQuestion = typeof agentQuestions.$inferSelect;

/**
 * REGISTRO PLUGIN d'istanza (fase 3): repo git pubblici pinnati a uno sha,
 * materializzati dal worker su un volume (`/plugins/<slug>/<sha>/`) e passati
 * ai run dell'agente con `--plugin-dir`. Qui vive solo il METADATO: i file del
 * plugin stanno sul volume, che il server non monta affatto (legge `inventory`
 * dal DB). Il registro è d'istanza, non di progetto: `project_plugins` dice chi
 * lo usa.
 *
 * `status` segue la materializzazione asincrona; `smokeStatus` è l'esito
 * separato dello smoke run che verifica che le skill siano davvero visibili
 * all'agente (un plugin materializzato ma invisibile al CLI sarebbe un no-op
 * silenzioso). Al `ready` vengono valorizzati `resolvedSha`, `inventory` e
 * `materializedAt`.
 */
export const plugins = pgTable("plugins", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Identità stabile del plugin nella UI e NEL PERCORSO sul volume
  // (`/plugins/<slug>/<sha>/`): derivato dalla sorgente alla registrazione.
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Sorgente https pubblica (il fetch gira senza auth): la validazione dello
  // schema — https, niente credenziali nell'URL — è in `@stubwise/shared`.
  sourceUrl: text("source_url").notNull(),
  // Sottocartella del repo che contiene il plugin (monorepo di plugin). Null =
  // il plugin è la radice della checkout.
  sourceSubdir: text("source_subdir"),
  // Ref richiesto dall'utente (tag, branch, sha): è ciò che si aggiorna.
  ref: text("ref").notNull(),
  // Sha a cui il ref è stato risolto dall'ultimo fetch riuscito: il pin in uso è
  // sempre uno sha, mai un ref mobile. Null finché mai materializzato.
  resolvedSha: text("resolved_sha"),
  // Colonna `text` con enum compile-time (come `repo_graphs.status`): nessun
  // enum Postgres, nessun CHECK.
  status: text("status", { enum: ["none", "materializing", "ready", "failed"] })
    .notNull()
    .default("none"),
  // Inventario costruito DAL WORKER leggendo la dir materializzata (skill,
  // comandi, agenti, hook, presenza di .mcp.json). Tipato sullo schema
  // condiviso: worker che scrive, server che espone e SPA che disegna nascono
  // dalla stessa dichiarazione. Chi LEGGE resta difensivo (il jsonb può venire
  // da una versione precedente del formato).
  inventory: jsonb("inventory").$type<PluginInventory>(),
  // Motivo dell'ultima materializzazione fallita, mostrato in UI.
  error: text("error"),
  smokeStatus: text("smoke_status", { enum: ["idle", "pending", "passed", "failed"] })
    .notNull()
    .default("idle"),
  smokeError: text("smoke_error"),
  materializedAt: timestamp("materialized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Coda di job del registro plugin: `materialize` (fetch + checkout + validate +
 * inventario) o `smoke` (run di verifica che le skill siano visibili al CLI).
 * Il poller del worker li claima con `FOR UPDATE SKIP LOCKED` in ordine FIFO.
 */
export const pluginJobs = pgTable(
  "plugin_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["materialize", "smoke"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Al più un job ATTIVO per (plugin, kind). Indice unico PARZIALE (come
    // `graph_jobs_active_unique`): i job done/failed non partecipano, quindi lo
    // storico può accumulare N materializzazioni sullo stesso plugin. È ciò che
    // impedisce due materializzazioni concorrenti della stessa dir.
    uniqueIndex("plugin_jobs_active_unique")
      .on(table.pluginId, table.kind)
      .where(sql`status IN ('queued', 'running')`),
    // Claim del worker: il job in coda più vecchio (FIFO). Indice PARZIALE: resta
    // minuscolo perché copre solo i job ancora `queued`.
    index("plugin_jobs_queued_created_at_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
  ],
);

/**
 * Abilitazioni per progetto, con gli spegnimenti a grana fine. Spegnere è per
 * SOTTRAZIONE (default: tutto acceso) perché l'inventario può crescere con un
 * aggiornamento del plugin: `disabled_skills` sono nomi di skill,
 * `disabled_hooks` chiavi `<Evento>#<indice>` (es. `SessionStart#0`). Sono le
 * voci che il worker TOGLIE dalla copia filtrata del plugin per quel run — non
 * esiste una disabilitazione nativa del CLI per la singola skill di un plugin.
 */
export const projectPlugins = pgTable(
  "project_plugins",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    disabledSkills: text("disabled_skills").array().notNull().default([]),
    disabledHooks: text("disabled_hooks").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.pluginId] })],
);

/**
 * Riga di `plugins`: un plugin del registro d'istanza.
 *
 * Suffisso `Row` (unico nello schema) perché `Plugin` in `@stubwise/shared` è
 * già la PROIEZIONE PUBBLICA del plugin (date ISO, inventario validato): sono
 * due tipi diversi, e un file del server che li usa entrambi non deve dover
 * aliasare l'import. Stesso motivo per `ProjectPluginRow`.
 */
export type PluginRow = typeof plugins.$inferSelect;
/** Riga di `plugin_jobs`: un job di materializzazione o smoke in coda. */
export type PluginJob = typeof pluginJobs.$inferSelect;
/** Riga di `project_plugins`: l'abilitazione di un plugin su un progetto. */
export type ProjectPluginRow = typeof projectPlugins.$inferSelect;

/**
 * BRIEF SETTIMANALE di un progetto (Fase 5): il resoconto per non-tecnici che
 * un poller genera una volta a settimana, sotto il toggle
 * `projects.weeklyBriefEnabled`.
 *
 * Nome distinto dal *project brief* della documentazione (jsonb su
 * `doc_generations`, tab `/docs/$projectId/brief`): sono due cose diverse che
 * condividono solo la parola.
 *
 * `periodStart`/`periodEnd` sono DATE, non istanti: la settimana è un
 * intervallo di giorni di calendario nel fuso d'invio. L'unique
 * `(project_id, period_start)` è il gate di idempotenza del poller — due tick
 * concorrenti non generano due brief della stessa settimana.
 *
 * `status` è text con CHECK (non un enum Postgres) perché sostituire un CHECK
 * si fa dentro la migrazione che serve, mentre un valore di enum ne richiede
 * una separata dal batch. `attempts` + `lastActivityAt` sono il recovery degli
 * orfani, come per i report giornalieri: un `running` la cui attività è vecchia
 * torna `queued`, fino a un massimo di tentativi.
 */
export const projectBriefs = pgTable(
  "project_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    error: text("error"),
    // Brief completo in markdown. Null finché non generato, e anche a
    // generazione `done` se il provider AI mancava: come per il report
    // giornaliero, meglio una riga senza testo che una generazione fallita.
    summary: text("summary"),
    // Le quattro sezioni separate (`whereWeAre`, `whatChanged`, `whatBlocks`,
    // `whatWeNeed`), estratte dai marcatori dell'output. Null se non parsate.
    sections: jsonb("sections").$type<Record<string, string>>(),
    // La notifica `project.brief` pubblicata per questo brief. SET NULL:
    // archiviare o cancellare la notifica non deve portarsi via il brief.
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("project_briefs_project_period_unique").on(table.projectId, table.periodStart),
    // I brief si leggono per progetto, dal periodo più recente.
    index("project_briefs_project_period_idx").on(table.projectId, table.periodStart.desc()),
    check(
      "project_briefs_status_chk",
      sql`status in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

/**
 * REGISTRO DELLE DECISIONI di un progetto (Fase 5).
 *
 * ⚠️ INVARIANTE: questo registro non è MAI scritto dall'AI. I writer automatici
 * (risposta a una domanda `ask_user`, approvazione/rifiuto di un piano,
 * "Procedi" del pulse) compongono i testi da template i18n nella lingua dei
 * contenuti; le voci manuali le scrive una persona. Il brief e i riassunti
 * "in breve" sono narrativa generata, questo è il FATTO: chi tocca i writer non
 * ci innesti una generazione di testo.
 *
 * `sourceKey` è la chiave di IDEMPOTENZA della voce (es. `question:<id>`,
 * `plan_review:<jobId>:<n>`, `pulse:<notificationId>`): l'unique con
 * `projectId` fa sì che un replay del writer non aggiunga una seconda riga —
 * `onConflictDoNothing` sull'unique è il contratto di `recordDecision`.
 *
 * `ticketId` e `decidedByUserId` sono ON DELETE SET NULL: cancellare il ticket
 * o l'utente non cancella la decisione, che è proprio lo storico da preservare.
 * `supersededById` marca una decisione superata da un'altra senza cancellare la
 * prima (una decisione revocata resta un fatto accaduto).
 */
export const projectDecisions = pgTable(
  "project_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // `email` (fase 6) è la conferma di una proposta nata dalla posta o dal
    // calendario: anch'essa scritta da TEMPLATE i18n, come le altre automatiche.
    source: text("source")
      .$type<"ask_user" | "plan_review" | "pulse" | "manual" | "email">()
      .notNull(),
    sourceKey: text("source_key").notNull(),
    // Gli id d'origine in forma strutturata (questionId, jobId, notificationId…),
    // per risalire all'evento senza dover parsare `sourceKey`.
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // Il contesto in cui la decisione è stata presa (es. le alternative
    // scartate del pulse). Null = nessun contesto registrato.
    context: text("context"),
    decision: text("decision").notNull(),
    // Cosa comporta la decisione presa (es. la `consequence` dell'opzione
    // scelta in una domanda dell'agente). Null = nessuna conseguenza dichiarata.
    consequences: text("consequences"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    // Self-reference: la FK esiste in migrazione (ON DELETE SET NULL) ma non è
    // dichiarata qui, come per `doc_pages.parentId` — drizzle non ammette un
    // riferimento alla tabella in corso di definizione.
    supersededById: uuid("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_decisions_project_source_key_unique").on(
      table.projectId,
      table.sourceKey,
    ),
    // Le decisioni si leggono sempre per progetto, dalla più recente.
    index("project_decisions_project_decided_idx").on(table.projectId, table.decidedAt.desc()),
    check(
      "project_decisions_source_chk",
      sql`source in ('ask_user', 'plan_review', 'pulse', 'manual', 'email')`,
    ),
  ],
);

/** Riga di `project_briefs`: il brief settimanale di un progetto. */
export type ProjectBriefRow = typeof projectBriefs.$inferSelect;
/** Riga di `project_decisions`: una decisione registrata su un progetto. */
export type ProjectDecisionRow = typeof projectDecisions.$inferSelect;

/**
 * GOOGLE WORKSPACE registrato dall'admin (Fase 6): l'app OAuth **interna**
 * creata nella Google Cloud Console di quell'organizzazione.
 *
 * Un'app per Workspace e non una sola d'istanza: l'app interna è l'unica forma
 * che non richiede la verifica di Google per gli scope sensibili, e vale solo
 * dentro il suo dominio. `clientSecretEncrypted` è il blob AES-256-GCM (vedi
 * `secrets.ts`): non esce mai in chiaro dall'API, che risponde col solo
 * `clientSecretSet`.
 *
 * `domains` sono i domini email del Workspace, normalizzati lowercase: il
 * callback OAuth RIFIUTA una casella il cui dominio non è qui dentro
 * (`domain_mismatch`). È il confine fra una casella aziendale e un account
 * Google qualunque.
 */
export const googleWorkspaces = pgTable("google_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domains: text("domains").array().notNull(),
  clientId: text("client_id").notNull(),
  clientSecretEncrypted: text("client_secret_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * CASELLA GOOGLE collegata da un utente (N per utente, Fase 6).
 *
 * ⚠️ NESSUN access token è persistito: c'è solo il refresh token cifrato, e il
 * worker ottiene l'access token dal refresh a ogni ciclo, in memoria. Un dump
 * del database senza `ENCRYPTION_KEY` non dà accesso a nessuna casella.
 *
 * `workspaceId` è RESTRICT (non cascade): togliere un Workspace con caselle
 * vive è un errore dell'admin, non un'operazione da fare in silenzio — la rotta
 * risponde 409 `workspace_in_use`. `userId` invece cascata: la casella è un
 * dato personale e se ne va con l'utente.
 *
 * `nextSyncAt` (default now()) è il claim del poller — la casella appena
 * collegata è già dovuta al primo tick —, `syncAttempts` il contatore del
 * backoff, `disabledAt` + `disabledReason` la disabilitazione (fatale da Google
 * o troppi errori transitori di fila).
 */
export const googleAccounts = pgTable(
  "google_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => googleWorkspaces.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    /** `sub` dell'identità Google: stabile anche se l'email viene rinominata. */
    googleSub: text("google_sub").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    /** Toggle dell'utente: spenta, la casella non viene più sincronizzata. */
    proposalsEnabled: boolean("proposals_enabled").notNull().default(true),
    /** Cursore della History API di Gmail. Null = primo giro (o history scaduta). */
    gmailHistoryId: text("gmail_history_id"),
    /** Cursore incrementale del calendario `primary`. Null = primo giro. */
    calendarSyncToken: text("calendar_sync_token"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }).notNull().defaultNow(),
    syncAttempts: integer("sync_attempts").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason").$type<
      "revoked" | "invalid_grant" | "insufficient_scope" | "workspace_removed" | "sync_failed"
    >(),
  },
  (table) => [
    uniqueIndex("google_accounts_email_unique").on(table.email),
    // Le caselle di un utente si leggono insieme (pagina Account, pagina Posta).
    index("google_accounts_user_id_idx").on(table.userId),
    // Claim del poller: la prossima casella dovuta. Indice PARZIALE sulle sole
    // caselle vive e con le proposte accese — le altre non vengono mai pescate.
    index("google_accounts_due_idx")
      .on(table.nextSyncAt)
      .where(sql`disabled_at is null and proposals_enabled`),
    check(
      "google_accounts_disabled_reason_chk",
      sql`disabled_reason is null or disabled_reason in ('revoked', 'invalid_grant', 'insufficient_scope', 'workspace_removed', 'sync_failed')`,
    ),
  ],
);

/**
 * NONCE MONOUSO del flusso OAuth (Fase 6).
 *
 * Lo `state` che va e torna da Google è firmato HMAC con la chiave d'istanza,
 * ma una firma valida da sola non impedisce il REPLAY di un callback
 * intercettato: questa riga è il nonce che lo impedisce (si consuma alla prima
 * verifica) e `expiresAt` la finestra di 10 minuti oltre la quale il callback
 * non è più accettato.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nonce: text("nonce").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => googleWorkspaces.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Valorizzato alla prima verifica riuscita: un secondo callback è rifiutato. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_states_nonce_unique").on(table.nonce),
    // Potatura degli state scaduti.
    index("oauth_states_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * REGOLE DI ROUTING della posta verso un progetto (Fase 6).
 *
 * Un messaggio è "in perimetro" se almeno una regola di almeno un progetto
 * combacia; il progetto risolto è quello che ne soddisfa il numero maggiore, e
 * in caso di parità la posta resta senza progetto con i candidati registrati.
 *
 * `value` lo normalizza lowercase chi scrive, così l'unique
 * `(projectId, kind, value)` è davvero la stessa regola e non due grafie della
 * stessa cosa. `kind` è text con CHECK (non un enum Postgres): allargarlo si fa
 * dentro la migrazione che serve.
 */
export const projectEmailRoutes = pgTable(
  "project_email_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind")
      .$type<"sender_domain" | "sender_address" | "gmail_label" | "keyword">()
      .notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_email_routes_project_kind_value_unique").on(
      table.projectId,
      table.kind,
      table.value,
    ),
    check(
      "project_email_routes_kind_chk",
      sql`kind in ('sender_domain', 'sender_address', 'gmail_label', 'keyword')`,
    ),
  ],
);

/**
 * MESSAGGIO GMAIL in perimetro (Fase 6): quelli che nessuna regola riconosce
 * non vengono nemmeno scaricati e qui dentro non esistono.
 *
 * `textExcerpt` è il testo già ripulito e CAPATO (≤ 20k con marcatore): il MIME
 * originale non si conserva e gli allegati non entrano affatto — di un allegato
 * resta il link al thread. `projectId` è il progetto risolto dalle regole (SET
 * NULL: cancellarlo non cancella la posta), `candidateProjectIds` i progetti in
 * parità quando le regole non decidono.
 *
 * `status` e `signal` sono text con CHECK e non enum Postgres, per la stessa
 * ragione di `project_briefs.status`: sostituire un CHECK si fa nella
 * migrazione che serve, un valore di enum ne richiede una separata dal batch.
 *
 * L'unique `(accountId, gmailMessageId)` è l'IDEMPOTENZA del poller: il tick
 * inserisce con `onConflictDoNothing`, quindi rileggere la stessa history due
 * volte non duplica niente.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => googleAccounts.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: text("to_addresses").array().notNull().default([]),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** Etichette Gmail del messaggio: le usa il routing (`gmail_label`). */
    labels: text("labels").array().notNull().default([]),
    textExcerpt: text("text_excerpt"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    candidateProjectIds: uuid("candidate_project_ids").array().notNull().default([]),
    /**
     * Fase 6b: TUTTI i progetti a cui questo messaggio è visibile — non solo
     * `projectId` (il risolto) ma anche i `candidateProjectIds` che non hanno
     * vinto il routing. Popolato dal backfill della 0070 per le righe
     * preesistenti e da chi risolve il routing per quelle nuove; le proposte
     * per-progetto in `email_proposals` vivono per ognuno di questi id.
     */
    scopeProjectIds: uuid("scope_project_ids").array().notNull().default([]),
    status: text("status")
      .$type<"new" | "classified" | "proposed" | "actioned" | "ignored" | "failed">()
      .notNull()
      .default("new"),
    signal: text("signal").$type<"decision" | "request" | "deadline" | "blocker" | "none">(),
    /** Output della classificazione già RIVALIDATO (referenti compresi). */
    classification: jsonb("classification").$type<Record<string, unknown>>(),
    /** La proposta pubblicata per questo messaggio. SET NULL come per i brief. */
    proposalNotificationId: uuid("proposal_notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    /** Esito dell'azione confermata (id creati, esito `exists`, `cancelled`…). */
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("email_messages_account_message_unique").on(table.accountId, table.gmailMessageId),
    // Fase 2 del tick: i messaggi `new` di una casella, da classificare.
    index("email_messages_account_status_idx").on(table.accountId, table.status),
    // La posta di un progetto, dalla più recente (pagina Posta, contesto).
    index("email_messages_project_received_idx").on(table.projectId, table.receivedAt.desc()),
    check(
      "email_messages_status_chk",
      sql`status in ('new', 'classified', 'proposed', 'actioned', 'ignored', 'failed')`,
    ),
    check(
      "email_messages_signal_chk",
      sql`signal is null or signal in ('decision', 'request', 'deadline', 'blocker', 'none')`,
    ),
  ],
);

/**
 * EVENTO del calendario `primary` di una casella, in perimetro come la posta
 * (Fase 6).
 *
 * `fingerprint` (giorno + titolo) è ciò che impedisce di riproporre lo stesso
 * appuntamento quando Google lo restituisce modificato: uno spostamento
 * d'orario nello stesso giorno NON è una proposta nuova. `status` è quello di
 * Google: un evento `cancelled` chiude la riga con un esito, senza mutare
 * niente.
 *
 * Per il calendario NON c'è nessun run del modello: la proposta di milestone è
 * deterministica (titolo + data), quindi qui non esiste una `classification`.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => googleAccounts.id, { onDelete: "cascade" }),
    googleEventId: text("google_event_id").notNull(),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull().default(false),
    attendees: text("attendees").array().notNull().default([]),
    organizer: text("organizer"),
    status: text("status").$type<"confirmed" | "tentative" | "cancelled">(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    proposalNotificationId: uuid("proposal_notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint").notNull(),
    /**
     * L'id dell'evento PADRE su Google se questa occorrenza appartiene a una
     * serie ricorrente (fase 7b). `null` per un evento singolo — la
     * maggioranza. È la chiave con cui {@link calendarSeries} riconosce la
     * serie, insieme ad `accountId`.
     */
    recurringEventId: text("recurring_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("calendar_events_account_event_unique").on(table.accountId, table.googleEventId),
    // "Questo appuntamento l'abbiamo già trattato?": la lettura per fingerprint
    // dentro la casella, fatta per ogni evento di ogni ciclo.
    index("calendar_events_account_fingerprint_idx").on(table.accountId, table.fingerprint),
    // "Le occorrenze di questa serie": la fase D ("gli appuntamenti visti" per
    // serie) e il propose phase (isReadyForProposal consapevole della serie).
    index("calendar_events_account_recurring_idx").on(table.accountId, table.recurringEventId),
    check(
      "calendar_events_status_chk",
      sql`status is null or status in ('confirmed', 'tentative', 'cancelled')`,
    ),
  ],
);

/**
 * CONFIGURAZIONE di una serie ricorrente riconosciuta (fase 7b).
 *
 * Chiavata su `(account_id, recurring_event_id)`: lo stesso
 * `recurring_event_id` che Google mette su ogni occorrenza. Una riga qui non
 * nasce mai da sola — la crea la prima volta che l'utente configura la serie
 * dalla sezione Calendario (`PUT /me/calendar/series/:recurringEventId`); fino
 * ad allora la serie esiste solo come gruppo di righe in `calendar_events`,
 * spenta per definizione (nessuna configurazione = non pronta, vedi
 * `isReadyForProposal` in `apps/worker/src/google/calendar.ts`).
 *
 * `enabled` default `false`: è la lezione delle 730 notifiche del 9 settembre
 * 2026 (design §4) — una serie nuova non deve poter fare niente da sola.
 * `projectId` si FISSA all'attivazione (SET NULL se il progetto viene
 * cancellato: la serie torna a non avere un progetto, e quindi non pronta) e
 * non si ri-deduce mai a ogni occorrenza, a differenza del routing della
 * posta: lo stesso appuntamento ricorrente non deve poter finire su progetti
 * diversi a seconda di chi era invitato quella volta.
 */
export const calendarSeries = pgTable(
  "calendar_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => googleAccounts.id, { onDelete: "cascade" }),
    recurringEventId: text("recurring_event_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    action: text("action").$type<"backlog_item" | "milestone" | "reminder">().notNull().default("milestone"),
    leadDays: integer("lead_days").notNull().default(2),
    /** `false` = propone e aspetta un tap; `true` = esegue e lo rende visibile (design §4: MAI un job AI). */
    auto: boolean("auto").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("calendar_series_account_recurring_unique").on(table.accountId, table.recurringEventId),
    check("calendar_series_lead_days_chk", sql`lead_days between 0 and 30`),
    check(
      "calendar_series_action_chk",
      sql`action in ('backlog_item', 'milestone', 'reminder')`,
    ),
  ],
);

/**
 * PROPOSTA per-progetto di un messaggio email (fase 6b — multi-progetto).
 * `email_messages` resta il messaggio grezzo con un solo esito legacy; questa
 * tabella è la riga FIGLIA, una per ogni progetto nello `scopeProjectIds` del
 * messaggio che ha almeno una proposta: ogni progetto vede, approva e ignora
 * le SUE proposte indipendentemente dagli altri.
 *
 * `classification` è NOT NULL (a differenza di quella, nullable, del
 * messaggio): una riga qui esiste solo quando la classificazione per QUEL
 * progetto è già stata prodotta. `status` e le colonne di esito rispecchiano
 * `email_messages` ma sono per-progetto: la stessa email può essere
 * `actioned` per un progetto e ancora `classified` per un altro.
 *
 * L'unique `(email_message_id, project_id)` è l'idempotenza di chi crea le
 * righe figlie (una sola proposta per coppia messaggio/progetto); il cascade
 * su entrambe le FK segue lo stesso principio di `email_messages`: cancellare
 * il messaggio o il progetto non deve lasciare proposte orfane.
 */
export const emailProposals = pgTable(
  "email_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailMessageId: uuid("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"classified" | "proposed" | "actioned" | "ignored" | "failed">()
      .notNull()
      .default("classified"),
    /** {summary, proposals[], recommendedIndex} DI QUESTO progetto. */
    classification: jsonb("classification").$type<Record<string, unknown>>().notNull(),
    proposalNotificationId: uuid("proposal_notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("email_proposals_email_message_id_project_id_unique").on(
      table.emailMessageId,
      table.projectId,
    ),
    // Claim di una proposta non ancora pubblicata: le sole righe classificate
    // e senza notifica sono candidate al prossimo giro del poller. Parziale
    // (e non su tutto `email_message_id`) perché è lo stesso claim di
    // `email_messages` prima della fase 6b — un progetto alla volta, non
    // l'intera coda.
    index("email_proposals_claim_idx")
      .on(table.emailMessageId)
      .where(sql`status = 'classified' and proposal_notification_id is null`),
    check(
      "email_proposals_status_chk",
      sql`status in ('classified', 'proposed', 'actioned', 'ignored', 'failed')`,
    ),
  ],
);

/** Riga di `google_workspaces`: un Workspace con la sua app OAuth interna. */
export type GoogleWorkspaceRow = typeof googleWorkspaces.$inferSelect;
/** Riga di `google_accounts`: una casella Google collegata da un utente. */
export type GoogleAccountRow = typeof googleAccounts.$inferSelect;
/** Riga di `oauth_states`: il nonce monouso di un flusso OAuth in corso. */
export type OauthStateRow = typeof oauthStates.$inferSelect;
/** Riga di `project_email_routes`: una regola di routing della posta. */
export type ProjectEmailRouteRow = typeof projectEmailRoutes.$inferSelect;
/** Riga di `email_messages`: un messaggio Gmail in perimetro. */
export type EmailMessageRow = typeof emailMessages.$inferSelect;
/** Riga di `calendar_events`: un evento di calendario in perimetro. */
export type CalendarEventRow = typeof calendarEvents.$inferSelect;
/** Riga di `calendar_series`: la configurazione di una serie ricorrente riconosciuta. */
export type CalendarSeriesRow = typeof calendarSeries.$inferSelect;
/** Riga di `email_proposals`: la proposta di UN messaggio per UN progetto. */
export type EmailProposalRow = typeof emailProposals.$inferSelect;
