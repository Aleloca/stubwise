-- Fase permessi (22 ott 2026, ruling R51): chi ha creato un invito. Alla sua
-- accettazione i progetti promessi si riverificano coi permessi ATTUALI di
-- chi ha invitato: senza questa colonna non si saprebbe di chi. Nullo per gli
-- inviti creati prima (nessuno ha progetti: `invite_projects` nasce nella
-- stessa fase) e quando l'invitante viene eliminato — in quel caso i progetti
-- dell'invito si scartano all'accettazione.
ALTER TABLE "invites" ADD COLUMN "invited_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
