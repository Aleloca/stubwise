-- Ciclo di correzione post-PR (30 set 2026, design
-- `docs/plans/2026-09-30-pr-correction-loop-design.md` §4). Additiva, NESSUN
-- `ALTER TYPE`, un solo batch: `trigger` e `status` sono CHECK e non pgEnum,
-- stesso motivo di `calendar_series.action` (7b) ed `email_rejections.reason`.
--
-- `pr_corrections`: una riga per correzione CHIESTA (dalla review, dal bottone
-- di Stubwise o da "Request changes" sul provider). NON ha un `ai_job_id`: il
-- collegamento è solo `ai_jobs.correction_id` (UNIQUE), così non esiste una FK
-- circolare fra le due tabelle.
--
-- `status`:
--   pending   → richiesta umana arrivata mentre un'altra correzione (o un job)
--               era in volo: aspetta, UNA per PR (indice unico parziale);
--   queued    → ha un job creato e non ancora terminale: UNA per PR;
--   done      → il suo job è terminato (bene o male: l'esito sta sul job);
--   cancelled → la PR si è chiusa prima che partisse o finisse.
--
-- `provider_feedback` è una FOTOGRAFIA dei commenti della PR presa alla
-- richiesta: un commento modificato dopo non cambia ciò che l'AI ha letto.
-- `feedback_complete` dice se quella fotografia è stata letta DAVVERO dal
-- provider: solo allora la correzione fa da taglio per i commenti successivi
-- (una lettura fallita non deve far saltare per sempre i commenti mai letti).
CREATE TABLE "pr_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by_user_id" uuid,
	"requested_by_provider_login" text,
	"review_id" uuid,
	"note" text,
	"provider_feedback" jsonb,
	"feedback_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_corrections_trigger_chk" CHECK ("trigger" in ('review', 'stubwise', 'provider')),
	CONSTRAINT "pr_corrections_status_chk" CHECK ("status" in ('pending', 'queued', 'done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "pr_corrections" ADD CONSTRAINT "pr_corrections_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_corrections" ADD CONSTRAINT "pr_corrections_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_corrections" ADD CONSTRAINT "pr_corrections_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_corrections" ADD CONSTRAINT "pr_corrections_review_id_pr_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."pr_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Il contatore dei giri e lo stato del ciclo leggono le correzioni di UNA PR
-- in ordine di creazione.
CREATE INDEX "pr_corrections_repository_pr_created_at_idx" ON "pr_corrections" USING btree ("repository_id","pr_number","created_at");--> statement-breakpoint
-- Una sola richiesta in attesa e una sola correzione attiva per PR (design §6):
-- è il DB, non il codice, a rendere impossibile la seconda.
CREATE UNIQUE INDEX "pr_corrections_pending_unique" ON "pr_corrections" USING btree ("repository_id","pr_number") WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "pr_corrections_queued_unique" ON "pr_corrections" USING btree ("repository_id","pr_number") WHERE "status" = 'queued';--> statement-breakpoint

-- Il job di una correzione. Valorizzata = il worker salta il triage e va in
-- `runCorrection`. NON è un valore nuovo di `resume_mode` (la trappola di
-- `resolveFixMode`: un valore dimenticato degrada in silenzio a fix completo).
ALTER TABLE "ai_jobs" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_correction_id_unique" UNIQUE("correction_id");--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_correction_id_pr_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."pr_corrections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- L'account revisore (facoltativo) e l'identità degli account sulla
-- piattaforma, che serve a scartare gli eventi generati da noi stessi (§5).
ALTER TABLE "repositories" ADD COLUMN "review_git_account_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_review_git_account_id_git_accounts_id_fk" FOREIGN KEY ("review_git_account_id") REFERENCES "public"."git_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_accounts" ADD COLUMN "provider_user_id" text;--> statement-breakpoint

-- Il tetto dei giri automatici per tornata. 0 = ciclo automatico spento; il
-- 10 è un paracadute, non una raccomandazione.
ALTER TABLE "projects" ADD COLUMN "pr_correction_max_rounds" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pr_correction_max_rounds_chk" CHECK ("pr_correction_max_rounds" BETWEEN 0 AND 10);--> statement-breakpoint

-- Il numero della PR come dato, non più solo dentro l'URL. BACKFILL, non
-- cosmetico: senza, ogni PR storica di Stubwise resterebbe senza ciclo.
-- Variante PIÙ PERMISSIVA di `parsePrNumberFromUrl` (@stubwise/git): accetta
-- GitHub `/pull/N`, Bitbucket `/pull-requests/N` e in più `/pulls/N`, e non
-- richiede il confine di parola dopo il numero. Gli URL salvati sono però
-- quelli html (GitHub `html_url`, Bitbucket `links.html.href`), quindi nella
-- pratica le due danno lo stesso risultato. Un URL che non combacia resta
-- NULL: mai un numero inventato.
ALTER TABLE "ticket_repositories" ADD COLUMN "pr_number" integer;--> statement-breakpoint
UPDATE "ticket_repositories"
SET "pr_number" = substring("pr_url" from '/pull(?:-requests|s)?/([0-9]+)')::int
WHERE "pr_url" IS NOT NULL;
--> statement-breakpoint

-- La review ESISTE dal claim, non da quando parte (piano, C10). Il poller
-- reclama il job con DELETE…RETURNING su `pr_review_jobs` e nella STESSA
-- transazione crea la riga `pr_reviews` `running` "in attesa"
-- (`started_at` NULL): altrimenti, mentre il job aspetta nel serializer di
-- progetto (in memoria), né la coda né lo storico lo vedono e il ciclo della
-- PR si legge `idle` con il bottone della correzione attivo. `runPrReview`
-- riusa quella riga e scrive `started_at = now()` quando parte davvero.
-- Colonna e non valore di `pr_review_status`: quello è un pgEnum, e un
-- `ALTER TYPE … ADD VALUE` qui romperebbe il batch unico.
--   started_at NULL  + running → in attesa nel serializer (il recovery degli
--                                stantii NON la chiude; all'avvio del worker
--                                torna in `pr_review_jobs` e la riga sparisce);
--   started_at !NULL + running → partita (heartbeat su `last_activity_at`).
-- `pr_body`/`source_branch`/`target_branch` sono i metadati del job che
-- `pr_reviews` non aveva: servono a rimettere in coda una riga in attesa al
-- riavvio senza richiamare il provider. NULL sulle righe storiche, mai lette.
ALTER TABLE "pr_reviews" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "pr_body" text;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "source_branch" text;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "target_branch" text;--> statement-breakpoint
-- BACKFILL, non cosmetico: ogni review già esistente (anche una `running` in
-- volo al deploy) è PARTITA. Senza, il recovery non chiuderebbe più una
-- `running` orfana del worker vecchio, e l'avvio del worker nuovo la
-- scambierebbe per una in attesa e la cancellerebbe.
UPDATE "pr_reviews" SET "started_at" = "created_at";
