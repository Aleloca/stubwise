# App desktop Stubwise, area 4: la Chat — design

Data: 25 ott 2026. Quarto documento della serie (ossatura
`docs/plans/2026-10-23-desktop-ossatura-design.md`, area 2
`…-area2-task-design.md`, area 3 `…-area3-claude-design.md`). Si costruisce
nel prototipo `apps/desktop` con dati finti, con le stesse regole: ogni
pagina definita fino in fondo, stati veri, permessi verificati col «vedi
come». Linguaggio visivo `apps/desktop/DESIGN.md`; UI e UX definite con
Impeccable (shape → costruzione → revisione).

Le decisioni marcate *(maintainer)* vengono dalla conversazione; quelle
marcate *(scelta del costruttore)* sono proposte confermabili.

## Perché

Il team usa Slack e Slack in sé va bene *(maintainer)*. Due cose non vanno:
il piano gratuito **cancella lo storico**, e per citare qualcosa di un
progetto bisogna **andarlo a cercare fuori**, copiare il link o allegare il
file a mano. La Chat interna conserva tutto e porta Stubwise dentro il
messaggio: è il suo punto di forza *(maintainer)*. Sostituisce Slack del
tutto.

## Obiettivi

- Le funzioni di Slack che il team usa ogni giorno: **canali, messaggi
  diretti, thread, reazioni, menzioni, ricerca** *(maintainer)*.
- **Storico per sempre**: nessun messaggio scade.
- **Citare Stubwise senza uscire**: task, richieste, pagine, file, persone,
  progetti, conversazioni con Claude si citano dal messaggio e si aprono con
  un clic, con anteprima.
- **@Claude** nei canali e nei thread *(maintainer)*.
- Gli **eventi dei progetti** arrivano nel canale del progetto *(maintainer)*.

## Non obiettivi

- **Chiamate** e videochiamate *(maintainer: non servono)*.
- Stato/presenza, messaggi programmati, canali condivisi con esterni.
- Il costruttore di regole «quando X, scrivi nel canale Y»: è dell'area 7
  (Automations); qui solo gli eventi di progetto predefiniti.
- Il Drive come spazio file (area 5): qui gli allegati di un messaggio.

## Anti-obiettivi

- Uno Slack «quasi uguale» ma più lento o più confuso da usare.
- Due posti per la stessa conversazione: i canali di un progetto sono **gli
  stessi** nella Chat globale e dentro il progetto (dall'ossatura).
- Rumore: eventi automatici che sommergono i messaggi delle persone.
- Una menzione che chiede qualcosa persa fra le notifiche.

## Modello

### Canali

- **Canali di progetto**: appartengono a un progetto. Ogni progetto nasce
  con un canale **«general»** aperto a tutti i suoi membri *(scelta del
  costruttore)*; altri canali si creano con il permesso di progetto
  **«creare canali»** *(maintainer)*.
- **Canali generali**: dell'azienda, non di un progetto (es. «annunci»,
  «marketing», «chiacchiere»); si creano con il permesso d'istanza **«creare
  canali generali»** *(maintainer)*.
- **Aperti o privati** *(maintainer)*. Aperto: lo vede (e vi entra) chi vede
  il progetto, o tutta l'azienda se generale. Privato: lo vede solo chi è
  invitato, anche se appartiene a un progetto. *(scelta del costruttore)*
  In un privato invitano e tolgono membri il creatore e chi ha il permesso
  di gestire i canali (di progetto o d'istanza); un privato di progetto può
  invitare solo membri del progetto.
- Nome, descrizione, argomento; archiviare (resta leggibile) ed eliminare
  (solo chi gestisce i canali, con conferma). *(scelta del costruttore)*
  I nomi dei canali di progetto si mostrano come `AUD · general`.
- **Privacy** *(maintainer)*: chi gestisce i canali vede che un canale
  privato esiste (nome e membri) e può archiviarlo o eliminarlo, ma **non ne
  legge i messaggi**; i messaggi diretti non li vede nessuno tranne chi
  partecipa, nemmeno il full admin. La ricerca segue le stesse regole.
- *(scelta del costruttore)* **Appartenenza**: il canale «general» comprende
  automaticamente tutti i membri del progetto; negli altri canali aperti si
  entra con un clic; non letti, «@canale» ed eventi valgono per chi è
  dentro.
- **Messaggi diretti** fra due persone e di gruppo (fino a 8 *(scelta del
  costruttore)*); privati per costruzione.

### Messaggi

- Testo markdown (come la conversazione con Claude: niente HTML), allegati
  (trascina, incolla, graffetta; immagini con anteprima), **citazioni**.
- **Thread**: si risponde a un messaggio in un pannello a destra; nel
  canale resta «N risposte · ultima di X»; «Rispondi anche nel canale»
  *(scelta del costruttore)*.
- **Reazioni** con emoji (le più usate + selettore), chi ha reagito al
  passaggio del mouse.
- **Modifica ed eliminazione** solo dei **propri** messaggi *(maintainer:
  nessuno elimina i messaggi altrui; una risposta di Claude la elimina chi
  l'aveva chiamato)*:
  un messaggio modificato dice «modificato»; uno eliminato lascia «Messaggio
  eliminato» senza testo (stessa regola dei commenti di oggi: il testo
  sparisce ovunque).
- **Storico per sempre** *(maintainer)*: nessuna scadenza.

### Citazioni *(maintainer: punto di forza)*

- Nella casella: **«#»** cerca e cita oggetti di Stubwise (task, richieste,
  pagine Docs, file, progetti, canali, conversazioni con Claude), **«@»**
  persone, reparti, «@canale» e «@Claude». Stesso componente e stesse regole
  della conversazione con Claude (area 3).
- Nel messaggio un oggetto citato compare con **codice e nome**, apribile;
  al passaggio del mouse un'anteprima (stato, assegnatario, ultimo
  aggiornamento). Un codice scritto a mano diventa link da solo.
- **Visibilità**: chi legge un messaggio vede l'oggetto citato solo se può
  vederlo; altrimenti il codice resta sbiadito e non apribile, senza titolo
  (regola R-E9 dell'area 3).
- **Allegare dal progetto**: dalla graffetta si sceglie anche un file del
  Drive del progetto (quando arriva l'area 5) invece di caricarlo.
- *(scelta del costruttore)* Da un messaggio: **«Crea task»** e **«Crea
  richiesta»**, precompilate con il testo e collegate al messaggio (il
  messaggio mostra «→ AUD-14»); **«Copia il link»** al messaggio.

### Menzioni e non letti

- **@persona**, **@reparto** (i membri del canale di quel reparto),
  **@canale** (tutti i membri del canale) *(scelta del costruttore su
  @reparto: limitato a chi è nel canale)*.
- Una menzione diretta va nelle **notifiche**; se il messaggio è una
  **domanda rivolta a te** (finisce con «?» o lo segni come «chiede una
  risposta») compare anche in **«Da decidere»** nella Home finché non
  rispondi *(scelta del costruttore, dall'ossatura: «una menzione diretta
  compare anche fra le decisioni della Home»)*.
- **Non letti**: per canale (grassetto + conteggio per menzioni), riga
  «Nuovi» nel canale, «Segna come letto»; i canali silenziati non contano
  nel conteggio salvo menzioni dirette.
- Preferenze per canale: tutti i messaggi / solo menzioni / silenziato.

### @Claude *(maintainer)*

- Si chiama scrivendo «@Claude» in un canale o in un thread; risponde **nel
  thread** di quel messaggio *(scelta del costruttore: sempre nel thread,
  per non riempire il canale)*.
- Usa i **permessi di chi l'ha chiamato, senza controlli**, e pubblica
  subito: chi lo chiama ne è responsabile *(maintainer)*. La risposta è
  marcata «Claude, chiamato da X».
- Le **modifiche** restano proposte da confermare, e le conferma solo chi
  l'ha chiamato (area 3).
- Stessa resa della conversazione con Claude (testo in diretta, righe
  d'azione, citazioni, schede).
- **Ogni chiamata è di chi la fa** *(maintainer)*: in un thread ogni
  «@Claude» è una chiamata nuova con i permessi di chi la scrive; la
  risposta è marcata «chiamato da X»; Claude legge il thread come contesto.
  Senza «@Claude» Claude non risponde. Le proposte le conferma solo chi le
  ha chieste.
- *(scelta del costruttore)* Gli scambi con @Claude sono **messaggi della
  Chat**, non conversazioni della destinazione «Claude»; le proposte scadono
  con la regola dell'area 3 (20 messaggi del thread o 24 ore).
- *(scelta del costruttore)* Una domanda che Claude fa a chi l'ha chiamato
  durante un lavoro avviato dalla chat arriva nel thread e in «Da decidere».

### Eventi dei progetti nel canale *(maintainer)*

- Gli eventi di un progetto arrivano come **messaggi di sistema** nel suo
  canale «general» (o in un altro scelto nelle impostazioni del canale), con
  la **scheda dell'oggetto**: nuova pagina di Release, PR aperta o mergiata,
  traguardo raggiunto, brief settimanale pronto, richiesta nuova, task
  chiusa *(scelta del costruttore sull'elenco)*. *(scelta del costruttore)*
  Le pagine di Release arrivano con l'area 8: fino ad allora la scheda punta
  a una pagina di Release finta del seme.
- Nelle impostazioni del canale si scelgono quali eventi pubblicare
  (predefinito: Release, traguardi, brief). Le regole più complesse sono
  dell'area 7.
- I messaggi di sistema non contano come non letti con menzione e si
  possono nascondere con un filtro «Solo persone».

### Ricerca

- Nella Chat (barra in testa) e da ⌘K: testo, filtri per canale, persona,
  data, «con allegati», «con citazioni»; risultati raggruppati per canale
  con il contesto; un clic porta al messaggio evidenziato. Solo ciò che chi
  cerca può vedere.

## Dove vive *(dall'ossatura)*

- **Chat globale** (binario): colonna con **Canali** (raggruppati per
  progetto, poi i generali), **Messaggi diretti**, «Thread» (i thread a cui
  partecipi con risposte nuove), «Menzioni»; in testa «Nuovo messaggio» e la
  ricerca.
- **Dentro il progetto**: la sezione «Chat» mostra i canali di quel progetto,
  gli **stessi** della Chat globale (stessi messaggi e non letti).
- Pannello thread a destra (agganciato da 1200px, sovrapposto sotto), come il
  dettaglio della task.

## Slack si spegne *(maintainer)*

La Chat sostituisce Slack del tutto: nell'app desktop non esistono le
impostazioni Slack, il collegamento dell'identità Slack, il toggle «DM
Slack» delle notifiche, «Invita da Slack», il comando `/docs` (→ @Claude),
le domande dell'agente nei DM Slack (→ «Da decidere» e chat). *(scelta del
costruttore)* Resta il **webhook in uscita** generico (formati Slack,
Discord, JSON) delle impostazioni di progetto: non è chat, è un'integrazione
verso l'esterno, e la decisione resta all'area 9. Il ticket con sorgente
«slack» resta leggibile come dato storico.

## Permessi

- Nuovi: progetto **`chat.channels.create`**, **`chat.channels.manage`**;
  istanza **`chat.general.create`**, **`chat.general.manage`** *(scelta del
  costruttore sui nomi e sulla separazione create/manage)*. Di base: create
  a Project Lead e Developer nei progetti, `chat.general.create` a tutti gli
  utenti, i manage ai Project Lead / admin. Assegnabili a qualunque ruolo.
- Scrivere in un canale: esserne membro (aperto = chi lo vede può entrare).
  Leggere un canale archiviato: chi lo vedeva.

## Stati

Ogni pagina: caricamento, vuoto (con l'azione se permessa), errore con
«Riprova», pieno, senza permessi; per i messaggi: in invio, inviato, non
inviato con «Rimanda», modificato, eliminato; canale archiviato in sola
lettura.

## Dati finti

Canali «general» per tutti i progetti, qualche canale tematico (AUD
«releases», MKX «grafica», uno privato), generali «annunci», «marketing»,
«chiacchiere»; DM e un gruppo; settimane di storico con thread, reazioni,
citazioni di task/richieste/pagine/file, eventi di sistema, un @Claude con
risposta e una proposta; menzioni e non letti diversi per persona.

## Parità con il web

Il web non ha una chat; questa area chiude le voci Slack dell'inventario
(impostazioni Slack, identità Slack, DM Slack, invito da Slack, comando
slash) come «sostituite dalla Chat» e mantiene il webhook in uscita.

## Decisioni aperte

- Struttura del Drive (area 5) per gli allegati scelti dal progetto.
