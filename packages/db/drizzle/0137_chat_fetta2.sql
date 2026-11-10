-- Area 4, Chat, fetta 2 (10 nov 2026): DM, privati, generali d'istanza,
-- ricerca, domande, task e richieste nate da un messaggio, «anche nel
-- canale». Piano: `docs/plans/2026-11-10-integrazione-area4-fetta2-plan.md`.
--
-- Un DM si ritrova dalle sue persone: `dm_key` sono i loro id ordinati,
-- separati da virgole. Non è unico: un gruppo da cui qualcuno è uscito può
-- coincidere con un DM che c'è già (si riapre il più vecchio, come il
-- prototipo); due aperture concorrenti si serializzano con un advisory lock.
ALTER TABLE "chat_channels" ADD COLUMN "dm_key" text;
--> statement-breakpoint
CREATE INDEX "chat_channels_dm_key_idx" ON "chat_channels" USING btree ("dm_key") WHERE "chat_channels"."kind" = 'dm';
--> statement-breakpoint
-- Un DM ha la sua chiave; un canale che non è un DM no.
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_dm_key_chk" CHECK (("kind" = 'dm') = ("dm_key" is not null));
--> statement-breakpoint
-- Un nome per i canali generali d'istanza, come per quelli di un progetto.
CREATE UNIQUE INDEX "chat_channels_general_name_idx" ON "chat_channels" USING btree ("name") WHERE "chat_channels"."kind" = 'general';
--> statement-breakpoint
-- Una risposta mandata «anche nel canale» entra nel flusso del canale.
ALTER TABLE "chat_messages" ADD COLUMN "also_in_channel" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- La ricerca: il testo senza maiuscole né accenti, scritto dal server a ogni
-- scrittura (`foldChatText`), cercato per sottostringa con un indice trigram.
-- Un eliminato ha il testo vuoto, come `body`.
ALTER TABLE "chat_messages" ADD COLUMN "search_folded" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- I messaggi che ci sono già: la fetta 1 esce con questa migrazione, quindi in
-- produzione non ce ne sono; resta per i database di sviluppo. Solo
-- `lower()`: togliere gli accenti in SQL dipende dalla codifica del database,
-- e lo fa il server (NFD) dalla prima modifica in poi.
UPDATE "chat_messages"
SET "search_folded" = lower("body")
WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "chat_messages_search_idx" ON "chat_messages" USING gin ("search_folded" gin_trgm_ops);
--> statement-breakpoint
-- «Da decidere»: le domande che chi guarda ha ignorato.
CREATE TABLE "chat_dismissed_questions" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_dismissed_questions_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "chat_dismissed_questions" ADD CONSTRAINT "chat_dismissed_questions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_dismissed_questions" ADD CONSTRAINT "chat_dismissed_questions_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Le task e le richieste nate da un messaggio («→ AUD-14»). Il codice si
-- deriva a lettura, filtrato per chi guarda; una task eliminata non è più
-- annunciata (cascata).
CREATE TABLE "chat_message_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"ticket_id" uuid,
	"backlog_item_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_links_one_chk" CHECK (("ticket_id" is null) <> ("backlog_item_id" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_ticket_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_backlog_fk" FOREIGN KEY ("backlog_item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_message_links_message_idx" ON "chat_message_links" USING btree ("message_id");
--> statement-breakpoint
-- Lo stesso oggetto una volta sola per messaggio (un intake che fonde due
-- volte nella stessa richiesta non la annuncia due volte).
CREATE UNIQUE INDEX "chat_message_links_ticket_idx" ON "chat_message_links" USING btree ("message_id","ticket_id") WHERE "chat_message_links"."ticket_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_links_backlog_idx" ON "chat_message_links" USING btree ("message_id","backlog_item_id") WHERE "chat_message_links"."backlog_item_id" IS NOT NULL;
