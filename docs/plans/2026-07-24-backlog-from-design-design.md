# Creare una voce di backlog da un design già pronto

Data: 2026-07-24
Stato: design validato, pronto per il piano di implementazione

## Obiettivo

Quando si ha **già un design doc completo**, creare una voce di backlog che
contenga quel design **verbatim**, usando l'AI **solo** per stimare i metadati
(effort/rischio/urgenza) — senza la sintesi del documento fatta dall'intake da
feedback grezzo.

Nasce da un problema reale: `create_backlog_item` è pensato per *feedback grezzo*
→ l'intake fa girare un agente che **riscrive** il testo in "un documento di
design conciso" (`apps/worker/src/backlog/prompts.ts`, `intakeOutputSchema`).
Passandogli un design finito, lo **appiattisce in un riassunto**. In più la skill
attuale spingeva Claude a non usare `set_design` su una voce nuova, lasciando una
descrizione generica. Vedi [[stubwise-design-plan-fields]].

## Decisioni validate

- Percorso **distinto** con un tool dedicato (nome esplicito → Claude lo sceglie
  quando ha un design pronto), non un flag su `create_backlog_item`.
- La voce si crea **sincrona**: `document = design` verbatim, `status = new`,
  `source = manual`, metadati/embedding `null`. L'`itemId` torna **subito**
  (niente polling).
- Un job leggero stima **solo** i metadati (effort/rischio/urgenza) dal document e
  calcola l'embedding. **Non** riscrive il documento.
- **Niente auto-merge**: la voce si crea sempre com'è (design deliberato).
  L'embedding si calcola comunque, così le voci FUTURE (da feedback grezzo)
  possono deduplicare contro questa.
- I metadati stimati vanno sui **campi diretti** (effort/risk/urgency), come fa
  l'intake — non su `suggested` (la voce nasce senza stime, è la loro prima
  assegnazione).

## Architettura

### Nuovo job kind `estimate`

- `packages/shared/src/schemas/backlog.ts`: aggiungere `"estimate"` a
  `backlogJobKindSchema` (il `pgEnum` in `packages/db/src/schema.ts` lo eredita
  via `enumValues`). Nuovo `backlogEstimatePayloadSchema = z.object({ itemId:
  z.uuid() }).strict()` aggiunto alla union `backlogJobPayloadSchema` (la forma
  `{ itemId }` da sola non collide con le esistenti).
- **Migrazione 0059**: `ALTER TYPE "public"."backlog_job_kind" ADD VALUE
  'estimate';` (precedente identico: `0045_doc_page_kind_product.sql`). Additivo,
  usato solo a runtime → nessuna trappola batch-in-transazione.

### Server — nuovo endpoint

`POST /api/backlog/from-design` (`requireAuth`), body
`{ projectId, title: string(1..300), design: string(1..200_000) }` (schema
condiviso `createBacklogFromDesignSchema`). In transazione:
1. `insert(backlogItems).values({ projectId, title, document: design, source:
   "manual" }).returning({ id })` — la voce nasce col design verbatim, metadati e
   embedding null.
2. `insert(backlogJobs).values({ projectId, kind: "estimate", payload: { itemId }
   })`.
Risposta **201** `{ itemId, url }` (sincrona; url = `${publicUrl}/backlog/<id>`).
404 se il progetto non esiste.

### Worker — handler `estimate`

Nuovo `apps/worker/src/backlog/estimate.ts` → `runEstimate(deps, job, { itemId })`:
1. Carica l'item (404/skip se assente o già chiuso).
2. `embed([item.document])` (riusa `deps.embeddingClient`, dim 1024, come l'intake).
3. Prompt **metadati-only**: riceve il `document` già pronto, ritorna solo
   `{ effort, risk, riskNote?, urgency }` (schema nuovo `estimateOutputSchema`;
   modellato sulla parte "LE STIME" di `buildIntakePrompt` e su `buildDeepDivePrompt`
   che già stima senza riscrivere il documento). `parseAgentJson` difensivo.
   `permissionMode: "default"` (input non fidato, run senza tool), come l'intake.
4. `update(backlogItems).set({ effort, risk, riskNote, urgency, embedding: vec })`
   `where id = itemId` (non tocca `document`).

Dispatch (`apps/worker/src/backlog/poller.ts`):
- Aggiungere `'estimate'` alla `IN`-list del claim del poller lento (`:171`).
- Nuovo case in `runBacklogJob` (`:284`): `safeParse` di
  `backlogEstimatePayloadSchema` (→ `MalformedBacklogPayloadError` se KO) →
  `runEstimateFn(deps, job, parsed.data)`.
- `runEstimateFn?` in `BacklogPollerDeps` (iniezione per i test, pattern
  `runIntakeFn`/`runDeepDiveFn`).
- Recovery orfani (`recoverStaleBacklogJobs`) e serializer per-progetto: `estimate`
  ci rientra automaticamente (non è escluso come `chat_turn`; passa per
  `serializer.run(projectId, …)`).

### MCP — nuovo tool

`create_backlog_from_design` `{ project?, title, design }` in `packages/mcp`:
- Client: `createBacklogFromDesign(projectId, title, design)` → `POST
  /api/backlog/from-design` → `{ itemId, url }`.
- Tool (`tools/write.ts`): risolve il progetto (`resolveProject`, come gli altri),
  chiama il client, ritorna itemId + url. Descrizione esplicita: **usare quando
  hai già un design doc completo** (verbatim + solo stima metadati), a differenza
  di `create_backlog_item` (feedback grezzo → l'intake lo sintetizza).
- Autonomia runtime preservata (nessun import runtime da `@stubwise/shared`).

### Guidance (il problema del collega)

- **Skill** `stubwise`: chiarire i tre percorsi di creazione/arricchimento —
  `create_backlog_from_design` (design pronto → verbatim); `create_backlog_item`
  (feedback grezzo → sintesi AI); `set_design` (sostituisce il corpo di una voce/
  ticket **esistente**, verbatim, funziona anche su una voce appena creata).
- **Descrizioni tool** aggiornate di conseguenza (valgono anche senza skill).
- **Changeset** MCP **minor** (nuovo tool) → prossima release `0.3.0`.

## Errori e test

- Server: `POST /from-design` → 201 con itemId; l'item esiste subito col document
  verbatim; un job `estimate` `{itemId}` è accodato; 404 progetto inesistente;
  400 su body invalido (design vuoto / >200k). Test in `backlog.test.ts`.
- DB: migrazione 0059 (enum ha `estimate`); payload schema; test in `schema.test.ts`.
- Worker: `runEstimate` con agente mockato → l'item riceve effort/risk/urgency +
  embedding, `document` INVARIATO; job kind `estimate` dispatchato dal poller;
  payload malformato → MalformedBacklogPayloadError. Test in `estimate.test.ts` +
  `poller.test.ts`.
- MCP: `createBacklogFromDesign` mappa l'endpoint giusto; il tool risolve il
  progetto e ritorna itemId+url; errori → ToolResult isError. Autonomia dist
  (grep `@stubwise/shared` vuoto).
- `pnpm lint` prima del merge.

## Fasi / deploy

Unica fase (feature contenuta). Deploy: migrazione 0059 all'avvio server →
**backup DB** + rebuild `server` + `worker` (nessuna modifica UI: la voce nasce
`new` e appare in `/backlog` come le altre; l'eventuale render è già coperto).
MCP via Changesets (changeset → PR Version Packages → `0.3.0`). Skill: la versione
raw su GitHub è già usata dai `curl` nella guida — chi l'ha copiata la ri-scarica.

## Riferimenti (codice)

- Enum/payload: `packages/shared/src/schemas/backlog.ts:37,101`;
  `packages/db/src/schema.ts:106` (pgEnum), `:2019` (backlogItems), `:2122`
  (payload jsonb). Precedente ADD VALUE: `packages/db/drizzle/0045_doc_page_kind_product.sql`.
- Intake (stima + embedding + insert): `apps/worker/src/backlog/intake.ts:58,261,362`;
  prompt `apps/worker/src/backlog/prompts.ts:60`; deep-dive metadati-senza-riscrittura
  `apps/worker/src/backlog/deep-dive.ts:221`.
- Poller/dispatch: `apps/worker/src/backlog/poller.ts:171,234,284,337`.
- Endpoint create attuale: `apps/server/src/routes/backlog.ts:921`.
- Serializer: `apps/worker/src/handler.ts:287`.
