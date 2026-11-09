# Shape brief — Sorgenti delle automazioni e tabella cliente → progetto

Superficie: pagina **Sources** della destinazione Automations
(`#/automations/sources`, dettaglio di una sorgente `?source=<id>` nel
pannello agganciato), con le sorgenti collegate (Audin, HubSpot, webhook
in arrivo), «Simulate an event» del prototipo, il contenuto d'esempio di
un webhook e i campi che ne derivano, e la **tabella cliente → progetto**.
Piano: Task 5 (dati: Task 1, 3). Spec: area 7 «Inizi», «In quale progetto
agisce», «Permessi», «Quanto è vero nel prototipo», «Stati», «Dati
finti». Il resto della destinazione è `automations.md`; la scelta
dell'inizio nel costruttore è `automation-builder.md`. Mondo: «Catalogo
numerato», modalità **Operate**. **[A n]** = scelta del brief, numerata in
fondo (numerazione propria di questo brief).

## 1. Lavoro e pubblico

- **Chi**: chi ha `integrations.manage` (preset admin; nel seme Matteo
  Conti). Non è chi costruisce le automazioni: è chi **apre la porta** da
  cui arrivano gli eventi, e chi tiene in ordine a quale progetto
  corrisponde ogni cliente.
- **Quando**: raramente — al primo collegamento, quando un accesso scade,
  quando arriva un cliente nuovo che non trova il suo progetto (un
  «scegli il progetto» in «Decide» lo ha fatto notare).
- **Stato d'animo**: cautela. Collegare un CRM vuol dire che eventi veri
  faranno partire lavoro vero; scollegarlo ferma automazioni di altri.
  Ogni azione deve dire **chi ne risente**.

## 2. Esito e prova

- **Azioni primarie**: collegare (o ricollegare) una sorgente; aggiungere
  un cliente alla tabella.
- **Successo**, a 1440×900:
  - lo stato di ogni sorgente si legge in parola (Connected / Expired /
    Disconnected) con chi l'ha collegata e quando è arrivato l'ultimo
    evento;
  - prima di scollegare so quali automazioni si fermeranno;
  - di un webhook vedo l'indirizzo, un contenuto d'esempio e i **campi**
    che le automazioni potranno usare, con etichette leggibili;
  - nella tabella, per ogni cliente, il progetto in codice + nome; un
    cliente senza progetto è la causa riconoscibile di un «scegli il
    progetto».
- **Verità del prodotto**:
  - i connettori sono **simulati** nel prototipo: lo si dice una volta,
    in modo onesto, senza fingere un OAuth;
  - contratti e trattative **non vivono in Stubwise**: la sorgente porta
    solo l'evento (cliente, prodotti, importo, documenti allegati);
  - un'automazione agisce solo nei progetti che il suo **proprietario**
    vede: la tabella può puntare a un progetto, ma se il proprietario non
    lo vede l'esecuzione chiede di sceglierlo.

## 3. Direzione scelta

- **Tesi**: un **quadro dei contatori** di casa: poche righe, ciascuna con
  la sua spia in parola, chi l'ha installata e cosa alimenta. Poi un
  **registro di corrispondenze** (cliente → progetto) come tabella
  semplice. Niente loghi a colori dei marchi: glifo monocromo lineare
  (come Google in Drive) e il nome in testo **[A 1]**.
- **Sequenza**: h1 «Sources» → frase 14px muted «Where the events that
  start automations come from.» → sezione **Connected sources**
  (`headline`) → sezione **Clients and projects** (`headline`).
- **Momento focale**: la riga di una sorgente scaduta (HubSpot nel seme),
  con «Expired» e «Reconnect» — l'unica cosa che chiede un'azione.

```
1440 · Sources, pannello di HubSpot aperto
┌rail┬column───────────┬ Sources                          ┬ HubSpot ─────────────┐
│    │ All automations │ Where the events that start…     │ ⚠ Expired on Oct 20  │
│    │ Runs in progress│ Connected sources  [Connect ▾]   │ AUT-2 can't start    │
│    │ Needs attention │ ◇ Audin   ● Connected  Matteo C. │ until it's reconnected│
│    │ Drafts          │   Deals won · last event 2 h ago │        [Reconnect]   │
│    │ ─────────────── │   Used by AUT-1, AUD-A1          │ CONNECTED BY          │
│    │▌Sources         │ ◇ HubSpot ⚠ Expired  Matteo C.   │ Matteo Conti · Sep 2  │
│    │                 │   Deals won · since Oct 20  [Reconnect]│ EVENTS IT BRINGS│
│    │                 │ ⇢ Ordini e-shop ● Connected      │ Deal won: client,     │
│    │                 │   Incoming webhook · used by AUT-3│ products, amount…    │
│    │                 │ ──────────────────────────────── │ USED BY               │
│    │                 │ Clients and projects  [Add client]│ AUT-2 Benvenuto…     │
│    │                 │ Client        Key        Project │ RECENT EVENTS         │
│    │                 │ Rossi Srl     rossi.it   AUD …   │ —                     │
└────┴─────────────────┴──────────────────────────────────┴──────────────────────┘
```

## 4. Ambito e confini

- **Dentro**: elenco delle sorgenti con stato; collega, ricollega,
  scollega; pannello di dettaglio (stato, chi, eventi recenti, campi,
  automazioni che la usano); webhook in arrivo (indirizzo, esempio,
  campi derivati); «Simulate an event» del prototipo; tabella cliente →
  progetto (aggiungi, cambia progetto, rimuovi); permessi.
- **Fuori**: la scelta dell'inizio e la mappatura dei campi dentro
  un'automazione (`automation-builder.md`); webhook **in uscita** (area
  9); connettori veri, credenziali, OAuth reali; contratti e trattative
  come oggetti di Stubwise.
- **Anti-obiettivi**: una pagina «marketplace delle integrazioni» con
  tessere colorate; un editor JSON come unico modo di capire un webhook;
  scollegare senza dire chi ne risente; mostrare dati economici del seme
  come se fossero veri (gli importi del seme sono etichettati come finti,
  come tutto il seme).

## 5. Stati e intervalli

- **Volumi**: 0–10 sorgenti (tipico 2–4); webhook con 1–60 campi, liste
  annidate fino a 2 livelli; tabella cliente → progetto 0–300 righe
  (ricerca sopra la tabella da 20 righe in su).
- **Stati di una sorgente** (parola + glifo, mai solo colore):
  - **Connected** / Collegata — punto pieno `positive`;
  - **Expired** / Scaduta — icona `warning` + «since Oct 20»: l'accesso va
    rinnovato; le automazioni che partono da lì non partono e mostrano un
    problema (`automations.md` §5);
  - **Disconnected** / Scollegata — cerchio vuoto `ink-faint`; la riga
    resta per sapere chi la usava, con «Connect».
- **Pagina**: caricamento (6 righe scheletro); errore «Couldn't load the
  sources» + «Retry» per sezione; vuoto delle sorgenti: «No sources
  connected yet. Connect a CRM or create an incoming webhook to start
  automations from outside events.» + **Connect a source**; vuoto della
  tabella: «No clients linked yet. When a general automation needs the
  client's project, it looks here.» + **Add client**.
- **Senza permesso** (`integrations.manage` assente): la voce «Sources»
  non c'è nella colonna, e `#/automations/sources` mostra la pagina «This
  page doesn't exist or you can't see it» (come R-G5) **[A 2]**. Nel
  costruttore, chi ha `automations.manage` vede comunque i **nomi e lo
  stato** delle sorgenti per scegliere l'inizio (`automation-builder.md`).
- **Cambio di persona** con il pannello aperto: se la persona nuova non
  ha il permesso, pagina R-G5; nessun dato della sorgente resta a schermo.

## 6. Interazione e layout

### Connected sources

- Testata della sezione: `headline` «Connected sources» + **Connect ▾**
  (primario) con il menu: «Audin», «HubSpot», «Incoming webhook».
- **Riga** 56px, due linee (stessa grammatica di `automations.md`):
  - linea 1: glifo monocromo (CRM: rombo ◇; webhook: freccia d'ingresso)
    · **nome** 14px («Audin», «HubSpot», «Ordini e-shop») · stato
    (glifo + parola) · avatar 20px + «Matteo Conti» (chi l'ha collegata)
    · azioni al passaggio: «Simulate an event» (prototipo), «⋯»;
  - linea 2 (13px muted): cosa porta e l'ultimo evento («Deals won ·
    last event 2 h ago»; «Incoming webhook · last event Oct 22»;
    scaduta: «Deals won · expired on Oct 20») · «Used by AUT-1, AUD-A1»
    (codici link; oltre 3: «Used by 5 automations» → elenco filtrato);
  - scaduta: **Reconnect** visibile sempre a destra, non solo al
    passaggio.
- Clic sulla riga → **pannello di dettaglio** agganciato 360px da 1200px
  (sotto, sovrapposto 400px), come il dettaglio task; Esc chiude; J/K
  sorgente precedente/successiva.

### Pannello di una sorgente (`?source=<id>`)

- Testata: glifo + nome (`headline` 20px), riga 12px «CRM · Audin» /
  «Incoming webhook»; «⋯» (Rename, Disconnect).
- Banner di stato se non collegata: scaduta → icona `warning` + «Access
  expired on Oct 20 · AUT-2 can't start until it's reconnected.» +
  **Reconnect**.
- Sezioni con `heading-group`, separate da filetti:
  - **CONNECTED BY**: «Matteo Conti · Sep 2» (e «Reconnected by… · Oct
    26» se è successo).
  - **EVENTS IT BRINGS** (CRM): «Deal won» con l'elenco dei **campi**
    in righe 28px — etichetta 14px · tipo 12px muted in parola («text»,
    «number», «date», «email», «person», «list of…», «file») · chiave
    tecnica solo in tooltip (`trattativa.prodotti`) **[A 3]**.
  - **USED BY**: le automazioni che partono da qui, righe con codice ·
    nome · stato.
  - **RECENT EVENTS**: ultimi 5, «Oct 26 09:12 · Deal won · Rossi Srl ·
    3 products» con a destra le esecuzioni che ha fatto partire («AUT-1
    #8») o «Started nothing» (nessuna automazione attiva, o in pausa). Un
    evento si apre in un riquadro con i suoi dati (etichetta → valore).
  - **Simulate an event** (prototipo, §sotto).
  - In fondo, **Disconnect** (testo `critical`).

### Collega, ricollega, scollega

- **Connect → Audin / HubSpot**: dialogo 440px «Connect Audin», con:
  - nota onesta, in un riquadro tratteggiato `rule-strong` intestato
    PROTOTYPE ONLY: «In this prototype the connection is simulated: no
    account is contacted.» **[A 4]**;
  - cosa Stubwise leggerà, in frasi: «Deals marked as won, with client,
    products, amount and attached documents. Nothing else is read, and
    nothing is written back to Audin.»;
  - «Connected as you (Matteo Conti). Automations of every project can
    start from it.»;
  - «Cancel» · **Connect**. Esito: la riga compare `Connected`, toast
    «Audin connected».
- **Reconnect**: stesso dialogo con titolo «Reconnect HubSpot»; la
  sorgente diventa di chi ricollega («Connected by» si aggiorna) **[A 5]**.
- **Disconnect**: dialogo 440px «Disconnect Audin?» con l'elenco delle
  automazioni **attive** che partono da qui («2 active automations start
  from Audin: AUT-1 Nuovo contratto, AUD-A1 Richiesta dati al cliente.
  They will show a problem and won't start until Audin is connected
  again.») · «Runs already in progress continue.» · «Events sent while
  disconnected are lost.» · **Disconnect** (`critical`). La riga resta,
  `Disconnected`, con «Connect».

### Webhook in arrivo

- **Connect → Incoming webhook**: dialogo 560px in due tempi.
  1. **Nome** («Ordini e-shop») → **Create**: nasce l'indirizzo.
  2. Il pannello della sorgente si apre già sul webhook nuovo, con
     «Paste an example» in evidenza.
- Nel pannello, sezioni del webhook:
  - **ADDRESS**: l'URL (`https://stubwise.example/hooks/in/…`, nel solo
    font del codice, una riga con ellissi a metà) · **Copy**; nota 12px
    muted «Send a POST with a JSON body to this address.»; «⋯»
    → «Generate a new address» con conferma («The old address stops
    working at once. Whoever sends to it must update it.») **[A 6]**.
  - **USED BY**: un webhook alimenta **una sola automazione** (lo spec:
    «un indirizzo per automazione»); finché nessuna lo usa: «Not used by
    any automation yet. Choose it as the start of an automation.»; usato:
    la riga dell'automazione. Un'automazione che lo usa già lo rende non
    selezionabile nel costruttore per altre **[A 7]**.
  - **EXAMPLE**: il contenuto d'esempio in un blocco di codice (JSON
    indentato, sola lettura, alto al massimo 320px con scorrimento) ·
    «Replace example» apre un'area di testo per incollarne uno nuovo; JSON
    non valido: «This isn't valid JSON: line 4, an extra comma» sotto
    l'area, il bottone resta spento.
  - **FIELDS** (derivati dall'esempio): tabella 32px per riga — **Label**
    (modificabile in posto, precompilata dalla chiave resa leggibile:
    `customer.email` → «Customer email») · **Type** (menu: Text, Number,
    Date, Email, Person, List, File; rilevato dall'esempio) · **Example
    value** (13px muted, ellissi) · chiave in tooltip. Le liste mostrano i
    campi interni rientrati («Items → Name, Quantity»). Sotto: «Fields
    are what automations can use from this webhook.»
  - Cambiare l'esempio con un'automazione che usa già dei campi: i campi
    spariti sono segnati con icona `warning` + «Used by AUT-3 · missing
    from the new example» e restano finché non si conferma; conferma:
    «AUT-3 uses 2 fields that the new example doesn't have. It will show
    a problem.» **[A 8]**.
  - **RECENT EVENTS** come per i CRM; un evento ricevuto con campi che
    non corrispondono ai tipi è scritto «Received with errors: “amount”
    isn't a number» e non fa partire nulla.

### Simulate an event (solo prototipo)

- Dove: nel menu della riga al passaggio e come sezione del pannello,
  sempre dentro il riquadro tratteggiato PROTOTYPE ONLY **[A 9]**.
- CRM: un elenco degli eventi del seme («Deal won · Rossi Srl · CRM +
  Dialer», «Deal won · Bianchi & Figli · Dialer», «Deal won · Verdi Spa ·
  CRM») con **Send** per riga. Webhook: «Send the example» e «Edit and
  send» (area di testo con l'esempio).
- Esito, in un toast con link: «Event sent · started AUT-1 #9 · Open»;
  più automazioni: «started 2 runs · Show»; nessuna: «Event sent ·
  no active automation starts from it» (e se ce n'è una in pausa:
  «AUT-2 is paused: events aren't recovered»). Sorgente scaduta o
  scollegata: il bottone è spento con tooltip «Reconnect HubSpot to
  receive events».

### Clients and projects

- Testata: `headline` «Clients and projects» · frase 13px muted «General
  automations use this table to find the client's project.» ·
  **Add client** (secondario).
- **Tabella** (righe 40px, `grid` con intestazioni): **Client** (nome 14px)
  · **Key** (come lo riconoscono le sorgenti: id del cliente su Audin /
  HubSpot o dominio email, 13px muted, con la sorgente in parola: «Audin ·
  C-1042», «Email domain · rossi.it») **[A 10]** · **Project** (codice
  600 tnum + nome muted) · **Added by** (avatar + nome, data in tooltip)
  · «⋯» al passaggio (Change project, Remove).
- Ordinamento per nome del cliente; ricerca sopra la tabella da 20 righe.
- **Add client**: riga in testa alla tabella in modifica (non un dialogo)
  **[A 11]**: Client (testo; suggerimenti dai clienti degli eventi
  recenti che non hanno ancora un progetto, in testa con «From recent
  events») · Key (sorgente ▾ + valore) · Project (menu di tutti i
  progetti che vedo, codice + nome, ricerca) · «Cancel» · **Add**.
  Chiave già presente: «rossi.it is already linked to AUD» sotto il
  campo, **Add** spento.
- **Progetto invisibile** a chi guarda (riga aggiunta da un altro verso
  un progetto che non vedo): la colonna Project dice «A project you can't
  see» `ink-faint`, senza codice né nome (R-G5); «⋯» offre solo
  **Remove** (con conferma che dice «You can't see the project it points
  to»), non «Change project» **[A 12]**.
- **Remove**: conferma 400px «Remove Rossi Srl? General automations won't
  find its project any more and will ask their owner to choose.» ·
  **Remove**.
- Nota fissa in fondo alla sezione (12px muted): «An automation acts
  only in projects its owner can see. If the owner can't see the linked
  project, the run asks them to choose.» — la verità del prodotto detta
  dove la si scrive.
- Dai «scegli il progetto» (`automations.md`, «Decide»): «Remember for
  Verdi Spa» aggiunge qui la riga, con «Added by» = chi ha scelto.

### 1024×680, tastiera, accessibilità

- Area 720px: nelle righe delle sorgenti cade il nome di chi ha collegato
  (resta l'avatar); in tabella cade «Added by»; il pannello è sempre
  sovrapposto 400px.
- J/K nelle righe (sorgenti e tabella), Enter apre il pannello / la
  modifica; ⌘C su un webhook selezionato copia l'indirizzo.
- Ogni riga ha un nome accessibile completo («HubSpot, expired since Oct
  20, connected by Matteo Conti, used by 1 automation»); i toast degli
  eventi simulati sono annunciati `polite`; lo stato è sempre in parola.

## 7. Vincoli e decisioni aperte

- Solo `data/queries.ts`: `listSources`, `listClientLinks`,
  `connectSource`/`disconnectSource`, `setClientLink`/`removeClientLink`,
  `simulateSourceEvent` (Task 3); nessuna rete.
- Le sorgenti **non hanno codice** di catalogo: sono poche, con un nome, e
  non si citano **[A 13]**.
- Il blocco JSON è l'unico testo monospace della pagina (è codice, come
  ammesso da DESIGN.md).
- Gli importi degli eventi del seme sono finti e il seme lo dichiara;
  nessun cliente reale.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 | Sources | Sorgenti |
| frase | Where the events that start automations come from. | Da dove arrivano gli eventi che fanno partire le automazioni. |
| stati | Connected · Expired · Disconnected | Collegata · Scaduta · Scollegata |
| azioni | Connect · Reconnect · Disconnect · Simulate an event | Collega · Ricollega · Scollega · Simula un evento |
| prototipo | In this prototype the connection is simulated: no account is contacted. | In questo prototipo il collegamento è simulato: nessun account viene contattato. |
| scollega | Runs already in progress continue. · Events sent while disconnected are lost. | Le esecuzioni già partite continuano. · Gli eventi mandati mentre è scollegata vanno persi. |
| webhook | Send a POST with a JSON body to this address. · Paste an example · Fields are what automations can use from this webhook. | Manda una POST con un corpo JSON a questo indirizzo. · Incolla un esempio · I campi sono ciò che le automazioni possono usare di questo webhook. |
| tipi | Text · Number · Date · Email · Person · List · File | Testo · Numero · Data · Email · Persona · Elenco · File |
| simula | Event sent · started {{code}} · No active automation starts from it | Evento mandato · è partita {{code}} · Nessuna automazione attiva parte da qui |
| tabella | Clients and projects · Add client · A project you can't see | Clienti e progetti · Aggiungi cliente · Un progetto che non vedi |
| nota | An automation acts only in projects its owner can see. | Un'automazione agisce solo nei progetti che il suo proprietario vede. |

## Scelte del brief da confermare

1. **[scelta del brief]** Nessun logo a colori dei marchi: glifo
   monocromo (rombo per i CRM, freccia per i webhook) e nome in testo.
2. **[scelta del brief]** Senza `integrations.manage` la pagina non
   esiste (né voce né rotta, pagina R-G5); i nomi e lo stato delle
   sorgenti si vedono solo nel costruttore, a chi ha `automations.manage`.
3. **[scelta del brief]** I campi si mostrano con etichetta e tipo in
   parola; la chiave tecnica solo in tooltip.
4. **[scelta del brief]** Il collegamento di Audin/HubSpot è un dialogo
   che dichiara la simulazione nel riquadro PROTOTYPE ONLY, invece di una
   finta schermata OAuth.
5. **[scelta del brief]** Chi ricollega una sorgente ne diventa «chi
   l'ha collegata» (come il proprietario di un'automazione).
6. **[scelta del brief]** L'indirizzo del webhook si può rigenerare, con
   conferma che dice che il vecchio smette subito di funzionare.
7. **[scelta del brief]** Un webhook alimenta una sola automazione: si
   crea nelle Sorgenti, si sceglie nel costruttore, e una volta usato non
   è selezionabile per altre.
8. **[scelta del brief]** Sostituire l'esempio di un webhook usato
   segnala i campi spariti e chiede conferma; l'automazione che li usava
   mostra un problema.
9. **[scelta del brief]** «Simulate an event» sta nel menu della riga e
   nel pannello, sempre nel riquadro tratteggiato PROTOTYPE ONLY, con un
   toast che dice quali esecuzioni sono partite (o perché nessuna).
10. **[scelta del brief]** La chiave di un cliente è per sorgente (id su
    Audin/HubSpot) o un dominio email; una chiave punta a un solo
    progetto.
11. **[scelta del brief]** «Add client» è una riga in modifica in testa
    alla tabella, con i clienti degli eventi recenti senza progetto come
    suggerimenti.
12. **[scelta del brief]** Una riga che punta a un progetto che non vedo
    si mostra «A project you can't see» e si può solo rimuovere.
13. **[scelta del brief]** Le sorgenti non hanno un codice di catalogo.
