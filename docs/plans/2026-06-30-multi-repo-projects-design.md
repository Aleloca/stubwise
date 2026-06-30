# Progetti multi-repository — Design

**Data:** 2026-06-30
**Stato:** approvato (visione + Fase 1). Implementazione in 3 fasi.

## Visione

Oggi **Progetto = Repo**. Introduciamo:
- **Repository** = un singolo repo git (l'attuale "progetto", rinominato).
- **Progetto** = un raggruppamento di repository (es. un prodotto con frontend
  React + backend Express in due repo). Relazione **1:N** (un repo appartiene a
  esattamente un progetto).

Obiettivi finali:
- **Ticket** a livello di progetto; un fix può toccare **più repository**.
- **Documentazione** a livello di progetto, che aggrega **più repository**.

## Fasi (consegna incrementale, ogni fase si mergia + deploya + verifica)

- **Fase 1 — Modello + migrazione + UI** (questo design). Rename, nuova entità
  progetto, migrazione 1:1 (ogni repo → un progetto-wrapper), riorganizzazione di
  route/UI. Fix e Docs restano **per-repository** sotto il progetto → **zero
  regressioni di comportamento**.
- **Fase 2 — Docs multi-repo**: documentazione di progetto che aggrega i repo
  (design dedicato).
- **Fase 3 — Fix multi-repo**: ticket di progetto, fix che tocca più repository
  (PR multiple, contesto cross-repo). Frontiera, **design dedicato a parte** —
  ma le scelte di Fase 1 sono già compatibili.

---

# Fase 1 — Dettaglio

## Modello dati

### `projects` (NUOVA entità = gruppo)
- `id`, `name`, `slug` (unico), `description?`, `createdAt`.
- Impostazioni di prodotto (salgono dal vecchio progetto): **`aiProviderId`**
  (FK `ai_providers`, vale per tutti i repo del progetto), **`docAutoUpdate`**.

### `repositories` (l'attuale `projects`, RINOMINATO)
- `id` (invariato), **`projectId`** (FK `projects`, NOT NULL — un repo sta sempre
  in un progetto), `name`, `slug` (unico — il webhook lo usa nell'URL),
  `provider`, `gitAccountId`, `repoUrl`, `defaultBranch`, `ingestionKey`,
  `webhookSecret`, `currentDocGenerationId`, `createdAt`.
- Tutto ciò che è specifico del repo git/ingest resta qui.

## Classificazione delle 12 tabelle con FK a `projects`

**→ a livello PROGETTO** (il loro `project_id` punta alla NUOVA `projects`):
- `tickets` — product-level. **Aggiunge `repositoryId`** (FK `repositories`,
  nullable) = repo bersaglio del fix. Fase 1: valorizzato (un repo per ticket);
  Fase 3: opzionale/multiplo.
- `milestones` — pianificazione di prodotto.

**→ a livello REPOSITORY** (il loro FK punta a `repositories`; rinomino la colonna
`project_id` → `repository_id` per chiarezza — i dati puntano già al repo giusto
dopo il rename della tabella):
- `errorGroups` (ingest SDK, legato all'`ingestionKey` del repo)
- `projectEnvFiles` (file .env materializzati nel worktree del repo) → tabella
  rinominabile in `repositoryEnvFiles`
- `docGenerations`, `docGenerationJobs`, `docAutoUpdateJobs`, `docPages`,
  `docChunks`, `docNodes`, `docChatSessions`, `docSearchHistory` (tutta la doc è
  per-repo in Fase 1)

Nota: `ai_jobs` non referenzia `projects` (è legata a `ticketId`): resta com'è;
l'esecuzione del fix gira sul `tickets.repositoryId`.

## Migrazione (deterministica: ogni repo vecchio → un progetto nuovo 1:1)

1. **Rinomina** la tabella `projects` → `repositories` (con FK/constraint/indici).
   Le righe mantengono gli `id`: ogni FK che puntava a `projects.id` ora punta a
   `repositories.id` (corretto per le tabelle repository-level).
2. **Crea** `projects` (gruppo). Per OGNI repository inserisci un progetto-wrapper
   (`name`/`slug` derivati dal repo, slug deconflittato se serve), setta
   `repositories.projectId`, e **sposta** `aiProviderId`/`docAutoUpdate` dal
   repository al suo progetto (poi rimuovi quelle colonne da `repositories`).
3. **Tabelle product-level** (`tickets`, `milestones`): rinomina il loro
   `project_id` → `repository_id` (punta già al repo) e **aggiungi** un nuovo
   `project_id` (FK `projects`, NOT NULL) valorizzato col progetto-wrapper di quel
   repo. Per `tickets`, `repository_id` = il repo bersaglio (il vecchio project_id).
   Per `milestones`: idem (un milestone resta legato al progetto; se in futuro i
   milestone diventano cross-repo è già pronto).
4. **Tabelle repository-level**: rinomina `project_id` → `repository_id` (solo
   chiarezza; il dato è già corretto).

La migrazione è scrivibile a mano in SQL (rename + create + UPDATE deterministici);
i dati restano consistenti perché la mappa repo→progetto è 1:1.

## API / route

- **Nuove** `/api/projects` (CRUD gruppi: lista, dettaglio, crea, update con
  `aiProviderId`/`docAutoUpdate`, elenco repository del progetto).
- Gli attuali `/api/projects/...` che gestivano il repo (git account, branch,
  webhook config, env-files, docs) diventano **`/api/repositories/...`**.
- **Ticket/milestone/board/viste**: restano `/api/projects/:projectId/...` ma
  `:projectId` ora è il GRUPPO; la creazione ticket riceve anche il `repositoryId`.
- **Docs**: `/api/repositories/:repositoryId/docs/...` (per-repo in Fase 1).
- **Webhook git**: `/webhooks/git/:repositorySlug` (gli eventi git sono per-repo:
  push → auto-update docs del repo; merge PR → chiude il ticket del progetto la
  cui branch `stubwise/ticket-N` è del repo).

## Slack

- `/docs` (modale): in Fase 1 il selettore elenca i **repository** (docs per-repo).
  La risoluzione del progetto è derivata dal repository.

## UI web

- **Nuova sezione "Progetti"**: lista dei gruppi; dettaglio progetto con la lista
  dei suoi **repository** + impostazioni di progetto (provider AI, auto-update).
- **Repository**: ognuno col proprio setup (git account, branch, webhook,
  env-files, generazione/auto-update Docs) — è la UI attuale del "progetto",
  spostata sotto il repository.
- **Ticket / board / milestone / viste salvate**: a livello di **progetto**
  (filtrano i ticket del progetto, che possono avere repository bersaglio diversi).
  Il dialog **"Nuovo ticket"** sceglie **progetto + repository bersaglio**; la
  board mostra una colonna/eventuale badge del repo bersaglio.
- **Documentazione**: l'hub `/docs` elenca gli **spazi per repository** (sotto il
  progetto); il resto della UX docs invariato.
- **Provider AI / auto-update**: nelle impostazioni del **progetto**.

## Testing (Fase 1)

- DB: migrazione (rename tabella, nuova tabella, UPDATE deterministici, rename
  colonne, spostamento settings). Verifica integrità FK e che ogni repo abbia un
  progetto.
- Server: nuove route projects (CRUD); le route repositories (rinominate)
  invariate nel comportamento; ticket/milestone con `projectId`+`repositoryId`;
  webhook su `:repositorySlug`.
- Worker: fix gira sul `tickets.repositoryId`; docs/auto-update sul repository;
  comportamento invariato (solo cambio di nomi/scoping).
- Web: nuova sezione Progetti; repository sotto progetto; nuovo-ticket con repo
  bersaglio; provider/auto-update sul progetto.

## Deploy

`server` + `worker` + `caddy`. Migrazione applicata dal server all'avvio. Worker a
generazioni ferme (fail-on-restart). **Backup DB prima** (migrazione strutturale
importante).

## Compatibilità con Fase 2/3 (decisioni già prese in Fase 1)

- `tickets.repositoryId` nullable: pronto per il fix multi-repo (Fase 3:
  opzionale/relazione N, l'agente sceglie i repo).
- Docs a livello repository ma sotto il progetto: Fase 2 introduce
  l'aggregazione di progetto senza rifare il modello.

## Fuori scope (Fase 1)

- Documentazione aggregata di progetto (Fase 2).
- Fix che tocca più repository / PR multiple / contesto cross-repo (Fase 3).
- Spostare un repository da un progetto a un altro via UI (nice-to-have successivo).
