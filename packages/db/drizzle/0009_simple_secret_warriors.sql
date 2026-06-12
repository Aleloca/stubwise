CREATE TABLE "git_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" "git_provider_kind" NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_account_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_git_account_id_git_accounts_id_fk" FOREIGN KEY ("git_account_id") REFERENCES "public"."git_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Migrazione dati: le credenziali vivevano sul progetto e ora si spostano su un
-- account git riutilizzabile. Per ogni progetto con credenziali non vuote si crea
-- un account dedicato (nome "<progetto> — account", stesso provider e stesso blob
-- cifrato) e vi si collega il progetto. Difensivo: i progetti senza credenziali
-- (blob NULL o vuoto) vengono saltati — in prod tutti i progetti hanno credenziali,
-- quindi il SET NOT NULL successivo non fallisce; su un DB vuoto (testcontainers)
-- il blocco e' un no-op.
DO $$
DECLARE
	proj RECORD;
	new_account_id uuid;
BEGIN
	FOR proj IN
		SELECT id, name, provider, encrypted_credentials
		FROM projects
		WHERE encrypted_credentials IS NOT NULL
			AND encrypted_credentials <> ''
	LOOP
		INSERT INTO git_accounts (name, provider, encrypted_credentials, created_at)
		VALUES (proj.name || ' — account', proj.provider, proj.encrypted_credentials, now())
		RETURNING id INTO new_account_id;

		UPDATE projects
		SET git_account_id = new_account_id
		WHERE id = proj.id;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "git_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "encrypted_credentials";
