---
title: Fase 7b — Posta e Calendario — piano di implementazione
date: 2026-09-09
design: 2026-09-09-phase7b-mail-calendar-surface-design.md
stubwise:
  project: stubwise
---

# Fase 7b — Posta e Calendario: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Lavora in un worktree nuovo `.worktrees/phase7b-mail-calendar` su branch
> `feature/phase7b-mail-calendar` da `main` (oggi `c8aa526`). **Non** mergiare
> e **non** deployare: entrambe restano al maintainer. Alla fine: push, CI
> verde (incluso E2E), report con HEAD e link al run.
>
> Convenzioni: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
> typecheck` prima dell'ultimo commit di ogni fase. Il design è la fonte: dove
> il piano e il design divergono, vince il design — e segnalalo.

**Contesto in una riga**: il 9 settembre 2026 un appuntamento ricorrente ha
prodotto 730 righe e 500 notifiche perché il calendario non ha una superficie
né una configurazione. Vedi §1 del design.

---

## Fase A — fondamenta (Task 1-2)

### Task 1: la serie esiste nel modello

Oggi Google manda `recurringEventId` su ogni occorrenza (`singleEvents=true`,
`packages/google/src/calendar.ts:127`) e lo perdiamo allo zod parse.

**Files:**
- Modify: `packages/google/src/calendar.ts` (`eventSchema` `:44-54` dichiara
  `recurringEventId` e `originalStartTime`; `toEvent` `:75-95` li mappa su
  `GoogleCalendarEvent` `:16-32`. Entrambi **opzionali**: un evento singolo non
  li ha)
- Modify: `packages/db/src/schema.ts` (`calendar_events.recurring_event_id`
  text NULL + index `(account_id, recurring_event_id)`; tabella nuova
  `calendar_series` — vedi la tabella del design §4 — con unique
  `(account_id, recurring_event_id)`, FK su `google_accounts` cascade e su
  `projects` set null, CHECK su `lead_days` 0..30 e su `action`)
- Create: `packages/db/drizzle/0073_calendar_series.sql` (**un solo batch,
  nessun `ALTER TYPE`**: additiva pura)
- Modify: `apps/worker/src/google/poller.ts` (l'upsert `:1100-1150` scrive
  `recurring_event_id`)
- Test: `packages/google/src/calendar.test.ts` (un evento con serie e uno
  senza), `packages/db` (la migrazione applica), `poller.test.ts`

**Commit** `feat(db): la serie ricorrente esiste nel modello (migrazione 0073)`.

### Task 2: la finestra si applica anche a ciò che si scrive

Il difetto che ha prodotto 728 righe su 730 (design §5a).

**Files:**
- Modify: `apps/worker/src/google/poller.ts:1049-1057` (il ciclo che filtra in
  memoria scarta anche gli eventi con `startsAt` fuori da
  `calendarWindow(now)`. Il **perché** va scritto lì: con un `syncToken` la
  finestra non si può mandare a Google, quindi è l'unico punto in cui esiste)
- Test: `poller.test.ts` — un giro incrementale che riceve un'occorrenza fra
  cinque anni **non scrive nessuna riga**; un'occorrenza dentro i 60 giorni la
  scrive. Questo test è la rete di sicurezza dell'incidente: chiamalo in modo
  che si capisca cosa protegge.

**Commit** `fix(calendar): la finestra dei 60 giorni vale anche in scrittura`.

---

## Fase B — il calendario si configura (Task 3-5)

### Task 3: le rotte del calendario

Personali, con l'ACL della posta: **`user_id` sempre nel WHERE**, nessun ruolo
scavalca (design §6). Prendi `apps/server/src/routes/me-mail.ts` come modello,
docblock `:30-38` incluso.

**Files:**
- Create: `apps/server/src/routes/me-calendar.ts` — `GET /` (appuntamenti
  visti, keyset come `me-mail.ts`), `GET /series` (le serie riconosciute con la
  configurazione), `PUT /series/:recurringEventId` (attiva/configura),
  `DELETE /series/:recurringEventId` (spegne)
- Modify: `packages/shared/src/schemas/google.ts` (gli schemi delle risposte.
  **Ogni campo nuovo `.optional()`/`.nullable()`/`.default()`**, con un test che
  parsa senza — invariante dell'app mobile, CLAUDE.md)
- Modify: `apps/server/src/routes/index.ts` o dove si registrano le rotte
- Test: `me-calendar.test.ts` con testcontainers — il filo conduttore è
  «`user_id` è nel WHERE»: un admin **non** vede il calendario di un member, e
  la risposta è vuota/404, mai 403

**Commit** `feat(calendar): le rotte personali del calendario e delle serie`.

### Task 4: il poller rispetta la configurazione

**Files:**
- Modify: `apps/worker/src/google/calendar.ts` (`isReadyForProposal` `:241`
  diventa consapevole della serie: un'occorrenza che appartiene a una serie
  **non configurata o spenta** non è mai pronta. Il default spento è la
  regola, non un caso limite)
- Modify: `apps/worker/src/google/poller.ts` (`runProposePhase` `:1279-1305`:
  per le occorrenze di una serie accesa, la proposta parte quando mancano
  `lead_days` giorni all'occorrenza, non appena la riga esiste)
- Test: `poller.test.ts` — serie spenta → nessuna proposta mai; serie accesa
  con `lead_days: 2` → niente a 5 giorni, proposta a 2; l'occorrenza già
  passata non propone; **una serie accesa con 100 occorrenze future produce una
  proposta per volta, non 100** (è l'asserzione che fissa l'incidente)

**Commit** `feat(calendar): una serie propone solo se accesa, e con l'anticipo scelto`.

### Task 5: le tre azioni, e quella automatica

**Files:**
- Modify: `apps/worker/src/google/proposal.ts` (`buildCalendarProposalEvent`
  `:525-547` costruisce la proposta secondo `action`: voce di backlog,
  milestone — quella di oggi — o promemoria. **Nessun valore nuovo in
  `ProposalSource.source`**, design §4)
- Modify: `apps/server/src/services/google-proposal.ts` (`dispatchAction`
  esegue le tre azioni; la milestone riusa `createMilestone`
  (`services/milestones.ts:57`) invariata)
- Modify: il percorso `auto: true` — crea l'oggetto senza chiedere e lo rende
  **visibile a chi ha la casella**, senza nuovi kind (design §4). ⚠️
  **L'azione automatica non avvia mai un job AI**: scrivilo come commento nel
  punto in cui si esegue, non solo qui
- Test: le tre azioni proposte e confermate; il percorso automatico che crea e
  notifica; e un test che **fallisce se qualcuno un domani accodasse un job AI**
  da questo percorso

**Commit** `feat(calendar): voce di backlog, milestone o promemoria, proposte o automatiche`.

---

## Fase C — la posta si legge (Task 6-8)

### Task 6: il dettaglio di un'email, dall'estratto in database

**Files:**
- Modify: `apps/server/src/routes/me-mail.ts` (`GET /:source/:id` — dettaglio,
  con `text_excerpt`, che oggi non è selezionato da nessuna parte. Stessa ACL
  delle altre sei rotte)
- Modify: `packages/shared/src/schemas/google.ts` (schema del dettaglio; il
  campo del corpo dichiara di essere un **estratto**, non il messaggio)
- Test: `me-mail.test.ts` (il dettaglio; l'ACL; un messaggio senza
  `text_excerpt` — è `NULL`-abile — non rompe la risposta)

**Commit** `feat(mail): il dettaglio di un'email con il testo già conservato`.

### Task 7: il messaggio originale, su richiesta

**Files:**
- Modify: `apps/server/src/routes/me-mail.ts` (`GET /:source/:id/original` —
  rilegge con `getMessageFull` (`packages/google/src/gmail.ts:263`) usando il
  token della casella. **Non si persiste nulla** di ciò che si rilegge: è una
  finestra su Gmail, non una copia)
- Gestisci gli errori veri, non solo il caso felice: token scaduto, messaggio
  cancellato da Gmail, Google irraggiungibile → un errore leggibile, e
  l'estratto resta visibile
- Test: `me-mail.test.ts` con il client Google finto (successo; messaggio
  sparito; token scaduto)

**Commit** `feat(mail): rileggere il messaggio originale da Gmail su richiesta`.

### Task 8: la vista web della posta

**Files:**
- Create: `apps/web/src/routes/mail.$source.$id.tsx` (dettaglio; il modello di
  struttura, stati e paginazione è `apps/web/src/routes/mail.tsx`)
- Modify: `apps/web/src/routes/mail.tsx` (dalla riga si entra nel dettaglio; il
  link a Gmail resta come uscita, non come unica strada),
  `apps/web/src/components/inbox-item.tsx` (dalla card si entra nel dettaglio)
- Modify: `router.tsx` (la rotta figlia), i18n `en`+`it`
- **La copy dichiara cosa stai leggendo** (design §3): l'estratto dice di essere
  un estratto e cosa non contiene; il comando di rilettura dice che sta
  chiedendo il messaggio a Google adesso; e la sezione dice che **dopo 90
  giorni il messaggio non c'è più**
- Test: web (happy-dom); parità i18n

**Commit** `feat(web): leggere un'email dentro Stubwise`.

---

## Fase D — la sezione Calendario (Task 9)

### Task 9: la pagina e la configurazione delle serie

**Files:**
- Create: `apps/web/src/routes/calendar.tsx` (appuntamenti visti + serie;
  struttura, filtri, stati e paginazione sul modello di `mail.tsx`)
- Create: il form della serie — toggle + progetto + azione + numero di giorni +
  automatica. Il pattern «toggle + numero con validazione e PATCH minimo» è
  `apps/web/src/components/project-form.tsx:269-288`: **riusalo, non
  reinventarlo**
- Modify: `apps/web/src/components/app-layout.tsx` (`NAV_ITEMS` `:27-44`, la
  voce nuova con `memberVisible`), `router.tsx`, i18n `en`+`it` (namespace
  nuovo `calendar`: va aggiunto anche all'array in
  `apps/web/src/i18n/index.ts:14-37`, altrimenti le chiavi non si risolvono)
- **La copy dice che una serie è spenta di default e perché**: chi la accende
  deve capire che sta accendendo qualcosa che si ripete
- Test: web; parità i18n

**Commit** `feat(web): la sezione Calendario e la configurazione delle serie`.

---

## Fase E — chiusura (Task 10-11)

### Task 10: documentazione

**Files:**
- Modify: `CLAUDE.md` — voce «Fase 7b» nella sezione Deploy (rebuild
  server+worker+caddy, migrazione 0073, nessuna env nuova, rollback: **niente
  kind nuovo, quindi nessuna trappola del 500 su `/api/inbox`**; la strada
  innocua è spegnere le serie dalla UI). E un invariante nuovo: **una serie
  ricorrente è spenta di default e la sua azione automatica non avvia mai
  lavoro**, con il puntatore alla riga
- Modify: `apps/docs` — guida utente: leggere la posta, la sezione Calendario,
  cosa vuol dire accendere una serie
- ⚠️ Non scrivere in CLAUDE.md cose che il codice non fa: la voce va verificata
  rileggendo il codice, non il piano

**Commit** `docs(fase7b): CLAUDE.md e guida utente`.

### Task 11: verifica finale

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .` e commit del grafo; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report al maintainer: HEAD, link al run, i dieci task, eventuali flaky con i
   nomi, e **qualunque punto in cui il design ti è sembrato sbagliato** — è
   informazione che vale più del codice.

---

## Fuori da questo piano

Design §7: rispondere alle email, conservare gli allegati, il riordino di
`inScope` per il calendario, la retention dei 90 giorni, il calendario
multi-progetto.
