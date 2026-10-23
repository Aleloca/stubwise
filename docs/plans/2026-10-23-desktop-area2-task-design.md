# App desktop Stubwise, area 2: il nucleo delle task — design

Data: 23 ott 2026. Secondo documento della serie aperta da
`docs/plans/2026-10-23-desktop-ossatura-design.md` (l'ossatura, costruita
sul branch `feat/desktop-app`). Si costruisce nel prototipo con dati finti,
con le stesse regole: ogni pagina definita fino in fondo (contenuti, azioni,
stati vuoto/caricamento/errore/pieno, permessi, transizioni), nessuna parte
abbozzata. Linguaggio visivo: `apps/desktop/DESIGN.md` («Catalogo
numerato»). Le cose rimaste aperte dall'ossatura sono in
`apps/desktop/docs/ossatura-follow-ups.md`.

Le decisioni marcate *(maintainer)* vengono dalla conversazione con il
maintainer; quelle marcate *(scelta del costruttore)* sono proposte
confermabili.

## Perché

L'area 2 è il motivo per cui l'app esiste: il posto in cui tutti i reparti
tengono il proprio lavoro al posto di Jira. Se qui il team non riesce a
capire cosa deve fare, cosa è fermo e cosa si fa questa settimana, il resto
dell'app non serve. Da Jira il team vuole tenere board, filtri, pianificazione
e traguardi; vuole perdere il gergo (sprint, epiche, backlog) e il costo.

## Cosa copre

1. **Livello dati consapevole di chi guarda** (primo passo, prerequisito).
2. **Home** a blocchi, con la mia settimana.
3. **Tasks** di progetto: elenco, board, timeline, e il **dettaglio della
   task** come pannello.
4. **Filtri salvati**, privati o pubblici, trasversali ai progetti.
5. **Planning** di progetto (e trasversale per chi pianifica).
6. **Requests** (oggi Backlog) e passaggio richiesta → task.
7. **Overview** di progetto.
8. **Tutti i progetti** (portafoglio).
9. **Stati per progetto** e **composizione dei modelli** di progetto (che
   l'ossatura rimandava a questo documento).

## Obiettivi

- Chiunque, aprendo l'app, vede per primo ciò che serve al suo lavoro: le
  priorità variano per persona e per reparto *(maintainer)*.
- Chi pianifica vede in un colpo solo le task aperte, quanto è carica ogni
  persona e cosa è già nella settimana *(maintainer)*.
- Aprendo un progetto mai visto da due settimane si capisce in dieci secondi
  a che punto è, cosa è aperto, cosa è fermo, da quanto e perché
  *(maintainer)*.
- I filtri di Jira hanno un equivalente: task aperte, task chiuse in un
  periodo, ecc., salvabili *(maintainer)*.
- Parità con il web per tutto ciò che questa area eredita (vedi «Parità»).

## Non obiettivi

- Sprint, epiche, story point, ore. Le stime sono in taglie *(maintainer)*.
- Workflow con transizioni vincolate (stato A può andare solo in B): gli
  stati di un progetto sono un elenco ordinato, ci si sposta liberamente.
- Il lavoro di Claude in dettaglio (sessioni dal vivo, piano e sua
  approvazione, domande, PR e correzioni): è l'area 3. Qui Claude è
  assegnabile e il suo stato si vede; vedi «Dettaglio della task».
- Chat, Docs, Drive, Mail, Calendar, Automations, Releases, Support,
  Servers: aree successive. Qui compaiono solo come link o blocchi della
  Home già predisposti a riceverle.
- Gestione completa di ruoli e permessi (area 9). Qui si introducono solo i
  permessi che questa area usa.

## Anti-obiettivi

- Una Home uguale per tutti che mostra a ciascuno le cose di qualcun altro.
- Un «perché è ferma» che non dice niente («nessuna attività»), quando l'app
  sa già il motivo vero.
- Ricreare Jira: schermate di configurazione del workflow, campi
  personalizzati a decine, schemi di permessi per tipo di task.
- Un filtro pubblico che fa vedere a qualcuno task che non potrebbe vedere.
- Contare le task come misura del carico senza dire che le task senza stima
  mancano dal conto.

## Modelli che questa area introduce

### Forma dei dati del prototipo *(scelta del costruttore)*

Come nell'ossatura: dove un'entità esiste negli schemi di `@stubwise/shared`
se ne tiene la forma; le entità nuove hanno tipi propri scritti come proposta
di schema. Gli stati per progetto sono nuovi: la task perde l'enum condiviso
`ticketStatusSchema` e porta `statusId` verso uno stato del progetto, con
la famiglia. Il documento del backend dirà come gli stati di oggi (e quelli
che la pipeline di Claude imposta da sola, `in_review` e `done`) si
mappano sulle famiglie; nel prototipo la pipeline porta la task nel primo
stato `active` dopo quello di partenza e, a lavoro chiuso, nel primo
`closed`.

### Stati per progetto *(maintainer)*

- Gli **stati appartengono al progetto**, non al reparto. Un reparto non ha
  stati propri.
- Il modello di progetto propone gli stati iniziali; chi ha
  `project.settings.manage` li aggiunge, rinomina, riordina, elimina (con
  spostamento delle task di quello stato in un altro, scelto nel dialogo).
- *(scelta del costruttore)* Ogni stato appartiene a una di tre **famiglie**:
  `todo` (da fare), `active` (in corso), `closed` (chiuso). Le viste che
  uniscono più progetti (Home, filtri, Planning trasversale, Tutti i
  progetti) ragionano per famiglia; dentro un progetto si vedono gli stati
  veri. Una task «aperta» è una task non `closed`. Ogni progetto ha almeno
  uno stato per famiglia; il primo stato `todo` è quello di nascita.
- Il colore di uno stato è dato dalla sua famiglia (tre toni neutri, il
  colore resta dei reparti); il nome dello stato è sempre scritto.

### Modelli di progetto *(scelta del costruttore, confermabile)*

| Modello | Moduli accesi | Stati iniziali (famiglia) |
|---|---|---|
| Software | Docs, Releases, Support, Servers | Da fare (todo) · In corso (active) · In revisione (active) · Fatto (closed) · Scartato (closed) |
| Marketing | nessuno | Idea (todo) · Bozza (active) · In approvazione (active) · Pubblicato (closed) · Scartato (closed) |
| Commessa cliente | Docs | Da fare (todo) · In corso (active) · Attesa cliente (active) · Consegnato (closed) · Scartato (closed) |
| Vuoto | nessuno | Da fare (todo) · In corso (active) · Fatto (closed) |

I modelli sono configurabili dall'amministrazione (area 9); qui sono dati
del seed.

### Taglie *(maintainer)*

Stima indicativa in taglie, non in ore: **XS, S, M, L, XL**. Facoltativa.
*(scelta del costruttore)* Per sommare il carico le taglie pesano 1, 2, 3,
5, 8; il peso non si mostra mai come numero all'utente, solo come
lunghezza di barra. Nessun limite fisso di capacità per persona: la barra
mostra il carico, il giudizio è di chi pianifica. Le task senza stima si
contano a parte e si dichiarano («+3 senza stima»).

### Richiesta di decisione *(maintainer)*

Su una task chiunque possa vederla e commentarla (`tickets.comment`) può
**chiedere a una persona di decidere**: testo della domanda e, se vuole,
opzioni fra cui scegliere (più «Altro…» a testo libero). Finché è aperta:

- compare in **Da decidere** nella Home di quella persona, risolvibile sul
  posto;
- la task è **ferma** con il motivo automatico «aspetta la decisione di
  <persona>», dal momento della richiesta;
- sulla tessera del progetto di quella persona si accende il punto «ti
  aspetta».

La risposta (opzione o testo, chi e quando) entra nell'attività della task e
avvisa chi l'ha chiesta nelle notifiche. Chi l'ha chiesta può ritirarla. Più
richieste aperte sulla stessa task sono ammesse, verso persone diverse.
*(scelta del costruttore)* Non entra nel registro decisioni del progetto in
automatico: si può registrare a mano da lì, come oggi.

### Permessi

Il modello resta quello di oggi: una persona ha un **ruolo in un progetto**,
il ruolo contiene i permessi; il server li calcola, il client li legge
*(maintainer)*. Permessi di progetto che questa area usa (in grassetto i
nuovi):

- `backlog.create` (nella UI «inviare richieste») — inviare una richiesta
  al progetto. *(scelta del costruttore)* È il permesso di oggi, rinominato
  solo nella UI, come `tickets.create` qui sotto.
- `tickets.create` (nella UI «creare task») — creare una task da zero o da
  una richiesta, con o senza refine con Claude *(maintainer)*.
- `tickets.edit` — modificare campi, stato, traguardi.
- **`planning.others`** — pianificare le task altrui (dall'ossatura).
- `project.settings.manage` — stati del progetto, moduli.

**Ruoli di reparto** *(maintainer)*: una persona può avere un ruolo anche in
un reparto, con permessi di reparto. In questa area ne esiste uno solo:
**`department.home.manage`** — decidere la Home predefinita del reparto.
*(scelta del costruttore)* Nel prototipo i ruoli di reparto sono dati del
seed e del «vedi come»; la loro gestione è area 9.

*(scelta del costruttore)* I permessi nuovi (`planning.others`,
`department.home.manage`) vivono **nel prototipo** (`data/viewer.ts`), non
nel registro di `@stubwise/shared`: entrano nel registro vero quando si
costruisce il backend, con i test del server. Nei preset: `planning.others`
al Project Lead (e al full admin); Developer e Contributor no.

**Filtri pubblici** *(scelta del costruttore)*: qualunque persona può
pubblicare un filtro; lo modifica o lo elimina solo l'autore o un full
admin.

## 1. Livello dati consapevole di chi guarda

Prerequisito di tutto il resto (da `ossatura-follow-ups.md`). Oggi «vedi
come» cambia i permessi ma non i dati.

- Una **sessione finta** nel livello dati: `currentPersonId` in
  `data/api.ts`, impostato da `ViewerProvider`, parte delle chiavi di ogni
  query (cambiare persona ricarica tutto, nessun dato della persona
  precedente resta a schermo).
- **Visibilità come sul server**: un progetto si vede se si è membri o full
  admin; ogni elenco filtra prima di contare e paginare; un progetto
  invisibile aperto da URL dà la stessa pagina di «non esiste».
- Filtri per membro e destinatario su progetti, ricerca, notifiche,
  progetti fissati (ognuno ha i suoi), Home, filtri salvati (i pubblici
  passano dalla stessa visibilità).
- Reparti e persone letti via query, non importati dal seed nei componenti
  (`DeptStrip`, `ProfileMenu`).
- Il segnale «ti aspetta» delle tessere si **deriva** dai dati (decisioni
  aperte per quella persona in quel progetto), non è più un flag del seed.
- Le persone del «vedi come» coprono ruoli e reparti diversi: almeno una
  del marketing con ruolo di reparto che gestisce la Home, una dello
  sviluppo, una dell'assistenza o amministrazione senza permessi di
  pianificazione, un full admin.

## 2. Home

La Home è fatta di **blocchi** *(maintainer)*.

### Composizione

- Ogni **reparto** ha una **Home predefinita**: quali blocchi e in che
  ordine. La decide chi ha `department.home.manage` su quel reparto
  *(maintainer)*.
- Una persona in più reparti vede l'unione dei blocchi dei suoi reparti
  *(scelta del costruttore: in ordine del primo reparto, i blocchi doppi
  una volta sola)*.
- Ognuno può **personalizzare la propria Home** (nascondere, aggiungere,
  riordinare) senza toccare quella del reparto; «Ripristina la Home del
  reparto» torna al predefinito. Se il reparto cambia la sua Home dopo,
  *(scelta del costruttore)* chi ha personalizzato tiene la sua e vede una
  riga discreta «La Home del reparto è cambiata · Vedi le novità».
- La modifica è in **modalità modifica** esplicita (bottone «Personalizza»):
  trascinamento con mouse e tastiera, nascondi, aggiungi da un catalogo. Chi
  ha `department.home.manage` sceglie all'ingresso se modificare «la mia
  Home» o «la Home di <reparto>».

### Blocchi fissi (non si nascondono)

- **Da decidere**: tutto ciò che aspetta una tua decisione, risolvibile sul
  posto (vedi ossatura). In questa area le voci sono: le **richieste di
  decisione** rivolte a te (vedi sopra) e le richieste da trasformare nei
  progetti dove puoi creare task. Le voci di
  Claude (domande, piani) si aggiungono nell'area 3 con la stessa forma.
  Vuoto: «Niente da decidere».
- **La mia settimana**: le mie task pianificate per questa settimana,
  sistemabili nei giorni (lun–ven, più «in settimana» senza giorno).
  *(scelta del costruttore)* Il giorno è una sistemazione **personale**
  dell'assegnatario, non un campo della task: lo vede solo lui, e si azzera
  se la task cambia settimana o assegnatario. Mostra
  le slittate dalla settimana prima con il segno di slittamento, la barra
  del mio carico in taglie, «Pianifica la prossima settimana» (passa alla
  settimana dopo nello stesso blocco).

### Catalogo dei blocchi aggiungibili *(scelta del costruttore)*

- **Le mie task**: assegnate a me / delegate da me / che seguo, raggruppate
  per scadenza (in ritardo, oggi, questa settimana, più avanti, senza data).
- **Lavoro di Claude per me**: task che ho affidato a Claude e il loro stato
  (sta lavorando, aspetta, fermo). Nell'area 3 diventa più ricco.
- **Ferme nei miei progetti**: task ferme dei progetti di cui sono membro,
  con giorni e motivo.
- **Richieste nuove**: richieste arrivate nei progetti dove posso creare
  task, non ancora trasformate.
- **Traguardi in arrivo**: traguardi dei miei progetti nelle prossime 4
  settimane, con avanzamento.
- **Un filtro salvato**: qualunque filtro (mio o pubblico) come blocco, con
  le prime righe e «Apri».
- I blocchi delle aree successive (canali con non letti, posta da gestire,
  rilasci da mergiare, conversazioni di assistenza aperte…) entrano nel
  catalogo con la loro area. Un blocco che richiede un permesso non compare
  nel catalogo di chi non ce l'ha.

### Colonna della Home

Sottoviste: **Home**, **La mia settimana** (a tutta pagina), poi i **filtri
fissati** dalla persona, poi «Tutti i filtri».

## 3. Tasks (di progetto)

Le task sono i ticket di oggi allargati a tutti i reparti. Codice
`<PROGETTO>-<n>`, striscia del reparto, nome sempre accanto al codice.

### Campi di una task

Titolo, descrizione (markdown), stato (del progetto), reparto, assegnatario
(persona o Claude), taglia, scadenza, settimana pianificata, traguardo,
etichette, richiesta d'origine (se c'è), task collegate (blocca / è
bloccata da / correlata / padre), allegati, chi la segue. Per le task
tecniche restano tipo e priorità di oggi *(scelta del costruttore: tipo e
priorità valgono per tutti i reparti, sono neutri — «bug», «funzionalità»,
«attività» —; la decisione è confermabile)*.

### Viste

Una barra in cima: **Elenco · Board · Timeline**, la barra dei filtri, «Salva
come filtro», «Nuova task».

- **Elenco**: denso, raggruppabile (stato, assegnatario, reparto, traguardo,
  settimana), ordinabile, selezione multipla con azioni in blocco (stato,
  assegnatario, settimana, traguardo, taglia). Righe con striscia del
  reparto, codice, titolo, stato, assegnatario, taglia, scadenza, segno
  «ferma».
- **Board**: una colonna per stato del progetto, nell'ordine del progetto.
  Trascinamento con mouse e tastiera (come oggi: Spazio prende, frecce
  spostano, Invio apre), ottimistico con ritorno indietro su errore.
  Carte: striscia, codice, titolo, assegnatario, taglia, segno «ferma».
  Raggruppabile in corsie (assegnatario o reparto).
- **Timeline**: asse per settimane; i traguardi come colonne con la loro
  data; le task come barre dalla settimana pianificata alla scadenza (o un
  punto se ne hanno una sola); le task senza date in un elenco a parte
  «Senza date». La lunghezza di una barra è la sua durata esatta (regola
  del linguaggio visivo).

### Dettaglio della task (pannello)

Si apre come pannello a destra sopra la vista, senza cambiare pagina;
ridimensionabile; ha anche un indirizzo suo (link condivisibile, ⌘K). Dall'
alto:

- **Decisioni**: le richieste di decisione aperte e chiuse, con
  «Chiedi una decisione».
- Testata: codice, titolo modificabile, stato, assegnatario, reparto,
  taglia, scadenza, settimana, traguardo; «Segui».
- **Ferma**: se lo è, il motivo e da quanti giorni (vedi «Ferme») e, se il
  motivo è manuale, la nota e «Non è più ferma».
- Descrizione.
- **Claude**: lo stato del lavoro di Claude sulla task (nessuno, sta
  lavorando, aspetta una risposta, aspetta un'approvazione, fermo, finito)
  e «Assegna a Claude». *(scelta del costruttore)* Il contenuto completo
  (piano, approvazione, sessione dal vivo, PR, correzioni, storia del
  lavoro) è dell'area 3; qui la sezione esiste con il suo stato reale nei
  dati finti e un link alla sessione che l'area 3 renderà vivo.
- Richiesta d'origine, task collegate, allegati.
- **Attività**: commenti (markdown, risposte, modifica ed eliminazione come
  oggi) e cambiamenti di campo, in un solo flusso.

### Nuova task

Dialogo: titolo, progetto (preselezionato), reparto (proposto: il primo
reparto di chi crea), descrizione, assegnatario, taglia, stato iniziale (il
primo `todo`), settimana, traguardo. Richiede `tickets.create` nel
progetto; dalla Home e da ⌘K si sceglie il progetto fra quelli dove si ha il
permesso.

## 4. Filtri salvati *(maintainer)*

- Criteri combinabili: progetto, reparto, assegnatario (Claude incluso),
  famiglia di stato o stato preciso (questo solo con un progetto solo),
  taglia (incluso «senza stima»), traguardo, «ferma», periodo su creazione /
  chiusura / settimana pianificata / scadenza (relativo: «ultimi 7 giorni»,
  «questo mese»; o assoluto), testo.
- Un filtro ricorda anche la vista (elenco, board, timeline) e il
  raggruppamento. La board di un filtro su più progetti ha colonne per
  famiglia.
- **Privato o pubblico**, nient'altro: niente condivisione con singole
  persone o reparti. Un filtro pubblico lo vedono tutti; **ognuno ci trova
  solo le task che può già vedere**.
- Si apre come pagina dalla colonna della Home (se fissato), da «Tutti i
  filtri», da ⌘K. Si può fissare nella colonna o mettere come blocco della
  Home.
- Dentro un progetto la barra dei filtri è la stessa, con il progetto
  fissato; «Salva come filtro» salva con quel progetto.
- Filtri pubblici di esempio nel seed: «Aperte», «Chiuse questo mese»,
  «Ferme da più di 7 giorni», «Senza stima», «Senza assegnatario».

## 5. Planning *(maintainer)*

Vista a due parti, dentro il progetto:

- **A sinistra, le task da pianificare**: aperte, senza settimana o
  slittate, filtrabili (barra dei filtri, raggruppabile per reparto o
  traguardo).
- **A destra, le persone** (membri del progetto, Claude compreso) per le
  settimane: questa, prossima, quella dopo (si scorre avanti). Per ogni
  persona: quante task aperte ha in tutto (in questo progetto e in tutti),
  quante sono già nella settimana, quante ne sono slittate, la **barra del
  carico in taglie** per settimana, e le task senza stima a parte. Il
  carico «in tutti i progetti» conta perché una persona lavora su più
  progetti *(scelta del costruttore)*.
- **Trascinare** una task su una persona in una settimana la assegna e la
  pianifica. Trascinarla fra settimane la ripianifica. Tastiera: seleziona
  la task, scegli persona e settimana da un menu.
- Chi ha `planning.others` muove le task di tutti; chi non ce l'ha muove solo
  le proprie, e le righe altrui sono in sola lettura. Chi viene spostato è
  avvisato nelle notifiche di cosa è cambiato e da chi.
- **Slittamento**: una task aperta della settimana passata passa da sola
  alla settimana corrente con il segno «slittata» (e quante volte).
- *(scelta del costruttore)* Una vista **Planning trasversale** (stessa
  forma, tutti i progetti, persone di un reparto) si raggiunge dalla
  colonna della Home per chi ha `planning.others` in almeno un progetto:
  chi pianifica le persone di un reparto le vede su tutti i progetti. Il
  reparto si sceglie in testa alla vista (all'inizio il primo reparto di chi
  guarda). Il permesso si valuta **per task**: le task dei progetti in cui
  chi guarda non ha `planning.others` restano visibili in sola lettura, con
  il motivo al passaggio del mouse.

## 6. Requests

Oggi «Backlog». Le richieste di un progetto.

- **Elenco**: titolo, chi l'ha chiesta (e «chiesta N volte» se fusa),
  stato (nuova, in rifinitura, pronta, trasformata, archiviata), urgenza,
  task collegate. Filtri per stato e testo.
- **Nuova richiesta** (permesso `requests.create`): titolo, descrizione;
  come oggi, arriva all'intake che propone fusioni con richieste simili.
- **Dettaglio** (pannello): descrizione, richiedenti, simili, task nate da
  questa. Azioni: **Trasforma in task** (con `tickets.create`, apre il
  dialogo della nuova task precompilato e collega le due), **Rifinisci con
  Claude** (la sessione di refinement: qui l'avvio e lo stato, la
  conversazione è area 3), fondi in…, archivia, riapri. Una richiesta
  trasformata resta leggibile e mostra a che punto è la task: chi l'ha
  chiesta lo vede *(maintainer)*.
- Una task si crea anche senza richiesta *(maintainer)*.

## 7. Overview di progetto *(maintainer)*

Risponde a tre domande, in quest'ordine:

1. **A che punto è**: traguardi con data e avanzamento (taglie chiuse sulle
   totali, con le task senza stima dichiarate), cosa si è chiuso nelle
   ultime due settimane, il brief settimanale (narrativa generata, si dice
   che lo è).
2. **Cosa è aperto**: le task aperte per famiglia di stato e per persona,
   in numeri leggibili e cliccabili (aprono l'elenco filtrato).
3. **Cosa è fermo, da quanto, perché**: in cima alla pagina se c'è
   qualcosa; ordinato dal più vecchio.

Sotto: la cronologia del progetto (oggi Roadmap: task aperte/chiuse,
traguardi, decisioni, brief, report giornalieri, PR, filtrabile per tipo) e
il registro decisioni (fatti, mai scritti dall'AI).

### Ferme *(maintainer)*

Il motivo si **ricava** quando l'app lo sa, altrimenti si **scrive**:

- automatici: aspetta la decisione di <persona>; Claude ha fatto una domanda
  senza risposta; bloccata da <task>; non assegnata; nessuno la tocca da N
  giorni;
- manuale: chi ci lavora la segna «ferma» con un motivo esterno (es.
  «aspettiamo il cliente») e una nota; resta ferma finché qualcuno non la
  sblocca.

*(scelta del costruttore)* «Nessuno la tocca» scatta dopo 7 giorni per le
task `active` e 14 per le `todo` pianificate in una settimana passata; le
soglie sono impostazioni del progetto. Il conteggio dei giorni parte
dall'evento che l'ha fermata.

## 8. Tutti i progetti

Pagina del portafoglio (dall'ossatura).

- Elenco di tutti i progetti visibili: codice, nome, cliente, modello,
  riga di polso (aspetta te, Claude ci lavora, N ferme da più di N giorni,
  prossimo traguardo), fissato sì/no. Ordine: prima quelli che aspettano
  te, poi alfabetico (come la decisione del 28 set 2026 sul web).
- Filtri: interni/commesse, reparto (progetti con task di quel reparto),
  cliente, fissati, testo.
- Sezione **Ferme** trasversale: le task ferme di tutti i progetti visibili.
- **Attività** trasversale per data (oggi «Activity»).
- Azioni: fissa/sgancia, **Nuovo progetto** (con `projects.create`: nome,
  codice proposto dal nome e modificabile, tipo, cliente, modello; si atterra
  sulla sua Overview).

## Stati di ogni pagina

Ogni pagina ha caricamento (scheletri della forma vera), vuoto (con l'azione
che lo riempie, se il permesso c'è, o la frase che spiega chi può), errore
(con «Riprova», simulabile con `failNext`), pieno, e la versione senza
permessi verificata col «vedi come». Le azioni ottimistiche (board,
planning, Home) tornano indietro su errore con un messaggio che lo dice.

## Parità con il web

Questa area chiude, voce per voce, le righe dell'inventario
(`apps/desktop/docs/web-inventory.md`): Tickets (elenco, viste salvate,
nuovo ticket), dettaglio ticket (tranne le sezioni AI, area 3), Board,
Backlog (elenco, voce, conversione, fusione, archiviazione; refinement
fino all'avvio), Projects (elenco con polso, fermi, nuovo progetto),
traguardi, Roadmap, brief settimanale, registro decisioni (lettura e
registrazione a mano), Activity. Il piano di costruzione porta una tabella
di controllo con una riga per ogni voce.

## Dati finti

Il seed cresce: stati per progetto dai modelli, taglie, settimane
pianificate su più settimane (passate, corrente, future) con slittamenti,
traguardi con date, task ferme per ogni tipo di motivo, richieste in ogni
stato (alcune fuse), filtri privati e pubblici, Home predefinite per ogni
reparto e almeno una personalizzata, ruoli di reparto. I volumi restano
quelli dell'ossatura (~50 progetti, ~25 persone), con i progetti di
riferimento AUD, STW, MKX più ricchi.

## Decisioni aperte

- Cosa fa Claude su una task non tecnica (dall'ossatura, invariato).
- Se e come il carico si confronta con assenze e ferie (oggi non esistono).
