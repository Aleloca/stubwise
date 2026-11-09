-- Integrazione area 2, fetta 3 (9 nov 2026): i filtri salvati dell'app nuova.
--
-- Tabella NUOVA (decisione del maintainer): le «viste salvate» del web
-- vecchio (`saved_views`) restano intatte, non si convertono, e se ne
-- andranno col web vecchio. I criteri sono `FilterCriteria` del prototipo
-- (`filterCriteriaSchema` di `@stubwise/shared` li valida in scrittura).
-- Visibilità, vista e raggruppamento sono testo con CHECK, non enum: un
-- valore nuovo è una migrazione semplice, senza `ADD VALUE`.
-- Un filtro senza autore (`owner_id` null) è uno dei filtri di esempio, o di
-- una persona eliminata: lo modifica solo un full admin.
CREATE TABLE "task_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"view" text NOT NULL,
	"group_by" text NOT NULL,
	"seed_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_filters_name_chk" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "task_filters_visibility_chk" CHECK ("visibility" IN ('private', 'public')),
	CONSTRAINT "task_filters_view_chk" CHECK ("view" IN ('list', 'board', 'timeline')),
	CONSTRAINT "task_filters_group_by_chk" CHECK (
		"group_by" IN ('none', 'status', 'assignee', 'department', 'milestone', 'week', 'project')
	),
	CONSTRAINT "task_filters_seed_key_unique" UNIQUE ("seed_key")
);
--> statement-breakpoint
CREATE INDEX "task_filters_owner_idx" ON "task_filters" ("owner_id");
--> statement-breakpoint
CREATE INDEX "task_filters_public_idx" ON "task_filters" ("visibility") WHERE "visibility" = 'public';
--> statement-breakpoint
-- I filtri fissati nella colonna, per persona, nell'ordine in cui sono stati
-- fissati. Eliminare un filtro lo toglie dai fissati di TUTTI (cascata).
CREATE TABLE "pinned_task_filters" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"filter_id" uuid NOT NULL REFERENCES "task_filters"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	CONSTRAINT "pinned_task_filters_pk" PRIMARY KEY ("user_id", "filter_id")
);
--> statement-breakpoint
CREATE INDEX "pinned_task_filters_filter_idx" ON "pinned_task_filters" ("filter_id");
--> statement-breakpoint
-- I cinque filtri pubblici di esempio del prototipo
-- (`apps/desktop/src/renderer/data/seed/filters.ts`), di nessuno. Nascono
-- QUI, una volta sola, non a ogni avvio: chi ne elimina uno non se lo
-- ritrova. `seed_key` rende l'inserimento idempotente.
INSERT INTO "task_filters" ("seed_key", "name", "owner_id", "visibility", "criteria", "view", "group_by") VALUES
	('open', 'Open', NULL, 'public', '{"families":["todo","active"]}', 'list', 'status'),
	('closed-month', 'Closed this month', NULL, 'public',
		'{"families":["closed"],"period":{"field":"closed","kind":"relative","preset":"thisMonth"}}', 'list', 'none'),
	('stalled', 'Stalled', NULL, 'public', '{"stalled":true}', 'list', 'assignee'),
	('no-estimate', 'No estimate', NULL, 'public', '{"families":["todo","active"],"sizes":["none"]}', 'list', 'none'),
	('unassigned', 'Unassigned', NULL, 'public', '{"families":["todo","active"],"assigneeIds":["none"]}', 'board', 'status')
ON CONFLICT ("seed_key") DO NOTHING;
