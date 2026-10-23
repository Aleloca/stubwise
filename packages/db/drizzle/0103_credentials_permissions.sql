-- Cassaforte delle credenziali (23 ott 2026): i tre permessi di progetto
-- nuovi vanno nel preset `project_lead` (e solo lì: Developer, Legacy Member,
-- Viewer e Contributor non li hanno). Il catalogo sta nel codice, il preset
-- nel DB (0097): senza questa riga un Project Lead esistente non li avrebbe.
-- `distinct unnest` perché il maintainer può aver già modificato i permessi
-- del preset, e perché la migrazione resti idempotente.
UPDATE "roles"
SET "permissions" = ARRAY(
	SELECT DISTINCT p FROM unnest("permissions" || ARRAY['credentials.create', 'credentials.edit', 'credentials.share']) AS p
)
WHERE "preset_key" = 'project_lead';
