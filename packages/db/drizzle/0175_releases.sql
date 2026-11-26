-- Area 8, fetta 1 (13 nov 2026): i rilasci. Piano in
-- `docs/plans/2026-11-13-integrazione-area8-fetta1-plan.md`.
--
-- Il valore d'enum nuovo sta in uno statement a sé e nessuno lo usa in questo
-- batch (il migratore gira in UNA transazione, vedi CLAUDE.md).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'release.failed';
--> statement-breakpoint
-- Un rilascio = un merge di una PR sul ramo di rilascio del repository, da
-- Stubwise o da fuori (S-3 = a). Lo STATO non si salva: si deriva dalle run
-- di CI (`release_ci_runs`) o dal commit in produzione.
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"seq" integer NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer,
	"pr_url" text NOT NULL,
	"title" text NOT NULL,
	"merge_sha" text NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"merged_by" uuid,
	"merged_git_name" text,
	"via_stubwise" boolean NOT NULL,
	"release_notes" text,
	"seen_in_production_at" timestamp with time zone,
	"runs_settled_at" timestamp with time zone,
	"fix_ticket_id" uuid,
	"failed_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_merged_by_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_fix_ticket_id_tickets_id_fk" FOREIGN KEY ("fix_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "releases_code_idx" ON "releases" USING btree ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX "releases_project_seq_idx" ON "releases" USING btree ("project_id", "seq");
--> statement-breakpoint
-- Una riconsegna del webhook, o il merge da Stubwise e il webhook della stessa PR, non creano un secondo rilascio.
CREATE UNIQUE INDEX "releases_repository_merge_idx" ON "releases" USING btree ("repository_id", "merge_sha");
--> statement-breakpoint
-- Una PR si mergia una volta sola: la deduplica fra il merge da Stubwise e il webhook anche quando
-- un provider dà il commit di merge abbreviato (Bitbucket) e l'altra strada intero.
CREATE UNIQUE INDEX "releases_repository_pr_idx" ON "releases" USING btree ("repository_id", "pr_number") WHERE "pr_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "releases_project_merged_idx" ON "releases" USING btree ("project_id", "merged_at" DESC);
--> statement-breakpoint
-- La sequenza dei codici per progetto (`<PRJ>-V<n>`): un codice non torna mai.
CREATE TABLE "release_code_seqs" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_code_seqs" ADD CONSTRAINT "release_code_seqs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Le run di CI del commit di merge, lette dal provider col token dell'account del repository (S-2 = a).
CREATE TABLE "release_ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"provider_run_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"failed_step" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_ci_runs_status_chk" CHECK ("status" IN ('running', 'success', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "release_ci_runs" ADD CONSTRAINT "release_ci_runs_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "release_ci_runs_release_run_idx" ON "release_ci_runs" USING btree ("release_id", "provider_run_id");
--> statement-breakpoint
-- Le impostazioni del repository per i rilasci (null = il ramo di default; nessuna pipeline nota = `auto`).
ALTER TABLE "repositories" ADD COLUMN "release_branch" text;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "release_pipeline" jsonb DEFAULT '{"mode":"auto"}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "ci_provider" text;
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ci_provider_chk" CHECK ("ci_provider" IS NULL OR "ci_provider" IN ('github_actions', 'bitbucket_pipelines'));
--> statement-breakpoint
-- Le PR dei colleghi (invariante «Le PR dei colleghi», 13 nov 2026). P-2 = a:
-- i repository già collegati partono in «solo analisi», nessun push nuovo sui
-- rami dei colleghi il giorno del deploy.
ALTER TABLE "repositories" ADD COLUMN "colleague_prs" text DEFAULT 'analyze_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_colleague_prs_chk" CHECK ("colleague_prs" IN ('analyze_and_fix', 'analyze_only', 'off'));
--> statement-breakpoint
-- «Solo analisi» su una singola PR (chi ha `prs.adopt` nel progetto).
ALTER TABLE "pr_reviews" ADD COLUMN "analysis_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "analysis_only_by" uuid;
--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "analysis_only_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_analysis_only_by_users_id_fk" FOREIGN KEY ("analysis_only_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Le note di rilascio di una PR (fermate nel rilascio al merge).
CREATE TABLE "pr_release_notes" (
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"body" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_release_notes_pk" PRIMARY KEY ("repository_id", "pr_number")
);
--> statement-breakpoint
ALTER TABLE "pr_release_notes" ADD CONSTRAINT "pr_release_notes_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pr_release_notes" ADD CONSTRAINT "pr_release_notes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- R-L2: su quale server gira una repository in un ambiente (repository diverse dello stesso progetto su server diversi).
CREATE TABLE "environment_servers" (
	"environment_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	CONSTRAINT "environment_servers_pk" PRIMARY KEY ("environment_id", "repository_id")
);
--> statement-breakpoint
ALTER TABLE "environment_servers" ADD CONSTRAINT "environment_servers_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_servers" ADD CONSTRAINT "environment_servers_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_servers" ADD CONSTRAINT "environment_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "environment_servers_server_idx" ON "environment_servers" USING btree ("server_id");
--> statement-breakpoint
-- I dati di oggi: il server di un ambiente vale per tutte le repository del progetto.
-- `project_environments.server_id` resta, inerte, per il rollback.
INSERT INTO "environment_servers" ("environment_id", "repository_id", "server_id")
SELECT e."id", r."id", e."server_id"
FROM "project_environments" e
JOIN "repositories" r ON r."project_id" = e."project_id"
WHERE e."server_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- [R 12]: una sola produzione per progetto. Se i dati di oggi ne hanno più d'una, la migrazione lo dice e si ferma.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "project_environments" WHERE "kind" = 'production' GROUP BY "project_id" HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'area 8, F1: un progetto ha piu di un ambiente di produzione; tienine uno prima di applicare la 0175';
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_environments_one_production_idx" ON "project_environments" USING btree ("project_id") WHERE "kind" = 'production';
--> statement-breakpoint
-- `release_page` della Chat (area 4, [DECIDE] 1 = a): un rilascio nuovo nei canali che l'hanno acceso.
CREATE FUNCTION "chat_event_release_page"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "chat_publish_event"(NEW."project_id", 'release_page', 'release', NEW."id", NULL);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "releases_chat_release_page" AFTER INSERT ON "releases"
	FOR EACH ROW EXECUTE FUNCTION "chat_event_release_page"();
