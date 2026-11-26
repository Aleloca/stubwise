-- Integrazione area 2, fetta 1 (9 nov 2026): codici di progetto, reparti,
-- nome visualizzato. Il permesso `departments.manage` NON si aggiunge al
-- preset Admin: il preset è `instance.full_admin`, che dà già ogni permesso
-- d'istanza (`effectiveInstancePermissions`), e la parità con `PRESET_ROLES`
-- (roles-migration.test, caso h) resta quella di oggi.
--
-- Codice di progetto: `^[A-Z][A-Z0-9]{1,5}$`, unico. La base si ricava dallo
-- slug (lettere, maiuscole, prime tre, completate con X); una collisione si
-- risolve aggiungendo 2, 3, … nell'ordine `created_at`. Un INSERT senza codice
-- lo riceve dal trigger `projects_assign_code`, così nessuno scrittore di oggi
-- (server, test, seed) deve conoscere la regola: è in UN posto, qui.
CREATE FUNCTION stubwise_project_code(slug text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
	SELECT rpad(upper(left(regexp_replace(coalesce(slug, ''), '[^a-zA-Z]', '', 'g'), 3)), 3, 'X')
$$;
--> statement-breakpoint
-- Il primo codice libero per uno slug. Il suffisso accorcia la base quando
-- servirebbe un settimo carattere, così il formato regge oltre il 999.
CREATE FUNCTION stubwise_next_project_code(slug text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	base text := stubwise_project_code(slug);
	candidate text := base;
	n integer := 1;
BEGIN
	-- Due INSERT concorrenti non devono scegliere lo stesso codice.
	PERFORM pg_advisory_xact_lock(hashtext('stubwise_project_code'));
	WHILE EXISTS (SELECT 1 FROM "projects" WHERE "code" = candidate) LOOP
		n := n + 1;
		candidate := left(base, 6 - length(n::text)) || n::text;
	END LOOP;
	RETURN candidate;
END;
$$;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "code" text;
--> statement-breakpoint
-- Idempotente: tocca solo i progetti ancora senza codice.
CREATE FUNCTION stubwise_assign_project_codes() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	p record;
BEGIN
	FOR p IN SELECT "id", "slug" FROM "projects" WHERE "code" IS NULL ORDER BY "created_at", "id" LOOP
		UPDATE "projects" SET "code" = stubwise_next_project_code(p."slug") WHERE "id" = p."id";
	END LOOP;
END;
$$;
--> statement-breakpoint
SELECT stubwise_assign_project_codes();
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_code_unique" UNIQUE ("code");
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_code_format_chk" CHECK ("code" ~ '^[A-Z][A-Z0-9]{1,5}$');
--> statement-breakpoint
CREATE FUNCTION projects_assign_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."code" IS NULL THEN
		NEW."code" := stubwise_next_project_code(NEW."slug");
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_assign_code" BEFORE INSERT ON "projects"
	FOR EACH ROW EXECUTE FUNCTION projects_assign_code();
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color_token" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
	CONSTRAINT "departments_color_token_chk" CHECK ("color_token" IN ('--dept-1', '--dept-2', '--dept-3', '--dept-4', '--dept-5', '--dept-6', '--dept-7', '--dept-8'))
);
--> statement-breakpoint
-- Un solo reparto di ripiego.
CREATE UNIQUE INDEX "departments_one_default_idx" ON "departments" ("is_default") WHERE "is_default";
--> statement-breakpoint
-- `position` = ordine dei reparti della persona: «primo reparto» = min(position).
CREATE TABLE "department_members" (
	"department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "department_members_pk" PRIMARY KEY ("department_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "department_members_user_idx" ON "department_members" ("user_id", "position");
--> statement-breakpoint
INSERT INTO "departments" ("name", "color_token", "is_default") VALUES ('General', '--dept-1', true);
--> statement-breakpoint
INSERT INTO "department_members" ("department_id", "user_id", "position")
SELECT d."id", u."id", 0 FROM "users" u CROSS JOIN "departments" d WHERE d."is_default";
