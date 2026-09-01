-- Registro plugin d'istanza (fase 3): repo git pubblici pinnati a uno sha,
-- materializzati dal worker su un volume (`/plugins/<slug>/<sha>/`) e
-- abilitabili per progetto. Qui stanno solo i metadati: i file del plugin
-- vivono sul volume, che il server non monta (legge `inventory` dal DB).
--
-- ⚠️ `status`, `smoke_status` e `kind`/`status` dei job sono colonne `text`
-- SENZA enum Postgres né CHECK (come `repo_graphs`/`graph_jobs`): il vincolo è
-- compile-time (`text(..., { enum: [...] })` in schema.ts) più la validazione
-- applicativa. Un enum Postgres richiederebbe di aggiungerne i valori in una
-- migrazione a sé (il migratore esegue l'intero batch in UNA transazione).
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"source_url" text NOT NULL,
	"source_subdir" text,
	"ref" text NOT NULL,
	"resolved_sha" text,
	"status" text DEFAULT 'none' NOT NULL,
	"inventory" jsonb,
	"error" text,
	"smoke_status" text DEFAULT 'idle' NOT NULL,
	"smoke_error" text,
	"materialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "plugin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Abilitazioni per progetto. Gli spegnimenti sono per SOTTRAZIONE (default:
-- tutto acceso): `disabled_skills` sono nomi di skill dell'inventario,
-- `disabled_hooks` chiavi `<Evento>#<indice>` (es. `SessionStart#0`).
CREATE TABLE "project_plugins" (
	"project_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_skills" text[] DEFAULT '{}' NOT NULL,
	"disabled_hooks" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plugins_project_id_plugin_id_pk" PRIMARY KEY("project_id","plugin_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plugins" ADD CONSTRAINT "project_plugins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plugins" ADD CONSTRAINT "project_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Al più un job ATTIVO per (plugin, kind): è il vincolo che impedisce due
-- materializzazioni concorrenti della stessa dir. Indice unico PARZIALE, quindi
-- lo storico dei job done/failed non vi partecipa.
CREATE UNIQUE INDEX "plugin_jobs_active_unique" ON "plugin_jobs" USING btree ("plugin_id","kind") WHERE status IN ('queued', 'running');--> statement-breakpoint
-- Claim del worker: il job in coda più vecchio (FIFO). Parziale sui soli
-- `queued`, come `backlog_jobs_queued_created_at_idx`.
CREATE INDEX "plugin_jobs_queued_created_at_idx" ON "plugin_jobs" USING btree ("created_at") WHERE status = 'queued';
