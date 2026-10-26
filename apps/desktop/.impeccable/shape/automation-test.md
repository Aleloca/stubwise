# Shape brief — La prova di un'automazione (simulazione)

Superficie: `pages/automations/test/*`, la **modalità prova** del
costruttore, rotta `#/automations/<code>/test` **[A 1]**, aperta da «Test»
nella testata del costruttore (`automation-builder.md`) e dal dettaglio di
un'automazione (`automations.md`, «Test this version»). Piano: Task 7 (dati:
Task 4, `startSimulation` / `simulationStep` / `getSimulation` /
`endSimulation`, stesso motore `advance` del Task 2 con un esecutore finto).
Spec: area 7 «Simulazione», «Anti-obiettivi» (regola 1: la simulazione non
scavalca un'approvazione reale), «Esecuzione». Mondo: «Catalogo numerato»,
modalità **Operate**, con un tratto di **Read** (le email e le motivazioni
di Claude in anteprima). **[A n]** = «[scelta del brief]», numerata in fondo.

## 1. Lavoro e pubblico

- **Chi**: chi sta costruendo o modificando un'automazione (ha
  `automations.manage` sul suo perimetro) — lo stesso pubblico del
  costruttore, quasi sempre **non tecnico**. Prova prima di accendere, e
  riprova dopo ogni ritocco.
- **Quando**: subito dopo aver scritto i passi, e prima di «Turn on» /
  «Publish». A volte per capire un'automazione di altri prima di
  modificarla.
- **Stato d'animo**: «fammi vedere cosa farebbe, senza combinare guai».
  Due paure da sciogliere insieme: **che succeda qualcosa di vero**
  (un'email al cliente, venti task nei progetti) e **di non capire** cosa
  è successo e perché.

## 2. Esito e prova

- **Azione primaria**: scegliere un evento di esempio, far avanzare la
  prova fino alla fine, leggere cosa sarebbe nato, poi tornare a
  correggere o accendere.
- **Successo** a 1440×900, provando «Nuovo contratto» sulla trattativa
  Audin «Rossi Srl»:
  - in ogni momento è evidente, senza leggere note, che **è una prova**;
  - il flusso è **lo stesso elenco del costruttore** e si accende passo
    dopo passo: si vede dove si è, quali rami sono stati presi e quali no;
  - ogni passo che «farebbe» qualcosa mostra un'**anteprima completa** —
    la task con titolo, incaricato risolto, scadenza in data, progetto;
    l'email con mittente, destinatari, oggetto, testo e allegati; la
    scelta di Claude con la sua **motivazione**;
  - le attese di giorni si superano con «Skip ahead» o scrivendo la
    risposta del cliente;
  - le approvazioni fermano la prova come fermerebbero l'esecuzione vera,
    e dicono chi approverebbe davvero;
  - alla fine, un **riepilogo** «Would create 1 milestone and 6 tasks,
    send 1 email» e, solo allora, **Turn on**.
- **Verità del prodotto**:
  - **Nessun effetto reale** (Task 4): nessuna task, traguardo, richiesta,
    email, notifica, avvio di altre automazioni, riga nel registro delle
    esecuzioni vere. La prova lo dice con le **parole** (tutto al
    condizionale: «Would create», «Would send») e con la **forma** (una
    fascia di prova fissa, nessun codice inventato).
  - **Stesso motore**: la prova percorre esattamente i rami e i limiti
    dell'esecuzione vera; se la vera fallirebbe, la prova fallisce allo
    stesso passo con lo stesso motivo.
  - **Approvare nella prova non approva niente**: sblocca solo la prova.
    L'esecuzione vera aspetterà comunque chi è indicato nel passo
    (regola 1).

## 3. Direzione scelta

- **Tesi**: **la procedura che si accende**. La prova non è una pagina
  nuova con un'altra forma: è il costruttore che passa in modalità
  lettura, con l'elenco numerato degli stessi passi a sinistra e, al posto
  del pannello del passo, il **pannello dell'anteprima** del passo
  corrente. Chi ha appena scritto il flusso lo ritrova uguale, con i
  numeri uguali, e lo vede percorrere **[A 2]**.
- **Topologia** (binario 64 · colonna 240 · area di lavoro, come il
  costruttore):
  - **Fascia di prova**, sotto la testata e a tutta larghezza dell'area di
    lavoro, fissa: glifo «provetta» + «TEST» (heading-group) + «Nothing here
    is real. No tasks, emails or notifications are created.» + a destra
    «What a test can't do» (popover: non legge davvero il Drive, non
    controlla le caselle; Claude risponde come risponderebbe sull'evento
    scelto). Tinta d'inchiostro 6% con bordo inferiore `rule-strong`; non
    gialla né rossa: non è un avviso, è lo stato della pagina **[A 3]**.
  - **Testata**: «← Back to editing» · h1 «Test: Nuovo contratto» con
    codice tnum · riga meta «Version 3 (draft) · Example: Deal won · Rossi
    Srl · Oct 24» con «Change example» · a destra, i comandi della prova
    (§6) e, solo a prova finita, **Turn on** / **Publish version 3**.
  - **Flusso** (sinistra, 520–760px): l'elenco del costruttore in sola
    lettura (niente «+», niente maniglie), con i **segni di percorso** su
    ogni riga (§5) e la riga corrente evidenziata.
  - **Pannello anteprima** (destra, 400–560px, agganciato): l'anteprima
    del passo selezionato (di default il corrente), con in fondo, quando la
    prova è ferma, le **azioni della fermata** (Skip ahead, Write the
    reply, Approve in the test…).
  - **Riepilogo** (sotto il flusso, sempre visibile in fondo all'elenco):
    «So far: would create 1 milestone, 3 tasks · would send 0 emails» con
    i conteggi che crescono; a fine prova diventa il riepilogo finale.
- **Sequenza**: scegli l'esempio → la prova parte e si ferma subito al
  primo passo (non corre da sola) → «Next step» uno alla volta, oppure
  «Run to next stop» → si ferma ad attese, approvazioni, scelte del
  progetto, errori, fine → fine con riepilogo e «Turn on».
- **Momento focale**: la **fermata** — il passo corrente con il pannello
  che dice cosa succederebbe ora e il bottone che sblocca la prova («Skip
  ahead 3 days», «Approve in the test»), e accanto, in una riga, cosa
  succederebbe **davvero** («In a real run, this waits for Laura Costa.»).

```
┌─work area────────────────────────────────────────────────────────────────────────┐
│ ← Back to editing                                                                │
│ Test: Richiesta dati al cliente  AUD-A1                                          │
│ Version 2 · Example: written by hand · Change example                            │
│                                    [Restart] [Next step ⏎] [Run to next stop]    │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ⚗ TEST  Nothing here is real. No tasks, emails or notifications are created.    │
├────────────────────────────────────────────────┬─Step 3 · Wait ──────────────────┤
│ ✓ When someone starts it   Rossi Srl           │ Would wait for a reply to the   │
│ ✓ 1 Send email “Information for activating…”   │ email from step 1, at most      │
│ ↻ 2 Repeat until {Reply received} · at most 2  │ 5 days.                         │
│ │ ROUND 1 OF 2                                 │                                 │
│ │ ● 3 Wait for a reply to step 1, at most 5 d  │ In a real run, the client's     │
│ │   4 Send reminder to {Client email}          │ answer arrives by email.        │
│ │ WHEN THE LIMIT IS REACHED  · not reached yet │                                 │
│ │   5 Notify the owner                         │ [Write the client's reply]      │
│   6 Claude checks the reply                    │ [Skip ahead 5 days — no reply]  │
│   …                                            │                                 │
│ ─────────────────────────────────────────────  │                                 │
│ So far: would send 1 email                     │                                 │
└────────────────────────────────────────────────┴─────────────────────────────────┘
```

- **Conseguenza per chi costruisce**: riusa `FlowList` del costruttore con
  una variante `mode="test"` (segni di percorso, nessuna modifica) e un
  `PreviewPanel` con un'anteprima per tipo di effetto. Le anteprime di task
  ed email sono le **stesse forme** usate dal registro di un'esecuzione
  (`automations.md`) e dall'approvazione in «Da decidere»: una sola
  anteprima di email, una sola di task.

## 4. Ambito e confini

- **Dentro**: scelta dell'evento di esempio (dalla sorgente o a mano);
  avanzamento passo per passo e fino alla prossima fermata; anteprime di
  task, traguardi, richieste, email, avvisi, avvii; scelte di Claude con
  motivazione e campi; attese con «Skip ahead» e risposta scritta;
  approvazioni (approva / rifiuta nella prova, con correzione dell'email);
  «Choose a project» quando il cliente non è in tabella; errori (Claude
  fuori dai binari, limiti, permessi); riepilogo; ricomincia, cambia
  esempio, torna a modificare; «Turn on» / «Publish» a prova finita;
  problemi di configurazione che impediscono di partire.
- **Fuori**: le esecuzioni vere e il loro registro (`automations.md`);
  modificare il flusso durante la prova (si torna al costruttore);
  salvare una prova (la prova non lascia traccia **[A 4]**); «Fai passare
  il tempo» (è dell'esecuzione vera, solo prototipo).
- **Anti-obiettivi**:
  - qualunque cosa nella prova che **somigli a un oggetto vero**: codici
    di task («AUD-97»), link apribili verso task/email inesistenti, una
    notifica nel pannello delle notifiche, un'email fra le inviate;
  - una prova che **corre da sola** fino in fondo senza farsi leggere;
  - «Turn on» disponibile a metà prova o come effetto collaterale di
    «Approve in the test»;
  - un'approvazione della prova presentata come un'approvazione vera
    («Approved by Laura Costa»): nella prova approva chi prova, e lo dice;
  - log tecnici (JSON degli input) come forma principale delle anteprime.

## 5. Stati e intervalli

### Partire

- **Problemi di configurazione**: «Test» nel costruttore è disabilitato
  con «Fix 3 problems to test». Arrivando dalla rotta diretta con una
  bozza che ha problemi, la pagina mostra lo stato bloccato: h1, la frase
  «This automation can't be tested yet» e l'elenco dei problemi come righe
  «Step 4 · Incomplete: choose who gets the task» che portano al passo nel
  costruttore; nessuna prova parte (Task 4) **[A 5]**.
- **Scelta dell'esempio** (Dialog 640px, all'ingresso e con «Change
  example»), titolo «Choose an example»:
  - **Inizio da sorgente** (Audin, HubSpot, webhook): segmentato «Recent
    events · Write one». *Recent events*: gli eventi di esempio della
    sorgente (`sampleEvents`), una riga ciascuno, più recente in alto:
    «Deal won · Rossi Srl · CRM + Website · €18,400 · Oct 24», sotto 12px
    «Contract attached». Scelta singola, Enter conferma. Sorgente scaduta o
    senza eventi: «No recent events from HubSpot» e si passa a *Write one*.
  - *Write one*: un modulo con **i dati dell'inizio** (stessi nomi e tipi
    di «Data you can use»): testo, numero, data (selettore), email,
    persona (selettore persone), lista (righe aggiungibili, ognuna con i
    suoi sottocampi), file (scelta da un piccolo insieme di file finti
    del seme: «Contratto Rossi Srl.pdf» **[A 6]**). Precompilato
    dall'evento più recente se c'è, altrimenti vuoto; nessun campo è
    obbligatorio (un dato vuoto è un caso da provare).
  - **Inizi di Stubwise**: «Recent» = le ultime task/richieste/email vere
    che corrispondono al filtro e che chi prova vede (codice + titolo; per
    le email solo dalle proprie caselle); *Write one* come sopra.
  - **Ricorrenza / a mano**: nessun elenco, solo il modulo (per la
    ricorrenza un solo campo «When it starts», precompilato con la
    prossima occorrenza).
  - Piede: «Cancel» · **Start test**.
- **Simulazione che non parte** (errore del livello dati): «Couldn't start
  the test» + Retry, il flusso resta visibile.

### Segni di percorso sulle righe (flusso a sinistra)

Sempre glifo + parola nel nome accessibile, mai solo colore **[A 7]**:

| Stato | Riga | Nome accessibile |
|---|---|---|
| non ancora raggiunto | numero e frase in `ink` normale, nessun segno | «Not reached yet» |
| corrente | tinta ink 10% + punto ink pieno al posto del segno | «Current step» |
| fatto | spunta ink + esito breve a destra 12px («would create AUD task», «Claude: Tasks found») | «Done» |
| fermo (attesa, approvazione, progetto) | anello pieno a metà + «Stopped: waiting for approval» | «Stopped» |
| ramo non preso | intera corsia in `ink-faint`, etichetta con «· not taken» | «Branch not taken» |
| fallito | icona + «Would fail» in `critical` | «Failed» |
| saltato | trattino + «Skipped» `ink-muted` (es. «Otherwise» vuota) | «Skipped» |

### Fermate

- **Attesa di tempo** («Wait 3 days»): anteprima «Would wait 3 days, until
  Oct 29» (data calcolata dall'orologio del prototipo) · bottone **Skip
  ahead 3 days**. Nessuna attesa vera.
- **Attesa di una risposta** («Wait for a reply to step 1, at most 5
  days»): anteprima con l'email a cui si aspetta risposta (riassunta in una
  riga, «See» la apre) · **Write the client's reply** · «Skip ahead 5 days —
  no reply». *Write the client's reply* apre nel pannello un compositore
  minimo: Da (il destinatario dell'email, non modificabile), testo,
  allegati finti opzionali, **Use this reply**; la risposta entra nei dati
  («Reply text», «Reply attachments») e la riga dice «Reply written in the
  test».
- **Attesa di una task chiusa**: anteprima della task attesa (forma della
  task in anteprima, §6) · **Close it in the test** · «Skip ahead N days —
  not closed».
- **Approvazione**: anteprima completa dell'effetto (la task, l'email) e
  sopra, in una riga 14px, «A real run would stop here until Laura Costa
  approves.» (o «…until the Project Lead of BRN — Giulia Ferri — approves»,
  o «…until the owner approves. After you turn it on, that's you.»). Poi:
  **Approve in the test** · «Reject in the test». Per un'email: «Edit before
  approving» rende modificabili oggetto e testo (come in «Da decidere»), e
  l'anteprima mostra il testo corretto. Rifiutare segue la corsia
  «rejected» se il passo ce l'ha, altrimenti la prova finisce con «A real
  run would stop here: rejected». Nella riga del passo: «Approved in the
  test by you» — mai il nome dell'approvatore vero **[A 8]**.
- **Progetto non trovato** («The client's project», cliente assente dalla
  tabella o progetto che il proprietario non vedrebbe): anteprima «Rossi
  Srl isn't in the client table. A real run would stop and ask the owner
  to choose a project.» · scelta del progetto (menu, codice + nome) ·
  **Use this project in the test**. Nessuna riga viene aggiunta alla
  tabella.
- **Claude al lavoro**: riga corrente con l'anello tratteggiato del
  glifo che pulsa; nel pannello il testo della motivazione arriva in
  streaming come nella conversazione (cursore ink); «Next step» è
  disabilitato finché Claude non ha finito.

### Anteprime (pannello a destra, passo selezionato)

- Testata del pannello: «Step 6 · Send an email» + stato («Would send»,
  «Waiting for approval», «Failed»). Sempre al condizionale.
- **Task** (forma condivisa con registro e «Da decidere»): «Would create a
  task in AUD Audin 2.0» · titolo con i dati già sostituiti · incaricato
  risolto con la spiegazione di come: «Marco Bellini — a person», «Sales
  — department, no assignee», «Laura Costa — first Project Lead in AUD,
  alphabetically», oppure «No one has the role Designer in AUD: the task
  would start without an assignee» (icona + `warning`) · scadenza «Due Oct
  31 (5 days after it's created)» · traguardo («In milestone Activation CRM
  – Rossi Srl, from step 1») · reparto con striscia 3px + nome · descrizione
  (markdown, chiusa a 6 righe con «Show all»). **Nessun codice**: al suo
  posto la parola «New task» in `ink-faint` **[A 9]**.
- **Traguardo / richiesta**: stessa forma ridotta (nome, progetto,
  scadenza / titolo, descrizione).
- **Email**: «Would send an email» · From (casella del proprietario; per
  una bozza mai accesa: «From your mailbox — giulia.ferri@example.com,
  because you'd be the owner») · To · Cc · Subject · corpo **intero**
  reso come nel pannello di lettura della Posta (prosa ≤ 68ch) · allegati
  a gettoni. Nessun «Open in Mail».
- **Avviso / avvio**: «Would notify Laura Costa: “…”» / «Would start AUT-2
  Onboarding cliente. A test doesn't run other automations: its steps
  aren't shown.» **[A 10]**.
- **Claude**: sezione «Claude chose» con l'uscita in 600 («Tasks found») e
  sotto, in prosa 14px, **la motivazione** («The contract lists two
  products, CRM and Website. Each has an activation checklist in the
  annex, so I listed 6 tasks…»); poi «Fields» come tabella etichetta ·
  valore (le liste come righe numerate, es. 6 task con titolo · reparto ·
  giorni); poi «Read» con i documenti letti (nomi). Claude fuori dai
  binari (uscita non dichiarata, campo del tipo sbagliato, elenco oltre
  50): icona + «Claude's answer didn't fit this step» in `critical`, il
  motivo in parole («It answered “Partly present”, which isn't one of the
  outcomes») e la riga «A real run would stop here. Nothing else would
  happen.» La prova finisce lì.
- **Condizione**: «{Amount} is 18,400 · more than 10,000 → If» con i valori
  veri del momento; Per ogni: «Products sold has 2 items»; Ripeti finché:
  «Round 1 of at most 2 · {Reply received} is no → repeat».
- **Inizio**: i dati dell'esempio in tabella etichetta · valore (liste
  apribili).

### I giri (For each e Repeat until)

- La corsia di un ciclo mostra in testa il **selettore del giro**: «Round
  3 of 6 · task: Configure CRM users» con ‹ › e un menu «All rounds». I
  passi dentro la corsia mostrano i segni **del giro scelto**; il giro
  corrente è il default mentre la prova avanza **[A 11]**.
- «All rounds» apre un elenco compatto (popover 400px, scorrevole): una
  riga per giro, `#` tnum · elemento (titolo/nome, ellissi) · esito in
  parole («would create 1 task», «failed»). Con **50 giri** l'elenco è
  virtualizzato, ha il campo «Find a round» e ←/→ da tastiera sul
  selettore scorrono i giri.
- Il riepilogo somma tutti i giri: «Would create 50 tasks (one per
  product)». Oltre 50 elementi: la prova si ferma al passo «For each» con
  «The list has 64 items. A run stops at 50: this step would fail.»
- Repeat until al limite: la corsia «When the limit is reached» si accende
  e la riga dice «Limit reached after 2 rounds».

### Fine

- **Finita bene**: l'ultima riga «End» con spunta; il riepilogo diventa
  sezione finale «If this were real» con gruppi: WOULD CREATE (traguardi,
  task con progetto e incaricato in righe compatte), WOULD SEND (email:
  destinatario + oggetto, clic = anteprima), WOULD NOTIFY, WOULD START,
  STOPS («Would wait for approval once — Laura Costa»), e la durata
  stimata delle attese («Real run: about 5 days of waiting»). In testata
  compare **Turn on** (bozza mai accesa) / **Publish version 3** (bozza di
  un'attiva) accanto a «Test again» e «Back to editing». Turn on apre
  **lo stesso dialogo** del costruttore (cambio di proprietario, casella)
  **[A 12]**.
- **Finita male** (errore): «The test stopped at step 6» + motivo +
  «Edit step 6» (porta al passo nel costruttore) · «Test again». Nessun
  Turn on.
- **Rifiutata**: «A real run would stop at step 6: rejected in the test».
- **Senza effetti** (es. Condition che porta a una corsia vuota): «Nothing
  would happen with this example.» — è un esito legittimo, non un errore.
- **In sola lettura** (chi vede ma non gestisce): può provare? **No**:
  «Test» non compare; la prova è uno strumento di chi costruisce **[A 13]**.

### Limiti verificati

- 40 passi, 5 livelli, 50 giri, email lunghe (corpo di 3.000 caratteri),
  6 uscite di Claude, motivazione di 1.500 caratteri (chiusa a 10 righe con
  «Show all»), nomi lunghi in en e it.

## 6. Interazione e layout

- **Comandi della prova** (testata, a destra): «Restart» (ricomincia dallo
  stesso esempio, senza conferma) · **Next step** (primario; Enter quando
  il fuoco è nel flusso o nel pannello, N ovunque nella pagina) · «Run to
  next stop» (Maiusc+Enter) **[A 14]**. A una fermata, «Next step» e «Run to
  next stop» sono disabilitati e il fuoco va al primo bottone della
  fermata nel pannello (annuncio «assertive»: «Stopped at step 3: waiting
  for a reply»).
- «Run to next stop» avanza con un piccolo ritmo visibile (ogni passo si
  accende per ~250ms, nulla con movimento ridotto) e si ferma alla prima
  fermata, a Claude che risponde (lo aspetta e prosegue) o alla fine.
- **Selezionare una riga già fatta** mostra la sua anteprima nel pannello
  senza spostare la prova; «Back to current step» in testa al pannello
  riporta al corrente. Una riga non raggiunta mostra «Not reached yet» e la
  frase del passo.
- **Uscire**: «← Back to editing» o Esc (fuori da dialoghi e campi) torna
  al costruttore sullo stesso passo; la prova si butta senza conferma
  (non c'è niente da perdere che sia reale) **[A 15]**. Cambiare la bozza
  e tornare in prova ricomincia da capo con lo stesso esempio, finché la
  pagina resta aperta.
- **Prova di un'automazione accesa senza bozza**: si prova la versione
  accesa («Version 2 · on»); a fine prova niente Turn on, solo «Test
  again» e «Back».
- **A 1024**: colonna chiusa; il pannello anteprima diventa sovrapposto
  (440px) e si apre da solo a ogni fermata; fuori dalle fermate si apre
  selezionando una riga.
- **Annunci**: `aria-live="polite"` per ogni passo completato («Step 4
  done: would create a task in AUD»), «assertive» per le fermate e la
  fine. La fascia di prova è un `role="note"` letto all'ingresso.
- **Movimento**: accensione della riga 150ms; pannello che cambia 0ms
  (cambia il contenuto); il riepilogo che cresce senza animazione dei
  numeri.

## 7. Vincoli e decisioni aperte

- La prova usa **solo** `startSimulation` / `simulationStep` /
  `getSimulation` / `endSimulation`; la UI non scrive mai nello store e
  non chiama mutazioni (test del Task 7: Posta, task, Home e notifiche
  identiche dopo una prova completa).
- Nessun link nelle anteprime verso oggetti che non esistono; i link
  esistono solo verso oggetti **veri** già esistenti (il progetto, la
  persona, l'evento di partenza se è una task vera).
- Le anteprime di task ed email sono componenti condivisi con il registro
  dell'esecuzione e con l'approvazione in «Da decidere».
- en/it con parità; tutto il testo delle anteprime al condizionale in
  entrambe le lingue («Would create» / «Creerebbe»).
- Colore: `critical` per fallito, `warning` per «nessun incaricato»;
  nient'altro. La fascia di prova è ink.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| fascia | TEST · Nothing here is real. No tasks, emails or notifications are created. · What a test can't do | PROVA · Niente qui è reale. Non nasce nessuna task, email o notifica. · Cosa non fa una prova |
| comandi | Next step · Run to next stop · Restart · Change example · Back to editing · Test again | Passo successivo · Vai alla prossima fermata · Ricomincia · Cambia esempio · Torna a modificare · Riprova |
| esempio | Choose an example · Recent events · Write one · Start test | Scegli un esempio · Eventi recenti · Scrivine uno · Avvia la prova |
| attese | Skip ahead {{n}} days · Write the client's reply · Use this reply · no reply | Vai avanti di {{n}} giorni · Scrivi la risposta del cliente · Usa questa risposta · nessuna risposta |
| approvazione | A real run would stop here until {{name}} approves. · Approve in the test · Reject in the test · Approved in the test by you | Un'esecuzione vera si fermerebbe qui finché {{name}} non approva. · Approva nella prova · Rifiuta nella prova · Approvato nella prova da te |
| anteprime | Would create a task in {{project}} · Would send an email · Would notify · Would wait {{n}} days, until {{date}} · New task | Creerebbe una task in {{project}} · Manderebbe un'email · Avviserebbe · Aspetterebbe {{n}} giorni, fino al {{date}} · Nuova task |
| Claude | Claude chose · Why · Fields · Claude's answer didn't fit this step | Claude ha scelto · Perché · Campi · La risposta di Claude non rientra in questo passo |
| giri | Round {{n}} of {{total}} · All rounds · Find a round · Limit reached after {{n}} rounds | Giro {{n}} di {{total}} · Tutti i giri · Cerca un giro · Limite raggiunto dopo {{n}} giri |
| fine | If this were real · Would create · Would send · Nothing would happen with this example. · The test stopped at step {{n}} | Se fosse vera · Creerebbe · Manderebbe · Con questo esempio non succederebbe niente. · La prova si è fermata al passo {{n}} |
| bloccata | This automation can't be tested yet · Fix {{count}} problems to test | Questa automazione non si può ancora provare · Risolvi {{count}} problemi per provarla |

## Scelte del brief da confermare

1. **[A 1] [scelta del brief]** La prova ha una rotta sua, `#/automations/<code>/test`, ed è
   una modalità del costruttore, non un dialogo.
2. **[A 2] [scelta del brief]** La prova mostra **lo stesso elenco numerato** del costruttore
   che si accende passo per passo, con l'anteprima a destra al posto del
   pannello del passo.
3. **[A 3] [scelta del brief]** La garanzia «nulla è reale» è una fascia fissa in ink (non
   gialla), più il condizionale in tutti i testi e l'assenza di codici e
   link verso oggetti inesistenti.
4. **[A 4] [scelta del brief]** Una prova non si salva e non lascia traccia (nemmeno «ultima
   prova riuscita» sull'automazione).
5. **[A 5] [scelta del brief]** Con problemi di configurazione la prova non parte: pagina
   bloccata con l'elenco dei problemi che portano al passo.
6. **[A 6] [scelta del brief]** Nel modulo «Scrivine uno» i file si scelgono da un piccolo
   insieme di file finti, non si caricano.
7. **[A 7] [scelta del brief]** Segni di percorso: corrente, fatto, fermo, ramo non preso,
   fallito, saltato — glifo + parola, rami non presi in `ink-faint`.
8. **[A 8] [scelta del brief]** Chi prova approva «nella prova», a nome suo, mai a nome
   dell'approvatore vero; la riga dice chi approverebbe davvero.
9. **[A 9] [scelta del brief]** Le task in anteprima non hanno codice («Nuova task»).
10. **[A 10] [scelta del brief]** «Avvia un'altra automazione» nella prova non percorre i
    passi dell'altra: lo dice e basta.
11. **[A 11] [scelta del brief]** Nei cicli, un selettore «Giro 3 di 6» sulla corsia e
    l'elenco «Tutti i giri» (virtualizzato, con ricerca) per i 50 giri.
12. **[A 12] [scelta del brief]** «Accendi» / «Pubblica» compare solo a prova finita bene, e
    apre lo stesso dialogo del costruttore (cambio di proprietario).
13. **[A 13] [scelta del brief]** Chi ha solo il permesso di vedere non può provare.
14. **[A 14] [scelta del brief]** Scorciatoie: N / Invio = passo successivo, Maiusc+Invio =
    prossima fermata; la prova non corre mai da sola fino in fondo.
15. **[A 15] [scelta del brief]** Uscire dalla prova la butta senza conferma.
