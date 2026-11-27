# Shape brief — ⌘K: i risultati aperti di recente

> Mini-shape scritta da 72 il 27 nov 2026, senza intervista: il maintainer
> ha deciso di FARE le ricerche recenti nella ⌘K (ritiro del web vecchio,
> inventario §1.6). Le scelte che il maintainer deve confermare sono marcate
> **[SR n]** e raccolte in fondo. Segue l'ossatura (`2026-10-23-desktop-
> ossatura-design.md`, «Ricerca e comandi») e la ⌘K com'è
> (`palette/CommandPalette.tsx`).

## 1. Cosa si ricorda

- **I risultati APERTI, non le parole digitate.** È ciò che il server
  salva già (`search_history`, `POST /api/search/history`): una voce per
  persona e per oggetto, aggiornata a ogni nuova apertura. Una query
  scritta e poi lasciata non lascia traccia. **[SR 1]**
- **Solo quattro tipi**, quelli che il server conosce: **task**
  (`ticket`), **progetto**, **spazio Docs** (`repository`) e **pagina
  Docs** (`doc`). Il resto della ⌘K non si ricorda in questa versione:
  persone, file, canali e messaggi della Chat, automazioni, rilasci,
  Support, server, pagine dello spazio Prodotto e azioni. Allargare
  l'elenco vuol dire cambiare l'enum del server. **[SR 2]**
- **La posta MAI**: è un'invariante (CLAUDE.md, «La posta NON entra nella
  cronologia della ricerca», una scelta di retention prima che di enum).
  Non si aggiunge nemmeno se un giorno l'enum si allargasse.
- Si ricorda solo un risultato aperto **dalla ⌘K**: una task aperta dalla
  lista Tasks o da un link non entra.
- Il server poi filtra a lettura: una voce di un progetto che chi guarda
  non vede più (o senza `tickets.view_all`, `docs.view`, `repos.view`)
  sparisce dai recenti senza che la riga si cancelli. La pagina non deduce
  niente.

## 2. Dove e quante

- **A query vuota, in testa alla ⌘K**: un gruppo **RECENT** / **RECENTI**
  (`heading-group`), prima di Projects e Actions. Appena si scrive qualcosa
  il gruppo sparisce e restano i risultati della ricerca.
- **Al più 5 righe**, come ogni gruppo della ⌘K (`GROUP_LIMIT`). Il server
  ne dà 8 e ne tiene 20 per persona: le altre restano là, e ricompaiono
  quando se ne tolgono alcune. **[SR 3]**
- **Nello scope di uno spazio Docs** (la ⌘K aperta dentro uno spazio, Tab
  per allargare) i recenti sono quelli **di quello spazio**: è il filtro
  `repositoryId` del server.
- Nessun recente: il gruppo non c'è. Niente frase vuota, la ⌘K è quella
  di sempre.

## 3. La riga

- È la riga di un risultato com'è oggi: il codice in tnum (`AUD-9`,
  `AUD-D12`), il titolo e, in `ink-muted`, il dettaglio salvato (il
  progetto della task, lo spazio della pagina). Enter o clic la riapre, e la
  voce torna in cima.
- **Togliere una voce**: un bottone ✕ a destra della riga, visibile al
  passaggio e sulla riga selezionata, con `aria-label` «Remove “<titolo>”
  from recent» / «Togli “<titolo>” dai recenti». Da tastiera,
  **⌘⌫** sulla riga selezionata, scritto nella barra dei tasti in fondo
  («⌘⌫ to remove») solo quando la riga selezionata è un recente. La riga
  esce subito, e la selezione passa alla riga dopo. **[SR 4]**
- **Clear all** / **Svuota**: un bottone di testo a destra
  dell'intestazione del gruppo. Svuota tutti i recenti di chi guarda, anche
  quelli oltre i 5 visibili. **Senza conferma e senza Annulla**: è una
  cronologia personale, la perdita è piccola, e il server non sa
  ripristinarla. **[SR 5]**
- **La riga sulla privacy**, una sola, `text-xs ink-faint`, sotto
  l'ultima voce del gruppo: «Only you see these: the results you opened, kept
  for your account.» / «Li vedi solo tu: i risultati che hai aperto,
  salvati per il tuo account.»

## 4. Come si apre una voce

- La voce si apre **dal suo indirizzo nella nuova app**: alla registrazione
  la ⌘K salva come `route` l'indirizzo che il risultato ha già (`#/p/AUD/
  tasks?task=AUD-9`, …).
- **Le voci del web vecchio** (con `route` tipo `/tickets/<id>`) **non si
  mostrano** nella nuova app: hanno un indirizzo che non porta da nessuna
  parte, escono dai 20 con l'uso, e il web vecchio sparirà. **[SR 6]**

## 5. Stati ed errori

- La lettura dei recenti è **accessoria**: se fallisce il gruppo non
  c'è, senza errore. La ⌘K non si ferma per lei.
- Registrare un'apertura è **fail-open e silenzioso**: l'apertura avviene
  comunque.
- Togliere una voce o svuotare che non riesce: la riga resta (o tornano
  tutte), con il toast «Couldn't remove it from recent.» / «Impossibile
  toglierlo dai recenti.» Niente Retry: si riprova col gesto.

## 6. Nel prototipo

- Il prototipo non ha server: i recenti stanno nello stato finto
  (`state.searchHistory`), **per persona**, con le stesse regole: 5 a
  vista, 20 tenuti, una voce per oggetto, il filtro dei permessi a lettura,
  la posta mai. «Vedi come» mostra i recenti di quella persona. `resetApi`
  li azzera.
- Il seme ne dà **3 a Laura** (una task, un progetto, una pagina Docs),
  così la ⌘K a query vuota li mostra subito. Le altre persone partono
  vuote. Il build «app» non contiene il seme (`check-no-seed`), come per il
  resto.

## Note d'implementazione (28 nov 2026)

- Approvata dal maintainer il 27 nov 2026 così com'è ([SR 1]–[SR 6]).
- Il codice della riga (`AUD-9`, `AUD-D12`) viaggia nel `subtitle` del
  server: la riga è codice + titolo, senza un dettaglio in più.
- Gli spazi Docs (`repository`) restano fra i tipi letti, ma la ⌘K oggi non
  ha righe per uno spazio: in pratica si ricordano task, progetti e pagine
  Docs. Una pagina Docs si registra come `<repositoryId>:<slug>`, così due
  spazi con lo stesso slug non si scontrano.

## Le scelte da confermare

- **[SR 1]** Si ricordano i risultati aperti, non le query. Alternativa:
  anche le query digitate, ma il server non le salva (serve una tabella o
  un tipo nuovo).
- **[SR 2]** Quattro tipi (task, progetto, spazio e pagina Docs), quelli
  del server. Allargare a persone, file e Chat è un cambio del server.
- **[SR 3]** 5 righe a vista, come gli altri gruppi. Alternativa: le 8 che
  il server dà.
- **[SR 4]** ✕ sulla riga e ⌘⌫ da tastiera.
- **[SR 5]** «Clear all» senza conferma né Annulla.
- **[SR 6]** Le voci registrate dal web vecchio non si mostrano.
