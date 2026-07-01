# Fix multi-repository (Fase 3) — Design

**Data:** 2026-07-01 (rivisto insieme all'utente)
**Stato:** VALIDATO in brainstorming con l'utente. Pronto per il piano di implementazione.
**Dipende da:** Fase 1 (modello a due livelli) e Fase 2 (docs cross-repo), entrambe in prod.

> Questo design sostituisce la bozza speculativa notturna: l'architettura è cambiata
> in meglio grazie alla visione dell'utente (un solo agente che vede tutti i repo del
> progetto, e sceglie da sé quali toccare).

## Obiettivo

Un singolo ticket può richiedere modifiche a **più repository dello stesso progetto**
(es. una feature che tocca API + web). L'agente esegue il fix vedendo **tutti** i repo
del progetto insieme, decide da sé su quali operare, e apre **una PR per ogni repo
modificato**. Il ticket si chiude quando **tutte** le PR sono mergiate.

## Decisioni validate (brainstorming)

- **D1 — L'AGENTE sceglie i repo, non l'utente.** Il triage (Haiku) resta invariato
  (tipologia + go/no-go). È **Opus, in fase di piano**, che esplorando il codice decide
  quali repo toccare. Nessuna multi-selezione manuale in "Nuovo ticket".
- **D2 — Modello uniforme "cartella progetto".** Ogni fix gira alla radice di una
  working dir `projectName/` che contiene un **worktree per ciascun repo del progetto**
  (`projectName/<repoSlug>/`). Un solo `claude` con `cwd = projectName/` vede tutto,
  come in un monorepo. Progetti con 1 repo → identico a oggi (nessun ramo speciale).
- **D3 — Un solo job di fix per ticket** (non uno per repo). Dopo l'esecuzione, per ogni
  repo con `git status` sporco → commit + push + **una PR**; i repo non toccati non
  producono nulla. Un fix che modifica un solo repo degrada naturalmente al caso di oggi.
- **D4 — RAG/Docs NON iniettata nel fix.** L'agente esplora liberamente i file. Motivo:
  i file non possono "sbagliare", la documentazione sì (stale/imprecisa) e potrebbe
  traviare l'agente. (Eventuale iniezione RAG = miglioramento separato, fuori scope.)
- **D5 — Numerazione per-progetto.** Il contatore si sposta da
  `repositories.next_ticket_number` a `projects.next_ticket_number`. Il branch
  `stubwise/ticket-N` usa N **di progetto** ed è pushato su ciascun repo modificato. Il
  webhook risolve il ticket per `(progetto del repo, N)`. Risolve la tensione nota della
  Fase 1 (numero per-repo vs unique `(projectId, number)`).
- **D6 — Serializzazione per-progetto, Livello 1.** Un solo fix attivo per progetto; gli
  altri ticket del progetto restano in coda finché il fix **non completa** (PR aperte),
  non fino al merge umano. Progetti diversi girano in parallelo. Elimina i conflitti
  **meccanici** (worktree/mirror); i conflitti **logici** tra PR parallele di ticket
  diversi si risolvono in review, come nel normale lavoro su git.
- **D7 — Chiusura aggregata.** Ticket → `in_review` quando le PR sono aperte; → `done`
  **solo quando tutte** le sue PR sono mergiate. Una PR chiusa-non-mergiata rimette in
  lavorazione **solo** quel repo, senza toccare gli altri.

## Modello dati (migrazione 0035)

- **`projects.next_ticket_number`** (integer, default 1): il contatore per-progetto.
  Migrazione: per ogni progetto, `next_ticket_number = max(tickets.number)+1` (oggi
  coincide col contatore del suo unico repo). Rimuovere/deprecare
  `repositories.next_ticket_number`.
- **Nuova `ticket_repositories`** — lo stato PR **per-repo** di un ticket:
  `id`, `ticketId` (FK tickets cascade), `repositoryId` (FK repositories cascade),
  `branch`, `prUrl` nullable, `prState` enum (`open|merged|closed_unmerged`),
  `createdAt`. UNIQUE `(ticketId, repositoryId)`. Popolata **dopo** l'esecuzione, una
  riga per repo effettivamente modificato.
- **`tickets.repositoryId`**: declassato a **"repo di origine"** (dove è nato il ticket:
  errore SDK via `ingestionKey`, o scelta al ticket manuale) — metadato nullable. NON è
  più il bersaglio d'esecuzione (il bersaglio è il progetto). La dedup del triage è già
  per `projectId` (nessun cambiamento lì).
- **`ai_jobs`**: resta **uno per ticket**. `prUrl` singolo è superato da
  `ticket_repositories` (per il multi-repo); mantenuto come "PR primaria" per
  retro-compatibilità del re-run, oppure deprecato in favore della lettura aggregata.

## Worker (cuore della fase)

- **Claim e serializzazione per-progetto**: il claim (`queue.ts`) e il serializer
  (`handler.ts`) passano da `repositoryId` a **`projectId`** (da `tickets.projectId`).
  L'esclusione fix↔generazione-docs si allarga: un fix di progetto esclude (ed è escluso
  da) qualunque worktree — fix o generazione — su **un qualsiasi repo del progetto**. Il
  provider AI è già risolto dal progetto (Fase 1), invariato.
- **MirrorManager — nuovo primitivo multi-worktree**: `withProjectWorktrees(project,
  repos, branch, fn)` che materializza, sotto una parent dir comune
  (`stubwise-proj-<slug>/`), un worktree per ogni repo (`<repoSlug>/`) agganciato al
  rispettivo mirror, su `git switch -C stubwise/ticket-N` in ciascuno; passa la parent
  dir a `fn`; cleanup di tutti i worktree in `finally`. I mirror per-repo esistono già;
  è "N `openWorktree` coordinati sotto una root". L'invariante mirror (niente
  `fetch --prune` con un worktree aperto) è rispettata dalla serializzazione per-progetto.
- **`runFix` sul progetto**: risolve il **progetto** dal ticket, carica i suoi repo,
  materializza i worktree, esegue **un** agente `claude` con `cwd = projectName/` (piano
  Opus → esecuzione Sonnet, come oggi). Materializzazione env-files **per ogni repo** nel
  proprio worktree (safeguard anti-leak invariato). Install/test: l'agente li lancia dove
  servono nei sotto-repo (i comandi install/test sono per-repo, gestiti come oggi ma
  dentro le sottocartelle).
- **Apertura PR multipla**: dopo l'agente, per ogni repo con diff: commit (autore
  `Stubwise AI`), `pushBranch`, `openPullRequest` via il provider di **quel** repo;
  inserisce una riga `ticket_repositories` con branch/prUrl/prState=open. Nessun repo
  modificato → esito "nessuna modifica" (come oggi il caso NoChangesError).
- **Prompt** (`prompts.ts`): il contesto elenca i repo del progetto come sottocartelle e
  istruisce l'agente a modificare solo quelle necessarie; per il resto la cornice è
  quella attuale (solo contenuto del ticket, nessuna RAG — D4).
- **Costo**: un agente su tutti i repo esplora di più → **più token di discovery per
  ticket** (accettato). Il budget per-ticket e mensile resta il guardrail (invariato).

## Server

- **Create ticket**: numero da `projects.next_ticket_number` (row-lock sul progetto);
  `tickets.repositoryId` = repo d'origine (ingest/manuale). Dedup triage invariata
  (per progetto).
- **Webhook merge** (`webhooks.ts`): estrae N dal branch `stubwise/ticket-N`, risolve il
  ticket per `(progetto del repo del webhook, N)`, marca la **riga** `ticket_repositories`
  di quel repo come `merged`; porta il ticket a `done` **solo se tutte** le righe sono
  `merged` (gate aggregato). `closed_unmerged` → quella riga torna `closed_unmerged`, il
  ticket resta/rientra in lavorazione per quel repo.
- **Mapper ticket / API**: espone lo stato per-repo (le righe `ticket_repositories` con
  prState + link PR). Costi: `ticketCostUsd` aggrega già per ticket via job → invariato.

## Web

- **Nuovo ticket**: NESSUNA multi-selezione repo (l'AI decide — D1). Resta la scelta del
  progetto (e per i ticket manuali, opzionalmente il repo d'origine).
- **Dettaglio ticket**: nuova sezione **"Repository / PR"** che, dopo l'esecuzione, elenca
  i repo toccati con stato (`open/merged/closed_unmerged`) e link alla PR. Prima
  dell'esecuzione è vuota (l'agente non ha ancora deciso).
- **Board / lista**: badge con il numero di repo toccati / PR aperte del ticket.
- i18n it/en per le nuove label.

## Piano (sotto-fasi subagent-driven, ognuna verde prima della successiva)

- **3-1 — Modello + numerazione.** Migrazione 0035 (`projects.next_ticket_number` +
  migrazione dati; `ticket_repositories`; declassamento `tickets.repositoryId` a origine).
  Shared schemas. Test integrità.
- **3-2 — Worker.** `withProjectWorktrees`; `runFix` sul progetto con agente unico;
  apertura PR multipla + `ticket_repositories`; serializzazione/claim per-progetto;
  esclusione allargata fix↔generazione. Test (materializzazione multi-worktree,
  PR multiple, serializzazione per-progetto, single-repo invariato).
- **3-3 — Server.** Create con numero di progetto; webhook con chiusura aggregata;
  mapper ticket con stato per-repo. Test (merge parziale non chiude; tutti merged → done).
- **3-4 — Web.** Sezione Repository/PR nel dettaglio ticket; badge; i18n. Test (+E2E).
- **3-5 — Verifica full-repo + review olistico + merge** (deploy demandato all'utente,
  migrazione strutturale → backup DB prima).

## Rischi

- **Costo token per ticket** più alto (agente su tutti i repo): accettato; budget come
  guardrail. Mitigabile in futuro con RAG-assist (fuori scope, D4).
- **Meno parallelismo** su progetti multi-repo (serializzazione per-progetto): voluto,
  evita conflitti meccanici.
- **Conflitti logici** tra PR parallele di ticket diversi: gestiti in review (Livello 1).
- **Spazio disco** dei worktree multipli in /tmp per progetti con molti repo grandi:
  worktree effimeri, rimossi a fine job.
- **Esclusione allargata**: un fix di progetto blocca temporaneamente anche le generazioni
  docs dei suoi repo (e viceversa) — coerente con l'invariante del mirror.
