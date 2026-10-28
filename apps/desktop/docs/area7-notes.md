# Area 7 — Automations: dove vive ogni voce dello spec (26 ott 2026)

L'area è **nuova**: il web non ha niente di simile, quindi non c'è parità da
chiudere. Questo documento segue la forma di `area6-parity.md` ma, al posto
della colonna «voce dell'inventario», ha le voci dello spec
(`docs/plans/2026-10-26-desktop-area7-automations-design.md`): dove vive ora
ciascuna e quale test la copre (nome del test fra virgolette). Dove non c'è un
test dedicato lo dice la colonna e la voce torna in «Buchi». Percorsi relativi
a `src/renderer/`; `d/` = `data/automations/`, `p/` = `pages/automations/`,
`dom/` = `domain/automations/`. La destinazione è `#/automations` (dettaglio
`/<codice>`, costruttore `/<codice>/edit`, prova `/<codice>/test`,
esecuzione `/<codice>/runs/<n>`, sorgenti `/automations/sources`); le
approvazioni stanno in **Da decidere** nella Home. Test: `d/*.test.ts` (livello
dati), `dom/*.test.ts` (motore puro), `p/*.test.tsx` e `p/*/*.test.*` (pagine).

## Obiettivi

| Voce | Dove vive | Test |
|---|---|---|
| Un motore: un inizio e una sequenza di passi con condizioni e rami | `dom/engine.ts` (puro, `advance`), `d/runner.ts`, `dom/validate.ts`; flusso dichiarativo in `data/model.ts` | `engine.test.ts` («AUT-1 #1 (finita) dal suo evento: stessi passi, percorsi, esiti ed effetti del registro», «qualunque sequenza di tempo, eventi ed esiti lascia l'esecuzione ferma, senza effetti né righe»), `validate.test.ts` («ogni flusso del seme è valido»), `conditions.test.ts` («gruppi all/any annidati») |
| Costruttore comprensibile a chi non è tecnico | `p/builder/*` (procedura numerata 1…N, corsie in parole, pannello del passo) | `Builder.test.tsx` («AUT-1: procedura numerata 1…N su tutto l'albero, corsie in parole, approvazione sulla riga», «40 passi, 5 livelli, nome lunghissimo: numeri 1…40, nome intero, tutto in pagina»), `tree.test.ts` («1…N nell'ordine di lettura, rami compresi») |
| Costruzione con tastiera e trascinamento | `p/builder/useTreeKeyboard.ts`, `useTreeDrag.ts`, `RowMenu.tsx` | `Builder.test.tsx` («A apre il menu dei passi, Enter crea il passo selezionato e già «Incomplete»; la bozza si salva da sola», «Spazio prende, ↓ sposta entrando nella corsia, Spazio lascia; Esc rimette dov'era», «⌥↓ sposta di uno, ⌘D duplica con «(copy)», ⌫ elimina con Undo»). Il gesto col puntatore: verificato in Chromium vero, nessun test unitario (Buchi) |
| Simulazione su un evento di esempio, passo per passo, senza effetti | `d/simulate.ts`, `d/examples.ts`; `p/test/*` | `simulate.test.ts` (««Nuovo contratto» provato da cima a fondo: anteprime complete e NESSUNA scrittura nello store»), `Test.test.tsx` («AUT-1: fascia di prova, stesso elenco numerato, si ferma subito, anteprime al condizionale, approvazione nella prova, poi «Publish»», «dopo una prova completa nessun effetto vero: né store, né Posta, né Home, né notifiche») |
| Passi di Claude che leggono e ricavano dati o scelte | `dom/claudeStep.ts`, `d/claudeFake.ts`, `p/builder/ClaudeForm.tsx`, `p/previews/Previews.tsx` (`ClaudePreview`, uno solo per registro e prova) | `claudeStep.test.ts` («accetta un'uscita dichiarata e i campi col loro tipo»), `automations.test.ts` (««Nuovo contratto» da una trattativa Audin: Claude, traguardo, task per reparto, email da approvare»), `simulate.test.ts` («Claude dice quali documenti ha letto») |
| Approvazione per passo (parte da solo / chiede approvazione) | `d/pendingEffect.ts`, `d/runner.ts`; `p/builder/StepSections.tsx` (impostazione), `p/RunDecisions.tsx` | `automations.test.ts` («pausa e riaccensione durante l'attesa: sospesa, non approvabile, poi di nuovo in attesa — nessun effetto prima»), `tree.test.ts` («l'email nasce chiedendo al proprietario, il resto parte da solo; «Where» secondo il tipo d'automazione») |
| Esecuzioni visibili: pagina Automations, progetto, traguardo, task | `p/RunList.tsx`, `RunDetail.tsx`, `ProjectAutomations.tsx`, `AutomationOrigin.tsx` | `Automations.test.tsx` (««Runs in progress»: prima quelle che aspettano me (punto pieno), poi le altre»), `EntryPoints.test.tsx` («in AUD la voce c'è dopo Chat, col conteggio delle esecuzioni in corso», «chi vede l'automazione ha codice, nome e l'esecuzione coi link», «il traguardo nel dialogo dei traguardi ha la stessa riga») |
| Sorgenti esterne (Audin, HubSpot, webhook in arrivo) collegate da chi ha il permesso | `p/SourcesPage.tsx`, `SourcePanel.tsx`, `WebhookSections.tsx`, `ClientLinks.tsx`; `d/sources.ts`, `d/webhooks.ts` | `Automations.test.tsx` («senza `integrations.manage` la pagina non esiste (R-G5)», «collegare dichiara la simulazione; ricollegare rende chi agisce «chi l'ha collegata»», «il webhook: indirizzo, esempio e campi con etichette»), `curation.test.ts` («solo con `integrations.manage`; scrive la riga a nome di chi sceglie») |

## Non obiettivi (cosa NON c'è, di proposito)

| Voce | Stato | Verifica |
|---|---|---|
| Claude che costruisce o prova le automazioni | assente: è della fase sull'integrazione di Claude. La forma c'è: il flusso è un documento dichiarativo che `validateFlow` controlla | `validate.test.ts` («incomplete: testi vuoti, nessun passo, attesa a zero, confronto a metà, id doppi, progetto suo in una generale») |
| Webhook in uscita | assente (area 9) | — |
| Connettori veri | tutto simulato (vedi «Quanto è vero nel prototipo») | `Automations.test.tsx` («collegare dichiara la simulazione; ricollegare rende chi agisce «chi l'ha collegata»») |
| Codice scritto dall'utente | assente: condizioni a campi e operatori | `conditions.test.ts` («is / is_not: testo senza maiuscole e spazi, numeri, booleani (R-J6)», «contains, empty, not_empty», «gt / lt su numeri e date») |

## Anti-obiettivi: le tre regole

| Regola | Dove vive | Test |
|---|---|---|
| 1. Un'approvazione blocca davvero (né un riavvio, né un'altra automazione, né la simulazione la scavalcano) | `dom/engine.ts` (il passo con approvazione aspetta), `d/runner.ts`, `dom/restore.ts`; la prova dà l'approvazione a nome di chi prova | `engine.test.ts` («un'esecuzione ripresa da un'istantanea (pausa e riaccensione) resta ferma; «Fai passare il tempo» non la sblocca», «un'approvazione arrivata mentre si aspetta altro (Claude, cliente, progetto, effetto) non fa nulla», «R-J8: l'approvazione del giro 0 ripetuta non sblocca il giro 1 né vi porta le sue correzioni»), `automations.test.ts` (««Fai passare il tempo» non scavalca un'approvazione», «un avvio annidato non salta l'approvazione dell'automazione avviata», «pausa subito dopo un'approvazione: l'approvazione già data non si perde, si sospende al passo dopo», «chi gestisce ma non è l'approvatore: forbidden (R-J8)»), `simulate.test.ts` («le approvazioni nella prova le dà chi prova, a nome suo; la riga dice chi approverebbe davvero»), `EntryPoints.test.tsx` («la decisione rimandata (con le modifiche) non cade sul passo nuovo, e il messaggio dice chi ha deciso») |
| 2. Claude sceglie solo fra le strade disegnate; fuori elenco = errore del passo | `dom/claudeStep.ts`, `dom/engine.ts`; codici `unknown_outcome`, `bad_field`, `too_many` | `claudeStep.test.ts` («un'uscita non dichiarata, assente o non prevista è unknown_outcome», «un campo non dichiarato, mancante o del tipo sbagliato è bad_field», «un elenco oltre 50 elementi è too_many; 50 e vuoto vanno bene»), `engine.test.ts` («una motivazione che «chiede» di fare altro non è un'azione: il flusso prosegue com'è disegnato»), `simulate.test.ts` («chi prova non può iniettare risultati di effetti o di Claude») |
| 3. Tutto tracciato: dati, perché (motivazione di Claude), chi approva e quando | registro in `data/model.ts`, `p/RunLog.tsx`, `LogGroups.tsx`, `previews/Previews.tsx` (`ClaudePreview`) | `Automations.test.tsx` («il registro: rami presi con l'etichetta, rami non presi espandibili, Claude con uscite e motivazione», «annulla con conferma: il registro scrive chi»), `automations.test.ts` («rifiutare annulla l'esecuzione (R-J7) senza effetti», ««Salta» un passo fallito: l'esecuzione prosegue da quello dopo») |

## Il modello

| Voce | Dove vive | Test |
|---|---|---|
| Automazione: nome, progetto facoltativo, proprietario, stato bozza / attiva / in pausa | `data/model.ts`, `d/writes.ts`, `d/plans.ts`; `p/AutomationDetail.tsx` | `Automations.test.tsx` («testata in prosa, azioni per stato, esecuzioni prima di «How it works», versioni», «mettere in pausa: dialogo, poi l'automazione è in pausa e la sua esecuzione in attesa è sospesa»), `curation.test.ts` («pausa e riaccensione scrivono e azzerano chi e quando») |
| Versioni: accendere pubblica; modificare un'attiva crea la bozza successiva; le esecuzioni in corso finiscono con la loro | `d/writes.ts` (salvataggio bozza, pubblicazione), `p/builder/useAutosave.ts` | `automations.test.ts` («versione nuova pubblicata con esecuzioni in corso: quelle finiscono con la loro», «un passo eliminato nella bozza non tocca l'esecuzione in corso»), `drafts.test.ts` («la bozza non cambia le esecuzioni in corso né la versione pubblicata»), `Builder.test.tsx` («su un'attiva senza bozza: aprire non crea niente; la prima modifica nasce come versione 2», «un altro ha cambiato la bozza: il salvataggio si ferma e chiede di ricaricare ([A 12])») |
| Duplicare una versione | `p/AutomationDialogs.tsx` | `curation.test.ts` («una bozza nuova col flusso della versione scelta, a nome di chi duplica»), `Automations.test.tsx` (««Duplicate this version» da una versione vecchia: una bozza nuova, poi il suo dettaglio») |
| In quale progetto agisce: di progetto crea nel suo; generale ricava dal cliente (tabella cliente → progetto) o progetto fisso | `d/sources.ts` (tabella), `d/runner.ts`; `p/ClientLinks.tsx` | `engine.test.ts` («cliente fuori tabella: attesa «scegli il progetto», poi la scelta vale per tutto il flusso»), `Automations.test.tsx` («righe ordinate per cliente col progetto in codice + nome; aggiungere, chiave già presente», ««Remember for» il cliente scrive la tabella; senza `integrations.manage` non c'è») |
| Progetto non trovato → attesa «scegli il progetto» in «Da decidere» | `p/RunDecisions.tsx`, `pages/home/blocks/AutomationDecisionItem.tsx` | `entry.test.ts` (««scegli il progetto» porta il cliente, e nessuna anteprima»), `EntryPoints.test.tsx` (««scegli il progetto» (il proprietario): sceglie sul posto, senza «Remember» senza integrations.manage») |
| Le esecuzioni di una generale compaiono anche nel progetto in cui hanno agito | `d/entry.ts`, `p/ProjectAutomations.tsx` | `entry.test.ts` («AUD per Giulia: l'automazione del progetto e le sue esecuzioni non finite, senza poter creare», «una generale che ha agito qui: chi non la vede ha l'esecuzione senza nome né link, chi la vede anche l'automazione»), `EntryPoints.test.tsx` («una generale che ha agito qui: chi non la vede ha la riga senza link») |

## Inizi (eventi)

| Voce | Dove vive | Test |
|---|---|---|
| Contratto/trattativa chiusa (Audin, HubSpot) con prodotti, cliente, importo, documenti | `d/sources.ts`, `dom/triggerFields.ts` | `automations.test.ts` (««Nuovo contratto» da una trattativa Audin…»), `simulate.test.ts` («da una sorgente collegata i suoi eventi d'esempio, il più recente in alto; scaduta → nessuno») |
| Webhook in arrivo: indirizzo, esempio, campi derivati | `d/webhooks.ts`, `p/WebhookSections.tsx` | `curation.test.ts` («un webhook nuovo, rinominato, con l'indirizzo rigenerato; tutto con `integrations.manage`», «l'esempio: JSON non valido detto, campi derivati con etichette e tipi, quelli usati che spariscono segnalati»), `Automations.test.tsx` («un webhook nuovo: nome, poi il pannello con «Paste an example»; JSON non valido detto; i campi nascono dall'esempio», «l'indirizzo si copia e si rigenera con conferma; un campo si rinomina in posto») |
| Eventi di Stubwise: task creata o chiusa, richiesta creata, traguardo raggiunto | `d/runner.ts` (ascolto), `dom/triggerFields.ts` | `automations.test.ts` («task creata: parte per il suo progetto, e una task creata dall'esecuzione non la riavvia», «inizi «richiesta creata» e «traguardo raggiunto»») |
| Email in arrivo (solo caselle del proprietario) | `d/runner.ts` + `data/mail/writes.ts` | `automations.test.ts` («email in arrivo: solo dalle caselle del proprietario»), `simulate.test.ts` («R-J13: le email d'esempio vengono SOLO dalle caselle di chi prova, non da quelle di chi l'ha creata») |
| Data o ricorrenza | `d/runner.ts` | `automations.test.ts` («una ricorrenza parte una volta sola al giorno, se cade adesso», «una ricorrenza conta solo gli avvii della ricorrenza, non quelli a mano») |
| Avvio a mano («Run now») | `p/RunNow.tsx` | `Automations.test.tsx` (««Run now»: i dati dell'inizio con l'etichetta, poi parte e lo dice») |
| Ogni inizio porta dati con nome e tipo | `dom/triggerFields.ts`, `dom/fields.ts` | `fields.test.ts` («all'inizio del flusso: solo i dati dell'inizio», «inizi interni e a orario prendono i campi da triggerFields») |

## Passi

| Voce | Dove vive | Test |
|---|---|---|
| Crea task: incaricato persona, reparto, «chi ha il ruolo X nel progetto» | `d/plans.ts` (`resolveAssignee`), `d/effects.ts`, `d/visibility.ts` (`holdersOfRole`), `p/builder/ActionForms.tsx` | `people.test.ts` («un ruolo nel progetto: la prima persona col ruolo, in ordine alfabetico», «un ruolo che nessuno ha: il passo fallisce con «no_recipient», mai un avviso a caso», «il dato Persona vuoto (o che non è una persona): senza incaricato, con l'avviso»), `automations.test.ts` (««Nuovo contratto» da una trattativa Audin…») |
| Crea traguardo, crea richiesta | `d/effects.ts` | `automations.test.ts` («permesso perso anche su «Crea richiesta» e «Crea traguardo»»), `Automations.test.tsx` («…e senza `tickets.edit` il traguardo, anche con `tickets.create`») |
| Manda email (casella collegata, testo con campi) → arriva nella Posta finta | `d/effects.ts` + `data/mail/writes.ts`; casella scelta sull'automazione | `curation.test.ts` («l'email parte solo dalla casella scelta: se non è più del proprietario, `mailbox_missing` che la nomina», «senza nessuna casella, un flusso con email non si accende»), `automations.test.ts` («un'email da una casella scaduta: passo fallito, nessun invio») |
| Aspetta: tempo, risposta all'email, task chiusa, il primo dei due | `dom/engine.ts` (`wait`), `d/runner.ts` | `engine.test.ts` («wait di giorni: riparte solo quando il tempo arriva», «wait.replyTo scaduto (R-J2): risposta.arrivata=false, testo vuoto; repeatUntil si ferma a max ed esce da onLimit»), `automations.test.ts` («la risposta del cliente simulata nella Posta sblocca wait.replyTo; Claude verifica; i promemoria stanno nella stessa conversazione», «una risposta da un'altra conversazione o di un collega non sblocca l'attesa», «wait.taskClosed: chiudere la task creata dal passo sblocca l'attesa») |
| Claude (istruzione, input, uscite e campi) | vedi Obiettivi | `claudeStep.test.ts`, `Builder.test.tsx` («il passo di Claude dice in testa che sceglie solo fra le uscite disegnate») |
| Condizione: è, non è, contiene, è vuoto, maggiore di | `dom/conditions.ts`, `p/builder/ConditionEditor.tsx` | `conditions.test.ts` (un test per famiglia di operatori), `validate.test.ts` («type_mismatch: forEach su un dato che non è un elenco, maggiore di su un testo, booleano confrontato con un testo») |
| Per ogni (limite 50) | `dom/engine.ts` (`forEach`) | `engine.test.ts` («un forEach su un elenco dell'evento oltre 50 elementi si ferma al limite, senza effetti», «forEach su un elenco vuoto: zero giri, il flusso prosegue»), `Test.test.tsx` («50 giri leggibili: «Round 50 of 50», frecce, «All rounds» virtualizzato e con la ricerca», «oltre 50 elementi la prova si ferma al «Per ogni»: dice perché e dove correggere») |
| Ripeti finché, con massimo obbligatorio e uscita «limite raggiunto» | `dom/engine.ts` (`repeatUntil`) | `engine.test.ts` («una risposta azzera la scadenza; il repeatUntil già soddisfatto fa zero giri (R-J4)», «repeatUntil con un massimo non finito, negativo o frazionario: 0 giri, poi a intero per difetto»), `validate.test.ts` («limit: repeatUntil senza un massimo fra 1 e 10») |
| Avvia un'altra automazione | `d/runner.ts` | `automations.test.ts` («una catena di avvii si ferma alla profondità 3», «configurazione: avviare un'automazione sconosciuta o sé stessa (A → … → A) è un errore e non si pubblica»), `simulate.test.ts` (««Avvia un'altra automazione» dice solo che partirebbe: nessuna esecuzione, i suoi passi non si percorrono») |
| Avvisa una persona | `d/effects.ts` | `automations.test.ts` (««Avvisa» con la persona vuota è un passo fallito, non un avviso a nessuno», ««Avvisa» in una generale non prende un progetto a caso fra quelli toccati»), `Builder.test.tsx` («avviso e task col dato Persona o un ruolo: frase coi gettoni, scelta nel pannello») |
| In pausa: nessun nuovo inizio, esecuzioni sospese prima del passo successivo, evento arrivato in pausa non recuperato | `d/runner.ts`, `dom/restore.ts` | `automations.test.ts` («pausa con un'esecuzione in waiting_event: sospesa, la risposta arrivata in pausa si perde, poi riprende», «pausa mentre un effetto è in volo: si sospende al confine del passo, senza ripeterlo») |
| Impostazione «Parte da solo» / «Chiede approvazione a …» con approvatore persona, ruolo o proprietario | `p/builder/StepSections.tsx`, `d/plans.ts`, `d/visibility.ts` | `people.test.ts` («chi approva vede il ruolo, e la pagina lo dice col progetto («Project Lead of AUD»)»), `validate.test.ts` («approver_cant_see: chi approva non vede il progetto del passo») |

## Esecuzione

| Voce | Dove vive | Test |
|---|---|---|
| Titolo da modello, stato (in corso, in attesa di approvazione, di un evento, finita, fallita, annullata), registro | `d/runner.ts`, `p/RunDetail.tsx` | `automations.test.ts` («ogni stato dell'esecuzione è raggiungibile», «codici: <PRJ>-A<n> e AUT-<n>, mai riusati; esecuzioni numerate per automazione») |
| Dura giorni e riprende da sola; «Fai passare il tempo» (solo prototipo) | `p/PassTime.tsx`, `d/runner.ts` | `Automations.test.tsx` («attesa della risposta: «Pass time» fino alla scadenza manda il promemoria»), `engine.test.ts` («un'esecuzione in attesa del cliente ripresa dal seme: alla scadenza scrive R-J2 e manda il promemoria») |
| Annullare; riprovare o saltare un passo fallito | `p/RunDialogs.tsx`, `d/runWrites.ts` | `Automations.test.tsx` («fallita: «Retry», «Skip» con conferma, «Cancel run» con conferma; Viewer non li ha»), `automations.test.ts` («il proprietario perde tickets.create a metà esecuzione: passo fallito «permesso perso», poi Riprova») |
| Approvazioni in «Da decidere» con Approva / Rifiuta; il rifiuto ferma l'esecuzione | `pages/home/blocks/DecideBlock.tsx`, `AutomationDecisionItem.tsx` | `EntryPoints.test.tsx` («l'approvazione con l'origine, la domanda e l'email in anteprima; Approve la manda», ««Undo» entro la finestra: niente parte e la voce torna»), `automations.test.ts` («rifiutare annulla l'esecuzione (R-J7) senza effetti») |
| Un'email da approvare si corregge prima | `p/RunDecisions.tsx`, `p/previews/Previews.tsx` | `EntryPoints.test.tsx` (««Edit» corregge l'email prima di approvarla»), `automations.test.ts` («un'email da approvare si corregge prima di approvarla (solo i campi dell'anteprima)») |

## Simulazione

| Voce | Dove vive | Test |
|---|---|---|
| «Prova» con un esempio recente della sorgente o scritto a mano | `p/test/ExampleDialog.tsx`, `d/examples.ts` | `Test.test.tsx` (««Write one»: il modulo coi dati dell'inizio, precompilato, nessun campo obbligatorio»), `simulate.test.ts` («inizi di Stubwise: solo oggetti veri che chi prova vede, del progetto dell'automazione»), `curation.test.ts` (««Edit and send»: un evento scritto a mano fa partire le automazioni; tipi sbagliati no») |
| Passo per passo: task, email intere, scelte di Claude con motivazione, attese, rami | `p/test/PreviewPanel.tsx`, `marks.ts`, `Summary.tsx` | `marks.test.ts` («dentro un «Per ogni»: rami presi e non presi per giro, giri, fermata all'approvazione»), `Test.test.tsx` (primo test) |
| Nessun effetto reale | `d/simulate.ts` (in memoria) | `simulate.test.ts` («nessuna scrittura anche con «Avvisa» e un'email che torna indietro (stesso esito della vera)», «le prove vivono in memoria: si buttano con endSimulation, resetApi e il cambio di persona»), `Test.test.tsx` («dopo una prova completa nessun effetto vero: né store, né Posta, né Home, né notifiche») |
| Attese con «Avanti», o risposta del cliente scritta | `p/test/StopActions.tsx` | `simulate.test.ts` («le attese: «Avanti» le supera, la risposta del cliente si scrive, Claude la verifica»), `Test.test.tsx` (««Skip ahead» senza risposta: il promemoria, poi il limite dei giri») |
| Approvazioni: «qui si fermerebbe…», approvabili per proseguire | `p/test/Blocked.tsx` | `Test.test.tsx` («rifiutare nella prova: la vera si fermerebbe lì; niente «Turn on»», «correggere l'email prima di approvare: l'anteprima mostra il testo corretto») |
| Si accende solo dopo, con un'azione esplicita | `p/builder/BuilderDialogs.tsx` (dialogo «Turn on»), `d/writes.ts` | `Builder.test.tsx` («Turn on senza averla provata: il dialogo lo dice e offre «Test first»»), `simulate.test.ts` («R-J19: una prova finita bene segna la revisione provata; una nuova modifica la rende non provata»), `Test.test.tsx` («il dialogo «Turn on» della prova dice «non provata» se la versione non lo è più») |

## Codici

| Voce | Dove vive | Test |
|---|---|---|
| `<PRJ>-A<n>`, `AUT-<n>`, esecuzione `#<n>`, mai riusati | `d/writes.ts` | `automations.test.ts` («codici: <PRJ>-A<n> e AUT-<n>, mai riusati; esecuzioni numerate per automazione») |
| Codici scritti a mano diventano link se visibili; nascosto = inesistente (R-G5) | `p/AutomationOrigin.tsx`, `LogEntryText.tsx`, `d/visibility.ts` | `automations.test.ts` («R-G5: un'automazione o un'esecuzione nascoste rispondono come inesistenti», «R-J12: dentro un'esecuzione i progetti che non vedo non hanno né id né codice…»), `Automations.test.tsx` («R-G5: inesistente e invisibile rispondono con la stessa pagina», «R-G5 anche per un'esecuzione»), `Builder.test.tsx` («R-G5: inesistente e invisibile rispondono uguale») |

## Dove si vede

| Voce | Dove vive | Test |
|---|---|---|
| Destinazione Automations: elenco con filtri progetto/stato/proprietario, esecuzioni, sorgenti | `p/AutomationsPage.tsx`, `AutomationList.tsx`, `AutomationsColumn.tsx`, `RunList.tsx`, `automationParams.ts` | `Automations.test.tsx` («raggruppato per progetto (GENERAL in testa), righe con stato in parola, inizio e problemi», «i filtri stanno nell'indirizzo; nessun risultato → «Clear filters»», «la colonna: viste, Sources e progetti solo con i permessi giusti», ««Needs attention»: le esecuzioni fallite di ciò che gestisco») |
| Progetto: sezione con automazioni ed esecuzioni | `p/ProjectAutomations.tsx`, `layout/ProjectColumn.tsx` | `EntryPoints.test.tsx` («in AUD la voce c'è dopo Chat, col conteggio delle esecuzioni in corso», «senza automazioni né esecuzioni la voce manca a chi non può crearne») |
| Traguardo e task creati: «Creata dall'automazione X · esecuzione Y» | `p/AutomationOrigin.tsx`, `pages/task/LinksSection.tsx`, `pages/overview/MilestonesDialog.tsx`, `pages/tasks/TaskTimeline.tsx` | `EntryPoints.test.tsx` («chi vede l'automazione ha codice, nome e l'esecuzione coi link», «chi non la vede legge solo «Created by an automation», senza link»), `entry.test.ts` («chi non la vede sa solo che l'ha creata un'automazione») |
| Home: approvazioni in «Da decidere» | `pages/home/blocks/DecideBlock.tsx`, `d/entry.ts` (`listMyApprovals`) | `entry.test.ts` («Matteo: prima quelle che aspettano lui, poi le fallite che gestisce, poi le sue in corso», «un approvatore che perde l'accesso al progetto non ha più la riga «aspetta me»») |
| Home: blocco «Automazioni» dal catalogo (non nelle Home di default) | `pages/home/blocks/AutomationsBlock.tsx`, `registry.ts` | `EntryPoints.test.tsx` («elenca solo le esecuzioni che mi riguardano, quelle che aspettano me per prime», «chi vede le automazioni ma non è coinvolto ha il blocco vuoto», «non è nelle Home di default») |
| ⌘K: cerca automazioni ed esecuzioni; «Nuova automazione» | `palette/commands.ts`, `CommandPalette.tsx`, `p/NewAutomationHost.tsx`, `searchAutomations` | `EntryPoints.test.tsx` («trova un'automazione per codice, con lo stato in parola», «R-G5: chi non vede l'automazione non la trova», ««New automation» apre il dialogo di creazione, solo a chi può crearne», «chi non ha automations.manage non ha il comando»), `automations.test.ts` («searchAutomations trova automazioni ed esecuzioni visibili, per codice e nome») |

## Permessi

| Voce | Dove vive | Test |
|---|---|---|
| `automations.manage` (progetto e istanza); `integrations.manage` per le sorgenti | `data/viewer.ts`, `data/types.ts`, `d/visibility.ts` | `automations.test.ts` («le automazioni di un progetto le vedono i membri, le gestisce chi ha automations.manage nel progetto», «una generale si crea solo col permesso d'istanza; un progetto che non vedo è not_found»), `Automations.test.tsx` («Laura (niente permesso d'istanza): niente generali, niente Sources», «Viewer: stesse pagine, nessun bottone d'azione») |
| Proprietario = chi l'ha accesa; il dialogo lo dice | `p/AutomationDialogs.tsx` | `Automations.test.tsx` («pubblicare dice il cambio di proprietario e le esecuzioni che restano sulla versione vecchia»), `automations.test.ts` («chi ripubblica diventa il proprietario: le approvazioni del proprietario passano a lui») |
| Agisce col permesso del proprietario; se lo perde, «permesso perso» | `d/runner.ts`, `d/effects.ts` | `automations.test.ts` («il proprietario perde tickets.create a metà esecuzione: passo fallito «permesso perso», poi Riprova»), `curation.test.ts` («senza il permesso di creare task nel progetto dell'automazione: `invalid: permission`»), `Automations.test.tsx` («il dialogo blocca per tipo di passo: senza `tickets.create` nel progetto, la task») |
| La posta: nessuna automazione legge quella di altri | `d/effects.ts`, `d/visibility.ts` | `automations.test.ts` («email in arrivo: solo dalle caselle del proprietario»), `curation.test.ts` («per chi non è il proprietario sparisce da attese, ingressi, variabili e campi di Claude») |
| Un approvatore che non vede il progetto non riceve la richiesta (e la configurazione lo segnala) | `dom/validate.ts` (`approver_cant_see`), `d/entry.ts` | `automations.test.ts` («l'approvatore che perde l'accesso al progetto non approva più e non la vede in «Da decidere»»), `EntryPoints.test.tsx` («un approvatore che non vede più il progetto non riceve la richiesta»), `validate.test.ts` («approver_cant_see: chi approva non vede il progetto del passo») |

## Stati e dati finti

| Voce | Dove vive | Test |
|---|---|---|
| Caricamento, vuoto (con modelli), errore con «Riprova», pieno, senza permessi | `p/AutomationList.tsx`, `RunList.tsx`, `SourcesPage.tsx` | `Automations.test.tsx` («vuoto: con il permesso i due modelli, senza la frase», «vuoto senza permesso: «No automations you can see.», nessun «New automation»», «errore di lettura: messaggio e «Retry» che ricarica», «errore di lettura dell'esecuzione: resta l'errore con «Retry»») |
| Errori di configurazione (passo incompleto, approvatore, sorgente scollegata) | `dom/validate.ts`, `p/builder/issues.ts` | `validate.test.ts` («source_disconnected: inizio da una sorgente scaduta o scollegata»), `automations.test.ts` («sorgente scollegata: errore di configurazione, niente avvii nuovi, le esecuzioni in corso vanno avanti»), `Automations.test.tsx` («errori nella bozza: «Problems» li dice «nella bozza della v2», «Publish» porta lì, la riga e «Needs attention» li contano») |
| Sorgente: collegata, scaduta, scollegata | `p/SourcePanel.tsx` | `Automations.test.tsx` («righe con stato in parola, chi l'ha collegata, chi la usa; la scaduta ha sempre «Reconnect»», «scollegare dice quali automazioni attive si fermano») |
| Dati finti: «Nuovo contratto» (AUT-1), «Richiesta dati al cliente» (AUD-A1), esecuzioni in corso / ferma / finita / fallita, una bozza (STW-A1), una in pausa (BTG-A1) | `data/seed/automations/`, `d/templates.ts` (i due modelli) | `validate.test.ts` («ogni flusso del seme è valido»), `engine.test.ts` («AUD-A1 #1 dal suo evento fino all'approvazione: registro e anteprima come nel seme»), `drafts.test.ts` (««New contract»: il flusso dell'esempio con sorgente, approvatori e reparti vuoti», ««Ask the client»: ripeti con il suo massimo, l'attesa della risposta, Claude con due uscite»), `Builder.test.tsx` («il modello apre il costruttore con sorgente, approvatori e reparti da completare») |
| Limiti di sicurezza: 20 email per esecuzione (e per catena), 200 effetti, 100 esecuzioni non finite, catena di avvii a 3, 50 elementi | `dom/engine.ts`, `d/runner.ts` | `engine.test.ts` («al massimo 20 email per esecuzione: la ventunesima è un limite e l'esecuzione si ferma», «R-J9: al massimo 200 effetti per esecuzione, anche attraverso cicli annidati»), `automations.test.ts` («al massimo 100 esecuzioni non finite per automazione», «il limite di 20 email vale per la catena intera») |

## Quanto è vero nel prototipo

Sorgenti, webhook, eventi esterni e Claude sono finti e deterministici
(`d/claudeFake.ts`, `d/sources.ts`); «Simulate an event» e «Pass time» sono
solo prototipo e lo dicono. Le email «partono» nella Posta finta dell'area 6 e
la risposta del cliente si simula.

- «Simulate an event» fa partire AUT-1 e lo dice in un toast:
  `Automations.test.tsx` (««Simulate an event» (solo prototipo) fa partire AUT-1 e lo dice in un toast con «Open»»).
- La risposta del seme si sblocca dalla Posta:
  `automations.test.ts` («R-J10: l'esecuzione del seme in attesa del cliente si sblocca con la risposta simulata nella sua conversazione»).
- Il lavoro in volo non scrive in uno stato nuovo:
  `automations.test.ts` («resetApi ripulisce: esecuzioni, orologi e il lavoro in volo non scrive nello stato nuovo»).

## Ruling del controller che hanno cambiato o completato lo spec

Dal ledger della costruzione (R-J1…R-J20). Lo spec non li dice, o dice altro;
vincolano il codice.

- **R-J1 → R-J10, proprietari del seme.** AUT-1 è di Matteo, con un permesso
  d'istanza personale; AUD-A1 di un Project Lead di AUD con casella (non
  Laura): chi accende deve avere una casella collegata, e le email del seme
  esistono nella Posta.
- **R-J2, attesa della risposta.** `wait.replyTo` azzera `risposta.*` a ogni
  attesa; scaduta, `risposta.arrivata = false` e testo vuoto. **R-J6**: tipo
  di campo `boolean`, così `risposta.arrivata` si cita nelle condizioni.
- **R-J3, campi di Claude.** Globali e ridichiarabili (vince il tipo più
  recente); `forEach.as` li prefissa; l'elenco di un ciclo non si ridichiara
  dentro il ciclo.
- **R-J4, «Ripeti finché».** Controlla la condizione prima di ogni giro (può
  fare zero giri); massimo intero fra 1 e 10.
- **R-J5, grammatica dei percorsi** dei dati (giro 0 dentro i cicli), scritta
  nei docblock di `data/model.ts`.
- **R-J7, rifiuto = annullata.** Rifiutare un'approvazione annulla
  l'esecuzione con errore `rejected`; Claude restituisce tutti i campi
  dichiarati.
- **R-J8, identità dell'approvatore** controllata dall'esecutore (chi gestisce
  ma non approva: `forbidden`); un'approvazione è legata al passo e al giro
  visti. **R-J9**: tetto di 200 effetti per esecuzione.
- **R-J11, `no_approver`.** Un'approvazione che nessuno può dare fallisce e il
  proprietario lo sa; un approvatore che non vede il progetto è errore di
  configurazione.
- **R-J12, R-G5 dentro un'esecuzione.** Progetti e codici che chi guarda non
  vede restano senza id, nome e codice.
- **R-J13 / R-J16, la posta è del proprietario.** Mittente, oggetto e testo di
  un'email d'inizio, e il testo della risposta del cliente, li vede solo il
  proprietario; gli esempi della prova vengono dalle caselle di chi prova.
  **R-J14**: chi deve approvare vede comunque l'anteprima dell'email.
- **R-J15, la prova.** Input `next`/`run`; una versione pubblicata provata da
  altri usa il proprietario di adesso, la bozza chi prova. **R-J19**: la
  revisione provata (`testedRev`) è segnata solo da una prova finita bene su
  una bozza non cambiata; «Publish» dice «non provata» altrimenti. **R-J20**:
  nessun allegato nella risposta simulata del cliente.
- **R-J17, numerazione 1…N** ovunque (costruttore, prova, dettaglio,
  registro).
- **R-J18, rimandati:** casella dell'inizio «email in arrivo», allegati dal
  Drive, file del Drive come input di Claude (vedi `ossatura-follow-ups.md`).
- **Esiti del registro** `suspended`/`resumed`/`cancelled`/`retried` aggiunti
  dal Task 3; errori macchina come codici (`permission_lost`), prosa solo in
  `reason`.
- **R-J21, avviare un'altra automazione** chiede che il proprietario possa
  gestirla, non solo vederla: errore di configurazione `unknown_ref` e, a
  runtime, `permission_lost` (`plans.ts` `planStart`, `reads.ts`
  `configErrorsOf`); il costruttore propone solo quelle che si gestiscono.
- **R-J22, «Ripeti finché»** resta col controllo prima di ogni giro (R-J4); il
  costruttore dice «If the condition is already true, the steps inside are
  skipped.» (shape `automation-builder.md` §6, 28 ott 2026).
- **R-J23, un solo vocabolario.** Lo stato acceso si chiama sempre «Active /
  Attiva» («Turn on» resta l'azione); righe e corsie di costruttore,
  dettaglio e registro usano le stesse frasi («If Claude says», «When the
  limit is reached», «For each task in …»), da `builder/flowWords.tsx`
  `laneLabel`.

## Ondata finale (28 ott 2026)

- File divisi (spostamenti puri): `dom/engine.ts` → `engineLoop.ts` (il
  ciclo) e `engineInputs.ts` (gli input); `d/writes.ts` → `runWrites.ts`
  (avvii a mano, decisioni, annulla/riprova/salta/tempo), `sourceWrites.ts`
  (sorgenti, eventi a mano, tabella cliente → progetto), `writeGuards.ts`;
  `d/simulate.ts` → `simulateExecute.ts` e `simulateView.ts`;
  `p/AutomationDetail.tsx` → `DetailHeader.tsx` e `DetailSections.tsx`.
- Motivazioni come codici (`RunLogEntry.why`, `automations.reasons.*` en/it,
  al condizionale nella prova): `reasons.test.ts` controlla che ogni codice
  scritto abbia le sue frasi. `reason` resta la prosa del registro.
- R-J13 lungo la catena (`reads.ts` `mailOrigin`), «Avvisa» coi permessi del
  proprietario, un solo ascoltatore in `AppLayout`
  (`useAutomationsLiveRefresh`, `runner.ts` `onAutomationsSettled`) che rilegge
  le aree quando le esecuzioni si fermano, anche dopo le scritture delle
  altre aree e dopo un fallimento scoperto da una lettura (R-J11).
- R-G5 nel flusso (`visibility.ts` `flowFor`/`keepHiddenProjects`),
  `approverIds` ricalcolato a lettura, `expectedPath` obbligatorio, l'email
  dalla casella salvata anche con più caselle.

## Buchi

- Il trascinamento col puntatore nel costruttore non ha test unitari
  (verificato in Chromium vero).
- `MAIL_HIDDEN` («Un'email ricevuta dal proprietario», al posto dell'email
  per chi non è il proprietario, R-J13) è un testo del livello dati in
  italiano: nell'interfaccia inglese si legge in italiano.
- Le date degli esempi della prova senza una data propria vengono dalla prima
  esecuzione nata da quell'evento (anche se chi prova non la vede: solo il
  giorno).
- Screenshot: `.impeccable/review/a7-*` (36 scene × chiaro/scuro × en/it a
  1440, più una a 1024); si rifanno con `node scripts/capture.mjs`
  (`CAPTURE_ONLY=<nome>` per una sola scena).
