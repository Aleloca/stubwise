# Shape brief — Automations (destinazione, automazione, esecuzione, punti d'ingresso)

Superficie: destinazione «Automations» sul binario (`#/automations`,
elenco; `#/automations?view=runs`, esecuzioni di tutte le automazioni),
dettaglio di un'automazione (`#/automations/<code>`, es. `AUD-A1`,
`AUT-1`), dettaglio di un'esecuzione (`#/automations/<code>/runs/<n>`),
sezione «Automations» del progetto (`#/p/<code>/automations`) e i punti
d'ingresso: «Created by automation…» su task e traguardi, blocco Home
«Automations», approvazioni e «scegli il progetto» in «Decide», ⌘K.
Piano: Task 5 e Task 8 (dati: Task 1–3). Spec: area 7, tutte le sezioni
salvo «Simulazione» (UI in `automation-test.md`). Il costruttore è
`automation-builder.md`; sorgenti, webhook e tabella cliente → progetto
sono `automation-sources.md`. Mondo: «Catalogo numerato», modalità
**Operate**, con un tratto di **Read** (il registro di un'esecuzione).
**[A n]** = scelta del brief, numerata in fondo.

## 1. Lavoro e pubblico

- **Chi**: tre persone diverse arrivano qui.
  - **Chi possiede un'automazione** (Project Lead, commerciale,
    responsabile dell'assistenza): l'ha accesa, agisce coi suoi permessi e
    la sua casella. Torna per vedere se gira, perché un'esecuzione è ferma,
    e per correggerla.
  - **Chi approva** un passo (un Project Lead per l'email al cliente, il
    proprietario per «scegli il progetto»): quasi sempre non entra in
    Automations — risponde da «Decide» — ma ci arriva dal link per capire
    il contesto.
  - **Chi riceve il lavoro** (una persona del reparto con una task nata da
    un'esecuzione): arriva dal «Created by automation…» della task e vuole
    sapere *perché* quella task esiste e cosa ha letto Claude.
- **Stato d'animo**: controllo e fiducia. La paura dichiarata dal
  maintainer è l'automazione che **esce dai binari**; ogni schermata deve
  rispondere a «cosa ha fatto, perché, chi l'ha permesso» senza leggere
  JSON.
- **Molti non sono tecnici**: niente nomi di campo, niente percorsi
  (`3/forEach[2]/1`), niente stati in inglese tecnico. Tutto in frasi.

## 2. Esito e prova

- **Azioni primarie**: (1) capire lo stato di un'esecuzione e sbloccarla
  (approvare, scegliere il progetto, riprovare, saltare); (2) accendere,
  mettere in pausa o pubblicare un'automazione sapendo cosa cambia.
- **Successo**, a 1440×900:
  - aprendo Automations so in un colpo d'occhio quali automazioni hanno un
    problema e quali esecuzioni aspettano qualcuno (e se aspettano **me**);
  - aprendo un'esecuzione, la prima cosa sotto il titolo è **cosa sta
    succedendo adesso** in una frase («Waiting for Rossi Srl to reply ·
    3 days · gives up on Oct 28»), e il registro sotto si legge come una
    storia, dall'alto in basso;
  - ogni scelta di Claude ha accanto la sua **motivazione** e l'uscita
    scelta fra quelle disegnate; ogni effetto ha il **codice** di ciò che
    ha creato, cliccabile;
  - accendere un'automazione dice, prima del clic finale, che da adesso
    agisce **con i miei permessi e la mia casella**.
- **Verità del prodotto** (dallo spec, mai ammorbidite in UI):
  - un'approvazione **blocca davvero**: nessun bottone, nemmeno «Fai
    passare il tempo», la scavalca, e la UI lo dice dove qualcuno
    potrebbe aspettarselo;
  - Claude **sceglie solo fra le uscite disegnate**: il registro mostra
    sempre l'elenco delle uscite possibili con quella scelta evidenziata,
    e un'uscita fuori elenco è un errore del passo, scritto come tale;
  - **tutto tracciato**: dati in ingresso, esito, motivazione, approvatore
    e ora per ogni passo.

## 3. Direzione scelta

- **Tesi**: **il registro di bordo**. Un'automazione è una voce di
  catalogo (codice, nome, stato in parola); un'esecuzione è un **giornale
  di bordo** che si legge dall'alto in basso come una storia, con l'ora in
  colonna a sinistra in cifre tabellari e il passo in una frase. Niente
  grafo a nodi, niente diagramma di flusso nel dettaglio: la forma è
  testo indentato, perché la leggono tutti i reparti **[A 1]**.
- **Colonna personale** (240px, nessun titolo, come Drive e Claude):
  - con `automations.manage` (in almeno un progetto o d'istanza):
    bottone a tutta riga **New automation**;
  - voci 32px con conteggio `ink-faint`: **All automations** · **Runs in
    progress** (esecuzioni non terminali) · **Needs attention** (con il
    punto pieno «ti aspetta» se almeno una aspetta me; vedi §5) ·
    **Drafts** (solo con il permesso);
  - filetto, poi **Sources** (solo con `integrations.manage`,
    `automation-sources.md`) **[A 2]**;
  - filetto, `heading-group` PROJECTS: «General» (solo con il permesso
    d'istanza) e i progetti con almeno un'automazione che vedo, codice +
    nome, ciascuno con conteggio — scorciatoie del filtro progetto
    **[A 3]**.
- **Binario**: la voce esiste già (dopo «Claude»). Porta il **punto
  pieno** «ti aspetta» quando un'approvazione o un «scegli il progetto» di
  un'esecuzione aspetta me — la stessa voce che compare in «Decide»; mai
  per un'esecuzione fallita **[A 4]**.
- **Momento focale**: nel dettaglio di un'esecuzione, il **riquadro
  «Now»** sotto il titolo — l'unico elemento con un fondo (`ink/4`) e
  filetto, perché è l'unica cosa che può chiedere un'azione.

```
1440 · Automations, elenco
┌rail┬column─────────────┬ Automations 9                       [New automation ▾]┐
│    │[+ New automation] │ Project ▾  Status ▾  Owner ▾                        │
│    │ All automations 9 │ GENERAL                                              │
│ ⚙● │ Runs in progress 6│ AUT-1  Nuovo contratto            ● Active   (MC) Matteo│
│    │ Needs attention 2●│        When a deal is won on Audin · 9 steps · 2 running│
│    │ Drafts         1  │ AUT-2  Benvenuto ai nuovi clienti ○ Draft    —        │
│    │ ───────────────── │        When a deal is won on HubSpot · ⚠ 2 problems   │
│    │ Sources           │ AUD · Audin 2.0                                      │
│    │ ───────────────── │ AUD-A1 Richiesta dati al cliente  ● Active   (LB) Laura │
│    │ PROJECTS          │        Started by hand or by AUT-1 · 11 steps · 3 running│
│    │ General        2  │ AUD-A2 Promemoria fatture         ‖ Paused   (LB) Laura │
│    │ AUD Audin 2.0  3  │        Every Monday at 9:00 · 4 steps · 1 suspended  │
└────┴───────────────────┴──────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- **Dentro**: elenco con filtri e stati; dettaglio di un'automazione
  (descrizione, inizio, riassunto dei passi, problemi, versioni,
  proprietario, esecuzioni); dialoghi di accensione, pausa, riaccensione e
  pubblicazione col cambio di proprietario; dettaglio di un'esecuzione con
  il registro; annulla, riprova, salta; «Pass time» del prototipo; sezione
  del progetto; righe d'origine su task e traguardi; blocco Home; voci di
  «Decide»; gruppo di ⌘K; vuoti con i due modelli.
- **Fuori**: il costruttore e la sua forma (`automation-builder.md`); la
  prova passo per passo (`automation-test.md`); sorgenti, webhook, tabella
  cliente → progetto (`automation-sources.md`); webhook in uscita (area 9);
  Claude che costruisce o prova le automazioni (fase su Claude).
- **Anti-obiettivi**:
  - un diagramma a nodi e frecce come vista di lettura (si legge solo a
    chi l'ha disegnato);
  - un registro che è un dump JSON o un log da terminale (la forma
    «terminale» è l'anti-riferimento del brand); i dati grezzi esistono,
    ma dietro «Show data» e con le etichette dei campi;
  - un'azione che scavalca un'approvazione «per comodità» (approva tutto,
    salta l'approvazione, forza);
  - colori decorativi per i tipi di passo: il colore resta di reparto e di
    stato; i passi si distinguono per glifo lineare e parola;
  - un contatore di successo in stile dashboard («98% runs succeeded»).

## 5. Stati e intervalli

### Volumi

- Automazioni: 0–60 visibili a una persona (tipico 3–15); nomi fino a 120
  caratteri (ellissi su una riga in elenco, a capo nel dettaglio);
  descrizioni fino a 500 (due righe in elenco nel tooltip, tre nel
  dettaglio con «More»).
- Passi: 1–40, rami annidati fino a 5 livelli.
- Esecuzioni per automazione: 0–100 attive (limite di sicurezza), storico
  illimitato a pagine da 50.
- Registro di un'esecuzione: 3–300 righe; `forEach` fino a 50 giri;
  `repeatUntil` fino a 10.

### Stati di un'automazione (parola + glifo, mai solo colore)

| Stato | en / it | Glifo | Colore |
|---|---|---|---|
| attiva | Active / Attiva | punto pieno 8px | `positive` |
| in pausa | Paused / In pausa | due barre ‖ | `ink-muted` |
| bozza | Draft / Bozza | cerchio vuoto ○ | `ink-faint` |

- **Bozza di una versione successiva** su un'attiva: accanto allo stato,
  12px muted «· draft of v4» **[A 5]**.
- **Problemi di configurazione** (da `validateFlow` e dalle sorgenti):
  seconda linea della riga con icona `critical` + «2 problems» (link al
  dettaglio, sezione Problems). Un'automazione attiva può averne (sorgente
  scaduta, approvatore che ha perso l'accesso): è il caso più grave e sale
  in «Needs attention».

### Stati di un'esecuzione

| Stato | en / it (parola in elenco) | Glifo |
|---|---|---|
| `running` | Running / In corso | triangolo ▸ ink |
| `waiting_approval` | Waiting for approval / In attesa di approvazione | punto pieno ink se aspetta **me**, cerchio vuoto ink se aspetta altri |
| `waiting_project` | Waiting for a project / In attesa del progetto | come sopra |
| `waiting_event` | Waiting / In attesa | orologio lineare `ink-muted` |
| `suspended` | Suspended / Sospesa | ‖ `ink-muted` |
| `done` | Done / Finita | spunta `positive` |
| `failed` | Failed / Fallita | icona `critical` |
| `cancelled` | Cancelled / Annullata | barra obliqua `ink-faint` |

- Accanto alla parola, in elenco, la **frase di adesso** (13px muted, una
  riga): «Waiting for Rossi Srl to reply · 3 days», «Laura Bianchi must
  approve an email», «Matteo Conti must choose the project for Verdi
  Spa», «Stopped: AUD-A2 is paused», «Failed at “Create task”:
  permission lost», «Finished in 2 days · 6 tasks, 1 milestone, 2
  emails».
- **Needs attention** = automazioni con problemi che posso gestire +
  esecuzioni `failed` delle automazioni che posso gestire + esecuzioni che
  aspettano me (approvazione, progetto). Le `failed` restano qui finché
  qualcuno non le riprova, salta o annulla **[A 6]**.

### Pagine

- **Caricamento**: barra attiva in testa, 6 righe scheletro della forma
  vera (due linee); nel dettaglio, scheletro dell'intestazione e di 4
  righe del registro.
- **Errore**: «Couldn't load the automations» + «Retry»; nel dettaglio
  l'errore di una sezione resta nella sezione (come Overview).
- **Vuoto della destinazione**:
  - con il permesso: h1 «Automations», frase «Automations turn events —
    a deal won, a task closed, a date — into work for the team.», poi
    `heading-group` START FROM A TEMPLATE con i **due modelli** come righe
    di 64px: «New contract → tasks for every department» (descrizione:
    «When a deal is won, Claude reads the contract and the products and
    creates a milestone and one task per department.») e «Ask the client
    for information» («Email the client, wait for the reply, remind them
    up to twice, let Claude check that everything arrived.»), ciascuna con
    **Use template**; sotto, «or start from scratch» (link) **[A 7]**;
  - senza: «No automations you can see. People who manage automations in
    your projects will create them here.»
- **Nessun risultato dai filtri**: «No automations match these filters» +
  «Clear filters».
- **Senza permessi** (Viewer, membro senza `automations.manage`): stesse
  pagine, nessun bottone d'azione (né New, né Turn on, né Retry); i
  dialoghi non esistono. Vede le esecuzioni delle automazioni che vede.
- **Inesistente o invisibile** (R-G5): `#/automations/AUD-A9` e
  `#/automations/AUD-A1/runs/999` mostrano la stessa pagina «This
  automation doesn't exist or you can't see it» (esecuzione: «This run…»),
  identica nei due casi.
- **Cambio di persona** («vedi come») con un dettaglio aperto: si ricarica
  per la persona nuova; se non lo vede più diventa la pagina R-G5, senza
  lampeggiare il contenuto di prima.

## 6. Interazione e layout

### Elenco (`#/automations`)

- Testata: h1 «Automations» + conteggio tnum `ink-faint`; a destra
  **New automation** (primario pieno d'inchiostro) con freccia ▾ che apre:
  «Blank automation», `heading-group` TEMPLATES, i due modelli. Senza
  permesso il bottone non c'è.
- Barra 32px: filtri a gettone come Tasks — **Project** (General + i
  progetti; ricerca), **Status** (Active, Paused, Draft, Has problems),
  **Owner** (persona; «Me» in testa). «Clear filters». Tutto nell'URL.
- **Raggruppamento** per progetto: GENERAL in testa, poi i progetti in
  ordine di codice, intestazioni `heading-group` «AUD · Audin 2.0». Con un
  filtro progetto le intestazioni spariscono **[A 3]**.
- **Riga** 56px, due linee:
  - linea 1: codice (600, tnum, 64px) · **nome** 14px ink (ellissi) ·
    a destra stato (glifo + parola, 96px) · avatar 20px + nome del
    proprietario («—» per una bozza mai accesa);
  - linea 2 (13px muted): l'**inizio in parole** («When a deal is won on
    Audin», «Every Monday at 9:00», «When a task is closed in AUD»,
    «Started by hand») · numero di passi · «2 running» / «1 suspended» ·
    o, se ci sono, i problemi in `critical` con icona;
  - passaggio: 6% + a destra, al posto del proprietario, «Open» e «⋯»
    (Turn on / Pause, Duplicate, Copy link); selezione 10%.
  - Nessuna striscia di reparto (non è una task).
- **Vista esecuzioni** (`?view=runs`, voce «Runs in progress»): stesso
  guscio, h1 «Runs in progress», filtri Project · Automation · Status
  (con «Finished» per vedere anche le terminali). Riga 44px: codice
  esecuzione `AUD-A1 #12` (tnum 600) · titolo («Richiesta dati – Rossi
  Srl») · glifo + parola di stato · frase di adesso · iniziata («Oct 23»).
  Ordinamento: prima quelle che aspettano me, poi le fallite, poi le
  altre per data d'inizio decrescente.

### Dettaglio di un'automazione (`#/automations/AUD-A1`)

Colonna di lettura fino a 960px, sezioni separate da filetti con titolo
`headline` 20px (come Overview).

- **Testata**:
  - riga 12px: codice `AUD-A1` (600) · «AUD · Audin 2.0» link al progetto
    (o «General»);
  - h1 = nome (28px, a capo fino a 3 righe);
  - descrizione 14px muted, 3 righe + «More»;
  - **riga di stato** in prosa: «● Active · version 3 · runs as Laura
    Bianchi since Oct 12» / «‖ Paused by Laura Bianchi on Oct 20 · 1 run
    suspended» / «○ Draft · never turned on · created by Paolo Neri»;
  - azioni a destra (il primario per ultimo):
    - bozza: «Edit» · «Test» · **Turn on**;
    - attiva senza bozza: «Pause» · **Edit**;
    - attiva con bozza: «Pause» · «Open draft» · **Publish v4**;
    - in pausa: «Edit» · **Turn on**;
    - «⋯»: Run now (solo con inizio «avvio a mano», apre un dialogo con i
      campi dell'evento), Duplicate, Copy link, Delete (solo una bozza mai
      accesa; con conferma).
    «Edit» e «Test» portano al costruttore e alla prova.
- **Problems** (solo se ce ne sono; prima sezione): icona `critical` +
  «2 problems — it can't be turned on until they're fixed» (bozza) o
  «2 problems — runs will stop at these steps» (attiva). Un elenco di
  righe: posizione in parole («Step 4 · Send email “Welcome”») + il
  problema («Elena Rossi must approve, but she can't see AUD», «HubSpot
  is disconnected», «“Due” uses a field that no step provides any
  more») + «Fix» che apre il costruttore su quel passo.
- **Runs** (dalla seconda posizione, sopra «How it works») **[A 8]**:
  `heading-group` IN PROGRESS (tutte le non terminali, prima quelle che
  aspettano me, poi le fallite) e FINISHED (ultime 10, «Show all 48» →
  vista esecuzioni filtrata). Righe come nella vista esecuzioni, più
  «v2» 12px muted se la versione differisce dalla corrente. Vuoto: «No
  runs yet.» (+ «Run now» se l'inizio è a mano).
- **How it works**: il riassunto **in sola lettura** del flusso, come
  testo indentato:
  - prima riga: l'inizio in parole con glifo, e sotto, 12px muted, «Brings:
    client, products, amount, contract (file)» — i dati dell'inizio con
    le loro etichette;
  - poi i passi numerati `1`, `2`, `2.1`… (tnum, `ink-faint`), uno per
    riga: glifo lineare del tipo (`ink-muted`) + frase («Claude reads the
    contract and the products», «Create a task “{task.title}” for the
    {task.department} department, due in 5 days»), con i riferimenti ai
    dati come gettoni di testo sottolineati a puntini (nome del campo in
    tooltip) **[A 9]**;
  - i rami come sottoelenchi rientrati 20px con filetto verticale
    `rule` a sinistra e un'etichetta del ramo 12px 600: «If products
    contains “CRM”» / «Otherwise»; per Claude «If Claude says “All
    present”» / «If Claude says “Missing information”»; «For each task in
    Task di attivazione»; «Repeat until the client replies — at most 2
    times» e «When the limit is reached» — le stesse etichette delle corsie
    del costruttore, e la stessa frase sulla riga del passo e sulla sua
    corsia (28 ott 2026, ruling R-J23: un solo vocabolario);
  - un passo con approvazione porta a destra «Needs approval · Laura
    Bianchi» (glifo mano lineare + parole); un passo che crea in un
    progetto ricavato dice «in the client's project»;
  - oltre il secondo livello i rami partono chiusi con «Show 6 steps
    inside»; «Expand all» in testa alla sezione **[A 10]**;
  - in fondo «Open in builder» (con permesso).
- **Versions**: righe «v3 · published by Laura Bianchi · Oct 12 · current
  · 3 runs in progress» / «v2 · published by Matteo Conti · Sep 30 · 1 run
  in progress» / «v4 · draft · edited by Laura Bianchi · Oct 25». Clic su
  una versione pubblicata apre il suo riassunto in sola lettura nello
  stesso posto di «How it works», con una riga «You're looking at version
  2 · Back to current» **[A 11]**. Nessun «ripristina» nella v1 del
  prototipo: si duplica.
- **About**: proprietario (con «Acts with Laura Bianchi's permissions and
  sends email from laura.bianchi@…»), progetto, creata da/il, limiti
  («At most 20 emails per run · 50 rounds per “For each” · 100 runs at a
  time») in 12px muted.

### Dialoghi d'accensione, pausa, pubblicazione (440px)

Il cambio di proprietario è detto **sempre**, anche quando non cambia.

- **Turn on** (bozza o in pausa) / **Publish version 4** (attiva con
  bozza):
  - titolo «Turn on AUD-A1?» / «Publish version 4 of AUD-A1?»;
  - paragrafo in evidenza (14px ink): «From now on it acts with **your**
    permissions and **your** mailbox.»;
  - riga «Owner: Laura Bianchi → **you**» (o «Owner: you (unchanged)»);
  - se ci sono passi «Send email»: campo «Emails are sent from» con le
    mie caselle collegate (la prima preselezionata); nessuna casella →
    il bottone primario è disattivato e la nota dice «Connect a mailbox
    in Mail first» con il link **[A 12]**;
  - **controllo dei miei permessi** sui progetti in cui agisce: se non
    posso creare task in un progetto fisso dell'automazione, una riga
    `critical` lo dice e blocca («You can't create tasks in MKX: step 6
    would fail»); per i progetti ricavati dal cliente è solo un avviso
    («Runs for clients whose project you can't see will ask you to
    choose») **[A 13]**;
  - pubblicazione con esecuzioni in corso: «3 runs in progress keep using
    version 3 and finish as they started.»;
  - riaccensione da pausa: «1 suspended run resumes from where it
    stopped. Events that arrived while it was paused are not recovered.»;
  - problemi di configurazione: il dialogo non si apre; «Turn on» porta
    alla sezione Problems con un avviso;
  - bottoni: «Cancel» · **Turn on** / **Publish**. Esito: toast «AUD-A1 is
    on · you're the owner».
- **Pause**: «Pause AUD-A1?» · «New events are ignored while it's paused
  and won't be recovered later. 3 runs in progress stop before their next
  step and resume when it's turned back on.» · «Cancel» · **Pause**.
  Nessun cambio di proprietario.
- **Delete draft**: «Delete AUD-A3? It has never run.» · **Delete**
  (`critical`).

### Dettaglio di un'esecuzione (`#/automations/AUD-A1/runs/12`)

Colonna di lettura fino a 960px.

- **Testata**: riga 12px «AUD-A1 #12 · Richiesta dati al cliente» (link
  all'automazione) · progetto («AUD · Audin 2.0»; per una generale i
  progetti in cui ha agito); h1 = titolo dell'esecuzione; riga di prosa
  «Started Oct 23 at 09:12 by AUT-1 #7 · version 3 · Laura Bianchi's
  automation» (l'inizio in parole: «by a deal won on Audin · Rossi Srl»,
  «by hand by Paolo Neri», «by AUT-1 #7» con link). A destra: «⋯» (Copy
  link) e, con permesso e se non terminale, **Cancel run** (secondario,
  testo `critical`).
- **Now** (riquadro `ink/4`, filetto `rule`, 8px di raggio — l'unico
  fondo della pagina), una frase grande (16px 600) e i dettagli:
  - `waiting_event`: «Waiting for Rossi Srl to reply to “Dati per
    l'attivazione CRM”» · «since Oct 23 · gives up on Oct 28, then sends
    reminder 1 of 2» · per il proprietario «Open the email» (Posta);
  - `waiting_approval`: «Laura Bianchi must approve this email» con
    l'**anteprima intera** dell'effetto (email: Da, A, Oggetto, corpo,
    allegati; task: titolo, incaricato, scadenza, progetto); se aspetta
    me: «Reject» · «Edit» · **Approve** qui come in «Decide» (stessa
    forma, §Decide); se aspetta altri: solo la frase con la data
    («Waiting since Oct 25»), nessun bottone **[A 14]**;
  - `waiting_project`: «Matteo Conti must choose the project for client
    “Verdi Spa”» · «No project is linked to this client.» · se sono io:
    il selettore come in «Decide»; con `integrations.manage`: «Link Verdi
    Spa to a project» (porta alla tabella in Sources);
  - `suspended`: «Suspended: AUD-A1 is paused» · «It resumes from step 5
    “Wait for the reply” when it's turned on.» · con permesso **Turn on**
    (apre il dialogo d'accensione);
  - `running`: «Claude is reading the reply…» con lo streaming della
    conversazione (stesso componente, anello tratteggiato ink);
  - `failed`: icona `critical` + «Failed at step 3 “Create task”:
    permission lost» · «Laura Bianchi can no longer create tasks in
    MKX.» · con permesso «Cancel run» · «Skip this step» · **Retry**;
  - `done` / `cancelled`: «Finished on Oct 25 · 6 tasks, 1 milestone, 2
    emails» con i codici come link; «Cancelled by Paolo Neri on Oct 24 ·
    what was already created stays».
- **«Pass time» del prototipo** (solo quando l'esecuzione aspetta un
  tempo o un evento, e solo con `automations.manage`) **[A 15]**: subito
  sotto «Now», un riquadro con contorno **tratteggiato** `rule-strong`,
  intestato `heading-group` PROTOTYPE ONLY, frase 13px «Runs wait for
  days. Here you can make time pass.», bottoni «+1 hour» · «+1 day» ·
  «To the next deadline (Oct 28)»; se l'attesa è una risposta: anche
  «Simulate the client's reply…» (apre la risposta simulata della Posta
  dell'area 6). Con l'esecuzione in attesa di un'approvazione il riquadro
  c'è e dice «Approvals don't expire: passing time won't move this run.»
  con i bottoni disattivati — la regola 1 resa visibile **[A 16]**.
- **Log** (`headline` «Log» + conteggio righe): barra 28px con
  **Show: All · Problems · Created** (segmentato), «Expand all» /
  «Collapse all», «Show data» (interruttore che mostra i dati di
  ingresso/uscita di ogni riga).
  - **Riga** (min 36px): colonna ora 64px (tnum 12px `ink-faint`, «Oct
    23» al primo cambio di giorno come separatore `heading-group`) ·
    glifo del tipo di passo · **frase al passato** 14px ink («Created
    task AUD-131 “Configurare le pipeline” for the Sales department»,
    «Sent “Dati per l'attivazione CRM” to mario@rossi.it», «Waited 3
    days for a reply · no reply», «Condition “products contains CRM”:
    yes») · esito non ordinario a destra in parola (Skipped, Failed,
    Limit reached, Rejected).
  - **Effetti**: i codici di ciò che è nato (task, traguardo, richiesta,
    esecuzione avviata) sono link; un effetto in un progetto che non vedo
    si scrive «Created a task in a project you can't see», senza codice
    né titolo (R-G5) **[A 17]**.
  - **Passi di Claude**: blocco rientrato con filetto sinistro `rule`:
    «Claude chose **Missing information**» e sotto le uscite possibili in
    fila, quella scelta in ink 600 e le altre `ink-faint` («All present ·
    **Missing information**»); poi «Why» (`heading-group`) e la
    motivazione in 14px, fino a 6 righe con «More»; poi i **campi
    restituiti** con le loro etichette — un elenco si mostra come tabella
    compatta (es. 6 task: titolo · reparto · giorni), oltre 10 righe
    «Show all 23». Errore del passo: «Claude answered “Partially”, which
    isn't one of this step's outcomes. The step failed.» — mai
    un'improvvisazione accettata.
  - **Approvazioni**: «Approved by Laura Bianchi · Oct 24 at 10:02» /
    «Approved with changes by Laura Bianchi» con «Show changes» (diff
    parola per parola, barrato e sottolineato, mai solo colore) /
    «Rejected by…» con la strada presa («followed “Rejected”» o «the run
    stopped»).
  - **Rami**: si mostra il ramo preso, rientrato con l'etichetta come nel
    riassunto; i rami non presi sono una riga `ink-faint` «Not taken:
    Otherwise (3 steps)» espandibile **[A 18]**.
  - **`forEach`**: riga di gruppo «For each task from Claude · 12 rounds ·
    11 done, 1 failed» chiusa di default salvo il primo giro con un
    problema; aperta, un sottogruppo per giro «Round 3 of 12 ·
    Configurare le pipeline» (il nome dell'elemento dal suo campo
    titolo) a sua volta chiuso, con a destra il codice creato o l'esito.
    A 50 giri: la riga di gruppo riassume, i giri si aprono uno a uno;
    «Problems» filtra ai soli giri con problemi.
  - **`repeatUntil`**: «Repeat until the client replies · round 2 of at
    most 2» per giro, e alla fine «Limit reached → followed “If the limit
    is reached”».
  - **Retry/Skip**: sulla riga fallita, a destra, con permesso «Skip» ·
    **Retry**; il registro poi scrive «Retried by Paolo Neri · Oct 24»
    o «Skipped by Paolo Neri · the run continued without this step's
    data». Skip chiede conferma: «Skip step 3? Later steps that use its
    data may fail.»
  - **«Show data»**: sotto ogni riga, 13px, coppie etichetta → valore dei
    dati in ingresso e in uscita (etichette dei campi, non le chiavi);
    file come link al Drive o all'allegato; «Copy as JSON» per chi lo
    vuole **[A 19]**.
  - **300 righe**: tutto il registro è presente (cercabile con ⌘F della
    pagina), i gruppi chiusi lo tengono corto; la barra del registro resta
    agganciata in alto durante lo scorrimento; «Jump to now» in fondo a
    destra quando la riga dell'adesso è fuori vista **[A 20]**.
- **Privacy della posta** **[A 21]**: le email che l'automazione **ha
  mandato** si vedono per intero nel registro a chi vede l'esecuzione (le
  ha scritte l'automazione, non sono posta personale). La **risposta del
  cliente** sta nella casella del proprietario: nel registro tutti vedono
  «Reply from mario@rossi.it received on Oct 26» e l'esito di Claude con
  la motivazione; il **testo** della risposta lo vede solo il proprietario
  (gli altri: «The reply is in Laura Bianchi's mailbox»).

### Annulla

- «Cancel run» → dialogo 400px: «Cancel AUD-A1 #12? It stops here. Tasks,
  milestones and emails already created stay as they are.» · **Cancel
  run** (`critical`). Il registro scrive «Cancelled by…». Le voci in
  «Decide» legate all'esecuzione spariscono.

### Sezione del progetto (`#/p/AUD/automations`) **[A 22]**

- Nuova voce **Automations** nella colonna del progetto, dopo «Chat» e
  prima dei moduli (Releases…), presente per tutti i membri **solo se** il
  progetto ha almeno un'automazione o un'esecuzione che vi ha agito, o se
  chi guarda ha `automations.manage` nel progetto. Conteggio: esecuzioni
  in corso nel progetto.
- Pagina: h1 «Automations» + «New automation» (permesso del progetto,
  progetto preimpostato); sezione **Runs in progress** (esecuzioni non
  terminali delle automazioni del progetto **e** delle generali che vi
  hanno agito, con il codice `AUT-1 #8` che dice da sé che è generale);
  sezione **Automations of AUD** (le righe dell'elenco); sezione
  **General automations that acted here** (righe con «Last acted Oct 24
  · 3 runs»), solo se ce ne sono. Le generali sono visibili qui solo a chi
  ha il permesso d'istanza: gli altri membri vedono **solo le esecuzioni**
  che hanno agito nel progetto, con il titolo e il codice in chiaro ma
  senza link all'automazione **[A 23]**.
- Vuoto: «No automations in AUD yet» + i due modelli (con permesso), o
  «People who manage AUD can create automations here.».

### Origine su task e traguardi

- **Task**: nel dettaglio, sezione «Origin» (dove oggi c'è «Origin
  request»): riga «Created by automation **AUD-A1** Richiesta dati al
  cliente · run **#12**» — codice e nome dell'automazione link al
  dettaglio, «#12» link all'esecuzione e alla riga del registro
  (`?entry=…`). Se non vedo l'automazione: «Created by an automation»,
  senza nomi né link **[A 24]**. In elenco/board nessun segno in più.
- **Traguardo**: nel dialogo dei traguardi della panoramica e nel
  tooltip dell'intestazione di gruppo della timeline delle task, la
  stessa riga 12px muted sotto il nome.

### Blocco Home «Automations» (`automations`)

- Nel catalogo per chi vede almeno un'automazione; non è nelle Home di
  default **[A 25]**.
- Contenuto: le esecuzioni non terminali **che mi riguardano** —
  automazioni di cui sono proprietario, esecuzioni che aspettano me, e
  fallite di automazioni che posso gestire — nell'ordine «aspettano me»,
  «fallite», poi le altre per data. Riga: codice esecuzione · titolo ·
  glifo + frase di adesso. 5 righe + «Show all 9» → `#/automations?view=
  runs&mine=1`. Le approvazioni stanno **anche** in «Decide»: qui la riga
  non ha bottoni, porta all'esecuzione.
- Vuoto: «No runs that need you». Guscio `BlockSection` con i suoi
  quattro stati.

### «Decide» (Home)

- **Approvazione** (`kind: "automationApproval"`), nella stessa forma
  delle altre voci, ordinata per data:
  - riga d'origine «From automation AUD-A1 Richiesta dati al cliente ·
    run #12» (link) e codice del progetto;
  - la domanda in una frase: «Send this email to mario@rossi.it?»,
    «Create 6 tasks in AUD?», «Notify Elena Rossi?»;
  - anteprima: per un'email Oggetto + prime 3 righe del corpo + «Show
    all»; per task titolo · incaricato · scadenza (più «+5 more» che
    espande);
  - bottoni: «Reject» · «Edit» (solo email) · **Approve**; sotto
    «Reject», 12px muted, la conseguenza detta prima: «Follows
    “Rejected”» o «Stops the run»;
  - **Edit** apre in posto i campi A, Oggetto e Corpo dell'email (gli
    allegati in sola lettura), con «Cancel» · **Approve with changes**;
    il registro conserverà il prima e il dopo;
  - approvare segue la finestra dell'«Undo» di 5 s come le altre
    risposte; l'effetto parte solo **dopo** la finestra;
  - più approvatori (un ruolo): decide il primo, la voce sparisce per
    tutti; chi era sul punto riceve «Already approved by Laura Bianchi».
  - Un approvatore che non vede il progetto **non riceve** la voce (è un
    problema di configurazione dell'automazione, non una voce in più).
- **Scegli il progetto** (`kind: "automationProject"`, solo il
  proprietario): «Which project for client “Verdi Spa”?» · origine come
  sopra · menu dei progetti in cui il proprietario può creare (ricerca,
  codice + nome) · casella «Remember for Verdi Spa» solo con
  `integrations.manage` (scrive nella tabella cliente → progetto)
  **[A 26]** · **Choose**. Undo 5 s.

### ⌘K

- Gruppo **Automations** (dopo i gruppi esistenti di oggetti): cerca per
  codice, nome e codice/titolo di esecuzione («AUD-A1 #12», «Rossi»).
  Righe: codice · nome · stato in parola. Invisibili e inesistenti non
  compaiono (R-G5).
- Azione «New automation» (con il permesso in almeno un posto): apre il
  dialogo di creazione.
- Creazione (dialogo 480px, anche da «New automation»): nome, progetto
  («General» solo col permesso d'istanza; i progetti dove ho il
  permesso), partenza (Blank / i due modelli) → **Create** apre il
  costruttore sulla bozza nuova (codice assegnato alla creazione).

### 1024×680 e tastiera

- Area 720px: in elenco cade il nome del proprietario (resta l'avatar),
  la linea 2 si accorcia; nel registro la colonna ora diventa 48px (solo
  ora, il giorno nei separatori); «Now» resta intero.
- J/K muovono la selezione nelle righe; Enter apre; nel dettaglio di
  un'esecuzione `[` / `]` vanno al problema precedente/successivo nel
  registro **[A 27]**; Esc torna all'elenco.
- Accessibilità: elenchi `grid` con nomi accessibili completi («AUD-A1,
  Richiesta dati al cliente, active, owner Laura Bianchi, 3 runs
  running»); il registro è una lista ordinata con gruppi `aria-expanded`;
  la frase di «Now» è `aria-live="polite"` (cambia quando l'esecuzione
  avanza); stati sempre in parola.
- Movimento: righe nuove del registro entrano in 150ms (dissolvenza), i
  gruppi si aprono in 200ms; zero con riduzione del movimento.

## 7. Vincoli e decisioni aperte

- Dati solo da `data/queries.ts` (Task 3); visibilità da
  `canSeeAutomation`/`canManageAutomation`; orologio `now()` dello store.
- Le frasi del registro si compongono dai dati della riga
  (`RunLogEntry`) con template i18n per tipo di passo ed esito: nessuna
  frase scritta dal modello, salvo la **motivazione** di Claude, che è
  sua ed etichettata come tale («Why — written by Claude»).
- Inglese/italiano: frasi lunghe in italiano; nessuna larghezza fissa sul
  testo, la colonna stato 96px tiene «In attesa di approvazione» su due
  righe in elenco (la parola breve «In attesa» in elenco, intera nel
  dettaglio) **[A 28]**.
- Il percorso interno (`path`) non compare mai a schermo; serve
  all'ancora `?entry=`.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 | Automations · Runs in progress | Automazioni · Esecuzioni in corso |
| colonna | All automations · Runs in progress · Needs attention · Drafts · Sources | Tutte le automazioni · Esecuzioni in corso · Da sistemare · Bozze · Sorgenti |
| stati | Active · Paused · Draft | Attiva · In pausa · Bozza |
| esecuzione | Running · Waiting for approval · Waiting for a project · Waiting · Suspended · Done · Failed · Cancelled | In corso · In attesa di approvazione · In attesa del progetto · In attesa · Sospesa · Finita · Fallita · Annullata |
| azioni | New automation · Turn on · Pause · Publish v{{n}} · Edit · Test | Nuova automazione · Accendi · Metti in pausa · Pubblica la v{{n}} · Modifica · Prova |
| proprietario | From now on it acts with your permissions and your mailbox. | Da adesso agisce con i tuoi permessi e la tua casella. |
| pausa | New events are ignored while it's paused and won't be recovered later. | Mentre è in pausa i nuovi eventi vengono ignorati e non si recuperano. |
| esecuzione | Cancel run · Retry · Skip this step | Annulla l'esecuzione · Riprova · Salta questo passo |
| prototipo | Prototype only · Pass time · Approvals don't expire: passing time won't move this run. | Solo prototipo · Fai passare il tempo · Le approvazioni non scadono: far passare il tempo non sblocca questa esecuzione. |
| Claude | Claude chose {{outcome}} · Why — written by Claude | Claude ha scelto {{outcome}} · Perché — scritto da Claude |
| origine | Created by automation {{code}} {{name}} · run #{{n}} · Created by an automation | Creata dall'automazione {{code}} {{name}} · esecuzione #{{n}} · Creata da un'automazione |
| Decide | From automation {{code}} {{name}} · run #{{n}} · Approve · Approve with changes · Reject | Dall'automazione {{code}} {{name}} · esecuzione #{{n}} · Approva · Approva con le modifiche · Rifiuta |
| progetto | Which project for client “{{client}}”? · Remember for {{client}} | Quale progetto per il cliente «{{client}}»? · Ricorda per {{client}} |
| vuoto | No automations you can see. | Nessuna automazione visibile. |
| R-G5 | This automation doesn't exist or you can't see it. | Questa automazione non esiste o non puoi vederla. |

## Scelte del brief da confermare

1. **[scelta del brief]** Nessun grafo nel dettaglio: il flusso si legge
   come testo indentato (passi numerati, rami rientrati). La forma del
   costruttore la decide `automation-builder.md`, ma la lettura resta
   testuale.
2. **[scelta del brief]** «Sources» è una voce della colonna di
   Automations, visibile solo con `integrations.manage` (non una pagina
   di Impostazioni/Amministrazione).
3. **[scelta del brief]** Elenco raggruppato per progetto (GENERAL in
   testa) e colonna con i progetti come scorciatoie del filtro, come
   nella destinazione Drive.
4. **[scelta del brief]** Il punto «ti aspetta» sulla voce del binario
   compare solo per approvazioni e «scegli il progetto» rivolti a me, mai
   per esecuzioni fallite (quelle stanno in «Needs attention»).
5. **[scelta del brief]** Una bozza della versione successiva si segnala
   in elenco con «· draft of v4» accanto allo stato, senza cambiarlo.
6. **[scelta del brief]** «Needs attention» = problemi di configurazione
   + esecuzioni fallite (di ciò che posso gestire) + ciò che aspetta me;
   una fallita resta finché qualcuno non la riprova, salta o annulla.
7. **[scelta del brief]** Vuoto con i due modelli come righe «Use
   template», più «start from scratch»; testi dei modelli proposti qui.
8. **[scelta del brief]** Nel dettaglio di un'automazione le esecuzioni
   vengono prima del riassunto dei passi (si torna lì per vedere cosa
   succede); per una bozza, senza esecuzioni, «How it works» sale da sé.
9. **[scelta del brief]** I riferimenti ai dati nel riassunto sono
   gettoni di testo sottolineati a puntini, col nome del campo in
   tooltip — niente parentesi graffe a schermo.
10. **[scelta del brief]** Oltre il secondo livello di annidamento i rami
    del riassunto partono chiusi («Show N steps inside»), con «Expand
    all».
11. **[scelta del brief]** Una versione vecchia si guarda in sola lettura
    al posto del riassunto; nessun «ripristina» (si duplica).
12. **[scelta del brief]** Accendere un'automazione con passi «Send
    email» richiede che il nuovo proprietario abbia una casella collegata
    e la scelga nel dialogo; senza casella non si accende.
13. **[scelta del brief]** All'accensione, permesso mancante in un
    progetto fisso = blocco; progetto ricavato dal cliente = solo avviso
    (a runtime diventa «scegli il progetto»).
14. **[scelta del brief]** Nessun «sollecita l'approvatore» nella v1:
    «Now» dice solo chi deve approvare e da quando.
15. **[scelta del brief]** «Pass time» c'è solo per chi ha
    `automations.manage` e solo su esecuzioni in attesa; tre passi: +1 ora,
    +1 giorno, fino alla prossima scadenza.
16. **[scelta del brief]** Su un'esecuzione in attesa di approvazione il
    riquadro del prototipo resta visibile con i bottoni spenti e la frase
    «Le approvazioni non scadono», per rendere visibile la regola 1.
17. **[scelta del brief]** Un effetto in un progetto che non vedo si
    scrive senza codice né titolo («in a project you can't see»).
18. **[scelta del brief]** Nel registro i rami non presi sono una riga
    `ink-faint` espandibile, non nascosti del tutto (servono a capire
    l'alternativa scartata).
19. **[scelta del brief]** I dati di ogni passo sono dietro «Show data»,
    con etichette leggibili e «Copy as JSON» per i tecnici.
20. **[scelta del brief]** Registro lungo: tutto caricato, gruppi dei
    cicli chiusi, barra agganciata, «Jump to now»; nessuna paginazione.
21. **[scelta del brief]** Privacy: le email mandate dall'automazione si
    vedono per intero a chi vede l'esecuzione; il **testo della risposta
    del cliente** solo al proprietario (gli altri vedono che è arrivata e
    l'esito di Claude con la motivazione). Da confermare con attenzione:
    tocca la regola «nessuno legge la posta di altri».
22. **[scelta del brief]** Nel progetto è una **sezione della colonna**
    «Automations» (dopo Chat), non un pannello della panoramica; compare
    solo se c'è qualcosa o se chi guarda può crearne.
23. **[scelta del brief]** Nel progetto, chi non ha il permesso d'istanza
    vede le esecuzioni delle automazioni generali che vi hanno agito, ma
    non l'automazione generale (niente link).
24. **[scelta del brief]** Su una task, se non vedo l'automazione: «Created
    by an automation» senza nomi né link.
25. **[scelta del brief]** Il blocco Home «Automations» è nel catalogo ma
    non nelle Home di default; contiene solo le esecuzioni che mi
    riguardano (proprietario, aspettano me, fallite che posso gestire).
26. **[scelta del brief]** «Remember for <cliente>» nella scelta del
    progetto scrive nella tabella cliente → progetto, ed è offerta solo a
    chi ha `integrations.manage`.
27. **[scelta del brief]** Scorciatoie `[` / `]` per saltare fra i problemi
    del registro.
28. **[scelta del brief]** In elenco le parole di stato brevi («In
    attesa»), quelle intere nel dettaglio e nei nomi accessibili.
