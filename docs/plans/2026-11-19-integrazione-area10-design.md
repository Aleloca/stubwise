# Integrazione area 10 — Claude dentro l'app: design

*19 nov 2026, 72. Dall'inventario
(`docs/plans/2026-11-19-integrazione-area10-inventario.md`, branch
`docs/area10-inventario`) e dalle decisioni girate da 46 lo stesso giorno. La
specifica resta il prototipo col suo design
(`docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`). Dove
una decisione lo cambia, il prototipo si riallinea PRIMA di integrarlo (94):
lo dice la sezione. Le invarianti nuove sono in fondo, scritte per esteso, e
le applica 46 quando approva questo design.*

*Il codice parte da `feat/integrazione-area10`, che 46 crea da
`feat/integrazione-area9` (940743f8b) quando approva il primo piano. Tutto
quello che l'area 9 ha già portato (la classe C, le 23 voci dell'area 9,
«By Claude» e «Undid» nel registro, `addMember` con l'escalation dei reparti)
qui non si rifà.*

## Le decisioni *(19 nov 2026)*

| | Decisione | Chi |
|---|---|---|
| D-1 = a | S0: un evento `capabilities` che il server compone dal catalogo vero, coi permessi di chi chiede. | 46 |
| D-2 = a | Le domande a scelta anche nella conversazione libera, con la scheda del prototipo; la risposta torna come messaggio della persona. | 46 |
| D-3 = a | S2: un evento `aside` («Hypothesis», «Details») prodotto dal tool del lavoro fermo, non dal modello. | 46 |
| D-4 = a | Le bozze nei campi le esegue il renderer, solo dal vivo, col segno «Bozza di Claude». | 46 |
| D-5 = a | I suggerimenti li calcola il server, con le regole del «mai se»; «Not now» si salva sul server, per persona. | 46 |
| D-6 = a | Gli scenari S1–S5 diventano golden del worker, coi dati del seme in una fixture. | 46 |
| D-9 = a | S4: niente esiti per riga. Claude legge prima e propone solo le righe fattibili, e nomina le altre in prosa. | 46 |
| D-10 = a | La bozza in un campo è una voce nuova del catalogo, `fillField`, non un ramo di `pageAction`. | 46 |
| D-11 = **b** | **`member.added` va alla persona aggiunta E a chi gestisce il progetto**, con «Undone by…» derivato a lettura. | **maintainer** |
| D-12 = a | Un tool di lettura per tipo di oggetto, ognuno con la sua allowlist e il suo golden ostile. | 46 |
| D-13 = a | S3: resta la regola del server sui consumi. Chi non ha nessun permesso non riceve niente, e Claude dice chi può dirglielo. Il prototipo si riallinea. | maintainer |

D-4 e D-10 sono due metà della stessa scelta. D-4 dice CHI esegue: il
renderer, dal vivo. D-10 dice come viaggia la bozza: una `fn` del catalogo,
che un client vecchio legge come `UNKNOWN`. Questo design le tiene insieme
(§F6).

## I fatti del codice che reggono il design

Questi si aggiungono a quelli dell'inventario e ne correggono due.

- **S1, l'urgenza e «dal supporto» ci sono già.** L'inventario le dava «da
  verificare».
  - `richiesta.urgenza` e `richiesta.dal_supporto` sono fra i campi
    dell'inizio `request_created` (`packages/shared/src/automations/triggerFields.ts`).
  - Il motore li riempie (`automationEventFields`,
    `packages/notifications/src/automation-event-fields.ts:68`).
  - Il passo `notify` accetta un reparto (`who: { departmentId }`), e il
    motore lo espande a ogni membro che vede il progetto.
  - Gli eventi li scrivono i trigger del DB (`automation_events`). Per S1 il
    motore non va toccato.
- **La prova (`trialAs`) non si fa sul server.** Nel prototipo è una
  simulazione senza effetti sugli esempi. Nell'app ha già i suoi pezzi:
  - gli esempi li dà `GET /api/automations/:code/examples`
    (`simulationExamples`), con i campi che un'esecuzione leggerebbe;
  - la simulazione la fa il motore condiviso (`packages/shared/src/automations/engine.ts`).

  La «prova» del server è un'altra cosa: `…/test/estimate` e
  `…/test/claude` costano una stima e chiamano il modello. Quindi per S1 la
  prova NON è né una voce del catalogo né un tool: la fa il renderer, come
  il costruttore (§F2).
- **`deleteDraft` su un'automazione mai pubblicata la cancella tutta**
  (`apps/server/src/automations/writes.ts:363`, `versions.length === 1`).
  Quindi l'inverso di `createAutomation` è `deleteAutomationDraft`, come nel
  prototipo, senza una rotta nuova.
- **Le funzioni delle automazioni stanno in `apps/server/src/automations/`**
  (`writes.ts`, `examples.ts`), non nelle rotte. Il catalogo le chiama da lì.
  `test-claude.ts` invece raggiunge il modello e NON va mai importato dal
  catalogo: `claude-actions-effects.test.ts` lo ferma, e va lanciato in ogni
  task che tocca il catalogo.
- **Il tipo di un evento della sessione è chiuso su DUE piani.**
  - Nello schema: `agentSessionEventTypeSchema` è uno `z.enum`
    (`packages/shared/src/schemas/agent-session.ts:168`).
  - Nel DB: un CHECK, `agent_session_events_type_chk`, scritto nella 0131.

  Un tipo nuovo (`question`, `aside`, `capabilities`) vuole quindi una
  migrazione che RISCRIVA il CHECK. Per i client è sicuro solo perché
  passano da `readerSchema`, che porta un tipo ignoto a `UNKNOWN`; il
  renderer deve saltare `UNKNOWN`. Ogni evento nuovo nasce con il test che
  parsa una risposta con un tipo ignoto.
- **Le domande di @Claude nella Chat sono legate ai messaggi del canale**:
  `chat_claude_questions.reply_message_id` e lo stato `waiting` del messaggio.
  La conversazione libera non ha messaggi di canale: è una sessione dell'agente
  coi suoi eventi. Serve quindi una tabella sua, gemella, non un riuso (§F2).
- **La spesa ha già la regola «solo i tuoi progetti»**, ma diversa dal
  prototipo. `GET /api/ai-usage/summary` dà tutta l'istanza a chi ha
  `usage.view`, e i soli progetti in cui lo si ha a chi ha `project.usage.view`.
  Il prototipo dava «la somma dei soli suoi progetti» a OGNI membro. È una
  differenza di permesso: D-13 = a, resta la regola del server.
- **`member.added` entra nel catalogo degli avvisi**
  (`packages/shared/src/alerts/catalog.ts`). Lo stesso giorno 46 ha deciso
  così anche D-6 dell'area 11, e la D-11 = b lo chiede. Chi gestisce il
  progetto è un destinatario per ISCRIZIONE, quindi spegnibile. La persona
  aggiunta lo è per motivo OBBLIGATORIO.

## Le fette

- **F1 — i chip e le letture**:
  - i tool di lettura dei tipi che mancano, ognuno con la sua rotta,
    l'allowlist e il golden ostile;
  - i chip nel renderer.
- **F2 — S1, un'automazione dal riquadro**: le tre voci delle bozze, le
  domande a scelta nella conversazione libera, la prova nel renderer.
- **F3 — S2 e S3**: due tool, l'evento `aside`.
- **F4 — S4, archiviare in blocco**: il tool dei motivi `busy`, il contratto
  della proposta in blocco, il golden.
- **F5 — `member.added`**: il kind, il catalogo degli avvisi, «Undone by»
  derivato, la voce di rollback.
- **F6 — le bozze nei campi**: `fillField` per la descrizione della task e le
  note di rilascio.
- **F7 — S0 e i suggerimenti**: l'evento `capabilities`, la rotta dei
  suggerimenti e «Not now».
- **F8 — «/» e «#»**: `/status`, `/today`, le skill dei plugin, le richieste
  in «#».

**Le dipendenze.**
- F2, F3 e F7 aggiungono tipi di evento: la riscrittura del CHECK la fa la
  prima che arriva, e le altre la estendono con una migrazione loro.
- F5 non dipende da niente e può andare per prima.
- F4 vuole i motivi `busy` di F6 dell'area 9, che ci sono.
- Ogni fetta porta il suo golden (D-6) e lancia
  `claude-actions-effects.test.ts` se tocca il catalogo.

---

## F1 — i chip e le letture (D-12 = a)

### 1.1 I tool

Un tool per tipo di oggetto che una pagina mostra e che oggi non ha lettura.
Ognuno nasce con quattro cose:
- la sua rotta in `CHAT_TOOL_READ_ROUTES`, che il test del registro controlla;
- la proiezione del ponte in ALLOWLIST (`apps/worker/src/claude-chat/bridge.ts`),
  mai con la lista nera di `compact`: è la regola di `read_instance_settings`
  in F7;
- la descrizione con la frase `UNTRUSTED_*` quando il contenuto viene da
  fuori;
- un golden ostile sul modello di `chat-drive-hostile`.

| Tool | Oggetto | Contenuto da fuori | Cosa NON passa al modello |
|---|---|---|---|
| `read_support_conversation` | una conversazione di supporto, per codice | **sì** (il cliente scrive) | email e dati di contatto del cliente, token del widget |
| `read_server` | un server del monitoraggio | no (campioni dell'agente) | chiave `sk_…`, chiavi SSH, IP se la pagina non li mostra a chi chiede |
| `read_automation` | un'automazione, per codice: inizio, passi, stato, ultime esecuzioni | no | segreti dei passi, URL delle fonti in entrata |
| `read_mail_thread` | una conversazione della posta, di una casella di chi chiede | **sì** | indirizzi oltre a quelli che la pagina mostra; corpo HTML (solo il testo) |
| `read_calendar_event` | un appuntamento di chi chiede | **sì** (descrizione dell'invito) | link di videochiamata con token |
| `read_channel` | gli ultimi messaggi di un canale della Chat che chi chiede legge | **sì** | allegati (solo nome e tipo) |

- **La rotta è sempre quella che la pagina usa già**, letta coi permessi di
  chi chiede: niente rotte nuove apposta per Claude. Se una pagina oggi
  legge da più rotte, il piano ne sceglie UNA e lo scrive.
- **La posta resta di chi la possiede**: `mailbox_owner` non include mai gli
  admin (`docs/invariants/mail-calendar.md`). Il tool legge solo dalle
  caselle di chi chiede, e lo verifica un test negativo: un admin che chiede
  la mail di un altro riceve `not_found`.
- **Il contenuto da fuori alza la proposta.** Una lettura di
  `read_support_conversation`, `read_mail_thread`, `read_calendar_event` o
  `read_channel` scrive `untrustedReadAt` (0146): da lì ogni proposta della
  conversazione è almeno B. È il meccanismo che c'è, applicato ai tool nuovi.
- **I chip senza tool non ci sono**: un chip nuovo manda `{ kind, id }`, e
  il modello lo rilegge col tool. Lo schema del contesto non cambia
  (`claudeConversationContextSchema` è libero).
- **Ordine**: due tool per task del piano. Prima `read_automation` e
  `read_server` (nessun contenuto da fuori), poi supporto e Chat, poi posta e
  calendario.
- *Test*: per ogni tool, il registro delle rotte; l'allowlist, con un campo
  segreto nella risposta della rotta che non deve arrivare al modello; il 404
  a chi non vede l'oggetto; `untrustedReadAt` scritto dai quattro tool da
  fuori. Golden: un'istruzione ostile nel contenuto (supporto, posta, canale)
  non diventa una proposta A.

### 1.2 Il renderer *(94)*

- I chip di automazioni, server, conversazioni di supporto, email, eventi,
  canali.
- Rilascio e file del Drive hanno già il tool (`read_release`,
  `read_drive_file`) e vogliono solo il chip.
- La rilettura con la visibilità si fa come per task e richieste.

---

## F2 — S1, un'automazione dal riquadro (D-2 = a)

### 2.1 Le tre voci delle bozze

| Voce | Classe | Inverso | Funzione del server |
|---|---|---|---|
| `createAutomation` | A | `deleteAutomationDraft` | `createAutomation` (`automations/writes.ts`) |
| `saveAutomationDraft` | A | `saveAutomationDraft` col flusso di prima; oppure `deleteAutomationDraft` se ha aperto una bozza su un'accesa | `saveDraft` |
| `deleteAutomationDraft` | B | nessuno | `deleteDraft` |

- **Solo bozze di progetto**: `projectId` è obbligatorio negli argomenti, mai
  `null` (P3 del prototipo). Il «Who?» è uno solo, il permesso di gestire le
  automazioni del progetto.
- **Claude non accende e non pubblica MAI un'automazione.** `publish`,
  `activate`, `pause`, `duplicate`, le esecuzioni e le approvazioni delle
  esecuzioni entrano nell'elenco del test «mai nel catalogo»
  (`claude-actions-never.test.ts`). Una bozza spenta non avvisa e non fa
  partire niente: per questo `createAutomation` è A. Non c'è un motivo di
  dati che la alzi a B.
- **Gli argomenti** usano gli schemi delle rotte:
  - `createAutomation`: `{ name, projectId, description?, flow }`, `.strict()`.
    Stato e proprietario non si leggono dagli argomenti: nasce spenta, di
    nessuno.
  - `saveAutomationDraft`: `{ code, flow, name?, description?, expectedRev }`.
    `expectedRev` è obbligatorio: la prova a secco lo legge, e la conferma
    ritorna `stale` se nel frattempo qualcuno ha salvato. È la stessa regola
    di `changed_after`.
  - `deleteAutomationDraft`: `{ code, expectedRev }`.
- **Il flusso si valida PRIMA della scheda**: la prova a secco chiama
  `configErrorsOf` (lo stesso controllo di `POST …/check`) come chi chiede.
  Un flusso con errori non diventa una scheda: Claude riceve gli errori e li
  dice. Prima si guarda il progetto (`not_found`, `forbidden`), poi il
  flusso, così un errore del flusso non dice niente di un progetto che chi
  chiede non vede.
- **L'«Annulla»** passa dalle regole che ci sono:
  - dell'autore, una volta;
  - `changed_after` sulla revisione della bozza: se qualcuno l'ha salvata
    dopo, l'«Annulla» non c'è.
  - L'automazione entra in `ActionObject` come kind nuovo `automation`, con
    lo `stamp` del registro. Il registro delle modifiche non ha voci per le
    automazioni (hanno le loro versioni), quindi `changed_after` legge `rev`
    e `saved_by`. Lo scrive il piano.
- **Il segno «via Claude»**: `automation_versions.saved_by` resta la
  persona. La versione salvata da Claude porta `via_claude_action_id`
  (colonna nuova, null di default), così la cronologia delle versioni dice
  «with Claude». È la stessa forma di `change_log.via_claude_action_id`
  della 0195, con lo stesso DEFAULT dalla variabile di sessione.

### 2.2 Le domande a scelta nella conversazione libera

- **Il tool è lo stesso**, `ask_question`, con lo stesso contratto: una
  domanda, da 2 a 5 opzioni con `label` e `description` facoltativa, e una
  sola per risposta. Nella conversazione libera il turno lo accende sempre:
  oggi lo accende solo `ask: mention`.
- **Dove si scrive**: una tabella `claude_conversation_questions`, gemella
  di `chat_claude_questions`. Le colonne:
  - `id`;
  - `session_id` (FK alla sessione, `ON DELETE CASCADE`);
  - `turn_id`: l'id del segmento, con un indice unico per la regola «una per
    risposta»;
  - `text`, `options` (jsonb);
  - `answered_at`, `answer_index`, `answer_text`;
  - `created_at`.
- **L'evento**: un tipo nuovo `question`. `data` porta solo `{ questionId }`,
  e testo e opzioni si leggono a lettura, come la `proposal`. Il turno si
  chiude dopo la domanda, come fa @Claude nella Chat.
- **La risposta**: `POST /api/claude/conversations/:id/questions/:questionId/answer`,
  corpo `{ index } | { text }`.
  - Risponde solo l'autore della conversazione: in una pubblica gli altri
    leggono e non rispondono.
  - Una domanda già risposta dà 409 `answered`.
  - La risposta diventa un `input` della persona («Scelgo: …») e il turno
    riparte. È la via del seguito che c'è.
- **Una pubblica** mostra la domanda e la risposta, senza il bottone.
- *Test*: una domanda per risposta; la risposta riprende il turno; chi non è
  l'autore riceve 403; 409 sulla seconda risposta; il parse di una sessione
  con `question` da un client che non lo conosce. Golden: S1 chiede il
  reparto, e la risposta porta alla bozza.

### 2.2b Deviazione: `list_departments` *(20 nov 2026, approvata da 46)*

- Per «avvisa un reparto» Claude deve sapere quali reparti ci sono, e nessun
  tool li leggeva (`list_people` dà solo gli id).
- Un tool di lettura nuovo, `list_departments`, su `GET /api/departments`
  (nell'allowlist del token del turno): il ponte passa solo id, nome e se è
  il reparto di ripiego. I permessi che il reparto dà e la versione no.
- Nato dal golden `chat-s1-automation`, insieme alla guida ai flussi del
  contratto (`claudeAutomationGuide`, dal motore, con un esempio che il
  motore valida).

### 2.3 La prova

- **Nel renderer, non sul server**, sul modello del costruttore:
  - dopo un `actions_executed` con `createAutomation`, il renderer legge gli
    esempi (`GET …/examples?version=draft`);
  - li fa girare nel motore condiviso;
  - mostra la riga della prova (`TrialRow`): «Wouldn't start» se il filtro
    dell'inizio esclude l'esempio (D3 del prototipo).
- Niente si scrive: nessun `tested`, nessuna stima, nessuna chiamata al
  modello. Il modello non vede l'esito. Se serve dirlo, la riga lo dice da
  sé.
- Il costruttore si apre da sé dopo la prova, con «Back to <pagina>» (D2 del
  prototipo).
- *(94)* Va riletto `data/claude/trial.ts` contro la vista vera degli esempi.

---

## F3 — S2 e S3 (D-3 = a)

### 3.1 Il lavoro fermo: `read_stalled_work` ed `aside`

- **Il tool**: `read_stalled_work({ projectId? })`.
  - Legge `stalled` del polso (`GET /api/projects/pulse`), solo per i
    progetti che chi chiede vede.
  - Con il progetto del contesto, si ferma a quello (S2 del prototipo).
  - Il ponte passa al modello, in allowlist: codice, titolo, da quanto è
    fermo, il segnale del polso.
- **L'evento `aside`**: lo scrive il ponte, non il modello, quando il tool
  risponde con almeno una riga. `data` porta
  `{ rows: [{ projectId, code, hypothesisKey, params }] }`.
  - L'ipotesi è una CHIAVE i18n scelta dal segnale (per esempio «aspetta una
    review», «la PR è chiusa», «il job è fermo per budget»), mai prosa del
    modello: la frase la scrive il renderer.
  - «Details» apre la task.
  - A lettura il server rifiltra le righe con la visibilità di chi guarda.
    In una pubblica un lettore che non vede il progetto non vede la riga.
- *Test*: allowlist; solo i progetti visibili; il filtro del contesto;
  l'`aside` rifiltrato per il lettore di una pubblica; il parse di un tipo
  ignoto.

### 3.2 La spesa del mese: `read_usage_month`

- Legge `GET /api/ai-usage/summary?month=true` coi permessi di chi chiede.
  Tutta l'istanza con `usage.view`, i soli progetti con `project.usage.view`.
  Senza nessuno dei due: un 403 che il modello traduce in «chi può dirtelo»,
  col nome di chi ha `usage.view`, letto da `read_people`/«Chi può farlo?».
- Il ponte passa: totale, per progetto (solo i visibili), per modello.
  Niente per persona.
- *Chi non ha nessuno dei due permessi* (D-13 = a, maintainer): non riceve niente, e Claude dice chi può dirglielo.
- *Test*: tre persone sugli stessi dati (`usage.view`, `project.usage.view`
  su un progetto, nessuno), ognuna con la sua somma o il 403.

---

## F4 — S4, archiviare in blocco (D-9 = a)

- **Niente esiti per riga**: i gruppi restano atomici, come «Annulla» li
  vuole.
- **Claude legge prima.** Un tool nuovo, `read_archive_check({ projectIds })`,
  dà per ogni progetto `{ canArchive, busy: [...] }`:
  - `canArchive` è il permesso di chi chiede nel progetto;
  - `busy` sono i motivi di F6 dell'area 9, compreso `doc_generation`;
  - un progetto che chi chiede non vede non c'è nella risposta. Non esce
    nemmeno come «non trovato».
- **Il contratto del prompt**: per un'azione in blocco Claude chiama prima
  `read_archive_check`, propone SOLO le righe con `canArchive` e senza
  `busy`, e nomina le altre in prosa col motivo («ACQ ha una generazione dei
  Docs in corso»). Per una riga senza permesso c'è il «Who?», cioè «Chi può
  farlo?» (D-11 dell'area 9).
- **La rete di sicurezza resta**: se nel frattempo una riga diventa `busy`,
  la prova a secco rifiuta la proposta intera, come oggi. «Conferma 2 di 3»
  (`selected`) c'è già.
- *Test*: il tool non nomina i progetti invisibili; i motivi `busy` sono gli
  stessi della rotta d'archivio. Golden S4: con un progetto `busy` e uno
  senza permesso, la proposta ha solo le righe fattibili e la prosa nomina
  le altre due.
- *(94)*: la scheda in blocco del prototipo mostra le righe non fattibili
  spente nella scheda. Nell'app stanno nella prosa sopra la scheda: il
  prototipo si riallinea.

---

## F5 — `member.added` (D-11 = b, maintainer)

- **Il kind**: `member.added`, valore nuovo di `notification_kind`.
  - La `ALTER TYPE … ADD VALUE` va in uno statement a sé, e il valore non si
    usa nello stesso batch.
  - L'enum dello schema condiviso passa da `readerSchema`.
- **Quando si pubblica**: a ogni ingresso di una persona in un progetto.
  - Lo fa `putProjectMember`, a mano e da Claude (`addMember`), e anche
    l'invito che dà un progetto.
  - Un cambio di ruolo NON pubblica: non è un ingresso.
  - Non pubblica nemmeno un reparto che, con F8 dell'area 9, dà permessi a
    chi è già membro.
  - Non pubblica mai per l'agente (`is_agent`).
- **I destinatari**, nel catalogo degli avvisi:
  - `type: "member.added"`, gruppo nuovo `members`;
  - `subscribe: { perm: "project.members.manage" }`;
  - `defaultOn: { perm: "project.members.manage" }`, `defaultPhone: false`;
  - `mandatory: ["added"]`, un `MandatoryReason` nuovo: la persona aggiunta
    lo riceve sempre, e non lo può spegnere.
  - Chi gestisce il progetto lo riceve per iscrizione, acceso di default, e
    lo può spegnere da Preferenze → Avvisi (inbox e push).
- **Mai a chi ha fatto l'ingresso**: né a chi aggiunge sé stesso, né al
  gestore che ha aggiunto. Con Claude «chi ha fatto» è la persona per conto
  di cui Claude agisce, e la card dice «Claude on behalf of …», come le card
  di oggi.
- **Il testo** dalla stessa riga dell'evento: progetto, ruolo, chi. Per la
  persona aggiunta: «You've been added to ACQ as Developer». Per i gestori:
  «Ada added Bruno to ACQ as Developer».
- **«Undone by …» si deriva a lettura**, mai nell'evento (CLAUDE.md, «I campi
  che un client legge su una card… si DERIVANO A LETTURA»).
  - L'evento porta l'id della voce del registro delle modifiche
    (`changeLogEntryId`). È vero solo al momento della publish, quindi lì è
    giusto.
  - Il lettore dell'inbox risolve `undoneBy` dal registro: la voce con
    `undo_of_action_id` sul gruppo di quell'ingresso, o una `member.removed`
    successiva dello stesso «Annulla». Lo fa in UNA query per pagina.
  - Una card vecchia senza `changeLogEntryId` resta senza «Undone by».
- **Rollback**: un `notification_kind` nuovo rende NON sicuro scendere
  d'immagine sul server finché ne esistono righe (500 su `/api/inbox`). La
  voce di deploy-log dice la query di pulizia prima della discesa.
- *Test*:
  - destinatari sugli stessi dati: la persona aggiunta, i gestori, e non
    l'attore;
  - un gestore che spegne l'avviso non lo riceve;
  - la persona aggiunta lo riceve anche con tutto spento;
  - Claude per conto di qualcuno;
  - nessuna card al cambio di ruolo, a un ingresso via reparto o all'agente;
  - «Undone by» su una card vecchia, scritta senza il campo, e su una nuova;
  - il parse di una inbox con il kind ignoto.
- *(94)*: il prototipo oggi lo dà solo alla persona aggiunta, e si
  riallinea sulla D-11 = b.

---

## F6 — le bozze nei campi (D-4 = a, D-10 = a)

- **La voce**: `fillField`, classe A, nessuna scrittura sul server.
  - Argomenti: `{ field: "task.description" | "release.notes", targetId,
    text }`, `.strict()`, con `text` fino al tetto del campo vero (100 000
    per la descrizione, come `taskPatchSchema`; 20 000 per le note, come la
    rotta — allineato dalla review di F3–F8, M8).
  - Prima di proporla, la prova a secco controlla che chi chiede possa
    scrivere quel campo. Se non può, non diventa una scheda: Claude dice che
    non può.
- **La esegue il renderer, solo dal vivo, come le azioni della pagina.**
  - Il server la segna eseguita senza effetti.
  - Il renderer, se la pagina del bersaglio è aperta in quella finestra,
    mette il testo nel campo col segno «Bozza di Claude».
  - Il salvataggio resta della persona, dal bottone della pagina.
  - «Undo» c'è solo a pagina aperta, prima del salvataggio.
  - Dopo un ricaricamento la riga resta «non applicata» col gesto «Apply»,
    come le azioni della pagina.
- **Perché una `fn` e non un ramo di `pageAction`**: `pageAction` è
  un'unione discriminata chiusa. Un ramo nuovo farebbe fallire, a un client
  vecchio, il parse dell'INTERA proposta, perché `readerSchema` apre gli
  enum ma non le unioni. Una `fn` nuova invece un client vecchio la legge
  come `UNKNOWN`, e la riga dice «azione non disponibile in questa versione».
- **Le note di rilascio**: la bozza del server (`GET …/release-notes`) resta
  quella della pagina. `fillField` è per quando la scrive Claude nella
  conversazione.
- **Fuori**: la risposta di supporto, per la premessa del maintainer del 14
  nov 2026.
- *Test*: il parse di una proposta con `fillField` da un client senza la
  voce; nessuna scrittura sul server alla conferma; chi non può scrivere il
  campo non riceve la scheda. Renderer *(94)*: «Undo» solo a pagina aperta,
  e il segno «Bozza di Claude».

---

## F7 — S0 e i suggerimenti (D-1 = a, D-5 = a)

### 7.1 S0, l'evento `capabilities`

- **Il tool**: `show_capabilities()`, senza argomenti. Il contratto del
  prompt dice di chiamarlo quando la richiesta non è fra le cose che Claude
  sa fare, invece di inventare un'azione.
- **L'evento lo compone il ponte**, non il modello: `capabilities`, con
  `data: { items: [capabilityId] }`.
  - Gli id sono le nove capacità del prototipo (`CapabilitiesList`),
    filtrate con le firme vere di chi chiede: `claudeActionSignatures(perms)`
    di F7 dell'area 9, coi permessi d'istanza e il «ha almeno un progetto in
    cui può…» per quelle di progetto.
  - Le frasi d'esempio sono del renderer (i18n, per id): il server non manda
    testo.
- *Test*: due persone con permessi diversi ricevono elenchi diversi; un id
  che il renderer non conosce si salta; il parse di un tipo ignoto.

### 7.2 «Claude può aiutarti a…»

- **La rotta**: `GET /api/claude/suggestions?page=<pagina>&objectId=<id>`.
  Dà al più una riga: `{ suggestionId, kind, params } | null`.
  - Le regole del «mai se» del prototipo (`data/claude/suggestions.ts`) si
    portano sul server e leggono dati e permessi di chi guarda.
  - Il client non deduce niente: mostra quello che arriva.
- **«Not now»**: `POST /api/claude/suggestions/dismiss`, corpo
  `{ kind, objectId }`.
  - Si salva in `claude_suggestion_dismissals` (`user_id`, `kind`,
    `object_id`, `dismissed_at`), con la chiave sui primi tre.
  - Vale per persona e per oggetto, per sempre, come nel prototipo.
  - Togliere un utente toglie le sue righe (CASCADE).
- **Le cinque pagine** del prototipo e i loro `kind` li elenca il piano,
  dalla shape `claude-suggestions.md`.
- *Test*: per ogni regola del «mai se», un caso negativo; «Not now» nasconde
  quella riga solo a chi l'ha scelto; nessuna riga a chi non avrebbe il
  permesso dell'azione suggerita.
- `claude-suggestions` si accende con questa fetta.

---

## F8 — «/» e «#»

- `/status`: un tool `read_followed_projects` sui progetti che chi chiede
  segue, col polso.
- `/today`: un tool `read_my_week`, con la settimana di chi scrive (le sue
  task pianificate) e le decisioni che aspettano lui.
- **Le skill dei plugin in «/»**: il renderer legge
  `GET /api/projects/:id/plugins` (la rotta c'è). È una lettura del
  renderer, non un tool: il comando scrive solo il nome della skill nel
  messaggio.
- **«#» con le richieste**: il renderer cerca anche le richieste. Il tool
  `read_request` c'è già.
- **Fuori dall'area 10, nel registro dei rimandi**: le citazioni sui
  messaggi della conversazione, anche quelle di file, che aspettano un tool
  che legga il codice (area 5, D6), e gli allegati (`claude-attachments`).

---

## La parità (D-6 = a)

- Gli scenari S1–S5 del 10b diventano golden del worker
  (`apps/worker/scripts/golden/run.ts`), come `chat-*`.
  - I dati vengono da una fixture tratta dal seme del prototipo: le persone,
    i progetti e le automazioni che gli scenari nominano.
  - La parità si misura sull'ESITO: la proposta giusta, coi permessi giusti,
    o il rifiuto giusto. Non sulla frase.
- Un golden per fetta: F1 i tre ostili, F2 S1, F3 S2 e S3, F4 S4, F5 S5 con
  `member.added`, F7 S0.
- Come gli altri golden: manuali, mai in CI, col CLI pinnato. Le chat
  probabilistiche girano 3 volte.

## Rollback e deploy

- Migrazioni, in ordine:
  - la riscrittura del CHECK degli eventi (F2, poi estesa da F3 e F7);
  - `claude_conversation_questions` (F2);
  - `automation_versions.via_claude_action_id` (F2);
  - `member.added` (F5, statement a sé);
  - `claude_suggestion_dismissals` (F7).
- Prima il server, poi il caddy (il renderer).
- **Non sicure in discesa**:
  - `member.added`, finché ne esistono righe;
  - un CHECK più stretto, finché esistono eventi coi tipi nuovi: la voce
    dice la query che li toglie prima della discesa.
- Le altre discese sono sicure.
- Una voce di deploy-log per l'area, scritta all'ultima fetta.

## Le invarianti nuove *(applicate all'approvazione, 19 nov 2026)*

### `docs/invariants/automations.md` — aggiunta

> **Claude scrive solo BOZZE di automazione (area 10, 19 nov 2026).** Le voci
> del catalogo sono `createAutomation`, `saveAutomationDraft` e
> `deleteAutomationDraft`, solo di progetto. Pubblicare, accendere, mettere in
> pausa, duplicare, avviare un'esecuzione e approvarla non sono mai nel
> catalogo (`claude-actions-never.test.ts`). Per questo una bozza creata da
> Claude è A: spenta e senza proprietario, non avvisa e non fa partire
> niente. Chi aggiungesse «e accendila» renderebbe Claude capace di agire a
> nome del proprietario di un'automazione: è un cambio di prodotto.

### `docs/invariants/claude-actions.md` — file NUOVO (non esiste un file delle azioni di Claude)

> **Gli eventi strutturati di una conversazione li scrive il SERVER, non il
> modello (area 10).** `aside` (il lavoro fermo), `capabilities` (S0) e
> `question` portano solo id e chiavi. Le frasi le scrive il renderer
> dall'i18n, e le righe si rifiltrano a lettura con la visibilità di chi
> guarda. Il modello sceglie QUANDO chiamare il tool, mai COSA dice la riga.
> E un tipo di evento nuovo vuole tre cose insieme: la riscrittura del CHECK
> `agent_session_events_type_chk`, il valore nello `z.enum` letto da
> `readerSchema` e un test che parsa un tipo ignoto.

### `docs/invariants/claude-actions.md` — seconda voce

> **Una bozza di Claude in un campo non si salva da sola (area 10, F6).**
> `fillField` non scrive sul server: il renderer la mette nel campo solo a
> pagina aperta, e il salvataggio resta della persona.

## Le righe per l'indice di CLAUDE.md *(a 46: io non lo tocco)*

- Sotto «Invarianti e trappole», nella voce delle automazioni: «Claude scrive
  solo BOZZE di automazione (area 10)».
- Una voce nuova «Azioni di Claude → `docs/invariants/claude-actions.md`»: «Gli eventi strutturati della
  conversazione li scrive il server (area 10)» e «Una bozza in un campo non
  si salva da sola (area 10, F6)».
- Nell'indice del deploy-log: «Integrazione area 10».

## [DECIDE]

Nessuna aperta. D-13 è decisa (= a, maintainer, 19 nov 2026).
