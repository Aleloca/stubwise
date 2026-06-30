# Fix multi-repository (Fase 3) — Design

**Data:** 2026-07-01
**Stato:** PROGETTATO in autonomia (notte), **in attesa di revisione dell'utente prima dell'implementazione.**
**Dipende da:** Fase 1 (modello a due livelli, su `main`) e — per i Docs — Fase 2 (branch `feat/multi-repo-docs`).

> Questa è la "frontiera" che il piano multi-repo ha sempre rimandato a un design
> dedicato, perché cambia il **ciclo di vita del ticket** e il **cuore del motore
> di fix**. Ho preso decisioni di default ragionate ed evidenziato le **scelte di
> prodotto da confermare**: vedi §"Decisioni da confermare". Non l'ho implementata
> stanotte di proposito — implementarla su semantiche inventate rischierebbe rework.

## Obiettivo

Permettere a **un singolo ticket** di avere **N repository bersaglio**: il fix viene
eseguito su ciascun repo (worktree e PR per-repo) e il ticket si chiude **solo quando
tutte le PR sono mergiate**. Caso d'uso: un ticket "aggiungi il campo X" che richiede
una modifica al backend (repo API) e una al frontend (repo web) dello stesso progetto.

## Dov'è oggi l'assunzione "1 ticket = 1 repo = 1 PR"

(riferimenti verificati sul motore attuale, post-Fase 1)
1. `tickets.repositoryId` colonna **singola** (nullable, già predisposta) e
   `ai_jobs.prUrl` **singolo** — la PR è registrata sul job, non c'è tabella PR.
2. `ai_jobs` **non** ha `repositoryId`: il repo bersaglio si deriva sempre dal ticket
   (`handler.ts` risolve un repo e serializza su un `repositoryId`).
3. `runFix` carica **un** repo, apre **un** worktree, **una** PR (branch
   `stubwise/ticket-N`).
4. Webhook di merge: porta il ticket a `done` al **primo** merge
   (`tickets` risolto per `(repositoryId, number)`).
5. Cardinalità "1 job vivo per ticket": `run-ai` riusa l'ultimo job; il webhook tocca
   "il job `pr_opened`".

## Modello dati proposto (migrazione 0035)

### Nuova tabella `ticket_repositories` (il fix per-repo)
Sostituisce funzionalmente `tickets.repositoryId` + `ai_jobs.prUrl` come **stato
per-repo del ticket**:
- `id`, `ticketId` (FK tickets cascade), `repositoryId` (FK repositories cascade),
- `branch` (`stubwise/ticket-<n>` o variante namespaced, vedi §Numerazione),
- `prUrl` nullable, `prState` enum (`none|open|merged|closed_unmerged`),
- `jobId` nullable (il job che esegue questo repo), `createdAt`.
- UNIQUE `(ticketId, repositoryId)`.

### `ai_jobs` guadagna `repositoryId`
- `ADD COLUMN repository_id uuid REFERENCES repositories(id)` (nullable per i job
  vecchi; per i nuovi sempre valorizzato). Il claim e il serializer leggono questo
  invece di derivarlo dal ticket → N job dello stesso ticket girano in **parallelo su
  repo diversi** (mirror/worktree sono già isolati per repo, e la serializzazione è
  già per-`repositoryId`). Backfill: `UPDATE ai_jobs SET repository_id = (SELECT
  tickets.repository_id ...)`.

### `tickets.repositoryId`
- **Mantenuto** in 3a come "repo primario/legacy" per retro-compatibilità e per i
  ticket a singolo repo (la stragrande maggioranza). In 3a un ticket single-repo crea
  comunque **una** riga `ticket_repositories`. Deprecabile in seguito.

### Numerazione ticket (RISOLUZIONE della tensione Fase 1) — **decisione da confermare**
Oggi il numero è generato da `repositories.next_ticket_number` (per-repo) ma l'unique
è `(projectId, number)` (per-progetto): con più repo per progetto due repo possono
collidere. Con un ticket multi-repo serve un numero **univoco a livello di progetto**.
**Raccomandazione (Opzione A):** spostare il contatore su `projects.next_ticket_number`
(numero per-progetto), migrando i contatori esistenti (max(number)+1 per progetto), e
il branch diventa `stubwise/ticket-<number>` con `number` di progetto. Il webhook
risolve il ticket per `(projectId-del-repo, number)` invece di `(repositoryId, number)`.
- *Opzione B* (meno invasiva ma più fragile): tenere il numero per-repo e namespacare
  il branch con lo slug del repo (`stubwise/<repoSlug>/ticket-N`); il webhook resta
  per-(repository, number). Sconsigliata: complica branch e UX.

## Esecuzione del fix (worker)

- **Espansione in job per-repo**: alla creazione/lancio del fix di un ticket con N
  repo, si creano N righe `ticket_repositories` + N `ai_jobs` (uno per repo,
  `repositoryId` valorizzato). Ognuno è claimato indipendentemente; la serializzazione
  per-`repositoryId` (già esistente) garantisce isolamento sul mirror.
- **`runFix` per-repo**: invariato nella sostanza (un repo, un worktree, una PR), ma
  prende il `repositoryId` dal job (non dal ticket) e aggiorna la riga
  `ticket_repositories` (branch/prUrl/prState) invece di `ai_jobs.prUrl`.
- **Stato del ticket aggregato**: `in_progress` se almeno un repo sta pianificando;
  `in_review` quando **tutte** le PR sono aperte; `done` quando **tutte** mergiate
  (gestito dal webhook, vedi sotto). Una vista/funzione `ticketAggregateState(ticketId)`
  calcola lo stato dal set di `ticket_repositories`.
- **Contesto cross-repo per l'agente** — **decisione da confermare**:
  - *3a (raccomandato, MVP):* ogni repo è fixato **indipendentemente**; l'agente vede
    solo il proprio worktree + la descrizione del ticket (come oggi). Nel prompt si
    aggiunge l'elenco dei repo coinvolti ("questo ticket tocca anche i repo X, Y; tu
    lavori su Z") come semplice contesto testuale, senza checkout degli altri.
  - *3b (avanzato, fase successiva):* l'agente riceve un **checkout read-only dei repo
    fratelli** come contesto (per far combaciare API e client), e/o una **fase di
    pianificazione condivisa** che produce un piano cross-repo prima dei fix per-repo.
    Più potente, molto più complesso (coordinamento, ordine, contratto API). Deferito.

## Webhook / ciclo di vita (chiusura aggregata)

- Merge PR del branch del ticket su un repo → aggiorna la **riga** `ticket_repositories`
  corrispondente a `prState=merged`; il job → `pr_merged`.
- Il ticket passa a `done` **solo se tutte** le righe `ticket_repositories` sono
  `merged` (gate aggregato); altrimenti resta `in_review`. (Oggi chiude al primo merge:
  va inserito il gate.)
- `closed_unmerged` su un repo → quella riga torna `closed_unmerged` e il ticket
  rientra in lavorazione per quel repo, senza toccare gli altri.
- Notifiche: `job.pr_opened`/`pr_merged` restano per-job (per-repo); aggiungere un
  evento aggregato `ticket.completed` quando l'ultimo repo mergia (opzionale).

## UI web

- **Nuovo ticket**: il selettore "repository bersaglio" diventa **multi-selezione** dei
  repo del progetto (oggi è singolo). Almeno uno obbligatorio.
- **Dettaglio ticket**: una sezione "Repository" con, per ciascun repo, stato del fix e
  link alla PR (prState). La board/lista mostra un badge "N repo" o gli slug.
- **Costi**: `ticketCostUsd` già aggrega per ticket via job → regge (i job per-repo
  restano legati al `ticketId`).

## Decisioni da confermare (prima di implementare)

1. **Numerazione**: Opzione A (numero per-progetto, contatore migrato su `projects`,
   webhook per-(project,number)) [raccomandata] vs B (namespacing branch per-repo).
2. **Contesto agente**: 3a fix indipendenti con contesto testuale [raccomandata per
   l'MVP] vs 3b checkout cross-repo / piano condiviso [fase successiva].
3. **Lancio**: i job per-repo partono **tutti insieme** [raccomandato] o in **ordine**
   (es. prima il backend poi il frontend)? L'ordine serve solo con 3b.
4. **`tickets.repositoryId`**: tenerlo come "primario/legacy" in 3a [raccomandato] o
   migrare subito tutto su `ticket_repositories` (più pulito, più rischio dati)?
5. **Ambito 3a**: confermare che l'MVP sono fix indipendenti per-repo con chiusura
   aggregata, rimandando il coordinamento cross-repo dell'agente.

## Piano (sotto-fasi, una volta confermate le decisioni)

- **3a-1 — Modello + numerazione.** Migrazione 0035 (`ticket_repositories`,
  `ai_jobs.repositoryId` + backfill; eventuale spostamento contatore su `projects` con
  migrazione dei numeri). Test integrità.
- **3a-2 — Server.** Create ticket con N repo (crea righe `ticket_repositories` + job
  per-repo); webhook con chiusura aggregata; `ticketAggregateState`; mapper ticket con
  lo stato per-repo. Test.
- **3a-3 — Worker.** `runFix` legge il `repositoryId` dal job e aggiorna
  `ticket_repositories`; serializzazione invariata; prompt con elenco repo coinvolti. Test.
- **3a-4 — Web.** Multi-selezione repo nel nuovo-ticket; sezione Repository nel dettaglio
  ticket con stato/PR per-repo; badge in board/lista; i18n. Test (+E2E).
- **3a-5 — Verifica + review olistico + merge** (deploy demandato all'utente).
- **3b (fase successiva, design a parte):** contesto cross-repo per l'agente (checkout
  read-only dei fratelli e/o pianificazione condivisa), ordinamento dei job.

## Rischi

- **Numerazione** (il più critico): finché non risolto (Opzione A/B), abilitare più repo
  per progetto rompe l'unique `(projectId, number)`. La 3a-1 DEVE risolverlo prima di
  permettere ticket multi-repo reali.
- **Webhook che chiude troppo presto**: senza il gate aggregato, il ticket andrebbe a
  `done` al primo merge. Il gate è obbligatorio nella 3a-2.
- **Cardinalità job**: `run-ai` ("ultimo job") e il webhook ("il job pr_opened") vanno
  resi per-repo, altrimenti il re-run e la chiusura toccano il job sbagliato.
- **Serializzazione**: già per-repo (OK); due job dello stesso ticket sullo stesso repo
  restano serializzati (corretto).
- **Contesto agente (3a)**: fix indipendenti possono produrre PR non perfettamente
  coordinate (es. naming di un campo API) — accettabile per l'MVP, risolto da 3b.
