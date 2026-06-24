# Provider bloccato per la generazione dei Docs — Design

**Data:** 2026-06-24
**Stato:** approvato, pronto per il piano di implementazione

## Obiettivo

Permettere, opzionalmente, di **bloccare una generazione della documentazione su
un singolo provider AI** (account o API key) scelto, senza mai usare altri
provider come fallback. Il default resta invariato.

## Stato attuale (verificato)

La generazione Docs **non fa fallback tra provider**: `resolveProvider()` in
`apps/worker/src/docs/recursive/node-dispatch.ts:247` prende **sempre `chain[0]`**
(il primo provider abilitato per `position`, da `loadProviderChain`). Il
fallback a catena su rate-limit esiste solo per i fix dei ticket
(`apps/worker/src/handler.ts`), non per i Docs. Quindi la generazione è già di
fatto "bloccata sul primo provider".

I provider stanno in `aiProviders` (`packages/db/src/schema.ts:550`): `position`
(ordine), `kind` (`account`|`api_key`), `label`, `secretEncrypted`, `enabled`.
Esiste già `GET /api/ai-providers` (admin, `apps/server/src/routes/ai-providers.ts`)
che li elenca ordinati per position.

## Decisione di design

**Default invariato**: usa il primo provider abilitato, niente fallback (non si
aggiunge fallback ai Docs). L'opzione serve solo a **scegliere un provider
specifico** per quella generazione. La garanzia "niente fallback" è già
intrinseca; la regola nuova e cruciale è: **se il provider scelto non è
disponibile al run (disabilitato/cancellato), la generazione FALLISCE con errore
chiaro — mai ripiego su `chain[0]`**.

Scelta **per-generazione** (al trigger), non impostazione di progetto.

## Dati (migrazione 0030)

- `doc_generation_jobs.pinned_provider_id uuid` — porta la scelta dal trigger al
  worker. FK → `ai_providers`, `ON DELETE SET NULL`, nullable.
- `doc_generations.pinned_provider_id uuid` — audit + visualizzazione nello
  stato. FK → `ai_providers`, `ON DELETE SET NULL`, nullable.

## Server

- `POST /projects/:projectId/docs/generate`: body opzionale `{ providerId?: string }`.
  - Se presente: il provider deve **esistere ed essere `enabled`**, altrimenti
    `400 provider_not_available`. Salvato su `doc_generation_jobs.pinned_provider_id`.
  - Idempotenza invariata: se c'è già un job `queued`/`running` lo restituisce
    com'è (la scelta del job in volo vince; il `providerId` nuovo è ignorato).
- `GET /projects/:projectId/docs/status`: aggiunge
  `pinnedProvider: { id, label, kind } | null` della generazione/job correnti.
- Dropdown popolato da `GET /api/ai-providers` (già esistente).

## Worker (il "blindaggio")

- Il trigger handler (`apps/worker/src/docs/handler.ts`) legge
  `job.pinnedProviderId` e lo propaga: nella riga `doc_generations` (al seed) e
  nelle deps del dispatch dei nodi.
- Nuova `loadProviderById(db, key, id)` in `apps/worker/src/providers/chain.ts`:
  risolve **solo** quel provider se `enabled`, altrimenti `null`.
- `resolveProvider()` (node-dispatch) e la scelta del trigger diventano:
  - `pinnedProviderId` impostato → carica quel provider; se `null`
    (disabilitato/cancellato) → **fallisce la generazione** con errore chiaro,
    niente ripiego su `chain[0]`;
  - altrimenti → comportamento attuale (`chain[0]`).
- La stessa credenziale vale per orientamento, esplorazioni e sintesi.

## UI (`docs-generation-panel.tsx`, admin)

- Dropdown **"Provider"** sopra il pulsante *Genera documentazione*: default
  `Automatico (primo abilitato)` + i provider **abilitati** (`label` + tag
  `ACCOUNT`/`API KEY`), da `GET /api/ai-providers` (React Query). Disabilitato a
  generazione in corso. Se non ci sono provider, mostra solo "Automatico".
- `generateDocs(projectId, providerId?)` passa la scelta.
- Nello stato mostra `Provider: <label>` quando la generazione corrente/ultima è
  bloccata su uno; nulla in automatico.

## Testing

- *DB*: migrazione 0030 + colonne.
- *Server*: `generate` con `providerId` valido lo salva; provider
  disabilitato/inesistente → `400`; `status` ritorna `pinnedProvider`.
- *Worker*: con pin la generazione usa quel provider (non `chain[0]`); pin
  disabilitato/cancellato al run → **fail**, niente ripiego; senza pin →
  `chain[0]`; propagazione a orientamento + nodi.
- *Web*: dropdown popolato, default automatico, `generateDocs` riceve
  `providerId`, lo stato mostra il provider bloccato.

## Deploy

`server` (migrazione + endpoint) + `worker` (logica provider) + `caddy` (UI). Il
**worker va ricostruito quando NON c'è una generazione in corso** (vincolo
fail-on-restart, vedi CLAUDE.md).

## Fuori scope

- Fallback a catena nel default dei Docs (esplicitamente escluso).
- Impostazione di provider di default per progetto (la scelta è per-generazione).
- Modifiche al fallback dei fix dei ticket.
