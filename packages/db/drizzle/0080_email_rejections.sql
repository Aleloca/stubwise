-- «Le mail tenute fuori» (25 set 2026, design §2): una riga per mail scartata
-- dal cancello di ammissione (`admit()`, fase 6c), per poter dire quante,
-- perché e da quali domini. Fino a qui il poller buttava il motivo dello
-- scarto (`if (!admission.admitted) continue;`) e di una mail tenuta fuori
-- non restava niente.
--
-- Senza CONTENUTO, apposta: niente oggetto (sarebbe posta fuori da
-- `pruneOldEmails`) e niente indirizzo completo (un dato personale di un
-- terzo). Il dominio basta.
--
-- L'unique `(account_id, gmail_message_id)` è l'idempotenza: una mail
-- scartata non scrive una riga in `email_messages`, quindi a ogni rilettura
-- della casella viene rivalutata. Un contatore che incrementa conterebbe due
-- volte.
--
-- `reason` è un CHECK e non un pgEnum: additiva, nessun `ALTER TYPE`, un solo
-- batch — stesso motivo di `calendar_series.action` (7b).
CREATE TABLE "email_rejections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "google_accounts"("id") ON DELETE CASCADE,
  "gmail_message_id" text NOT NULL,
  -- Minuscolo. NULL = mittente non leggibile (niente `@`).
  "sender_domain" text,
  "reason" text NOT NULL,
  "rejected_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "email_rejections_reason_chk" CHECK (reason in ('automated', 'denied_label', 'no_match'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_rejections_account_message_unique" ON "email_rejections" USING btree ("account_id","gmail_message_id");
--> statement-breakpoint
CREATE INDEX "email_rejections_account_rejected_at_idx" ON "email_rejections" USING btree ("account_id","rejected_at");
