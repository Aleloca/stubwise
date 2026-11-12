-- Review della F3b: la potatura del calendario guarda la FINE dell'evento, su tutta la tabella.
CREATE INDEX "calendar_events_ends_idx" ON "calendar_events" USING btree (coalesce("ends_at", "starts_at"));
