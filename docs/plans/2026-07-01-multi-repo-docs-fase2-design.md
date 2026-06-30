# Documentazione di progetto (Fase 2 multi-repo) — Design + Piano

**Data:** 2026-07-01
**Stato:** progettato in autonomia (utente assente). Decisioni con default ragionati, evidenziate per revisione.
**Dipende da:** Fase 1 (modello a due livelli, già su `main`).

> **For Claude:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development per l'esecuzione.

## Obiettivo

Oggi (post-Fase 1) tutta la documentazione è **per-repository**. La Fase 2 aggiunge
un'esperienza **a livello di progetto** che **aggrega i repository del gruppo**:
1. **Hub di progetto**: elenca gli spazi-doc dei repo del progetto in un'unica vista.
2. **Chat RAG di progetto**: recupera dai chunk di **tutti** i repo del progetto e
   **cita da quale repository** proviene ogni fonte.
3. **Slack `/docs`**: può interrogare un intero **progetto** (oltre al singolo repo).
4. **Ricerca di progetto**: full-text/semantica sull'unione dei repo.

**Principio guida:** è un layer di **lettura/scoping**, NON una nuova pipeline di
generazione. La generazione resta per-repository (l'engine `docs-engine` resta
single-repo). Nessuna modifica a `doc_pages`/`doc_chunks`/`doc_nodes`/embeddings.
**Zero regressioni**: le esperienze per-repository esistenti restano identiche.

## Decisioni (default ragionati — rivedibili)

- **D1 — Retrieval cross-repo con filtro generazione PER-REPO.** Il punto debole è
  che `currentDocGenerationId` è per-repo: NON si può usare un solo
  `IN (currentGenIds)` piatto (mescolerebbe generazioni stale). Si costruisce un OR
  di coppie `(repositoryId = A AND (generationId = currentA OR generationId IS NULL))`
  per ciascun repo del progetto. L'indice `doc_chunks (repositoryId, generationId)`
  copre la forma. → nuova `retrieveChunksForProject`.
- **D2 — Citazioni arricchite col repository.** `RetrievedChunk` e `Citation`
  guadagnano `repositoryId`, `repositorySlug`, `repositoryName`. Il system prompt
  istruisce il modello a disambiguare per repository; il blocco "Fonti" (web/Slack)
  mostra il repo. **Retro-compatibile**: nelle esperienze per-repo i campi sono
  valorizzati ma la UI può ignorarli.
- **D3 — Sessioni chat di progetto.** Migrazione 0034: `doc_chat_sessions` acquista
  `project_id` (FK projects, cascade) **nullable**, e `repository_id` diventa
  **nullable**. Una sessione è *o* repo-level *o* project-level (esattamente uno dei
  due valorizzato; vincolo CHECK). Nessuna perdita: le righe esistenti restano
  repo-level.
- **D4 — Slack `/docs` interroga il PROGETTO.** Il selettore elenca i **progetti**
  con almeno un repo documentato. La risposta cerca su tutti i repo del progetto e
  cita il repo per ogni fonte; il link "Fonti" usa il `repositoryId` della fonte.
  (I repo singoli restano raggiungibili dalla UI web; per Slack si sceglie il
  progetto = caso d'uso Fase 2.)
- **D5 — Ricerca di progetto SENZA persistenza storia (YAGNI).** L'endpoint di
  ricerca di progetto riusa il retrieval cross-repo. La **cronologia** (`doc_search_history`,
  UNIQUE `(userId, repositoryId, slug)`) resta **per-repository** (niente migrazione
  per ora): la palette di progetto non registra storia in Fase 2. Si potrà
  aggiungere `project_id` in seguito se serve.
- **D6 — `k` di retrieval proporzionale.** La chat per-repo usa `k=8`. Per il
  progetto si usa `k` cresciuto col numero di repo (es. `min(8 + 4*(nRepo-1), 24)`),
  con over-fetch invariato, per non perdere copertura sui repo grandi.

## Modello dati (migrazione 0034)

- `doc_chat_sessions`: `ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE cascade`
  (nullable); `ALTER COLUMN repository_id DROP NOT NULL`; `ADD CONSTRAINT
  doc_chat_sessions_scope_chk CHECK ((repository_id IS NOT NULL) <> (project_id IS NOT NULL))`.
  Idx `(project_id)` per il lookup sessione di progetto. Nessun'altra tabella cambia.

## Server

- **Retrieval** (`apps/server/src/routes/docs-retrieval.ts`):
  - `RetrievedChunk` + `repositoryId/repositorySlug/repositoryName`.
  - nuova `retrieveChunksForProject(db, embeddingClient, projectId, query, options)`:
    carica `{id, slug, name, currentDocGenerationId}` dei repo del progetto; costruisce
    lo scope OR-di-coppie (D1); le due gambe (semantic/full-text) join su `doc_pages`
    + `repositories` per arricchire le citazioni; merge/rank invariati. Se il progetto
    non ha repo documentati → `[]`.
  - `retrieveChunks` (per-repo) invariata, ma arricchita coi campi repo (join repo).
- **RAG non-streaming** (`apps/server/src/routes/docs-rag.ts`): `Citation` +
  campi repo; `buildDocsSystemPrompt`/`buildCitations` istruiscono/espongono il repo;
  nuova `answerProjectDocsQuestion(deps, {projectId, question})` che usa il retrieval
  cross-repo (riusa il cuore).
- **Route di progetto** (nuovo `apps/server/src/routes/project-docs.ts`, montato sotto
  `/api/projects/:projectId/docs`):
  - `GET /spaces` — elenco spazi-repo del progetto (riusa la query hub, group by
    repo, filtrata `projectId`).
  - `GET /search?q=` — ricerca cross-repo (no history).
  - `POST /chat` — chat SSE streaming di progetto (sessione project-level, D3);
    retrieval cross-repo, citazioni col repo. Stessa meccanica SSE della chat per-repo.
  - `GET /chat/sessions`, `GET /chat/sessions/:id/messages` — scoped a `(projectId,userId)`.
- **Hub globale** (`GET /api/docs/spaces`): invariato (lista repo-spazi); la SPA
  introduce sopra il raggruppamento per progetto (vedi Web). In alternativa si può
  aggiungere `GET /api/projects-with-docs`; scelta implementativa lasciata al task web/server.

## Slack (`apps/server/src/slack/*`)

- `listProjectsWithDocs` → ritorna i **progetti** (id = projectId) con ≥1 repo
  documentato (rinominare la funzione/var coerentemente: in Fase 1 erano repo).
- Modal `buildDocsQueryModal`: option.value = projectId.
- Submit → `answerAndPostToSlack` accetta un `projectId`, usa `answerProjectDocsQuestion`;
  il blocco "Fonti" usa `repositoryId` di ciascuna citazione per il link
  `${publicUrl}/docs/${repositoryId}/${slug}` e mostra il nome repo.

## Web (`apps/web`)

- **Hub `/docs`** (`routes/docs/index.tsx`): raggruppa gli spazi **per progetto**
  (header progetto → card dei repo-spazi). Da Fase 1 ogni progetto wrapper ha 1 repo;
  con più repo si vede l'aggregazione.
- **Landing di progetto** `/docs/project/$projectId` (NUOVA route, segmento distinto
  per evitare l'ambiguità col param `$projectId`=repositoryId esistente): mostra i
  repo-spazi del progetto + una **chat di progetto** (cross-repo) con citazioni che
  indicano il repository. Riusa i componenti chat esistenti, estesi per mostrare il
  repo nelle citazioni.
- Le viste **per-repository** esistenti (`/docs/$projectId` = repo) restano invariate.
- `docs-api.ts`: aggiunge le funzioni project-scoped (spaces/search/chat/sessions).
- i18n: label "Documentazione di progetto", "Tutti i repository", indicazione repo
  nelle citazioni.

## Testing

- DB: migrazione 0034 (project_id nullable, repository_id nullable, CHECK xor); righe
  esistenti restano repo-level; sessione di progetto valida, sessione con entrambi/nessuno
  → viola il CHECK.
- Server: `retrieveChunksForProject` recupera da più repo, filtro generazione per-repo
  (un chunk di una generazione stale di un repo NON compare; un chunk manuale sì);
  citazioni arricchite col repo; chat di progetto crea sessione project-level e cita i
  repo; due repo nello stesso progetto entrambi rappresentati; ricerca cross-repo.
- Slack: selettore elenca progetti; risposta cita i repo; link con repositoryId.
- Web: hub raggruppato per progetto; landing di progetto con chat cross-repo; citazioni
  mostrano il repo; viste per-repo invariate.

## Fuori scope (Fase 2)

- Generazione unificata cross-repo (l'engine resta single-repo).
- Storia di ricerca a livello progetto (D5).
- Fix multi-repo (Fase 3).

## Piano (task subagent-driven)

- **Task 1 — DB + retrieval core.** Migrazione 0034; `RetrievedChunk`/`Citation` +
  campi repo; `retrieveChunks` arricchita; `retrieveChunksForProject`; test server del
  retrieval. (`apps/server`, `packages/db`)
- **Task 2 — Route docs di progetto.** `project-docs.ts` (spaces/search/chat/sessions),
  `answerProjectDocsQuestion`; registrazione in app.ts; test.
- **Task 3 — Slack progetto.** selettore progetti, risposta cross-repo, citazioni repo; test.
- **Task 4 — Web.** hub per progetto, landing `/docs/project/$projectId` con chat
  cross-repo e citazioni col repo; docs-api project-scoped; i18n; test (+ E2E coerenza).
- **Task 5 — Verifica + review olistico + merge** (deploy demandato all'utente).
