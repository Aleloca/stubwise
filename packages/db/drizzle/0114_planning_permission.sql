-- Integrazione area 2, fetta 2 (9 nov 2026): `planning.others` (pianificare
-- le task altrui) va nel preset `project_lead` e in nessun altro: Developer e
-- Legacy Member no (decisione del maintainer), Contributor e Viewer no. Il
-- catalogo sta nel codice, il preset nel DB (0097): senza questa riga un
-- Project Lead esistente non lo avrebbe. `distinct unnest` come la 0103:
-- il preset può essere già stato modificato, e la migrazione resta idempotente.
UPDATE "roles"
SET "permissions" = ARRAY(
	SELECT DISTINCT p FROM unnest("permissions" || ARRAY['planning.others']) AS p
)
WHERE "preset_key" = 'project_lead';
