-- Fase 5 — roadmap e narrativa. Tutto additivo: un valore enum, quattro
-- colonne nullable (più un toggle con default), un NOT NULL tolto e due tabelle
-- nuove. Nessuna colonna rimossa, nessun default cambiato sotto i piedi di chi
-- legge già queste tabelle.
--
-- ⚠️ 'project.brief' NON va usato da nessun altro statement di questa
-- migrazione: il migratore esegue l'intero batch pendente in UNA transazione e
-- Postgres non ammette l'uso di un valore enum aggiunto nella stessa (vedi
-- CLAUDE.md, "Trappola migrazioni drizzle"). Qui il valore si aggiunge
-- soltanto; a scriverlo nelle righe sarà il poller del brief, dopo il commit.
--
-- Il valore entra ORA anche se il kind non viene pubblicato prima della fase D
-- della roadmap: un valore enum richiede comunque una migrazione a sé, e
-- averlo già in DB permette alla fase D di essere solo codice.
ALTER TYPE "public"."notification_kind" ADD VALUE 'project.brief';--> statement-breakpoint
-- Riassunto "in breve" del piano, per non-tecnici. Vive e muore con
-- `plan_text`: lo scrive lo stesso UPDATE guardato che parcheggia il job sul
-- gate di approvazione, e il rifiuto del piano azzera entrambi. Null = run di
-- sintesi fallito o riassunti spenti: il gate funziona lo stesso.
ALTER TABLE "ai_jobs" ADD COLUMN "plan_summary" text;--> statement-breakpoint
-- Riassunto "in breve" della PR, scritto dalla review nella stessa transazione
-- di `verdict`/`summary`. Null = nessuna review, review scartata dal cap di
-- costo o run di sintesi fallito.
ALTER TABLE "pr_reviews" ADD COLUMN "pr_summary" text;--> statement-breakpoint
-- Riparazione della creazione milestone: `repository_id` era NOT NULL "per
-- continuità" con i dati della fase 1, ma la UI non lo manda mai e la POST
-- falliva. Una milestone appartiene al PROGETTO; il repo, quando c'è, è un
-- dettaglio d'origine. Le righe esistenti restano valorizzate.
ALTER TABLE "milestones" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
-- `description`: testo libero della milestone (la UI lo chiedeva già).
-- `closed_at`: quando la milestone è passata a `closed`. Serve alla timeline
-- di progetto, che ha bisogno di una DATA per collocare l'evento; `status` da
-- solo dice che è chiusa, non quando. Riaprirla lo rimette a NULL.
ALTER TABLE "milestones" ADD COLUMN "description" text, ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
-- Brief settimanale per progetto: opt-in esplicito, indipendente dal backlog
-- (a differenza del pulse, che senza backlog non avrebbe nulla da proporre).
-- Al deploy nessun progetto riceve brief.
ALTER TABLE "projects" ADD COLUMN "weekly_brief_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Toggle webhook del kind nuovo, speculare a `notify_pulse`. Default true come
-- gli altri: l'interruttore generale e i toggle per-evento restano l'unico
-- posto in cui si spegne un recapito.
ALTER TABLE "notification_settings" ADD COLUMN "notify_brief" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Un brief per progetto e settimana. `status` è text con CHECK e non un enum
-- Postgres: sostituire un CHECK si fa in DROP + ADD dentro la migrazione che
-- serve, mentre un valore di enum richiede una migrazione SEPARATA dal batch
-- (vedi sopra). `period_start`/`period_end` sono DATE (giorni di calendario nel
-- fuso di invio, non istanti): la settimana non è un intervallo di istanti.
--
-- `notification_id` ON DELETE SET NULL: la notifica si può archiviare o
-- cancellare, il brief resta leggibile dalla roadmap. `attempts` +
-- `last_activity_at` sono il recovery degli orfani, come per i report
-- giornalieri: un `running` la cui attività è vecchia torna `queued`.
CREATE TABLE "project_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"summary" text,
	"sections" jsonb,
	"notification_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "project_briefs_project_period_unique" UNIQUE("project_id","period_start"),
	CONSTRAINT "project_briefs_status_chk" CHECK ("status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Registro delle decisioni PRESE DAGLI UMANI su un progetto. NON è mai scritto
-- dall'AI: i writer automatici (risposta a una domanda, approvazione/rifiuto di
-- un piano, "Procedi" del pulse) compongono i testi da template i18n, e le voci
-- manuali le scrive una persona. Il brief e i riassunti sono narrativa, questo
-- è il fatto.
--
-- `source_key` è la chiave di IDEMPOTENZA (es. `question:<id>`,
-- `plan_review:<jobId>:<n>`, `pulse:<notificationId>`): l'unique con
-- `project_id` fa sì che un replay del writer non aggiunga una seconda riga.
-- `source` è text con CHECK, per la stessa ragione di `status` sopra.
--
-- `ticket_id` ON DELETE SET NULL: cancellare il ticket non cancella la
-- decisione — è proprio lo storico che deve sopravvivere. `decided_by_user_id`
-- idem con l'utente. `superseded_by_id` è la self-reference che marca una
-- decisione superata da un'altra, senza cancellare la prima.
CREATE TABLE "project_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"source_ref" jsonb,
	"ticket_id" uuid,
	"title" text NOT NULL,
	"context" text,
	"decision" text NOT NULL,
	"consequences" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_decisions_project_source_key_unique" UNIQUE("project_id","source_key"),
	CONSTRAINT "project_decisions_source_chk" CHECK ("source" in ('ask_user', 'plan_review', 'pulse', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_superseded_by_id_project_decisions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."project_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Le decisioni si leggono sempre per progetto, dalla più recente (registro,
-- sezione Docs, contesto della chat, tool MCP).
CREATE INDEX "project_decisions_project_decided_idx" ON "project_decisions" USING btree ("project_id","decided_at" DESC);--> statement-breakpoint
-- I brief si leggono per progetto, dal periodo più recente (lista API, brief
-- precedente per la continuità, separatori della roadmap).
CREATE INDEX "project_briefs_project_period_idx" ON "project_briefs" USING btree ("project_id","period_start" DESC);
