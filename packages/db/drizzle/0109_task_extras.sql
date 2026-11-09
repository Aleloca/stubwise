-- Integrazione area 2, fetta 1 (9 nov 2026): reparto delle task, ferme a
-- mano, soglie «ferma», follower e richieste di decisione.
ALTER TABLE "projects" ADD COLUMN "stall_active_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "stall_todo_days" integer DEFAULT 14 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_stall_active_days_chk" CHECK ("stall_active_days" BETWEEN 1 AND 90);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_stall_todo_days_chk" CHECK ("stall_todo_days" BETWEEN 1 AND 90);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "department_id" uuid;
--> statement-breakpoint
UPDATE "tickets" SET "department_id" = (SELECT "id" FROM "departments" WHERE "is_default");
--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "department_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_department_id_fk"
	FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "tickets_department_id_idx" ON "tickets" ("department_id");
--> statement-breakpoint
-- Una task senza reparto (SDK, widget, posta, automazioni, intake, pipeline:
-- ogni scrittore che non conosce i reparti) nasce nel ripiego.
CREATE FUNCTION tickets_default_department() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."department_id" IS NULL THEN
		SELECT "id" INTO NEW."department_id" FROM "departments" WHERE "is_default";
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_default_department" BEFORE INSERT ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_default_department();
--> statement-breakpoint
-- Nessuno è senza reparto (decisione del 9 nov 2026): una persona nuova entra
-- nel ripiego con `position` 0, lo stato in cui la 0107 ha lasciato tutti.
CREATE FUNCTION users_default_department() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "department_members" ("department_id", "user_id", "position")
	SELECT "id", NEW."id", 0 FROM "departments" WHERE "is_default"
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "users_default_department" AFTER INSERT ON "users"
	FOR EACH ROW EXECUTE FUNCTION users_default_department();
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "manual_stall_reason" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "manual_stall_note" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "manual_stall_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "manual_stall_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_manual_stall_chk"
	CHECK (("manual_stall_reason" IS NULL) = ("manual_stall_since" IS NULL));
--> statement-breakpoint
CREATE TABLE "ticket_followers" (
	"ticket_id" uuid NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_followers_pk" PRIMARY KEY ("ticket_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "ticket_followers_user_idx" ON "ticket_followers" ("user_id");
--> statement-breakpoint
CREATE TABLE "decision_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
	"asked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"asked_of_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"question" text NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"answer_option_index" integer,
	"answer_text" text,
	"answered_at" timestamp with time zone,
	"answered_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	CONSTRAINT "decision_requests_question_chk" CHECK (length("question") BETWEEN 1 AND 2000),
	CONSTRAINT "decision_requests_options_chk" CHECK (cardinality("options") <= 8),
	-- Al più uno fra risposta e ritiro.
	CONSTRAINT "decision_requests_closed_once_chk" CHECK ("answered_at" IS NULL OR "withdrawn_at" IS NULL),
	-- Una risposta è un indice oppure un testo («Altro…»), mai entrambi né nessuno.
	CONSTRAINT "decision_requests_answer_chk" CHECK (
		("answered_at" IS NULL AND "answer_option_index" IS NULL AND "answer_text" IS NULL)
		OR ("answered_at" IS NOT NULL AND (("answer_option_index" IS NULL) <> ("answer_text" IS NULL)))
	),
	CONSTRAINT "decision_requests_option_index_chk" CHECK (
		"answer_option_index" IS NULL OR ("answer_option_index" >= 0 AND "answer_option_index" < cardinality("options"))
	)
);
--> statement-breakpoint
CREATE INDEX "decision_requests_ticket_idx" ON "decision_requests" ("ticket_id", "created_at");
--> statement-breakpoint
CREATE INDEX "decision_requests_open_target_idx" ON "decision_requests" ("asked_of_user_id")
	WHERE "answered_at" IS NULL AND "withdrawn_at" IS NULL;
