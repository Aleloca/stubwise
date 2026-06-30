# Provider AI a livello di progetto — Design

**Data:** 2026-06-30
**Stato:** approvato, pronto per il piano di implementazione

## Obiettivo

Sostituire le associazioni provider AI sparse (per-generazione dei Docs +
per-progetto solo per l'auto-update) con **un'unica associazione a livello di
progetto** che vale per **TUTTI** i job AI del progetto: generazione Docs
(manuale + auto-update) e **fix dei ticket**.

## Decisioni (validate)

- **Solo a livello progetto**: un campo `projects.aiProviderId`. Niente override
  per-generazione (si toglie il selettore dal modale di generazione).
- **Strict ovunque, niente failover**: quando impostato, il provider scelto è
  l'unico usato. Su rate-limit del provider i fix vanno in **held** (riprendono
  dopo il reset), niente ripiego su altri provider. Per i Docs, provider non
  disponibile → generazione fallita con errore chiaro.
- **Default `null` = Automatico** = comportamento ATTUALE invariato: Docs usano il
  primo provider abilitato della catena; i fix usano la catena con failover.

## Modello dati

- **Rinomina** `projects.doc_auto_update_provider_id` → `projects.ai_provider_id`
  (preserva dati + FK `ai_providers` `on delete set null`). I progetti che avevano
  un provider per l'auto-update lo conservano come provider generale.
- **Elimina** `doc_generation_jobs.pinned_provider_id` (non più usato: la scelta
  non passa più dal modale/trigger).
- **Mantiene** `doc_generations.pinned_provider_id` come **snapshot** della
  generazione: seminato da `projects.aiProviderId` al lancio, così una generazione
  in volo resta coerente se l'impostazione del progetto cambia a metà.

## Comportamento

| Scenario | Docs (gen + auto-update) | Fix dei ticket |
|---|---|---|
| `aiProviderId` impostato | usa SOLO quel provider; non disponibile → generazione fallita | usa SOLO quel provider; rate-limit → `held` (no failover); non disponibile → held con messaggio |
| `aiProviderId` = null (Automatico) | `chain[0]` (primo abilitato) | catena con failover, held se esauriti (INVARIATO) |

## Worker

- **Docs trigger** (`apps/worker/src/docs/handler.ts` `createDocHandler`): non legge
  più `job.pinnedProviderId`; carica `project.aiProviderId`, lo risolve strict
  (`loadProviderById`; impostato ma non risolvibile → fallisce la generazione,
  niente fallback — logica già presente) e semina `doc_generations.pinnedProviderId`.
  Il dispatch dei nodi (legge `doc_generations.pinnedProviderId`) resta INVARIATO.
- **Auto-update** (`apps/worker/src/docs/auto-update.ts`): `docAutoUpdateProviderId`
  → `aiProviderId`. Logica strict invariata.
- **Fix** (`apps/worker/src/handler.ts`, loop provider `runJobWithProvider`): carica
  `project.aiProviderId`. Impostato → risolve UN provider (`loadProviderById`),
  esegue il job con SOLO quello; esito "limit" → `held` (no iterazione sulla
  catena); non risolvibile → held con messaggio chiaro. `null` → catena con
  failover INVARIATA (loop attuale).

## Server

- `POST /projects/:projectId/docs/generate`: rimuove il `providerId` dal body (la
  scelta viene dal progetto). Crea il job senza pin (colonna eliminata).
- Update progetto (`apps/server/src/routes/projects.ts`): campo `aiProviderId`
  (validato che esista, nullable) nello schema body e nella risposta (toPublicProject).
- `GET /docs/status`: continua a esporre `pinnedProvider` della generazione corrente
  (risolto da `doc_generations.pinned_provider_id`).

## Web

- **Impostazioni progetto** (`apps/web/src/components/project-form.tsx`): il selettore
  provider diventa **"Provider AI del progetto"** (vale per Docs + fix), mostrato
  sempre nel form (admin), default `Automatico (catena con failover)`, legato ad
  `aiProviderId`. Il toggle auto-update resta separato e indipendente.
- **Pannello generazione** (`apps/web/src/components/docs-generation-panel.tsx`):
  RIMUOVE il selettore di provider; il pulsante Genera lancia e basta.
  `generateDocs(projectId)` senza `providerId`. Lo stato continua a mostrare
  `Provider: <label>` della generazione corrente (da `status.pinnedProvider`).
- Tipi client `Project`/`ProjectPatch`: `docAutoUpdateProviderId` → `aiProviderId`.

## Testing

- DB: migrazione (rename colonna progetto, drop colonna job).
- Server: update progetto con `aiProviderId` valido/inesistente/null; generate non
  accetta più `providerId`; status ritorna `pinnedProvider`.
- Worker: docs trigger semina `doc_generations.pinned_provider_id` da
  `project.aiProviderId`; non disponibile → generazione fallita (no fallback);
  null → chain[0]. Fix: `aiProviderId` impostato → usa SOLO quel provider, esito
  limit → held senza toccare la catena; non risolvibile → held; null → catena con
  failover (regressione invariata).
- Web: form col selettore generale (sempre, admin); pannello generazione senza
  selettore; `generateDocs` senza providerId.

## Deploy

`server` (endpoint + migrazione) + `worker` (logica provider) + `caddy` (UI). Worker
ricostruito a generazioni ferme (fail-on-restart). Niente passaggi manuali.

## Fuori scope

- Provider per-generazione/override (consolidato a livello progetto).
- Cambiare la semantica della catena+failover quando il provider NON è associato.
