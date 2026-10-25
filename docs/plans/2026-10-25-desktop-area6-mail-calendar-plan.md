# App desktop, area 6: Posta e Calendario — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare nel prototipo `apps/desktop` Posta e Calendario del web e
costruire le novità del design: classificazione di ogni email (progetti,
importanza, scadenza, proposte) senza filtri, proposte condivise fra i
destinatari, trascrizioni dei Meet con riassunto, scheda di preparazione,
scrittura con bozza di Claude, azioni sul calendario, due blocchi in Home.

**Architecture:** Un blocco di dati finti `data/mail/*` (caselle, messaggi,
classificazione simulata, proposte, bozze e invii, trascrizioni) e uno
`data/calendar/*` (eventi, risposte, serie, scritture), separati come Chat e
Drive. La privacy della posta sta in **una** funzione (`canSeeMessage`), la
visibilità delle proposte in un'altra (`canSeeMailProposal`); le pagine
leggono solo da `data/queries.ts`. La griglia del calendario riusa le
funzioni pure di `@stubwise/shared/calendar-grid` (fusi già decisi lì). Le
proposte eseguono le azioni con l'esecutore «tutto o niente» di
`settleProposal` (`data/api-mutations.ts`). UI in `pages/mail/*`,
`pages/calendar/*`, blocchi in `pages/home/blocks/*`.

**Tech Stack:** quello delle aree 1–5; nessuna dipendenza nuova. Il corpo
HTML di un'email si mostra in un `<iframe sandbox>` con `srcdoc`, immagini
remote bloccate fino al clic (come il web, `untrusted-html-frame.tsx`).

**Spec:** `docs/plans/2026-10-25-desktop-area6-mail-calendar-design.md`
(approvato 25 ott 2026, commit 582eb9fe). Contesto:
`apps/desktop/docs/web-inventory.md` (sezioni «Mail & Calendar» e la card
`google.proposal` dell'Inbox), `docs/invariants/mail-calendar.md`,
`apps/desktop/DESIGN.md`, design area 5 (account Google personale).

## Global Constraints

- Tutte le Global Constraints delle aree 2–5 restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo e codice; codice sempre con nome; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi; lint/typecheck/test verdi a ogni commit; orologio fisso del prototipo — `now()` di `data/store.ts`, mai `Date.now()`; Impeccable obbligatorio con gli shape approvati vincolanti; R-G5: nascosto e inesistente identici).
- **Privacy**: un messaggio lo vede **solo** una persona fra i suoi destinatari in Stubwise (mittente, `to`, `cc`, proprietario della casella che lo contiene). Admin e full admin **non** fanno eccezione. Vale per elenco, ricerca, ⌘K, scheda di preparazione, Claude.
- **Nessun filtro d'ingresso**: niente domini ammessi, niente regole della posta per progetto. Ogni email va alla classificazione; l'unico interruttore è personale, «Proposte attive per questa casella» (`Mailbox.proposalsEnabled`): spento = la posta di quella casella non va al modello (resta `classification.state: "off"`).
- **Classificazione**: progetti candidati = progetti di cui almeno un destinatario in Stubwise è membro. Esito: `projectIds` (0..n), `importance` ∈ `high | normal | low`, `dueDate` (ISO o `null`), proposte. Nessun progetto → nessuna proposta, nessuna etichetta (newsletter, personali, automatiche). Incerta fra più progetti → una proposta `chooseProject`.
- **Una proposta per email (Message-ID) e progetto**, condivisa: la vedono i destinatari in Stubwise **membri del progetto**; un destinatario non membro non la vede. Chi decide per primo chiude per tutti («Confermata/Ignorata/Passata al progetto da <nome>»); una seconda decisione → `already_handled`.
- **Conferma** = permesso dell'azione nel progetto: `createTask` → `tickets.create`; `updateTask`, `createMilestone` → `tickets.edit`; `addComment` → `tickets.comment`; `createRequest` → `backlog.create`; `recordDecision` → `decisions.record`. Senza → «Passa al progetto» (arriva a chi ha il permesso, con l'estratto). Le proposte di calendario non si passano.
- **Incaricato fuori dal progetto**: alla conferma «<Nome> non è nel progetto: aggiungila come Contributor?»; con `project.members.manage` → aggiunta (ruolo `contributor`, `memberIds`) e assegnazione; senza → scegli un altro o lascia senza.
- **Riunioni registrate**: email di Gemini riconosciuta (`kind: "transcript"`), Google Doc letto, collegata all'evento per link Meet + orario. Riassunto e trascrizione: **solo i partecipanti dell'evento** in Stubwise. Gli altri membri vedono solo task e richieste nate.
- **Calendario**: una riunione normale non produce proposte; le producono serie accese (spente di default), trascrizioni ed eventi futuri riconosciuti come scadenza/consegna (→ `createMilestone`). Mai da un evento passato o rifiutato. Evento con orario nel fuso locale, «tutto il giorno» come data (getter UTC), finestra `now − 30 gg → now + 60 gg` (`CALENDAR_LOOKBACK_DAYS`/`CALENDAR_WINDOW_DAYS`).
- **Scrittura**: nulla parte senza clic su «Invia»; annulla per **5 s** dopo l'invio; bozze salvate per conversazione; la bozza di Claude riempie il campo in streaming e si modifica.
- **Allineamento**: «Aggiornato N min fa» per casella, «Aggiorna ora»; oltre **5 minuti** segnato come vecchio; casella `expired` → «Ricollega». Scritture con stato `sending` → `sent`/`failed` («Riprova»).
- **Home**: blocchi `importantMail` (email `high` non aperte, dalla più recente) e `upcomingEvents` (da `now()` a fine di domani); presenti di default nelle Home nuove.
- **Nessun permesso nuovo.** Posta e Calendario richiedono solo l'account Google collegato (area 5).
- **Prototipo**: tutto Google è simulato; «Apri in Gmail», «Apri in Google Calendar», «Apri la trascrizione» mostrano un avviso; arrivi e classificazioni passano da `gate()` con ritardo simulato; nessun lavoro nel processo main.

## Review Focus

1. **Privacy della posta sotto il «vedi come»**: un admin, un collega dello stesso progetto non destinatario, un destinatario in `cc` — elenco, ricerca, ⌘K, scheda di preparazione, «Da decidere», Claude. Solo i destinatari vedono il messaggio; il resto è come se non esistesse. → test in Task 2, Task 6, Task 11.
2. **Proposta condivisa decisa da due persone quasi insieme**: la seconda riceve `already_handled` e vede chi ha deciso; nessuna task doppia; cambio di persona con il dialogo di conferma aperto lo chiude. → test in Task 3 e Task 7.
3. **Fusi e bordi del calendario**: evento «tutto il giorno» in un fuso negativo, evento a cavallo della mezzanotte, serie con occorrenze fuori finestra, navigazione ai bordi della finestra di 30/60 giorni. → test in Task 5 e Task 9 (con `TZ` negativo).
4. **Invio annullato e invio fallito**: «Annulla» entro 5 s non lascia traccia nella conversazione; un invio fallito tiene il testo e offre «Riprova»; cambio di persona durante i 5 s non spedisce a nome dell'altra. → test in Task 4 e Task 8.
5. **Contenuti estremi**: oggetto lunghissimo, conversazione da 60 messaggi, email con 40 destinatari, HTML ostile (script, immagini remote), giornata con 12 eventi sovrapposti. → test in Task 7 e Task 9.

---

### Task 0 (controller): shape di Impeccable

Brief Impeccable `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `mail.md` (Posta: caselle e filtri per importanza/progetto, elenco per conversazione, lettura con originale isolato, proposte accanto all'email con modifica e conferma parziale, proposta condivisa decisa da altri, incaricato fuori dal progetto, analisi in corso/fallita, allineamento), `mail-compose.md` (rispondi/rispondi a tutti/inoltra/nuova, destinatari, allegati dal Drive, bozza di Claude con indicazione, invio con annulla, bozze salvate, fallito), `calendar.md` (griglia giorno/settimana/mese, dettaglio, nuova riunione con disponibilità e Meet, risposta agli inviti, modifica/trascinamento, «solo questo / tutta la serie», serie ricorrenti, progetto dell'evento e correzione), `meeting-prep.md` (scheda di preparazione, riassunto e trascrizione per i partecipanti, versione ridotta per i non partecipanti, blocchi Home «Email importanti» e «Prossimi appuntamenti»). Aggiornare `home.md` per i due blocchi. Nessun codice.

### Task 1: Posta — modello, permessi e seme

**Files:** Modify `data/model.ts`, `data/types.ts`, `data/store.ts`; Create `data/seed/mail/*.ts`; Test `data/seed.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export interface MailAddress { name: string; email: string; personId: string | null }
export interface Mailbox { personId: string; email: string; proposalsEnabled: boolean; syncedAt: string;
  sync: "ok" | "syncing" | "failed" }
export type MailImportance = "high" | "normal" | "low";
export type MailClassification =
  | { state: "off" | "pending" | "failed" }
  | { state: "done"; projectIds: string[]; importance: MailImportance; dueDate: string | null;
      uncertainProjectIds: string[] };
export interface MailMessage { id: string; messageId: string /* RFC Message-ID */; threadId: string;
  from: MailAddress; to: MailAddress[]; cc: MailAddress[] | null; subject: string; at: string;
  text: string; quoted: string | null; html: string | null; attachments: { id: string; name: string; sizeBytes: number }[];
  mailboxPersonIds: string[] /* caselle che lo contengono */; readByPersonIds: string[];
  kind: "email" | "transcript"; context: boolean /* messaggio di contesto */; classification: MailClassification;
  delivery?: { state: "sending" | "sent" | "failed"; sentById: string; error?: string } }
export interface MeetingTranscript { messageId: string; eventId: string | null; docTitle: string;
  doc: "reading" | "ready" | "unreachable"; transcript: string; summary: string | null }
export type MailProposalSource = "email" | "transcript" | "calendar";
export interface MailProposal { id: string; source: MailProposalSource; sourceId: string /* messageId RFC o eventId */;
  projectId: string; actions: ProposedAction[]; excerpt: string; createdAt: string;
  status: "open" | "confirmed" | "ignored" | "handed" | "failed"; decidedById: string | null; decidedAt: string | null;
  resultCodes: string[]; error: string | null; handedAt: string | null }
export interface MailDraft { id: string; personId: string; threadId: string | null; mode: "new" | "reply" | "replyAll" | "forward";
  replyToMessageId: string | null; to: MailAddress[]; cc: MailAddress[]; subject: string; body: string;
  attachments: { id: string; name: string; sizeBytes: number; driveFileId: string | null }[]; updatedAt: string }
```
`ProposedAction.fn` guadagna `"recordDecision" | "createMilestone" | "chooseProject"`. `HomeBlockKind` guadagna `"importantMail" | "upcomingEvents"` (titoli e catalogo nel Task 11). Nessun permesso nuovo in `viewer.ts`.

Seme (date relative a `TODAY`, ore prima e dopo `now()`): caselle per Giulia (collegata, `proposalsEnabled`), Marco (collegata), Laura (`expired` sull'account Google, casella vecchia); Roberta (admin) **senza** messaggi di altri. Email su AUD e STW di importanza `high/normal/low` con scadenze; due newsletter e una personale senza progetto; una incerta fra AUD e MKX; una email a Giulia, Marco e Laura (stesso `messageId`, tre `mailboxPersonIds`) con una proposta condivisa aperta; una già confermata da Marco; una passata al progetto; un'email di Gemini dopo la riunione AUD di ieri con `MeetingTranscript` pronto e quattro `createTask`, una assegnata a Chiara (marketing, **non** membro di AUD); una trascrizione `unreachable`; una classificazione `pending` e una `failed`; una conversazione da 60 messaggi; un HTML con `<script>` e immagini remote; un'email con 40 destinatari.
- [ ] Tests (seme): ogni caso sopra presente; `messageId` unici tranne la condivisa; ogni `MailProposal` ha `projectId` di cui almeno un destinatario è membro; nessun messaggio ha Roberta fra i destinatari; Chiara non è in `memberIds` di AUD.
- [ ] Commit `feat(desktop): modello e seme della Posta`.

### Task 2: Posta — livello dati

**Files:** Create `data/mail/{visibility.ts,reads.ts,writes.ts,classify.ts,index.ts}` (+`data/mail/mail.test.ts`); Modify `data/api.ts`, `data/api-mutations.ts`, `data/queries.ts`, `data/store.ts`.

**Interfaces — Produces:**
- `canSeeMessage(me: string, m: MailMessage): boolean` — `me` è `from.personId`, in `to`/`cc` per `personId`, o in `mailboxPersonIds`. Unica fonte per ogni lettura.
- Reads: `listMailThreads({ mailbox?: string; importance?: MailImportance; projectId?: string; q?: string })` → righe `{ threadId, subject, lastAt, participants, projectIds, importance, dueDate, unread, openProposals, analysing }` (importanza = la più alta dei messaggi visibili; progetti visibili a me soltanto); `getMailThread(threadId)` → messaggi visibili in ordine, transcript se lo vedo (Task 6), proposte (Task 3); `listMailboxes()` → le mie caselle con `stale` (`now() − syncedAt > 5 min`) e `expired`; `listImportantMail()` per la Home; `searchMail(q)` per ⌘K.
- Writes: `markRead(threadId)`, `syncMailbox(email)` (`syncing` → `ok`, arriva un messaggio nuovo del seme in coda, `syncedAt = now()`), `setProposalsEnabled(email, on)`, `reproposeMessage(id)` (`failed` → `pending` → `done`).
- `classify.ts`: `classifyMessage(m, members: (projectId) => string[]): MailClassification` finta e deterministica (parole chiave del seme), e `candidateProjects(m)` = progetti con almeno un destinatario membro. Ritardo via `gate()`.
- [ ] Tests: Review Focus 1 (elenco, thread e ricerca per admin, collega non destinatario, destinatario in `cc`: `getMailThread` di un thread invisibile → `not_found` come un id inesistente); `proposalsEnabled: false` → `state: "off"` e nessuna proposta; `stale` dopo 5 min; casella `expired`; un progetto invisibile a me non compare in `projectIds` della riga; newsletter senza progetto e senza proposte; `reproposeMessage` passa per `pending`.
- [ ] Commit `feat(desktop): dati della Posta`.

### Task 3: Proposte condivise

**Files:** Create `data/mail/proposals.ts` (+`data/mail/proposals.test.ts`); Modify `data/api-mutations.ts` (estrarre da `settleProposal` l'esecuzione «tutto o niente» delle azioni in una funzione riusabile, senza cambiarne il comportamento per conversazioni e Chat), `data/queries.ts`.

**Interfaces — Produces:**
- `canSeeMailProposal(me, p): boolean` — `source` email/transcript: vedo il messaggio con `messageId === p.sourceId` **e** sono membro di `p.projectId`; `status: "handed"`: anche chi ha il permesso della prima azione nel progetto. `source: "calendar"`: partecipante dell'evento e membro.
- `permissionForAction(fn: ProposedAction["fn"]): Permission | null` con la mappa delle Global Constraints (`chooseProject` → `null`).
- Reads: `listMailProposals({ sourceId?, status? })`, `getMailProposal(id)` → `{ proposal, canConfirm, canHand, outsiders: { personId, name }[] /* incaricati non membri */, decidedBy }`.
- Writes: `confirmMailProposal(id, { actionIndexes?, edits?: Record<number, Partial<args>>, addOutsiders?: string[] })` (`already_handled` se non `open`; `forbidden` se manca un permesso; `addOutsiders` richiede `project.members.manage` → `grantProjectRole(personId, projectId, "contributor")` + `memberIds`, poi esegue; tutto o niente), `ignoreMailProposal(id)`, `handMailProposal(id)` (non per `calendar` → `invalid_action`), `chooseProjectFor(id, projectId)` (sostituisce la proposta `chooseProject` con quelle del progetto scelto), `reassignMailProposal(id, projectId)`.
- Le proposte aperte e visibili entrano in `useDecisions`/«Da decidere» come `kind: "mailProposal"` (Task 11 per la UI).
- [ ] Tests: Review Focus 2 (due persone: la seconda `already_handled`, una sola task, `decidedBy` giusto); destinatario non membro non la vede; Viewer la vede con `canConfirm: false, canHand: true`; passata → la vede un Project Lead non destinatario con l'estratto, non il messaggio; outsider senza `project.members.manage` → `forbidden` e nulla creato; con il permesso → Chiara membro come `contributor` e incaricata; proposta di calendario non passabile; conferma parziale; modifica dei campi applicata; `resetApi` annulla le concessioni di ruolo. `recordDecision` scrive nel registro con origine `email` e testo da template (mai dal modello).
- [ ] Commit `feat(desktop): proposte condivise dalla posta`.

### Task 4: Scrittura — bozze, invio, bozza di Claude

**Files:** Create `data/mail/compose.ts` (+test), `domain/claude/intents/mailDraft.ts` (+test); Modify `data/queries.ts`, `data/api-mutations.ts`.

**Interfaces — Produces:**
- `getDraft(threadId | null, mode)`, `saveDraft(draft)` (per persona e conversazione), `discardDraft(id)`.
- `sendDraft(id): { messageId; undoUntil: string }` — crea il messaggio con `delivery.state: "sending"` visibile solo nella mia vista fino a `undoUntil` (`now() + 5 s` sul timer del prototipo), poi `sent`; `undoSend(messageId)` entro la finestra → torna bozza, nessuna traccia; dopo → `too_late`. Un invio può fallire (seme: un indirizzo `@bounce.example`) → `failed` col testo intatto e `retrySend`.
- Destinatari: `suggestRecipients(q)` → persone del team + indirizzi visti nei messaggi che vedo (mai indirizzi solo da messaggi invisibili).
- Allegati dal Drive: `attachDriveFile(draftId, driveFileId)` solo per file che vedo (`canSeeDriveFile`).
- `mailDraft.ts`: `draftReply({ threadId, hint })` → testo finto costruito dall'ultimo messaggio, dal progetto (task aperte e in ritardo visibili a me) e dall'indicazione; servito in streaming col meccanismo esistente di `data/stream.ts`. Non invia mai.
- [ ] Tests: Review Focus 4 (annulla entro 5 s; cambio di persona durante la finestra: l'invio resta della persona che l'ha fatto e non appare all'altra se non destinataria); fallito → «Riprova»; bozza salvata e ritrovata; `suggestRecipients` non rivela indirizzi di messaggi invisibili; la bozza di Claude non cita task di progetti invisibili.
- [ ] Commit `feat(desktop): scrivere dalla posta`.

### Task 5: Calendario — modello, seme e livello dati

**Files:** Modify `data/model.ts`, `data/store.ts`, `data/queries.ts`, `data/api.ts`, `data/api-mutations.ts`; Create `data/seed/calendar/*.ts`, `data/calendar/{visibility.ts,reads.ts,writes.ts,index.ts}` (+`data/calendar/calendar.test.ts`).

**Interfaces — Produces (`model.ts`):**
```ts
export type Rsvp = "accepted" | "declined" | "tentative" | "needsAction";
export interface CalendarAttendee { email: string; name: string; personId: string | null; response: Rsvp; organizer: boolean }
export interface CalendarEvent { id: string; calendarPersonIds: string[]; title: string; description: string | null;
  startsAt: string; endsAt: string; allDay: boolean; location: string | null; meetUrl: string | null;
  attendees: CalendarAttendee[]; reminders: { minutes: number; method: "popup" | "email" }[] | "default";
  seriesId: string | null; projectId: string | null; projectBy: "model" | "manual" | null;
  save?: { state: "saving" | "saved" | "failed"; error?: string } }
export interface CalendarSeries { id: string; title: string; rule: string; projectId: string | null; enabled: boolean;
  action: "milestone" | "request" | "remind"; leadDays: number; auto: boolean }
```
- `canSeeEvent(me, e)`: `me` in `calendarPersonIds` o fra gli `attendees`. Gli altri: inesistente.
- Reads: `listEvents({ from, to })` (dentro la finestra), `getEvent(id)` → anche `myResponse`, `isOrganizer`, transcript e prep (Task 6), `listSeries()`, `freeBusy(personIds, from, to)` (occupato/libero, mai titoli), `listUpcomingEvents()` (da `now()` a fine di domani, per la Home).
- Writes: `createEvent(input)` (con `addMeet`; partecipanti persone o indirizzi), `updateEvent(id, patch, scope: "one" | "series")`, `moveEvent(id, startsAt, endsAt, scope)`, `deleteEvent(id, scope)` — solo organizzatore, altrimenti `forbidden`; `respond(id, rsvp, note?)`; `setEventProject(id, projectId | null)` (`projectBy: "manual"`; solo progetti in cui sono membro); `configureSeries(id, patch)` (progetto obbligatorio prima di `enabled` → `choose_project_first`); `syncCalendar()`. Le scritture passano per `save.state: "saving"` → `saved`; il seme ha un evento che fallisce al salvataggio.
- Proposte di calendario: un evento futuro con titolo da scadenza/consegna nel seme produce una `MailProposal` `source: "calendar"` con `createMilestone`; eventi passati o rifiutati mai.
- Seme: giornata di oggi piena per Giulia (tre riunioni di progetto, una personale, un invito `needsAction`, un tutto-il-giorno, 12 eventi sovrapposti in un giorno della settimana prossima), una serie spenta e una accesa, riunioni passate di AUD con trascrizione (Task 1), un evento a cavallo della mezzanotte, una serie con occorrenze oltre la finestra.
- [ ] Tests: Review Focus 3 con `TZ=America/Los_Angeles` (riusando `eventDayKey`, `timedEventsForDay`, `allDayEventsForDay` di `@stubwise/shared/calendar-grid`); non organizzatore → `forbidden` su modifica, ok su `respond`; `scope: "series"` sposta tutte le occorrenze, `"one"` una; `freeBusy` non espone titoli; evento passato/rifiutato senza proposta; serie spenta di default; `choose_project_first`; `listUpcomingEvents` si ferma a fine di domani.
- [ ] Commit `feat(desktop): dati del Calendario`.

### Task 6: Riunioni registrate e scheda di preparazione — dati

**Files:** Create `data/mail/transcripts.ts`, `data/calendar/prep.ts` (+test); Modify `data/queries.ts`.

**Interfaces — Produces:**
- `canSeeTranscript(me, t)`: `me` è partecipante (`attendees[].personId`) dell'evento `t.eventId`. Transcript senza evento: solo i destinatari del messaggio.
- `getMeetingSummary(eventId)` → `{ summary, transcript }` per chi può, altrimenti `null`; `tasksBornFrom(eventId)` → task e richieste create dalle proposte di quella trascrizione, filtrate da `canSeeTask`.
- `getMeetingPrep(eventId)` → `null` se l'evento non ha progetto o non sono membro; altrimenti `{ recentMail: ThreadRow[] /* max 5, solo visibili a me, del progetto */, recentMeetings: { eventId, title, at, summary: string | null, tasks: { code, title, status: "open" | "done" | "late" }[] }[] /* max 3 */, status: { inProgress, late, stalled, nextDueDates, milestones } }`. Lo stato riusa le funzioni della panoramica (`domain/stalled.ts`, le letture di `pages/overview/*` tramite `queries.ts`), senza ricalcoli paralleli.
- [ ] Tests: Review Focus 1 (prep: le email sono solo le mie, nessuna di un collega); riassunto `null` per un membro non partecipante, con le task nate visibili; transcript `unreachable` → riassunto assente e stato esposto; evento senza progetto → `null`; non membro → `null`.
- [ ] Commit `feat(desktop): riunioni registrate e scheda di preparazione`.

### Task 7: Posta — pagina

**Files:** Create `pages/mail/{MailPage.tsx,MailboxBar.tsx,ThreadList.tsx,ThreadRow.tsx,ReadingPane.tsx,MessageView.tsx,UntrustedHtmlFrame.tsx,MailProposalCard.tsx,OutsiderPrompt.tsx,SyncStatus.tsx,mailFilters.ts}` (+test); Modify `router.tsx` (`pageOf("mail")` e `/mail/$threadId`), `data/routes.ts` (parametri `mailbox`, `importance`, `project`, `q`), i18n en/it.

Tre colonne come da shape `mail.md`: caselle con stato di allineamento e «Aggiorna ora»/«Ricollega»; elenco per conversazione (importanza, progetto, scadenza, «N aperte», «in analisi»); lettura (contesto, testo citato, allegati, originale in `UntrustedHtmlFrame` con «Mostra immagini», «Apri in Gmail» → avviso, conservazione 90 giorni, «Riproponi»). Proposte accanto al messaggio: «Mostra cosa ha letto Stubwise» (estratto), azioni modificabili, conferma parziale, «Passa al progetto», «Ignora», esito deciso da altri con nome e link, `OutsiderPrompt`. Trascrizione: riassunto e «Apri la trascrizione» per i partecipanti. Senza account Google: stato «Collega il tuo account Google» che apre la scheda account dell'area 5.
- [ ] Tests: Review Focus 2 (cambio di persona con conferma aperta la chiude; esito altrui) e 5 (oggetto lunghissimo, 60 messaggi, 40 destinatari compressi, HTML con `<script>` non eseguito e immagini bloccate fino al clic); filtri nell'URL; conferma con e senza permesso; stato vecchio dopo 5 min; analisi fallita → «Riproponi».
- [ ] Commit `feat(desktop): pagina della Posta`.

### Task 8: Posta — scrittura

**Files:** Create `pages/mail/{Composer.tsx,RecipientField.tsx,ClaudeDraftButton.tsx,UndoSendToast.tsx}` (+test); Modify `pages/mail/ReadingPane.tsx`, `pages/mail/MailPage.tsx` («Nuova email», ⌘N di pagina), i18n.

Compositore da shape `mail-compose.md`: rispondi / rispondi a tutti / inoltra nel pannello di lettura, nuova email in un pannello; destinatari con completamento (`suggestRecipients`), cc, oggetto, corpo, allegati dal disco (finti) e dal Drive; «Chiedi a Claude» con indicazione facoltativa e streaming nel campo, interrompibile; bozza salvata a ogni modifica; «Invia» → toast con «Annulla» per 5 s; inviata/fallita nella conversazione con «Riprova».
- [ ] Tests: Review Focus 4 (annulla; fallita con testo intatto; cambio di persona durante l'annulla); la bozza di Claude non parte da sola; bozza ritrovata riaprendo la conversazione; allegato del Drive solo fra i file visibili.
- [ ] Commit `feat(desktop): scrivere email`.

### Task 9: Calendario — pagina e azioni

**Files:** Create `pages/calendar/{CalendarPage.tsx,CalendarToolbar.tsx,MiniMonth.tsx,CalendarGrid.tsx,EventDetail.tsx,EventEditor.tsx,RsvpBar.tsx,SeriesSidebar.tsx,SeriesSettings.tsx,SeriesScopeDialog.tsx,calendarParams.ts}` (+test); Modify `router.tsx` (`pageOf("calendar")`, `/calendar?view&date&event`), `data/routes.ts`, i18n.

Da shape `calendar.md`: giorno/settimana (predefinita)/mese con le funzioni di `@stubwise/shared/calendar-grid`, Oggi/precedente/successivo fermi ai bordi della finestra, mini-mese, filtro per casella con colore, stato di allineamento; dettaglio (ora o «tutto il giorno», partecipanti con risposta, descrizione isolata, luogo, Meet, promemoria, ricorrenza, progetto con correzione, «Apri in Google Calendar» → avviso, rifiutato segnato); risposta Sì/Forse/No con nota; nuova riunione e modifica (`EventEditor`, disponibilità da `freeBusy`, «Aggiungi Google Meet»); trascinamento e ridimensionamento per l'organizzatore, con tastiera equivalente; `SeriesScopeDialog` «Solo questo / Tutta la serie»; serie con configurazione; salvataggio in corso/fallito con «Riprova».
- [ ] Tests: Review Focus 3 (`TZ` negativo: tutto il giorno e mezzanotte nella cella giusta; bordi della finestra) e 5 (12 eventi sovrapposti leggibili); non organizzatore senza trascinamento né modifica; nuova riunione appare con `saving` → `saved`; parametri nell'URL.
- [ ] Commit `feat(desktop): pagina del Calendario`.

### Task 10: Scheda di preparazione — UI

**Files:** Create `pages/calendar/{MeetingPrep.tsx,MeetingSummary.tsx}` (+test); Modify `pages/calendar/EventDetail.tsx`, i18n.

Da shape `meeting-prep.md`: dentro il dettaglio di un evento con progetto (e dal blocco Home), tre sezioni — ultime email (link alla conversazione), ultime riunioni (riassunto per i partecipanti, segnato come testo generato; per gli altri solo le cose da fare), stato del progetto (riusa i componenti di `pages/overview/*` dove esistono: `StalledSection`, milestone, task in ritardo). Non membro o senza progetto: solo i dettagli dell'evento. Trascrizione non raggiungibile: lo dice.
- [ ] Tests: partecipante vede il riassunto, membro non partecipante no ma vede le task; cambio di persona con la scheda aperta; stati caricamento/errore/vuoto per sezione.
- [ ] Commit `feat(desktop): scheda di preparazione alle riunioni`.

### Task 11: Home, «Da decidere», ⌘K e Claude

**Files:** Create `pages/home/blocks/{ImportantMailBlock.tsx,UpcomingEventsBlock.tsx}` (+test); Modify `pages/home/blocks/{registry.ts,DecideBlock.tsx}`, `data/seed/homes.ts` (blocchi di default nelle Home nuove), `palette/CommandPalette.tsx` (gruppo **Posta** con `searchMail`, azioni «Nuova email», «Nuova riunione»), `domain/claude/intents/*` (domande su posta e riunioni rispettano `canSeeMessage`/`canSeeTranscript`), i18n.

Blocchi da shape `meeting-prep.md`/`home.md`: «Email importanti» (mittente, oggetto, progetto, scadenza; vuoto «Niente di importante»), «Prossimi appuntamenti» (ora, titolo, progetto, segno di scheda disponibile; clic → evento con scheda). «Da decidere» mostra le `MailProposal` aperte con conferma sul posto (riusa `MailProposalCard`). ⌘K: gruppo Posta dopo File, prima di Canali/Messaggi; le righe di ripiego restano in «Altro».
- [ ] Tests: Review Focus 1 (⌘K, «Da decidere» e Claude per admin e collega non destinatario non mostrano nulla); blocchi nel catalogo per tutti; Home nuova li contiene; email aperta esce dal blocco; proposta decisa da un altro sparisce da «Da decidere» di tutti.
- [ ] Commit `feat(desktop): posta e calendario nella Home e in ⌘K`.

### Task 12: Parità, screenshot, follow-up

`apps/desktop/docs/area6-parity.md`: ogni voce «Mail & Calendar» dell'inventario e della card `google.proposal`/`google.proposal_handed` → dove vive e il test; le voci tolte per scelta (regole della posta, «Admitted mail») con la decisione; le novità senza parità. `capture.mjs`: scatti `a6-*` (Posta con proposta condivisa, trascrizione con riassunto, compositore con bozza di Claude, Calendario settimana, nuova riunione, scheda di preparazione, blocchi Home) light/dark, en/it a 1440 e uno a 1024; vite ucciso. «Area 6 — minori aperti» in `ossatura-follow-ups.md`, con la nota che il lavoro sul server (classificazione di tutta la posta, lettura dei Google Doc, scope di invio e scrittura calendario, invarianti da riscrivere in `docs/invariants/mail-calendar.md`) è un progetto a parte. Suite, typecheck, lint, build verdi. Commit `docs(desktop): parità dell'area 6`.

Dopo il Task 12: revisione finale del branch (area 6) e revisione visiva di Impeccable.
