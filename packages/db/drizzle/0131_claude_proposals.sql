-- Chat con Claude, fetta 3 (10 nov 2026): proposte e azioni. Claude PROPONE
-- (`claude_proposals`, scritte dal tool `propose_action` attraverso la sola
-- rotta di scrittura del token del turno); il SERVER esegue, con gli stessi
-- servizi delle rotte, un gruppo alla volta (`claude_action_groups`) di azioni
-- (`claude_actions`, con l'inverso e gli oggetti toccati per «Annulla»).
-- Il segno «via Claude» (`via_claude_action_id`) sulle scritture fatte per una
-- persona: l'attore resta la persona. NESSUN writer lo passa: è il DEFAULT
-- della colonna, letto da una variabile di TRANSAZIONE
-- (`set_config('stubwise.via_claude_action_id', <azione>, true)`) che solo
-- l'esecutore delle azioni di Claude imposta. Fuori da lì vale null.
CREATE TABLE "claude_action_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"requester_id" uuid NOT NULL,
	"proposal_id" uuid,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_of_group_id" uuid
);
--> statement-breakpoint
CREATE TABLE "claude_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"fn" text NOT NULL,
	"args" jsonb NOT NULL,
	"cls" text NOT NULL,
	"inverse" jsonb,
	"objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_actions_cls_chk" CHECK (cls in ('A','B','C'))
);
--> statement-breakpoint
CREATE TABLE "claude_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"tool_use_id" text,
	"actions" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"declared_cls" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"failure" jsonb,
	"group_id" uuid,
	"event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"undo_of_group_id" uuid,
	CONSTRAINT "claude_proposals_status_chk" CHECK (status in ('open','confirmed','cancelled','failed')),
	CONSTRAINT "claude_proposals_cls_chk" CHECK (declared_cls in ('A','B','C')),
	CONSTRAINT "claude_proposals_tool_use_unique" UNIQUE("session_id","tool_use_id")
);
--> statement-breakpoint
-- SET NULL, non CASCADE: le sessioni si potano a 14 giorni, il segno «via
-- Claude» su registro, commenti e notifiche no (le azioni restano).
ALTER TABLE "claude_action_groups" ADD CONSTRAINT "claude_action_groups_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_action_groups" ADD CONSTRAINT "claude_action_groups_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_action_groups" ADD CONSTRAINT "claude_action_groups_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_action_groups" ADD CONSTRAINT "claude_action_groups_undo_of_group_id_fk" FOREIGN KEY ("undo_of_group_id") REFERENCES "public"."claude_action_groups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_actions" ADD CONSTRAINT "claude_actions_group_id_claude_action_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."claude_action_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD CONSTRAINT "claude_proposals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD CONSTRAINT "claude_proposals_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD CONSTRAINT "claude_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD CONSTRAINT "claude_proposals_group_id_claude_action_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."claude_action_groups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD CONSTRAINT "claude_proposals_undo_of_group_id_fk" FOREIGN KEY ("undo_of_group_id") REFERENCES "public"."claude_action_groups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claude_action_groups" ADD CONSTRAINT "claude_action_groups_proposal_id_claude_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."claude_proposals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "claude_proposals_session_idx" ON "claude_proposals" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "claude_action_groups_session_idx" ON "claude_action_groups" USING btree ("session_id","executed_at");
--> statement-breakpoint
CREATE INDEX "claude_actions_group_idx" ON "claude_actions" USING btree ("group_id","seq");
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD COLUMN "via_claude_action_id" uuid DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_via_claude_action_id_claude_actions_id_fk" FOREIGN KEY ("via_claude_action_id") REFERENCES "public"."claude_actions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "via_claude_action_id" uuid DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_via_claude_action_id_claude_actions_id_fk" FOREIGN KEY ("via_claude_action_id") REFERENCES "public"."claude_actions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "via_claude_action_id" uuid DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_via_claude_action_id_claude_actions_id_fk" FOREIGN KEY ("via_claude_action_id") REFERENCES "public"."claude_actions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deleted_tickets" ALTER COLUMN "via_claude_action_id" SET DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "deleted_tickets" ADD CONSTRAINT "deleted_tickets_via_claude_action_id_claude_actions_id_fk" FOREIGN KEY ("via_claude_action_id") REFERENCES "public"."claude_actions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- I due tipi d'evento nuovi della conversazione: una proposta e un gruppo
-- eseguito. Il `data` porta solo gli id; lo stato si deriva a lettura.
ALTER TABLE "agent_session_events" DROP CONSTRAINT "agent_session_events_type_chk";
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end','proposal','actions_executed'));
