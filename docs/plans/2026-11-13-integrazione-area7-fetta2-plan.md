# Area 7, fetta 2 — email e attese

> BOZZA di stubwise-94 (13 nov 2026), su richiesta di stubwise-46, presa da
> stubwise-72 il 13 nov 2026 con le «Correzioni di 72» (prima dei task del
> server, che le seguono dove divergono), nella forma del piano della F1 (`2026-11-12-integrazione-area7-fetta1-plan.md`,
> con le «Correzioni di 72»). I task del SERVER sono scritti come interfacce
> e test: l'implementazione e le scelte interne restano a 72. I task del
> RENDERER sono dettagliati. Design:
> `docs/plans/2026-11-12-integrazione-area7-design.md` (§ Fette, § Il motore
> nel worker, § La ricorrenza mensile, Review Focus F2). Inventario:
> `docs/plans/2026-11-12-integrazione-area7-inventario.md` (§2.2–2.5, §3 la
> riga «Passo manda email» e «Inizio email in arrivo»). Specifica: il design
> del prototipo `docs/plans/2026-10-26-desktop-area7-automations-design.md`,
> la mappa `apps/desktop/docs/area7-notes.md` (R-J2, R-J13, R-J15, R-J16), le
> shape `apps/desktop/.impeccable/shape/{automations,automation-builder,automation-test}.md`.
> Dalla Posta: `docs/invariants/mail-calendar.md` e il mittente
> `apps/worker/src/google/mail-sender.ts` (area 6, F3). Branch proposti:
> `feat/area7-f2` (server, 72) e `feat/area7-f2-renderer` (94), sopra la F1.

## Cosa cambia

Dopo la F1 le automazioni di progetto creano task, traguardi, richieste e
avvisi. Dopo questa fetta, come nel prototipo:

- il passo **manda email**, dalla casella del proprietario scelta
  all'accensione, con l'approvazione per passo (Q4 = b: chi crea sceglie se
  parte da sola o va approvata; chi approva può correggere A, Oggetto e
  Corpo prima dell'invio);
- le **attese**: un tempo (giorni), la **risposta** a un'email del flusso
  (nella stessa conversazione, col massimo di giorni) e una **task del
  flusso chiusa** (col massimo);
- il ciclo **«ripeti finché»** (al massimo 10 giri, uscita «limite»);
- gli **inizi a orario**: ogni giorno, ogni settimana (giorni scelti), ogni
  mese (un giorno del mese, Q13), nel fuso Europe/Rome;
- l'inizio **«email in arrivo»**, solo dalle caselle del proprietario;
- la prova senza effetti con email e attese (anteprima dell'email, «Avanti»
  sulle attese), sempre nel client (P1 = a della F1).

Restano alle fette dopo: i passi di Claude (F3); le automazioni generali,
la tabella cliente → progetto, le sorgenti e il webhook in arrivo, «avvia
un'altra automazione» (F4). Gli allegati di un'email vengono da campi file,
che nella F2 nessun passo produce: vedi la domanda F2-5.

## Decisioni già prese

Dal design e dalla F1. Qui solo quelle che toccano la F2:

- **Q4 = b** *(M)*: come il prototipo, l'email di un passo parte da sola o
  va approvata, a scelta di chi crea. Restano il tetto di 20 email per
  esecuzione, contato sulla catena, e la casella del proprietario.
- **D2** *(M)*: nessun limite in più per le email che partono da sole
  (niente tetto giornaliero). La difesa contro un'automazione impazzita
  resta quella della F1: l'idempotenza e la profondità della catena (3).
- **Q13 = a** *(O)*: la ricorrenza mensile si porta e scatta
  (`MONTHLY;BYMONTHDAY=n`; un giorno che il mese non ha cade all'ultimo).
- **Q3 = a** *(O)*: l'email non è una scrittura locale. La sua chiave
  d'idempotenza è l'invio trattenuto della Posta (`mail_outgoing`), creato
  nella transazione del cursore; il mittente della Posta lo manda.
- **F1, C6**: l'esecutore e il consumatore stanno nel worker, con la lease;
  le attese sono esecuzioni `waiting_event` con `due_at` (il massimo), che
  il poller del motore riprende alla scadenza.
- **R-J13, R-J16**: l'evento di un'email lo vede solo il proprietario, lungo
  la catena; il testo della risposta del cliente lo vede solo il
  proprietario.
- **`mailbox_owner`** (`docs/invariants/mail-calendar.md`): nessuna
  automazione legge la posta di un altro, e gli admin non fanno eccezione.

## Perimetro della F2

| Dentro | Fuori (fetta) |
|---|---|
| Passo `sendEmail` (A, Oggetto, Corpo coi campi; casella del proprietario; auto o «chiede a» con le correzioni) | Allegati da campi file (F3/F4, domanda F2-5) |
| `wait` per tempo, per risposta (`replyTo`, `maxDays`), per task chiusa (`taskClosed`, `maxDays`) | — |
| `repeatUntil` (≤ 10, `onLimit`) | — |
| Inizi `schedule` (DAILY, WEEKLY con BYDAY, MONTHLY con BYMONTHDAY; BYHOUR) | — |
| Inizio `stubwise:mail_received` (solo le caselle del proprietario) | — |
| La casella scelta all'accensione (`mailbox`), e i suoi controlli | — |
| La prova con email e attese, nel client | La prova con Claude vero (F3) |
| — | `claude` (F3); `startAutomation`, `source`, generali, «dal cliente» (F4) |

Nella build app la disponibilità diventa `AUTOMATION_F2_AVAILABILITY` (F1
più `sendEmail`, `wait`, `repeatUntil`, `schedule`,
`stubwise:mail_received`), nel motore condiviso: server e app non divergono.

## Il modello dei dati (aggiunte alla F1)

- `automations.mailbox_account_id` uuid null → `google_accounts`, la
  casella scelta all'accensione (R-J15: vale per il proprietario di adesso;
  chi accende con un'altra casella la cambia). `ON DELETE SET NULL`: una
  casella scollegata lascia l'automazione senza casella (sotto, «La casella
  persa»).
- `automation_effects`: il `kind` `email`, con `mail_outgoing_id`; la chiave
  resta `<run_id>:<path>:<round>` UNIQUE.
- `mail_outgoing`: la colonna `automation_run_id` uuid null (chi l'ha
  chiesta: una persona con Invia, o un'esecuzione), più quanto serve perché
  il mittente la mandi senza una bozza scritta da una persona (domanda per
  72, C-F2-1 sotto).
- `automation_schedule_fires`: `(automation_id, local_date)` UNIQUE, una
  riga per inizio a orario scattato. È la chiave d'idempotenza
  dell'orario: un tick ripetuto, due worker o un riavvio non fanno partire
  due volte la stessa automazione lo stesso giorno.
- `automation_runs.waiting_for` (o dentro `pending`, a scelta di 72): cosa
  aspetta un `wait` — la conversazione (`gmail_thread_id` dell'email
  partita) o il codice della task — perché il consumatore svegli SOLO le
  attese giuste con un indice, senza leggere ogni esecuzione in attesa.

## L'email di un passo

- **Dal piano all'invio.** L'esecutore fa il piano dell'email
  (`planEmail`, spostato in `@stubwise/shared` come i piani della F1:
  destinatario, oggetto, corpo coi campi, casella, «stessa conversazione»).
  Poi, NELLA transazione del cursore, scrive `mail_outgoing` (`queued`,
  `send_at` = adesso, `automation_run_id`) e l'effetto con la sua chiave.
  Il mittente della Posta la manda come ogni altra. Una ripresa che trova
  la chiave non scrive una seconda email.
- **Il risultato.** Il passo resta `running` finché la riga non è `sent`
  (allora `ok`, e il registro ha il `gmail_message_id`) o `failed` (allora
  il passo fallisce col codice del mittente: `token_expired`,
  `google_scope_missing`, `quota`, `invalid_message`, `interrupted`). Il
  mittente non ritenta MAI da solo, e il motore nemmeno: «Riprova» del
  passo è un gesto, come in F1. Un `interrupted` (il worker è morto a metà
  invio) è un fallimento: non si sa se Gmail l'abbia mandata, e rimandarla
  rischierebbe due email.
- **La stessa conversazione.** Le email allo stesso indirizzo nella stessa
  esecuzione stanno in UNA conversazione, quella aperta dalla prima (come
  `threadFor` del prototipo): la seconda risponde nel thread della prima.
- **Il tetto**: 20 email per esecuzione, contate sulla catena intera
  (`AUTOMATION_LIMITS.emailsPerRun`). Oltre il tetto il passo esce con
  `limit`, come nel prototipo.
- **La casella persa.** Accendere o pubblicare vuole una casella del
  NUOVO proprietario, collegata, non scaduta, con lo scope d'invio dell'area
  6 (`ownerChecks`, come nel prototipo). A metà di un'esecuzione, una casella
  scaduta, scollegata o senza scope fa fallire il passo (`mailbox_lost`,
  riprovabile) e mette l'automazione in pausa, come D5 per il permesso perso
  (domanda F2-4).
- **L'eccezione all'invariante del mittente.** Oggi
  `mail-sender.ts` dice che il worker manda un'email SOLO perché una persona
  ha premuto Invia. Con Q4 = b un'automazione accesa da una persona manda
  email da sola: il consenso è l'accensione (la casella scelta lì) più
  l'approvazione del passo, se c'è. Va scritta come eccezione dichiarata,
  accanto a quella dei passi di Claude (Q8), in
  `docs/invariants/automations.md` e nel docblock del mittente: **una riga
  di `mail_outgoing` nasce da Invia di una persona O da un passo di
  un'automazione accesa da lei, dalla sua casella; nessun altro percorso
  automatico ne scrive**. Test: l'elenco chiuso degli scrittori di
  `mail_outgoing` (la rotta di Invia e l'esecutore del motore), come
  `vault-isolation.test.ts`.

## Le attese

- **Un tempo** (`days`): l'esecuzione va in `waiting_event` con `due_at`; il
  poller del motore la riprende alla scadenza e manda l'input `time`.
- **La risposta a un'email del flusso** (`replyTo`, `maxDays`): quando il
  poller Google ingerisce un messaggio nella STESSA conversazione
  (`gmail_thread_id` dell'email partita da quel passo), nella casella da cui
  è partita, e il mittente NON è il proprietario, sveglia l'attesa con
  `risposta.arrivata = true` e `risposta.testo` (R-J2); il testo lo vede
  solo il proprietario (R-J16). Alla scadenza senza risposta:
  `risposta.arrivata = false`. Mai un messaggio di un'altra conversazione,
  né di un'altra casella.
- **Una task del flusso chiusa** (`taskClosed`, `maxDays`): l'evento
  `task_closed` della F1 sveglia l'attesa se la task è un effetto di quel
  passo nella stessa esecuzione.
- **Pausa**: un'esecuzione in attesa si sospende subito (F1). Una risposta
  arrivata durante la pausa non si perde: la riprende chi riaccende
  (domanda F2-6).

## Gli inizi a orario

- Un tick del poller del motore (ogni minuto) valuta le automazioni
  `active` con inizio `schedule`: la regola cade OGGI nel fuso Europe/Rome
  (`FREQ=DAILY`, `WEEKLY;BYDAY=…`, `MONTHLY;BYMONTHDAY=n`, con l'ultimo
  giorno del mese se il mese non ha quel giorno) e l'ora `BYHOUR` è
  raggiunta. Allora inserisce `automation_schedule_fires(automation_id,
  local_date)` e, nella stessa transazione, crea l'esecuzione. Il vincolo
  UNIQUE è ciò che fa scattare una volta sola.
- Un'automazione accesa DOPO l'ora di oggi scatta oggi, se è ancora oggi
  (come il prototipo: «non è ancora partita oggi»). Un worker spento per un
  giorno intero non recupera i giorni persi.
- Il calcolo della regola sta in `@stubwise/shared` (`scheduleDue` del
  prototipo, esteso al MENSILE e al fuso), con i test su un fuso negativo e
  sul cambio dell'ora legale, così server e prototipo non divergono.

## L'inizio «email in arrivo»

- Il poller Google, dopo l'ingestione di un messaggio, pubblica
  `mail_received` per le SOLE automazioni attive il cui proprietario
  possiede quella casella (`mailbox_owner`). Payload: `email.mittente`,
  `email.oggetto`, `email.testo` (i campi di `triggerFields.ts`). L'evento
  lo vede solo il proprietario, lungo la catena (R-J13).
- Quali messaggi: TUTTI quelli ricevuti dalla casella, ammessi o no
  (F2-1 = tutte *(M)*, vedi C-F2-0). Il filtro dell'inizio fa il resto.
- Il punto di pubblicazione: il poller Google, prima del cancello
  dell'ammissione (C-F2-0). Un trigger su `email_messages` perderebbe i
  messaggi rifiutati, che lì non entrano.

## La prova (nel client, come la F1)

- `planEmail` passa in `@stubwise/shared` (dal `data/automations/plans.ts`
  del prototipo, che lo ri-esporta). La prova mostra l'email che partirebbe
  («From», «To», oggetto, corpo, la stessa conversazione), mai un invio. Il
  `SimulationContext` della F1 aggiunge la casella che il proprietario
  avrebbe (`mailbox: { accountId, email } | null`).
- Le attese nella prova si sbloccano con «Avanti» (input `time`) e, per la
  risposta, con la risposta scritta da chi prova (input `event`), come nel
  prototipo. Nessuna lettura della posta vera.
- Un inizio a orario o «email in arrivo» si prova sugli esempi di
  `GET …/examples`: per l'orario la data di oggi, per la posta gli ultimi
  messaggi della casella del proprietario, solo se chi prova È il
  proprietario (R-J13); altrimenti nessun esempio, e l'evento si scrive a
  mano.

## Le rotte (aggiunte alla F1)

| Rotta | Cosa |
|---|---|
| `POST /api/automations/:code/activate` · `/publish` | il corpo aggiunge `mailboxAccountId` (obbligatorio se il flusso manda email; deve essere una casella di chi chiama); 409 `mailbox_required`, `mailbox_expired`, `mailbox_scope` |
| `GET /api/automations/:code/examples` | per `mail_received` gli ultimi messaggi della casella del proprietario, solo se chi chiama è il proprietario; `context.mailbox` |
| `POST …/runs/:n/approve` | `edited` ammesso su `to`, `subject`, `body` di un'email (`checkEdited`) |
| `GET /api/me/google/accounts` (c'è già, area 6) | le caselle fra cui scegliere all'accensione |

Nessuna rotta nuova per le attese: sono stati di un'esecuzione
(`waiting_event`, con `waiting.until` e cosa aspetta), già nella forma di
`AutomationRunDetail`.

## Correzioni da chiedere a 72 (prima dei task del server)

**C-F2-1. La bozza Gmail di un'email d'automazione.** `mail_outgoing` vuole
`gmail_draft_id` NOT NULL: oggi la bozza la scrive la rotta della persona.
Per un'esecuzione serve un passo in più. Due strade, a scelta di 72:
(a) l'esecutore scrive la riga `queued` senza bozza (colonna nullable, o
uno stato `composing`) e il mittente crea la bozza e la manda; (b)
l'esecutore crea la bozza FUORI dalla transazione, poi nella transazione
scrive riga ed effetto, e una ripresa che trova una bozza orfana la
riusa o la cancella. La (a) tiene la chiave d'idempotenza nella sola
transazione del cursore, e la consiglio.

**C-F2-2. L'invio senza i 10 secondi.** Il trattenimento di 10 s esiste
perché chi preme Invia possa annullare. Per un'automazione non c'è nessuno
che annulla: `send_at` = adesso (domanda F2-2).

## Correzioni di 72 (13 nov 2026)

Dove divergono dal resto del piano, i task del server seguono queste.

**C-F2-0. F2-1 = TUTTE le email *(M)*.** L'inizio «email in arrivo»
scatta per OGNI messaggio RICEVUTO nella casella dell'automazione: ammesso,
rifiutato dal cancello dell'ammissione (con `MAIL_CLASSIFY_V2` spenta),
messaggio di contesto, appunti di Gemini. Restano fuori solo i messaggi
MANDATI dalla casella stessa (`isFromMailbox`), che non sono posta in
arrivo. Vanno corretti tre punti del piano:
- «L'inizio email in arrivo», «Quali messaggi»: non più «quelli che il
  poller già ingerisce e ammette», ma tutti i ricevuti; il filtro
  dell'inizio fa il resto.
- **Il punto di pubblicazione NON è un trigger su `email_messages`**: un
  messaggio rifiutato dall'ammissione non ci entra mai (va in
  `email_rejections`), quindi un trigger lo perderebbe. Si pubblica dal
  poller Google, subito dopo la lettura dei metadati e il controllo
  `isFromMailbox`, PRIMA del cancello dell'ammissione. Il poller scrive
  `automation_events` (kind nuovo `mail_received`, valore di enum in uno
  statement a sé) SOLO se la casella ha almeno un'automazione `active` con
  quell'inizio e la casella scelta all'accensione: senza, non legge niente
  in più di oggi.
- Per un messaggio che il poller non scaricherebbe intero (rifiutato
  dall'ammissione) serve il `getMessageFull` per `email.testo`: è il costo
  accettato di (M), e c'è solo quando un'automazione lo chiede.

  Tre scelte interne che ne discendono:
- **Il payload è una fotografia**: `email.mittente`, `email.oggetto`,
  `email.testo` (tagliato a 20 000 caratteri), più `accountId`,
  `gmailMessageId` e `gmailThreadId` (che servono all'attesa della risposta
  e alla deduplica). L'evento non ha una riga `email_messages` da cui
  derivare i campi, perché un rifiutato non ce l'ha. Dopo che il
  consumatore l'ha trattato, il testo nell'evento si svuota: resta solo
  nell'esecuzione partita, che è il registro e lo vede solo il proprietario
  (R-J16). Così la potatura della posta non lascia copie orfane del testo.
- **La deduplica**: `automation_events.object_id` diventa nullable e si
  aggiunge `dedupe_key` UNIQUE (`mail:<accountId>:<gmailMessageId>`). La
  history riletta due volte non fa partire due esecuzioni.
- **R-J13 resta com'è**: il consumatore apre l'evento solo per le
  automazioni il cui proprietario possiede la casella, e un admin non fa
  eccezione (test negativo in S8).

**C-F2-5. Il botta e risposta *(M, 13 nov 2026)*.** Con TUTTE le email,
un'automazione «email in arrivo → manda email» e il risponditore
automatico (o il rimbalzo) di chi riceve si rimbalzerebbero all'infinito:
l'evento nasce dalla posta, senza origine, quindi la catena non lo vede, e
il tetto di 20 vale per esecuzione. Regola: **un messaggio ricevuto in una
conversazione in cui l'automazione stessa ha mandato un'email NON fa
partire quell'automazione**. Sveglia solo le sue attese su quella
conversazione (se ce ne sono); le ALTRE automazioni della casella partono
come sempre.
- «Conversazione dell'automazione» = esiste una riga `mail_outgoing` con
  `automation_run_id` di un'esecuzione di quell'automazione, la stessa
  casella e lo stesso `gmail_thread_id` del messaggio ricevuto. Non solo la
  conversazione APERTA da lei: anche una in cui ha risposto. Così il caso
  di un'automazione B che risponde in una conversazione aperta da A (o dal
  cliente) è fermato allo stesso modo: la seconda risposta del risponditore
  non fa ripartire B. *(Lettura di 72 della decisione: «aperta» da sola
  lascerebbe il giro aperto per B.)*
- La regola sta nel consumatore (non nel poller): l'evento si scrive
  comunque, e il consumatore lo scarta per quell'automazione con un indice
  su `mail_outgoing (account_id, gmail_thread_id) where automation_run_id
  is not null`. Le righe `failed` o `cancelled` contano lo stesso (un invio
  interrotto può essere partito).
- *Test* (in S8): un'automazione «email in arrivo → manda email»; il
  risponditore automatico del destinatario risponde nella conversazione →
  nessuna nuova esecuzione di quell'automazione, ma un'attesa della
  risposta della stessa esecuzione su quella conversazione si sveglia con
  `risposta.arrivata = true`; un'altra automazione della stessa casella
  parte; un messaggio in una conversazione SENZA email dell'automazione la
  fa partire (controllo che la regola non spenga tutto).

**C-F2-1. Niente bozza Gmail per un'email d'automazione.** Né la (a) né la
(b) della bozza, ma un invio diretto. `gmail.modify` (lo scope dell'area 6)
ammette `users.messages.send`, quindi la bozza è un giro in più che non
serve a nessuno: per la persona esiste perché la bozza è ciò che scrive e
corregge, per un'esecuzione no. Quindi:
- la migrazione rende `mail_outgoing.gmail_draft_id` nullable, con un CHECK:
  `gmail_draft_id is not null or automation_run_id is not null` (una riga
  di persona ha sempre la sua bozza);
- l'esecutore scrive, NELLA transazione del cursore, la riga `queued`
  (`user_id` = proprietario, `account_id` = casella dell'automazione,
  destinatari, oggetto, corpo, `automation_run_id`, e `gmail_thread_id` più
  `In-Reply-To`/`References` presi dalla prima email della stessa
  conversazione) più l'effetto con la sua chiave;
- il mittente, per una riga senza bozza, compone il MIME con
  `buildMimeMessage` (c'è già, in `gmail-compose.ts`) e lo manda con un
  `sendMessage` nuovo in `@stubwise/google` (`users.messages.send` col
  `threadId`). Claim, `sending` → `interrupted` al riavvio, nessun
  ritentativo: tutto invariato, è la stessa riga;
- **Riprova ed Elimina della Posta** (`retrySend`, l'annullamento in
  `apps/server/src/services/mail-send.ts`) rifiutano una riga con
  `automation_run_id` (409): un'email d'automazione la riprova solo
  «Riprova» del passo, altrimenti due strade potrebbero rimandarla. *Test*:
  Riprova della Posta su una riga d'automazione fallita → 409 e nessuna
  riga `queued`.
- Nessuna firma aggiunta: il corpo è quello del passo, corretto da chi
  approva se c'è l'approvazione.

**C-F2-2. `send_at` = adesso.** D'accordo col piano, ed è F2-2: la riga
nasce già dovuta, e la Posta non offre «Annulla» su una riga
d'automazione (vedi sopra). Chi vuole fermare un'email mette il passo
«chiede a».

**C-F2-3. L'eccezione all'invariante del mittente, riscritta con C-F2-1.**
«Una riga di `mail_outgoing` nasce da Invia di una persona (con la sua
bozza) O da un passo di un'automazione accesa da lei, dalla sua casella
(senza bozza, con `automation_run_id`); nessun altro percorso automatico
ne scrive.» L'elenco chiuso degli scrittori (S9) parte da quelli di oggi:
`apps/server/src/services/mail-send.ts`, `apps/server/src/routes/me-mail*.ts`
(da verificare quali scrivono e quali leggono), il mittente e il poller
(che aggiornano lo stato), più l'esecutore del motore.

**C-F2-4. `waiting_for` in colonne, non dentro `pending`.** Due colonne
nullable su `automation_runs`: `waiting_thread` (`<accountId>:<gmailThreadId>`)
e `waiting_ticket_id`, ognuna con un indice parziale `where status =
'waiting_event'`. Il poller Google e il consumatore svegliano per indice;
`due_at` c'è già, ma il suo indice parziale oggi è solo `where status =
'running'`: si allarga a `waiting_event`. Il valore `waiting_event` non c'è
nell'enum `automation_run_status` della 0169: si aggiunge in uno statement a
sé, e nello stesso batch nessun indice parziale né default lo nomina (gli
indici che lo usano vanno in `runMigrations`, dopo il batch, o con un
confronto sul testo: `status::text = 'waiting_event'`).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La migrazione** (la prossima libera): `automations.mailbox_account_id`,
   `mail_outgoing.automation_run_id` (+ C-F2-1), `automation_effects.kind`
   `email`, `automation_schedule_fires`, l'indice delle attese. I valori
   nuovi di enum in statement a sé e mai usati nello stesso batch.
   *Test*: la migrazione su un DB con i dati della F1.

S2. **Accendere con la casella**: `ownerChecks` aggiunge la casella del
   nuovo proprietario (sua, collegata, non scaduta, con lo scope d'invio).
   *Test*: con la casella di un altro → 403/409, MAI salvata; senza scope →
   `mailbox_scope`; un flusso senza email non la chiede.

S3. **L'esecutore dell'email**: `planEmail` dal motore condiviso;
   `mail_outgoing` + effetto nella transazione del cursore; il passo
   aspetta `sent`/`failed`. *Test*: una ripresa dopo il commit non scrive
   una seconda riga (la chiave); `failed` → passo fallito col codice, nessun
   ritentativo; `interrupted` → fallito; la seconda email allo stesso
   indirizzo nella stessa conversazione; la 21ª email della catena →
   `limit`; un'email «chiede a» non scrive `mail_outgoing` prima di Approva,
   nemmeno dopo un riavvio; Approva con `edited` manda il testo corretto,
   con il prima e il dopo nel registro.

S4. **La casella persa a metà**: `mailbox_lost` + la pausa (secondo F2-4).
   *Test*: casella scollegata fra due passi → il passo dell'email fallisce,
   l'automazione va in pausa, `automation.paused` a chi gestisce.

S5. **Le attese**: `wait` per tempo (`due_at`), per risposta (il poller
   Google sveglia per conversazione e casella), per task chiusa (il
   consumatore della F1). *Test*: una risposta in un'ALTRA conversazione
   non sveglia; una risposta del proprietario stesso non sveglia; una
   risposta da un'altra casella non sveglia; alla scadenza
   `risposta.arrivata = false`; R-J16 (il testo solo al proprietario nelle
   letture dell'esecuzione).

S6. **«Ripeti finché»**: già nel motore condiviso; il worker lo esegue con
   la lease. *Test*: 10 giri e l'uscita `onLimit`; una ripresa a metà giro
   non rifà l'effetto del giro (la chiave col `round`).

S7. **Gli inizi a orario**: il tick, `automation_schedule_fires`, la regola
   condivisa. *Test*: due tick nello stesso minuto → una esecuzione; il 31
   in un mese di 30 giorni → il 30; un fuso negativo e il cambio dell'ora
   legale; un'automazione in pausa non scatta, e riaccesa non recupera.

S8. **L'inizio «email in arrivo»**: dal poller Google, solo le caselle del
   proprietario. *Test* NEGATIVI: un messaggio nella casella di un altro non
   fa partire l'automazione, anche se il proprietario è admin; l'evento non
   compare nelle letture di chi non è il proprietario (R-J13). Il botta e
   risposta di C-F2-5. Un messaggio rifiutato dall'ammissione fa partire
   l'automazione (F2-1 = tutte), uno MANDATO dalla casella no.

S9. **L'elenco chiuso degli scrittori di `mail_outgoing`** e l'eccezione
   all'invariante (`docs/invariants/automations.md`, docblock del
   mittente). *Test*: un file nuovo che scrive `mail_outgoing` fa fallire
   il test.

S10. **Il client** (`client.automations`): `activate`/`publish` con
   `mailboxAccountId`; le forme nuove additive in shared (`mailbox` su
   `Automation`, `context.mailbox`, `waiting` dell'email), ognuna
   facoltativa, con un test che parsa una risposta senza.

## Task del RENDERER (94)

R1. **La disponibilità della F2**: `AUTOMATION_F2_AVAILABILITY` nel motore
   condiviso; `automationAvailability()` nella build app passa alla F2.
   *File*: `packages/shared/src/automations/availability.ts`,
   `data/integration.ts`. *Test*: `BuilderF1.test.tsx` diventa
   `BuilderPerimeter.test.tsx`: `sendEmail`, `wait`, `repeatUntil`,
   `schedule`, `mail_received` si scelgono; `claude`, `startAutomation`,
   `source` restano «Coming soon».

R2. **`planEmail` in shared** (come `plans.ts` della F1), con la parte
   pura di «stessa conversazione»; il prototipo lo ri-esporta. *Test*: i
   test del prototipo restano verdi senza cambiare; un test del piano senza
   lo store.

R3. **Accendere e pubblicare con la casella**: il dialogo del prototipo
   (`AutomationDialogs.tsx`) sulle caselle vere (`GET /api/me/google/accounts`),
   con i rifiuti `mailbox_required`/`mailbox_expired`/`mailbox_scope` detti
   nel dialogo. *File*: `data/backend/real/automations.ts` (`activate`,
   `publish` con `mailboxAccountId`). *Test*: il corpo esatto; senza
   caselle, il dialogo lo dice e non accende.

R4. **Le esecuzioni con email e attese**: `RunDetail.tsx` mostra l'email
   partita (o in invio), l'attesa con la sua scadenza, la risposta (il
   testo solo al proprietario: lo decide il server, il client legge);
   «Pass time» e «Simulate reply» restano solo prototipo. L'approvazione di
   un'email con «Edit» (A, Oggetto, Corpo) manda `edited`. *Test*: la
   pagina fino alla richiesta esatta; un'esecuzione con la risposta letta
   da chi non è il proprietario non ha il testo.

R5. **La prova con email e attese**: il mondo della prova (`contextWorld`)
   aggiunge `outside.previewEmail` sopra `planEmail` condiviso e la casella
   del contesto; «Avanti» e la risposta scritta come nel prototipo. *Test*:
   una prova con un'email e un'attesa della risposta arriva in fondo e
   chiama solo GET e `/tested`; senza casella del proprietario la prova si
   ferma col problema dell'accensione.

R6. **Gli inizi a orario e «email in arrivo» nel costruttore**: già nel
   prototipo; nella build app si scelgono. La ricorrenza mensile del
   costruttore ora scatta anche nel prototipo (`scheduleDue` condiviso).
   *Test*: il prototipo fa scattare la mensile (il buco dell'inventario
   §2.6).

R7. **Parità** (`apps/desktop/docs/integration-area7-f2.md`) e registro.

## Global Constraints

- Le tre regole dell'anti-obiettivo valgono come nella F1: un'approvazione
  blocca davvero, anche un'email; tutto tracciato (l'email nel registro col
  suo id).
- Un'email parte SOLO dalla casella del proprietario, scelta all'accensione;
  nessuna automazione legge o scrive la posta di un altro (`mailbox_owner`),
  admin compresi.
- Nessun effetto senza la sua chiave d'idempotenza nella transazione del
  cursore; un'email non parte due volte, nemmeno dopo un riavvio.
- Il mittente e il motore non ritentano mai da soli un invio fallito.
- Gli inizi a orario scattano una volta per giorno, per vincolo UNIQUE, non
  per convenzione.
- Verso i client solo campi additivi con default; test filtrati; mutazioni
  sui controlli della casella e sull'idempotenza dell'email.

## Review Focus

- **Un'automazione impazzita** (D2): un evento che si autoalimenta (una task
  creata che fa ripartire la stessa automazione, che manda un'email) si
  ferma alla catena; migliaia di eventi in ingresso non producono MAI due
  volte la stessa email e non superano 20 email per esecuzione.
- Un'email «chiede a» non parte prima dell'Approva, nemmeno dopo un
  riavvio, e nemmeno se chi approvava ha perso il ruolo nel frattempo.
- L'attesa della risposta si sveglia SOLO nella stessa conversazione, dalla
  stessa casella, da un mittente che non è il proprietario.
- Un'automazione non legge mai la posta di un altro: né l'inizio «email in
  arrivo», né l'attesa, né gli esempi della prova (test negativi).
- La mensile scatta una volta, nel fuso giusto, anche a fine mese e al
  cambio dell'ora legale.
- La casella persa a metà non manda niente da un'altra casella.

## Domande per il maintainer

Ognuna con la consigliata per prima.

F2-1. **Quali email fanno partire «email in arrivo»?** DECISA *(M)*:
   TUTTE quelle ricevute dalla casella, anche non ammesse (C-F2-0), TRANNE
   le risposte in una conversazione dell'automazione stessa (C-F2-5,
   risposta del maintainer *(M)* alla domanda di 72, 13 nov 2026).

F2-2. **L'email di un'automazione ha i 10 secondi per annullare?**
   (a) No, parte subito: non c'è nessuno a guardare; chi vuole fermarla
   mette il passo «chiede a». *(consigliata)*
   (b) Sì, 10 secondi anche qui, con «Annulla» nella Posta del proprietario.

F2-3. **Un rimbalzo (indirizzo inesistente)?**
   (a) Il passo è `ok` quando Gmail l'ha mandata; il rimbalzo arriva nella
   Posta del proprietario come ogni altro, e il registro non lo sa.
   Rimandato al registro. *(consigliata: Gmail non lo dice all'invio)*
   (b) Il poller riconosce il rimbalzo nella stessa conversazione e fa
   fallire il passo dopo (`address_not_found`, come il prototipo).

F2-4. **La casella del proprietario scade o si scollega a metà?**
   (a) Il passo dell'email fallisce (`mailbox_lost`, riprovabile) e
   l'automazione va in pausa con l'avviso, come D5. *(consigliata)*
   (b) Solo il passo fallisce; l'automazione resta accesa e continua a
   fallire a ogni esecuzione.

F2-5. **Gli allegati di un'email** (da campi file)?
   (a) Fuori dalla F2: nessun passo della F2 produce un file; tornano con
   la F3 (i campi di Claude) o la F4 (le sorgenti). Un flusso con allegati
   ha `not_available`. *(consigliata)*
   (b) Dentro, dai file del Drive del progetto scelti nel passo (una
   funzione che il prototipo non ha).

F2-6. **Una risposta del cliente arrivata mentre l'automazione è in
   pausa?**
   (a) Si tiene: l'attesa sospesa la trova alla riaccensione. *(consigliata:
   la risposta è un fatto, non un evento d'inizio)*
   (b) Si perde, come gli eventi d'inizio in pausa (prototipo).

## Rimandi (dal registro, area 7)

- La paginazione col cursore degli elenchi (`/api/automation-runs` e gli
  altri della F1): l'adattatore della build app legge oggi la prima pagina.
  Da completare quando un elenco reale supera la pagina.
- I rimbalzi, se F2-3 = a.
- Gli allegati, se F2-5 = a.
