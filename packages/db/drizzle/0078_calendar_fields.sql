-- «Il calendario che dice la verità» (15 set 2026, design §2, Task 4 e 7):
-- di un appuntamento Stubwise mostrava molto meno di Google.
--
-- Additiva, **nessun ALTER TYPE**, un solo batch, nessun backfill: le colonne
-- nuove nascono NULL (o col loro default vuoto) sulle righe storiche, ed è il
-- valore giusto — di quegli eventi questi campi non li abbiamo mai chiesti,
-- non «erano vuoti». Si riempiranno da sé al primo resync di ogni casella.
--
-- ⚠️ `description` è HTML NON FIDATO, scritto da chiunque abbia creato
-- l'invito, e qui sta GREZZO di proposito: si sanifica alla LETTURA, come il
-- corpo di un'email (invariante «Il corpo HTML di un'email: dove si conserva,
-- e dove no» in CLAUDE.md). Scrivere in colonna il sanificato congelerebbe
-- ogni riga alla versione del filtro che l'ha scritta, e correggere il filtro
-- richiederebbe una colonna di versione più un ri-scaricamento da Google.
ALTER TABLE "calendar_events" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "hangout_link" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "conference_entry_points" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

-- I promemoria IMPOSTATI SU GOOGLE. Stubwise non li fa scattare: sono
-- un'informazione vera su cosa farà Google, e la UI lo dice (design §2).
-- `reminders_use_default` NON è ridondante con un array vuoto: «usa i
-- predefiniti del calendario» e «nessun promemoria» sono due cose diverse, e
-- i predefiniti stanno in `calendarList`, che non leggiamo.
ALTER TABLE "calendar_events" ADD COLUMN "reminders" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reminders_use_default" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- LA RICORRENZA A PAROLE (Task 7), in una tabella A SÉ e non su
-- `calendar_series`, ed è una scelta: le due hanno proprietari e cicli di
-- vita DIVERSI. `calendar_series` è la CONFIGURAZIONE dell'utente, e
-- spegnere una serie la CANCELLA (`DELETE /series/:id` — «una serie mai
-- configurata e una spenta di nuovo sono la stessa cosa»); la ricorrenza è
-- invece un FATTO su Google, che non ha ragione di sparire quando qualcuno
-- spegne un'automazione — e se sparisse, il giro dopo il poller la
-- ri-scaricherebbe, pagando una chiamata per ogni spegnimento.
--
-- ⚠️ Una riga qui NON accende niente e non configura niente: non è letta da
-- `isReadyForProposal` né da nessun cancello. È solo «che regola ha questa
-- serie su Google», per poterla dire a parole.
CREATE TABLE "calendar_series_recurrence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "google_accounts"("id") ON DELETE CASCADE,
  "recurring_event_id" text NOT NULL,
  -- Le righe come le manda Google (`RRULE:FREQ=WEEKLY;BYDAY=MO`, più
  -- eventuali EXDATE/RDATE). GREZZE: tradurle in parole è lavoro di lettura,
  -- e conservare la traduzione la congelerebbe alla lingua e alla versione
  -- del parser del giorno in cui è stata scritta.
  "recurrence" text[] NOT NULL DEFAULT '{}',
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "calendar_series_recurrence_account_event_unique"
  ON "calendar_series_recurrence" ("account_id", "recurring_event_id");
