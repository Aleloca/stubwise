-- Chat con Claude, fetta 5 (10 nov 2026): le conversazioni PUBBLICHE e la
-- continuazione. Decisioni del maintainer nel piano
-- `docs/plans/2026-11-10-integrazione-claude-chat-f5-plan.md`.
--
-- `visibility`: privata (dell'autore) o pubblica (chi ha `claude.public.view`
-- la LEGGE). `published_project_ids`: i progetti che l'autore ha confermato
-- pubblicando. `private_from_event_id`: il primo evento che i lettori NON
-- ricevono (il seguito privato: un turno in corso, o che ha toccato un
-- progetto nuovo). `visibility_changed_at`: da quando riparte la finestra
-- della potatura dopo «Make private» (una pubblica non si pota, D5).
-- `continues_from_session_id`: la pubblica da cui nasce una continuazione.
ALTER TABLE "claude_conversations" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD CONSTRAINT "claude_conversations_visibility_chk" CHECK ("visibility" in ('private', 'public'));
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "published_by" uuid;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD CONSTRAINT "claude_conversations_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "published_project_ids" uuid[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "private_from_event_id" bigint;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "visibility_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD COLUMN "continues_from_session_id" uuid;
--> statement-breakpoint
ALTER TABLE "claude_conversations" ADD CONSTRAINT "claude_conversations_continues_from_fk" FOREIGN KEY ("continues_from_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "claude_conversations_public_idx" ON "claude_conversations" USING btree ("visibility","updated_at");
--> statement-breakpoint
-- I progetti LETTI O TOCCATI da Claude in una conversazione (D2: li scrive il
-- server, da ciò che sa; mai un dato letto, solo il progetto e l'evento).
CREATE TABLE "claude_conversation_projects" (
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"first_event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_conversation_projects_pk" PRIMARY KEY("session_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "claude_conversation_projects" ADD CONSTRAINT "claude_conversation_projects_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."claude_conversations"("session_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_conversation_projects" ADD CONSTRAINT "claude_conversation_projects_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- D4: `claude.public.view` al preset d'istanza User (l'Admin è full admin e
-- lo ha implicito). `distinct unnest` come la 0114: idempotente anche su un
-- preset già modificato.
--
-- E a OGNI ruolo d'istanza che conteneva già tutti i permessi del preset User
-- di prima (decisione del maintainer, 10 nov 2026; invariante «un permesso
-- nuovo dato a un preset si dà anche ai ruoli che lo contenevano» in
-- `docs/invariants/permissions.md`): chi stava sopra un User — un ruolo
-- fatto a mano con `users.manage` — ci resta, e non riceve `target_above`
-- per il solo permesso nuovo.
UPDATE "roles"
SET "permissions" = ARRAY(
	SELECT DISTINCT p FROM unnest("permissions" || ARRAY['claude.public.view']) AS p
)
WHERE "preset_key" = 'user'
	OR ("scope" = 'instance'
		AND "permissions" @> ARRAY['monitor.view', 'users.view_all', 'git_accounts.view', 'mail_admission.view']::text[]);
