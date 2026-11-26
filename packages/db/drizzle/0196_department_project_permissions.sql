-- Area 9, F8 (D-1, F8-1 = a del maintainer): i permessi di PROGETTO che un
-- reparto dà ai suoi membri, validi in ogni progetto di cui la persona è GIÀ
-- membro (un reparto non rende membri di niente), come il prototipo. Una
-- lista per reparto: niente `project_id`. Il calcolo li unisce in
-- `memberPermissionsSql` (UNA funzione); la validazione dei permessi (solo di
-- progetto) e l'escalation stanno nel servizio.
CREATE TABLE "department_project_permissions" (
	"department_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_project_permissions_pkey" PRIMARY KEY("department_id","permission")
);
--> statement-breakpoint
ALTER TABLE "department_project_permissions" ADD CONSTRAINT "department_project_permissions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "department_project_permissions" ADD CONSTRAINT "department_project_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
