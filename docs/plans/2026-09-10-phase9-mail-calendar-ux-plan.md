---
title: Fase 9 — Posta e Calendario — piano di implementazione
date: 2026-09-10
design: 2026-09-10-phase9-mail-calendar-ux-design.md
stubwise:
  project: stubwise
---

# Fase 9 — Posta e Calendario: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Worktree nuovo `.worktrees/phase9-mail-calendar-ux`, branch
> `feature/phase9-mail-calendar-ux` da `main`. **Non** mergiare e **non**
> deployare. Alla fine: push, CI verde (incluso E2E), report con HEAD e link al
> run.
>
> Convenzioni: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
> typecheck` prima dell'ultimo commit di ogni fase; `pnpm -r test` con
> `--workspace-concurrency=1`. Il design è la fonte: dove piano e design
> divergono, vince il design — e segnalalo.

**Leggi il §3 del design prima di toccare il poller.** Il rischio numero uno di
questa fase è trasformare ogni appuntamento personale in una proposta di
milestone.

---

## Fase A — il calendario diventa un calendario (Task 1-3)

### Task 1: si ingerisce tutto, si propone solo ciò che è in perimetro

**⚠️ IL TASK PIÙ PERICOLOSO DEL PIANO. Le due modifiche stanno nello stesso
commit, mai in due.**

Oggi `apps/worker/src/google/poller.ts:1072`
(`if (!routeEvent(event, ctx.routes).inScope) continue;`) fa **due lavori in
uno**: decide cosa si scrive e, di conseguenza, cosa può diventare una
proposta. Toglierlo dall'ingestione senza metterlo in proposta significa che
ogni appuntamento personale — il dentista, la cena — diventa una proposta di
milestone: l'incidente del 9 settembre moltiplicato per la vita privata di chi
ha collegato la casella.

**Files:**
- Modify: `apps/worker/src/google/poller.ts` — l'`inScope` esce dal ciclo di
  ingestione (`:1049-1072`) ed entra nella condizione di **proposta**
  (`runProposePhase`), accanto alle condizioni che la 7b ha già messo lì (serie
  configurata e accesa, anticipo, progetto fissato). Il filtro della finestra
  dei 60 giorni in scrittura **resta dov'è**: è la difesa della 7b
- Il perché va scritto nel codice, non solo qui: chi legge fra sei mesi deve
  capire che sono due domande diverse (design §3), non un controllo spostato
  per comodità
- Test, e sono la rete di sicurezza di questa fase:
  - un evento **fuori perimetro** dentro la finestra → **scritto** in
    `calendar_events` e **mai** proposto (asserisci su entrambe le cose)
  - un evento **in perimetro** → scritto e proposto come prima
  - un evento fuori finestra → non scritto, come la 7b
  - **una casella con 50 appuntamenti personali produce ZERO proposte**

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `feat(calendar): si vede tutto, si propone solo il lavoro in perimetro`.

### Task 2: i partecipanti hanno uno stato, l'evento ha un link

**Files:**
- Modify: `packages/google/src/calendar.ts` — `eventSchema` (`:63`) dichiara
  `responseStatus`; `toEvent` (`:111`) lo mappa. `htmlLink` c'è già nel tipo
  (`:30`, `:115`) e va solo persistito
- Modify: `packages/db/src/schema.ts` + `packages/db/drizzle/0075_*.sql` —
  colonna `html_link` (nullable); i partecipanti passano da `text[]` a una
  forma che porta anche lo stato. **Migrazione con dati**: 1553 righe in
  produzione. Modello da imitare: la 0074 — backfill, poi `NOT NULL`, così un
  buco fa fallire la migrazione invece di lasciare dati muti
- ⚠️ `attendees` è letto da `eventToRouting`
  (`apps/worker/src/google/calendar.ts:169-177`) come `toAddresses` per
  l'attribuzione: **cambia anche quel lettore nello stesso commit**. Alla fine
  deve esserci UNA sola fonte di verità, non una colonna nuova accanto a una
  vecchia
- Test: `packages/google` (evento con e senza `responseStatus`), `packages/db`
  (il backfill su dati realistici), `apps/worker` (l'attribuzione non cambia
  comportamento)

**Commit** `feat(calendar): lo stato dei partecipanti e il link all'evento (migrazione 0075)`.

### Task 3: le rotte del calendario per una griglia

Oggi `me-calendar.ts` serve una lista con keyset. Una griglia vuole un
intervallo.

**Files:**
- Modify: `apps/server/src/routes/me-calendar.ts` — gli eventi di un intervallo
  (`from`/`to`), con i campi che servono al pannello di dettaglio. **L'ACL non
  si tocca**: `user_id` sempre nel WHERE, nessun ruolo scavalca
- Modify: `packages/shared` (schemi; campi nuovi `.optional()`/`.nullable()`
  con test che parsa senza)
- ⚠️ Metti un tetto all'intervallo richiedibile: una griglia mensile è un mese,
  non «dal 2021 al 2035». Senza tetto, una richiesta larga legge tutta la
  tabella
- Test: server con testcontainers, ACL inclusa

**Commit** `feat(calendar): gli eventi di un intervallo, per la griglia`.

---

## Fase B — l'email si legge (Task 4-5)

### Task 4: HTML sanificato, mai conservato

**Files:**
- Modify: `apps/server/src/routes/me-mail.ts` — la rotta `/original` aperta
  dalla 7b restituisce anche l'HTML **sanificato lato server**: allowlist di
  tag e attributi (**non** una denylist: si aggira), via ogni `<script>`,
  handler `on*`, `javascript:`, `<iframe>`, `<object>`, `<embed>`, `<form>`
- **L'HTML non si persiste in nessuna colonna** (design §4): si rilegge da
  Gmail e si sanifica per quella risposta. Nessuna copia di HTML scritto da un
  estraneo entra nel database
- Le immagini remote si neutralizzano di default (l'`src` non parte finché
  l'utente non lo chiede): sono i pixel di tracciamento
- Test: una tabella di payload ostili — `<script>`, `<img onerror>`,
  `<a href="javascript:">`, `<iframe>`, CSS con `expression()`, un `<img>`
  remoto — e per ciascuno l'asserzione su cosa sopravvive. Questo test è la
  difesa: scrivilo prima

**Commit** `feat(mail): il corpo HTML si legge sanificato, e non si conserva`.

### Task 5: la lettura a tre colonne

**Files:**
- Modify/Create: `apps/web/src/routes/mail*.tsx` — tre colonne (design §5):
  caselle e filtri esistenti a sinistra, lista al centro, lettura a destra
- Il corpo va in un **`<iframe sandbox>`** senza `allow-scripts` e senza
  `allow-same-origin`, con il comando «mostra immagini»
- ⚠️ **La lista sarà sempre corta** (33 messaggi in produzione): disegnala per
  venti righe, non per duemila — niente densità da client di posta, niente
  scroll infinito che non scorre mai
- Tema: quello esistente (`apps/web/src/styles.css`), **un solo accento ambra**
- Test: web; parità i18n

**Commit** `feat(web): la posta si legge a tre colonne`.

---

## Fase C — la griglia (Task 6-7)

### Task 6: giorno, settimana, mese

**Files:**
- Modify/Create: `apps/web/src/routes/calendar*.tsx` — le tre viste, oggi e le
  frecce, l'elenco delle caselle col proprio colore, il mini-calendario
- I colori per casella si ottengono **dentro la palette dell'inchiostro**
  variando luminosità e saturazione: l'accento ambra resta uno (design §5)
- ⚠️ Fusi orari: gli eventi sono `timestamptz` e `all_day` è a mezzanotte UTC
  (vedi il commento in `apps/worker/src/google/calendar.ts` su `isoDay`). Una
  griglia sbaglia riga se confonde i due — scegli come rendi e **scrivi la
  scelta**
- Test: web (un evento a cavallo di mezzanotte; un evento «tutto il giorno»;
  una settimana vuota); parità i18n

**Commit** `feat(web): la griglia del calendario, giorno settimana mese`.

### Task 7: il pannello di dettaglio, e la serie si accende da lì

**Files:**
- Create: il pannello laterale — titolo, quando, partecipanti **con lo stato**,
  «apri in Google Calendar» (`html_link`)
- Modify: la configurazione della serie della 7b si raggiunge **da qui**, davanti
  all'appuntamento che si sta guardando, invece che da un elenco separato
  (design §3). Se l'evento non appartiene a una serie, quella parte non c'è
- Test: web; parità i18n

**Commit** `feat(web): il dettaglio dell'evento, con la serie configurabile da lì`.

---

## Fase D — chiusura (Task 8-9)

### Task 8: documentazione

- `CLAUDE.md`: voce «Fase 9» (rebuild, migrazione 0075 **con dati**, rollback) e
  l'invariante nuovo: **il calendario ingerisce tutto, propone solo ciò che è in
  perimetro** — col puntatore alla riga. ⚠️ Scrivi anche l'avvertenza di
  rollback del design §6: dopo questa fase il database contiene tutti gli
  appuntamenti, e per un binario senza il filtro in proposta sarebbero
  proponibili
- `apps/docs`: guida utente — cosa si vede nel calendario e perché non tutto
  produce proposte; come si legge un'email e perché le immagini sono bloccate
- ⚠️ Verifica ogni affermazione contro il codice, non contro il piano

**Commit** `docs(fase9): CLAUDE.md e guida utente`.

### Task 9: verifica finale

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .`; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report: HEAD, link al run, i task, eventuali flaky con i nomi, e **ogni punto
   in cui il design ti è sembrato sbagliato**.

---

## Fuori da questo piano

Design §7: rispondere o scrivere email, le cartelle in uscita, il cambio di
linguaggio visivo dell'app, il tema chiaro, il calendario multi-progetto, l'app
mobile.
