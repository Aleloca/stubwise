---
title: Fase 9 — fix di review prima del merge
date: 2026-09-11
design: 2026-09-10-phase9-mail-calendar-ux-design.md
plan: 2026-09-10-phase9-mail-calendar-ux-plan.md
stubwise:
  project: stubwise
  backlog: 3a04f5c6-0139-4975-a5d5-befbe9869ae6
---

# Fase 9 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Worktree esistente `.worktrees/phase9-mail-calendar-ux` (branch
> `feature/phase9-mail-calendar-ux`, PR #20, HEAD `00490ee`). Il piano è su
> `main`: `git fetch && git show origin/main:docs/plans/2026-09-11-phase9-review-fixes-plan.md`,
> oppure `git merge origin/main`. **Non** mergiare e **non** deployare. Alla
> fine: push, CI verde (incluso E2E), report con HEAD e link al run.

**Goal:** chiudere i findings di tre revisori indipendenti. **Uno solo è da
chiudere prima del merge, e non va sottovalutato.**

Prima, tre cose che sono un merito e non vanno perse nella lista:

- **La sanificazione è più solida di quanto chiedesse il design.** Un revisore
  ha ESEGUITO 25 payload ostili contro la configurazione — maiuscole miste,
  tabulazioni, entità HTML, `<svg><script>`, `srcdoc`, `formaction`,
  `xlink:href`, `background-image: url()` — e sono tutti neutralizzati. È una
  allowlist vera su un parser HTML, non regex.
- **Le immagini remote sono neutralizzate lato SERVER** (`data-src`, mai `src`)
  invece che lato client: nessuna richiesta può partire nemmeno per un errore di
  rendering. Meglio di quanto il piano chiedesse.
- **I due flag dell'iframe erano l'interpretazione giusta**: senza
  `allow-scripts` nessun JS gira, quindi un popup può nascere solo da un click
  umano, e il sanificatore forza `rel="noopener noreferrer"` su ogni
  `target="_blank"`. Senza `allow-popups-to-escape-sandbox` il sito di
  destinazione erediterebbe il sandbox e sarebbe rotto.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: un evento passato non propone niente

**PRIMA DEL MERGE. Verificato di persona.**

`isReadyForProposal` (`apps/worker/src/google/calendar.ts:384-385`) per un evento
**non ricorrente** fa `if (recurringEventId === null) return true;` — **nessun
controllo temporale**. Il gate `delta >= 0 && delta <= leadMs` (`:396-398`)
esiste solo per le occorrenze di serie, e la query del propose phase replica la
stessa asimmetria: il ramo `recurring_event_id is null` non ha nessuna
condizione su `startsAt`, mentre quello delle serie ha `startsAt >= now`.
`buildMilestoneProposal` (`:230-239`) non scarta una data passata: compone
«titolo entro \<ieri\>».

Fino a questa fase il difetto era **invisibile**, perché `timeMin` era `now` e
un evento passato non entrava mai. Il Task 1 della fase 9 allarga la finestra a
`now − 30gg`, e da lì entra.

**Effetto al primo tick dopo il deploy**: ogni appuntamento **singolo** in
perimetro degli ultimi 30 giorni diventa una proposta di milestone con scadenza
già passata — e la query ordina `asc(startsAt)`, quindi i più vecchi passano per
primi, 20 per tick. È la stessa forma dell'incidente del 9 settembre da una
porta nuova: non «ogni appuntamento personale» (quelli non sono in perimetro),
ma **ogni riunione di lavoro del mese scorso, tutte insieme**.

⚠️ **Il test che dovrebbe proteggere fa l'opposto.**
`apps/worker/src/google/calendar.test.ts:546` asserisce
`expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 1 })`, e
`ready` significa esattamente «candidata a una proposta» (`poller.ts:1170`).
**Quel test fissa il comportamento sbagliato**: va corretto, non aggirato.

**Files:**
- Modify: `apps/worker/src/google/calendar.ts` — la condizione temporale che
  oggi vive solo nel ramo serie vale anche per l'evento singolo
  (`startsAt >= now`). Scrivi il perché: la finestra allargata è utile alla
  griglia e innocua per le serie, ma per gli eventi singoli scopre un cancello
  che non è mai esistito
- Modify: `apps/worker/src/google/poller.ts` — la stessa condizione nella query
  del propose phase, sul ramo `recurring_event_id is null`. **Le due devono
  restare d'accordo**: se una è più larga dell'altra, il difetto torna
- Modify: `calendar.test.ts:546` — correggi l'asserzione: l'evento di tre
  settimane fa **viene scritto** e **non è pronto**
- Test nuovo: un evento singolo passato e in perimetro → **scritto, mai
  proposto**; uno futuro in perimetro → proposto come prima. E il caso che fissa
  l'incidente: **una casella con 30 riunioni di lavoro del mese scorso produce
  ZERO proposte**

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(calendar): un appuntamento passato non diventa una scadenza`.

### Task 2: una serie resta sempre raggiungibile

**Minore, ma da chiudere prima di dimenticarsene.** Spostando la configurazione
della serie nel pannello di dettaglio, una serie le cui occorrenze cadono tutte
fuori da [−30gg, +60gg] non è configurabile da nessuna vista: su `main` c'era un
elenco dedicato (`calendar.tsx:52-97`), nel branch l'unico consumatore è
`calendar-detail-panel.tsx:144`, che esiste solo se hai selezionato un evento
nella griglia.

Il **dato non si perde**: `GET /series` (`me-calendar.ts:178`) raggruppa senza
filtro di finestra, e `me-calendar.test.ts:272` prova che una serie con sole
occorrenze passate resta visibile. Il buco è nella UI.

Impatto oggi nullo (le tre serie in produzione sono attive e hanno sempre
occorrenze in finestra), ma morde su una serie **finita** o **rada** — e il
sotto-caso peggiore non è non poterla accendere: è **non poterla spegnere** se è
accesa con `auto: true`.

**Files:**
- Modify: `apps/web/src/routes/calendar*.tsx` — un blocco richiudibile «Serie
  ricorrenti» nella colonna sinistra. **I dati sono già sulla pagina**: il
  loader fa già `ensureQueryData(calendarSeriesQueryOptions())`
  (`router.tsx:675`) e nessun componente li consuma. Nessuna rotta nuova,
  nessuna query nuova
- Test: una serie senza occorrenze in finestra è elencata e configurabile

**Commit** `fix(calendar): una serie resta raggiungibile anche senza occorrenze in vista`.

### Task 3: tre rifiniture visibili

- **Le immagini perdono le dimensioni.** `allowedAttributes.img`
  (`packages/google/src/gmail.ts:534`) dichiara `width`/`height`, ma
  `transformTags.img` (`:551-560`) ricostruisce `attribs` da zero tenendo solo
  `alt` e `data-src`, e gira **prima** del filtro degli attributi. Conseguenza
  visiva: premendo «mostra immagini» il testo salta, perché il browser non
  conosce le dimensioni prima del caricamento. Propaga `width`/`height` nel
  transform.
- **Prefetch morto**: `router.tsx:674` fa
  `ensureQueryData(calendarEventsQueryOptions({}))`, ma nessun componente
  consuma più quella query (la pagina usa `/range`). È una
  `GET /api/me/calendar` sprecata a ogni apertura del calendario.
- **Lo stato vuoto manda nel posto quasi giusto**: il link porta all'elenco
  progetti, non alla sezione Posta del progetto, dove stanno davvero le regole
  che decidono cosa si vede. Un passaggio in più proprio per chi non sa dove
  guardare.

**Commit** `chore(calendar): dimensioni delle immagini, prefetch morto, link dello stato vuoto`.

### Task 4: CLAUDE.md dice il vero anche sulle parti scomode

Due correzioni e un'aggiunta, tutte sul rollback della 0075 — che è **la prima
migrazione del programma che droppa una colonna**.

- **In scrittura il fallimento è RUMOROSO, ed è la notizia buona.** CLAUDE.md
  dice che un worker precedente «smette di produrre la forma che la colonna si
  aspetta». In realtà drizzle sul binario vecchio dichiara `text().array()`,
  manda un array literal, e Postgres **rifiuta** (`column "attendees" is of type
  jsonb but expression is of type text[]`): la sincronizzazione del calendario
  fallisce rumorosamente invece di scrivere dati sbagliati. Chi legge il
  rollback deve saperlo. In lettura la descrizione attuale è invece esatta.
- **Manca l'avvertenza sul deploy parziale.** CLAUDE.md prescrive
  «server+worker+caddy insieme», corretto — ma qui, **per la prima volta nel
  programma**, un deploy del solo server non lascia una funzionalità incompleta:
  **rompe attivamente il worker vecchio ancora in esecuzione**, che dalla 0075 in
  poi non riesce più a scrivere `calendar_events`. Nelle fasi additive
  precedenti «insieme» era completezza; qui è correttezza.
- **Aggiungi l'invariante del Task 1**: un appuntamento passato non diventa mai
  una proposta, col puntatore alla riga — e il perché (la finestra allargata
  dalla fase 9 scopre un cancello che prima non serviva).

**Commit** `docs(fase9): il rollback e il deploy parziale, detti come stanno`.

### Task 5: due nit sul sanificatore

- **Il docblock promette più di quanto faccia.**
  `packages/google/src/gmail.ts:494-496` dice che `<iframe>`, `<object>`,
  `<embed>`, `<form>` «spariscono col loro contenuto, non solo svuotati». È vero
  solo per `<script>` e `<style>` (gli unici in `nonTextTags` di default):
  `<iframe>TESTO</iframe>` lascia `TESTO`. Innocuo — resta testo inerte — ma chi
  legge quel commento si fida di una garanzia che non c'è. O correggi la frase,
  o aggiungi `nonTextTags`.
- **I test non coprono le varianti offuscate.** I 12 casi provano `onclick`
  minuscolo e `javascript:` in chiaro. Il comportamento sulle forme con maiuscole
  miste, tabulazioni ed entità **è corretto** (un revisore le ha eseguite), ma è
  garantito dalla libreria, non dal repo: un domani un cambio di libreria o di
  opzioni passerebbe la suite. Sei casi, poche righe.

**Commit** `test(mail): le varianti offuscate sono fissate dai test, non dalla libreria`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .` se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report: HEAD finale, link al run, i cinque task, eventuali flaky con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- I flaky preesistenti: `me-google.test.ts` (firma OAuth, 1 su 16, diagnosticato
  il 9 set), `slack/routes.test.ts` (due test su `block_actions`, sospetto
  leakage fra mock adiacenti — `postResponse.mock.calls.at(-1)` che prende la
  call sbagliata).
- La potatura di mirror e grafi, che crescono senza limite.
