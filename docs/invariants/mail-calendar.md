# Invarianti e trappole — Posta e calendario (Google)

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

- **L'audience `mailbox_owner` non include MAI gli admin.** È un'audience a
  sé nell'enum di `routing.ts` (`packages/notifications/src/routing.ts`),
  non un caso speciale di `requester` (che invece gli admin li include
  sempre): `recipientsFor` per `mailbox_owner` restituisce **un solo**
  destinatario, `ctx.mailboxOwner`, risolto da chi pubblica
  (`PublishOpts.mailboxOwnerUserId`) — senza quel valore non c'è nessun
  destinatario, non un fallback sugli admin. È la stessa privacy-by-
  construction della fase 6: una proposta nata dalla casella di qualcuno la
  vede SOLO quel qualcuno. Verificato in
  `packages/notifications/src/routing.test.ts` (un caso con un admin E un
  follower presenti nel contesto, per essere sicuri che nessuno dei due
  compaia). Chi aggiunge un'audience nuova non la faccia ereditare da
  `requester` "per comodità": se deve escludere gli admin, è un caso a sé
  come questo. **Un evento `mailbox_owner` non esce mai dal perimetro del
  proprietario: inbox, DM Slack e push suoi; mai webhook d'istanza.**
  `shouldSendWebhook` (`packages/notifications/src/dispatch.ts`) ritorna
  sempre `false` per quell'audience, PRIMA di consultare qualunque toggle o
  configurazione del webhook: un canale Slack/Discord/generico condiviso
  leggerebbe `from`/`subject`/`question` della posta di un collega, che è
  esattamente ciò che l'audience esiste per impedire. Non è un caso limite
  scoperto dopo: il toggle `notifyGoogleProposal` che in origine governava
  anche questo canale è stato **rimosso** da UI, schema di risposta e body
  di `PUT /api/settings/notifications` (la colonna `notify_google_proposal`
  resta in DB, innocua, sempre `true` di default) proprio perché un toggle
  suggerirebbe che spegnerlo o accenderlo cambi qualcosa — mentre la
  risposta è sempre e comunque "mai". Chi tocca `shouldSendWebhook` o
  `publishNotification` non reintroduca un ramo che, per una audience
  `mailbox_owner`, arrivi a scrivere una riga `channel: "webhook"`.
- **Confermare una proposta chiede il permesso nel progetto; chi non ce l'ha
  la PASSA, e la card passata è una card NUOVA (fase permessi, 22 ott
  2026).** La classificazione considera tutti i progetti, quindi il
  proprietario può ricevere una proposta per un progetto in cui non può fare
  quella cosa. `answerGoogleProposal`
  (`apps/server/src/services/google-proposal.ts`) controlla, PRIMA del claim,
  il permesso dell'azione nel suo progetto (`permissionForProposalAction` in
  `packages/notifications/src/proposal-permissions.ts`, l'unica copia della
  mappa: voce → `backlog.edit`, milestone e aggiornamento ticket →
  `tickets.edit`, commento → `tickets.comment`, decisione →
  `decisions.record`); senza, `forbidden` e nulla si chiude. La card offre
  allora «Passa al progetto»: l'azione d'inbox `hand_to_project`, DERIVATA A
  LETTURA (`listInbox`) coi permessi ATTUALI del proprietario e
  ricontrollata all'esecuzione (`handGoogleProposal`), MAI scritta
  nell'evento (ruling R36). Chiude la card del proprietario e
  pubblica, nella stessa transazione, `google.proposal_handed` con audience
  `project_deciders` — chi nel progetto ha almeno uno dei permessi delle
  azioni, più i full admin, MAI il proprietario. Questo NON allarga
  `mailbox_owner`: la card del proprietario resta sua sola; quella passata è
  un'altra card, di progetto (filtrata a lettura per appartenenza, per
  questo `notificationVisibleToRecipient` esenta solo `google.proposal`, non
  `google.*`), e come la proposta d'origine non va MAI al webhook
  d'istanza. La riga `email_proposals` resta aperta finché un decisore non
  decide; l'esito si scrive con gli indici della card del proprietario
  (`sourceOptionIndices`) e lui lo legge in `decision`. Una proposta
  superata nel thread chiude anche le copie passate (`classify.ts`). Il
  calendario non si passa.
- **Passare al progetto: le regole di contorno e i limiti accettati (22 ott
  2026).** Quattro cose che il punto sopra non dice e che non si deducono:
  (1) **la mappa azione → permesso è quella della ROTTA corrispondente**, non
  `tickets.create` come diceva il design (ruling R35): nessuna azione di
  posta crea un ticket (`create_backlog_item` accoda un intake: il test «un
  decisore conferma» asserisce il job di intake, ruling R40), quindi chiedere
  `tickets.create` avrebbe dato il bottone a chi non può fare l'azione vera.
  (2) **Il calendario non si passa** (ruling R37): una proposta di calendario
  non ha la riga figlia su cui il decisore scriverebbe l'esito, quindi
  `hand_to_project` non le è offerta. Il proprietario senza permesso la
  ignora, o la sposta su un progetto che vede (`reassign_project`). Serve un
  design a sé, non un ramo in più in `handToProject`. (3) **«Non fare nulla»
  di un decisore chiude la proposta per tutti SOLO se avrebbe potuto
  confermare OGNI azione della card** (ruling R39, `answerGoogleProposal`):
  altrimenti chiude soltanto la propria copia, e la proposta resta aperta per
  gli altri decisori — un decisore con meno permessi non ha il veto su ciò che
  un altro deciderebbe. Una copia chiusa così non scrive l'esito sulla riga. (4) **Una proposta passata
  resta ORFANA se tutti i decisori archiviano la propria copia** senza
  decidere: la riga `email_proposals` resta aperta, il proprietario non ha
  più il bottone (l'ha già passata) e nessuno la vede. Limite accettato: si
  chiude da sola se il thread la supera. Le copie dei decisori, poi, non
  mostrano l'esito deciso da un altro decisore, e la chiusura per
  superamento non aggiorna i loro DM Slack (i bottoni rimasti non
  confermano più nulla: la proposta è chiusa).
- **La classificazione dei segnali email gira con la stessa dottrina
  dell'intake, non un'eccezione per la posta.**
  `apps/worker/src/google/classify.ts` chiama `runAgentText` con
  `permissionMode: "default"` (MAI `"plan"`, che è la modalità di
  esplorazione read-only e invita l'agente a guardare il filesystem del
  container), una directory temporanea VUOTA come cwd e nessun tool: il
  testo di un'email lo scrive chi vuole, compreso chi vuole male, e il run
  non deve avere niente da toccare né niente da leggere oltre al messaggio
  stesso. La difesa vera però non è il prompt: è la RIVALIDAZIONE nel
  codice di ogni referente che il modello nomina (`projectId` dev'essere fra
  i candidati del routing, `ticketNumber` fra i ticket aperti di quel
  progetto, `dueDate` nel futuro) — un'azione che perde un referente
  sparisce, e se non ne resta nessuna il messaggio diventa `ignored` senza
  proposta. Stessa forma di `apps/worker/src/backlog/prompts.ts` per
  l'intake: chi aggiunge un nuovo punto che manda testo non fidato al
  modello copi questa dottrina, non la reinventi.
- **Il modulo che scrive nel registro decisioni non importa MAI un esecutore
  AI — vale anche per `google-proposal.ts`.** La conferma di una proposta
  email o calendario registra una decisione con `source: "email"` e un testo
  da template i18n (`decision.email.*`), mai dall'output della
  classificazione: la classificazione ha già fatto il suo lavoro a monte
  (proporre), la decisione la prende la persona col tap, e il registro
  annota IL TAP, non il ragionamento del modello che l'ha preceduto. È la
  stessa regola della fase 5, estesa:
  `apps/server/src/services/decisions-never-ai.test.ts` include
  `google-proposal.ts` fra i moduli che non devono nominare alcun esecutore
  di agenti, sia a runtime (spie sull'SDK Anthropic a zero mentre il writer
  scrive davvero su un Postgres vero) sia sul sorgente.
- **Il poller Google non usa il serializer di progetto.**
  `apps/worker/src/google/poller.ts` è un poller PER-CASELLA, con un claim
  su `google_accounts.next_sync_at` e nessun lock né heartbeat di job:
  stessa famiglia di `rollupDevSummaries`
  (`apps/worker/src/notify/daily-report-poller.ts`), non quella dei fix o
  della generazione Docs, che invece serializzano per progetto perché
  toccano un worktree. I tre giri di un tick — sync Gmail, classificazione,
  sync Calendar — non prendono mai il lock di un progetto: un fix in corso
  su un progetto e la sincronizzazione di una casella che quel progetto la
  osserva nel routing procedono in parallelo senza contendersi nulla. Chi
  tocca `runAccountTick` non ci infili un accodamento per-progetto "per
  sicurezza": romperebbe l'indipendenza che il poller ha di proposito.
- **UNA PROPOSTA PER RICHIESTA, NON PER MESSAGGIO** («la posta si legge per
  conversazione», 14 set 2026). Di un thread si classifica **l'ULTIMO**
  messaggio ammesso, valutando la conversazione, non ognuno: le tre card che
  in produzione erano tre messaggi dello stesso scambio erano tre messaggi
  contati come tre richieste. I precedenti si chiudono `ignored` con un
  outcome che dice da cosa sono superati (`superseded_in_thread`), mai in
  silenzio e mai lasciati `new` — resterebbero a occupare uno slot del tetto
  per sempre.
  Quando il thread ha già una proposta APERTA, la classificazione la riceve
  e dice che rapporto ha il messaggio nuovo con essa: `integrates` e
  `replaces` chiudono la vecchia e ne lasciano UNA riscritta, `new_request`
  ne fa nascere una seconda. **Il default, quando il modello non lo dice, è
  `new_request`**: una card in più costa un tap, una chiusa per sbaglio costa
  un pezzo di lavoro che nessuno rivede. E la vecchia si chiude SOLO se dalle
  nuove è sopravvissuto qualcosa alla rivalidazione della fase 6, che questa
  aggiunta non scavalca — c'è un test su entrambe le cose
  (`apps/worker/src/google/classify.test.ts`).
- **Il cancello dell'ammissione si allarga col THREAD, e il limite che lo
  rende accettabile è `admitted`.** Quando l'ammissione (fase 6c) fa passare
  un messaggio, il poller tira dentro TUTTO il suo thread: i fratelli entrano
  con `email_messages.admitted = false`, cioè come CONTESTO. È una decisione
  del maintainer e fa entrare anche messaggi che il cancello della 6c
  avrebbe scartato — quello che la rende accettabile è che **`admitted =
  false` non diventa mai una card, in nessun percorso**: non viene
  classificato, non genera proposte, esiste per farsi leggere. Chi aggiunge
  un percorso che parte da `email_messages` verifichi quel campo, o riapre
  esattamente il buco che questo limite chiude.
  Non è un valore di `status` di proposito: lo stato è un PERCORSO (`new →
  classified → …`) che un messaggio di contesto non fa mai.
- **La potatura della posta è legata al THREAD, e va in due passi.** Un
  messaggio di contesto non ha figli `email_proposals` e resta `status =
  'new'` per sempre: sulle condizioni della fase 6b produce due errori
  OPPOSTI — le soddisfa banalmente (sarebbe il primo a sparire, lasciando una
  conversazione coi buchi) ma `status <> 'new'` lo escluderebbe sempre
  (non sparirebbe mai). `pruneOldEmails` pota quindi prima gli AMMESSI con le
  regole di sempre, poi il contesto dei thread in cui non è rimasto nessun
  ammesso — se un ammesso non era potabile è ancora lì e trattiene il suo
  contesto. Il confronto è su `(account_id, thread_id)`: due caselle possono
  avere lo stesso thread Gmail.
- **Confermare una proposta non chiude le sorelle.** Dalla fase 6b un
  messaggio email può avere PIÙ proposte aperte contemporaneamente, una per
  progetto del perimetro (`email_proposals`): il claim di conferma
  (`propagateHandled`, poi lo stato terminale) è per RIGA FIGLIA, non per
  messaggio. `markSourceOutcome`/`markSourceFailed`
  (`apps/server/src/services/google-proposal.ts`) scrivono lo stato, l'esito
  e l'errore SOLO sul figlio (`source.rowId` in `email_proposals`) e toccano
  il padre (`email_messages`) unicamente per `updated_at` (serve alla
  retention, vedi sopra) — mai `status`, mai `proposal_notification_id`, mai
  `outcome`/`error` del padre. Confermare, ignorare o far fallire una
  proposta non cambia lo stato di nessun'altra proposta sullo stesso
  messaggio: è la proprietà verificata da
  `apps/worker/src/google/proposal.test.ts` (due proposte dallo stesso
  messaggio pubblicate indipendentemente, notifiche distinte),
  `apps/server/src/services/google-proposal.test.ts` (confermarne una non
  tocca le altre) e `apps/worker/src/google/poller.test.ts` (un figlio ancora
  aperto blocca la retention dell'intero messaggio). ⚠️ Insidia per chi tocca
  questo codice in futuro: dalla classificazione in poi
  `email_messages.status`, `.proposal_notification_id`, `.outcome` ed
  `.error` sul padre **non sono più la fonte di verità per l'email** —
  restano scritti (e vanno letti) solo per il **calendario**, che è rimasto
  uno-a-uno e non ha un figlio, e per le righe **legacy pre-6b** senza una
  riga `email_proposals` equivalente. Chi ha bisogno dello stato di UNA
  proposta email guarda `email_proposals`, mai il padre; lo stato
  "aggregato" del messaggio (es. per la pagina Posta) si CALCOLA in lettura
  dai suoi figli, non si persiste da nessuna parte. ⚠️ **Aggiornamento dalla
  fase 6c**: questo paragrafo, scritto in 6b, non è più letteralmente
  esatto — la fase 6c aggiunge un TERZO caso, oltre al calendario e alle
  righe legacy pre-6b, in cui `email_messages.status`/
  `.proposal_notification_id`/`.outcome`/`.error` sul padre TORNANO a
  essere la fonte di verità: la proposta di **smistamento**
  (`source: "email_triage"`, vedi "Fase 6c" più sopra) vive SUL PADRE per
  costruzione — non ha figli — quindi per quel caso specifico è corretto
  che `markSourceOutcome`/`markSourceFailed` scrivano direttamente lì. Il
  principio resta valido per ogni riga CON figli (`email_proposals`); non
  vale più come regola assoluta per ogni riga di `email_messages`.
- **`choose_project` ha DUE semantiche diverse, sul padre e sui figli — mai
  unificarle.** Dalla fase 6c la stessa azione (`choose_project`, l'unione
  che il server e il worker si scambiano) si comporta in modo opposto a
  seconda di cosa `ProposalSource.source` vale
  (`apps/server/src/services/google-proposal.ts`, case `choose_project` in
  `dispatchAction`): su `"email_triage"` (il PADRE, la proposta di
  smistamento) è **viva** — attribuisce il messaggio e lo **rimette in
  coda** di classificazione (`status: "new"`, niente
  `markSourceOutcome`, il messaggio resta ATTIVO); su `"email"` (un FIGLIO,
  una proposta della fase 6b) resta **deprecata in generazione** e
  **chiude** il figlio con l'esito `reassigned_project`, comportamento
  storico invariato. Il motivo per cui `choose_project` non è mai stata
  rimossa dall'unione, solo deprecata in generazione per i figli in 6b, è
  esattamente questo: la 6c aveva già bisogno della stessa azione con
  un'altra semantica sul padre. Chi tocca questo case può condividere la
  validazione comune (il progetto scelto deve esistere ancora) ma **non**
  ne unifichi i due rami: sono percorsi indipendenti con effetti opposti
  (chiude vs. riapre), e un refactor "per non ripetersi" che li facesse
  convergere romperebbe uno dei due silenziosamente. Verificato leggendo il
  commento esplicito sopra quel case nel sorgente e i test
  `apps/server/src/services/google-proposal.test.ts` (entrambi i rami,
  con asserzioni opposte su `email_messages.status` ed `email_proposals`).
  ⚠️ **Dal 17 set 2026 le cose sono TRE, e la terza ha un nome diverso
  apposta.** `reassign_project` («Sposta su un altro progetto») fa una cosa
  che nessuno dei due rami di `choose_project` fa: chiude la proposta corrente
  **e CREA** la riga sul progetto scelto — il ramo `"email"` chiude e basta
  (non sposta `project_id`, non crea niente), il ramo `"email_triage"` non
  chiude affatto e rimette il PADRE in coda. Non è stata infilata dentro
  `choose_project` proprio per questa invariante: aggiungere una TERZA
  semantica a un nome che ne ha già due opposte è esattamente l'errore che il
  paragrafo qui sopra esiste per impedire, e il prossimo che legge quel case
  troverebbe tre rami senza un filo che li tenga. Un nome suo costa un valore
  in due enum minori — `inboxGoogleActionTypeSchema` e `storedActionSchema`,
  già gemelli per `acknowledge_reminder` — e in cambio ogni ramo resta
  leggibile da solo. Le tre non si toccano fra loro: `choose_project` non è
  stata modificata da quel commit, e i suoi test asseriscono ancora il
  comportamento storico.
- **Una serie ricorrente è spenta di default, e la sua azione automatica non
  avvia MAI lavoro.** È la lezione diretta dell'incidente del 9 settembre
  2026 (fase 7b, design §1): `calendar_series.enabled` nasce `false` — senza
  configurazione una serie è un gruppo di righe inerte in `calendar_events`,
  mai candidata da `isReadyForProposal` (`apps/worker/src/google/calendar.ts`).
  Il percorso `auto: true` (`apps/worker/src/google/calendar-auto.ts`,
  chiamato da `runProposePhase` subito DOPO la publish, mai prima) scrive
  DIRETTAMENTE la milestone o la voce di backlog — **mai** attraverso
  `enqueueBacklogIntake` del server, che per il backlog avvierebbe un job
  d'intake: è esattamente il tipo di lavoro che un'automazione ricorrente non
  deve poter far partire da sola, perché il suo costo si moltiplica per il
  numero di occorrenze. Verificato con un test esplicito
  (`apps/worker/src/google/poller.test.ts`, "il percorso auto non fa MAI
  partire un job AI") che conta le righe di `ai_jobs`/`backlog_jobs` dopo il
  percorso automatico per tutte e tre le azioni: deve restare zero. Chi
  aggiunge una quarta azione a una serie (`calendar_series.action`) faccia
  passare anche lei da `calendar-auto.ts`, non da un servizio del server.
- **Un appuntamento passato non diventa MAI una proposta (fase 9, fix di
  review).** `isReadyForProposal` (`apps/worker/src/google/calendar.ts`)
  richiede `startsAt >= now` per un evento SINGOLO esattamente come per
  un'occorrenza di serie — non solo quest'ultima, come prima del fix. Il
  motivo è la stessa lezione dell'incidente del 9 settembre da una porta
  nuova: prima della fase 9 il controllo era ridondante (la finestra di
  ingestione partiva da `now`, un evento passato non entrava mai), ma il
  Task 1 della fase 9 allarga la finestra a `now - 30gg`
  (`CALENDAR_LOOKBACK_DAYS`) — senza il controllo, ogni riunione di lavoro
  dell'ultimo mese sarebbe diventata una proposta di milestone con scadenza
  già passata, tutte insieme al primo tick. **Tre punti devono restare
  d'accordo**, verificato a fix fatto con un grep mirato dopo ogni modifica
  futura a questa regola: `isReadyForProposal` (il cancello vero), la query
  del propose phase in `apps/worker/src/google/poller.ts` (che lo replica in
  SQL — le due DEVONO dire la stessa cosa o il difetto torna dall'altra
  porta) e il conteggio `stats.ready` calcolato in fase di ingestione
  (stesso file, poco sotto: è ciò che il log espone come «N da proporre» e
  ciò che i test leggono come `calendarReady`). Un test esplicito fissa il
  caso che ha reso visibile il difetto: `apps/worker/src/google/
  calendar.test.ts`, "trenta riunioni di lavoro del mese scorso: zero
  proposte" — conta zero notifiche pubblicate.
- **Il corpo HTML di un'email: dove si conserva, e dove no.** ⚠️ Questa
  invariante diceva «non si conserva mai» (fase 9) ed è stata **riscritta,
  non cancellata**, dalla migrazione 0076 («la posta si legge per
  conversazione», 14 set 2026): il motivo che conteneva regge ancora, ed è
  il motivo per cui la cache sta dove sta.
  **Cosa è cambiato**: l'HTML originale si conserva in `email_bodies` — una
  tabella a sé, una riga per messaggio, `ON DELETE CASCADE` dal padre —
  perché ogni tap su «Mostra l'originale» ri-scaricava il messaggio da
  Gmail: si usciva dalla schermata, si rientrava, e lo ri-scaricava.
  **Si conserva GREZZO, e si sanifica a ogni lettura.** `sanitizeEmailHtml`
  (allowlist di tag/attributi, mai denylist — `packages/google/src/gmail.ts`)
  resta **nel percorso di RISPOSTA** di `GET
  /api/me/mail/:source/:id/original` (`apps/server/src/routes/me-mail.ts`) e
  gira su ogni lettura, da Google o da cache che sia. Chi è tentato di
  scrivere in colonna il sanificato «tanto è già pulito» faccia il conto
  dell'alternativa: ogni riga resterebbe congelata alla versione del filtro
  che l'ha scritta, e correggere il filtro richiederebbe una colonna di
  versione più un ri-scaricamento da Google per ogni riga. Col grezzo, una
  correzione vale retroattivamente su tutta la cache, senza migrazioni di
  dati. Il rischio dell'HTML non è stare in una colonna — lì è dato, non
  viene eseguito — è cosa esce verso il client.
  **Cosa NON è cambiato**: tutto il resto della difesa. L'HTML esce sempre
  sanificato, si rende in un `<iframe sandbox>`
  (`apps/web/src/components/mail-reading-pane.tsx`) **senza**
  `allow-scripts` né `allow-same-origin` — i due permessi che farebbero
  uscire il documento dal suo recinto — con le immagini remote neutralizzate
  di default (spostate in `data-src`, mai in `src`: sono il vettore classico
  dei pixel di tracciamento) finché chi legge non chiede di mostrarle.
  **E soprattutto**: la ragione per cui la cache è una TABELLA A SÉ dal nome
  esplicito e non una colonna accanto a `email_messages.text_excerpt`. Un
  corpo persistito lì sarebbe un'affermazione implicita «questo è ciò che
  Stubwise ha letto», e per l'HTML non è vero — nessun codice lo legge se non
  la persona che clicca. `text_excerpt` è ciò che la CLASSIFICAZIONE ha letto
  (il testo su cui il modello ha deciso); `email_bodies` è una copia per CHI
  LEGGE. I due non vanno sullo stesso piano, e la rilettura dell'originale
  non tocca `text_excerpt` — c'è un test che lo fissa
  (`apps/server/src/routes/me-mail.test.ts`).
  **Nessuna scadenza sulla cache, e non è una svista**: un messaggio Gmail è
  immutabile, una volta inviato non cambia più. L'unico modo in cui la copia
  può diventare falsa è che il messaggio sparisca da Gmail — e allora sparisce
  la riga padre, che si porta dietro questa col CASCADE. Per la stessa ragione
  la potatura di `email_messages` non va toccata per lei.
- **Un appuntamento che hai RIFIUTATO non diventa mai una proposta, e i punti
  d'accordo sono TRE — non quattro (15 set 2026, design §1).** Il dato
  (`attendees[].responseStatus`) c'era dalla fase 9 ed era pure mostrato, ma
  nessuna condizione lo consultava. Ora il cancello vive in
  `hasDeclinedInvitation` (`packages/shared/src/calendar-attendance.ts`),
  l'UNICO posto in cui «quali risposte bloccano» è scritto, ed è applicato
  nei tre punti che devono restare d'accordo — stessa forma dell'invariante
  sull'appuntamento passato qui sopra: `isReadyForProposal`
  (`apps/worker/src/google/calendar.ts`, dove `attendees` e `mailboxEmail`
  sono OBBLIGATORI nel tipo apposta: un cancello che si spegne quando un
  chiamante dimentica un campo non è un cancello), la query del propose phase
  che lo replica in SQL (`apps/worker/src/google/poller.ts`) e il conteggio
  `stats.ready` poco sopra.
  ⚠️ **SOLO `declined` blocca.** `tentative` e `needsAction` no, ed è una
  decisione presa guardando i dati veri del maintainer, non prudenza: alle
  riunioni di lavoro ricorrenti quasi nessuno risponde formalmente, e
  allargare toglierebbe di mezzo la maggior parte degli appuntamenti veri —
  un falso negativo che nessuno noterebbe, perché una proposta che non nasce
  non lascia traccia. Non essere fra i partecipanti (l'evento è tuo e basta)
  **non è un rifiuto**: è `null`, e chi legge non deve travestirlo.
  **La clausola SQL non è una copia decorativa di `isReadyForProposal`, e il
  test che lo dimostra esiste**: togliendola i test resterebbero quasi tutti
  verdi (il controllo JS a valle dà lo stesso esito osservabile, zero
  proposte), TRANNE per una serie — l'occorrenza rifiutata verrebbe comunque
  SELEZIONATA, entrerebbe nel dedup per-tick `seriesAttemptedThisTick`, e
  solo dopo verrebbe scartata, bruciando l'unica occasione della serie in
  quel giro. In prodotto: rifiutare la riunione di lunedì zittirebbe quella
  di giovedì. Il test è `apps/worker/src/google/poller.test.ts`,
  «un'occorrenza rifiutata non consuma lo slot per-tick».
  **Il rifiuto SOPRAVVENUTO chiude la card, non la lascia lì.** Il cancello
  impedisce a una proposta di NASCERE; per una già pubblicata serve altro, o
  un appuntamento proposto lunedì e rifiutato martedì resterebbe
  confermabile, creando una milestone per una riunione a cui non si va.
  `syncCalendar` la chiude con `CALENDAR_DECLINED_OUTCOME`
  (`outcome.type = 'declined'`) e marca la notifica `handled`, nella stessa
  transazione. Due paletti: l'esito dice **da cosa** è stata chiusa
  (distinguibile da un `ignored` qualunque, stessa forma di
  `superseded_by_message`) e la card resta leggibile fra le gestite, mai
  sparita; e vale **solo per una proposta ancora aperta** — una già
  confermata non si tocca, la milestone esiste e cancellarla è un'altra
  cosa. Un appuntamento mai proposto non riceve nessun esito, ed è ciò che
  gli permette di tornare a proporre da solo se lo riaccetti. Chiudere qui è
  legittimo — mentre per la posta serviva più cautela — perché **l'ha chiuso
  il maintainer, non il modello**: rifiutare un invito è una sua azione
  esplicita su Google, e Stubwise smette di chiedergli una cosa a cui ha già
  risposto.
- **Lo stato normalizzato del calendario NON sa nulla del rifiuto, ed è
  deliberato (15 set 2026).** `calendarStatusCaseSql`
  (`apps/server/src/routes/calendar-status.ts`) dichiara nel suo docblock di
  replicare `isReadyForProposal`, quindi sembra il QUARTO punto da tenere
  d'accordo con l'invariante qui sopra. **Non lo è, e non va reso tale**:
  risponde a un'altra domanda — «in che stato è questa riga da mostrare», non
  «è pronta a proporre» — e insegnarle il rifiuto vorrebbe dire rifare
  `hasDeclinedInvitation` in SQL su OGNI lettura di `/mail` e `/calendar`,
  cioè un quinto posto da tenere allineato per guadagnare un'etichetta.
  **La conseguenza, da conoscere prima di appoggiarci qualcosa**: un
  appuntamento rifiutato che non ha mai avuto una proposta resta `new` **per
  sempre**, e non diventerà mai `proposed`. Va bene perché l'etichetta di
  quello stato è «Nuova», neutra: non promette «da proporre», quindi non dice
  una bugia. Ma chi un domani ci appoggia un **filtro** o un **contatore**
  («quante ne restano da proporre?») starebbe promettendo qualcosa che per
  quelle righe non succederà mai — e quello sì sarebbe un difetto. Chi ne ha
  bisogno guardi `attendees` più l'indirizzo della casella con
  `hasDeclinedInvitation`, mai quello stato. Il rifiuto **sopravvenuto**
  invece passa di lì, perché scrive un `outcome.type` (`declined`) che quella
  CASE deve mappare: senza, cadrebbe nell'`else` e la riga si mostrerebbe
  «Eseguita», che è falso. È mappato su `ignored` e **non** su un valore
  nuovo di `mailItemStatusSchema`: è un enum che l'app mobile legge, e non lo
  si paga per un'etichetta.
  Corollario già chiuso, da non riaprire: «Riproponi» su un appuntamento
  rifiutato era un **no-op silenzioso** (la rotta azzerava l'esito, il tick
  dopo riapplicava il cancello, la riga restava `new` dopo che la UI aveva
  detto ok). Ora `POST /api/me/mail/calendar/:id/repropose` risponde **409
  `not_reproposable`** dicendo il perché, senza toccare l'esito.
- **`cc_addresses` è NULLABLE mentre `to_addresses` non lo è, e non è
  un'incoerenza da uniformare (16 set 2026).** È la prima cosa che qualcuno
  vorrà «sistemare», e uniformarla romperebbe una cosa che non si vede.
  I due valori dicono cose diverse: `null` = «riga scritta PRIMA della
  colonna, non lo sappiamo», `[]` = «lo sappiamo, non c'era nessuno in
  copia». Su quella distinzione si regge INTERAMENTE lo script di recupero
  (`apps/server/scripts/backfill-email-cc.ts`), la cui condizione di ripresa
  è `cc_addresses is null`: con un `not null default '{}'` quella condizione
  smetterebbe di distinguere le righe mai guardate da quelle senza copia, e
  lo script tornerebbe a Gmail **a ogni lancio** per ogni email che
  legittimamente non aveva nessuno in copia — cioè la maggioranza. C'è un
  test che lo fissa da entrambi i lati: `buildEmailMessageInsert` scrive `[]`
  e mai `null` per un messaggio senza header `Cc`
  (`apps/worker/src/google/sync.test.ts`), e il recupero al secondo giro non
  chiama Google nemmeno una volta (`backfill-email-cc.test.ts`).
  Verso il client la distinzione **non arriva**: `searchMailHitSchema`
  appiattisce a `[]` (`cc: r.ccAddresses ?? []`), perché una riga di ricerca
  non ha niente di diverso da dire nei due casi. Esiste per il recupero, non
  per chi legge.
  **Lo script di recupero tocca SOLO quella colonna**, ed è l'altra metà
  della regola: mai `text_excerpt` (è ciò che la CLASSIFICAZIONE ha letto),
  mai `status`, mai `outcome`, mai una riga di `email_proposals` — una
  proposta aperta non deve accorgersi che è passato — e non fa partire nessun
  job e nessuna notifica, stessa dottrina del percorso `auto` del calendario.
  I test lo verificano sui VALORI prima/dopo, non sull'esito dello script.
- **`to` e `cc` si MOSTRANO, non si cercano (16 set 2026).** `MAIL_TSV`
  (`apps/server/src/routes/search.ts`) non li include, e allargarlo è una
  decisione di prodotto, non un'ottimizzazione: cercare un indirizzo trova
  già le email di quella persona dal mittente e dall'oggetto, mentre
  includere i destinatari farebbe comparire una mail in copia a mezza
  azienda cercando chiunque di quella mezza azienda. C'è un test negativo che
  lo fissa (una parola che esiste SOLO fra i `cc` non trova la
  conversazione).
- **La ricerca della posta non incrina `mailbox_owner`, e il test che lo
  verifica è NEGATIVO (15 set 2026, design §3).** `GET /api/search` ha un
  gruppo `mail` che cerca CONVERSAZIONI (`DISTINCT ON (account_id,
  thread_id)`, non messaggi: tre risposte dello stesso scambio sono un
  risultato, come nella pagina Posta). Il filtro è
  `google_accounts.user_id = utente corrente` dentro l'INNER JOIN, e **nessun
  ruolo scavalca** — non esiste un ramo `if (admin)` da sbagliare, perché non
  esiste affatto. È l'invariante `mailbox_owner` della fase 6, non un
  requisito nuovo: la ricerca non deve poterla incrinare.
  ⚠️ **Il test che la presidia cerca una parola che esiste SOLO nel messaggio
  dell'altro utente** (`apps/server/src/routes/search.test.ts`), e verifica
  ANCHE il verso opposto — che il proprietario quella parola la trovi — così
  un risultato vuoto non può essere una query che non funziona. Contare i
  risultati non basterebbe: con due messaggi diversi un conteggio giusto può
  nascondere la riga sbagliata.
  Due scelte di quel gruppo che non vanno «semplificate»: la `where` ha un
  ramo **ILIKE** oltre al full-text perché Postgres tokenizza un indirizzo
  come UNA parola (`mario@acme.test`), quindi cercare «mario» con
  `websearch_to_tsquery` non trova niente — e un pezzo di nome è il modo in
  cui si cerca la posta; e include i messaggi di **contesto**
  (`admitted = false`), perché quel limite esiste per non farli diventare una
  CARD, non per impedirne la lettura — e cercare è leggere.
- **La posta NON entra nella cronologia della ricerca, ed è una scelta di
  RETENZIONE prima che di enum (15 set 2026).** `searchEntityTypeSchema` non
  ha il valore `mail` e non va aggiunto senza affrontare prima il motivo
  vero: una voce di `search_history` porta `title`/`subtitle`
  **denormalizzati**, quindi registrare una conversazione copierebbe
  l'oggetto di un'email in una SECONDA tabella — fuori da `pruneOldEmails`.
  Un messaggio cancellato da Gmail e potato da noi lascerebbe il suo oggetto
  nei «recenti» per sempre. Il secondo motivo (l'`ALTER TYPE` su
  `search_entity`, con la trappola delle migrazioni batch e un binario
  vecchio che non saprebbe serializzare `/api/search/history`) è reale ma
  viene dopo. Sul web la guardia è `isRecordable` in
  `global-search-palette.tsx`, con un test che verifica che un ticket invece
  SÌ si registri: la guardia è sulla posta, non sulla cronologia in generale.
- **Una serie resta raggiungibile anche senza occorrenze nella finestra
  visibile (fase 9, fix di review).** Spostando la configurazione di una
  serie nel pannello di dettaglio (design §3, Task 7), una serie le cui
  occorrenze cadono tutte fuori da [-30gg, +60gg]
  (`CALENDAR_LOOKBACK_DAYS`/`CALENDAR_WINDOW_DAYS`) sarebbe stata
  irraggiungibile da nessuna vista — il caso esatto delle 730 righe
  dell'incidente del 9 settembre 2026, e peggio: non sarebbe stata
  SPEGNIBILE se accesa con `auto: true`. Corretto prima del merge: la
  sidebar `CalendarSeriesSidebar` (`apps/web/src/components/
  calendar-series-sidebar.tsx`) elenca TUTTE le serie viste, senza filtro di
  finestra (stesso `GET /series` della 7b, che non ha mai filtrato per
  finestra — il buco era solo nella UI), richiudibile e chiusa di default
  per non costare un blocco fisso in una colonna stretta. Chi tocca la
  pagina calendario non rimuova questa sidebar "per pulizia": è l'unico
  punto d'accesso per una serie fuori dalla finestra della griglia.
