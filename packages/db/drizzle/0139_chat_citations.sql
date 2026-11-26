-- Area 4, Chat, fetta 2 (F2.7, decisione del maintainer del 10 nov 2026): le
-- citazioni di un messaggio. Task, richieste, progetti, persone e pagine Docs
-- scelti con «#»/«@» (o i codici scritti a mano, che diventano link da sé).
-- Il server tiene solo ciò che chi scrive vede e che il testo nomina ancora;
-- a lettura le filtra su ciò che chi legge vede. Niente FK verso l'oggetto
-- (sono tabelle diverse): un oggetto che non c'è più non esce a lettura.
CREATE TABLE "chat_message_citations" (
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_message_citations_pk" PRIMARY KEY("message_id","kind","ref_id"),
	CONSTRAINT "chat_message_citations_kind_chk" CHECK ("kind" in ('task', 'request', 'project', 'person', 'doc'))
);
--> statement-breakpoint
ALTER TABLE "chat_message_citations" ADD CONSTRAINT "chat_message_citations_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
