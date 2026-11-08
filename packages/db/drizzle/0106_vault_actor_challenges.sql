-- Sfide di possesso della chiave di persona (23 ott 2026, review finale
-- della cassaforte). Le azioni che passano o tolgono una chiave (conferma,
-- rifiuto, condivisione, revoca di un lettore, rotazione del kit) vogliono la
-- prova che chi agisce ha APERTO la sua chiave confermata: il server cifra un
-- segreto per la pubblica di quella chiave e accetta solo chi lo rimanda.
-- Stessa tabella delle sfide del kit, distinte da `kind`; quelle di persona
-- sono legate alla chiave (`person_key_id`), e una chiave ricreata le perde.
ALTER TABLE "vault_recovery_challenges" ADD COLUMN "kind" text DEFAULT 'recovery' NOT NULL;
--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD COLUMN "person_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_person_key_id_vault_person_keys_id_fk" FOREIGN KEY ("person_key_id") REFERENCES "public"."vault_person_keys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_kind_chk" CHECK (("kind" = 'recovery' AND "person_key_id" IS NULL) OR ("kind" = 'actor' AND "person_key_id" IS NOT NULL));
