# Adozione delle PR aperte da altri — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** un maintainer preme «Fai correggere a Stubwise» su una PR esterna
(ticket `review`) e da lì le correzioni di Stubwise finiscono sul branch di
quella PR col ciclo solito; «Smetti di correggere» la restituisce.

**Architecture:** l'adozione è una riga `ticket_repositories` del ticket
review con quattro colonne nuove (0085). La correggibilità diventa UNA regola
pura in `@stubwise/shared` (`isCorrectablePr`): branch di Stubwise del ticket
OPPURE riga adottata e non rilasciata. Tutti i punti che oggi usano la regex
per decidere passano da lì; il resto del ciclo (`enqueueCorrection`,
`runCorrection`, review, webhook) è invariato perché lavora già per
`(repository, numero PR)` sulla riga `ticket_repositories`.

**Tech Stack:** Fastify + Zod, Drizzle/Postgres, Vitest + testcontainers,
React (web), React Native (app), i18n en/it.

Design: `docs/plans/2026-10-06-adopt-external-pr-design.md`.

---

## Premesse verificate (6 ott 2026, leggendo il codice)

Il §1/§3 del design erano affermazioni; ecco cosa dice davvero il codice.

1. **Il ticket review e la PR.** `run-review.ts` (`resolveTicket`, passo 11)
   crea il ticket `review` solo a parse riuscito, e il legame è
   `pr_reviews.ticket_id` (scritto nella transazione del passo 12). Le review
   successive della stessa `(repository, PR)` ritrovano QUEL ticket (ramo 2 di
   `resolveTicket`). **Nessuna riga `ticket_repositories` esiste per un
   ticket review**: la scrive solo la pipeline di fix (`fix.ts`) e il ramo
   merge del webhook (solo per branch di Stubwise). → L'adozione la CREA.
2. **`pr_reviews` conosce `source_branch`/`target_branch`** (0081) ma sono
   NULL sulle righe precedenti: il branch vero si rilegge dal provider
   all'adozione.
3. **Consumatori di `STUBWISE_BRANCH_RE`/`stubwiseTicketNumber` che DECIDONO
   «correggibile»** (da cambiare): `derivePrCycle`
   (`packages/notifications/src/pr-correction-cycle.ts`), `requestCorrection`
   (`apps/server/src/services/pr-corrections.ts`), `handleChangesRequested`
   (`apps/server/src/services/pr-correction-webhook.ts`), `runCorrection`
   (`apps/worker/src/pipeline/correction.ts`), `isStubwisePr`/
   `promotePendingAfterFailedReview`/`notifyCycleStoppedByFailedReview`
   (`apps/worker/src/review/cycle.ts`). Consumatori che **non** decidono la
   correggibilità e restano: `resolveTicket` (ticket del fix), il ramo di
   chiusura del webhook per i ticket del fix (`webhooks.ts:596`), `fix.ts`
   (nome del branch del fix), script golden/smoke.
4. **Chiusura della PR adottata: già coperta.** `markPrRowsClosed` e
   `cancelOpenCorrections` lavorano per `(repository, numero)` su
   `ticket_repositories`, quindi trovano la riga dell'adozione; il ticket
   review lo chiude già il suo ramo (`done`/`closed`). Manca solo
   l'allineamento dei job `pr_opened` delle correzioni (il ramo del fix lo fa,
   quello review no) → Task 9.
5. **`listReleaseQueue`**: con la riga dell'adozione la PR passerebbe da
   «esterna» a «interna» con `origin: "stubwise"`, falso → per un ticket
   `review` l'origine resta `external` (Task 9).
6. **Polso/segnali**: la riga dell'adozione fa comparire la PR in
   `waitingForMerge` e zittisce il pulse (`openPr`). È vero (una PR aperta
   aspetta il merge) e lo si accetta; dopo il rilascio la riga resta, quindi
   resta lì finché la PR è aperta. Documentato, non cambiato.
7. **Provider e fork.** Nessun metodo di `GitProvider` dice se una PR viene
   da un fork. `PrActivityEvent` neppure. GitHub: `head.repo.full_name` vs
   `base.repo.full_name` (con `head.repo` null se il fork è stato cancellato);
   Bitbucket: `source.repository.full_name` vs
   `destination.repository.full_name`. → nuovo metodo
   `getPullRequestInfo` (live, autorevole) + campo `fromFork` sull'evento del
   webhook, salvato su `pr_review_jobs`/`pr_reviews` per spegnere il bottone
   PRIMA del click.
8. **⚠️ Premessa del design INCOMPLETA, pericolosa così com'è: il fork non è
   l'unico caso in cui il nome del branch inganna.** Una PR da fork ha
   `head.ref` = un nome di branch NEL FORK, spesso `main`: trattarlo come un
   branch del repository base porterebbe il push di una correzione sul `main`
   del repository. E anche una PR NON da fork il cui branch sorgente è il
   branch di default o il target è inadottabile per la stessa ragione.
   Decisione (non c'è ambiguità di prodotto): non adottabile anche quando il
   branch sorgente è il default o il target della PR (`base_branch`), e
   l'esito «fork non verificabile» (provider che non dice il repository
   sorgente) **rifiuta** (fail-closed). Il worker, prima del push su una PR
   adottata, rilegge la PR dal provider e non pusha se risulta da fork o con
   un branch diverso da quello adottato.
9. **Commenti sulla PR**: `GitProvider.createPrComment` con le credenziali
   dell'account PRINCIPALE (`decryptGitCredentials`), come il ripiego di
   `publishReview`. Non può innescare correzioni: (a) i webhook sottoscritti
   non includono eventi di commento (GitHub `pull_request`,
   `pull_request_review`, `push`; Bitbucket created/updated/fulfilled/
   rejected/changes_request_created), (b) un «Request changes» del
   principale è `own_account`, (c) la fotografia dei commenti esclude il
   principale. Test in Task 7.
10. **⚠️ Rischio NUOVO introdotto dall'adozione: «Rilancia» su un ticket
    review.** Oggi un ticket review non ha job; dopo l'adozione ha i job
    delle correzioni, e una correzione fallita pubblica `job.failed`, la cui
    card in inbox (e Slack) offre «Rilancia» → `startRun` senza
    `resumeCorrectionJobId` → un FIX COMPLETO dal branch di default su un
    ticket review. Sul web `canRelaunch` non esclude i ticket review. →
    `startRun` rifiuta un ticket `review` salvo la forzatura di una
    correzione ferma (`review_ticket_not_runnable`, 409), e il web nasconde il
    rilancio (Task 6, Task 11).
11. **Prompt della correzione**: dice «Stubwise already opened a pull request
    for the ticket below» — falso per una PR adottata. Variante `adopted` per
    la sola prima frase; il testo per le PR di Stubwise resta IDENTICO (golden
    invariati). Il golden su un branch adottato va lanciato a mano (Task 8).
12. **Target della review dopo una correzione**: `enqueueReview` usa il branch
    di default come target; per una PR esterna verso un altro branch il diff
    sarebbe sbagliato → si usa `pr_reviews.target_branch` dell'ultima review
    se c'è (Task 8).

13. **Premessa scoperta IN IMPLEMENTAZIONE (Task 8), non vista in fase 1**:
    `MirrorManager` (`apps/worker/src/git/mirrors.ts`, `assertBranchName`)
    accetta SOLO branch `stubwise/…` per worktree, push e head — ed è la
    protezione che rende innocuo `pushBranch(..., { force: true })`. Una
    correzione su un branch adottato falliva lì. Correzione: un'opzione
    ESPLICITA `adopted` (stessi vincoli per segmento del target di una PR), che
    con sé rifiuta `force`, il default branch e un worktree non aperto dalla
    head del branch. Mai un allargamento implicito del controllo.

## Decisioni di forma

- **Colonne nuove su `ticket_repositories`** (0085, nullable, nessun enum):
  `adopted_at`, `adopted_by_user_id` (FK users SET NULL),
  `adoption_released_at`, `adoption_released_by_user_id` (FK users SET NULL),
  CHECK `adoption_released_at IS NULL OR adopted_at IS NOT NULL`.
  `pr_review_jobs.from_fork` e `pr_reviews.from_fork` boolean nullable (NULL =
  non lo sappiamo: righe vecchie o review accodate dal worker).
- **Regola unica**: `isCorrectablePr({ branch, ticketNumber, adoptedAt,
  adoptionReleasedAt })` in `packages/shared/src/stubwise-branch.ts`.
- **Rotte** (sotto `/api`, nel file `routes/corrections.ts`, stessa forma di
  path): `POST /tickets/:id/repositories/:repositoryId/adoption` (body
  `{ note? }`, 202 `{ correctionId: uuid | null }`) e `DELETE` stessa path
  (204). `preHandler: requireAdmin` + `actor.role !== "admin"` nel servizio.
- **Campo di lettura** `ticketDetailSchema.prAdoption`
  (`.nullable().default(null)`): solo per ticket `review` con una review
  completata. `{ repositoryId, prNumber, prUrl, branch|null, state:
  "available"|"adopted"|"unavailable", unavailableReason: "fork"|
  "stubwise_pr"|"base_branch"|"pr_closed"|null, adoptedAt|null,
  adoptedBy|null, canManage }`. `canManage` = ruolo admin di chi guarda,
  calcolato dal server (stesso criterio di `canMerge`).
- **Il rilascio non cancella la riga**: la marca, annulla le correzioni
  aperte (riga di log dedicata), lascia un commento sul ticket e sulla PR.
  Si può ri-adottare (la riga torna adottata).
- **`enqueueCorrection`** rifiuta sotto il lock una PR non più correggibile
  (`pr_not_correctable`, tradotto in `not_stubwise_pr` dalla rotta): chiude
  la corsa fra «Smetti di correggere» e un «Request changes» in volo.
- **Codici d'errore nuovi** (409/422): `not_review_ticket`, `already_adopted`,
  `not_adopted`, `pr_from_fork`, `pr_fork_unverifiable`, `stubwise_pr`,
  `base_branch`, `pr_not_open` (riuso), `review_ticket_not_runnable`.

## Task

### Task 1: regola unica `isCorrectablePr` (shared)

**Files:** Modify `packages/shared/src/stubwise-branch.ts`; Test
`packages/shared/src/stubwise-branch.test.ts`.

1. Test: branch di Stubwise del ticket → true; di un altro numero → false;
   branch qualunque adottato e non rilasciato → true; adottato e rilasciato →
   false; mai adottato → false; adottato con branch di Stubwise di un altro
   ticket → true (l'adozione vince, ma non è producibile: la rotta lo
   rifiuta).
2. Implementazione pura.
3. `pnpm --filter @stubwise/shared test`, commit.

### Task 2: migrazione 0085 + schema drizzle

**Files:** Create `packages/db/drizzle/0085_pr_adoption.sql`; Modify
`packages/db/drizzle/meta/_journal.json` (idx 85, `when` 1791331200000),
`packages/db/src/schema.ts` (`ticketRepositories`, `prReviewJobs`,
`prReviews`), `packages/db/src/testing.ts` (opzioni di adozione nel seed).
Test: `packages/db/src/migrations.test.ts` se esiste, altrimenti i test che
seminano `ticket_repositories`.

SQL additivo, un batch, nessun `ALTER TYPE`, nessun backfill.

### Task 3: provider — `getPullRequestInfo` e `fromFork` sull'evento

**Files:** `packages/git/src/provider.ts`, `github.ts`, `bitbucket.ts` e test.

- `getPullRequestInfo(p, prNumber) → { state: "open"|"closed", sourceBranch,
  targetBranch, headSha, fromFork: boolean | null }` (`null` = il provider
  non dice il repository sorgente). GitHub: `head.repo` null → `null`;
  confronto di `full_name` senza maiuscole. Bitbucket: `source.repository`/
  `destination.repository` `full_name` (o `uuid`).
- `PrActivityEvent.fromFork?: boolean` (assente = non si sa) nei due
  `parsePrEvent`.
- Test con fixture: stesso repo → false, fork → true, head.repo null → null.

### Task 4: `from_fork` nella coda delle review

**Files:** `apps/server/src/routes/webhooks.ts` (insert/upsert
`pr_review_jobs.fromFork`), `apps/worker/src/review/run-review.ts`
(`PrReviewJobRow.fromFork`, `insertWaitingReview`), il poller che rimette in
coda le review in attesa (`requeueWaitingReviews`), `enqueuePrReviewNow`
(`fromFork` non passato = NULL). Test: webhook che salva `fromFork`; review
che lo copia su `pr_reviews`.

### Task 5: correggibilità nei punti che decidono

**Files:** `packages/notifications/src/pr-correction-cycle.ts`
(`derivePrCycle`, `prStillOpen` → anche correggibilità, errore
`pr_not_correctable`; `cancelOpenCorrections` con `opts.logLine`),
`apps/server/src/services/pr-corrections.ts`,
`apps/server/src/services/pr-correction-webhook.ts` (riga trovata per
`repository + branch + aperta`, poi regola e numero),
`apps/worker/src/review/cycle.ts` (`isStubwisePr` → regola;
`promotePendingAfterFailedReview` senza regex; `notifyCycleStoppedByFailedReview`
per riga). Test (testcontainers): ciclo derivato su riga adottata e su riga
rilasciata (null); `requestCorrection` su adottata ok / rilasciata
`not_stubwise_pr`; webhook «Request changes» su PR adottata → correzione
`provider`; su PR rilasciata → nessuna riga; `enqueueCorrection` dopo il
rilascio → `pr_not_correctable` senza scritture; `advanceCycle` su adottata
accoda il giro automatico, su rilasciata no.

### Task 6: servizio di adozione e rilascio + `startRun`

**Files:** Create `apps/server/src/services/pr-adoption.ts` (+ test);
Modify `apps/server/src/services/jobs.ts` (guardia ticket review),
`apps/server/src/routes/tickets.ts` (409 nuovo), `apps/server/src/services/inbox.ts`
(mappatura), i18n `packages/i18n` (`comment.prAdopted`, `comment.prAdoptionReleased`,
`prComment.adopted`, `prComment.adoptionReleased`, en+it).

`adoptPullRequest(db, encryptionKey, { ticketId, repositoryId, actor, note,
getProviderFn? })`:
1. `actor.role !== "admin"` → `forbidden` (prima di qualunque lettura che
   scriva).
2. ticket `review` (altrimenti `not_review_ticket`); ultima review completata
   CON quel ticket su quel repository (altrimenti `pr_not_found`).
3. riga esistente adottata e non rilasciata → `already_adopted`.
4. `getPullRequestInfo` LIVE: errore → `pr_fork_unverifiable`; `closed` →
   `pr_not_open`; `fromFork` true → `pr_from_fork`, null →
   `pr_fork_unverifiable`; branch di Stubwise → `stubwise_pr`; branch =
   default del repository o = target → `base_branch`.
5. transazione con lock del ticket: upsert della riga (branch dal provider,
   `prUrl`, `prNumber`, `prState: open`, adozione), commento di sistema.
6. dopo il commit: `enqueueCorrection` (`trigger: "stubwise"`, `actorRole`,
   nota) — un rifiuto non disfa l'adozione (`correctionId: null`).
7. commento sulla PR col principale, best-effort, mai rilanciato.

`releaseAdoption(...)`: admin; riga adottata e non rilasciata (altrimenti
`not_adopted`); transazione col lock: marca rilasciata + commento di sistema;
poi `cancelOpenCorrections(..., { logLine })` e `promotePendingForTicket`;
commento sulla PR best-effort.

`startRun`: ticket `review` e nessuna correzione ferma da forzare →
`review_ticket_not_runnable`.

Test a due ruoli che asseriscono sulle righe: member → 403 e nessuna riga
`ticket_repositories`/`pr_corrections` scritta, nessuna chiamata al provider;
admin → riga adottata + una correzione `queued` con `review_id` e nota + un
commento sulla PR col token principale; fork / fork null / branch di default
/ branch di Stubwise / PR chiusa → nessuna scrittura; rilascio: correzioni
`cancelled`, job `skipped`, riga rilasciata, commento; member che rilascia →
403 e nulla cambia; `startRun` su ticket review → 409, su review con
correzione ferma → forza.

### Task 7: rotte + campo `prAdoption` + auto-innesco

**Files:** `packages/shared/src/schemas/pr-correction.ts` (schemi corpo/
risposta, `prAdoptionSchema`), `packages/shared/src/schemas/ticket.ts`
(`prAdoption` `.nullable().default(null)`), test di parse SENZA il campo;
`apps/server/src/routes/corrections.ts`; `apps/server/src/routes/tickets.ts`
(`loadPrAdoption` col ruolo del viewer). Test di rotta (`corrections.test.ts`
o nuovo `adoption.test.ts`): 403 member, 202 admin, 409/422 codici; dettaglio
ticket: `prAdoption` per admin (`canManage: true`) e member (`false`),
`unavailable` con `fork` da `pr_reviews.from_fork`.
**Auto-innesco**: dopo l'adozione, un evento «Request changes» il cui autore
è il principale (quello che ha scritto il commento) non crea una seconda
correzione (asserzione sul conteggio delle righe `pr_corrections`).

### Task 8: worker — `runCorrection` su un branch adottato

**Files:** `apps/worker/src/pipeline/correction.ts`, `prompts.ts`, test.
- regola unica al posto della regex;
- prima del push, per una riga adottata, `getPullRequestInfo`: `fromFork`
  true o branch diverso → niente push, correzione fallita col motivo
  (errore API → come oggi, si pusha: la verifica autorevole è all'adozione);
- target della review = `target_branch` dell'ultima review se c'è;
- prompt: variante `adopted` della prima frase.
Test: correzione su branch adottato pusha IN AVANTI (nessun `force`);
push concorrente → `PushRejectedError` → job failed col messaggio, nessun
force; correzione su riga rilasciata → fallita senza push; PR risultata da
fork al ricontrollo → nessun push.

### Task 9: chiusura e coda di rilascio

**Files:** `apps/server/src/routes/webhooks.ts` (ramo del ticket review:
`pr_opened` → `pr_merged`/`pr_closed`), `apps/server/src/services/release.ts`
(origin `external` per un ticket `review`). Test: merge di una PR adottata →
ticket review `done`, correzioni annullate, job allineato; coda di rilascio
con riga adottata → una sola voce, `origin: "external"`.

### Task 10: api-client

`packages/api-client/src/endpoints/tickets.ts`: `adoptPr`, `releasePrAdoption`
+ test.

### Task 11: web

- `apps/web/src/lib/api.ts` (funzioni + tipo), componente
  `apps/web/src/components/pr-adoption-panel.tsx` (+ test), inserito nel
  dettaglio ticket per i ticket review; `prAdoption ?? null` nel punto di
  lettura, fixture SENZA il campo; `canRelaunch` escluso per i ticket review.
- i18n `apps/web/src/i18n/locales/{en,it}.json`: testi del pannello e codici
  d'errore nuovi.

### Task 12: app

- `apps/mobile/src/components/work/PrAdoptionSection.tsx` (+ test, `await
  render`, doppio del client completo), mutation in
  `apps/mobile/src/lib/adoption-mutations.ts`; in `WorkScreen.tsx` per i
  ticket review: sezione in Stato, nota del ticket review dipendente dallo
  stato, apertura su Stato se adottata; `prAdoption ?? null` (cache
  persistita); fixture complete.
- i18n `apps/mobile/src/i18n/{en,it}.json`.

### Task 13: CLAUDE.md, changeset, verifica

- CLAUDE.md: voce di deploy «Adozione delle PR aperte da altri» (0085, ordine
  server → worker → caddy con verifica, rollback); invarianti aggiornate
  («Una correzione non forza MAI il push … se non dopo un'adozione esplicita»,
  «Una sola regola di correggibilità»), nuova invariante sul fork e sul branch
  base, e sul `startRun` dei ticket review.
- `.changeset/shared-pr-adoption.md` (minor).
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, test dei package toccati.

## Deploy

**Ordine, alla lettera — prima il server:**
1. `docker compose up -d --build server`;
2. healthy, poi verifica la **0085**: `docker compose exec postgres sh -c
   'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d ticket_repositories"'`
   mostra `adopted_at` e `adoption_released_at` (oppure `max(created_at)` di
   `drizzle.__drizzle_migrations` = `1791331200000`);
3. solo allora `docker compose up -d --build worker caddy`.

Perché: lo schema drizzle del worker nuovo nomina le colonne nuove di
`ticket_repositories` e `pr_reviews`/`pr_review_jobs` in ogni select della
riga intera (correzione, fix, review); contro un DB senza la 0085 quei job
falliscono. Il worker vecchio davanti allo schema nuovo è innocuo.

L'app si aggiorna dagli store; legge `prAdoption` dal `.default(null)`.

## Rollback

- **Spegnere la funzione senza toccare immagini**: «Smetti di correggere»
  sulle PR adottate (o `update ticket_repositories set adoption_released_at =
  now() where adopted_at is not null and adoption_released_at is null;` più
  l'annullamento delle correzioni aperte di quelle PR).
- **Server vecchio**: le rotte nuove sono 404 e `prAdoption` sparisce (app dal
  default, web con `??`). ⚠️ Il server vecchio NON conosce la regola: su una
  riga adottata `derivePrCycle`/`requestCorrection` dicono «non di Stubwise»
  (innocuo), ma il suo `startRun` non ha la guardia dei ticket review —
  «Rilancia» da un `job.failed` di una correzione avvierebbe un fix sul ticket
  review. Prima di scendere: rilasciare le adozioni (sopra).
- **Worker vecchio**: rifiuta le correzioni su un branch adottato («non è una
  PR aperta da Stubwise») → job falliti, nessun push. Prima di scendere,
  rilasciare le adozioni come sopra. Le colonne sopravvivono, il migratore
  ignora la 0085.
