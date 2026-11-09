# App desktop Stubwise, area 7: Automations — design

Data: 26 ott 2026. Settimo documento della serie (ossatura
`docs/plans/2026-10-23-desktop-ossatura-design.md`, aree 2–6 accanto). Si
costruisce nel prototipo `apps/desktop` con dati finti, con le stesse
regole: ogni pagina definita fino in fondo, stati veri, permessi verificati
col «vedi come». Linguaggio visivo `apps/desktop/DESIGN.md`; UI e UX
definite con Impeccable (shape → costruzione → revisione).

Le decisioni marcate *(maintainer)* vengono dalla conversazione; quelle
marcate *(scelta del costruttore)* sono proposte confermabili.

## Perché

Ci sono processi che si ripetono e oggi si fanno a mano *(maintainer)*:

1. **Contratto chiuso → task per tutti.** Quando il commerciale chiude un
   contratto, qualcuno crea a mano le task per le persone coinvolte. È lungo
   e tedioso, e le cose da fare dipendono da cosa si è venduto: sono sempre
   le stesse.
2. **Richieste al cliente.** Per attivare una funzione di un contratto
   servono informazioni dal cliente: gli si scrive, e se non risponde entro
   un tot gli si ricorda. Quando risponde, qualcuno deve controllare che
   abbia mandato tutto.

Sono esempi: serve **un motore** con cui gestire tanti processi diversi, non
due funzioni fisse *(maintainer)*. Il web non ha nulla di simile: l'area non
ha parità da chiudere.

## Obiettivi

- **Un motore di automazioni**: un inizio (evento) e una sequenza di passi,
  con condizioni e ramificazioni *(maintainer)*.
- **Facili da costruire e facili da provare** *(maintainer)*: un costruttore
  comprensibile anche a chi non è tecnico, e una **simulazione** su un
  evento di esempio che mostra passo per passo cosa succederebbe senza
  effetti reali, prima di accendere *(maintainer)*.
- **Passi di Claude** che leggono un documento o una risposta e ne ricavano
  dati o scelte (es. le task da un contratto; «il cliente ha mandato tutto?»)
  *(maintainer)*.
- **Approvazione per passo**: ogni passo che produce un effetto può partire
  da solo o aspettare che qualcuno lo approvi; si configura nel passo
  *(maintainer)*.
- **Esecuzioni visibili** dove servono: pagina Automations, progetto,
  traguardo creato *(maintainer)*.
- **Sorgenti esterne** (Audin, HubSpot, webhook in arrivo) collegate da chi ha
  il permesso *(maintainer)*.

## Non obiettivi

- **Claude che costruisce o prova le automazioni**: si fa nella fase finale
  sull'integrazione di Claude nell'app *(maintainer)*. Il motore deve però
  avere una forma che Claude potrà scrivere (vedi «Lasciato al costruttore»).
- **Webhook in uscita**: area 9 (amministrazione).
- **Connettori veri**: Audin, HubSpot e webhook sono simulati.
- **Codice scritto dall'utente** (script, espressioni libere): le condizioni
  si compongono con campi e operatori.

## Anti-obiettivi *(maintainer)*

**Un'automazione che esce dai binari**: un'approvazione saltata, un controllo
ignorato, Claude che fa qualcosa che il passo non prevedeva. Ne discendono
tre regole *(scelta del costruttore, dalla paura del maintainer)*:

1. **Un'approvazione blocca davvero.** Un passo con approvazione non parte
   finché qualcuno con il diritto non approva; nessun percorso lo scavalca
   (né un riavvio, né un'altra automazione, né la simulazione).
2. **Claude sceglie solo fra le strade disegnate.** Un passo di Claude legge e
   restituisce: una delle uscite previste dal passo, e/o i campi che il passo
   chiede di compilare (con il loro tipo). Non esegue azioni: le azioni sono
   solo i passi del flusso. Un'uscita fuori dall'elenco o un campo non valido
   è un **errore del passo**, non un'improvvisazione.
3. **Tutto tracciato.** Ogni esecuzione registra cosa ha fatto ogni passo,
   con quali dati, perché (le scelte di Claude con la motivazione), chi ha
   approvato e quando.

## Il modello

### Automazione

- Nome, descrizione, **progetto facoltativo** *(maintainer: legata a un
  progetto oppure generale)*, proprietario, stato: **bozza**, **attiva**,
  **in pausa**.
- **Inizio** (un solo evento per automazione) e **passi** (una sequenza con
  ramificazioni).
- **Versioni** *(scelta del costruttore)*: accendere pubblica la versione
  corrente; modificare un'automazione attiva crea una bozza della versione
  successiva, e le esecuzioni in corso finiscono con la versione con cui
  sono partite.

### In quale progetto agisce *(maintainer)*

- Un'automazione **di progetto** crea le cose nel suo progetto.
- Un'automazione **generale** ricava il progetto **dai dati dell'evento**:
  il passo dice «nel progetto del cliente» e Stubwise lo trova con una
  **tabella cliente → progetto** (gestita nelle sorgenti, da chi ha
  `integrations.manage`); in alternativa il passo fissa un progetto. Se il
  progetto non si trova, il passo si **ferma** e chiede a una persona (il
  proprietario) di sceglierlo: è un'attesa come le approvazioni, in «Da
  decidere».
- Le esecuzioni di un'automazione generale compaiono anche nella pagina del
  progetto in cui hanno agito.

### Inizi (eventi)

- **Sorgenti esterne** *(maintainer)*: contratto/trattativa chiusa su Audin o
  HubSpot (con prodotti, cliente, importo, documenti allegati); webhook in
  arrivo (un indirizzo per automazione, con un esempio di contenuto per
  ricavarne i campi).
- **Eventi di Stubwise** *(scelta del costruttore)*: task creata o chiusa,
  richiesta creata, traguardo raggiunto, email in arrivo che corrisponde a un
  filtro (dalla Posta dell'area 6, solo caselle di chi possiede
  l'automazione), una data o una ricorrenza (ogni lunedì alle 9…), avvio a
  mano.
- Ogni inizio porta dei **dati** con nomi e tipi (es. `trattativa.prodotti`,
  `cliente.email`): sono quello che i passi successivi possono usare.

### Passi

- **Crea task** (titolo, descrizione, incaricato, scadenza relativa,
  progetto, traguardo). L'incaricato *(scelta del costruttore)* è: una
  persona; **un reparto** = task senza incaricato con quel reparto (il
  `departmentId` che le task hanno già), che il reparto vede fra le sue da
  prendere; **«chi ha il ruolo X nel progetto»** = la prima persona con quel
  ruolo in ordine alfabetico, e se nessuno ce l'ha la task nasce senza
  incaricato con un avviso nel registro.
- **Crea traguardo** *(maintainer: raggruppa le task della stessa cosa, il
  ruolo delle epiche)*.
- **Crea richiesta** (backlog).
- **Manda email** al cliente o a chiunque (da una casella collegata, con un
  testo con campi, allegati).
- **Aspetta**: un tempo («3 giorni»), una risposta all'email mandata, una
  task chiusa, oppure il primo dei due («la risposta, al massimo 5 giorni»).
- **Claude**: un'istruzione, gli input che può leggere (documenti
  dell'evento, la risposta del cliente, file del Drive del progetto), e cosa
  restituisce: un elenco di **uscite** (es. «tutto presente», «mancano
  informazioni») e/o **campi** (es. un elenco di task, il testo di una
  risposta). Vedi la regola 2.
- **Condizione**: ramifica su dati dell'evento o dei passi precedenti con
  operatori semplici (è, non è, contiene, è vuoto, maggiore di…).
- **Per ogni**: ripete i passi interni per ogni elemento di un elenco (es.
  per ogni prodotto venduto, per ogni task ricavata da Claude).
- **Ripeti finché** *(scelta del costruttore: serve al promemoria e alla
  richiesta delle parti mancanti)*: ripete i passi interni finché una
  condizione è vera, con un **massimo obbligatorio** di giri (es. «fino a 2
  promemoria»); finito il massimo esce dall'uscita «limite raggiunto». Il
  flusso resta un **albero** (niente salti all'indietro): ogni ciclo è un
  «Ripeti finché» o un «Per ogni», e la simulazione e il registro li
  mostrano giro per giro.
- **Avvia un'altra automazione** *(dall'ossatura)*.
- **Avvisa** una persona (notifica nell'app).

**In pausa** *(scelta del costruttore, dall'anti-obiettivo)*: nessun nuovo
inizio, e le esecuzioni in corso si **sospendono** prima del passo
successivo (stato «sospesa»); riaccendendo riprendono da lì. Un evento
arrivato durante la pausa non viene recuperato.

Ogni passo che produce un effetto (crea, manda, avvia, avvisa) ha
l'impostazione **«Parte da solo» / «Chiede approvazione a …»** *(maintainer)*
con chi approva (persona, ruolo nel progetto, il proprietario).

### Esecuzione

- Ogni volta che un'automazione parte nasce un'**esecuzione** con un titolo
  (es. «Attivazione CRM – Rossi Srl», dal modello del titolo
  dell'automazione), lo stato (in corso, in attesa di approvazione, in
  attesa di un evento, finita, fallita, annullata) e il **registro** dei
  passi.
- Un'esecuzione può durare giorni (aspetta il cliente) e riprende da sola.
- Si può **annullare**; un passo fallito si può **riprovare** o **saltare**
  (chi ha il permesso), e lo dice nel registro.
- Le **approvazioni in attesa** entrano nel «Da decidere» della Home di chi
  deve approvare *(scelta del costruttore: l'ossatura vuole lì ogni
  decisione)*, con «Approva» e «Rifiuta» (rifiutare segue l'uscita «rifiutato»
  del passo, o ferma l'esecuzione se il passo non ne ha una). Un'email da
  approvare si può correggere prima di approvarla.

### Simulazione *(maintainer)*

- Dal costruttore: «Prova» con un **evento di esempio** (uno reale recente
  della sorgente, scelto da un elenco, oppure uno scritto a mano).
- Mostra passo per passo cosa succederebbe: le task che nascerebbero (con
  incaricati e scadenze), le email che partirebbero (testo completo), le
  scelte di Claude con la motivazione, le attese, i rami presi.
- **Nessun effetto reale**: niente task, email, notifiche, avvii. Le attese
  si saltano con «Avanti» (o si simula la risposta del cliente scrivendola).
- Le approvazioni si mostrano come «qui si fermerebbe per l'approvazione di
  …» e si possono approvare per proseguire la prova.
- Si accende solo dopo, con un'azione esplicita.

## Codici *(scelta del costruttore)*

- Automazione di progetto `<PRJ>-A<n>` (es. `AUD-A3`), generale `AUT-<n>`;
  stabili, mai riusati.
- Esecuzione: il codice dell'automazione più `#<n>` (es. «AUD-A3 #12»),
  numerata per automazione.
- Codici scritti a mano diventano link se visibili; nascosto e inesistente
  sono identici (R-G5).

## Dove si vede *(maintainer: più posti, dove serve)*

- **Automations** (destinazione sul binario): elenco delle automazioni
  (filtri: progetto, stato, proprietario), costruttore, esecuzioni (in corso
  in alto), sorgenti collegate.
- **Progetto**: le automazioni del progetto e le loro esecuzioni (una
  sezione o un pannello nella panoramica, *scelta del costruttore*).
- **Traguardo** e **task** create da un'esecuzione: «Creata
  dall'automazione X · esecuzione Y» con il link.
- **Home**: approvazioni in «Da decidere»; un blocco «Automazioni» dal
  catalogo (esecuzioni in corso che mi riguardano) *(scelta del
  costruttore)*.
- **⌘K**: cerca automazioni ed esecuzioni; azione «Nuova automazione».

## Permessi *(maintainer: «chi ha il permesso»; nomi del costruttore)*

- **`automations.manage`** (progetto): creare, modificare, accendere e
  spegnere le automazioni del progetto; riprovare/saltare/annullare le loro
  esecuzioni. Preset: Project Lead.
- **`automations.manage`** (istanza, per quelle generali). Preset: admin.
- **`integrations.manage`** (istanza, già esistente): collegare e scollegare
  Audin, HubSpot, webhook in arrivo *(maintainer: chi ha i permessi
  necessari)*.
- **Vedere**: le automazioni di un progetto le vedono i membri; le generali
  chi ha il permesso d'istanza. Le esecuzioni seguono la loro automazione.
- **Proprietario = chi l'ha accesa** *(scelta del costruttore)*: un campo
  solo. Accenderla, riaccenderla o pubblicarne una versione nuova la fa
  diventare di chi lo fa, e il dialogo lo dice («Da adesso agisce con i tuoi
  permessi e la tua casella»).
- **Un'automazione agisce col permesso del proprietario**: se crea task in un progetto, chi l'ha accesa deve poterlo
  fare; se perde il permesso, il passo fallisce con «permesso perso» invece
  di agire. Le email partono da una casella di chi l'ha accesa (privacy della
  Posta: nessuna automazione legge la posta di altri).
- **Approvare** un passo: chi è indicato nel passo; un approvatore che non
  vede il progetto non riceve la richiesta (la configurazione lo segnala).

## Quanto è vero nel prototipo *(scelta del costruttore)*

- Sorgenti, webhook ed eventi esterni sono finti: un pulsante «Simula un
  evento» nella sorgente ne fa arrivare uno del seme.
- Le esecuzioni avanzano con ritardi simulati; le attese di giorni si
  accorciano con «Fai passare il tempo» nel dettaglio dell'esecuzione (solo
  prototipo).
- I passi di Claude rispondono con testi finti deterministici, con lo stesso
  streaming della conversazione.
- Le email «partono» nella Posta finta dell'area 6 (compaiono come inviate) e
  la risposta del cliente si può simulare.

## Stati

Ogni pagina: caricamento, vuoto (con «Nuova automazione» se permesso, e i
modelli), errore con «Riprova», pieno, senza permessi. Automazione: bozza,
attiva, in pausa, con errori di configurazione (un passo incompleto, un
approvatore che non vede il progetto, una sorgente scollegata). Esecuzione:
gli stati sopra. Sorgente: collegata, scaduta, scollegata.

## Dati finti

- Audin collegato con trattative chiuse di esempio (prodotti diversi,
  contratto PDF allegato), HubSpot scaduto, un webhook in arrivo.
- Automazione **«Nuovo contratto»** (attiva, generale o su un progetto
  commesse): da trattativa chiusa → Claude legge il contratto e i prodotti →
  traguardo «Attivazione <prodotto> – <cliente>» → per ogni task ricavata,
  crea task assegnata al reparto giusto; una email di benvenuto con
  approvazione.
- Automazione **«Richiesta dati al cliente»**: email di richiesta → aspetta
  la risposta (max 5 giorni) → promemoria (fino a 2) → Claude verifica la
  risposta → «tutto presente»: crea la task di attivazione; «mancano»: email
  con le parti mancanti (con approvazione) e torna ad aspettare.
- Esecuzioni: una in corso in attesa del cliente da 3 giorni, una ferma su
  un'approvazione, una finita, una fallita (permesso perso).
- Una bozza mai accesa; un'automazione in pausa; persone con e senza
  permesso per il «vedi come».

## Lasciato al costruttore

- Forma visiva del costruttore (lista verticale di passi con rami annidati,
  o grafo), purché leggibile da chi non è tecnico (shape Impeccable).
- Formato interno del flusso: un documento dichiarativo (JSON) che un domani
  Claude potrà scrivere e validare.
- Catalogo di modelli pronti (i due esempi come modelli).
- Limiti di sicurezza (numero massimo di email per esecuzione, di
  ripetizioni di un «per ogni», di esecuzioni contemporanee) con valori
  sensati.

## Decisioni aperte

Nessuna.
