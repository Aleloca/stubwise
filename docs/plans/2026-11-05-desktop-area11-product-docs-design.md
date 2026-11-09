# App desktop Stubwise, area 11: la documentazione di prodotto — design

Ultima area del prototipo desktop (`apps/desktop`, branch
`feat/desktop-app`). Si appoggia all'ossatura
(`docs/plans/2026-10-23-desktop-ossatura-design.md`), all'area 5 Docs e Drive
(`2026-10-25-desktop-area5-docs-drive-design.md`), all'area 6 Mail e Calendar,
all'area 9 (permessi) e all'area 10 (Claude dentro l'app,
`2026-11-02-desktop-area10-claude-integration-design.md`). Le regole di
quelle aree valgono anche qui, salvo dove questo documento dice altro.

Le decisioni sono segnate *(maintainer, 5 nov 2026)* quando le ha prese il
maintainer, *(scelta del costruttore)* quando le ha prese chi ha scritto
questo documento.

## Perché

Oggi un progetto nuovo si definisce col cliente in Google Docs *(maintainer)*.
Il PO/PM scrive cosa deve fare il prodotto, le schermate, le decisioni prese
in riunione e le fasi. Due fatiche:

1. **Un progetto nuovo non ha casa in Stubwise finché non c'è codice.** I Docs
   di oggi nascono dai repository. Prima del primo repository il progetto
   è definito altrove, e quel lavoro non arriva mai a chi poi lo costruisce.
2. **La doc invecchia.** Dopo email, riunioni, decisioni e lavoro fatto,
   nessuno la aggiorna.

La decisione di portare questa doc dentro Stubwise è del 25 ott 2026
(maintainer, durante l'area 6): smettono di usare Google Docs per questo.

## Obiettivi

- **Uno spazio «Prodotto» per progetto**, dentro la sezione Docs, accanto agli
  spazi dei repository. È fatto di pagine e sottopagine in un albero, e le
  pagine le scrive il team *(maintainer)*.
- **Contenuto** *(maintainer)*:
  - cosa deve fare il prodotto (funzionalità, regole, casi d'uso);
  - schermate e design;
  - decisioni prese col cliente;
  - fasi e priorità.
- **Un editor come Google Docs o Notion** *(maintainer)*. Si scrive nella pagina
  già formattata: titoli, elenchi, tabelle, immagini, e «/» per inserire un
  blocco. Il markdown non si vede mai.
- **Scrittura insieme dal vivo** *(maintainer)*: si vedono i cursori degli
  altri e le modifiche arrivano subito.
- **Commenti su una frase** *(maintainer)*: si seleziona una frase e la si
  commenta, con @menzioni e «Risolto».
- **Il design nelle pagine** *(maintainer)*:
  - immagini incollate o trascinate, con una didascalia;
  - file del Drive del progetto (area 5), che si aprono da lì;
  - bozze di schermata disegnate da Claude a partire dal testo della pagina.
- **Claude scrive la prima versione** *(maintainer)*. Il PO indica le fonti
  (email, riunioni, note incollate) e Claude crea l'albero delle pagine con
  una prima stesura. Le parti che non sono chiare diventano domande. Si può
  anche partire da una pagina vuota.
- **Claude tiene la doc aggiornata da solo** *(maintainer)*, partendo da
  quattro fonti:
  - le email col cliente attribuite al progetto (area 6);
  - le riunioni del calendario del progetto;
  - le decisioni del registro;
  - il lavoro fatto, cioè task chiuse e rilasci.
- **Dalla doc al lavoro** *(maintainer)*. Da una pagina, o da una fase, Claude
  propone le voci di backlog collegate a quella pagina, e il PO le conferma.
  Ogni task mostra poi la pagina da cui viene.
- **Esportazione in PDF e Word** di una pagina o dello spazio intero
  *(maintainer: non l'ha messa fra le esclusioni)*.

## Non obiettivi *(maintainer)*

- **Condividere col cliente.** Il cliente non vede la doc: non ci sono link
  esterni né accessi per il cliente.
- **Importare i Google Docs di oggi.** Non c'è un import automatico.
- **Fasi collegate al Planning.** Le fasi della doc restano testo e non
  diventano milestone.

## Anti-obiettivi

- **Decisioni inventate** *(maintainer: è il rischio che lo preoccupa di più)*.
  Claude non scrive mai come «deciso» ciò che nella fonte era un'idea, una
  proposta o una domanda. Una modifica entra da sola solo se la fonte la dice
  chiaramente. Altrimenti diventa una domanda (vedi «La regola di Claude»).
- **Modifiche che nessuno nota.** Ogni modifica di Claude resta riconoscibile
  e annullabile (vedi «Il segno»).
- **Confondere la doc con il registro decisioni.** La doc di prodotto è
  *narrativa*: è scritta anche da Claude e può essere sbagliata. Il registro
  decisioni resta *fatto*, mai scritto dall'AI (invariante del CLAUDE.md). La
  sezione «Decisioni» di una pagina può citare righe del registro con un
  link, ma non è il registro. Claude non scrive mai nel registro partendo
  dalla doc *(scelta del costruttore)*.
- **Rivelare l'invisibile (R-G5).** Una pagina, una fonte citata, un nome o un
  codice che chi guarda non può vedere non compaiono in nessuna superficie:
  segno, cronologia, notifiche, ricerca, risposte di Claude.

## Dove vive *(maintainer)*

- **Sezione Docs del progetto.** Oggi la pagina iniziale dei Docs elenca gli
  spazi dei repository. Lo spazio «Prodotto» si aggiunge **per primo**,
  separato dagli spazi «Codice», cioè quelli dei repository *(scelta del
  costruttore)*. Esiste anche in un progetto senza repository.
- **Ricerca, ⌘K e chat del progetto** trovano le pagine di prodotto come le
  altre pagine dei Docs, e le citano con lo stesso componente di
  citazione *(scelta del costruttore)*.
- **Modulo Docs spento.** Se il progetto non ha acceso il modulo Docs, lo
  spazio Prodotto non c'è. Accenderlo è il gesto per iniziare *(scelta del
  costruttore)*.

## Permessi *(maintainer)*

- **Leggere:** chi vede il progetto.
- **Scrivere, commentare, annullare una modifica di Claude, confermare le
  voci di backlog proposte:** chi ha `docs.edit` nel progetto. Confermare
  una voce chiede in più il permesso del backlog che serve oggi (area 2). Non
  c'è un permesso nuovo.
- **Commentare senza `docs.edit`:** *(scelta del costruttore)* no. Chi legge
  soltanto può fare domande in Chat.
- Valgono le lezioni delle aree precedenti: il bottone spento ha la sua frase
  e il «Who?», e la pagina non ricalcola i permessi.

## Struttura di una pagina *(scelta del costruttore, dentro le scelte del maintainer)*

- Albero libero: pagine e sottopagine, trascinabili e rinominabili.
- La prima stesura di Claude propone un albero tipico: Panoramica,
  Funzionalità (una sottopagina per funzionalità), Schermate, Decisioni con
  il cliente, Fasi. È solo un punto di partenza, non un modello obbligatorio.
- Ogni pagina ha un titolo, il corpo, chi la segue e la cronologia.
- I blocchi dell'editor sono:
  - titoli, paragrafi, elenchi puntati e numerati, liste di controllo;
  - tabelle, citazioni, separatori;
  - immagini con didascalia;
  - file del Drive;
  - bozza di schermata di Claude;
  - link a task, voce di backlog, decisione del registro o altra pagina, con
    i codici apribili (`CodeLink`).

## La regola di Claude *(maintainer)*

Claude legge le quattro fonti e per ogni fatto nuovo decide una di tre cose.

1. **Modifica diretta.** La fonte lo dice chiaramente e non contraddice
   niente di già scritto, per esempio «Confermiamo: login solo con Google».
   Claude cambia solo le frasi toccate *(scelta del costruttore: mai
   riscrivere una sezione intera)*. Poi segna la modifica e avvisa chi segue
   la pagina.
2. **Domanda.** La fonte è vaga («potremmo…», «il cliente vorrebbe forse…»)
   oppure contraddice una frase già scritta o una decisione. In questo caso
   Claude non tocca il testo: apre un commento-domanda sulla frase in dubbio,
   con la fonte e due o tre risposte possibili («Aggiorna così», «Lascia
   com'è», «Apri una richiesta»).
3. **Niente.** La fonte non riguarda la doc.

**Il lavoro fatto è sempre una domanda quando diverge** *(maintainer)*. Se una
task chiusa è stata costruita in modo diverso da come dice la pagina, Claude
non sceglie da solo e chiede: «La pagina dice X, è stato fatto Y: aggiorno la
pagina o apro una richiesta?». Se invece il lavoro fatto coincide con la
pagina, Claude non cambia il testo. Al massimo aggiunge il link alla task
nella pagina *(scelta del costruttore)*.

**Le decisioni del registro** sono fatti. Se una decisione riguarda una
pagina, Claude aggiorna la frase e cita la riga del registro come fonte.
Se la decisione contraddice qualcosa scritto a mano da una persona, la
regola 2 vale lo stesso *(scelta del costruttore)*.

**Mentre qualcuno scrive** *(maintainer: scrittura dal vivo)*. Claude non
modifica una sezione in cui qualcuno sta scrivendo in quel momento: aspetta
che la persona esca dalla sezione. Le domande invece può aprirle subito.

**Quando succede** *(scelta del costruttore)*. Claude rilegge le fonti appena
arrivano: un'email attribuita, una riunione finita, una decisione
registrata, una task chiusa o un rilascio. Nel prototipo questi passaggi sono
copioni dei dati finti, come nelle aree 6 e 10. Non c'è una chiamata vera al
modello.

## Il segno e la cronologia *(maintainer)*

- **Il segno.** Le frasi cambiate da Claude hanno un segno a lato. Il segno dice
  la fonte (l'email, la riunione, la decisione o la task, apribile) e offre
  «Annulla». Resta finché qualcuno con `docs.edit` non la legge e la accetta
  («Va bene») o la modifica a mano *(scelta del costruttore sul gesto che lo
  toglie: leggere da solo non basta, perché il rischio da evitare è proprio
  il cambio che nessuno nota)*.
- **Riuso dell'area 10.** Il segno riusa `ClaudeDraftMark`, cioè lo stesso
  segno «Bozza di Claude» dell'area 10, con la stessa forma delle fonti
  *(scelta del costruttore)*. A differenza delle bozze dell'area 10, qui la
  modifica è già salvata: il segno dice «Aggiornato da Claude», non «Bozza».
- **La cronologia della pagina** elenca ogni modifica: chi, quando, da quale
  fonte, e le righe prima e dopo. Le modifiche di Claude hanno «Annulla»
  finché la frase non è stata toccata da altri. Dopo, «Annulla» si spegne,
  con la frase e il «Who?» come nell'area 10 («Marco Bellini l'ha modificata
  dopo»).
- **«Annulla»** torna esattamente alla frase di prima e lascia una riga nella
  cronologia «Annullato da …».

## Avvisi *(maintainer)*

- **Chi riceve.** Domande e avvisi «Claude ha aggiornato la pagina» vanno a
  chi segue la pagina. Chi crea una pagina la segue in automatico. Chiunque
  la veda può seguirla o smettere *(scelta del costruttore: seguire non
  richiede `docs.edit`, ma rispondere a una domanda sì)*.
- **Se nessuno la segue**, gli avvisi vanno a chi ha `docs.edit` nel
  progetto.
- **Due tipi di notifica nuovi** *(scelta del costruttore)*:
  - `product_doc.updated`, che raccoglie in una sola card le modifiche dalla
    stessa fonte;
  - `product_doc.question`, con le risposte nella card come le domande
    dell'area 3.
  Per il prodotto vero ognuno è un `notification_kind` nuovo, con la regola
  di rollback del CLAUDE.md e i cambi additivi verso l'app mobile (vedi
  «Parità con il web»).

## Prima versione da Claude *(maintainer)*

- In uno spazio Prodotto vuoto ci sono due strade: «Scrivi la prima versione
  con Claude» e «Inizia da una pagina vuota».
- **Fonti.** Il PO sceglie le fonti: email del progetto, riunioni del
  progetto, testo incollato e file del Drive *(scelta del costruttore: il
  Drive c'è già nel progetto)*.
- **La stesura.** Claude crea l'albero e scrive la prima stesura, con le
  regole di sempre: si scrive solo ciò che le fonti dicono chiaramente, e
  ogni dubbio diventa una domanda sulla frase.
- **Il segno.** Nella prima stesura le frasi non hanno il segno una per una
  *(scelta del costruttore: sarebbe tutto segnato)*. In cima a ogni pagina
  compare una riga «Prima versione scritta da Claude dalle fonti: …», che
  sparisce quando il PO la accetta.
- **Le domande** compaiono nel riquadro di Claude (area 10) come elenco «N
  domande da chiudere».

## Bozze di schermata di Claude *(maintainer)*

- Da una pagina (blocco «/schermata» o «Disegna questa schermata») Claude
  propone una bozza in bianco e nero a fil di ferro *(scelta del costruttore:
  serve a far vedere la struttura, non lo stile)*. La bozza nasce dal testo
  della pagina.
- È un blocco della pagina, segnato «Bozza di Claude». Si tiene, si rifà o si
  elimina. La si può sostituire con un'immagine vera.
- Nel prototipo le bozze sono immagini o SVG preparati nei dati finti
  *(scelta del costruttore)*.

## Dalla doc al backlog *(maintainer)*

- Su una pagina, o su una fase, c'è il gesto «Proponi le voci di backlog».
  Claude propone le voci: titolo, descrizione con la frase della pagina,
  urgenza ed effort se la pagina li dice. Le propone con la scheda in blocco
  dell'area 10, che il PO conferma tutta o in parte.
- **Il collegamento.** Ogni voce confermata ricorda la pagina da cui viene. La
  voce, il ticket che ne nasce e la task mostrano «Dalla doc: <pagina>», e
  la pagina mostra le voci collegate *(scelta del costruttore: il legame è
  sulla pagina, non sulla singola frase)*.
- Una voce già proposta da quella pagina non viene riproposta *(scelta del
  costruttore)*.

## Commenti *(maintainer)*

- Si seleziona una frase e si commenta, con @menzioni, risposte in fila e
  «Risolto».
- Le domande di Claude sono commenti con le risposte a scelta, e scompaiono
  da sole quando qualcuno risponde. Una risposta che aggiorna la pagina passa
  dalle regole del segno.
- Se una frase commentata viene cancellata, il commento resta nella colonna
  dei commenti con «Frase eliminata» *(scelta del costruttore)*.

## Scrittura dal vivo *(maintainer)*

- Si vedono i cursori e le selezioni degli altri, con nome e colore, e le
  modifiche arrivano subito.
- In cima alla pagina ci sono gli avatar di chi c'è.
- Nel prototipo non c'è rete: la presenza di un'altra persona è un copione
  dei dati finti, una persona che scrive in una sezione per qualche secondo.
  Basta per far vedere i cursori e Claude che aspetta *(scelta del
  costruttore)*.

## Esportazione *(maintainer)*

- PDF e Word, di una pagina o dello spazio intero. Le immagini e le bozze sono
  incluse; segni, commenti e domande no *(scelta del costruttore)*.
- Nel prototipo l'esportazione produce un file vero, scaricato con la finestra
  di salvataggio di Electron *(scelta del costruttore; se il costo è alto, il
  piano può ridurla a PDF soltanto e dirlo)*.

## Claude nel riquadro (area 10)

- Il catalogo dell'area 10 cresce di poche voci *(scelta del costruttore)*:
  - «scrivi la prima versione»;
  - «aggiorna la pagina da questa email o riunione», un gesto a mano oltre
    all'automatico;
  - «proponi le voci di backlog da questa pagina»;
  - «disegna questa schermata»;
  - «cosa è cambiato nella doc questa settimana».
- Le classi della conferma sono quelle dell'area 10. Scrivere in una pagina da
  sé, segnato e annullabile, è la regola di quest'area per gli aggiornamenti
  da fonte. Lo stesso gesto chiesto nel riquadro è classe A, con «Undo».
- La doc di prodotto entra nelle risposte di S0 («cosa sai fare») e nelle
  fonti delle risposte del progetto.

## Stati

- Spazio vuoto con le due strade, oppure modulo Docs spento.
- Claude sta scrivendo la prima versione, con l'avanzamento per pagina.
- Pagina senza permesso di scrittura: in sola lettura, col perché e il
  «Who?».
- Fonte che non si può più aprire, per esempio un'email potata: il segno dice
  «Fonte non più disponibile» e «Annulla» resta.
- Budget mensile di Claude esaurito: niente aggiornamenti automatici. Le
  fonti aspettano e in cima allo spazio compare una riga «Claude riprenderà
  ad aggiornare la doc quando torna il budget» *(scelta del costruttore)*.

## Dati finti *(scelta del costruttore)*

- Un progetto nuovo senza repository e con lo spazio Prodotto scritto da
  Claude. Ha una decina di pagine, alcune domande aperte, una bozza di
  schermata, due immagini e un file del Drive.
- Un progetto esistente (ACQ) con lo spazio Prodotto maturo, con:
  - una modifica recente di Claude da un'email, segnata;
  - una domanda nata da una riunione;
  - una divergenza da una task chiusa;
  - voci di backlog collegate.
- Un'istanza vuota, senza nessuno spazio Prodotto.

## Parità con il web

Il web oggi non ha la doc di prodotto. Il prototipo è la specifica. Per il
prodotto vero servono:

- tabelle nuove per spazi, pagine, revisioni, segni e commenti;
- i due `notification_kind` nuovi, con il rollback;
- il lavoro del worker che rilegge le fonti, sotto le regole del giro
  notturno e della quota dove si applica;
- la scrittura dal vivo, cioè un canale in tempo reale che il server oggi non
  ha.

Questi punti vanno in `apps/desktop/docs/area10-parity.md`, o in un file
gemello per l'area 11.

## Decisioni dopo la lettura del costruttore (5 nov 2026)

Prevalgono sulle sezioni sopra quando le precisano.

1. **Email e riunioni private nella doc** *(maintainer)*. Le email e le
   riunioni attribuite al progetto aggiornano la doc da sole, **senza il
   consenso di chi le ha ricevute**. Il segno nomina la fonte a tutti
   quelli che leggono la pagina. È un'apertura voluta: il contenuto di
   un'email privata finisce in un testo che tutto il progetto legge.
   L'invariante `mailbox_owner` resta valida per l'email stessa: chi non è
   destinatario non può aprirla. Quindi per lui il segno mostra «da
   un'email di <titolare> · <data>», senza link, e il testo dell'email non
   compare mai, nemmeno l'oggetto. R-G5 vale per il resto: nomi e codici
   invisibili non compaiono. Il piano scrive questa apertura fra le
   invarianti da riscrivere prima del motore, accanto a `mailbox_owner`.
2. **Chi agisce** *(maintainer)*.
   - Un aggiornamento da email o riunione è «Claude per conto di
     <titolare della fonte>», con i permessi di quella persona: `actorId` è
     la persona e `via` è `"claude"`, come nell'area 10. Il titolare è chi ha
     ricevuto l'email, o chi l'ha attribuita al progetto, o l'organizzatore
     della riunione.
   - Se il titolare non ha `docs.edit` nel progetto, la modifica diventa una
     domanda.
   - Da task chiuse, rilasci e decisioni agisce il Claude collega dell'area
     10. Per questo i suoi permessi di lavoro fissi includono scrivere la doc
     di prodotto *(scelta del costruttore, conseguenza della decisione)*.
3. **Classe nel riquadro** *(scelta del costruttore)*. Un aggiornamento
   chiesto nel riquadro avvisa chi segue la pagina, quindi è **classe B**
   (scheda da confermare), secondo la regola dell'area 10. «Nessuna B
   diventa A» resta vera. L'aggiornamento automatico da fonte non passa dal
   riquadro e segue la regola di quest'area.
4. **Frase, sezione, modifica** *(scelta del costruttore)*.
   - La «frase» è un **blocco**: un paragrafo, una voce di elenco o una
     cella di tabella. Il segno, il commento, «Annulla» e «toccata da altri»
     si ancorano al blocco.
   - La «sezione» è tutto ciò che sta sotto un titolo, fino al titolo dello
     stesso livello. Claude aspetta solo se qualcuno sta scrivendo dentro
     quella sezione.
   - Una modifica di Claude da una fonte può toccare più blocchi. Ogni blocco
     ha il suo segno, e la cronologia li raccoglie in una riga sola con
     «Annulla tutto».
   - Il corpo di una pagina diventa un **documento a blocchi con id
     stabili**, non più markdown. Le pagine manuali dei repository restano
     come sono.
5. **Il segno** *(scelta del costruttore)*. È un componente nuovo di margine,
   con le sue regole. Riusa l'aspetto e la riga delle fonti («Used: …» con
   `CodeLink`) di `ClaudeDraftMark`. `ClaudeDraftMark` e i suoi test non
   cambiano. Il segno sta nei dati ed è visto da tutti.
6. **Le risposte a una domanda di Claude** *(scelta del costruttore)*.
   - «Aggiorna così» è una modifica **della persona che risponde**. Nella
     cronologia compare come «Laura, dalla domanda di Claude» e non ha un
     segno, perché l'ha scelta una persona.
   - «Apri una richiesta» apre la scheda dell'area 10 (classe B), con il
     controllo del permesso del backlog dell'area 2.
   - «Lascia com'è» chiude la domanda.
7. **Leggere** *(scelta del costruttore)*. Lo spazio Prodotto si legge con
   `docs.view`, come i Docs di oggi. «Chi vede il progetto» del maintainer
   corrisponde ai preset di oggi, che hanno `docs.view` per tutti i membri.
   Il modulo Docs ora vuol dire «Docs di prodotto e di codice», e in un
   progetto senza repository si accende lo stesso.
8. **Esportazione** *(scelta del costruttore)*. PDF con `printToPDF` di
   Electron. Word con una dipendenza nuova, dichiarata nel piano. Servono
   **un solo** messaggio IPC nuovo nel processo principale, «salva questo
   file», con la finestra di salvataggio, e i suoi test in `security.ts`. Se
   la dipendenza per Word non passa la revisione, il piano riduce a PDF
   soltanto e lo dice.
9. **«Annulla» della prima versione e dopo «Va bene»** *(scelta del
   costruttore)*.
   - La prima versione si annulla **tutta insieme**, finché nessuno ha
     toccato una sua pagina. Dopo, «Annulla» si spegne con la frase e il
     «Who?».
   - «Va bene» toglie il segno ma non chiude «Annulla» nella cronologia.
     «Annulla» resta finché il blocco non è toccato da altri.
10. **Budget** *(scelta del costruttore)*. È lo stesso budget mensile
    d'istanza dell'area 9b. Le fonti in attesa si mettono in coda. Quando il
    budget torna, si elaborano in ordine di arrivo, e gli avvisi si
    raggruppano per pagina in una card sola.

## Lasciato al costruttore

- La forma esatta dell'editor nel prototipo, cioè quale libreria usare. La
  libreria deve stare nelle regole del repo: nessuna dipendenza nuova senza
  dirlo nel piano.
- L'ordine e il nome dei gesti nella barra della pagina.
- Il layout a 1024 (lo decidono gli shape di Impeccable).
- Quanti copioni di fonti preparare nei dati finti, purché coprano le tre
  uscite della regola.
