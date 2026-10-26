# Shape brief — Calendario

Superficie: destinazione «Calendar» del binario (`#/calendar?view=day|week|
month&date=YYYY-MM-DD&event=<id>&series=<id>`), la sua colonna personale
(mini-mese, calendari, serie ricorrenti), il dettaglio di un evento e di
una serie nel pannello di dettaglio, il dialogo «New meeting» / «Edit
meeting», il dialogo «Solo questo / Tutta la serie». Piano: Task 9 (dati
nel Task 5). Spec: area 6 «Calendario» (Cosa si vede, Agire), «Allineamento»,
«Permessi», «Stati», «Dati finti». La scheda di preparazione dentro il
dettaglio è in `meeting-prep.md`; le proposte di calendario nella Posta e in
«Da decidere» seguono `mail.md`. Mondo: «Catalogo numerato», modalità
**Operate**. **[A n]** = scelta del brief, elencata in fondo.

## 1. Lavoro e pubblico

- Chi arriva: chiunque abbia collegato l'account Google, la mattina per
  vedere la giornata e prepararsi, e più volte al giorno per rispondere a
  un invito, fissare una riunione con i colleghi o spostarne una.
  Commerciale e PM ci vivono più degli sviluppatori.
- Stato d'animo: «cosa ho oggi e con chi; questa riunione di cosa parla».
  Non esplora, controlla e agisce in fretta.
- Paura dichiarata (anti-obiettivo del maintainer): un calendario
  **indietro rispetto a Google**. Se un evento manca o è vecchio si torna a
  Google Calendar. Ogni vista dice quanto è aggiornata e si riallinea
  subito.

## 2. Esito e prova

- Azione primaria: aprire un evento e capire in un colpo d'occhio orario,
  partecipanti, progetto e come entrare; secondarie: rispondere a un
  invito, creare una riunione vedendo chi è libero, spostare un proprio
  evento trascinandolo.
- Successo: a 1440×900, in Week, la giornata di oggi si legge senza
  scorrere dalle 8 alle 19; un invito senza risposta si distingue da un
  evento accettato **senza colore**; chi non è organizzatore non trova
  maniglie che non può usare; la riga «Updated 2 min ago» è sempre a vista.
- Verità del prodotto: Stubwise **legge** il calendario da `now − 30` a
  `now + 60` giorni (`CALENDAR_LOOKBACK_DAYS` / `CALENDAR_WINDOW_DAYS`):
  fuori non c'è «niente in programma», c'è un tratto che Stubwise non
  guarda, e la griglia lo dice. Ogni evento ha un **progetto** deciso dal
  modello e correggibile a mano. Una riunione normale non produce
  proposte; le producono le serie accese, le trascrizioni e un evento
  futuro riconosciuto come scadenza. Mai un evento passato o rifiutato.
  La disponibilità dei colleghi è **libero/occupato**, mai titoli.

## 3. Direzione scelta

- **Tesi**: un **registro orario** — la griglia è un foglio a righe
  sottili, gli eventi sono voci del catalogo (codice del progetto in cifre
  tabellari accanto al titolo), non post-it colorati. Il calendario resta
  calmo e quasi monocromo: l'inchiostro fa la gerarchia, lo stato della
  risposta lo dicono **forma e parola** (pieno, contorno, barrato, «Not
  answered», «Maybe»), il colore compare solo per lo stato (salvataggio
  fallito, dato vecchio) e, quando ci sono più account, per l'account
  **[A 1]**.
- **Colonna personale** (240px, nessun titolo di colonna): in alto il
  **mini-mese**; poi `heading-group` CALENDARS con le caselle e il loro
  allineamento; poi `heading-group` RECURRING SERIES, richiudibile e chiusa
  di default (invariante: elenca **tutte** le serie, anche senza
  occorrenze nella finestra).
- **Testata dell'area di lavoro**: h1 28px «Calendar» · etichetta
  dell'intervallo in 14px tnum («Oct 19 – 25, 2026», «Friday, Oct 23»,
  «October 2026») · a destra **Today** · ‹ › · selettore **Day | Week |
  Month** (gruppo a schede, Week predefinita) · **New meeting** (primario
  pieno d'inchiostro, come «New task»).
- **Momento focale**: la colonna di **oggi** in Week, con la linea
  dell'ora corrente in inchiostro e il prossimo evento subito sotto; il
  clic su un evento apre il pannello di dettaglio con il titolo in
  `headline` e il bottone «Join Google Meet» in testa.

```
┌rail┬─column (240)────────┬─work area────────────────────────────────────────────────┐
│    │ ‹  October 2026  ›  │ Calendar  Oct 19 – 25, 2026   [Today] ‹ › [Day|Week|Month] [New meeting]│
│    │ M  T  W  T  F  S  S │       Mon 19  Tue 20  Wed 21  Thu 22  Fri 23·Today  Sat  Sun │
│    │ ▓▓ ▓▓ ▓▓ ▓▓ (23) …  │ ALL DAY                         ┌Offsite AUD──┐          │
│    │ ─────────────────── │  09 ┌AUD 09:30─┐        ┌STW────┐ │             │          │
│    │ CALENDARS           │     │Standup   │        │Review │ ┌╌╌╌╌╌╌╌╌╌╌╌╌┐          │
│    │ ☑ giulia@…          │  10 └──────────┘        └───────┘ ╎MKX Kickoff ╎ Not answered│
│    │   Updated 2 min ago │ ━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 10:42       │
│    │   [Refresh now]     │  11             ┌AUD──────┐       ┌AUD Weekly ⌸┐            │
│    │ ─────────────────── │                 │Demo     │       │+ 2 more    │            │
│    │ RECURRING SERIES ▸ 4│  …                                                          │
└────┴─────────────────────┴──────────────────────────────────────────────────────────┘
```

- Conseguenza: un solo componente «blocco evento» con tre densità (griglia
  oraria, riga del mese, riga di elenco nel popover dei sovrapposti e nella
  Home) e gli stessi segni di stato in tutte; il pannello di dettaglio è lo
  stesso pannello di `?task=` / `?file=` (docked ≥1200px, sovrapposto
  sotto, larghezza della persona 320–640px).

## 4. Ambito e confini

- **Dentro**: tre viste con le funzioni pure di
  `@stubwise/shared/calendar-grid` (`rangeForView`, `stepAnchor`,
  `weekDays`, `monthGridDays`, `timedEventsForDay`, `allDayEventsForDay`,
  `eventsForDay`, `eventDayKey`); navigazione ferma ai bordi della
  finestra; mini-mese; filtro per casella; stato di allineamento per
  casella; dettaglio evento; risposta Sì/Forse/No con nota; nuova riunione
  e modifica con disponibilità e Meet; eliminazione; trascinamento e
  ridimensionamento per l'organizzatore, con equivalente da tastiera;
  dialogo «Solo questo / Tutta la serie»; serie ricorrenti e la loro
  configurazione; progetto dell'evento e correzione manuale; «Open in
  Google Calendar» (avviso del prototipo, come «Apri in Google Drive»).
- **Fuori**: calendari di colleghi da sfogliare (si vede solo il proprio
  libero/occupato nell'editor), calendari condivisi o di risorse (sale),
  fusi orari multipli a schermo, vista agenda/anno, inviti ricevuti come
  email (stanno in Posta), proposte di calendario come card (`mail.md`).
- **Anti-obiettivi**: blocchi evento a tinta piena per account o per
  progetto (un muro di colori che litiga con i reparti); un calendario che
  sembra vuoto oltre la finestra; maniglie di trascinamento su eventi che
  non si possono spostare; titoli di eventi altrui nella disponibilità; il
  vuoto che rimanda alle «regole della posta» (tolte nell'area 6).

## 5. Stati e intervalli

- **Eventi per giorno**: 0–12 con orario, 0–3 «tutto il giorno»; tipico
  4–7. Giornata con **12 eventi sovrapposti** (seme, settimana prossima):
  nella griglia oraria al massimo **3 corsie** affiancate in Week e **5**
  in Day; oltre, l'ultima corsia diventa una voce «+N more» che apre un
  popover con l'elenco della fascia (righe: ora tnum, codice progetto,
  titolo, stato di risposta). In Month ogni cella mostra 3 righe e «+N
  more» che apre lo stesso popover del giorno **[A 2]**.
  **Aggiornamento [A 2] del 26 ott 2026** (approvato dal maintainer dopo la
  revisione visiva, cambia solo le colonne strette): le corsie seguono la
  **larghezza della colonna**, non solo la vista —
  `maxLanes = clamp(floor((larghezzaColonna − 4) / 64), 1, MAX_LANES[view])`,
  misurata con un ResizeObserver (una colonna di Week a 1024 px, o con il
  pannello aperto, scende sotto i 100 px). «+N» è un gettone compatto alto
  20 px (largo almeno 28 px) **in alto nella fascia**, nell'ultima corsia;
  se resta una corsia sola si sovrappone in alto a destra del blocco
  rimasto. Bordo pieno `border-rule-strong`, non tratteggiato. Un blocco più
  stretto di 140 px è **compatto**: su una riga il solo titolo (la parola
  di stato al posto dell'ora), su due il titolo in testa; l'ora resta nel
  tooltip, nel nome accessibile e nella posizione. La parola di stato
  (risposta, «continues», «Saving…») non si tronca mai: sulla riga dell'ora
  il codice le lascia il posto.
- **Durate**: un evento di 15′ o meno ha l'altezza minima garantita dalla
  griglia e mostra solo ora + titolo su una riga; da 45′ titolo su due
  righe e codice progetto; da 60′ anche luogo o «Google Meet».
- **Evento a cavallo della mezzanotte** (seme): compare in **entrambi** i
  giorni, troncato ai bordi di ciascuno (`timedEventsForDay`). Il pezzo che
  continua ha il bordo basso dritto e la parola «continues» in 12px; il
  pezzo del giorno dopo ha il bordo alto dritto e «from Thu 22:30». Il nome
  accessibile dice l'orario intero («Release AUD 2.1, Thu 22:30 – Fri
  01:00»). Trascinare o ridimensionare uno dei due pezzi agisce sull'evento
  intero.
- **Tutto il giorno**: fascia ALL DAY sopra la griglia (Day/Week), una riga
  per evento; un evento di più giorni è una barra continua fra le colonne.
  Data letta con i getter UTC (`eventDayKey`): in un fuso negativo resta
  nel giorno giusto. In Month in testa alla cella.
- **Fusi**: un evento con orario nel fuso locale di chi guarda; l'angolo
  della griglia mostra il fuso («GMT+1», 12px muted). Nessun selettore di
  fuso.
- **Bordi della finestra** (oggi nel prototipo: venerdì 23 ottobre 2026 →
  finestra 23 settembre – 22 dicembre): ‹ è disabilitato quando
  l'intervallo precedente cadrebbe **tutto** prima dell'inizio, › quando
  il successivo cadrebbe tutto dopo la fine. Il bottone disabilitato ha
  tooltip e nome accessibile «Stubwise reads your calendar from Sep 23 to
  Dec 22». Una vista che **tocca** il bordo (es. il mese di settembre)
  mostra i giorni fuori finestra con un tratteggio a righe sottili
  `rule` e, una volta per vista sopra la griglia, la riga 12px «Days before
  Sep 23 aren't read from Google · Open Google Calendar» **[A 3]**. Il
  mini-mese spegne gli stessi giorni (`ink-faint`, non cliccabili) e le
  sue frecce si fermano agli stessi mesi. `?date=` fuori finestra
  nell'URL: si riporta al giorno di bordo più vicino.
- **Risposta di chi guarda**, sul blocco evento (testo sempre presente
  quando lo spazio lo consente, sempre nel nome accessibile e nel tooltip):
  - accettato / organizzatore: tinta d'inchiostro 10%, bordo sinistro
    assente, titolo 600;
  - **in attesa** (`needsAction`): solo contorno `rule-strong`, nessuna
    tinta, «Not answered» in 12px;
  - **forse**: contorno `rule-strong` + tinta 4%, «Maybe»;
  - **rifiutato**: nessuna tinta, titolo barrato `ink-faint`, «Declined»;
    resta visibile (come il web) ma non produce proposte;
  - evento **passato**: testo `ink-muted`, stessa forma.
- **Salvataggio** (crea, modifica, sposta, risposta): l'evento appare
  subito nel posto nuovo con «Saving…» 12px e la sua forma normale; a
  conferma sparisce la parola; **fallito**: bordo `critical` 1px + icona +
  «Couldn't save · Retry» sul blocco e, nel dettaglio, una riga con
  l'errore, «Retry» e «Undo change» (torna alla versione di Google). Il
  seme ha un evento che fallisce sempre al primo salvataggio.
- **Allineamento** (per casella, nella colonna e ripetuto in 12px sotto
  la testata quando c'è un problema):
  - aggiornato: «Updated 2 min ago» `ink-faint` + bottone icona «Refresh
    now» (nome accessibile) — durante: «Updating…» con l'icona che gira
    (ferma con riduzione del movimento);
  - **vecchio** (oltre 5 minuti): icona + «Updated 12 min ago · may be
    behind Google» in `warning`, «Refresh now» diventa un bottone con
    testo;
  - **scaduto**: icona + «Connection expired on Oct 20» in `critical` +
    «Reconnect» (apre la scheda account dell'area 5); la griglia resta con
    gli ultimi eventi letti e la testata dice «Showing what was read on Oct
    20»;
  - aggiornamento fallito: «Couldn't update · Try again».
- **Account non collegato**: nessuna griglia. Al centro dell'area di
  lavoro: titolo 20px «Connect your Google account», una frase «Your
  calendar and mail show up here, and Stubwise can prepare you for
  meetings.», **Connect Google account** (apre la scheda dell'area 5).
  Colonna: solo il mini-mese, spento.
- **Vuoti**: settimana senza eventi → la griglia resta (righe e ore) e una
  riga calma al centro «Nothing on your calendar this week»; il vuoto non
  cita più le regole della posta. Nessuna serie → la sezione RECURRING
  SERIES non compare.
- **Caricamento**: scheletro della griglia (ore e colonne vere, 3 blocchi
  grigi per giorno). **Errore**: al posto della griglia «Couldn't load your
  calendar» + «Retry»; la colonna resta.
- **Partecipanti**: 0–40 (seme: un evento con 40). Nomi fino a ~40
  caratteri, indirizzi esterni lunghi con ellissi a metà.
- **Serie**: 0–10 per persona; occorrenze anche tutte fuori finestra.
- Evento non visibile o inesistente da `?event=` → il pannello dice «This
  event isn't available» (stesso testo per i due casi, R-G5).

## 6. Interazione e layout

### Griglia

- **Week** (predefinita): 7 colonne lun–dom (`weekDays`, settimana dal
  lunedì) + gutter delle ore 48px. Altezza di un'ora 48px; all'apertura la
  griglia scorre per mostrare l'ora corrente − 1h (o le 8:00 se oggi non è
  nella vista); si scorre per vedere 0–24. Testate dei giorni sticky: «Mon
  19» tnum; oggi = «Today» in testo + inchiostro pieno sul numero, mai un
  colore. Linea dell'ora corrente: 1px inchiostro con punto 6px e l'ora in
  12px tnum nel gutter, si muove con l'orologio del prototipo.
- **Day**: una colonna larga; i blocchi mostrano anche luogo, numero di
  partecipanti e stato della scheda di preparazione.
- **Month**: 6 righe × 7 (`monthGridDays`), giorni del mese adiacente in
  `ink-faint`; per cella righe 20px «09:30 AUD Standup» (tutto il giorno in
  testa senza ora); clic sul numero del giorno → Day di quel giorno; clic su
  una riga → dettaglio.
- **Blocco evento** (griglia oraria): 6px di raggio, nessuna ombra,
  nessuna striscia di reparto (un evento non è una task). Contenuto: ora
  d'inizio tnum 12px · codice progetto tnum 600 (se c'è e lo vedo) ·
  titolo 13px 600, ellissi; segno ⌸ (glifo lineare) se ha la scheda di
  preparazione, glifo Meet se ha il link. Tooltip completo dopo 250ms.
- **Creazione rapida**: trascinare su uno spazio vuoto disegna un blocco
  fantasma con l'intervallo (passo 15′) e al rilascio apre «New meeting»
  con giorno e ora già scritti; un clic semplice su uno spazio vuoto fa lo
  stesso con 30′ **[A 4]**.
- **1024×680** (area di lavoro 720px): Week ha colonne da ~96px, titoli su
  due righe, codice progetto nascosto sotto 60′; il selettore Day/Week/
  Month resta, «New meeting» diventa solo «New». Il pannello di dettaglio
  sotto 1200px si apre sovrapposto. 1440: colonne ~160px senza pannello,
  ~104px con il pannello affiancato.

### Mini-mese e caselle (colonna)

- Mini-mese: 7×6 celle 28px tnum, ‹ › per mese (fermi ai bordi della
  finestra); oggi = numero su cerchio d'inchiostro pieno; l'intervallo
  della vista corrente = tinta d'inchiostro 10%; un punto 4px sotto i
  giorni con eventi. Clic su un giorno: Week/Day saltano lì, Month va al
  mese.
- CALENDARS: una riga per casella collegata: casella di spunta (filtro,
  ricordato per persona) · email con ellissi · sotto la riga di
  allineamento. Con una sola casella (il caso di tutti nel seme) la spunta
  non c'è: la riga resta per l'allineamento.
- **Più account [A 1]**: solo quando chi guarda ha **due o più** caselle,
  ognuna prende un colore fisso (nell'ordine di collegamento) mostrato
  come quadratino 10px accanto all'email e come filetto sinistro 3px sui
  blocchi evento di quella casella; il nome della casella è sempre nel
  tooltip e nel nome accessibile del blocco, e il dettaglio dice «In
  giulia@…». Con un solo account nessun colore.

### Dettaglio di un evento (`?event=`)

Ordine dall'alto (pannello di dettaglio, scorre da solo):

1. **Avviso di rifiuto** se ho rifiutato: «You declined this event ·
   Change your answer» (porta alla barra di risposta).
2. **Titolo** `headline` 20px, poi in 14px: «Today · 10:00 – 11:00» o
   «All day · Fri, Oct 30» (multi-giorno: «All day · Oct 30 – Nov 1»);
   ricorrenza in 13px muted («Every Monday · until Dec 21»).
3. **Join Google Meet** (bottone secondario largo con glifo Meet; nel
   prototipo apre l'avviso) e sotto il link in 12px con «Copy link»; i
   numeri di telefono di accesso in «More ways to join» richiudibile.
4. **Barra di risposta** (se sono invitato e non organizzatore):
   etichetta «Going?» + gruppo di tre bottoni **Yes · Maybe · No** con
   stato premuto (`aria-pressed`) e «Add a note» che apre un campo di una
   riga («Running 10 min late»). La risposta è ottimistica, porta
   «Saving…», si annuncia. In una serie chiede «This event / All events»
   (lo stesso dialogo di §6, testo «Answer for…»).
5. **Progetto**: «AUD Audin 2.0» (codice tnum 600 + nome) con «Suggested
   by Stubwise» 12px muted oppure «Set manually»; bottone «Change» → menu
   con i progetti di cui sono membro (ricerca se più di 8) e «No project».
   Evento senza progetto: «No project · Choose». Il progetto di un
   evento è condiviso fra chi lo vede; la scelta si applica a tutti **[A
   5]**. Un progetto che non vedo non compare (riga «No project» per me).
6. **Partecipanti**: riassunto «12 guests · 8 yes · 1 maybe · 3 no
   reply» tnum; elenco con avatar 20px, nome (o indirizzo), «Organizer»,
   «You», e la risposta in parole a destra (Yes / Maybe / No / No reply)
   con un glifo per forma (✓, ?, ✕, ○) — mai solo colore. Ordine:
   organizzatore, io, poi sì, forse, nessuna risposta, no. Primi 8, poi
   «Show all 40».
7. **Luogo** (link a mappa solo se è un indirizzo: avviso del prototipo).
8. **Descrizione** in un frame isolato (`iframe sandbox`, come l'originale
   di un'email): script spenti, immagini remote bloccate fino a «Show
   images», link che passano dall'avviso esterno; altezza fino a 240px poi
   «Show more».
9. **Promemoria**: «Google default (10 min before, notification)» oppure
   l'elenco «30 min before · email».
10. **Casella**: «In giulia.ferri@example.com» 12px muted.
11. **Scheda di preparazione** (eventi futuri o in corso con progetto di
    cui sono membro) o **Riassunto e cose da fare** (eventi passati con
    trascrizione) — `meeting-prep.md`.
12. Piede: **Open in Google Calendar** (link con ↗, avviso) e, se sono
    organizzatore, **Edit** (secondario) · **Delete** (in «⋯», con
    conferma; per una serie il dialogo dello scope). Non organizzatore:
    nota 12px «Organized by Marco Bianchi · you can change only your
    answer».

### Nuova riunione e modifica (dialogo 560px)

- Campi in ordine: **Title** · **Date** + **Start** + **Duration** (menu
  15′–3h e «Custom», con fine calcolata in testo «until 11:30») o **All
  day** (spunta: diventano Date e «to» Date) · **Guests** (campo a
  gettoni: persone del team per nome con avatar, indirizzi email liberi;
  stessi suggerimenti della Posta) · **Availability** (sotto Guests) ·
  **Add Google Meet** (spunta, accesa di default quando c'è almeno un
  ospite **[A 6]**; «The link is created when you save») · **Project**
  (menu dei miei progetti, «No project»; precompilato con il progetto in
  cui mi trovo se apro da lì) · **Description** (testo semplice) ·
  **Calendar** (menu delle mie caselle; con una sola, testo «From
  giulia@…») · **Repeat** (Does not repeat · Daily · Weekly on Monday ·
  Every weekday · Monthly · Custom…) · **Reminders** (Default · lista).
- **Disponibilità**: una riga per ogni ospite del team: avatar + nome a
  sinistra (140px), a destra una striscia oraria della giornata scelta
  dalle 8 alle 20 con i tratti **occupati** in inchiostro 30% e la fascia
  scelta contornata in inchiostro; a destra della striscia, in parole,
  «Free» o «Busy at that time». Mai un titolo, nemmeno nel tooltip
  («Busy 10:00 – 11:00»). Ospite senza Google collegato: «Calendar not
  connected»; collegamento scaduto: «Availability unavailable»; indirizzo
  esterno: «Availability unknown». Sopra le righe, «Find a time» propone
  il primo spazio libero per tutti nella giornata e sposta l'ora **[A
  7]**.
- Bottoni: **Save** / **Send invitations** (se ci sono ospiti, il
  primario dice cosa succede) · Cancel. Errori in linea: titolo vuoto
  «Add a title», fine prima dell'inizio, data fuori finestra «Stubwise
  can schedule up to Dec 22 · use Google Calendar for later dates» **[A
  8]**.
- Modifica: stesso dialogo, titolo «Edit meeting»; se l'evento è di una
  serie, «Save» apre il dialogo dello scope. Solo l'organizzatore.

### Trascinamento e ridimensionamento (solo organizzatore)

- Puntatore: un blocco mio ha il cursore di spostamento e una maniglia di
  2px sul bordo basso che appare al passaggio; trascinare sposta con passo
  15′ (fra giorni in Week), il fantasma mostra «10:30 – 11:30» in testa; il
  bordo basso cambia la durata. Esc durante il trascinamento annulla.
- **Tastiera** (stesso modello del riordino in Home): con il fuoco su un
  blocco mio, **Space** lo prende («Moving Standup. Arrows to move, Shift
  arrows to change the end, Space to drop, Escape to cancel»), ↑/↓ = ±15′,
  ←/→ = ±1 giorno, **Shift+↑/↓** = fine ±15′, **Space** lascia, **Esc**
  annulla; ogni passo si annuncia («Thursday 10:30 to 11:30»). Dal menu
  «⋯» del blocco anche «Move to…» (dialogo data/ora).
- Rilascio: se l'evento è di una serie → dialogo dello scope; poi
  salvataggio ottimistico, toast «Moved to Thu 10:30 · Undo» 5s.
- Non organizzatore: nessun cursore di spostamento, nessuna maniglia,
  Space non prende (annuncio «You can't move this event: Marco Bianchi
  organizes it»).
- Eventi tutto il giorno: si trascinano fra giorni nella fascia ALL DAY,
  non si ridimensionano in orario.

### Dialogo «Solo questo / Tutta la serie» (400px)

- Titolo secondo l'azione: «Move recurring event», «Edit recurring
  event», «Delete recurring event», «Answer for…». Due scelte radio:
  **This event** · **All events in the series**, con una riga ciascuna su
  cosa succede («Only Thursday, Oct 29 changes»). Bottoni: conferma (verbo
  dell'azione) · Cancel; Cancel o Esc rimettono il blocco dov'era. Nessuna
  terza scelta «questo e i successivi» (fuori dallo spec).

### Serie ricorrenti (`?series=`)

- Sezione della colonna, chiusa di default con il numero di serie;
  aperta: una riga per serie con titolo, regola in 12px («Every Monday
  09:30») e stato in parole: «Off» (`ink-faint`) oppure «On · AUD ·
  milestone 2 days before»; «Auto» se agisce da sola. Le serie senza
  occorrenze nella finestra ci sono comunque, con «No dates in the synced
  range».
- Clic → pannello di dettaglio della serie: titolo, regola, «N dates
  between Sep 23 and Dec 22 · next Mon, Oct 26», e la **configurazione**:
  - **Proposals for this series** (interruttore, spento di default);
  - **Project** (obbligatorio prima di accendere: con l'interruttore
    toccato senza progetto, errore in linea «Choose a project before
    turning this on», codice `choose_project_first`);
  - **Action**: Create a milestone · Open a request · Just remind me;
  - **Days ahead**: 0–14, passo intero, con la frase risultante («A
    proposal arrives 2 days before each date»);
  - **Act automatically** (interruttore) con nota fissa «Creates it
    without asking you. It never starts Claude's work.»;
  - **Remove configuration** (torna spenta, con conferma).
  Il salvataggio è a ogni modifica, con «Saving…»/«Saved» in testa.
- Dal dettaglio di un'occorrenza, la riga di ricorrenza ha «Series
  settings» che apre questa vista.
- Ricordato in chiaro nel pannello: «Past or declined dates never become
  proposals.»

### Tastiera della pagina [A 9]

T = Today · J / K = successivo / precedente · D / W / M = vista · ⌘N = New
meeting · Enter sul blocco = dettaglio · Esc chiude il pannello e
riporta il fuoco al blocco · ↑/↓ fra i blocchi del giorno, Tab fra i
giorni. Le scorciatoie compaiono nei tooltip dei bottoni.

### Movimento

150–250ms: ingresso del pannello, cambio di vista (dissolvenza 150ms,
nessuno scorrimento laterale), il blocco che si posa al rilascio. Zero con
riduzione del movimento (anche l'icona di aggiornamento).

## 7. Vincoli e decisioni aperte

- Dati solo da `data/queries.ts`; orologio fisso del prototipo (`now()`),
  mai `Date.now()`; tutto Google simulato con ritardo via `gate()`.
- Le funzioni della griglia sono quelle di `@stubwise/shared/calendar-
  grid`: niente ricalcoli paralleli; test con `TZ` negativo per tutto il
  giorno e mezzanotte.
- Permessi: nessun permesso nuovo; serve solo l'account Google collegato.
  Organizzatore → modifica/sposta/elimina; gli altri → solo la risposta
  (`forbidden` dal livello dati anche se la UI sbagliasse).
- Accessibilità: la griglia è una `grid` con testate di riga (ore) e
  colonna (giorni); ogni blocco è un bottone con nome completo (titolo,
  orario intero, progetto, risposta, stato di salvataggio); le risposte e
  gli stati non sono mai solo colore; il fuoco torna al blocco alla
  chiusura di pannello e dialoghi.
- Lingue: «Mon 19» / «lun 19», «Not answered» / «Senza risposta» più lungo
  in italiano → testo che va a capo, mai larghezze fisse; formati di data
  e ora dalla lingua (24h in italiano, 12h in inglese) **[A 10]**.
- `?view`, `?date`, `?event`, `?series` validati come gli altri
  parametri in `data/routes.ts`.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 / viste | Calendar · Day · Week · Month · Today | Calendario · Giorno · Settimana · Mese · Oggi |
| azioni | New meeting · Edit · Delete · Open in Google Calendar · Join Google Meet | Nuova riunione · Modifica · Elimina · Apri in Google Calendar · Partecipa con Google Meet |
| colonna | Calendars · Recurring series | Calendari · Serie ricorrenti |
| allineamento | Updated {{n}} min ago · Updating… · may be behind Google · Refresh now · Connection expired on {{date}} · Reconnect | Aggiornato {{n}} min fa · Aggiornamento… · potrebbe non essere allineato a Google · Aggiorna ora · Collegamento scaduto il {{date}} · Ricollega |
| finestra | Stubwise reads your calendar from {{from}} to {{to}} | Stubwise legge il calendario dal {{from}} al {{to}} |
| risposta | Going? · Yes · Maybe · No · Add a note · Not answered · Declined · No reply | Partecipi? · Sì · Forse · No · Aggiungi una nota · Senza risposta · Rifiutato · Nessuna risposta |
| rifiuto | You declined this event · Change your answer | Hai rifiutato questo evento · Cambia risposta |
| progetto | Suggested by Stubwise · Set manually · No project · Change | Suggerito da Stubwise · Scelto a mano · Nessun progetto · Cambia |
| disponibilità | Free · Busy at that time · Calendar not connected · Availability unknown · Find a time | Libero · Occupato a quell'ora · Calendario non collegato · Disponibilità sconosciuta · Trova un orario |
| salvataggio | Saving… · Couldn't save · Retry · Undo change | Salvataggio… · Non salvato · Riprova · Annulla la modifica |
| scope | This event · All events in the series | Solo questo evento · Tutta la serie |
| serie | Proposals for this series · Act automatically · It never starts Claude's work · Choose a project before turning this on | Proposte per questa serie · Agisci da solo · Non avvia mai il lavoro di Claude · Scegli un progetto prima di accendere |
| mezzanotte | continues · from {{day}} {{time}} | continua · dalle {{time}} di {{day}} |
| non collegato | Connect your Google account | Collega il tuo account Google |
| vuoto | Nothing on your calendar this week | Niente in calendario questa settimana |

## Scelte del brief da confermare

1. **[scelta del brief]** Il colore per account esiste solo quando una
   persona ha **due o più** caselle (filetto 3px sul blocco + quadratino
   nel filtro, sempre col nome della casella in testo/tooltip). Con un
   account solo — il caso di tutti nel seme — il calendario è monocromo.
   È un terzo significato del colore oltre reparto e stato: vale solo
   nel Calendario, dove non ci sono strisce di reparto. La tavolozza è da
   scegliere al momento della costruzione con la verifica dei 30° dai
   reparti; in alternativa si usa l'ink con pattern.
2. **[scelta del brief]** Sovrapposti: 3 corsie in Week, 5 in Day, poi
   «+N more» con popover; in Month 3 righe per cella.
3. **[scelta del brief]** Giorni fuori finestra tratteggiati, con una
   riga che lo dice e il rimando a Google Calendar; ‹ › disabilitati solo
   quando l'intervallo intero è fuori.
4. **[scelta del brief]** Clic su uno spazio vuoto = nuova riunione di
   30′ a quell'ora; trascinare = intervallo scelto.
5. **[scelta del brief]** La correzione del progetto di un evento vale per
   tutti quelli che vedono l'evento (il progetto è dell'evento, non della
   persona), e la può fare chiunque lo veda, purché sia membro del
   progetto scelto.
6. **[scelta del brief]** «Add Google Meet» acceso di default quando c'è
   almeno un ospite.
7. **[scelta del brief]** «Find a time»: propone il primo spazio libero
   per tutti gli ospiti del team nella giornata scelta (fra le 8 e le 20).
8. **[scelta del brief]** Non si crea né si sposta un evento oltre la fine
   della finestra (+60 giorni): lo si fa su Google Calendar.
9. **[scelta del brief]** Scorciatoie: T, J/K, D/W/M, ⌘N; spostamento da
   tastiera con Space/frecce/Shift+frecce come il riordino della Home.
10. **[scelta del brief]** Orario a 24 ore in italiano e a 12 ore in
    inglese, dalla lingua dell'app (non dal sistema).
11. **[scelta del brief]** Dall'esterno (Home, Posta, ⌘K) un evento si
    apre portando il Calendario sul giorno dell'evento in Day con
    `?event=` (non come pannello sopra la pagina di partenza): il giorno
    intorno alla riunione è contesto utile.
12. **[scelta del brief]** Gli eventi rifiutati restano nella griglia,
    barrati (come il web); non c'è un filtro per nasconderli.
