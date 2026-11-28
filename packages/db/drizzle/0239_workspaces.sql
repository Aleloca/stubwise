-- Workspace (design `docs/plans/2026-11-27-workspace-design.md`, decisioni
-- D1–D19 del 27 nov 2026): raggruppamenti di PROGETTI per VISIBILITÀ. Una
-- persona di una workspace vede ogni suo progetto col suo ruolo di workspace
-- (un ruolo di PROGETTO), e i permessi effettivi sono l'UNIONE delle fonti
-- (workspace ∪ membro esplicito ∪ reparti): la regola sta in
-- `packages/db/src/member-permissions.ts`, sopra la vista `project_access`.
-- Tutto additivo, nessun dato: un'istanza senza workspace è identica a prima.
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	CONSTRAINT "workspaces_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
	CONSTRAINT "workspaces_color_token_chk" CHECK ("color_token" IN ('--dept-1', '--dept-2', '--dept-3', '--dept-4', '--dept-5', '--dept-6', '--dept-7', '--dept-8'))
);
--> statement-breakpoint
-- D2: un progetto sta in AL PIÙ una workspace (l'indice unico, non una convenzione).
CREATE TABLE "workspace_projects" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_projects_pk" PRIMARY KEY ("workspace_id", "project_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_projects_project_uq" ON "workspace_projects" ("project_id");
--> statement-breakpoint
-- Il ruolo di workspace è un ruolo di PROGETTO, valido in ogni progetto della workspace.
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE RESTRICT,
	"added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_pk" PRIMARY KEY ("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" ("user_id");
--> statement-breakpoint
-- D9: l'invito di registrazione che promette una workspace (riverificato all'accettazione, R51).
CREATE TABLE "invite_workspaces" (
	"invite_token" text NOT NULL REFERENCES "invites"("token") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
	CONSTRAINT "invite_workspaces_pk" PRIMARY KEY ("invite_token", "workspace_id")
);
--> statement-breakpoint
-- La stessa difesa di `project_members` (0097): un ruolo d'istanza non vale qui.
CREATE TRIGGER "workspace_members_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "workspace_members"
	FOR EACH ROW EXECUTE FUNCTION "project_members_role_scope"();
--> statement-breakpoint
CREATE TRIGGER "invite_workspaces_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "invite_workspaces"
	FOR EACH ROW EXECUTE FUNCTION "project_members_role_scope"();
--> statement-breakpoint
-- Chi accede a un progetto, una riga per FONTE: `member` (una riga
-- `project_members`) o `workspace` (una workspace che contiene il progetto).
-- Una persona può avere due righe per lo stesso progetto. Le query di
-- visibilità e di permesso leggono QUESTA vista, mai `project_members` da
-- sola; le scritture e la sezione Members restano su `project_members`.
-- Chi tocca le tabelle sotto ricrea la vista nella stessa migrazione.
CREATE VIEW "project_access" AS
	SELECT pm."project_id", pm."user_id", pm."role_id", 'member'::text AS "source", NULL::uuid AS "workspace_id"
	FROM "project_members" pm
	UNION ALL
	SELECT wp."project_id", wm."user_id", wm."role_id", 'workspace'::text AS "source", wm."workspace_id"
	FROM "workspace_members" wm
	JOIN "workspace_projects" wp ON wp."workspace_id" = wm."workspace_id";
