-- Area 11, F2 (N-1 = a, maintainer): i tre kind della doc di prodotto nel
-- catalogo degli avvisi. Ognuno in uno statement a sé, e nessuno si usa in
-- un'altra migrazione dello stesso batch (CLAUDE.md, «Migrazioni Drizzle»).
-- `updated` e `question` non hanno righe finché F5 non li produce.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'product_doc.mention';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'product_doc.updated';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'product_doc.question';
