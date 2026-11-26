-- Chat con Claude, fetta 5 (F5.3, D3 del maintainer): la continuazione di una
-- pubblica porta a Claude la trascrizione LEGGIBILE dell'originale, come la
-- legge chi continua (fino al seguito privato), solo prosa: i messaggi e le
-- risposte, mai gli eventi dei tool. La calcola il SERVER alla continuazione
-- (la stessa proiezione dei lettori) e il worker la mette nel primo prompt
-- come contesto non fidato. Null per ogni conversazione che non continua.
ALTER TABLE "claude_conversations" ADD COLUMN "origin_transcript" jsonb;
--> statement-breakpoint
-- L'id dell'originale resta anche quando l'originale è eliminato: la
-- continuazione dice «non più disponibile» (`available: false`), invece di
-- dimenticare di essere una continuazione. Un uuid semplice, senza FK.
ALTER TABLE "claude_conversations" DROP CONSTRAINT "claude_conversations_continues_from_fk";
