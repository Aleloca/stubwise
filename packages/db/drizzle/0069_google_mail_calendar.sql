-- Fase 6 — Gmail e Calendar. Tutto additivo: due valori di enum, sei tabelle
-- nuove, una colonna owner su `agent_runs`, un toggle webhook e un CHECK
-- allargato. Nessuna colonna rimossa, nessun default cambiato sotto i piedi di
-- chi legge già queste tabelle.
--
-- ⚠️ 'google.proposal' e 'email_classify' NON vanno usati da nessun altro
-- statement di questa migrazione: il migratore esegue l'intero batch pendente
-- in UNA transazione e Postgres non ammette l'uso di un valore enum aggiunto
-- nella stessa (vedi CLAUDE.md, "Trappola migrazioni drizzle"). Qui i valori si
-- aggiungono soltanto; a scriverli nelle righe saranno il poller Google e le
-- proposte, dopo il commit. È anche il motivo per cui l'indice sulle proposte,
-- in fondo, NON è parziale su `kind` (vedi il commento lì).
ALTER TYPE "public"."notification_kind" ADD VALUE 'google.proposal';--> statement-breakpoint
-- Fase dei run dell'agente che classificano i segnali di una email. Entra come
-- valore di enum — al contrario degli stati testuali qui sotto — perché
-- `agent_runs.phase` è un enum Postgres da sempre: allinearlo è l'unica strada.
ALTER TYPE "public"."agent_run_phase" ADD VALUE 'email_classify';--> statement-breakpoint
-- Sorgente nuova del REGISTRO DECISIONI: la conferma di una proposta nata da
-- una email. `source` è text con CHECK (non un enum), quindi allargarlo si fa
-- qui, in DROP + ADD, senza una migrazione a sé.
--
-- ⚠️ Il registro resta scritto da TEMPLATE i18n, mai da un run del modello:
-- l'origine `email` non è un'eccezione (vedi CLAUDE.md e
-- `decisions-never-ai.test.ts`).
ALTER TABLE "project_decisions" DROP CONSTRAINT "project_decisions_source_chk";--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_source_chk" CHECK ("source" in ('ask_user', 'plan_review', 'pulse', 'manual', 'email'));--> statement-breakpoint
-- Toggle webhook del kind nuovo, speculare a `notify_pulse`/`notify_brief`.
-- Default true come gli altri: l'interruttore generale e i toggle per-evento
-- restano l'unico posto in cui si spegne un recapito.
ALTER TABLE "notification_settings" ADD COLUMN "notify_google_proposal" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Un Google Workspace registrato dall'admin, con l'app OAuth **interna** creata
-- nella sua Google Cloud Console. `client_secret_encrypted` è il blob
-- AES-256-GCM (vedi `secrets.ts`): non esce mai in chiaro dall'API, che risponde
-- col solo `clientSecretSet`.
--
-- `domains` sono i domini email del Workspace, normalizzati lowercase: il
-- callback OAuth RIFIUTA una casella il cui dominio non è qui dentro. È il
-- confine fra "casella aziendale" e un account Google qualunque.
CREATE TABLE "google_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domains" text[] NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Una casella collegata da un utente (N per utente). NESSUN access token è
-- persistito: c'è solo il refresh token cifrato, e il worker ottiene l'access
-- token a ogni ciclo, in memoria.
--
-- `workspace_id` è RESTRICT e non cascade: togliere un Workspace con caselle
-- vive è un errore dell'admin, non un'operazione da eseguire in silenzio (la
-- rotta risponde 409 `workspace_in_use`). `user_id` invece cascata: le caselle
-- sono dati personali di quell'utente e se ne vanno con lui.
--
-- `next_sync_at` (default now()) è il claim del poller: la casella appena
-- collegata è già dovuta al primo tick. `sync_attempts` è il contatore del
-- backoff; `disabled_at` + `disabled_reason` la disabilitazione (fatale da
-- Google, o troppi errori transitori di fila).
CREATE TABLE "google_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"google_sub" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"proposals_enabled" boolean DEFAULT true NOT NULL,
	"gmail_history_id" text,
	"calendar_sync_token" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "google_accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "google_accounts_disabled_reason_chk" CHECK ("disabled_reason" is null or "disabled_reason" in ('revoked', 'invalid_grant', 'insufficient_scope', 'workspace_removed', 'sync_failed'))
);
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_workspace_id_google_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."google_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Le caselle di un utente si leggono insieme (pagina Account, pagina Posta).
CREATE INDEX "google_accounts_user_id_idx" ON "google_accounts" USING btree ("user_id");--> statement-breakpoint
-- Claim del poller: la prossima casella dovuta. Indice PARZIALE sulle sole
-- caselle vive e con le proposte accese — le disabilitate e le spente non
-- vengono mai pescate, quindi non devono nemmeno stare nell'indice.
CREATE INDEX "google_accounts_due_idx" ON "google_accounts" USING btree ("next_sync_at") WHERE "disabled_at" is null and "proposals_enabled";--> statement-breakpoint
-- Lo `state` OAuth è firmato HMAC, ma una firma valida da sola non impedisce il
-- REPLAY: questa riga è il nonce monouso che lo impedisce, e `expires_at` la
-- finestra di 10 minuti oltre la quale il callback non è più accettato.
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_workspace_id_google_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."google_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Potatura degli state scaduti.
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
-- Regole che dicono quale posta riguarda quale progetto. `value` è normalizzato
-- lowercase da chi scrive, così l'unique `(project_id, kind, value)` è davvero
-- la stessa regola e non due grafie della stessa cosa.
CREATE TABLE "project_email_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_email_routes_project_kind_value_unique" UNIQUE("project_id","kind","value"),
	CONSTRAINT "project_email_routes_kind_chk" CHECK ("kind" in ('sender_domain', 'sender_address', 'gmail_label', 'keyword'))
);
--> statement-breakpoint
ALTER TABLE "project_email_routes" ADD CONSTRAINT "project_email_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Un messaggio Gmail IN PERIMETRO (le regole di routing di almeno un progetto
-- l'hanno riconosciuto): quelli fuori perimetro non vengono nemmeno scaricati,
-- e qui dentro non esistono.
--
-- `text_excerpt` è il testo già ripulito e CAPATO (≤ 20k con marcatore): non
-- teniamo il MIME originale, e gli allegati non entrano affatto. `project_id` è
-- il progetto risolto (SET NULL: cancellarlo non cancella la posta), i
-- `candidate_project_ids` i progetti in parità quando le regole non decidono.
--
-- `status` e `signal` sono text con CHECK e non enum Postgres: allargarli si fa
-- dentro la migrazione che serve, mentre un valore di enum ne richiede una
-- separata dal batch (vedi in cima).
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" text[] DEFAULT '{}' NOT NULL,
	"subject" text,
	"received_at" timestamp with time zone NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"text_excerpt" text,
	"project_id" uuid,
	"candidate_project_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"signal" text,
	"classification" jsonb,
	"proposal_notification_id" uuid,
	"outcome" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_account_message_unique" UNIQUE("account_id","gmail_message_id"),
	CONSTRAINT "email_messages_status_chk" CHECK ("status" in ('new', 'classified', 'proposed', 'actioned', 'ignored', 'failed')),
	CONSTRAINT "email_messages_signal_chk" CHECK ("signal" is null or "signal" in ('decision', 'request', 'deadline', 'blocker', 'none'))
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_account_id_google_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."google_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_proposal_notification_id_notifications_id_fk" FOREIGN KEY ("proposal_notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Fase 2 del tick del poller: i messaggi `new` di una casella, da classificare.
CREATE INDEX "email_messages_account_status_idx" ON "email_messages" USING btree ("account_id","status");--> statement-breakpoint
-- La posta di un progetto, dalla più recente (pagina Posta, contesto).
CREATE INDEX "email_messages_project_received_idx" ON "email_messages" USING btree ("project_id","received_at" DESC);--> statement-breakpoint
-- Un evento del calendario `primary` di una casella, in perimetro come sopra.
-- `fingerprint` (giorno + titolo) è ciò che impedisce di riproporre lo stesso
-- appuntamento quando Google lo rimanda indietro modificato: uno spostamento
-- d'orario nello stesso giorno NON è una proposta nuova.
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"google_event_id" text NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"attendees" text[] DEFAULT '{}' NOT NULL,
	"organizer" text,
	"status" text,
	"project_id" uuid,
	"proposal_notification_id" uuid,
	"outcome" jsonb,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_account_event_unique" UNIQUE("account_id","google_event_id"),
	CONSTRAINT "calendar_events_status_chk" CHECK ("status" is null or "status" in ('confirmed', 'tentative', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_account_id_google_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."google_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_proposal_notification_id_notifications_id_fk" FOREIGN KEY ("proposal_notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- "Questo appuntamento l'abbiamo già trattato?": la lettura per fingerprint
-- dentro la casella, fatta per ogni evento di ogni ciclo.
CREATE INDEX "calendar_events_account_fingerprint_idx" ON "calendar_events" USING btree ("account_id","fingerprint");--> statement-breakpoint
-- TERZO OWNER di un run dell'agente, accanto a `job_id` e `pr_review_id`: la
-- classificazione dei segnali di una email. Serve a far comparire la posta in
-- Usage con lo stesso metro dei fix, invece di essere un costo invisibile.
--
-- ON DELETE **cascade** e non set null: il check qui sotto vuole esattamente un
-- owner valorizzato, quindi un run svuotato lo violerebbe e la retention dei
-- messaggi non riuscirebbe più a cancellare nulla. È anche il comportamento
-- degli altri due owner.
ALTER TABLE "agent_runs" ADD COLUMN "email_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_owner_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_check" CHECK (num_nonnulls(job_id, pr_review_id, email_message_id) = 1);--> statement-breakpoint
-- Aggregazione del costo per messaggio + cascade delete da `email_messages`.
CREATE INDEX "agent_runs_email_message_id_idx" ON "agent_runs" USING btree ("email_message_id");--> statement-breakpoint
-- Claim di una proposta: `propagateHandled` chiude in un colpo solo tutte le
-- copie della notifica con lo stesso `event->>'proposalId'` (oggi una sola —
-- l'audience è il proprietario della casella — ma la query è la stessa del
-- pulse, che di copie ne ha N).
--
-- ⚠️ La condizione parziale è `IS NOT NULL` e NON `kind = 'google.proposal'`:
-- quel literal userebbe il valore di enum aggiunto in cima a QUESTA
-- transazione, e Postgres lo rifiuterebbe ("unsafe use of new value"). La
-- forma scelta indicizza comunque le sole righe che portano un `proposalId` —
-- oggi esattamente quelle del kind nuovo — e resta usabile dal planner, perché
-- `event->>'proposalId' = $1` implica `IS NOT NULL` (l'operatore è strict).
CREATE INDEX "notifications_proposal_id_idx" ON "notifications" USING btree (("event"->>'proposalId')) WHERE ("event"->>'proposalId') is not null;
