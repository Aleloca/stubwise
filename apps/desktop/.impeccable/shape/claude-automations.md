# Shape brief — Claude che scrive e prova un'automazione (S1), e quel che cambia nel costruttore e nella prova

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer (nessuno strumento di domanda
> in questa sessione). Dove design e piano non bastavano la scelta è
> marcata **scelta del controller** e numerata **[AU n]** in fondo. Valgono
> come scritte le decisioni del maintainer: Claude non accende mai
> un'automazione; la bozza nasce spenta e senza proprietario; la prova non
> ha effetti e Claude non approva nella prova; **D2** finita la prova
> Claude apre da sé il costruttore, col riquadro aperto e «Back to
> <pagina>»; **D3** il filtro sta sull'inizio e la prova, anche a mano,
> dice «Wouldn't start» / «Non partirebbe».

Superficie:
- nella conversazione (riquadro e destinazione): la riga che riassume il
  flusso (testo di Claude), la riga eseguita di `createAutomation` (10a),
  `pages/claude/conversation/TrialRow.tsx` (l'evento `trial`), la riga
  finale;
- `layout/claudePanel/ClaudePanel.tsx`: l'apertura del costruttore (D2) e
  la riga «Back to <pagina>»;
- `pages/automations/test/{useTestRun.ts,TestPage.tsx,Summary.tsx}`:
  `?sim=<id>` e la riga di `filteredOut` (D3, anche per la prova a mano);
- `pages/automations/builder/ActionForms.tsx`: «Notify» con un reparto, il
  problema `department_cant_see`, i due dati nuovi dell'inizio;
- `pages/automations/DetailHeader.tsx` e la riga meta del costruttore:
  «Created by Claude on behalf of …».

Parte da `automation-builder.md` e `automation-test.md` e non li riscrive:
qui solo ciò che cambia. Le schede di scelta (reparto, progetto) sono in
`claude-scenarios.md` §3.6.

Piano 10b: Task 2 (UI), Task 5, Task 11. Spec area 10: parte 6 tutta, S1,
«Cosa cambia deliberatamente» 5. Mondo: «Catalogo numerato», modalità
**Operate**.

## 1. Lavoro e pubblico

- **Laura** (Project Lead in ACQ, `automations.manage`), dalla sezione
  Support di ACQ, con una conversazione aperta: «quando arriva una
  richiesta di supporto urgente, crea una task e avvisa il reparto». Non
  è tecnica. Vuole che la cosa esista, sapere cosa farà, e decidere lei
  quando accenderla.
- **Sara** (Contributor, senza `automations.manage`): chiede la stessa
  cosa. Deve capire cosa sarebbe nato e a chi chiedere.
- **Stato d'animo**: entusiasmo e una paura precisa: che parta qualcosa da
  solo verso il team o verso il cliente. La forma deve dire a ogni passo
  «è una bozza, è spenta, la prova non ha fatto niente».

## 2. Esito e prova

- **Successo**, a 1440×900, riquadro aperto su Support di ACQ:
  1. scrivo la frase; arriva la scheda «Which department should get the
     task and the notice?» con **Support** consigliato;
  2. scelgo Support; Claude scrive la riga del flusso, poi «✓ Created
     **ACQ-A4** “Urgent support request → task for Support” · draft, off ·
     Undo»;
  3. arriva la riga della prova: due esempi, il primo «would create 1 task
     for Support and notify 3 people», il secondo «Wouldn't start: the
     start filter doesn't match this example»;
  4. Claude scrive «It would create a task for Support and notify 3
     people.» e «It's off: turn it on from the builder when you're
     ready.»;
  5. l'area principale passa al costruttore, sulla prova finita del primo
     esempio; il riquadro resta aperto e in cima dice «← Back to ACQ ·
     Support»; il fuoco resta nella casella del riquadro;
  6. nel costruttore leggo «Draft · Created by Claude on behalf of Laura
     Costa»; il bottone **Turn on** c'è, ed è mio.
- **Verità del prodotto**:
  - **la bozza è spenta**: nessuna riga del riquadro dice «Turn on» o
    «Activate»; la riga eseguita dice «draft, off»;
  - **la prova è al condizionale e non lascia niente**: nessuna task,
    notifica, email, esecuzione o voce nasce;
  - **la prova è la simulazione vera dell'area 7**: aperta nel
    costruttore è la stessa, coi suoi segni di percorso e il suo
    riepilogo;
  - **il motore non inventa passi**: ciò che non sa fare si dice.

## 3. Direzione scelta

- **Tesi**: **dalla frase alla procedura, senza toccare niente di vero**.
  Nella conversazione tre righe in fila (il flusso in parole, la bozza
  creata, la prova) e una frase che dice l'esito; poi la procedura
  vera nel costruttore. La conversazione non ripete il costruttore: ne è
  il riassunto e la porta **[AU 1]**.

### 3.1 La riga del flusso (testo di Claude)

- Una frase 14px ink, parti unite da « · », al presente, prima dell'azione:

| Parte | en | it |
|---|---|---|
| inizio, supporto urgente | Starts when an urgent support request arrives in ACQ | Parte quando arriva una richiesta di supporto urgente in ACQ |
| inizio, solo urgente | Starts when an urgent request is created in ACQ | Parte quando nasce una richiesta urgente in ACQ |
| crea task | creates a task for Support, due in 1 day | crea una task per Support, con scadenza a 1 giorno |
| avvisa | notifies Support | avvisa Support |
| manda email | sends an email to the customer | manda un'email al cliente |
| tutto da solo | runs on its own | parte da sola |
| con l'email | the email waits for the owner's approval | l'email aspetta l'approvazione del proprietario |

  Esempio: «Starts when an urgent support request arrives in ACQ · creates
  a task for Support, due in 1 day · notifies Support · runs on its own.»
- **Con l'email**, la parte finale è «the other steps run on their own;
  the email waits for the owner's approval» / «gli altri passi partono da
  soli; l'email aspetta l'approvazione del proprietario», e una seconda
  frase: «Until someone turns it on, the owner is whoever tests it.» /
  «Finché nessuno l'accende, il proprietario è chi la prova.» **[AU 2]**.
- **Il nome dell'automazione** lo scrive Claude da un template: «Urgent
  support request → task for Support» / «Richiesta di supporto urgente →
  task per Support». Si cambia nel costruttore (Rename and describe)
  **[AU 3]**.

### 3.2 La riga eseguita della creazione (10a)

- «✓ Created **ACQ-A4** “Urgent support request → task for Support” ·
  draft, off» / «✓ Creata **ACQ-A4** «Richiesta di supporto urgente → task
  per Support» · bozza, spenta», con «Undo» / «Annulla l'azione» a destra.
- Il codice porta al costruttore (`#/automations/ACQ-A4/edit`).
- **«Undo»** elimina la bozza e le sue prove. Stati come nel 10a; dopo un
  salvataggio, una rinomina o l'accensione di Laura: «Laura Costa changed
  it afterwards · can't undo from here · Open ACQ-A4» / «Laura Costa l'ha
  modificata dopo · non si annulla da qui · Apri ACQ-A4». Accesa, resta
  accesa.
- Annullata mentre il costruttore è aperto su ACQ-A4: la pagina mostra lo
  stato «non trovata» dell'area 7 («Can't find ACQ-A4»), identico a un
  codice inesistente; il riquadro e la riga «Back to …» restano.

### 3.3 La riga della prova (`TrialRow`)

- **In testa**, 13px `ink-muted`: segno della provetta (lo stesso della
  fascia TEST dell'area 7) · «Tested on 2 examples · nothing was created»
  / «Provata su 2 esempi · non è nato niente» **[AU 4]**.
- **Una riga per esempio**, 14px, segno + parola a sinistra, poi
  l'esempio, poi l'esito al condizionale, a destra «Open the test» /
  «Apri la prova» (link a `#/automations/ACQ-A4/test?sim=<id>`):

| `status` | Segno | Esito (en / it) |
|---|---|---|
| `done` | ✓ | would create 1 task for Support and notify 3 people / creerebbe 1 task per Support e avviserebbe 3 persone |
| `done`, nulla da fare | ✓ | nothing would happen with this example / con questo esempio non succederebbe niente |
| `filtered_out` | ⊘ | Wouldn't start: the start filter doesn't match this example / Non partirebbe: il filtro dell'inizio non vale per questo esempio |
| `waiting_approval` | ◐ | would create 1 task and notify 3 people, then stop here for Laura Costa's approval / creerebbe 1 task e avviserebbe 3 persone, poi si fermerebbe qui per l'approvazione di Laura Costa |
| `waiting_approval`, approvatore invisibile | ◐ | …, then stop here for an approval / …, poi si fermerebbe qui per un'approvazione |
| `stoppedAtClaude` | ◐ | would stop at the step where Claude reads and decides: open the test to go on / si fermerebbe al passo in cui Claude legge e decide: apri la prova per andare avanti |
| `failed` | ✕ `critical` | would fail at step 2: {{reason}} / non andrebbe oltre il passo 2: {{reason}} |

- **L'esempio**:
  - evento vero: **codice** 600 della richiesta (link: è vera e chi chiede
    la vede) · titolo fra virgolette · fra parentesi i dati del filtro in
    parole: «(urgent, from support)» / «(urgente, dal supporto)», «(low
    urgency, from support)» / «(urgenza bassa, dal supporto)»;
  - evento scritto da Claude (`written`): niente codice; «Example written
    by Claude: an urgent request from support» / «Esempio scritto da
    Claude: una richiesta urgente dal supporto», in `ink-muted`.
- I conteggi sono quelli di `TrialOutcome` (task, notifiche, email,
  richieste, traguardi), solo quelli maggiori di zero, nell'ordine «task ·
  email · avvisi · richieste · traguardi». Le persone si contano (sono
  membri di un reparto che vedono il progetto), non si nominano: la prova
  nel costruttore le elenca **[AU 5]**.
- **In corso** (`pending`): una riga «Testing on 2 examples…» / «La provo
  su 2 esempi…» con l'anello di Claude che pulsa (fermo con movimento
  ridotto).
- **`skipped`** (creazione fallita o salita a scheda): **nessuna riga**.
- Il colore non è mai l'unico segnale: segno + parola; ⊘ e ◐ sono ink.

### 3.4 La frase dell'esito e la riga finale

- Dopo la riga della prova, testo di Claude, una frase calcolata dal
  **primo esempio che passa**: «It would create a task for Support and
  notify 3 people.» / «Creerebbe una task per Support e avviserebbe 3
  persone.» Con l'email: «…, and the email would wait for Laura Costa's
  approval.» / «…, e l'email aspetterebbe l'approvazione di Laura Costa.»
  Nessun esempio passa: «None of the examples would start it.» /
  «Nessuno degli esempi la farebbe partire.».
- Riga finale, sempre: «It's off: turn it on from the builder when you're
  ready.» / «È spenta: accendila dal costruttore quando ti va bene.» Solo
  testo: nessun bottone, nessun link «Turn on» (il codice nella riga
  eseguita porta già al costruttore).

### 3.5 L'apertura del costruttore (D2) e «Back to <pagina>»

- **Quando**: alla prima resa di un `trial` `done` **nel turno in
  diretta**, una volta sola. Riaprendo la conversazione, o leggendola a
  pagina intera dopo, non si naviga: c'è «Open the test».
- **Dove**: l'area principale va a `#/automations/ACQ-A4/test?sim=<openSimId>`
  (la prima prova che passa). Se nessuna passa (`openSimId` `null`), va al
  costruttore `#/automations/ACQ-A4/edit` **[AU 6]**.
- **Il riquadro resta aperto**, col fuoco nella casella: la navigazione
  non ruba il fuoco. Annuncio `polite`: «Opened ACQ-A4 in the builder, on
  the test.» / «Aperta ACQ-A4 nel costruttore, sulla prova.».
- **«Back to <pagina>»**: una riga 32px **sopra il chip** del riquadro,
  13px, bottone testo con ←: «Back to ACQ · Support» / «Torna a ACQ ·
  Support» (l'etichetta è quella del chip della pagina lasciata, senza il
  tipo per gli oggetti: «Back to ACQ-S2» / «Torna a ACQ-S2»).
  - Clic: torna all'indirizzo di prima; la pagina ritrova scorrimento e
    testi non salvati dove la pagina li tiene già (Supporto, Posta); la
    riga sparisce.
  - Sparisce anche se la persona va da sé su un'altra pagina, o preme
    **New** nel riquadro. Non sopravvive a un ricaricamento **[AU 7]**.
  - Il chip, mentre si è sul costruttore, dice «ACQ-A4 · automation».
- **La pagina della prova adottata** (`?sim=` di chi guarda): la prova
  finita com'è nell'area 7 («If this were real», segni di percorso,
  pannello dell'anteprima), senza il dialogo «Choose an example». Riga
  meta: «Version 1 (draft) · Example: **ACQ-R7** Export bookings · chosen
  by Claude» / «Versione 1 (bozza) · Esempio: **ACQ-R7** Esporta le
  prenotazioni · scelto da Claude», con «Change example». In testata
  **Turn on** (bozza mai accesa, prova finita bene: regola [A 12]).
- **`?sim=` di un'altra persona** (vedi come) o scaduta: la pagina apre il
  dialogo «Choose an example» come oggi, senza messaggi.

### 3.6 Nel costruttore

- **Riga meta** (`automation-builder.md` §3): dopo lo stato, «· Created by
  Claude on behalf of Laura Costa» / «· Creata da Claude per conto di
  Laura Costa», con l'anello **fermo** 12px davanti ([CT 2]). Da
  `createdVia`; senza il campo, niente. Lo stesso nel dettaglio
  dell'automazione (`DetailHeader`), nella riga meta sotto il titolo.
  **Resta per sempre**, anche dopo l'accensione, le pause e le versioni
  nuove: è l'origine dell'automazione, non uno stato della bozza
  **[AU 8]**.
- **«Notify someone»**, campo **Who**: segmentato come «Create a task»:
  «A person · A department · A role in the project» / «Una persona · Un
  reparto · Un ruolo nel progetto». «A department»: menu dei reparti con
  la striscia 3px e il nome; sotto, 12px `ink-muted`: «Each person in
  Support who can see ACQ gets their own notice.» / «Ogni persona di
  Support che vede ACQ riceve il suo avviso.»; in un'automazione generale:
  «…who can see the project of each run.» / «…che vede il progetto di
  ogni esecuzione.».
- **Frase della riga del passo**: «Notify Support · department: “{{text}}”»
  / «Avvisa Support · reparto: «{{text}}»».
- **Problema `department_cant_see`**: sulla riga del passo icona +
  «Nobody in Marketing sees ACQ» / «Nessuno di Marketing vede ACQ» in
  `critical`; nel pannello la stessa frase e sotto «Choose another
  department, or add someone from Marketing to ACQ.» / «Scegli un altro
  reparto, o aggiungi qualcuno di Marketing ad ACQ.». Conta nei problemi
  della testata e impedisce «Test» come gli altri.
- **I due dati nuovi dell'inizio** `request_created` (in «Data you can
  use» e nel costruttore di condizione): «Urgency» / «Urgenza» (valore da
  un menu: «low · medium · high» / «bassa · media · alta», non testo
  libero) e «From support» / «Dal supporto» (sì/no) **[AU 9]**. La frase
  dell'inizio con il filtro: «When a request is created · urgency is high
  · from support is yes» / «Quando nasce una richiesta · l'urgenza è alta
  · dal supporto è sì».

### 3.7 Nella prova dell'area 7: `filteredOut` (D3, anche a mano)

- Scelto un esempio che il filtro esclude, la prova finisce subito, senza
  anteprime:
  - la riga «When» ha il segno ⊘ e a destra «Wouldn't start» / «Non
    partirebbe»; le righe dei passi restano senza segni («Not reached
    yet»);
  - il pannello dell'anteprima dice «Wouldn't start: the start filter
    doesn't match this example» / «Non partirebbe: il filtro dell'inizio
    non vale per questo esempio», e sotto una riga per condizione col
    valore dell'esempio, segno + parola: «Urgency is high — this example:
    low · doesn't match» / «L'urgenza è alta — questo esempio: bassa · non
    vale»; «From support is yes — this example: yes · matches» / «Dal
    supporto è sì — questo esempio: sì · vale»;
  - il riepilogo «If this were real» diventa una riga: «Nothing would
    happen: it wouldn't start with this example.» / «Non succederebbe
    niente: con questo esempio non partirebbe.»;
  - **nessun Turn on** e nessuna prova registrata (`testedRev` invariato):
    al suo posto «Change example» primario e la riga «Try an example that
    matches the start filter.» / «Prova un esempio che soddisfa il filtro
    dell'inizio.» **[AU 10]**.

### 3.8 I rifiuti e i limiti

| Caso | en | it |
|---|---|---|
| senza permesso (Sara), 3 righe + rifiuto | It would start when an urgent support request arrives in ACQ. · It would create a task for Support, due in 1 day. · It would notify the people in Support who see ACQ. · You can't create automations in ACQ · Who? | Partirebbe quando arriva una richiesta di supporto urgente in ACQ. · Creerebbe una task per Support, con scadenza a 1 giorno. · Avviserebbe le persone di Support che vedono ACQ. · Non puoi creare automazioni in ACQ · Who? |
| cosa che il motore non sa fare | Automations can't post to Slack. The closest step is notifying people in Stubwise: I built the rest and left that part out. | Le automazioni non pubblicano su Slack. Il passo più vicino è avvisare le persone in Stubwise: ho costruito il resto e ho lasciato fuori quella parte. |
| altro problema di validazione | I couldn't build it: {{issue}}. Nothing was created. | Non sono riuscito a costruirla: {{issue}}. Non è nato niente. |
| nessuna azione riconosciuta | I didn't find a step I can do in this request: an automation can create tasks, notify people or send an email. | In questa richiesta non trovo un passo che so fare: un'automazione può creare task, avvisare persone o mandare un'email. |

- Le tre righe di Sara sono un elenco senza codici, senza scheda e senza
  prova. «Who?» = `WhoCanLink` `manageProjectAutomations` di ACQ
  (`manageGeneralAutomations` per una generale).
- Per «Slack», nessun passo nuovo nel flusso, e nessun passo «quasi
  uguale» aggiunto da solo: se Laura vuole l'avviso, lo chiede **[AU 11]**.
- **Coda in pausa** (9b): la bozza nasce e la prova gira; nessuna riga lo
  dice (non sono lavoro in coda). **Budget esaurito**: il riquadro non
  risponde (10a).

```
1440 ── dopo D2: costruttore in prova, riquadro aperto ──────────────────────────────────────
│rail│ flow (576, colonna chiusa)              │ Claude 400              │ preview 400        │
│    │ ← Back to editing                       │ ← Back to ACQ · Support │ Step 2 · Notify    │
│    │ Test: Urgent support request → task…    │ You're looking at:      │ Would notify 3     │
│    │ Version 1 (draft) · Example: ACQ-R7 …   │ [ACQ-A4 · automation ×] │ people in Support: │
│    │   chosen by Claude · Change example     │ ─────────────────────── │ “New urgent…”      │
│    │ ⚗ TEST Nothing here is real…            │ ✓ Created ACQ-A4 “Urg…” │                    │
│    │ ✓ When a request is created · urgency…  │   · draft, off   Undo   │                    │
│    │ ✓ 1 Create task for Support · 1 day     │ ⚗ Tested on 2 examples ·│                    │
│    │ ✓ 2 Notify Support · department         │   nothing was created   │                    │
│    │   End                                   │ ✓ ACQ-R7 “Export…” (ur- │                    │
│    │ IF THIS WERE REAL                       │   gent, from support) — │                    │
│    │ Would create 1 task · would notify 3    │   would create 1 task…  │                    │
│    │                         [Test again]    │ ⊘ ACQ-R8 “…” (low urg…) │                    │
│    │                         [Turn on]       │   — Wouldn't start: …   │                    │
│    │                                         │ It's off: turn it on    │                    │
│    │                                         │ from the builder…       │                    │
```

```
1024 ── stessa scena ─────────────────────────────────────────────
│rail│ flow (600)                              │ Claude 360               │
│    │ Test: Urgent support request → task…    │ ← Back to ACQ · Support  │
│    │ ⚗ TEST Nothing here is real…            │ [ACQ-A4 · automation ×]  │
│    │ ✓ When … ✓ 1 … ✓ 2 …                    │ ⚗ Tested on 2 examples · │
│    │ IF THIS WERE REAL …        [Turn on]    │   nothing was created    │
```

## 4. Ambito e confini

- **Dentro**: la riga del flusso, la riga eseguita della creazione e il
  suo «Undo», la riga della prova in tutti gli stati, la frase dell'esito
  e la riga finale, l'apertura del costruttore e «Back to», la prova
  adottata, la riga «Created by Claude on behalf of», «Notify» con un
  reparto e il suo problema, i dati «Urgency» e «From support», la riga
  `filteredOut` nella prova a mano.
- **Fuori**: le schede di scelta (`claude-scenarios.md`); il dialogo
  «Turn on» dell'area 7 (invariato); le esecuzioni vere.
- **Anti-obiettivi**:
  - un «Turn on» / «Activate» / «Publish» nel flusso della conversazione;
  - una bozza che nasce accesa o con un proprietario;
  - un esito della prova scritto al presente o al passato («created»);
  - un codice di task, di notifica o di esecuzione nella riga della
    prova;
  - una prova che approva: Claude non sblocca mai un'approvazione;
  - un passo inventato per ciò che il motore non sa fare;
  - la navigazione del costruttore che ruba il fuoco o che si ripete
    riaprendo la conversazione.

## 5. Stati e intervalli

- Esempi della prova: 1 o 2 (`wants`); un esempio scritto da Claude quando
  manca un evento vero visibile.
- Conteggi: da 0 a decine (un reparto di 12 persone: «would notify 12
  people»).
- Nomi d'automazione fino a ~80 caratteri: la riga eseguita va a capo, il
  codice no.
- **Vedi come**: la prova adottata è solo di chi l'ha fatta; un'altra
  persona con lo stesso indirizzo vede il dialogo degli esempi.
- **Annullata la creazione**: la riga della prova resta com'era (storia
  della conversazione), ma «Open the test» diventa testo senza link.

## 6. Interazione e layout

- **1440** (D2): arrivando dal riquadro sulla prova, la colonna di
  Automations si chiude (come a 1024; il suo interruttore la riapre); il
  **pannello dell'anteprima sta al bordo destro** e il riquadro di Claude
  subito alla sua sinistra, come il pannello della task ([CP 10]). Restano
  a vista ~576px di flusso e il riepilogo **[AU 12]**.
- **1024**: colonna già chiusa; l'anteprima è sovrapposta e a prova
  finita è chiusa (si apre selezionando una riga), quindi il flusso ha
  ~600px accanto al riquadro (360). Aperta, l'anteprima sta al bordo
  destro e il riquadro alla sua sinistra.
- **Tastiera**: la navigazione non sposta il fuoco; Esc nel riquadro lo
  chiude e la pagina sotto è la prova; «Back to …» è raggiungibile con Tab
  come primo elemento del riquadro dopo la testata.
- **Movimento**: la pagina cambia come ogni navigazione; la riga «Back to»
  entra con dissolvenza 150ms; nulla con movimento ridotto.

## 7. Vincoli

- **Dove compare «Who?»**: solo nel rifiuto per permesso (Sara) e nei
  «Didn't run» per permesso del 10a. Mai nella riga della prova, nella
  frase dell'esito, nel costruttore per `department_cant_see`.
- **Dove compare +R**: da nessuna parte. Creare, salvare ed eliminare una
  bozza non sono in `REAUTH_REQUIRED`; il dialogo «Turn on» dell'area 7
  resta com'è.
- **Voci del registro delle modifiche**: **nessuna**, come a mano: creare
  o salvare una bozza d'automazione non scrive nel registro delle
  modifiche (che tiene accessi e impostazioni). La traccia è `createdVia`
  (la riga «Created by Claude on behalf of …») e `objectWrites`
  (`noteWrite("automation", …)`), che serve a «Com'era» per l'«Undo».
  Accendere resta un'azione della persona, con la traccia dell'area 7.
  Nessuna voce del registro decisioni.
- La prova si legge da `trial.results`, mai rifatta nel renderer; la
  pagina della prova legge la simulazione con le query dell'area 7.
- Nessun `can()` né `viewer` nei file di `pages/claude/conversation/`.
- Testi en/it con parità; tutto ciò che descrive la prova al condizionale
  («Would create» / «Creerebbe», «Wouldn't start» / «Non partirebbe»).

## Scelte del brief (scelte del controller, da confermare)

1. **[AU 1]** Nella conversazione tre righe e una frase; la procedura sta
   solo nel costruttore.
2. **[AU 2]** Con l'email, la frase «Until someone turns it on, the owner
   is whoever tests it.» spiega perché la prova chiede a Laura.
3. **[AU 3]** Il nome dell'automazione da un template «evento → azione».
4. **[AU 4]** La riga della prova ha in testa «nothing was created», col
   segno della provetta dell'area 7.
5. **[AU 5]** Le persone avvisate si contano, non si nominano, nella
   conversazione.
6. **[AU 6]** Senza una prova che passa, D2 apre il costruttore e non la
   prova.
7. **[AU 7]** «Back to» sta sopra il chip e sparisce al primo cambio di
   pagina fatto dalla persona, a «New» o al ricaricamento.
8. **[AU 8]** «Created by Claude on behalf of …» nella riga meta del
   costruttore e del dettaglio.
9. **[AU 9]** «Urgency» con un menu di tre valori, non testo libero (il
   dato del Task 2 è `type: "text"`: il menu è solo dell'interfaccia).
10. **[AU 10]** Una prova `filteredOut` non mostra «Turn on» e propone
    «Change example».
11. **[AU 11]** Per ciò che il motore non sa fare, Claude costruisce il
    resto e lo dice, senza aggiungere da solo il passo «più vicino».
12. **[AU 12]** A 1440, arrivando da D2, la colonna di Automations si
    chiude per lasciare il flusso a vista accanto ai due pannelli.

## Scelte confermate (2 nov 2026)

1. **[AU 8]** *(confermata dal maintainer il 2 nov 2026)*: «Created by
   Claude on behalf of …» / «Creata da Claude per conto di …» resta per
   sempre, nel costruttore e nel dettaglio, anche dopo l'accensione.
2. Le altre scelte di questo brief sono approvate col brief.

## Emendamenti (ratificati dal controller)

1. **emendamento (ratificato dal controller), 5 nov 2026, Task 11,
   concern (a)**: quando **nessun esempio passa** il filtro (`openSimId`
   `null`), D2 non apre la prova ma atterra su **`/edit`**, e il
   costruttore sta **sotto il pannello** del riquadro ([CP 1]): non c'è
   una prova da mostrare accanto al flusso, e «Turn on» resta del
   costruttore. *Se sbagliata*: l'atterraggio di D2 per questo caso e il
   test «nessun esempio passa (`openSimId` `null`)» di
   `Scenarios.test.tsx`.
