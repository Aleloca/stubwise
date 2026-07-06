# Auto-update Docs — Fase 3: pagine incrementali per aree nuove

Data: 2026-07-06 · Stato: design validato · Estende: auto-update Fase 1 (changelog) e Fase 2 (refresh mirato) in `apps/worker/src/docs/auto-update.ts`

## Obiettivo

Quando un push introduce **aree nuove** del repo (file che nessuna pagina docs
copre via `sourcePath`), l'auto-update crea **incrementalmente** le pagine
mancanti nella generazione corrente — senza rigenerazione completa. Caso reale:
app admin pushata il 4 lug, release note generata, ma il RAG non sapeva nulla
del billing (docs ferme al 2 lug).

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Trigger | **Automatico nel ciclo di push**, entro tetto `DOCS_AUTOUPDATE_MAX_NEW_PAGES` (default 5, 0 = off) |
| Collocazione | **Mini-orient**: 1 run agente decide fino a N pagine (titolo, kind, parentSlug tra le pagine esistenti, sourcePaths) |
| Profondità | Solo **pagine foglia** (children delle proposte ignorati); decomposizione profonda = rigenerazione completa |
| Coerenza | Insert nella **generazione corrente** (visibilità automatica in albero/ricerca/RAG/widget); `stats`/`cost` aggiornati esplicitamente; related links esistenti NON ricalcolati (degrado dichiarato) |

## Flusso

1. **Aggregazione deterministica** delle `newAreas` (file singoli) in aree:
   raggruppa per prefisso di cartella comune più lungo, risalendo finché il
   gruppo è ≥2 file o profondità ≤2; file isolato → la sua cartella. Pura,
   unit-testata.
2. **Mini-orient** (1 run, read-only, nel worktree effimero GIÀ aperto dalla
   Fase 2 — le fasi condividono `withWorktree`): input = aree aggregate coi
   file + struttura albero esistente (titoli/kind/slug overview) + tetto N;
   output a marcatori = fino a N proposte `{titolo, kind, parentSlug,
   sourcePaths}`. Proposte non parsabili / parentSlug inesistente → scartate
   best-effort.
3. **Un run per proposta** (sequenziale, `permissionMode: "plan"`): riusa
   `buildExplorePrompt` con titolo/sourcePaths/contesto genitore; si usa SOLO
   il body (children ignorati). Body vuoto o meta-summary → scarto, area nel
   residuo.
4. **Insert per pagina in transazione** (pattern Fase 2):
   - slug via `slugForNode(titolo, used)` con `used` = TUTTI gli slug della
     generazione (unique `(generation_id, slug)` sicuro anche su append
     ripetuti);
   - `parentId` dal parentSlug; `position` = max(position)+1 della
     generazione; `kind`; `sourcePath` = primo dei sourcePaths; stesso
     `generationId` corrente;
   - `doc_chunks` via `embedAndStoreChunks` (stesso chunking). Embedding
     giù → rollback della pagina, area nel residuo.
5. **Post-ciclo**: update di `doc_generations.stats` (pages/chunks) e `cost`
   (somma run Fase 3).
6. **Release note**: nuovo campo opzionale `createdPages: {slug,title}[]` nel
   contratto release (pattern `refreshedPages`) + blocco prompt; cross-link
   della entry estesi alle pagine create (fix del filtro `buildRelatedLinks`
   che oggi conosce solo le pagine pre-esistenti); la sezione deterministica
   "Aree nuove non documentate" elenca SOLO il residuo, e il suggerimento di
   rigenerazione completa resta solo se il residuo è non vuoto.

## Gate e indipendenza dalle fasi

- Il gate rumore esistente resta a monte (niente file materiali → niente
  Fase 3).
- Oggi `mapAffectedPages` gira solo se `maxRefreshPages > 0`: fix — gira se
  almeno una tra Fase 2 e Fase 3 è attiva, ognuna col suo tetto.

## Config

`DOCS_AUTOUPDATE_MAX_NEW_PAGES` (env worker, default 5, 0 = off) →
`WorkerConfig.docsAutoUpdateMaxNewPages` → `RunAutoUpdateDeps.maxNewPages`,
accanto a `maxRefreshPages` (`DOCS_AUTOUPDATE_MAX_PAGES`). Compose aggiornato.

## Testing

- Unit: aggregazione file→aree (casi limite: file isolati, prefissi comuni,
  profondità), parser contratto mini-orient, filtro proposte.
- Integrazione worker (runner finto, pattern test auto-update esistenti):
  proposta → pagina nella generazione corrente (slug dedupato, parentId,
  chunks embeddati) visibile dal retrieval; slug collidente → suffisso; body
  vuoto → residuo; tetto rispettato; stats/cost aggiornati; release note con
  "Pagine create" e residuo corretto; `maxNewPages=0` → Fase 3 spenta;
  Fase 3 attiva con Fase 2 spenta → newAreas comunque calcolate.

## Deploy

Solo **worker** (nessuna migrazione). ⚠️ Riavvio worker SOLO senza generazioni
`running`/`paused` (invariante). **Backfill**: dopo il deploy, accodare a mano
un job auto-update per il repo Audin sul range ultima-generazione→HEAD per
documentare incrementalmente l'app admin.

## Fuori scope

- Ricalcolo related links delle pagine esistenti
- Decomposizione profonda delle aree nuove (children)
- Bottone "documenta ora" on-demand (eventuale v2)
