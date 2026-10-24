# App desktop Stubwise, area 3: Claude come collega — design

Data: 24 ott 2026. Terzo documento della serie (ossatura:
`docs/plans/2026-10-23-desktop-ossatura-design.md`; area 2:
`docs/plans/2026-10-23-desktop-area2-task-design.md`). Si costruisce nel
prototipo `apps/desktop` con dati finti, con le stesse regole: ogni pagina
definita fino in fondo, stati veri, permessi verificati col «vedi come».
Linguaggio visivo: `apps/desktop/DESIGN.md` («Catalogo numerato»); UI e UX
definite con Impeccable (shape → costruzione → revisione), come nell'area 2.

Le decisioni marcate *(maintainer)* vengono dalla conversazione con il
maintainer; quelle marcate *(scelta del costruttore)* sono proposte
confermabili.

## Perché

Usare Claude in Stubwise oggi **funziona**, ma l'esperienza è brutta: la
sessione dal vivo sembra un registro tecnico, le domande e i piani sono
pannelli a parte *(maintainer)*. L'area 3 rifà come si vede e come si usa il
lavoro con Claude, e ne allarga il perimetro: oltre alle sessioni legate a
un lavoro, una **conversazione libera** con Claude che conosce tutto
Stubwise e può fare ciò che l'utente può fare.

## Riferimento d'interazione *(maintainer)*

L'app ufficiale di Claude è il riferimento per **come si interagisce**:

- la conversazione come flusso di messaggi puliti, con le risposte che
  **arrivano in diretta** (testo che si scrive, azioni che compaiono mentre
  avvengono);
- le **domande** come scheda di scelta nella conversazione (opzioni +
  «Altro…»), non come pannello separato;
- **allegare** con facilità (trascina, incolla immagini);
- **comandi con «/» e autocompletamento**, comprese le skill dei plugin.

*(scelta del costruttore)* Si riprende il modo d'interazione, non l'identità:
l'aspetto resta il «Catalogo numerato» (Archivo, filetti, codici, nessun
marchio o stile grafico di Anthropic).

## Cosa copre

1. **Conversazione con Claude** — un solo componente, usato ovunque.
2. **Conversazione libera** dalla destinazione «Claude» del binario.
3. **Sessioni di lavoro** legate a un oggetto: task (pianifica, esegue,
   corregge), refine di una richiesta, e le sessioni automatiche di oggi
   (review, Docs, brief, report, classificazione posta…) in sola lettura.
4. **Azioni proposte da Claude** e loro conferma.
5. **Domande e approvazione del piano** dentro la conversazione.
6. **Elenco delle conversazioni e sessioni** (destinazione «Claude»).
7. **Visibilità e conversazioni pubbliche.**
8. **Rassegna del giorno per persona** (oggi «Activity» per sviluppatore).
9. Ciò che l'area 2 ha lasciato all'area 3: le sezioni AI della task (piano,
   approvazione, stato del lavoro, storia del lavoro, PR, correzioni) e la
   conversazione di refine delle richieste; le voci Claude nel blocco «Da
   decidere» della Home.

## Obiettivi

- Seguire Claude mentre lavora è piacevole e chiaro come nell'app di Claude.
- Chiunque, anche non tecnico, chiede a Claude «a che punto siamo», «cosa
  devo fare oggi», «spiegami AUD-12», «come funziona X nel progetto Y», e fa
  avviare lavoro, **senza uscire dalla conversazione** *(maintainer)*.
- Domande e piani si risolvono dove compaiono, in un clic.
- Chi coordina rivede cosa ha fatto ogni persona in un giorno, in ogni
  reparto *(maintainer)*.
- Parità con il web per Agents, sessione dal vivo, domande, approvazione del
  piano, refinement, Activity.

## Non obiettivi

- Cambiare cosa fa la pipeline (triage, piano, esecuzione, PR, correzioni):
  il **funzionamento** resta quello di oggi *(maintainer: «funzionale»)*; si
  rifà la presentazione.
- Decidere cosa fa Claude sulle task non tecniche di ogni reparto (resta
  aperto dall'ossatura): la conversazione è generica, i flussi per reparto
  si definiscono caso per caso.
- Deploy: Stubwise non fa deploy, il merge resta l'unica azione verso la
  produzione.
- Scegliere modelli o provider dalla conversazione (amministrazione, area 9).

## Anti-obiettivi

- Un registro di log travestito da chat: righe tecniche in primo piano,
  testo di Claude in secondo.
- Claude che fa qualcosa che l'utente non potrebbe fare a mano.
- Una modifica ai dati di Stubwise fatta da Claude per conto dell'utente
  senza che l'utente l'abbia vista e confermata.
- Due posti per rispondere alla stessa domanda che danno esiti diversi.
- Testo generato presentato come fatto (registro decisioni: mai AI).

## Regole di fondo

### Claude agisce come l'utente *(maintainer)*

Ogni comando di Stubwise che Claude esegue nella conversazione gira **con
l'identità e i permessi dell'utente** che conversa: può fare solo ciò che
quell'utente può fare in quel progetto. Il controllo è **deterministico e
lato server** (gli stessi `config.access`/`need` delle rotte e del livello
dati), mai un'istruzione nel prompt: non è aggirabile da ciò che si scrive a
Claude. Nel prototipo: le azioni di Claude passano dalle stesse funzioni del
livello dati finto con la sessione della persona, e falliscono con
`forbidden` esattamente come a mano.

### Le modifiche sono proposte da confermare *(maintainer)*

Leggere non chiede nulla. Ogni azione che **cambia** qualcosa (creare,
modificare, assegnare, pianificare, commentare, avviare un'esecuzione,
archiviare…) Claude la **propone** come scheda nella conversazione: cosa
farà, su cosa, con quali valori (es. «Creo in AUD: “Titolo” · Marco ·
settimana 44 · M»), con **Conferma**, **Modifica** (apre il dialogo della
stessa azione precompilato) e **Annulla**. Solo la conferma la esegue; il
risultato compare nella conversazione con il codice dell'oggetto, apribile.
Più azioni insieme diventano una scheda con l'elenco e «Conferma tutto» /
conferma per riga. *(scelta del costruttore)* Una proposta non confermata
scade quando la conversazione va avanti di 20 messaggi o dopo 24 ore e resta
leggibile come «Non eseguita».

*(scelta del costruttore)* La conferma vale per le **azioni sui dati di
Stubwise** che Claude fa per conto dell'utente in una conversazione (libera
o di sessione). I **prodotti del lavoro** della pipeline seguono le regole
di oggi, invariate: in una sessione di task Claude modifica il codice nel
worktree e il piano passa dal gate di approvazione; nel refine Claude
scrive design, piano e metadati della richiesta con gli strumenti di oggi
(`set_design`, `set_plan`, …). Queste scritture compaiono nel flusso come
righe di azione già eseguite («Ha aggiornato il design di STW-R4 · vedi»),
non come proposte.

### Restano invariate le regole di oggi

- Chi può scrivere, fermare o rispondere in una sessione lo decide il
  server (`docs/invariants/agent-sessions.md`); i client leggono
  `canWrite`/`canInterrupt`/`canAnswer`.
- Un **piano** lo approva solo chi ha `plans.approve` nel progetto; il merge
  solo chi ha `release.merge` (i «due divieti dell'operatore»).
- Il **registro decisioni** non è mai scritto dall'AI.

## 1. La conversazione

Un solo componente per conversazione libera, sessione di task, refine,
sessioni automatiche.

- **Flusso**: messaggi dell'utente a destra o allineati in modo distinto
  *(scelta del costruttore: allineamento a sinistra per entrambi, l'utente
  con il nome e una fascia di fondo leggera, come nel Catalogo; si decide
  allo shape)*; messaggi di Claude come testo markdown leggibile (titoli,
  elenchi, codice, tabelle), che **si scrive mentre arriva**.
- **Azioni di Claude** (legge un file, cerca, esegue un comando, modifica,
  chiama uno strumento di Stubwise): **righe compatte** nel flusso («Legge
  `src/x.ts`», «Cerca nei Docs di AUD “sincronizzazione”», «Esegue i test»),
  raggruppate quando sono consecutive («5 azioni»), che si aprono per vedere
  ingresso e risultato. Lo stato dal vivo è la riga in corso con un segno di
  attività (l'anello tratteggiato di Claude dell'ossatura).
- **Fasi** di una sessione di lavoro (triage, piano, esecuzione, correzione,
  review…) come separatori leggeri nel flusso, con esito (ok, fallito,
  scaduto, fermato da …).
- **Citazioni**: ogni oggetto di Stubwise che Claude usa è citato con il suo
  codice e nome (task, richiesta, pagina Docs, file), apribile; anteprima al
  passaggio del mouse.
- **Casella di scrittura** in fondo:
  - testo con invio; **allegati** trascinando file o incollando immagini;
  - **«@» o «#»** per citare un oggetto di Stubwise (task, richiesta, pagina,
    file, persona, progetto) scegliendolo da un menu che cerca *(scelta del
    costruttore sul carattere: «#» oggetti, «@» persone)*;
  - **«/»** apre l'elenco dei **comandi** con autocompletamento e una riga
    di descrizione: i comandi di Stubwise e le **skill dei plugin abilitati**
    nel progetto della conversazione (le skill spente nel progetto non
    compaiono) *(maintainer)*;
  - in una sessione al lavoro: **Ferma**, **Ferma e scrivi**, invio di un
    messaggio che Claude assorbe nel turno (stato del messaggio: in attesa,
    consegnato, non consegnato con motivo e «Rimanda»), come oggi.
- Nuovi messaggi mentre sei più su: pillola «Nuovi messaggi»; «Carica
  precedenti»; «Riconnessione…».
- Sola lettura quando il server non concede la scrittura, con la frase che
  dice perché (oggi: «Questo passo si può solo guardare», ecc.).

## 2. Conversazione libera *(maintainer)*

Dalla destinazione **Claude** del binario: «Nuova conversazione».

- Claude conosce Stubwise **come l'utente**: progetti, task, richieste,
  planning, Docs, decisioni, brief, posta e calendario dell'utente (quando
  arrivano le aree 6), e può **fare ciò che l'utente fa a mano** tramite
  proposte da confermare. Esempi del maintainer: a che punto sono i
  progetti e cosa devo fare oggi; spiegami un ticket o una richiesta; come
  funziona qualcosa in un progetto (dalla documentazione, citata); avvia
  l'esecuzione di una richiesta.
- Anche **consultazione libera** su temi esterni ai progetti.
- **Cosa raggiunge** *(scelta del costruttore)*: i dati di Stubwise che
  l'utente può vedere, la documentazione dei progetti, e il **codice dei
  repository** solo dei progetti dove l'utente ha `repos.view`. Una
  conversazione libera non ha un progetto: un **contesto di progetto**
  facoltativo (chip in testa, impostato scegliendolo o citando un oggetto
  con «#») decide quali skill di plugin compaiono in «/»; senza contesto «/»
  mostra solo i comandi di Stubwise.
- Una conversazione libera può **diventare** il punto di partenza di un
  lavoro: se Claude avvia un'esecuzione, la sessione di lavoro che nasce è
  collegata («Lavoro avviato: AUD-14 · apri la sessione»).
- *(scelta del costruttore)* Titolo automatico dalla prima domanda,
  rinominabile; conversazioni archiviabili ed eliminabili dall'autore.

## 3. Sessioni di lavoro

- **Task assegnata a Claude**: la sessione è la conversazione della task,
  aperta dalla sezione «Claude» del dettaglio task (oggi un segnaposto) e
  dall'elenco Claude. Cosa vedi e quando Claude ti interpella dipende dalla
  sessione stessa — da cosa gli hai detto e da cosa sta facendo
  *(maintainer)*. La sezione «Claude» del dettaglio task mostra stato,
  ultimo messaggio, domanda o piano aperto, PR e correzioni, «Apri la
  sessione», «Assegna a Claude», «Avvia» / «Rilancia con indicazioni» /
  «Riprendi la correzione» (come oggi, con gli stessi permessi).
- **Piano**: compare nella conversazione come documento leggibile con il
  riassunto «In breve»; la scheda di approvazione ha **Approva** e
  **Rifiuta con indicazioni** per chi ha `plans.approve`; gli altri vedono
  «Aspetta l'approvazione di chi può approvare in AUD». Approvazione in
  anticipo e revoca come oggi.
- **Domanda** (`ask_user`): scheda di scelta nel flusso, con l'opzione
  consigliata in evidenza, «Altro…» a testo libero; rispondono il
  richiedente e chi ha `plans.approve` (regola di oggi). La stessa domanda
  compare in **Da decidere** nella Home: rispondere in un posto la chiude
  nell'altro.
- **PR, review, correzioni**: righe nel flusso e nella sezione della task
  («PR aperta», «Review: richiede modifiche», «Correzione 2 inviata»), con
  «Chiedi modifiche» come oggi.
- **Refine di una richiesta**: la conversazione di refinement (oggi un
  pannello) è la stessa conversazione, con a lato la richiesta (urgenza,
  taglia, rischio, design, piano) aggiornata dal vivo; «Chiudi la sessione».
  Scrive chi ha `backlog.edit`.
- **Sessioni automatiche** (review PR, Docs, brief, report giornaliero,
  classificazione posta, stima e merge dell'intake): stesse viste, sola
  lettura. *(scelta del costruttore)* Brief e report giornaliero compaiono
  come sessioni concluse (oggi non hanno una vista dal vivo).

## 4. Destinazione «Claude»

Colonna: **Nuova conversazione**, poi **Al lavoro ora** (sessioni vive che
puoi vedere), **Le mie conversazioni**, **Pubbliche**, **Concluse** (ultimi
14 giorni come oggi, poi «Mostra più vecchie»). Filtri: progetto, tipo
(conversazione, task, refine, review, Docs, brief, report, posta), esito.
Ogni riga: tipo, titolo, progetto e codice, stato o esito, tempo, attività
corrente («sta modificando X», «sta facendo una domanda»).

Area di lavoro: la conversazione scelta; a lato, per le sessioni legate a
un oggetto, l'oggetto stesso (task o richiesta) in breve.

## 5. Visibilità *(maintainer)*

- Una **conversazione libera** la vede solo chi l'ha aperta.
- Una **sessione di lavoro** la vedono i membri del progetto secondo la
  regola del server di oggi (vedere una sessione chiede il permesso nel
  progetto — `repos.view`, o `backlog.edit` per il refine).
- Chi ha aperto una conversazione può renderla **pubblica**: da allora la
  vede chiunque abbia il permesso **«vedere le conversazioni pubbliche con
  Claude»** (permesso d'istanza nuovo). Al momento di renderla pubblica
  l'autore vede l'**elenco dei progetti** che Claude ha letto o toccato e
  **conferma** prendendosene la responsabilità *(maintainer)*. Chi non può
  vedere uno di quei progetti legge comunque il testo, ma i codici di quel
  progetto **non si aprono** (stessa risposta di un oggetto inesistente).
  Si può tornare privata; *(scelta del costruttore)* una conversazione
  pubblica mostra in testa «Pubblica · resa pubblica da X il …».
- **Continuare una conversazione pubblica** *(maintainer)*: chi la vede
  può continuarla **come se fosse sua**, e Claude agisce **come quel nuovo
  utente**, potendo fare solo ciò che farebbe lui (proposte confermabili
  solo da chi le ha chieste). *(lettura del costruttore, da confermare)*
  Scrivere in una conversazione pubblica altrui ne crea una **continuazione
  propria e privata** di chi scrive, che parte dalla conversazione pubblica
  (citata in testa: «Continua da …»): l'originale non cambia e le identità
  non si mescolano nello stesso filo. L'autore originale continua la sua;
  se Claude vi tocca un progetto nuovo, i messaggi successivi restano
  privati finché l'autore non riconferma l'elenco dei progetti.
- Le sessioni di lavoro non hanno l'opzione «pubblica»: la loro visibilità
  segue il progetto. Le sessioni di **classificazione della posta** restano
  visibili solo al titolare della casella (`mailbox_owner`, invariante di
  oggi), anche in «Al lavoro ora» e nei filtri.

### Permessi nuovi *(maintainer)*

- **«Vedere le conversazioni pubbliche con Claude»** — di base a **tutti**
  gli utenti (preset User e Admin).
- **«Vedere l'attività delle persone»** — di base ai **responsabili** (full
  admin e Project Lead).
- Come ogni permesso, entrambi si possono assegnare a qualunque ruolo,
  preesistente o creato (gestione dei ruoli: area 9).

## 6. Rassegna del giorno per persona *(maintainer)*

Serve a chi coordina per **rivedere cosa stanno facendo le persone**, in
**tutti i reparti**.

- Da **Tutti i progetti → Attività**, una vista «Per persona» con selettore
  della data (oggi e indietro) e filtro per reparto.
- Per ogni persona: task chiuse, task spostate (stato, settimana), commenti,
  decisioni prese, richieste create; per chi sviluppa anche i **commit** del
  giorno con la descrizione scritta dall'AI (etichettata «Testo generato») e
  lo stato del report (come oggi: «Genera il report», «Collega una persona»
  per gli autori dei commit non collegati).
- Solo per chi ha il permesso **«vedere l'attività delle persone»** (vedi
  «Permessi nuovi»); la rassegna mostra solo i progetti che chi guarda può
  vedere.
- *(scelta del costruttore)* Solo eventi di Stubwise: posta e calendario
  personali non entrano nella rassegna (restano privati del titolare).

## Stati di ogni pagina

Caricamento, vuoto, errore con «Riprova», pieno, versione senza permessi;
in più per la conversazione: in diretta, riconnessione, interrotta, finita
(con esito), sola lettura con motivo, proposta scaduta.

## Come risponde Claude nel prototipo *(scelta del costruttore)*

Il prototipo non usa la rete (vincolo dell'ossatura), quindi non chiama un
modello. Le sessioni seminate riproducono flussi scritti a mano nel tempo;
la conversazione libera usa un **motore di intenti deterministico** sui dati
finti per le richieste tipiche del maintainer (a che punto sono i progetti,
cosa devo fare oggi, spiegami <codice>, come funziona <tema> in <progetto>
dalla Docs, avvia l'esecuzione di <richiesta>, crea/assegna/pianifica) che
risponde in diretta con citazioni e proposte da confermare; una domanda non
riconosciuta riceve una risposta generica e plausibile, senza azioni. L'app
vera sostituisce il motore con il modello vero e gli strumenti MCP di
Stubwise, senza toccare le pagine.

## Dati finti

Conversazioni libere di Giulia e Marco (una pubblica che tocca un progetto
che Sara non vede), sessioni di task in ogni stato (al lavoro, aspetta una
risposta, aspetta l'approvazione, fermata, finita con PR, fallita), un
refine in corso, sessioni automatiche, uno **stream simulato** che fa
arrivare testo e azioni nel tempo (con la latenza del livello finto),
comandi «/» e skill di plugin per progetto, commit del giorno per la
rassegna.

## Parità con il web

Questa area chiude le voci dell'inventario: Agents (elenco, sessione dal
vivo, sessione per job), sezioni AI del dettaglio ticket (piano,
approvazione, storia del lavoro, attività AI, avvio/rilancio/ripresa,
correzioni, PR), domande e piani nell'Inbox (→ Da decidere), refinement del
backlog, Activity per sviluppatore. Il piano porta la tabella di controllo.

## Decisioni aperte

- Cosa fa Claude per ogni tipo di task non tecnica (invariato).
- Quali comandi «/» di Stubwise esistono oltre alle skill (si fissa nel
  piano partendo dalle azioni manuali disponibili).
