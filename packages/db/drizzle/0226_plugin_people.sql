-- Rimandi, lotto 5 (A9): chi ha registrato un plugin e chi ne ha cambiato il
-- ref per ultimo («updated … by»), come il prototipo (`registeredById`,
-- `updatedById`). Null per i plugin di prima o una persona eliminata.
ALTER TABLE "plugins" ADD COLUMN "registered_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "updated_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
