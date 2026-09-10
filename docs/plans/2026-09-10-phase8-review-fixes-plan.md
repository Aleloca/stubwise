---
title: Fase 8 — fix di review prima del merge
date: 2026-09-10
design: 2026-09-10-phase8-release-queue-design.md
plan: 2026-09-10-phase8-release-queue-plan.md
stubwise:
  project: stubwise
  backlog: 590ced8c-61b3-4251-b579-eed449a29b73
---

# Fase 8 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Worktree esistente `.worktrees/phase8-release-queue` (branch
> `feature/phase8-release-queue`, PR #19, HEAD `9971042`). Questo piano è su
> `main`: `git fetch && git show origin/main:docs/plans/2026-09-10-phase8-review-fixes-plan.md`,
> oppure `git merge origin/main`. **Non** mergiare e **non** deployare. Alla
> fine: push, CI verde (incluso E2E), report con HEAD e link al run. Le
> posizioni `file:riga` sono di `9971042`.

**Goal:** chiudere i findings di tre revisori indipendenti. **Nessun
bloccante.** Due vanno chiusi prima del merge, il resto è rifinitura.

Tre cose vanno dette prima, perché sono il merito di questo giro:

- **La migrazione 0074 è la parte meglio fatta della fase.** La colonna nasce
  nullable, il backfill riempie, il `SET NOT NULL` arriva **dopo**: un buco nel
  backfill fa fallire la migrazione dentro la transazione e il server non parte,
  invece di lasciare 20 `.env` di produzione silenziosamente invisibili al fix.
  E il nuovo unique è strettamente più debole del vecchio, quindi non può
  violare nulla sui dati esistenti.
- **L'invariante «solo `test` entra in un worktree» è difeso su tre livelli**
  indipendenti (tipo, `throw` a runtime prima di qualunque query, filtro nella
  query stessa), uno più di quanto chiedesse il piano.
- **Il taglio di «Rilascia» dalla card d'inbox era la scelta giusta.** La
  motivazione regge — `fix.ts:2060-2072` pubblica UNA sola `job.pr_opened` per
  job col solo `primaryPrUrl`, quindi una card costruita su quella notifica non
  può sapere quale delle N PR rilasciare. Unica imprecisione: il docblock di
  `PrReadyCard.tsx` citato a supporto documenta l'assenza di un'azione `merge`
  nel contratto, **non** l'ambiguità multi-repository. Il ragionamento è tuo ed
  è corretto; la citazione no.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: la coda mostra davvero tutte le PR aperte

**PRIMA DEL MERGE. Verificato di persona.** `listReleaseQueue`
(`apps/server/src/services/release.ts:135-143`) parte da `ticketRepositories`
con `prState = "open"`, e quelle righe le scrive **solo la pipeline di fix**: in
tutto `apps/worker/src/review/run-review.ts` la stringa `ticketRepositories`
compare **zero volte**.

Conseguenza: una PR aperta a mano non comparirà **mai** in coda — pur ricevendo
oggi in produzione verdetto, riassunto, commento sticky e un ticket di tipo
`review`, perché `pr_review_enabled` è acceso. Il docblock della funzione
(`release.ts:213-216`) afferma «TUTTE le PR aperte sui repository collegati, di
qualunque origine … nasconderne metà renderebbe la pagina bugiarda», e il
design §4 lo chiede esplicitamente. **È il punto che il maintainer aveva
corretto di persona in fase di design**: senza questo la fase non fa la cosa per
cui è stata ridisegnata.

**Files:**
- Modify: `apps/server/src/services/release.ts` — la coda unisce **due
  sorgenti**: le righe di `ticket_repositories` con PR aperta (le PR nate da
  Stubwise, che hanno test interno e rischio) e le PR note solo da
  `pr_reviews` (le esterne, che hanno verdetto e riassunto ma **non** test
  interno né rischio). Dedup per `(repository_id, pr_number)`: una PR che
  esiste in entrambe è **una riga sola**, con i campi di entrambe
- Le colonne che una PR esterna non ha (`test interno`, `rischio`) devono
  essere **distinguibili da «negativo»**: «non eseguito da Stubwise» non è
  «rosso» e non è «verde». Se lo schema oggi non lo permette, allargalo con un
  campo `.optional()` e un test che parsa senza
- Modify: `apps/web` — la coda rende la distinzione visibile senza spiegazioni
  (chi guarda deve capire perché quella riga ha meno informazioni)
- Test: `release.test.ts` — una PR solo da fix; una PR solo esterna; **una PR
  presente in entrambe le sorgenti → una riga sola**; una PR esterna chiusa non
  compare

⚠️ Attenzione allo stato: `pr_reviews` non ha un `pr_state` come
`ticket_repositories`. Decidi come sai che una PR esterna è ancora aperta
(rilettura dal provider? l'ultima review per `head_sha`?) e **scrivi il perché**
— è la parte del task in cui è più facile prendere una scorciatoia che poi
mente all'utente.

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(release): la coda mostra anche le PR aperte fuori da Stubwise`.

### Task 2: un errore di lettura chiude il cancello, non lo apre

**PRIMA DEL MERGE. Verificato di persona.** `getPullRequestChecks`
(`packages/git/src/github.ts:153-155` e il gemello Bitbucket) ha un `catch` che
restituisce `{ status: "no_checks" }` per **qualunque** errore: rete, 401 da
token scaduto, 403, risposta malformata. E `no_checks` **non blocca** il
rilascio: blocca solo `failure` (`services/release.ts:105`).

Quindi una PR con i check **rossi** diventa rilasciabile se la lettura fallisce
nell'istante del tap, e il maintainer legge «nessun check» invece di «non sono
riuscito a leggerli». La regola del design — «una PR coi check rossi non si
rilascia» — regge solo finché la rete collabora.

La scelta di far passare `pending` e `no_checks` è **giusta** e dichiarata
(`release.ts:103-105`): il punto non è quella, è che **l'errore viene confuso
con l'assenza**.

**Files:**
- Modify: `packages/git/src/{provider,github,bitbucket}.ts` — quarto stato
  `unknown`, distinto da `no_checks`. Il `catch` restituisce `unknown`, mai
  `no_checks`
- Modify: `apps/server/src/services/release.ts` — `unknown` **blocca** il
  rilascio con un errore che dice cosa è successo, non «check falliti»
- Modify: `apps/web` — in coda `unknown` si legge come «non leggibili», non
  come «nessuno»
- Test: entrambi i provider (errore di rete → `unknown`; 401 → `unknown`; corpo
  malformato → `unknown`; nessun check configurato → `no_checks`, che è un caso
  diverso); servizio (`unknown` → rilascio rifiutato)

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(release): non leggere i check è diverso da non averne`.

### Task 3: un solo ambiente `test` per progetto

**Trovato indipendentemente da due revisori su tre** — di solito è il segno che
è reale. L'unique è `(project_id, name)` e `kind` ha solo un CHECK: nulla vieta
`{name: "test-2", kind: "test"}` (`project-environments.ts:135-146`). Ma
`loadProjectEnvFiles` seleziona per `kind = 'test'`, **non** per un ambiente
specifico: con due ambienti `test` i file di entrambi entrano nello stesso
worktree, e siccome l'unique consente lo stesso `path` in ambienti diversi —
il docblock lo chiama «il caso normale» — due `.env` omonimi verrebbero fusi con
un vincitore **non deterministico**.

Non è una falla dell'invariante (staging e produzione restano fuori). È il
loader che assume un'unicità che la migrazione garantisce e l'API non preserva.

La difesa opposta esiste già ed è giusta: cancellare l'ambiente `test` è
rifiutato con 409 (`:232-240`).

**Files:**
- Modify: la migrazione 0074 — indice unico **parziale** su `(project_id)` dove
  `kind = 'test'` (è il vincolo vero; farlo nello schema lo rende impossibile,
  non solo scoraggiato). La 0074 non è ancora applicata da nessuna parte, quindi
  si corregge lì invece di aggiungere una 0075
- Modify: `apps/server/src/routes/project-environments.ts` — il POST rifiuta un
  secondo `kind: "test"` con un errore leggibile, invece di lasciar emergere una
  violazione di indice
- Test: due `test` sullo stesso progetto → rifiutati; due `test` su progetti
  diversi → ammessi

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(environments): un solo ambiente di test per progetto`.

### Task 4: tre rifiniture su ciò che il prodotto promette

- **`already_merged` è un ramo morto.** `MergeFailureReason` lo dichiara
  (`packages/git/src/provider.ts:359`) e il servizio lo mappa
  (`release.ts:119`), ma **nessuno dei due provider lo lancia mai**. Una PR
  mergiata da qualcun altro fuori da Stubwise torna 405 su GitHub →
  `not_mergeable` → «conflitti o regole del branch non soddisfatte», che per una
  PR semplicemente già chiusa è fuorviante. O lo si lancia davvero, o lo si
  toglie: un ramo dichiarato e irraggiungibile è peggio di uno assente.
- **Il segno verde promette più di quanto verifichi.** Su GitHub il controllo è
  il preesistente `permissions.push` con l'etichetta estesa a «(PR e merge)»
  (`github.ts:418-431`). Il commento a `:412-417` è onesto — GitHub non espone
  un bit «merge» — ma la stringa che l'utente legge dice «accesso al repo,
  permessi di scrittura e merge ok», mentre branch protection, review
  obbligatorie e required checks bloccano il merge pur con `push: true`.
  **Cambia il testo per dire cosa è stato davvero verificato**: il maintainer
  leggerà quel verde come una garanzia.
- **`deployedOn` è cieco senza una riga di review.** `deployedOnFor` riceve
  `review?.headSha` (`release.ts:245`): senza review — non ancora girata,
  spenta, o fallita — la colonna «già su staging» è **sempre vuota**, anche per
  una PR nata da Stubwise. L'head sha va preso dalla PR, non dall'artefatto di
  un'altra automazione.

**Commit** `chore(release): il prodotto promette solo ciò che verifica`.

### Task 5: due nit

- **`DROP INDEX` senza `IF EXISTS`** nella 0074. Il nome legacy è verificato
  coerente, quindi il rischio è basso; ma se in produzione l'indice fosse
  divergente l'intero batch fallirebbe e il server non partirebbe. Costa una
  parola.
- **Docblock rimasto indietro**: `packages/db/src/schema.ts:1305` dice ancora
  «File d'ambiente configurato per un *progetto* … cancellato in cascata col
  *progetto*», mentre la riga è del **repository** e ora cascade anche
  dall'ambiente. Il paragrafo aggiunto dalla fase 8 dice la cosa giusta: è la
  prima frase, preesistente, a non esserlo più.

**Commit** `chore(db): IF EXISTS sul drop e docblock allineato`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .` se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report: HEAD finale, link al run, i cinque task, eventuali flaky con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- I due flaky preesistenti confermati non regressivi
  (`monitor-agent.integration.test.ts`, testcontainer lento sotto pressione;
  `plugins.test.ts` update ref, asserzione a risoluzione di millisecondo) e il
  flaky di `me-google.test.ts` già diagnosticato il 9 set.
- La potatura di mirror e grafi, che crescono senza limite.
- Un'azione «Rilascia» dall'inbox, che avrebbe senso solo con una card **per
  repository** invece che per ticket — vedi il taglio motivato sopra.
