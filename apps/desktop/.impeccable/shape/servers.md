# Shape brief — Servers (sezione del progetto, dettaglio di un server, nuovo server e chiave dell'agente)

Superficie: sezione **Servers** del progetto (`#/p/<CODE>/servers`, oggi
`Placeholder`), dettaglio di un server (`#/p/<CODE>/servers/SRV-<n>`, con
`?range=1h|24h|7d`, `?check=<id>` e `?section=<id>` per portare in vista
una parte), dialogo **New server** con il pannello della chiave
dell'agente, voce **Servers** della colonna del progetto, gruppo «Servers»
di ⌘K. Piano 8b: Task 7 (dati: Task 1–3; avvisi e analisi: Task 5). Il
pannello «SSH access» del dettaglio è di `server-access.md`; il blocco
«Server» nella task, la sessione d'analisi e gli avvisi sono di
`server-task.md`. Spec area 8: «Server», «Permessi», «Codici», «Stati»,
«Dati finti», «Quanto è vero nel prototipo». Web di riferimento (cosa si
porta, non come appare): `apps/web/src/routes/monitor/*`. Mondo:
«Catalogo numerato» (`DESIGN.md`), modalità **Operate**, con un tratto di
**Read** (i grafici). Il maintainer approva da telefono: nessuna domanda
interattiva; le scelte del brief sono numerate **[S n]** e raccolte in
fondo, le tre che cambiano davvero ciò che si vede sono in «Scelte da
confermare».

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi segue il progetto senza essere tecnico** (Matteo, Project Lead;
    Sara, Contributor): vuole sapere «i server vanno?» e, se no, «qualcuno
    se ne sta occupando?». Legge parole, non percentuali.
  - **Chi interviene** (Marco, Developer con `servers.operate` su ACQ;
    Laura, Project Lead di AUD): arriva da un avviso o dalla task di
    diagnosi, apre il dettaglio per vedere **quando** è cominciato, **cosa**
    è salito, quali servizi e controlli sono giù.
  - **Chi amministra il monitoraggio** (Roberta, admin: `monitor.manage` e
    `servers.ssh.manage`): aggiunge un server, copia la chiave dell'agente,
    regola soglie e controlli, sceglie il progetto principale.
- **Stato d'animo**: davanti a un server giù, urgenza e bisogno di sapere
  se è già in mano a qualcuno (Claude o una persona); in tempi normali,
  un'occhiata di conferma. La pagina deve rispondere prima alla domanda
  «sta bene?» e solo dopo ai numeri.

## 2. Esito e prova

- **Azioni primarie**: (1) capire lo stato di ogni server del progetto e
  chi ci sta lavorando; (2) leggere l'andamento di un server nel tempo e
  trovare il momento in cui è cambiato; (3) per `monitor.manage`: aggiungere
  un server e regolarne soglie, controlli e impostazioni.
- **Successo**, a 1440×900:
  - aprendo Servers vedo in cima i server che non stanno bene, ognuno con
    **due frasi**: la salute («Not responding · since 14:02») e il lavoro
    («Claude is looking into it» / «Diagnosis ready · ACQ-57» / «Fix
    running · ACQ-57»);
  - aprendo un server in difficoltà, sotto il titolo c'è l'**episodio in
    corso** in parole («Memory at 94%, above 90% for 12 minutes») e, sulla
    stessa riga, chi ci lavora; sotto, i grafici con la soglia disegnata e
    l'episodio segnato sull'asse del tempo;
  - un server senza accesso SSH lo dice dove serve: «Claude can't look into
    problems on this server: no SSH access.»
- **Verità del prodotto** (mai ammorbidite in UI):
  - **un server appartiene a un progetto attraverso gli ambienti**: ogni
    riga dice in quale ambiente (e di quale progetto) il server è usato;
    solo la **produzione** manda avvisi e fa partire l'analisi, e un server
    solo di staging lo scrive («Staging only: no alerts, no analysis»);
  - **l'analisi è in sola lettura** e la correzione parte solo da una task
    (vedi `server-task.md`): qui nessun bottone avvia Claude né tocca il
    server;
  - **Stubwise non rilascia**: nessun «Restart», «Deploy», «Pull» su un
    server o su un servizio, nemmeno fra i «Simula»;
  - **la chiave dell'agente si vede una volta sola**: alla creazione e alla
    rigenerazione, mai in una lettura successiva.

## 3. Direzione scelta

- **Tesi**: **prima la salute in parole, poi i numeri**. L'elenco è un
  catalogo di server con codice in testa e due frasi di stato; il
  dettaglio è una pagina che scorre, aperta dall'episodio in corso e
  ordinata per domanda: com'è andato (grafici) → cosa gira (servizi,
  dischi) → cosa si controlla (controlli, soglie) → chi può entrare
  (accesso SSH) → impostazioni.
- **Elenco in due gruppi** con `heading-group`: **NEEDS ATTENTION** (non
  risponde, in difficoltà) e **RUNNING FINE** (in salute, rientrato, mai
  collegato in fondo); un gruppo vuoto non compare, e con un solo gruppo
  l'intestazione resta (dice quale dei due è) **[S 1]**.
- **Dettaglio a pagina intera**, non pannello: i grafici vogliono la
  larghezza. Indice delle parti agganciato sotto la testata (link, non
  schede: la pagina scorre) **[S 2]**.
- **Momento focale**: il riquadro **Now** in testa al dettaglio (l'unico
  con fondo `ink/4`, filetto `rule`, raggio 8px, come «Needs attention»
  delle Releases), presente solo quando c'è un episodio aperto o rientrato
  da meno di 24 ore, o una task di server aperta su questo server.

```
┌────────┬────────────────────────────────────────────────────────────────────┐
│ ACQ    │ Servers                                          [New server]      │
│ Acquis.│ Where ACQ runs, and how it's doing. Servers join a project through │
│        │ its environments.                                                  │
│ Overv. │ NEEDS ATTENTION                                                    │
│ Tasks  │ SRV-2  db-stw-01          ▲ In trouble · since 09:40      ╱╲_╱‾    │
│ …      │        Production · STW   No SSH access: Claude can't look         │
│ Servers│ RUNNING FINE                                                       │
│  ● 1   │ SRV-1  acq-prod-01        ✓ Healthy · back to normal 2 d ago ‾╲_   │
│        │        Production · ACQ (primary)   Diagnosis ready · ACQ-57       │
│        │ SRV-4  acq-prod-02        ✓ Healthy                       __‾_     │
│        │        Production · ACQ             No SSH access                  │
└────────┴────────────────────────────────────────────────────────────────────┘
```

### Pagina della sezione (`#/p/ACQ/servers`)

- **Testata**: h1 «Servers» → riga in prosa `ink-muted`: «Where ACQ runs,
  and how it's doing. Servers join a project through its environments.» →
  a destra **New server** (solo `monitor.manage`; bottone secondario, la
  pagina non ha un primario).
- **Riga di un server** (due righe, 56px, filetto sotto, intera riga
  cliccabile verso il dettaglio):
  - prima riga: codice `SRV-2` (600, cifre tabellari) · nome (ellissi,
    intero nel `title`) · **salute** (glifo + parola + da quando) ·
    a destra il **mini-grafico CPU** delle ultime ore (`recentCpu`, linea
    ink 1px, 96×20, nessun asse, `aria-hidden`, la salute è già in parole)
    **[S 3]**;
  - seconda riga, 13px `ink-muted`: **ambienti** («Production · ACQ
    (primary)», «Staging · STW»; più produzioni separate da «·») e
    **lavoro o accesso**, nell'ordine di ciò che conta: lavoro di Claude se
    c'è («Claude is looking into it» con l'anello tratteggiato, «Diagnosis
    ready · ACQ-57» con il codice link se visibile, «Fix running · ACQ-57»
    con l'anello), altrimenti lo stato dell'accesso solo se **non**
    verificato («No SSH access», «SSH access waiting for the command»,
    «SSH access check failed»).
  - Niente hostname nella riga (sta nel dettaglio) **[S 4]**.
- **Ordine**: dentro NEEDS ATTENTION prima «non risponde» poi «in
  difficoltà», poi per inizio dell'episodio (il più vecchio in alto);
  dentro RUNNING FINE per codice.
- **Stati della salute** (glifo + parola, colore solo di stato, mai unico
  segnale):
  - **Healthy** — glifo ✓ `ink-muted`, nessuna data;
  - **In trouble** — ▲ `warning`, «since 09:40» (o «since Oct 27» oltre il
    giorno);
  - **Not responding** — ● pieno con croce `critical`, «since 14:02»; per
    agente muto «no data since 14:02»;
  - **Back to normal** — ✓ `positive`, «back to normal 2 h ago» (fino a 24
    ore, poi torna Healthy);
  - **Never connected** — ○ vuoto `ink-faint`, «waiting for the agent»
    (server appena creato).
- **Stati del lavoro** (`ServerWork`): nessuno · **Claude is looking into
  it** (anello tratteggiato ink, come sul binario) · **Diagnosis ready ·
  ACQ-57** · **Fix running · ACQ-57** (anello). Il lavoro si mostra anche
  su un server in salute (una diagnosis pronta resta finché la task è
  aperta).
- **Server condiviso fra progetti**: dal progetto non principale la seconda
  riga aggiunge «Diagnoses go to ACQ» (codice link solo se il progetto è
  visibile, altrimenti «to another project»).

### Dettaglio (`#/p/ACQ/servers/SRV-1`)

- **Testata**: link «← Servers» (12px) → h1 = nome del server con il codice
  accanto in cifre tabellari a 28px `ink-muted` (codice accanto al nome,
  mai solo) → riga 13px `ink-muted`: salute in parola · hostname · «agent
  1.8.2» · «last report 30 s ago» · ambienti come nell'elenco. Nessun
  bottone in testata: le azioni stanno nelle parti.
- **Indice agganciato** sotto la testata, 32px, link 13px: Charts ·
  Services · Disks · Checks · SSH access · Thresholds · Settings (le ultime
  due solo se la parte esiste per chi guarda; Thresholds c'è sempre, in
  lettura). La parte in vista è sottolineata in ink. `?section=access` apre
  la pagina sulla parte.
- **Now** (riquadro, solo se serve):
  - titolo 14px 600: «Not responding since 14:02» / «In trouble since
    09:40» / «Back to normal at 16:10 · after 2 h 8 min»;
  - i **motivi** dell'episodio, uno per riga, in frase: «Memory at 94%,
    above 90% for 12 minutes» · «Check “API health” is down: connection
    refused» · «The agent hasn't reported since 14:02»; un secondo
    allarme aggiunto all'episodio compare come riga in più con l'ora;
  - il **lavoro**: «Claude is looking into it with read-only access ·
    Open session» / «Diagnosis ready · ACQ-57 Memory leak in the import
    worker» (link alla task) / «Fix running · ACQ-57»; senza accesso di
    lettura usabile: «Claude can't look into it: no SSH access.» e, solo a
    `servers.ssh.manage`, **Link SSH access** (porta a `?section=access`);
  - server in produzione di più progetti: «The diagnosis opens in ACQ, the
    primary project.»
- **Charts**:
  - intestazione `headline` «Charts» · a destra il selettore d'intervallo
    **1h · 24h · 7d** (gruppo di bottoni segmentato, `aria-pressed`; di
    base 24h) **[S 5]**;
  - **cinque grafici piccoli** in griglia a due colonne (una sotto 1100px
    utili): CPU %, Memory %, Disk %, Load (1 min), Network (in/out) — linea
    ink 1.5px, area sotto a `ink/6`; network con due linee distinte per
    **tratto** (piena «in», tratteggiata «out») e legenda in parole;
  - la **soglia** è una linea tratteggiata `rule-strong` con etichetta a
    destra «Alert at 90%»; soglia spenta: nessuna linea e «No alert» nel
    sottotitolo;
  - gli **episodi** nell'intervallo sono una fascia verticale `ink/6` su
    tutti i grafici, con etichetta in alto «Memory · 14:02–16:10» (la
    fascia di un episodio aperto arriva al bordo destro, con «now»);
  - **cursore**: al passaggio (o con ←/→ col fuoco sul grafico) una linea
    verticale condivisa da tutti i grafici e un'etichetta con ora e
    valore; fuori dal grafico, sotto il titolo, un **riassunto in parole**
    sempre visibile: «Average 23% · peak 81% at 14:20» (è anche il testo
    accessibile del grafico);
  - campioni ridotti: una riga 12px `ink-faint` sotto la griglia: «Showing
    300 averaged points of 20,160 samples.» **[S 6]**;
  - **controllo selezionato** (da Checks): sopra la griglia compare un
    grafico in più, «Response time · API health», a tutta larghezza, con
    le fasce dei momenti in cui il controllo era giù; una pastiglia «API
    health ✕» accanto al selettore d'intervallo lo toglie. La selezione sta
    in `?check=`.
- **Services**: tabella con intestazione agganciata — Name · Source
  (Docker / PM2) · State (parola: «running», «restarting», «exited (1)») ·
  CPU · Memory · Restarts · Image (12px `ink-muted`, ellissi). Ordinabile
  per colonna (`aria-sort`); da 20 righe in su un campo «Filter services»
  sopra. Uno stato non «running» ha il glifo ▲ `warning` accanto alla
  parola. Nessuna azione sui servizi. 200 righe: tabella intera, scorre con
  la pagina, intestazione agganciata.
- **Disks**: una riga per mount — `/` · barra 160×6 (ink pieno; `warning`
  quando supera la soglia del disco, `critical` sopra il 95%) · «412 GB of
  500 GB · 82%». Nessun grafico in più (l'andamento sta in Charts).
- **Checks**: righe 40px — glifo + stato in parola («Up», «Down»,
  «Unknown») · nome · tipo in parola («HTTP», «TCP», «Process»,
  «PostgreSQL», «MySQL») · bersaglio (ellissi) · «every 60 s» · latenza ·
  ultimo errore (`critical` solo il glifo, il testo `ink-muted`). Clic sulla
  riga (o Invio) la **seleziona** per i grafici (`aria-pressed`, fondo
  `ink/10`); di nuovo la deseleziona. Con `monitor.manage`: **Add check**
  (dialogo 440px: nome, tipo, bersaglio con l'esempio del tipo
  scelto, intervallo 10–3600 s, attivo) e, al passaggio sulla riga,
  «Edit» · «Pause/Resume» · «Delete» (conferma in posto a due tempi come il
  merge delle Releases) **[S 7]**. Vuoto: «No checks yet. A check watches
  a URL, a port, a process or a database.»
- **SSH access**: la parte di `server-access.md`.
- **Thresholds**:
  - **in lettura** (chi non ha `monitor.manage`): tre frasi — «An alert
    starts when CPU stays above 95% for 5 minutes.», «…memory above 90%…»,
    «…disk above 90%…»; spenta: «CPU never raises an alert.»; sotto, 12px:
    «Someone who manages monitoring can change these.»;
  - **in modifica** (`monitor.manage`): le stesse frasi con il numero
    dentro un campo (1–100, vuoto = «off»), minuti 1–60 in una riga a sé
    («…for at least [5] minutes»), **Save** che si abilita solo con
    modifiche; «Saved» compare solo dopo la conferma del livello dati e
    sparisce alla prima modifica (bug dell'area 6). Errore di validazione
    sotto il campo, in parole.
- **Settings** (solo `monitor.manage`):
  - **Name** (campo, salva con Save come sopra); **Report every** (10–300
    s);
  - **Primary project**: menu fra i progetti la cui produzione usa il
    server; con un solo progetto, testo fisso «ACQ — the only production
    using this server» e nessun menu; frase sotto: «Claude's diagnoses open
    as tasks here.»;
  - **Agent key**: «Regenerate key» → conferma in dialogo «The agent on
    SRV-1 stops reporting until you update it with the new key.» → pannello
    della chiave (sotto);
  - **Delete server**: dialogo con il codice e le conseguenze: «SRV-1
    leaves the environments Production · ACQ. Its history is deleted. The
    code SRV-1 won't be used again.» · **Delete SRV-1** (unico bottone
    `critical` della pagina).
- **Prototype only** (riquadro tratteggiato dell'8a, in fondo alla pagina,
  visibile a ogni membro che vede il server): «Simulate an alert» (motivo:
  CPU, Memory, Disk, Check, Agent silent; gravità: in trouble / not
  responding; «takes too long»), «Simulate recovery», «Simulate SSH
  unreachable», con la frase «These buttons pretend the server or the
  agent answered. They don't touch any server.»

### New server e chiave dell'agente

- **Dialogo** 480px «New server in ACQ»: **Name** · **Environment** (menu
  dei soli ambienti di ACQ senza server, con il tipo in parola) · frase:
  «The server joins ACQ through this environment.» · **Create server**.
- **Nessun ambiente libero**: il dialogo mostra solo «Every environment of
  ACQ already has a server. Add an environment in Releases → Environments
  first.» con il link; senza `environments.manage` su ACQ il bottone New
  server c'è ma il dialogo dice «Someone who manages ACQ's environments
  can add one.» **[S 8]**.
- **Dopo la creazione** il dialogo diventa il **pannello della chiave**
  (stessa finestra, nessuna navigazione): titolo «SRV-5 is ready for its
  agent» → riga in evidenza 14px 600 «This key is shown only now.» → la
  chiave `sk_…` in monospace in un campo di sola lettura con **Copy** →
  il comando d'installazione dell'agente (blocco monospace, Copy) →
  **Done**. Chiudere senza aver copiato chiede «Close without copying the
  key? You can regenerate it later from Settings.» Alla chiusura si va al
  dettaglio di SRV-5, stato «Never connected · waiting for the agent».
- Prototipo: una riga 12px `ink-faint` sotto la chiave: «Prototype: this
  key is made up and no agent can use it.»

### Colonna e ⌘K

- **Voce Servers** della colonna (solo template software, come oggi): il
  conteggio `ink-faint` dei server; quando almeno un server del progetto
  è in difficoltà o non risponde, al posto del conteggio un **punto di
  stato** 6px (`critical` se uno non risponde, altrimenti `warning`) con
  tooltip e testo per i lettori di schermo «1 server not responding»
  **[S 9]**.
- **⌘K**: gruppo «Servers» per codice o nome dei server visibili («SRV-1 ·
  acq-prod-01 · ACQ»), apre il dettaglio nel progetto principale se
  visibile, altrimenti nel primo visibile. Codici scritti a mano
  (`SRV-1`) diventano link solo se il server è visibile.

## 4. Ambito e confini

- **Dentro**: sezione, dettaglio con tutte le parti, New server e chiave,
  rigenerazione della chiave, soglie, controlli, impostazioni, cancellazione,
  voce della colonna, ⌘K, riquadro dei «Simula».
- **Fuori**: la vista complessiva dei server dell'istanza (area 9);
  intervalli 30d/90d del web (il seme ha 7 giorni) **[S 5]**; azioni sui
  servizi (riavvio, stop); l'aggiornamento dell'agente; ogni avvio di
  Claude da questa pagina.
- **Anti-obiettivi**: un colore come unico segnale di salute; un bottone
  che agisce sul server; un grafico senza il suo riassunto in parole; la
  chiave dell'agente visibile dopo la chiusura del pannello; un server di
  un progetto invisibile che compare (R-G5: dettaglio di un server
  invisibile e di `SRV-99` identici).

## 5. Stati e intervalli

- **Server per progetto**: 0 → «No servers in ACQ yet. A server joins a
  project through one of its environments.» + New server per chi può,
  altrimenti «Someone who manages monitoring can add one.»; tipico 1–4;
  massimo ~20 (tutti in pagina, niente «Show all»).
- **Grafici**: 1h ≈ 120 punti, 24h ≈ 2 880 → ridotti a 300, 7d ≈ 20 160 →
  300; intervallo senza dati («Never connected» o agente muto da prima
  dell'intervallo): area vuota con «No data in this range».
- **Servizi** 0–200 («No services reported»); **dischi** 1–8; **controlli**
  0–30.
- **Nomi**: server fino a 64 caratteri (ellissi in elenco, a capo nell'h1
  fino a due righe); progetti nell'elenco degli ambienti per codice.
- **Caricamento**: scheletro con la forma vera (2 righe d'elenco; nel
  dettaglio testata + 5 riquadri grafico). **Errore** per parte: ogni parte
  ha il suo «Couldn't load services» + **Retry**, le altre restano; errore
  della pagina intera solo se manca il server.
- **Non trovato**: «This server doesn't exist, or you can't see it.» +
  «← Servers» (stesso testo per invisibile e inesistente).
- **Cambio di persona** («Vedi come») col dettaglio aperto: le parti di
  gestione compaiono o spariscono sul posto; se il server non è più
  visibile, la pagina diventa «non trovato».
- **Cambio di stato dal vivo** (Simula): l'elenco riordina con una
  transizione 200ms; il riquadro Now compare in altezza.

## 6. Interazione e layout

- **Pagina**: colonna di lavoro fino a 1120px con 32px di margine;
  1024×680 (720px utili): grafici in una colonna, tabella dei servizi senza
  la colonna Image (resta nel `title` del nome).
- **Tastiera**: nell'elenco J/K scorrono i server e Invio apre (come le
  task); nel dettaglio `1`/`2`/`3` scelgono 1h/24h/7d col fuoco fuori dai
  campi, ←/→ muovono il cursore sul grafico a fuoco, Esc deseleziona il
  controllo.
- **Movimento**: cursore senza animazione; cambio d'intervallo con
  dissolvenza 150ms delle linee; Now e dialoghi 200ms; nulla sotto
  reduced-motion.
- **Grafici SVG inline** (nessuna libreria), asse del tempo con 4–6
  etichette in cifre tabellari, asse dei valori con 0 e massimo; tema
  chiaro/scuro dai token.

## 7. Vincoli e decisioni aperte

- Pagine solo via `data/queries.ts` (`listProjectServers`, `getServer`,
  `getServerMetrics`, `searchServers`, scritture del monitor); la UI non
  calcola salute, lavoro né progetto principale: li legge.
- Testi en/it con parità; frasi dei motivi per `EpisodeReason.kind`.
- **Da chiudere nel Task 3, non una scelta di forma**: `MetricPoint` non
  ha la latenza di un controllo; il grafico «Response time» del controllo
  selezionato ha bisogno che `getServerMetrics(code, range, checkId)` la
  restituisca (es. `latencyMs` e `up` per punto).
- Riuso: `PageEmpty`/`PageError`/`PageSkeleton`, il riquadro «Prototype
  only», `Toast`, la conferma a due tempi di `MergeConfirm`, l'anello di
  `WorkingRing`.

## Scelte del brief

1. **[S 1]** Elenco in due gruppi «Needs attention» / «Running fine».
2. **[S 2]** Dettaglio a pagina intera con indice agganciato, non pannello
   né schede.
3. **[S 3]** Mini-grafico CPU per riga, decorativo (`aria-hidden`).
4. **[S 4]** Hostname solo nel dettaglio.
5. **[S 5]** Intervalli 1h · 24h · 7d (non 30d/90d del web), 24h di base.
6. **[S 6]** Nota dei punti ridotti sotto i grafici.
7. **[S 7]** Controlli: aggiunta in dialogo, azioni al passaggio, cancella
   a due tempi.
8. **[S 8]** New server solo verso un ambiente libero del progetto; senza
   ambienti liberi il dialogo rimanda a Releases → Environments.
9. **[S 9]** Punto di stato colorato sulla voce Servers della colonna.

## Scelte da confermare

1. **Dettaglio a pagina intera** con indice agganciato (Charts · Services ·
   Disks · Checks · SSH access · Thresholds · Settings) invece di un
   pannello laterale **[S 2]**.
2. **Elenco in due gruppi** («Needs attention» in cima, «Running fine»
   sotto), ogni server su due righe: salute in parola e chi ci lavora
   **[S 1]**.
3. **Voce Servers della colonna con un punto rosso/ambra** (non ink) quando
   un server del progetto non risponde o è in difficoltà **[S 9]**.
