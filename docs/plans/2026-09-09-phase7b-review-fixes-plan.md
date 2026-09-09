---
title: Fase 7b — fix di review prima del merge
date: 2026-09-09
design: 2026-09-09-phase7b-mail-calendar-surface-design.md
plan: 2026-09-09-phase7b-mail-calendar-surface-plan.md
stubwise:
  project: stubwise
  backlog: f6f31215-199f-4348-a4e3-a12e9f6cc494
---

# Fase 7b — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase7b-mail-calendar` (branch
> `feature/phase7b-mail-calendar`, PR #18, HEAD `a535802`). Questo piano è su
> `main`: recuperalo con `git fetch && git show origin/main:docs/plans/2026-09-09-phase7b-review-fixes-plan.md`,
> oppure `git merge origin/main` se preferisci averlo nel branch.
> **Non** mergiare e **non** deployare. Alla fine: push, CI verde (incluso
> E2E), report con HEAD e link al run. Le posizioni `file:riga` sono di
> `a535802`.

**Goal:** chiudere i findings della review indipendente (tre revisori: serie e
automazione, posta e sicurezza, regressioni e deploy). **Nessuno è bloccante.**

Prima di tutto, tre cose che vanno dette perché sono il merito di questo giro e
non vanno perse nella lista dei fix:

- **Il fix XSS non previsto dal piano era necessario e la chiusura è
  completa.** `bodyHtml` non esiste in nessun file del branch, non solo nel
  render; l'unico `dangerouslySetInnerHTML` del repo è quello preesistente e
  sanitizzato di `markdown.tsx`. Il piano sbagliava, non l'esecuzione.
- **La rete di sicurezza dell'incidente è solida e onestamente testata.** Il
  revisore ha verificato che ENTRAMBI gli strati siano discriminati dallo stesso
  test (`poller.test.ts:2404`): togliendo il dedup per tick il primo tick fa 20
  invece di 1; togliendo il `NOT EXISTS` il secondo fa 1 invece di 0.
- **La serie spenta di default è per costruzione, non per un `if`**: `LEFT JOIN`
  + `enabled is true`, nessuna riga → `NULL` → falso. Non c'è un default da
  dimenticare.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: la serie usa il progetto che l'utente ha fissato

**Il finding che conta.** Verificato di persona: `calendarSeries.projectId` è
letto in **due soli punti** in tutto il repo — `me-calendar.ts:149` (la lista
per la UI) e `calendar.tsx:196` (il form). **Il worker non lo legge mai.** La
`select` del propose phase (`poller.ts:1313-1324`) prende `enabled`,
`leadDays`, `action`, `auto` e non `projectId`; contano
`calendar_events.project_id` — il progetto ri-dedotto dal routing su
QUELL'occorrenza — sia nel cancello (`isNotNull`, `:1338`) sia nella creazione
(`executeAutoCalendarAction({projectId: row.projectId})`, `:1531`).

Il design §4 dice l'opposto, con la ragione scritta: «Il progetto si fissa, non
si ri-deduce. Le regole di routing decidono a ogni occorrenza, e per una serie
questo è imprevedibile».

**Due esiti, e il peggiore non è quello dichiarato nel report.** La serie che
diventa silenziosamente inerte (routing che non risolve più → `project_id`
null → riga esclusa) è fastidiosa ma innocua. Il caso grave è l'altro: se il
routing risolve un progetto **diverso** — una regola aggiunta su un altro
progetto, un partecipante nuovo — l'azione viene creata **lì**, e con
`auto: true` senza che nessuno la veda prima. La UI dice un progetto, il
sistema ne usa un altro: è l'unico punto della fase in cui il prodotto fa una
cosa diversa da quella che promette.

**Files:**
- Modify: `apps/worker/src/google/poller.ts` (la `select` del propose phase
  legge anche `calendarSeries.projectId`; per un'occorrenza che appartiene a
  una serie **configurata**, il progetto usato è quello della serie, sia nel
  cancello sia nella creazione. Un'occorrenza SENZA serie continua a usare il
  routing, invariata — è la maggioranza degli appuntamenti)
- Modify: `apps/worker/src/google/calendar.ts` (`isReadyForProposal`, se il
  cancello vive anche lì)
- Scrivi il **perché** nel codice, non solo qui: chi legge fra sei mesi deve
  capire che la ri-deduzione è stata una scelta scartata, non una dimenticanza
- Test: `poller.test.ts` — (a) serie accesa con progetto fissato P, occorrenza
  il cui routing risolve **Q**: l'azione nasce su **P**; (b) serie accesa con
  progetto fissato P, occorrenza il cui routing **non risolve niente**: l'azione
  nasce comunque su P, la serie non diventa inerte; (c) evento **senza** serie:
  comportamento invariato rispetto a oggi

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(calendar): una serie usa il progetto fissato, non quello ri-dedotto`.

### Task 2: l'esecuzione automatica è atomica

**Finding (minore, ma reale).** Fra `executeAutoCalendarAction`
(`poller.ts:1528`) e i due UPDATE che seguono (`:1535`, `:1539`) non c'è
transazione. Un crash del worker in mezzo lascia l'oggetto creato, `outcome`
nullo e la notifica ancora `open`: un tap successivo **riesegue**. Per
`milestone` è quasi innocuo (`calendar-auto.ts:62-66` controlla per nome, e il
percorso server ha `milestone_exists`); per `backlog_item` no — nasce una
seconda voce.

**Files:**
- Modify: `apps/worker/src/google/poller.ts` (creazione ed esiti nella stessa
  transazione)
- Test: la doppia esecuzione non produce due voci di backlog

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(calendar): creazione ed esito dell'azione automatica nella stessa transazione`.

### Task 3: la difesa dichiarata esiste o il commento non la promette

**Finding (minore).** `hasOpenSeriesProposal` è **codice morto**:
`poller.ts:1483` lo passa sempre `false` e nessun chiamante di produzione passa
`true` (solo `calendar.test.ts:383,392`). Il controllo a `calendar.ts:309` non
scatta mai in esercizio, ma il docblock a `:250-255` e il commento a
`poller.ts:1299-1303` affermano che `isReadyForProposal` «riverifica riga per
riga».

Non è un bug — SQL e dedup per tick coprono davvero — ma **una difesa in
profondità dichiarata e assente è peggio di una assente e basta**: chi domani
semplificasse il `NOT EXISTS` fidandosi di quel controllo toglierebbe uno
strato credendo di averne due.

Scegli tu quale delle due strade, e scrivi perché: cablare davvero il parametro
(diventa una difesa vera), oppure toglierlo e correggere docblock e commento
(restano due strati dichiarati, che sono quelli che ci sono).

**Commit** `chore(calendar): la difesa in profondità dichiarata coincide con quella che c'è`.

### Task 4: due rifiniture sulla posta

- **La frase arriva troppo tardi.** `mail:detail.originalNotice` («Sto
  chiedendo questo messaggio a Google adesso — non viene salvato nulla») è reso
  **solo mentre `original.isPending`** (`mail.$source.$id.tsx:141`): cioè dopo
  il click e per la durata della chiamata. Il design §3 vuole che sia il
  **comando** a dichiararlo, prima che lo si prema. L'etichetta del bottone dice
  «su Gmail», che è metà dell'informazione. Rendilo accanto al bottone, sempre.
- **Dalla card d'inbox si entra nel dettaglio.** Era stato tagliato con la
  motivazione che servirebbe esporre `email_proposals.id` su
  `inboxGoogleSchema`, «che oggi non c'è». **C'è già**: l'evento persistito
  porta `proposalId`, che è esattamente quello — `poller.ts:1274` lo seleziona e
  lo passa ad `assembleEvent` (`proposal.ts:367`). Costo reale: un campo
  `.optional()` sullo schema e un `<Link>` in `inbox-item.tsx`.
  ⚠️ **Avvertenza**: `proposalId: args.proposalId ?? randomUUID()`
  (`proposal.ts:486, 602`) significa che per calendario e smistamento quell'id è
  **casuale** — il link va reso SOLO per `source === "email"`, come già fa
  correttamente la lista in `mail.tsx`. Un link costruito su un id casuale
  porterebbe a un 404.

**Commit** `feat(mail): dalla notifica si apre il messaggio, e la nota sulla rilettura si legge prima`.

### Task 5: CLAUDE.md dice anche la parte scomoda del rollback

**Finding (prima del deploy).** La voce Fase 7b dice — correttamente — che
`notificationKindSchema` è invariato e che non si ripresenta il 500 su
`/api/inbox` delle fasi 2/5/6. Ma **tace** che due valori sono stati aggiunti a
enum chiusi minori: `acknowledge_reminder` in `inboxGoogleActionTypeSchema`
(`notification.ts:212`) e la variante gemella in `storedActionSchema`
(`google-proposal.ts:177`).

Non è la trappola del 500 — entrambi i punti di lettura usano `safeParse` e
degradano: `readGoogle` (`inbox.ts:874-877`) torna `undefined` (card senza il
blocco di dettaglio, ancora visibile) e `answerGoogleProposal`
(`google-proposal.ts:765-766`) torna `proposal_stale`. Ma è **la stessa
famiglia di trappola già documentata per 6b e 6c**, e chi legge quella voce per
decidere un rollback merita di trovarcela.

Due frasi: una proposta di serie con `action: "reminder"` pubblicata DOPO il
deploy, letta da un binario pre-7b, perde il blocco di dettaglio e risponde
`proposal_stale` alla conferma; nessun crash, ma quelle card vanno chiuse a
mano o si accetta di perderle.

**Files:**
- Modify: `CLAUDE.md` (voce Fase 7b, sezione rollback)
- **NIT nello stesso commit**: `poller.ts:1516-1518` dice che un tap tardivo su
  una notifica non `open` è «già `proposal_stale`»; è `already_handled`
  (`google-proposal.ts:773-774`). Stessa protezione, nome sbagliato.

**Commit** `docs(fase7b): il rollback dice anche cosa succede alle card promemoria`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .` e commit del grafo se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report: HEAD finale, link al run, conferma dei cinque task, eventuali flaky
   con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- **Il flaky di `me-google.test.ts`** («state non spendibile → 400 su firma
  manomessa»): preesistente, diagnosticato il 9 set 2026 — il test manomette
  l'ultimo carattere base64url della firma HMAC, che codifica 4 bit su 6,
  quindi 1 volta su 16 il buffer decodificato è identico e il server accetta
  **correttamente**. Si sistema manomettendo un byte a metà stringa. Non è di
  questa fase.
- **`plugin_jobs`/`graph_jobs` nel test dell'automazione**: irraggiungibili dal
  percorso, l'asserzione su `ai_jobs` e `backlog_jobs` basta.
