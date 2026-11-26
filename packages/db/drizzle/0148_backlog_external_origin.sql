-- Review della F3 dell'area 5 (12 nov 2026, decisione del maintainer): leggere
-- nella chat con Claude una task o una richiesta nata da FUORI conta come
-- contenuto non fidato. Le task lo dicono già (`tickets.source`: widget, SDK,
-- webhook); una richiesta nata da un'email in entrata no, e da qui lo ricorda.
ALTER TABLE "backlog_items" ADD COLUMN "external_origin" text;
--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_external_origin_chk" CHECK ("external_origin" in ('email'));
