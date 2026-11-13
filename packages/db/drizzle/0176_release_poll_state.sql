-- Area 8, F1 (review del server): lo stato dell'ultima lettura delle run di CI
-- e il turno del poller. `ci_unreadable_at`: l'ultima lettura del provider è
-- fallita (null = letta, o mai provata); il server lo usa per dire «non
-- leggibile» invece di indovinare uno stato. `last_polled_at`: il poller guarda
-- prima i rilasci guardati da più tempo, così nessuno resta indietro.
ALTER TABLE "releases" ADD COLUMN "ci_unreadable_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "last_polled_at" timestamp with time zone;
