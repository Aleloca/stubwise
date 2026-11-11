-- Area 5, fetta 3 (11 nov 2026, decisione O dell'orchestratrice): in un turno
-- della chat con Claude che ha letto contenuto NON fidato (un file del Drive,
-- una pagina Docs, che scrive chiunque abbia docs.edit) ogni proposta è
-- almeno B: aspetta la conferma della persona. Lo calcola il SERVER: la
-- CONVERSAZIONE ricorda la prima lettura (la segna l'accesso del token del
-- turno, sulle rotte di `CHAT_TOOL_UNTRUSTED_ROUTES`) — per conversazione e
-- non per turno, perché il testo letto resta nel contesto dei turni dopo —, la
-- proposta il fatto, così la classe ricalcolata a ogni lettura non torna A.
ALTER TABLE "claude_conversations" ADD COLUMN "untrusted_read_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claude_proposals" ADD COLUMN "untrusted_input" boolean DEFAULT false NOT NULL;
