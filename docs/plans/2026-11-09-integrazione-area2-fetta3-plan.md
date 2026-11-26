# Integrazione area 2, fetta 3 (Home a blocchi e filtri salvati) — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Home a blocchi (reparto e personale), ruoli di reparto, «Da decidere», catalogo dei blocchi dell'area 2 e filtri salvati funzionano contro il server vero, identici al prototipo, su desktop e `/app`.

**Spec:** `docs/plans/2026-11-09-integrazione-area2-fetta3-design.md`.

## Global Constraints

Quelli delle fette 1 e 2, più: branch `feat/integrazione-area2-fetta3` (parte dalla fetta 2). Migrazioni dalla prima libera dopo la fetta 2. Test solo filtrati.

## Review Focus

1. **Filtro pubblico con task di un progetto che chi guarda non vede**: non compaiono, né nel conteggio → test nel Task H.
2. **Home di reparto con un filtro privato**: rifiutata dal server → test nel Task I.
3. **Persona in più reparti con lo stesso blocco**: compare una volta, nell'ordine del primo reparto → test nel Task I (modulo puro).
4. **Blocco di un'area non integrata salvato in una Home**: nella build app non si mostra e non chiama nulla → test nel Task K.
5. **Eliminare un filtro fissato da altri**: sparisce dai loro fissati, resta «non disponibile» nelle Home → test nel Task H.

---

### Task H (backend): filtri salvati
`task_filters(id, owner_id null fk set null, name 1..80, visibility public|private, criteria jsonb, view list|board|timeline, group_by, created_at, updated_at)`, `pinned_task_filters(user_id, filter_id cascade, position, pk)`; seed idempotente dei 5 pubblici di esempio (owner null). Shared: `filterCriteriaSchema`, `periodRange(field, preset|range, today)`, `canUseStatusIds` (spostati da `domain/filters.ts`, adattatori nel desktop). Rotte: `GET /api/filters` (miei + pubblici), `GET /api/filters/:id` (404 se privato d'altri), `POST`, `PATCH /:id`, `DELETE /:id` (autore o full admin), `GET /api/me/pinned-filters`, `PUT /api/me/pinned-filters/:id` e `DELETE`. Test di parità `matches` (finto) ↔ `/api/tasks` (server) sui periodi del prototipo. api-client `filters.*`.

### Task I (backend): Home e ruoli di reparto
Shared: `FIXED_BLOCKS`, `sameBlock`, `withFixed`, `resolveHome`, `homeBlockSchema` (kind aperto: un kind ignoto passa e il client lo ignora). Registro dei permessi di reparto + `department.home.manage` (gruppo, frasi). DB: `department_roles`, `department_homes(department_id pk, blocks jsonb, updated_at, updated_by)`, `personal_homes(user_id pk, blocks jsonb)`, `personal_home_seen(user_id, department_id, seen_at, pk)`; migrazione con le Home d'apertura dei reparti esistenti. Rotte: `GET /api/me/home` (Home risolta + `departmentChanged` + blocchi «novità»), `PUT /api/me/home` (valida), `DELETE /api/me/home` (ripristina), `POST /api/me/home/seen/:departmentId`, `GET /api/departments/:id/home`, `PUT /api/departments/:id/home` (full admin o il permesso nel reparto; solo filtri pubblici), `PUT /api/departments/:id/roles` (instance `departments.manage`, senza riconferma, registro delle modifiche). `departmentPermissions` in `/api/auth/me`. api-client `home.*`, `departments.roles`.

### Task J (backend): richieste da trasformare
`GET /api/requests/to-convert` (voci di backlog new|refining|ready, non fuse, progetti visibili con `tickets.create`, dalla più recente; forma `ProjectRequest` minima del prototipo + `webHref`). api-client.

### Task K (renderer): superfici della fetta 3 nella build app
`integration.ts`: `home`, `filters`, feature `saved-filters`, `department-permissions`; `available` del registro dei blocchi passa da `featureIntegrated(<area>)`; atterraggio di nuovo su Home (`landingSearch` torna `{}`); l'extra «releases» di `resolveHome` spento in app; in «Da decidere» le sorgenti di Claude, chat, posta e automazioni spente. Test nella build app con «nessuna chiamata fuori elenco».

### Task L (renderer): implementazione vera
`real/{home,filters,requests,departments}.ts`: le funzioni di `data/api.ts` della ricognizione (`listDepartmentHomes`, `getPersonalHome`, `setPersonalHome`, `resetPersonalHome`, `setDepartmentHome`, `markDepartmentHomeSeen`, `listDepartmentRoles`, `listSavedFilters`, `getSavedFilter`, `listPinnedFilterIds`, `saveFilter`, `updateFilter`, `deleteFilter`, `setFilterPinned`, `listRequestsToConvert`) e la gestione dei ruoli nella pagina Reparti (senza riconferma). `departmentPermissions` dal viewer vero. Test con client finto.

### Task M (chiusura)
Parità `apps/desktop/docs/integration-slice3.md`, voce del deploy-log, `CLAUDE.md`/invarianti se servono.
