# Shape brief — Amministrazione → Servers, Repositories, Instance status

> Shape scritto dal controller senza intervista (30 ott 2026). Le scelte
> non coperte da design e piano sono marcate **scelta del controller** e
> numerate **[IS n]** in fondo. Decisioni del maintainer del 30 ott 2026
> che valgono qui: **Retry** chiede `settings.manage` **e** `runs.start` nel
> progetto, parte a nome di chi riprova e passa dal gate del piano come
> «Avvia»; un passo d'automazione col budget esaurito **resta fermo** e
> riparte da solo; la pausa della coda **non** ferma «Chiedi a Claude».

Superficie: il gruppo **ACROSS PROJECTS** / **IN TUTTI I PROGETTI** di
Amministrazione — **Servers** (`/admin/servers`, `/admin/servers/$server`),
**Repositories** (`/admin/repositories`), **Instance status**
(`/admin/status`) — con i dialoghi **New server** (senza ambiente),
**Retry**, **Pause queue**, **Resume queue**. Il dettaglio del server è
quello dell'8b (`servers.md`), allargato a 30d e 90d anche nella sezione di
progetto. Piano 9b: Task 12 e 13 (dati: Task 5 e 7). Spec area 9: «Viste di
tutta l'istanza», «Il lavoro nella coda», «“Stubwise non fa deploy” e le
azioni dello Stato dell'istanza». Inventario: sezione E. Mondo: «Catalogo
numerato», modalità **Operate** (Instance status ha un tratto di
**Monitor**: si guarda e si aggiorna da sola).

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi gestisce il monitoraggio** (Roberta, `monitor.manage`): vuole tutti
    i server in una lista, anche quelli che nessun progetto ha ancora
    preso, e il loro andamento su un mese o tre.
  - **Chi gestisce i repository** (Laura, `repos.manage` in ACQ): «quali
    repository abbiamo, e con che account git?», per poi entrare nelle
    impostazioni del progetto.
  - **Chi tiene d'occhio il lavoro** (Roberta; un tecnico con
    `instance.status.view`): «perché Claude non è partito su ACQ-57?», «cosa
    sta facendo il worker?», «è fallito qualcosa stanotte?». Arriva spesso
    **da un problema**: deve trovare in una schermata cosa è fermo e perché,
    e poterlo rimettere in coda o fermare la coda di un progetto.
- **Stato d'animo**: diagnosi calma. Ogni lavoro fermo dice **perché** in
  parole; le due azioni sono leggere, confermate, e dicono che agiscono
  **solo sulla coda di Stubwise**.

## 2. Esito e prova

- **Azioni primarie**: leggere tutti i server con i loro progetti e aprirne
  uno; creare un server senza ambiente; leggere i repository per progetto e
  aprirne le impostazioni; leggere la coda per progetto e per tipo, i
  worker, la quota, gli errori recenti e il giro notturno; **Retry** su un
  lavoro fallito; **Pause** / **Resume** della coda di un progetto.
- **Successo**, a 1440×900:
  - in Servers leggo «SRV-2 db-stw-01 ▲ In trouble since 09:40 · STW» e in
    fondo, nel gruppo NOT IN ANY PROJECT, il server appena creato;
  - nel dettaglio scelgo «90d» e leggo «Average CPU 34% · peak 91% on Sep
    12» sopra il grafico;
  - in Instance status leggo in alto «STW ‖ Paused by Roberta Fontana ·
    yesterday at 18:00 · 2 waiting» e, fra i lavori, «STW-14 · Task run ·
    Waiting: queue paused by Roberta Fontana · 12 min»;
  - premo **Resume**, confermo, e la riga di STW passa a «2 running»; la voce
    è nel registro;
  - sul lavoro fallito di ieri premo **Retry**, confermo, e il toast mi porta
    alla task con la sessione nuova a mio nome.
- **Verità del prodotto**:
  - **Stubwise non fa deploy**: le azioni sono solo Retry e Pause/Resume,
    sulla coda di Stubwise; nessun controllo riavvia, ridistribuisce o tocca
    un server o un processo, e la pagina lo scrive;
  - **la pausa ferma ciò che partirebbe, non ciò che è partito**; un
    «Avvia» su una coda in pausa entra in attesa e parte una volta sola alla
    ripresa, nell'ordine d'arrivo;
  - **Retry solo su una task fallita**, a nome di chi riprova, col gate del
    piano; mai su una correzione ferma (`pr-corrections.md`);
  - **R-G5**: un progetto invisibile non compare per nome, codice o link in
    nessuna delle tre pagine; i suoi lavori sono una riga «Other projects»
    coi soli conteggi.

## 3. Direzione scelta

- **Tesi**: **Instance status è un quadro di controllo che si legge
  dall'alto: prima le code dei progetti (dove si agisce), poi i lavori uno
  per uno (dove si capisce), di lato le macchine (worker, quota, notte)**.
  Servers e Repositories sono elenchi del catalogo raggruppati, senza
  azioni nuove oltre a «New server» **[IS 1]**.

### Servers (`/admin/servers`)

- Voce visibile solo con `monitor.manage` (altrimenti assente; per
  indirizzo «not found»).
- h1 «Servers» / «Server» · «Every server on the instance, in every project.
  A server joins a project through one of its environments.» / «Tutti i
  server dell'istanza, in tutti i progetti. Un server entra in un progetto
  attraverso uno dei suoi ambienti.» · **New server** / **Nuovo server**
  (secondario).
- **Gruppi** (`heading-group`): NEEDS ATTENTION / DA GUARDARE · RUNNING FINE
  / TUTTO BENE · NOT IN ANY PROJECT / IN NESSUN PROGETTO **[IS 2]**.
- **Riga**: quella dell'8b (codice, nome, salute in glifo + parola + da
  quando, mini-grafico CPU; seconda riga: ambienti e lavoro di Claude), più
  una **colonna dei progetti** a destra prima del mini-grafico: codici in
  cifre tabellari separati da spazio, al massimo 4 e «+2» (`title` con
  codice e nome).
  - Un server con progetti tutti invisibili a chi guarda: la colonna dice
    «—» e la seconda riga «In projects you can't see» / «In progetti che non
    vedi», senza numero (come [PE 4]).
  - Un orfano: nessuna colonna, seconda riga «Not in any project yet» / «Non
    ancora in un progetto».
  - Clic → `/admin/servers/$server`.
- **New server** (dialogo 440px) **[IS 3]**, **confermata dal maintainer
  il 30 ott 2026**: **Name** · frase «It starts
  without a project. To bring it into a project, link it to an environment in
  that project's Releases → Environments.» / «Nasce senza progetto. Per
  portarlo in un progetto, collegalo a un ambiente in Releases → Ambienti di
  quel progetto.» · **Create server** → il pannello della chiave dell'8b
  (`SecretOnce`, «This key is shown only now.», comando d'installazione) →
  **Done** → dettaglio del server nuovo, «Never connected».
- **Dettaglio** (`/admin/servers/$server`): il componente dell'8b con
  «← Servers» verso Amministrazione. Differenze:
  - intervalli **1h · 24h · 7d · 30d · 90d** (anche nella sezione di
    progetto), tasti 1–5;
  - a 30d e 90d ogni punto è una media di 15 minuti: riga 12px sopra i
    grafici «Each point averages 15 minutes.» / «Ogni punto è la media di 15
    minuti.»; la frase-riassunto in parole resta sopra ogni grafico («Average
    CPU 34% · peak 91% on Sep 12»);
  - orfano: al posto degli ambienti «Not in any project yet»; «Ask Claude to
    look» e «Start the fix» spenti con «Link this server to a project first:
    Claude works inside a project.» / «Collega prima il server a un
    progetto: Claude lavora dentro un progetto.» (nessun «Who?»: non è un
    permesso).

### Repositories (`/admin/repositories`)

- Voce visibile con `repos.manage` in almeno un progetto; elenca i progetti
  dove chi guarda ha `repos.view`.
- h1 «Repositories» / «Repository» · «The repositories of the projects you
  can see. To change one, open it in its project's settings.» / «I
  repository dei progetti che vedi. Per cambiarne uno, aprilo nelle
  impostazioni del suo progetto.»
- Campo **Find a repository** / **Cerca un repository** (nome o progetto)
  sopra l'elenco quando i repository sono più di 10.
- **Un gruppo per progetto**: testata «ACQ · Portale utenti Acquedotto delle
  Colline» (codice 600 + nome) e a destra «3 repositories».
- **Riga** (44px, intera riga link a `#/p/ACQ/settings/repositories`): nome
  600 · nome completo (`audin/portale-utenti`) 13px `ink-muted` · a destra
  l'account git per nome («Bitbucket Audin») o «No git account» / «Nessun
  account git» in `ink-faint` · → .
- Un progetto visibile senza repository non compare; nessun conteggio di
  progetti invisibili.

### Instance status (`/admin/status`)

- Voce visibile con `instance.status.view` o `settings.manage`. Azioni con
  `settings.manage` (Pause/Resume) e `settings.manage` + `runs.start` nel
  progetto (Retry).
- h1 «Instance status» / «Stato dell'istanza» · «What Stubwise is doing right
  now, in the projects you can see.» / «Cosa sta facendo Stubwise adesso,
  nei progetti che vedi.» · a destra 12px `ink-faint` «Updated 08:41:12 ·
  every 10 seconds» / «Aggiornato alle 08:41:12 · ogni 10 secondi».

```
1440 ───────────────────────────────────────────────────────────────────────────
│ Instance status                          Updated 08:41:12 · every 10 seconds │
│ What Stubwise is doing right now, in the projects you can see.              │
│ QUEUES                                          │ WORKERS                     │
│ STW  Stubwise          ‖ Paused by Roberta F.  │ Worker 1  ACQ-57 Task run   │
│      yesterday 18:00 · 0 running · 2 waiting   │           12 min            │
│                                     [Resume]   │ Worker 2  AUD · PR review   │
│ ACQ  Portale utenti…   1 running · 1 failed    │           3 min             │
│                                      [Pause]   │ AI ACCOUNTS                 │
│ AUD  Audin 2.0         1 running               │ Team Max    week 41%        │
│                                      [Pause]   │ Backup Max  ▲ Near · 87%    │
│ Other projects         1 running · 0 waiting   │ Billing key API key · idle  │
│ ─────────────────────────────────────────────  │ RECENT ERRORS               │
│ WORK  [All][Running][Waiting][Failed] Project▾ │ Yesterday 16:20  ACQ-49     │
│ ▸ ACQ-57 Task run      Running · worker 1  12m │ Tests didn't pass after the │
│ ◷ STW-14 Task run      Waiting: queue paused   │ fix.          Open task →   │
│          by Roberta Fontana             12 min │ NIGHTLY RUN · last night    │
│ ◷ ACQ-A2 #7 Automation Waiting: monthly AI     │ stubwise · Docs · ✓ done    │
│          budget reached                 2 h    │ audin-web · Release note ✕  │
│ ✕ ACQ-49 Task run      Failed yesterday        │                             │
│          Tests didn't pass         [Retry]     │                             │
│ ○ Stubwise only changes its own queue here: nothing restarts a server or a  │
│   worker.                                                                    │
```

- **Due colonne a 1440** **[IS 4]**: principale (fino a 720px) con QUEUES e
  WORK; laterale 320px con WORKERS, AI ACCOUNTS, RECENT ERRORS, NIGHTLY RUN,
  separata da un filetto `rule`.

#### QUEUES / CODE

- Una riga per **progetto visibile con lavoro negli ultimi 7 giorni o in
  pausa**; sotto, 12px: «Projects with no work aren't listed.» / «I progetti
  senza lavoro non sono elencati.» Ordine: in pausa, poi con lavori falliti,
  poi per codice.
- **Riga** (56px): codice 600 + nome (ellissi) · conteggi «1 running · 2
  waiting · 1 failed» / «1 in corso · 2 in attesa · 1 non riuscito» (cifre
  tabellari; uno zero si omette, tutto zero «Nothing running» / «Niente in
  corso») · se in pausa, sulla seconda riga «‖ Paused by Roberta Fontana ·
  yesterday at 18:00» / «‖ In pausa da Roberta Fontana · ieri alle 18:00»
  (il nome resta anche se la persona è stata disattivata, con
  «(deactivated)») · a destra **Pause** / **Metti in pausa** oppure
  **Resume** / **Riprendi** (secondari).
- **Other projects** / **Altri progetti** (ultima, `ink-muted`): solo i
  conteggi, nessuna azione, `title` «Projects you can't see.» / «Progetti
  che non vedi.»
- Senza `settings.manage`: Pause/Resume visibili e spenti, frase breve e
  **Who?** (`manageSettings`).
- **Pause…** (dialogo 480px): «Pause STW's queue?» / «Mettere in pausa la
  coda di STW?» · conseguenze in righe:
  - «Work already running finishes.» / «Il lavoro già partito finisce.»
  - «New work waits: starting Claude on a task, corrections, pull request
    reviews, server analyses and fixes, automation steps that use Claude.» /
    «Il lavoro nuovo aspetta: avviare Claude su una task, correzioni,
    revisioni delle pull request, analisi e correzioni dei server, passi
    delle automazioni che usano Claude.»
  - «Ask Claude isn't affected.» / «“Chiedi a Claude” non cambia.»
  - «Everyone in STW reads “Queue paused by Roberta Fontana”.» / «Tutti in
    STW leggono “Coda in pausa da Roberta Fontana”.»
  → **Pause queue** / **Metti in pausa** → toast «STW's queue is paused.» /
  «La coda di STW è in pausa.» Nessuna riconferma (*scelta del
  controller*: agisce solo sulla coda, non su un segreto).
- **Resume…** (dialogo 440px): «Resume STW's queue? 2 waiting jobs start
  now, in the order they arrived.» / «Riprendere la coda di STW? I 2 lavori
  in attesa partono adesso, nell'ordine in cui sono arrivati.» Con zero
  lavori: «Nothing is waiting.» / «Non c'è niente in attesa.» → **Resume
  queue** / **Riprendi la coda** → toast «STW's queue is running again.» /
  «La coda di STW è ripartita.» Se uno dei lavori resta fermo per il budget,
  riga in più nel dialogo: «1 of them still waits for the monthly AI
  budget.» / «Uno di questi aspetta ancora il budget AI del mese.»

#### WORK / LAVORI

- Barra: **All · Running · Waiting · Failed** / **Tutti · In corso · In
  attesa · Non riusciti** (segmentato) · **Project** (menu dei progetti
  visibili) · **Type** (menu dei tipi). Filtri nell'indirizzo.
- **Tipi** in parola: Task run / Esecuzione della task · Correction /
  Correzione · PR review / Revisione della PR · Server analysis / Analisi del
  server · Server fix / Correzione del server · Automation / Automazione ·
  Nightly run / Giro notturno (questi ultimi solo nella colonna laterale).
- **Riga** (52px, due righe): glifo di stato · **codice** (task «ACQ-57»,
  esecuzione «ACQ-A2 #7», server «SRV-2») link all'oggetto · tipo in parola ·
  titolo (ellissi) · a destra l'età («12 min», «2 h», «yesterday») ·
  seconda riga 13px: lo **stato in parole**:
  - `running`: «▸ Running · worker 1» / «▸ In corso · worker 1»;
  - `waiting` coda in pausa: «◷ Waiting: queue paused by Roberta Fontana» /
    «◷ In attesa: coda in pausa da Roberta Fontana»;
  - `waiting` budget: «◷ Waiting: monthly AI budget reached» / «◷ In
    attesa: budget AI del mese raggiunto»;
  - `waiting` quota: «◷ Waiting: AI accounts at their limit» / «◷ In attesa:
    account AI al limite»;
  - `failed`: «✕ Failed yesterday at 16:20 · Tests didn't pass after the
    fix» / «✕ Non riuscito ieri alle 16:20 · I test non passavano dopo la
    correzione» (`critical` sul glifo e sulla parola, non sulla frase).
- **Retry** / **Rimetti in coda** **[IS 5]** (secondario, solo sui `failed`):
  - etichette mai «Riprova» / «Rilancia» (`noDeploy`): in italiano
    **Rimetti in coda**; in inglese **Retry** è ammesso;
  - spento per permesso, con **Who?**: senza `settings.manage`
    (`manageSettings`), oppure senza `runs.start` nel progetto (`startRun`);
  - `unavailable` su una correzione ferma o fallita: niente bottone, riga
    12px «Corrections are resumed from the task.» / «Le correzioni si
    riprendono dalla task.» + link **Open task** / **Apri la task**;
  - dialogo 480px: «Put ACQ-49's work back in the queue?» / «Rimettere in
    coda il lavoro di ACQ-49?» ·
    - «Claude starts again from the beginning, on your behalf, as if you
      pressed Start.» / «Claude riparte dall'inizio, a nome tuo, come se
      avessi premuto Avvia.»
    - (solo senza `plans.approve` in ACQ) «It stops at the plan, for someone
      who can approve plans in ACQ.» / «Si ferma al piano, per chi può
      approvare i piani in ACQ.»
    - (solo con la coda del progetto in pausa) «ACQ's queue is paused: it
      waits for Resume.» / «La coda di ACQ è in pausa: aspetta la ripresa.»
    → **Retry** / **Rimetti in coda** → toast «ACQ-49 is back in the queue.» /
    «ACQ-49 è di nuovo in coda.» · **Open task** / **Apri la task**;
  - `conflict`: «ACQ-49 already has work running. Nothing was added.» /
    «ACQ-49 ha già un lavoro in corso. Non è stato aggiunto niente.»
- Nessun lavoro col filtro: «Nothing matches.» / «Niente corrisponde.» ·
  **Clear filters**; nessun lavoro affatto: «Nothing running, waiting or
  failed in the last 7 days.» / «Niente in corso, in attesa o non riuscito
  negli ultimi 7 giorni.»

#### Colonna laterale

- **WORKERS**: due righe «Worker 1 · ACQ-57 Task run · 12 min» / «Worker 2
  · idle» / «Worker 2 · libero». Riga 12px `ink-faint`: «Prototype: two
  simulated workers.» / «Prototipo: due worker simulati.» Un lavoro di un
  progetto invisibile: «Worker 2 · busy in a project you can't see» /
  «Worker 2 · occupato in un progetto che non vedi».
- **AI ACCOUNTS / ACCOUNT AI**: una riga per account con la banda di
  `admin-ai.md` («week 41%», «▲ Near the limit · 87%», «● At the limit until
  16:00»); spento: «off» / «spento». Link **Open AI accounts** / **Apri gli
  account AI** solo per chi vede AI → Providers.
- **RECENT ERRORS / ERRORI RECENTI**: fino a 5, il più recente in alto:
  quando (12px tnum) · codice · frase del fallimento (due righe) · **Open
  task** / **Open run**. Vuoto: «No errors in the last 7 days.» / «Nessun
  errore negli ultimi 7 giorni.»
- **NIGHTLY RUN · LAST NIGHT / GIRO NOTTURNO · STANOTTE**: le 4 righe del
  seme, repository · fase («Commit summaries» / «Riassunti dei commit»,
  «Release note» / «Nota di rilascio», «Docs») · stato («✓ done», «▸
  running», «◷ waiting», «✕ failed» + frase). Riga 12px: «Read only: the
  nightly run picks up where it stopped.» / «Solo da leggere: il giro
  notturno riprende da dove si è fermato.» Nessuna azione.

#### Confine, aggiornamento

- In fondo alla pagina, 13px ○, sempre: «Stubwise only changes its own queue
  here: nothing restarts a server, a worker or a deploy.» / «Qui Stubwise
  cambia solo la propria coda: niente riavvia un server, un worker o un
  deploy.» (`noDeploy` la ammette perché nega).
- **Ogni 10 secondi** la pagina si ricarica in silenzio: le righe nuove
  hanno lo sfondo `ink/6` per 2 s, quelle uscite spariscono in 150ms; il
  fuoco resta sul controllo che lo aveva (se la riga è sparita, va al titolo
  della sezione). `aria-live="polite"` annuncia solo i cambi dei conteggi di
  una coda («STW: 2 running») e un lavoro fallito nuovo, non ogni giro.
- Con un dialogo aperto l'aggiornamento non cambia il contenuto del dialogo.

## 4. Ambito e confini

- **Dentro**: le tre pagine; New server senza ambiente; 30d/90d nel
  dettaglio (anche dal progetto); le due azioni leggere con conferma e voce
  del registro; l'aggiornamento ogni 10 s.
- **Fuori**: azioni sui server, sui worker, sui processi; un «Run now» del
  giro notturno; annullare un lavoro da qui; modificare un repository da
  qui (9c); grafici storici della coda.
- **Anti-obiettivi**: un bottone che riavvia o ridistribuisce; «Riprova» o
  «Rilancia» come etichetta; un progetto invisibile per nome in una riga di
  coda, lavoro, server o errore; un lavoro fermo senza il perché; una pausa
  senza il nome di chi l'ha messa.

## 5. Stati e intervalli

| Pagina | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Servers | 4 righe scheletro da 56px | «No servers yet. Create one here, or from a project's environments.» / «Nessun server. Creane uno qui, o dagli ambienti di un progetto.» + **New server** | «Couldn't load the servers.» · **Retry** / **Riprova** |
| Dettaglio | come l'8b | come l'8b; 30d/90d senza dati: «No data in this range» | come l'8b |
| Repositories | 2 gruppi scheletro | «No repositories in the projects you can see.» / «Nessun repository nei progetti che vedi.» | «Couldn't load the repositories.» · **Retry** |
| Instance status | 4 code + 6 lavori + colonna scheletro | code: «No project has work right now.» / «Nessun progetto ha lavoro adesso.»; lavori: vedi sopra | «Couldn't load the instance status.» / «Impossibile caricare lo stato dell'istanza.» · **Load again** / **Ricarica** **[IS 6]** |

- Un errore di un aggiornamento automatico non svuota la pagina: riga 12px
  in testa «Couldn't update at 08:41:22. Showing 08:41:12.» / «Aggiornamento
  delle 08:41:22 non riuscito. Mostro quello delle 08:41:12.», e si riprova
  al giro dopo.
- **Senza permessi**: ogni voce assente senza il suo permesso, «not found»
  per indirizzo; Instance status in sola lettura con il solo
  `instance.status.view` (azioni spente con **Who?**).
- **Istanza vuota**: nessun server, nessun repository, code vuote, worker
  liberi, nessun account AI («No AI accounts.» + link se visibile).
- **Rifiuti** (stato invariato): `forbidden` «You can no longer do this.»;
  `already_paused` «Someone already paused STW's queue.» / «Qualcuno ha già
  messo in pausa la coda di STW.» (la riga si aggiorna); `not_retryable`
  come «unavailable»; `conflict` come sopra; errore «Couldn't do it. Try
  again.» / «Non è riuscito. Prova di nuovo.» (mai «Riprova» come
  etichetta di un bottone in questa pagina).
- **Intervalli**: server 0–60 (gruppi sempre visibili se non vuoti), 0–40
  progetti per server; repository 0–200 in 0–50 progetti; code 0–50 righe,
  lavori 0–200 (oltre 50, «Show 50 more» / «Mostrane altri 50»), errori 0–5
  visibili, giro notturno 0–20 righe.

## 6. Interazione e layout

- Servers e Repositories fino a 960px; Instance status fino a 1080px.
- Dialoghi: il fuoco va al bottone d'annullamento (le azioni non sono
  distruttive ma toccano altri); dopo la conferma torna alla riga.
- **1440×900**: Instance status a due colonne come nello schizzo; Servers con
  la colonna dei progetti.
- **1024×680** (720px utili):
  - Instance status a **una colonna**: QUEUES, WORK, poi WORKERS, AI
    ACCOUNTS, RECENT ERRORS, NIGHTLY RUN; worker e account in due colonne
    affiancate di 340px;
  - nelle righe dei lavori l'età scende sulla seconda riga a destra, il
    bottone Retry sotto lo stato;
  - in Servers i codici dei progetti scendono sulla seconda riga dopo gli
    ambienti, il mini-grafico resta;
  - il dettaglio del server mette i 5 intervalli in un gruppo che va a capo
    se non ci sta;
  - Repositories: il nome completo scende sotto il nome.

## 7. Vincoli

- Solo via `data/queries/instance.ts` (`listAllServers`, `createServer`
  con `environmentId: null`, `listAllRepositories`, `getInstanceStatus` con
  `refetchInterval: 10_000`, `retryJob`, `pauseQueue`, `resumeQueue`) e le
  query dell'8b per il dettaglio.
- `expectNoDeploy()` in en e in it su Instance status: per questo il bottone
  dell'errore è «Load again» / «Ricarica» e Retry è «Rimetti in coda» in
  italiano.
- Le disponibilità (`retry`, `pause`) vengono dalla vista (`ActionAvailability`),
  non da un controllo nella pagina.
- **Voci del registro**:
  - gruppo `queue` (di progetto, `settings.manage`):
    - `queue.paused`: «**Roberta Fontana** paused STW's queue.» /
      «**Roberta Fontana** ha messo in pausa la coda di STW.»
    - `queue.resumed`: «…resumed STW's queue.» / «…ha ripreso la coda di
      STW.» (prima/dopo «Paused since Oct 29, 18:00 → Running»)
    - `job.retried`: «…put the work on **ACQ-49** back in the queue.» /
      «…ha rimesso in coda il lavoro di **ACQ-49**.»
  - gruppo `servers` (`monitor.manage`):
    - `server.created`: «…created the server **SRV-7** (not in any
      project).» / «…ha creato il server **SRV-7** (in nessun progetto).»
    - `server.updated`: «…changed the server **SRV-2**.» / «…ha modificato
      il server **SRV-2**.» (nome, ambiente nel prima/dopo)
    - `server.deleted`: «…deleted the server **SRV-4**.» / «…ha eliminato il
      server **SRV-4**.»
    - `server.agent_key_regenerated`: «…made a new agent key for **SRV-2**.»
      / «…ha creato una nuova chiave dell'agente per **SRV-2**.» (mai la
      chiave)
    - `server.thresholds_changed`: «…changed the alert thresholds of
      **SRV-2**.» / «…ha cambiato le soglie d'allarme di **SRV-2**.» («CPU
      85% → 90%»)
    - `server.check_changed`: «…changed the check “HTTP /health” on
      **SRV-2**.» / «…ha modificato il controllo “HTTP /health” su
      **SRV-2**.»
    - `server.ssh_access_changed`: «…changed SSH access to **SRV-2**.» /
      «…ha cambiato l'accesso SSH a **SRV-2**.» (mai chiavi)
- Testi en/it con parità. Il nome della persona del seme è **Roberta
  Fontana** (il piano scrive «Roberta Ferri» in due test: è una svista).

## Scelte del brief (scelte del controller, da confermare)

1. **[IS 1]** Instance status ordinato «code → lavori», con macchine e notte
   di lato.
2. **[IS 2]** Servers in tre gruppi, con gli orfani in un gruppo loro in
   fondo.
3. **[IS 3]** «New server» da Amministrazione crea solo senza ambiente; si
   collega a un progetto dagli ambienti.
4. **[IS 4]** Due colonne a 1440, una a 1024.
5. **[IS 5]** «Retry» in inglese, «Rimetti in coda» in italiano.
6. **[IS 6]** Il bottone d'errore di Instance status è «Load again» /
   «Ricarica», per non incappare nel divieto di «Riprova».
7. **[IS 7]** Pause e Resume con conferma ma senza riconferma.
8. **[IS 8]** In QUEUES solo i progetti con lavoro negli ultimi 7 giorni o in
   pausa.

## Scelte confermate dal maintainer (30 ott 2026)

1. **[IS 3]** Un server creato da Amministrazione nasce **sempre** senza
   progetto: il dialogo non offre ambienti; lo si collega dagli ambienti del
   progetto.
