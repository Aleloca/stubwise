# Invarianti e trappole — Posta e calendario (Google)

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

- **La proposta CONDIVISA (area 6, F2, D4): chi la riceve, chi la vede, chi
  la decide.** La classificazione nuova (`MAIL_CLASSIFY_V2`, `classify-v2.ts`)
  manda OGNI email ricevuta al modello (niente `admit` né regole della posta;
  `admitted` resta il confine fra «classificabile» e «contesto del thread»),
  UNA volta per Message-ID, e produce una proposta per email e progetto
  (`email_proposals.rfc_message_id` unico col progetto, `audience =
  mail_recipients`).
  - **Chi la riceve** (`publish-shared.ts`): i destinatari di ogni copia
    dell'email (mittente, to, cc, mai bcc; i proprietari delle caselle) che
    sono persone di Stubwise (`resolveRecipientUserIds`) E vedono il
    progetto. Un admin la riceve SOLO se è anche destinatario: l'intersezione
    lo esclude per costruzione, non c'è un ramo `if (admin)`. Test NEGATIVI in
    `publish-shared.test.ts`. Decisioni del maintainer: A = (a) un
    destinatario senza casella collegata la riceve e vede l'estratto, mai il
    messaggio (il dettaglio, `/original` e il thread gli sono 404, test in
    `me-mail-proposals.test.ts`); B = (b) l'interruttore della casella decide
    solo se classificare la propria posta, non chi riceve.
  - ⚠️ **La card si consegna con l'audience `mailbox_owner`, UN destinatario
    alla volta**: il nome resta quello del catalogo per kind
    (`google.proposal`), ma qui vuol dire «solo questa persona, mai gli
    admin», non «proprietario della casella». Chi legge una card condivisa
    non deduce la proprietà della casella: `sourceProposalId` viene da
    `email_proposal_recipients`, il vecchio esecutore non la trova (cerca per
    `proposal_notification_id`), dettaglio e originale filtrano sul
    proprietario.
  - **Chi la vede e la decide**: un destinatario registrato in
    `email_proposal_recipients`, col progetto visibile ADESSO; una proposta
    PASSATA anche chi nel progetto ha il permesso di OGNI sua azione. Il primo
    che decide la chiude per tutti (riga `FOR UPDATE`, stato ricontrollato,
    tutte le card chiuse); conferma parziale e modifiche dei soli campi
    consentiti; tutto o niente. Una task nata da qui ha `source = email`:
    contenuto da fuori per la regola «almeno B».
  - Le proposte di PRIMA (`mailbox_owner`, per casella) restano com'erano e
    si vedono anche in `/api/me/mail/proposals`, solo dal proprietario.
  - **«Quale progetto?»** (review F2, 12 nov 2026): la ricevono i
    destinatari che vedono ALMENO UNO dei progetti incerti, e ognuno ha la
    SUA card con i soli progetti incerti che vede (`publish-shared.ts`). Lato
    server vederla e deciderla segue la stessa regola
    (`proposalPermissionsOf` in `mail-proposals.ts`), e la vista non porta
    l'id dei progetti che chi guarda non vede. Dall'inbox l'indice
    dell'opzione si legge sulla mappa che la card MOSTRA (`event.actions`),
    non ricalcolato dalla classificazione.
  - **Invisibile = inesistente anche nei thread**: lo scope di un messaggio
    nasce dai candidati di TUTTI i destinatari, quindi può contenere
    progetti altrui. Elenco, filtri `project`/`noProject` e dettaglio
    intersecano coi progetti di chi guarda (`visibleScopeSql` in
    `me-mail.ts`).
  - ⚠️ **Limite accettato: il PROMPT vede i candidati di tutti i
    destinatari.** `loadCandidateProjects` mette nel prompt titoli delle
    task aperte e nomi dei membri dei progetti di cui è membro un
    QUALUNQUE destinatario: servono alla scelta (il progetto, l'incaricato,
    il ticket). Il rischio è che un testo GENERATO li riporti a chi non vede
    quel progetto: le azioni sono per progetto (una proposta = un progetto,
    ricevuta solo da chi lo vede), mentre il `summary` è condiviso, quindi
    il prompt gli vieta di citare task e persone dei candidati (test in
    `classify-v2.test.ts`). È un divieto al modello, non una garanzia: chi
    aggiunge al riassunto un uso nuovo (una superficie che lo mostra fuori
    dalla proposta) riapra questa voce.
  - **Una classificazione per Message-ID anche fra copie in attesa**: fra le
    copie della stessa email ancora da classificare guida quella con l'id
    più basso, le altre la copiano al giro dopo (`classifyNewMessagesV2`).
- **Con le proposte spente una casella si LEGGE; si spengono solo le
  proposte (decisione del maintainer, 12 nov 2026, area 6).** Il claim del
  poller e l'indice `google_accounts_due_idx` guardano solo `disabled_at`;
  `runAccountTick` salta la classificazione e la pubblicazione (posta,
  calendario, smistamento, azioni automatiche delle serie) quando
  `proposals_enabled` è falso — test NEGATIVO in `poller.test.ts`
  («proposte spente: si legge, non si propone»: messaggi ed eventi ingeriti,
  zero `email_proposals`, zero notifiche, il runner mai chiamato).
  Riaccese, `google_accounts.proposals_since` (scritto dal PATCH solo nel
  passaggio da spente ad accese) è il TAGLIO: la posta con `created_at`
  precedente resta `new` e non si classifica mai (`classify.ts`), così
  riaccenderle non sforna proposte sulla posta già letta. Il calendario non
  ha taglio: un appuntamento propone solo se futuro e nella finestra, come al
  primo collegamento. Chi aggiunge una fase che propone la mette sotto lo
  stesso `if`, e chi aggiunge un percorso di classificazione mette lo stesso
  taglio.
- **Il calendario con TUTTI gli eventi (area 6, F3b): un evento VISTO non è
  un CANDIDATO.** Il worker salva ogni evento della finestra del calendario
  principale (tranne `workingLocation` e `birthday`); solo una riga con
  `proposal_candidate` può diventare una proposta, e la fase delle proposte
  lo filtra in SQL, anche per le occorrenze delle serie accese.
  - **A flag spento il candidato è ESATTAMENTE quello di prima**: un titolo
    e in perimetro per le regole (`routeEvent(...).inScope`). Un candidato
    non torna indietro, e il suo progetto si tocca solo come prima. Test
    «flag spento: stessi candidati e stesse proposte su un insieme misto».
  - **A flag acceso** (`MAIL_CLASSIFY_V2`): un invitato o l'organizzatore,
    escluso il proprietario, membro esplicito di UN progetto
    (`projectBy: model`), calcolato per lotto; con più progetti nessuna
    proposta (la «Quale progetto?» del calendario è nel registro).
  - **Le due linee di base**: il primo giro completo dopo il deploy
    (`calendar_baseline_at`; il syncToken azzerato forza il resync) e il
    primo giro col flag acceso (`calendar_v2_baseline_at`) chiudono
    (`baseline`) ogni riga che vi DIVENTA candidata. Una casella collegata
    dopo il deploy nasce con la prima già fatta. Chi aggiunge un percorso
    che fa nascere candidati gli metta la stessa linea di base.
  - **La potatura** (`pruneOldCalendarEvents`): via le righe prima di −31
    giorni senza una proposta aperta; una proposta aperta su un evento
    vecchio si chiude `expired` (riga e card insieme) e se ne va al giro
    dopo. Con l'orologio del giro, come la finestra.
  - **`range?fields=summary`** è la lista leggera e senza le cancellate;
    senza il parametro `range` resta quello di prima, perché web e app
    leggono ancora i campi pesanti da lì.
  - Le proposte del calendario stanno anche in `/api/me/mail/proposals`
    (col flag acceso, `kind: calendar`): sempre `mailbox_owner`, decise
    dalla loro card.

- **Scrivere la posta (area 6, F3): bozze di Gmail, invio trattenuto, e
  Claude che PROPONE ma non manda mai.**
  - **Le bozze sono bozze di Gmail** (D7): `mail_drafts` tiene ciò che Gmail
    non sa e la copia dell'ultimo salvataggio (l'elenco non chiama Google).
    Una bozza cambiata da Gmail nel frattempo non si sovrascrive in
    silenzio: 409 `draft_changed`, e solo il gesto «Tieni la mia»
    (`overwrite: true`) scrive sopra. Bozze e invii sono di chi scrive: il
    suo id nella WHERE, una riga altrui è 404.
  - **Invia = una riga `mail_outgoing`, 10 s, e il worker la manda**
    (`mail-sender.ts`): claim `queued → sending` con SKIP LOCKED, MAI un
    ritentativo automatico (Riprova è un gesto), e all'avvio una riga
    rimasta `sending` diventa `failed`/`interrupted`, mai rimandata (non si
    sa se Gmail l'abbia mandata). I controlli (destinatari, indirizzi,
    allegati, casella, scope, file del Drive ancora visibili) stanno PRIMA
    di accodare.
  - ⚠️ **Annulla ferma SEMPRE l'invio entro i 10 s** (correzione di 46): la
    riga va a `cancelled` per prima, sulla riga bloccata. Se lo slot è di
    un'altra bozza, il contenuto torna NON salvato (`unsaved`) e la copia di
    Stubwise se ne va; la bozza resta fra quelle di Gmail. Nessun esito
    della bozza lascia partire un'email annullata — chi tocca `undoSend` non
    reintroduca un rifiuto che lasci la riga `queued`.
  - **La posta mandata entra nei thread come CONTESTO** (`admitted =
    false`), solo in un thread già noto o se l'ha mandata Stubwise, e non si
    classifica mai.
  - **Un file del Drive allegato è un riferimento**, riletto a ogni
    salvataggio e ricontrollato a Invia col permesso di chi scrive: chi non
    vede più il progetto (o il file è eliminato) riceve
    `attachment_unavailable`, mai i byte.
  - **La firma di Gmail si legge con `gmail.modify`**
    (`users.settings.sendAs`), mai con `gmail.settings.basic` (ristretto, e
    serve solo a scrivere le impostazioni). Il server la mette nel MIME a
    ogni salvataggio, sotto il corpo e prima della citazione, una volta sola;
    non entra mai in `body`. La copia sulla casella serve al compositore.
  - **La bozza di Claude è solo un testo** (`mail-claude-draft.ts`): legge
    con gli occhi di chi chiede (la sua casella, i progetti attribuiti che
    vede, le task aperte), il testo delle email e i titoli delle task stanno
    in blocchi delimitati con `<`, `>` e `&` scappati e dichiarati DATI; non
    salva e non manda niente.
  - **`fillMailBody` è SEMPRE B e non manda mai**: B perché dichiarata e
    perché senza inverso; nella transazione (e a secco) solo letture; Gmail
    è un seguito dopo il commit, e se fallisce lo dice
    (`claude_actions.effect_failure = mail_not_saved`, nella vista dei
    gruppi) invece di un «fatto» falso. Il test sul sorgente del catalogo
    vieta `sendDraftLater`, `sendDraft` e `retrySend`.
- **Nessuna scrittura verso Google senza un gesto della persona, e lo stato
  locale solo dopo il sì di Google (area 6, F1.3).** La prima scrittura è il
  letto/non letto: `POST /api/me/mail/threads/:threadId/read` chiama
  `threads.modify` col token della casella di chi guarda (`user_id` nella
  WHERE: un thread altrui è 404 senza chiamare Google) e scrive
  `email_messages.unread` SOLO dopo la risposta positiva; un rifiuto lascia
  la riga com'era (test «un rifiuto di Google NON cambia lo stato locale»).
  Senza `gmail.modify` (una casella di prima) 409 `google_scope_missing` con
  `missing`, PRIMA di qualunque chiamata. Il poller non scrive mai su Google:
  rilegge `UNREAD` dalla history. Chi aggiunge una scrittura (bozze, invio,
  calendario) la fa partire da una rotta chiamata da un gesto, con lo stesso
  ordine.
  **Aprire una conversazione È il gesto che la segna letta** *(O)*,
  decisione dell'orchestratrice dalla review del renderer della F1, come il
  prototipo con D5 = b): il renderer chiama la rotta dopo 1 s di permanenza
  sulla conversazione aperta, non al passaggio. «Segna come non letta» la
  lascia non letta finché non la si RIAPRE: il renderer non la risegna letta
  mentre resta aperta. Nessun altro percorso (anteprima, notifica, ricerca,
  il worker) segna letta una conversazione.
- **Scrivere sul calendario (area 6, F4): un gesto, i no prima di Google, la
  riga dopo il sì.** Le sole scritture su Google Calendar sono le rotte di
  `/api/me/calendar/events…` (`services/calendar-writes.ts`,
  `services/calendar-project.ts`): nessun poller, job o azione di Claude
  scrive sul calendario (i nomi sono nel `NEVER` di
  `claude-actions-never.test.ts`). Solo le PROPRIE caselle: un evento altrui
  è 404, anche per un admin. Chi non organizza non modifica, sposta o
  elimina (`not_organizer`); l'organizzatore non risponde (`organizer`), chi
  non è invitato nemmeno (`not_invited`); un etag diverso da quello della
  riga è `changed_on_google` — e in questi casi Google NON viene chiamato
  (verificato negativamente: risposta E nessuna chiamata). Le modifiche
  portano l'etag in `If-Match` (un 412 è `changed_on_google`, si rilegge:
  Q4). La riga si scrive nella stessa richiesta DOPO il sì di Google. **La
  creazione è idempotente** (review F4): l'id dell'evento lo genera il
  client (`eventId`, base32hex) e Riprova lo rimanda; un 409 `duplicate` di
  Google vuol dire «già creato» e si rilegge — solo se lo organizza la
  casella. Senza, un DB che fallisce dopo il sì creerebbe una SECONDA
  riunione al Riprova, con gli inviti agli esterni mandati due volte (Q6).
  «Tutta la serie» scrive sul PADRE e riscrive le date da
  `events.instances`: lo spostamento parte dall'inizio ORIGINALE della data
  trascinata ed è in ore d'orologio nel fuso del padre (l'ora legale non lo
  sposta), e una data che cambia id porta con sé progetto, candidatura e card
  della riga vecchia (abbinata per data originale); si chiude solo una data
  sparita DENTRO la finestra. ⚠️ Limite dichiarato (review F4, punto 11): su
  «tutta la serie» l'`If-Match` è l'etag del PADRE appena riletto, quindi
  l'etag del client protegge solo la data trascinata, non le altre.
  Eliminare chiude le righe come il poller chiude un evento cancellato (la
  card aperta si chiude, Q5) e toglie `calendar_series`. Il progetto messo a
  mano (Q1) passa alle righe degli altri invitati SOLO se senza progetto o
  con uno che chi lo mette vede, mai su una messa a mano da un altro, e solo
  se il proprietario vede il progetto; e a lettura un progetto che chi guarda
  non vede esce come `null` (id, nome e `projectBy`), qualunque sia la fonte.
- **⚠️ ECCEZIONE DICHIARATA a «Posta e Calendario personali»: il
  libero/occupato dei colleghi (area 6, F4, task 5; D8 = b, Q3 = a).** `GET
  /api/me/calendar/freebusy` lo legge CHIUNQUE nell'istanza *(O, 46)*, per
  organizzare una riunione — è l'unico punto in cui una riga del calendario
  di una persona produce qualcosa per un'altra. Il perimetro, che non si
  allarga: escono SOLO `personId`, `availability` (`connected` /
  `not_connected` / `expired`) e intervalli `{ startsAt, endsAt }` FUSI e
  tagliati all'intervallo chiesto — mai un titolo, un luogo, una descrizione,
  un invitato, un organizzatore, un id di evento o di casella, nemmeno di un
  evento `private` (che occupa, e basta). Dalle righe salvate, nessuna
  chiamata a Google; una casella disattivata non conta. Occupa un evento con
  orario, non cancellato, non `transparent`, non rifiutato; un tutto il
  giorno no, un fuori ufficio sì (`services/calendar-freebusy.ts`). I test
  (`me-calendar-freebusy.test.ts`) controllano le CHIAVI ESATTE della
  risposta e che nessun dettaglio compaia nel corpo: chi aggiunge un campo
  «utile» (il titolo per chi è nello stesso progetto, il numero di eventi)
  rompe l'eccezione, non solo il test — è una decisione del maintainer.
- **«Aggiorna ora» non ha un percorso a parte (area 6, F1.2).** La rotta porta
  `next_sync_at` a adesso e fa un `pg_notify` (`google_sync_request`) nella
  stessa transazione; il worker si sveglia e il claim di sempre (`SKIP
  LOCKED`, richieste prima delle altre dovute) prende la casella: il payload
  non decide chi sincronizzare, quindi un NOTIFY non può far girare la
  casella di un altro né due giri della stessa. A fine giro si azzera la
  richiesta VISTA al claim; una scritta a giro in corso resta e torna dovuta.
  Limite accettato: con `GMAIL_POLL_MINUTES=0` (poller spento, il rollback)
  una richiesta resta in attesa per sempre.
- **L'audience `mailbox_owner` non include MAI gli admin.** (Per le proposte CONDIVISE della classificazione nuova vedi la voce in testa: la card usa la stessa audience, un destinatario alla volta.) È un'audience a
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
