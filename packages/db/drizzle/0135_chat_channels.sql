-- Area 4, Chat, fetta 1 (10 nov 2026): canali, membri, messaggi, reazioni,
-- letture, preferenze, thread seguiti. Design e decisioni in
-- `docs/plans/2026-11-10-integrazione-area4-chat-design.md`; piano in
-- `docs/plans/2026-11-10-integrazione-area4-fetta1-plan.md`.
CREATE TABLE "chat_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'open' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"is_general" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"published_events" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_channels_kind_chk" CHECK ("kind" in ('project', 'general', 'dm')),
	CONSTRAINT "chat_channels_visibility_chk" CHECK ("visibility" in ('open', 'private')),
	CONSTRAINT "chat_channels_project_chk" CHECK (("kind" = 'project') = ("project_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_channels_project_idx" ON "chat_channels" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_one_general_idx" ON "chat_channels" USING btree ("project_id") WHERE "chat_channels"."is_general";
--> statement-breakpoint
-- Un nome per progetto (anche fra gli archiviati: il prototipo non li riusa).
CREATE UNIQUE INDEX "chat_channels_project_name_idx" ON "chat_channels" USING btree ("project_id", "name") WHERE "chat_channels"."project_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "chat_channel_members" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_channel_members_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_channel_members_user_idx" ON "chat_channel_members" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" text DEFAULT 'person' NOT NULL,
	"called_by_id" uuid,
	"thread_root_id" uuid,
	"body" text NOT NULL,
	"mentioned_ids" uuid[] DEFAULT '{}' NOT NULL,
	"asks_reply_of" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Ogni cambio del messaggio (modifica, eliminazione, reazione, una risposta
	-- sulla radice) lo porta avanti: lo stream manda ciò che è cambiato dopo.
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"via_claude_action_id" uuid,
	CONSTRAINT "chat_messages_kind_chk" CHECK ("kind" in ('person', 'system', 'claude')),
	CONSTRAINT "chat_messages_deleted_chk" CHECK ("deleted_at" is null or "body" = '')
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_called_by_fk" FOREIGN KEY ("called_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_root_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_deleted_by_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_messages_channel_idx" ON "chat_messages" USING btree ("channel_id","created_at");
--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_root_id","created_at");
--> statement-breakpoint
CREATE INDEX "chat_messages_updated_idx" ON "chat_messages" USING btree ("channel_id","updated_at");
--> statement-breakpoint
CREATE TABLE "chat_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_reactions_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "chat_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"last_read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_thread_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_reads_channel_idx" ON "chat_reads" USING btree ("user_id","channel_id") WHERE "chat_reads"."thread_root_id" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_reads_thread_idx" ON "chat_reads" USING btree ("user_id","thread_root_id") WHERE "chat_reads"."thread_root_id" is not null;
--> statement-breakpoint
CREATE TABLE "chat_channel_prefs" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "chat_channel_prefs_pk" PRIMARY KEY("user_id","channel_id"),
	CONSTRAINT "chat_channel_prefs_level_chk" CHECK ("level" in ('all', 'mentions', 'muted'))
);
--> statement-breakpoint
ALTER TABLE "chat_channel_prefs" ADD CONSTRAINT "chat_channel_prefs_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_channel_prefs" ADD CONSTRAINT "chat_channel_prefs_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "chat_thread_follows" (
	"user_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	CONSTRAINT "chat_thread_follows_pk" PRIMARY KEY("user_id","root_message_id")
);
--> statement-breakpoint
ALTER TABLE "chat_thread_follows" ADD CONSTRAINT "chat_thread_follows_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_follows" ADD CONSTRAINT "chat_thread_follows_root_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- D8 (O): il «general» di ogni progetto esistente (il server non ha progetti
-- archiviati), con gli
-- eventi predefiniti (Release, traguardi, brief). I progetti nuovi lo
-- ricevono da `createProject`, nella stessa transazione.
INSERT INTO "chat_channels" ("project_id", "kind", "visibility", "name", "is_general", "published_events")
SELECT "id", 'project', 'open', 'general', true, ARRAY['release_page', 'milestone_reached', 'brief_ready']
FROM "projects"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Il «general» di un progetto NUOVO, nella stessa transazione che lo crea:
-- un trigger copre ogni punto che crea un progetto (la rotta, gli script, i
-- seed), non solo la rotta.
CREATE FUNCTION "chat_project_general"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "chat_channels" ("project_id", "kind", "visibility", "name", "is_general", "published_events")
	VALUES (NEW."id", 'project', 'open', 'general', true, ARRAY['release_page', 'milestone_reached', 'brief_ready'])
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_chat_general" AFTER INSERT ON "projects" FOR EACH ROW EXECUTE FUNCTION "chat_project_general"();
--> statement-breakpoint
-- D3 (M): i permessi della Chat ai preset, come il prototipo: Developer crea;
-- Project Lead crea e gestisce; User crea canali generali; il full admin li
-- ha per costruzione. `distinct unnest` come la 0114: idempotente.
--
-- E a OGNI ruolo dello stesso scope che conteneva già tutti i permessi di quel
-- preset (decisione del maintainer, 10 nov 2026; `docs/invariants/permissions.md`
-- «un permesso nuovo dato a un preset si dà anche ai ruoli che lo
-- contenevano»): chi stava sopra un Developer o un Lead ci resta. Il
-- riferimento è il preset di PRIMA, quindi i ruoli si aggiornano prima del
-- preset (il preset stesso è escluso: lo aggiorna il suo statement).
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['chat.channels.create', 'chat.channels.manage']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'project_lead'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'project_lead');
--> statement-breakpoint
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['chat.channels.create']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'developer'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'developer');
--> statement-breakpoint
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['chat.general.create']) AS p)
WHERE r."scope" = 'instance'
	AND r."preset_key" IS DISTINCT FROM 'user'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'user');
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['chat.channels.create', 'chat.channels.manage']) AS p)
WHERE "preset_key" = 'project_lead';
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['chat.channels.create']) AS p)
WHERE "preset_key" = 'developer';
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['chat.general.create']) AS p)
WHERE "preset_key" = 'user';
