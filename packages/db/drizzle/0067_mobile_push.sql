-- Notifiche push verso l'app mobile (fase 4). Tre pezzi indipendenti:
-- il canale di consegna nuovo, la preferenza per utente e la tabella dei
-- device token (a quale telefono mandare).
--
-- ⚠️ 'push' NON va usato da nessun altro statement di questa migrazione: il
-- migratore esegue l'intero batch pendente in UNA transazione e Postgres non
-- ammette l'uso di un valore enum aggiunto nella stessa (vedi CLAUDE.md,
-- "Trappola migrazioni drizzle"). Qui il valore si aggiunge soltanto; a
-- scriverlo nelle righe sarà il codice, dopo il commit della migrazione.
ALTER TYPE "public"."delivery_channel" ADD VALUE 'push';--> statement-breakpoint
-- Preferenza di recapito per utente, speculare a `notify_slack_dm`. Default
-- true come il DM: chi non ha registrato un device resta comunque muto, perché
-- senza device attivi non nasce nessuna consegna.
ALTER TABLE "users" ADD COLUMN "notify_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Un'installazione dell'app mobile che può ricevere push. `token` è il token
-- del servizio di notifica del sistema operativo: unico globalmente, perché il
-- sistema lo riassegna e lo stesso token non può restare su due utenti (il
-- reinserimento è un upsert su questa unique, non una riga in più).
--
-- `pat_id` lega il device al Personal Access Token con cui l'app si è
-- autenticata: ON DELETE SET NULL e non CASCADE perché revocare un token è
-- un'operazione di credenziali, non di recapito — la riga sopravvive e resta
-- disattivabile a parte (`disabled_at`).
--
-- La disattivazione è un soft delete con motivo (`disabled_reason`, es. il
-- token rifiutato dal provider): serve a smettere di provarci senza perdere la
-- traccia del perché. `platform` è text con CHECK e non un enum Postgres, così
-- aggiungerne uno domani non richiede una migrazione a sé (vedi sopra).
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pat_id" uuid,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"app_version" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "device_tokens_platform_chk" CHECK ("platform" in ('ios', 'android'))
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_pat_id_personal_access_tokens_id_fk" FOREIGN KEY ("pat_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Destinatari di una push: i device ATTIVI di un utente. Indice parziale, così
-- i device disattivati (token rifiutato, app disinstallata) non pesano sulla
-- query che sta sul percorso di ogni notifica.
CREATE INDEX "device_tokens_user_active_idx" ON "device_tokens" USING btree ("user_id") WHERE "disabled_at" IS NULL;
