-- Integrazione area 2, fetta 3 (9 nov 2026): la Home a blocchi e i ruoli di
-- reparto. Le regole (fissi, unione dei reparti, «è cambiata») stanno in
-- `@stubwise/shared` (`tasks/home.ts`); qui solo dove si salvano.
--
-- I permessi di reparto sono un livello nuovo (accanto a istanza e
-- progetto): una riga per persona e reparto con i suoi permessi
-- (`DEPARTMENT_PERMISSIONS`, oggi solo `department.home.manage`). Non danno
-- accesso a dati: decidono la disposizione della Home del reparto.
CREATE TABLE "department_roles" (
	"department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "department_roles_pk" PRIMARY KEY ("department_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "department_roles_user_idx" ON "department_roles" ("user_id");
--> statement-breakpoint
-- La Home predefinita di un reparto: i blocchi (`{kind, filterId?}`), quando
-- è cambiata e da chi. `updated_at` è ciò che «La Home del reparto è
-- cambiata» confronta con `personal_home_seen`.
CREATE TABLE "department_homes" (
	"department_id" uuid PRIMARY KEY NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
-- La Home personalizzata: senza riga si usa l'unione delle Home dei reparti.
CREATE TABLE "personal_homes" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Per chi ha la Home personale: l'`updated_at` della Home di ciascun suo
-- reparto l'ultima volta che l'ha vista («Vedi le novità»).
CREATE TABLE "personal_home_seen" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "personal_home_seen_pk" PRIMARY KEY ("user_id", "department_id")
);
--> statement-breakpoint
-- La Home d'apertura dei reparti che esistono già, con i soli blocchi
-- dell'area 2 (così nessuno vede una Home vuota): i due fissi, le mie task,
-- il lavoro di Claude per me e le ferme nei miei progetti. Un reparto creato
-- dopo non ha una Home sua finché qualcuno non la imposta (come nel
-- prototipo): chi sta solo lì vede i fissi.
INSERT INTO "department_homes" ("department_id", "blocks")
SELECT "id", '[{"kind":"decide"},{"kind":"myWeek"},{"kind":"myTasks"},{"kind":"claudeForMe"},{"kind":"stalledInMyProjects"}]'::jsonb
FROM "departments"
ON CONFLICT ("department_id") DO NOTHING;
