-- Ruoli, membri di progetto e conversione degli utenti esistenti (22 ott 2026,
-- docs/plans/2026-10-22-permessi-progetto-design.md).
-- I permessi sono un catalogo nel codice (@stubwise/shared, permissions.ts):
-- qui stanno solo i ruoli che li raggruppano. `scope` è testo + CHECK e non un
-- enum: niente ALTER TYPE nel batch (vedi 0095_pat_kind.sql).
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"preset_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_preset_key_unique" UNIQUE("preset_key"),
	CONSTRAINT "roles_scope_chk" CHECK ("scope" in ('instance', 'project'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "roles_scope_name_idx" ON "roles" USING btree ("scope", lower("name"));--> statement-breakpoint
-- I sette preset, con le chiavi LETTERALI di PRESET_ROLES (la parità la
-- verifica roles-migration.test.ts). `preset_key` serve al seed e alla
-- conversione: i preset restano modificabili ed eliminabili.
INSERT INTO "roles" ("preset_key", "name", "scope", "permissions") VALUES
	('admin', 'Admin', 'instance', ARRAY['instance.full_admin']),
	('user', 'User', 'instance', ARRAY['monitor.view', 'users.view_all', 'git_accounts.view', 'mail_admission.view']),
	('project_lead', 'Project Lead', 'project', ARRAY['project.settings.manage', 'project.members.manage', 'tickets.view_all', 'tickets.create', 'tickets.edit', 'tickets.comment', 'tickets.moderate', 'runs.start', 'plans.approve', 'release.merge', 'corrections.request', 'backlog.view_all', 'backlog.create', 'backlog.edit', 'docs.view', 'docs.edit', 'repos.view', 'repos.manage', 'agent_sessions.intervene', 'decisions.record', 'environments.manage', 'widget.manage', 'project.usage.view', 'docs.generate', 'prs.adopt']),
	('developer', 'Developer', 'project', ARRAY['tickets.view_all', 'tickets.create', 'tickets.edit', 'tickets.comment', 'tickets.moderate', 'runs.start', 'corrections.request', 'backlog.view_all', 'backlog.create', 'backlog.edit', 'docs.view', 'docs.edit', 'repos.view', 'repos.manage', 'agent_sessions.intervene', 'decisions.record', 'environments.manage', 'widget.manage', 'project.usage.view', 'docs.generate', 'prs.adopt']),
	('contributor', 'Contributor', 'project', ARRAY['docs.view', 'tickets.create', 'tickets.comment', 'backlog.create']),
	('viewer', 'Viewer', 'project', ARRAY['tickets.view_all', 'backlog.view_all', 'docs.view', 'repos.view', 'project.usage.view']),
	('legacy_member', 'Legacy Member', 'project', ARRAY['tickets.view_all', 'tickets.create', 'tickets.edit', 'tickets.comment', 'runs.start', 'corrections.request', 'backlog.view_all', 'backlog.create', 'backlog.edit', 'docs.view', 'docs.edit', 'repos.view', 'decisions.record']);--> statement-breakpoint
-- Ruolo d'istanza: nasce nullable, si riempie da `role`, poi NOT NULL.
ALTER TABLE "users" ADD COLUMN "instance_role_id" uuid;--> statement-breakpoint
UPDATE "users" SET "instance_role_id" = (
	SELECT "id" FROM "roles"
	WHERE "preset_key" = CASE WHEN "users"."role" = 'admin' THEN 'admin' ELSE 'user' END
);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "instance_role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_instance_role_id_roles_id_fk" FOREIGN KEY ("instance_role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Inviti: null = preset `User` all'accettazione. Un invito pendente di oggi
-- (che non porta un ruolo) resta null: diventa `User` senza progetti.
ALTER TABLE "invites" ADD COLUMN "instance_role_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_instance_role_id_roles_id_fk" FOREIGN KEY ("instance_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_user_id_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
-- Conversione, una tantum: ogni member di oggi entra in TUTTI i progetti
-- esistenti con `Legacy Member`. Gli admin no: `instance.full_admin` vale già
-- su ogni progetto. Un progetto creato dopo non aggiunge nessuno da sé.
INSERT INTO "project_members" ("project_id", "user_id", "role_id")
SELECT p."id", u."id", r."id"
FROM "users" u
CROSS JOIN "projects" p
JOIN "roles" r ON r."preset_key" = 'legacy_member'
WHERE u."role" = 'member';--> statement-breakpoint
-- `users.role` resta come colonna DERIVATA dal ruolo d'istanza finché tutti i
-- lettori non sono passati ai permessi: `admin` se il ruolo ha
-- `instance.full_admin`, altrimenti `member`. Il trigger copre anche gli
-- scrittori che conoscono solo `role` (un'immagine vecchia dopo un rollback,
-- il codice non ancora migrato): un INSERT senza ruolo d'istanza riceve il
-- preset `Admin`/`User` da `role`, e un UPDATE che cambia solo `role` sposta
-- il ruolo d'istanza sullo stesso preset. Nello stesso punto il controllo che
-- il ruolo d'istanza sia davvero di tipo `instance`.
CREATE FUNCTION "users_role_derived"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	r_scope text;
	r_permissions text[];
BEGIN
	IF (TG_OP = 'INSERT' AND NEW."instance_role_id" IS NULL)
		OR (TG_OP = 'UPDATE'
			AND NEW."instance_role_id" IS NOT DISTINCT FROM OLD."instance_role_id"
			AND NEW."role" IS DISTINCT FROM OLD."role") THEN
		SELECT "id" INTO NEW."instance_role_id" FROM "roles"
		WHERE "preset_key" = CASE WHEN NEW."role" = 'admin' THEN 'admin' ELSE 'user' END;
	END IF;
	IF NEW."instance_role_id" IS NULL THEN
		RETURN NEW; -- lo rifiuta il NOT NULL
	END IF;
	SELECT "scope", "permissions" INTO r_scope, r_permissions
	FROM "roles" WHERE "id" = NEW."instance_role_id";
	IF r_scope IS DISTINCT FROM 'instance' THEN
		RAISE EXCEPTION 'il ruolo % non è un ruolo d''istanza', NEW."instance_role_id"
			USING ERRCODE = 'check_violation';
	END IF;
	NEW."role" := CASE WHEN 'instance.full_admin' = ANY(r_permissions) THEN 'admin' ELSE 'member' END;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_role_derived" BEFORE INSERT OR UPDATE OF "instance_role_id", "role" ON "users"
	FOR EACH ROW EXECUTE FUNCTION "users_role_derived"();--> statement-breakpoint
-- Un ruolo non cambia tipo (i controlli di tipo valgono all'assegnazione), e
-- cambiare i suoi permessi ricalcola `users.role` dei suoi utenti: l'UPDATE
-- nomina `instance_role_id` senza cambiarlo, così `users_role_derived` deriva
-- di nuovo invece di prendere la strada dello scrittore vecchio.
CREATE FUNCTION "roles_sync_users"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."scope" IS DISTINCT FROM OLD."scope" THEN
		RAISE EXCEPTION 'il tipo di un ruolo non si cambia' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."permissions" IS DISTINCT FROM OLD."permissions" AND NEW."scope" = 'instance' THEN
		UPDATE "users" SET "instance_role_id" = "instance_role_id" WHERE "instance_role_id" = NEW."id";
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "roles_sync_users" AFTER UPDATE OF "scope", "permissions" ON "roles"
	FOR EACH ROW EXECUTE FUNCTION "roles_sync_users"();--> statement-breakpoint
CREATE FUNCTION "project_members_role_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "scope" FROM "roles" WHERE "id" = NEW."role_id") IS DISTINCT FROM 'project' THEN
		RAISE EXCEPTION 'il ruolo % non è un ruolo di progetto', NEW."role_id"
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_members_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "project_members"
	FOR EACH ROW EXECUTE FUNCTION "project_members_role_scope"();
