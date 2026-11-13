# Area 6, fetta 5 — riunioni registrate e Google Drive

> BOZZA di 94, 12 nov 2026, su richiesta di 46; presa da 72 il 12 nov 2026,
> con le correzioni nella sezione «Correzioni di 72» (prima dei task del
> server, che le seguono dove divergono). I task del SERVER sono interfacce e test
> (l'implementazione e le scelte interne restano a 72); quelli del RENDERER
> sono dettagliati. Design: `docs/plans/2026-11-12-integrazione-area6-design.md`
> (§ Fette, F5; D1, D9; i vincoli «sempre»). Inventario: il messaggio di 94 a
> 72 con le forme della F5 e il registro, area 6 (note della F5) e area 5 (i
> riferimenti a Google Drive). Branch proposti: `feat/area6-f5` (server, 72)
> e `feat/area6-f5-renderer` (94), sopra `feat/integrazione-area6`.

## Cosa cambia

Oggi il server non sa niente delle riunioni registrate né di Google Drive:
nessun riconoscimento dell'email di Gemini, nessun client Drive o Docs,
nessun riassunto, nessuna scheda di preparazione, e `drive_files.source`
ammette solo `upload`. Dopo questa fetta, come nel prototipo:

- l'**email di Gemini** è riconosciuta e collegata alla sua riunione;
- il **Google Doc** degli appunti si legge con l'account di chi l'ha
  ricevuta, e ne nasce un **riassunto** (narrativa generata) e le
  **proposte** della riunione;
- riassunto e proposte li vedono **tutti gli invitati** di Stubwise
  (decisione *(M)*, sotto);
- **«Task da questa riunione»** nel dettaglio di una riunione passata;
- la **scheda di preparazione** completa sulle riunioni future;
- i **riferimenti a Google Drive** nel Drive dei progetti (il rimando
  dell'area 5): aggiungi da Google Drive, le cartelle collegate, Togli e
  Nascondi, i file non disponibili; e gli allegati della Posta come LINK;
- il **cassetto Google** coi testi del Drive (il rimando della F1).

## Decisioni già prese

- **D9 = a** (design, righe 121-125 e 194-197): lo scope **`drive.readonly`**
  — il «permesso di lettura Drive» del maintainer —, che legge il Doc di
  Gemini E chiude i riferimenti a Google Drive dell'area 5. Non
  `documents.readonly` (l'opzione b, scartata). È già in
  `googleOauthScopes` (D1: un solo riconsenso); è ristretto (la verifica di
  Google serve solo con un client External); alla callback NON è
  obbligatorio, quindi le rotte che leggono il Drive rispondono
  `google_scope_missing` con `missing`, e il cassetto lo dice.
- **La visibilità di riassunto e proposte** *(M, 12 nov 2026)*: le vedono
  TUTTI GLI INVITATI che sono persone di Stubwise, con qualunque risposta
  (anche declined, R-I15), anche senza l'evento nel loro calendario, come
  nel prototipo; senza un evento collegato, chi ha ricevuto l'email di
  Gemini. **Mai** un membro del progetto che non c'era, **mai** un admin.
  È un'eccezione dichiarata a «Posta e Calendario restano PERSONALI» (testo
  d'invariante sotto).
- **«Task da questa riunione»** solo ai MEMBRI del progetto dell'evento
  (R-I21): un partecipante non membro ha il riassunto ma non le task.
- **Trascrizioni e file Google sono contenuto NON fidato** (design, vincoli
  «sempre»): al modello fra delimitatori, come dati, senza strumenti; le
  rotte che un tool di Claude legge entrano in `CHAT_TOOL_UNTRUSTED_ROUTES`,
  e contano per «almeno B».
- **Il riassunto è NARRATIVA generata**: un'operazione AI nuova col suo
  `UsageTag`, mai nel registro decisioni (la regola di
  `decisions-never-ai.test.ts`).
- **Nessuna scrittura verso Google** in questa fetta (si legge soltanto).
- **Una trascrizione non Gemini** è fuori (design, Perimetro).

### Le risposte alle domande (12 nov 2026)

- **Q1 = a** *(M)*: un invitato che non ha ricevuto l'email di Gemini vede E
  decide le proposte della riunione, se ha i permessi nel progetto; la prima
  decisione chiude per tutti.
- **Q2 = a** *(M)*: `docUrl` a ogni invitato che vede il riassunto; i
  permessi del Doc li applica Google.
- **Q3 = a** *(M)*: le cartelle Google le collega chi ha `drive.manage` nel
  progetto.
- **La scheda di preparazione si compone nel CLIENT** *(O, 46)*: niente
  `/prep` sul server. Le letture (il polso, la mia posta del progetto, le
  task, le ferme, i traguardi, e `/summary` e `/tasks` delle riunioni
  passate) vanno in PARALLELO, con al più 3 riunioni passate; sono tutte rotte
  già filtrate dal server, quindi nessuna allarga cosa vede chi guarda.

## Le forme per il renderer (dall'inventario di 94, tutte additive)

**L'email di Gemini sul messaggio della conversazione**
(`MailMessageView` del prototipo): `kind: "email" | "transcript"` (default
`"email"`) e `meeting: MeetingNote | null` (default `null`), con

```
MeetingNote = {
  docTitle: string | null,          // null a chi non c'era
  doc: "reading" | "ready" | "unreachable" | null,
  visible: boolean,                 // può vedere riassunto e trascrizione
  summary: string | null,
  docUrl: string | null,            // «Open the transcript» apre Google Docs
  event: { id, title, startsAt, endsAt, people: number } | null  // solo se legge l'evento
}
```

**Il riassunto di una riunione**: `GET /api/me/calendar/events/:id/summary`
→ `MeetingSummary { eventId, docTitle, doc, summary, docUrl, email: {
threadId, messageId, at } | null }` (`email` solo se chi guarda vede l'email
di Gemini); **404** a chi non è invitato (come un evento che non esiste). La
trascrizione INTERA non va al client: il prototipo mostra il riassunto e un
link al Doc.

**Le proposte di una riunione** nella lista della Posta
(`/api/me/mail/proposals`, come quelle del calendario della F3b): `kind:
"meeting"` e `meetingOrigin: { eventId | null, threadId, title, at } | null`
(il campo a parte, come `calendarOrigin`). Destinatari: gli invitati
di Stubwise (la decisione M sulla visibilità e Q1: anche chi non ha ricevuto
l'email, se ha i permessi nel progetto; la prima decisione chiude per tutti);
un'email inoltrata a chi non era invitato non basta (R-I24); a chi la
vede solo perché «passata al progetto», `excerpt: ""`. Nel registro
decisioni una riga da template («Decided from the notes of a meeting.»),
mai l'estratto. Le task nate contano per «almeno B» (`source: email` o
`meeting`).

**«Task da questa riunione»**: `GET /api/me/calendar/events/:id/tasks` →
`{ tasks: MeetingTask[], proposedTasks: number } | null` (null: l'evento non
ha progetto o chi guarda non ne è membro), con

```
MeetingTask = { kind: "task" | "request", id, code, title,
  status: "open" | "done" | "late", inProgress: boolean,
  dueDate: string | null, departmentId: string | null }
```

I `results` delle proposte di quella riunione già confermate, per
`decidedAt`, senza doppi; una richiesta convertita mostra le sue task;
`proposedTasks` = le createTask delle proposte ancora aperte o passate che
chi guarda vede.

**La scheda di preparazione**: `hasPrep: boolean` (default `false`) su ogni
riga di `range` (vero se l'evento è futuro, ha un progetto e chi guarda ne è
membro). La scheda (`MeetingPrep { eventId, projectId, pulse, recentMail,
recentMeetings, status }`) la compone il CLIENT *(O, 46)*, in parallelo, da
letture che esistono già; per le riunioni passate servono `/summary` e
`/tasks`:
- `pulse`: il polso del progetto (come `/api/projects/pulse`);
- `recentMail`: le righe di conversazione di CHI GUARDA su quel progetto
  (max 5; mai la posta di un collega);
- `recentMeetings: RecentMeeting[]` (max 3, dalla più recente, l'evento
  corrente escluso), `RecentMeeting = { eventId, title, at, summary | null,
  doc | null, canOpen, tasks: MeetingTask[], proposedTasks }` (`summary` e
  `doc` null per chi non c'era);
- `status: { inProgress, late, stalled (come /api/tasks/stalled),
  nextDueDates (max 3), milestones (max 2) }`.
404 su un evento che non legge.

**I riferimenti a Google Drive nel Drive dei progetti** (il rimando
dell'area 5, `driveFileRowSchema.source` accetta già `google`):
- su `drive_files`: `source: "google"`, `googleFileId`, `googleOwner`,
  `folderLinkId`, `hidden`, `unavailable: null | "deleted" | "access_lost"`,
  `sizeBytes` null per i Doc nativi; `storage_key` diventa nullable;
- un codice per ogni riferimento: lo stesso file Google in un altro progetto
  è un riferimento nuovo, con un codice nuovo;
- le cartelle collegate: `{ id, projectId, googleFolderId, name, linkedBy,
  status: "ok" | "expired" }`, lette con l'account di CHI L'HA COLLEGATA;
- le rotte (sotto `/api/projects/:projectId/drive` e `/api/drive`):
  `GET /google/files?q=` (il picker, il mio Drive), `GET /google/outside?q=`
  (la ricerca fuori dai progetti, solo il mio account), `POST /google/files`
  `{ googleFileId }` (`drive.upload`; 409 `already_in_project`),
  `POST /google/folders` `{ googleFolderId }` e `DELETE /google/folders/:id`
  e `POST /google/folders/:id/sync` (`drive.manage`),
  `DELETE /files/:id` per un riferimento («Togli»: chi l'ha aggiunto o
  `drive.manage`; un file di cartella risponde `use_hide`),
  `PUT /files/:id/hidden` `{ hidden }` (`drive.manage`), l'apertura
  `via: "google"` che conta in `drive_opens`;
- il contenuto (testo, riassunto, ricerca) con le regole della fetta 3 del
  Drive: contenuto NON fidato.

**Gli allegati della Posta come LINK** (rimando della F3): un file del Drive
con `source: "google"` va in una bozza come `as: "link"`; non conta nei 10
né nei 25 MB; all'invio è un link nel corpo, non un allegato MIME.

**Errori**: 409 `google_scope_missing` con `missing` (senza
`drive.readonly`), 409 `account_disabled` / `token_expired`, 502
`google_unavailable`, 404 `not_found` (anche per chi non può vedere), 409
`already_in_project`, 409 `use_hide`, 403 `forbidden` (il permesso del
Drive).

## Correzioni di 72 (12 nov 2026)

Dall'inventario del codice (le righe citate sono di `feat/area6-f4-fix`).

**C0. Due fette, non una** *(O, da confermare con 46)*. La F5 così è due
lavori che non si toccano: le **riunioni registrate** (task 1–5, più il
link al Doc) e i **riferimenti a Google Drive** (task 6–7). Propongo
**F5a** = riunioni (branch `feat/area6-f5`) e **F5b** = Drive Google e
allegati come link (branch `feat/area6-f5b`, sopra F5a), ognuna con la sua
review e la sua voce di deploy-log: la F5b cambia `drive_files`
(`storage_key` nullable, il CHECK di `source`) e ogni lettore del file
(download, anteprima, contenuto, `drive_opens`), cioè l'area 5, mentre la
F5a vive in Posta e Calendario. I due rami del renderer seguono la stessa
divisione.

**C1. Riconoscere l'email di Gemini senza fidarsi del mittente.** `From:
gemini-notes@google.com` si falsifica; il worker la riconosce solo se (a)
il mittente è quello, (b) l'intestazione `Authentication-Results` di Gmail
dice `dkim=pass` con `header.d=google.com` (richiesta fra le intestazioni
dei metadati, oggi `DEFAULT_METADATA_HEADERS`), (c) il corpo ha un link a
`https://docs.google.com/document/d/<fileId>`. Fail-closed: in dubbio è
un'email normale. Il riconoscimento scrive `email_messages.kind =
'transcript'` (colonna nuova, default `'email'`) e il `fileId` del Doc.
⚠️ **La classificazione nuova la SALTA** (`classify-v2.ts`: oggi ogni
email ammessa va al modello): altrimenti la stessa email produrrebbe le
proposte di un'email E quelle della riunione.

**C2. Una tabella per la riunione registrata**, non campi sull'email:
`meeting_notes` (migrazione **0165**, il primo numero libero su tutti i
branch remoti al 12 nov 2026): `id`, `doc_file_id` (unico: un Doc, una
riunione, anche se l'email arriva a più caselle), `rfc_message_id`,
`source_message_id` (la PRIMA copia vista, la cui casella legge il Doc),
`ical_uid` e `event_starts_at` (l'evento collegato, nullable), `doc_title`,
`doc_status` (`reading` | `ready` | `unreachable`), `doc_reason`
(`scope_missing` | `not_shared` | `deleted` | `too_long` | null),
`summary` (narrativa), `attendee_emails` (lo snapshot degli invitati al
collegamento, per quando nessuna riga dell'evento resta), `project_id`
(quello dell'evento, se c'è), `attempts`, `next_attempt_at`, i tempi. Il
testo del Doc NON si salva (resta su Google): serve solo al run.

**C3. Il collegamento email ↔ evento.** Oggi `calendar.ts` non legge gli
`attachments` dell'evento: si aggiungono alla normalizzazione e a
`calendar_events.attachments` (jsonb `{ fileId, title, mimeType }[]`,
stessa 0165). Regola: (1) un evento, in una QUALUNQUE casella collegata,
con un allegato `fileId` uguale a quello del Doc (Gemini attacca gli
appunti all'evento); (2) altrimenti un evento della casella che ha
ricevuto l'email, con un link Meet, finito nelle 12 ore prima della
ricezione, il cui titolo è quello dell'oggetto dell'email (Gemini scrive
`Notes: “<titolo>”`, confronto normalizzato come il fingerprint); più di
un candidato = nessun collegamento (mai indovinare). Senza evento, la
visibilità è quella della decisione M (chi ha ricevuto l'email).

**C4. Chi vede: si deriva a lettura, in UN modulo.**
`services/meeting-visibility.ts` (server) e il suo gemello di sola lettura
per il worker in `packages/notifications` (come `project-signals.ts`, perché
il worker deve sapere a chi pubblicare): `meetingViewerIds(db, noteId)` =
le persone di Stubwise (`resolveRecipientUserIds`, agenti esclusi) fra gli
invitati ATTUALI dell'evento (l'unione degli `attendees` delle righe di
`calendar_events` con quell'`ical_uid`; se non ne resta nessuna, lo
snapshot `attendee_emails`) più l'organizzatore; senza evento, i
destinatari dell'email (le caselle che ne hanno una copia, come
`publish-shared.ts`). **Nessun ruolo nel calcolo**: un admin non c'è se non
è invitato. Un invitato TOLTO dall'evento smette di vedere (le righe si
aggiornano col poller) — il test negativo «ex invitato» di 46.

**C5. Le proposte della riunione riusano le proposte CONDIVISE della F2**,
non un tipo nuovo: righe di `email_proposals` con `audience =
'meeting_invitees'` (valore nuovo del CHECK, stessa 0165) e
`meeting_note_id`, pubblicate con `email_proposal_recipients` a ogni
invitato che vede il progetto (come `publishSharedProposals`). Così Q1 («la
prima decisione chiude per tutti») è il comportamento che le condivise hanno
già, e `/api/me/mail/proposals` le elenca dalla stessa query: `kind:
"meeting"` e `meetingOrigin` si DERIVANO a lettura da `meeting_note_id`.
`excerpt` a chi le vede solo perché passate resta `""` (regola esistente).

**C6. Un'operazione AI, un run.** `meeting_summary` (gruppo `mail`) fa
riassunto E proposte in un run solo, con lo stesso schema d'uscita della
classificazione nuova (`summary` + azioni per progetto, rivalidate da
`revalidateV2`): i candidati sono il progetto dell'evento se c'è,
altrimenti i progetti degli invitati (`loadCandidateProjects` sugli
invitati). Il testo del Doc va al modello fra delimitatori come dati, tagliato
a un tetto (oltre: `too_long`, riassunto della parte letta e lo dice), senza
strumenti. Migrazione dei due CHECK (`agent_runs`, `ai_model_settings`) come
la 0154. Modello predefinito: Sonnet. Il riassunto non va mai nel registro
decisioni (`meeting-notes.ts` entra nei `MODULES` di
`decisions-never-ai.test.ts`).

**C7. Dove gira**: una fase del giro della casella nel worker (dopo la
classificazione, prima di `publishSharedProposals`), con lo stato su
`meeting_notes` (`reading` → `ready` | `unreachable`, tentativi con
backoff, al più N per giro). Il Doc si legge col token della casella di
`source_message_id` e con `drive.readonly`; senza lo scope `unreachable` /
`scope_missing` (si riprova quando la casella riconsente). Nessuna
scrittura verso Google.

**C8. La forma `MeetingNote` sul messaggio** si deriva a lettura nella
rotta della conversazione (`me-mail.ts`), come le altre: `visible` dal
modulo C4, `docTitle`/`summary`/`docUrl` null quando `visible` è falso.
`docUrl` = `https://docs.google.com/document/d/<fileId>` (Q2: a ogni
invitato che vede il riassunto).

**C9. `hasPrep`** si calcola nello stesso passaggio di
`hideUnseenProjects` (`me-calendar.ts`): futuro, con un progetto, e chi
guarda lo vede.

**C10. `/events/:id/summary` e `/tasks`**: `:id` è una riga di
`calendar_events` di chi guarda **oppure** — per un invitato senza l'evento
nel suo calendario — la rotta per la riunione è `GET
/api/me/meetings/:noteId` (lo stesso `MeetingSummary`), raggiungibile dal
messaggio o dalla proposta. 404 a chi non è nel calcolo di C4.

**C11. Untrusted**: in `CHAT_TOOL_UNTRUSTED_ROUTES` le rotte del riassunto
(`/api/me/meetings/:noteId`, `/api/me/calendar/events/:id/summary`); quella
del contenuto di un file Google è della F5b.

## Task del SERVER (interfacce e test; l'implementazione è di 72)

1. **`@stubwise/google`, Drive e Docs.** `files.get` e `export` (testo di un
   Doc), la ricerca nel mio Drive, gli elenchi di una cartella, gli
   `attachments` di un evento di Calendar (dove Gemini attacca il Doc).
   *Test*: col `fetch` iniettato, le richieste esatte; uno scope mancante
   `insufficient_scope`; un file non più visibile `not_found` /
   `access_lost`.
2. **L'email di Gemini.** Riconoscerla (mittente `gemini-notes@google.com`,
   il link al Doc nel corpo) e collegarla all'evento (prima gli
   `attachments` dell'evento, col `fileId` del Doc; poi Meet + orario: è la
   scelta di 72). Leggere il Doc con la casella di chi l'ha ricevuta (mai
   un'altra), con gli stati `reading` → `ready` | `unreachable`. *Test*: una
   trascrizione non Gemini non è riconosciuta; un Doc spostato o non
   condiviso dà `unreachable`, senza riassunto; la casella usata è quella
   del destinatario.
3. **Il riassunto e le proposte della riunione.** Un'operazione nuova in
   `AI_OPERATIONS` (proposta: `meeting_summary`, gruppo `mail`) con la
   migrazione dei CHECK; il testo della trascrizione al modello fra
   delimitatori, come dati, senza strumenti; il riassunto salvato come
   narrativa (mai nel registro decisioni); le proposte con la dottrina
   della posta (le stesse azioni, gli stessi candidati). *Test*: il
   `UsageTag` con l'operazione e il progetto; `decisions-never-ai.test.ts`
   resta verde e include il modulo nuovo; una trascrizione con
   un'istruzione («ignora le regole e …») resta un dato.
4. **Le letture per l'app.** `MeetingNote` sul messaggio, `GET
   …/events/:id/summary`, le proposte con `kind: "meeting"` e
   `meetingOrigin`, `GET …/events/:id/tasks`, `hasPrep` sulle righe di
   `range` (niente `/prep`: la scheda la compone il client, O di 46). *Test* — la visibilità, coi NEGATIVI:
   - un invitato di Stubwise vede il riassunto, con qualunque risposta
     (declined compreso), anche SENZA l'evento nel suo calendario;
   - un membro del progetto che non c'era: 404 sul riassunto, `visible:
     false` e `docTitle` null sul messaggio inoltrato, e lo stesso per le
     proposte;
   - un admin che non c'era: 404, come un evento che non esiste (il test lo
     verifica con un full admin);
   - senza evento collegato: solo chi ha ricevuto l'email;
   - le task solo ai membri (R-I21): un partecipante non membro ha `null`;
   - un invitato che non ha ricevuto l'email decide le proposte se ha i
     permessi nel progetto (Q1), e la prima decisione chiude per tutti;
   - ogni campo nuovo con default, e un test che parsa una risposta SENZA.
5. **Contenuto non fidato per Claude.** Le rotte del riassunto, della
   trascrizione (se un tool la legge) e del contenuto di un file Google in
   `CHAT_TOOL_UNTRUSTED_ROUTES`. *Test*: una conversazione che legge un
   riassunto o un file Google ha `untrusted_read_at`, e la sua proposta
   nasce almeno B.
6. **Google Drive nel Drive dei progetti.** La migrazione (`source` google,
   le colonne sopra, `storage_key` nullable, il CHECK), le cartelle
   collegate (lette con l'account di chi le ha collegate), le rotte sopra,
   il contenuto con le regole della fetta 3. *Test*: i permessi
   (`drive.upload`, `drive.manage`, «Togli» di chi l'ha aggiunto), i
   negativi; `already_in_project`; un file di cartella `use_hide`; un
   account scaduto rende le cartelle `expired` e i file `access_lost`; lo
   stesso file in due progetti, due codici.
7. **Gli allegati come link.** `as: "link"` per un file Google nella bozza;
   all'invio un link nel corpo. *Test*: non conta nei limiti; il MIME non ha
   l'allegato.
8. **Chiusura**: invarianti (`mail-calendar.md`: l'eccezione sotto, il
   Doc letto col destinatario; `drive.md`: i riferimenti Google, «Save to
   Drive» resta una COPIA), deploy-log (le migrazioni, il kind se serve, il
   rollback), registro, `@stubwise/api-client` (i metodi nuovi).

## Task del RENDERER (94)

Su `feat/area6-f5-renderer`, TDD, `ComingSoon.test.tsx` nel giro (si
accendono `meeting-notes` e `google`), il server finto che risponde come
quello vero (con la modalità `legacy`).

1. **Il livello dati delle riunioni** (`data/backend/real/meetings.ts`):
   `getMeetingSummary`, `tasksBornFrom`, `getMeetingPrep`, il `meeting` dei
   messaggi (`data/backend/real/mail.ts`), `hasPrep` dalla riga
   (`calendarView.ts`, oggi sempre `false`). *Test*: ogni forma; 404 →
   `null` per il riassunto (chi non c'era non sa che esiste); `null` per le
   task a chi non è membro; i default per un server di prima.
2. **Le proposte di una riunione** (`mailProposalView.ts`): `kind:
   "meeting"` → `source: "transcript"` e `origin: { kind: "meeting", … }`
   del prototipo; `excerpt` vuoto per chi non c'era. *Test*: dal server finto,
   in «Da decidere»; una lista di prima (senza `kind`) resta della posta.
3. **Le pagine delle riunioni**: `featureIntegrated("meeting-notes")`
   acceso; il blocco «Recorded meeting» nel messaggio
   (`pages/mail/MessageView.tsx`, «Open the transcript» apre `docUrl` dal
   main/browser), il riassunto e «Task da questa riunione» nel dettaglio di
   una riunione passata (`pages/calendar/MeetingSummary.tsx`), la scheda di
   preparazione (`MeetingPrep.tsx`) e il segno sul blocco (`hasPrep`).
   *Test* (`calendarPage.test.tsx`, `mailCompose.test.tsx`): un invitato
   vede riassunto e task; chi non c'era legge la frase «solo per chi c'era»
   e nient'altro; un partecipante non membro ha il riassunto ma non le task;
   `unreachable` lo dice; la scheda ha le tre sezioni coi loro stati.
4. **Google Drive nel Drive dei progetti**: `featureIntegrated("google")`
   acceso; il livello dati (`data/backend/real/drive.ts`: `addGoogleFile`,
   `listGoogleFiles`, `listGoogleOutside`, `linkFolder`, `unlinkFolder`,
   `syncFolder`, `removeGoogleFile`, `setHidden`, l'apertura `via:
   "google"`), le pagine già del prototipo (`AddFromGoogleDialog`,
   `LinkFolderDialog`, `WhichProjectDialog`, `DriveBanners`,
   `GoogleAccountCard`). *Test*: ogni gesto fino alla richiesta esatta; i
   permessi (senza `drive.manage` niente cartelle né Nascondi); un file non
   disponibile non si apre e dice perché.
5. **Il cassetto Google col Drive** (il rimando della F1): i testi del
   prototipo (intro, scaduto, scollegare con le cartelle che smettono di
   aggiornarsi), più account; senza `drive.readonly` la funzione «drive» fra
   quelle che mancano. *Test*: `GoogleAccountCard.app.test.tsx`.
6. **Gli allegati come link** (`ComposeAttachments.tsx`, «Google link»;
   `mailDrafts.ts`): un file Google nella bozza come `as: "link"`, fuori dai
   limiti. *Test*: `mailDrafts.test.ts`, `mailCompose.test.tsx`.
7. **Parità** (`apps/desktop/docs/integration-area6-f5.md`) e registro.

## L'eccezione alla privacy di Posta e Calendario (decisione *(M)*)

Da aggiungere a `docs/invariants/mail-calendar.md`:

> **Il riassunto e le proposte di una riunione registrata li vedono TUTTI
> GLI INVITATI — l'unica eccezione a «Posta e Calendario restano
> PERSONALI»** *(maintainer, 12 nov 2026)*. Una persona di Stubwise invitata
> alla riunione (con qualunque risposta, anche declined) vede il riassunto
> del Doc di Gemini e le proposte nate dalla riunione, anche se l'evento non
> sta nel SUO calendario e anche se non ha ricevuto lei l'email di Gemini.
> Senza un evento collegato li vede chi ha ricevuto l'email. Il resto resta
> personale: la trascrizione intera non esce, il Doc si legge SOLO con la
> casella di chi l'ha ricevuto, l'email di Gemini resta di chi l'ha
> ricevuta. **Mai** un membro del progetto che non c'era, **mai** un admin
> (nessun ruolo scavalca l'invito). Verificato con test NEGATIVI: un membro
> che non c'era e un full admin ricevono 404 sul riassunto, `visible: false`
> sul messaggio, nessuna proposta; un invitato senza l'evento nel suo
> calendario lo vede.

## Global Constraints

- Nessuna scrittura verso Google; il Doc si legge con la casella di chi ha
  ricevuto l'email, mai con un'altra.
- La visibilità è l'eccezione dichiarata sopra, e nient'altro: nessun ruolo
  la scavalca; la trascrizione intera non va al client.
- Trascrizioni e file Google sono contenuto NON fidato (delimitatori, nessuno
  strumento, `CHAT_TOOL_UNTRUSTED_ROUTES`, «almeno B»).
- Il riassunto è narrativa: un'operazione AI col suo `UsageTag`, mai nel
  registro decisioni.
- «Save to Drive» resta una COPIA; un riferimento Google è un'altra cosa.
- Verso i client solo campi additivi con default; test filtrati;
  mutazioni sui controlli di visibilità.

## Review Focus

- Un membro che non c'era e un admin non vedono il riassunto né le
  proposte, in NESSUN percorso (la rotta, il messaggio inoltrato, la lista
  delle proposte, la scheda di preparazione di un'altra riunione, la
  ricerca).
- Il Doc letto con la casella giusta: mai con quella di un altro invitato
  che non ha ricevuto l'email.
- Una trascrizione con istruzioni dentro resta un dato (il riassunto non le
  esegue, le proposte seguono solo le azioni ammesse).
- Il riassunto non entra mai nel registro decisioni.
- Le cartelle collegate lette con l'account di chi le ha collegate: un
  account scaduto non lascia file «disponibili» per sbaglio.
- La scheda di preparazione: la posta è sempre di chi guarda.

## Domande per il maintainer (risposte: vedi «Le risposte alle domande»)

Q1. **Le proposte di una riunione a chi le vede ma non ha ricevuto l'email**
(un invitato che non era fra i destinatari dell'email di Gemini).
- (a) *(consigliata)* Le vede e le può decidere, con l'estratto: è un
  invitato, quindi la decisione del maintainer sulla visibilità vale anche
  per le proposte.
- (b) Le vede ma non le decide: decide solo chi ha ricevuto l'email.

Q2. **Il link al Doc di Gemini per gli invitati che non l'hanno ricevuto.**
- (a) *(consigliata)* Sì: `docUrl` a ogni invitato. Il Doc lo apre Google
  coi permessi di quella persona: se non le è condiviso, Google lo dice.
- (b) No: il link solo a chi ha ricevuto l'email.

Q3. **Le cartelle Google collegate a un progetto: chi le può collegare?**
- (a) *(consigliata)* Chi ha `drive.manage` nel progetto, come nel
  prototipo, con l'avviso «tutti nel progetto potranno leggere ogni file
  della cartella».
- (b) Solo un admin d'istanza.

## Rimandi

- La «Quale progetto?» del calendario e le proposte del calendario
  condivise fra gli invitati (F3b, registro).
- «Aggiungi da Google Drive» senza navigare le cartelle (R-H3 del
  prototipo, `ossatura-follow-ups.md`).
- Le trascrizioni non Gemini (fuori dal design).
