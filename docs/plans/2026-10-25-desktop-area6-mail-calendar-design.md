# App desktop Stubwise, area 6: Posta e Calendario — design

Data: 25 ott 2026. Sesto documento della serie (ossatura
`docs/plans/2026-10-23-desktop-ossatura-design.md`, aree 2–5 accanto). Si
costruisce nel prototipo `apps/desktop` con dati finti, con le stesse
regole: ogni pagina definita fino in fondo, stati veri, permessi verificati
col «vedi come». Linguaggio visivo `apps/desktop/DESIGN.md`; UI e UX
definite con Impeccable (shape → costruzione → revisione).

Le decisioni marcate *(maintainer)* vengono dalla conversazione; quelle
marcate *(scelta del costruttore)* sono proposte confermabili.

## Perché

La mattina il maintainer apre posta e calendario per due cose: vedere se
c'è qualcosa di nuovo e prepararsi agli impegni del giorno *(maintainer)*.
Lì non perde tempo. Il tempo lo perde **dopo**: tenere traccia di quello
che gli viene detto, per email e in riunione, e trasformarlo a memoria in
task, richieste e aggiornamenti *(maintainer)*.

Le riunioni passano anch'esse dalla posta: le registrano su Google Meet, e
a riunione finita arriva un'email di Gemini con il link a un Google Doc che
contiene la trascrizione *(maintainer)*. Oggi Stubwise legge il testo
dell'email ma non il documento a cui rimanda, quindi la parte più ricca
resta fuori.

Oggi inoltre un'email entra nel giro delle proposte solo se passa i filtri
configurati per progetto (dominio, mittente, etichetta, parola chiave).
Il maintainer non vuole più doverli scrivere *(maintainer)*.

## Obiettivi

- **Ogni email passa da un modello piccolo** (Haiku) che la associa ai
  progetti, le dà un'importanza, ne ricava l'eventuale scadenza e propone
  le task che ne nascono — senza filtri per progetto *(maintainer)*.
- **Le riunioni registrate diventano proposte**: l'email di Gemini viene
  riconosciuta, il Google Doc della trascrizione letto e collegato
  all'evento del calendario, e da lì nascono proposte come da un'email
  *(maintainer)*.
- **Una proposta per email e progetto, condivisa** fra tutti i destinatari
  che usano Stubwise *(maintainer)*.
- **Home**: due blocchi nuovi, «Email importanti» e «Prossimi
  appuntamenti» *(maintainer)*.
- **Posta e Calendario** come viste complete per il giro d'insieme
  *(maintainer)*, con le funzioni del web.
- **Scheda di preparazione** a una riunione: lo stato del progetto in un
  colpo d'occhio *(maintainer)*.
- **Scrivere dalla posta**: rispondere, inoltrare, scrivere un'email nuova,
  a mano o partendo da una bozza di Claude *(maintainer)*.
- **Agire sul calendario**: creare riunioni, rispondere agli inviti,
  modificare e spostare i propri eventi *(maintainer)*.

## Non obiettivi

- **Proposte di modifica alla documentazione di prodotto.** La
  documentazione di prodotto (scritta dal PO/PM, anche prima che esista
  codice) andrà dentro Stubwise, in un'area a sé fatta **dopo** questa
  *(maintainer)*. Qui le proposte producono task e richieste; il tipo
  «aggiorna questa pagina di prodotto» si aggiunge con quell'area.
- **Il cambio vero sul server** (classificazione di tutte le email, lettura
  dei Google Doc, invio di posta, scrittura sul calendario, nuovi scope
  OAuth): il prototipo lo simula; il lavoro sul backend è un progetto a
  parte, che parte da questo design.
- Trascrizioni che non vengono da Gemini (Zoom, Teams, registrazioni
  caricate a mano).
- Una casella condivisa del team: ognuno vede la propria posta.
- Gestire le etichette di Gmail, archiviare, spostare nel cestino, regole
  di posta: si fa su Gmail.

## Anti-obiettivi

- **Una posta o un calendario indietro rispetto a Google** *(maintainer)*:
  eventi non allineati, email che arrivano in ritardo. È il motivo per cui
  si tornerebbe a Gmail. Ogni vista dice quanto è aggiornata e si può
  riallineare subito (vedi «Allineamento»).
- **Duplicati**: la stessa email arrivata a cinque colleghi non produce
  cinque proposte *(maintainer)*.
- **Privacy incrinata**: un'email la vede solo chi ne è destinatario o in
  copia, admin compresi *(maintainer; invariante `mailbox_owner` già in
  vigore)*. Né la ricerca né le schede la rivelano ad altri.
- **Rumore**: newsletter, email personali e notifiche automatiche restano
  nella posta e non producono nulla *(maintainer)*.
- **Un'email che parte da sola**: niente viene spedito senza un clic
  esplicito di chi scrive *(scelta del costruttore)*.

## Home *(maintainer)*

Due blocchi nuovi nel catalogo della Home a blocchi (`pages/home/blocks`),
presenti di default in una Home nuova *(scelta del costruttore)*:

- **Email importanti**: le email di importanza alta non ancora aperte,
  dalla più recente, con mittente, oggetto, progetto e scadenza se c'è.
  Un clic apre la conversazione in Posta. Vuoto: «Niente di importante».
- **Prossimi appuntamenti**: gli eventi da adesso a fine giornata di domani
  *(scelta del costruttore)*, con ora, titolo, progetto e un segno se c'è
  la scheda di preparazione. Un clic apre l'evento con la scheda.

Le proposte nate da email e riunioni restano anche nel blocco «Da decidere»
della Home, come stabilito dall'ossatura.

## Posta

### Cosa si vede *(come il web, più importanza)*

Le funzioni del web (`apps/desktop/docs/web-inventory.md`, «Mail») si
portano tutte: elenco per conversazione, pannello di lettura, messaggi di
contesto, testo citato, allegati, originale in un frame isolato con le
immagini remote bloccate fino al clic, «Apri in Gmail», filtro per casella,
avviso di conservazione di 90 giorni, «Riproponi».

Si aggiunge l'**importanza** *(maintainer)*: tre livelli, alta, normale,
bassa *(scelta del costruttore)*, decisi dal modello e mostrati sulla riga.
L'elenco si filtra per importanza e per progetto. La **scadenza** ricavata
compare accanto all'oggetto. Le email senza progetto restano nell'elenco
senza etichetta di progetto e senza proposte *(maintainer)*.

Il «Da smistare» di oggi (triage) diventa il caso «il modello non è sicuro
del progetto»: la proposta chiede di scegliere il progetto, come la
`choose_project` di oggi *(scelta del costruttore)*.

### La classificazione *(maintainer)*

Ogni email in arrivo passa dal modello, **nessun filtro prima**
*(maintainer)*: spariscono sia i domini ammessi d'istanza (Impostazioni →
Google, «Admitted mail») sia le regole della posta per progetto. È il
modello a scartare newsletter, notifiche e posta personale. Per ciascuna
email restituisce: i progetti (zero, uno o più), l'importanza, la scadenza
se c'è, e le proposte.

I **progetti candidati** sono quelli di cui almeno un destinatario in
Stubwise è membro *(scelta del costruttore)*. Ognuno vede l'etichetta di
progetto e le proposte solo dei progetti che può vedere: un progetto
invisibile resta invisibile anche qui.

L'interruttore personale «Proposte attive per questa casella» resta: chi lo
spegne non manda la propria posta al modello.

### Proposte da un'email *(maintainer)*

- Ogni proposta è una **task** (titolo, descrizione con le parole
  dell'email, persona incaricata, scadenza) o una **richiesta** (il backlog
  del desktop), secondo il contenuto; di solito una task *(maintainer)*.
  Restano le azioni di oggi: aggiornare o commentare una task esistente,
  registrare una decisione, creare un traguardo, scegliere il progetto,
  spostare su un altro progetto.
- **La persona incaricata** può essere chiunque nel team, non solo chi è
  nell'email *(maintainer)*. Se il modello non la individua, la task resta
  senza incaricato e chi conferma la sceglie.
- **Incaricato fuori dal progetto** *(maintainer)*: alla conferma compare
  «<Nome> non è nel progetto: aggiungila come Contributor?». Chi ha il
  permesso di gestire i membri la aggiunge e la task le viene assegnata;
  chi non ce l'ha sceglie un altro incaricato o lascia la task senza.
- Prima di confermare si può **modificare** ogni campo, e confermare solo
  alcune proposte dello stesso messaggio, come nel desktop già fa la
  conferma delle proposte di Claude.
- **Conferma** chi ha nel progetto il permesso dell'azione (per una task:
  quello di creare task; per una richiesta: `backlog.create`); chi non ce
  l'ha la **passa al progetto** *(maintainer; invariante esistente)*.

### Una proposta condivisa *(maintainer)*

Un'email arrivata a più persone che usano Stubwise (destinatari o in copia)
produce **una sola** proposta per progetto, non una per casella.

- La vedono tutti i destinatari in Stubwise **membri di quel progetto**,
  nella loro Posta accanto all'email e nel loro «Da decidere». Un
  destinatario non membro non la vede *(scelta del costruttore)*.
- La conferma il primo che ha il permesso; gli altri la vedono chiusa con
  «Confermata da <nome>» e il link alla task o alla richiesta nata. Stessa
  cosa per «Ignorata da <nome>» e «Passata al progetto da <nome>».
- La privacy regge perché la vede solo chi ha già l'email. L'unica
  eccezione è quella di oggi: una proposta **passata al progetto** arriva a
  chi ha il permesso nel progetto, con l'estratto che Stubwise ha letto,
  come la `google.proposal_handed` del web *(scelta del costruttore:
  comportamento invariato)*.
- Chi la riconosce come «la stessa email»: il Message-ID dell'email *(scelta
  del costruttore)*. Una risposta nella stessa conversazione è un messaggio
  diverso, e segue la regola di oggi «una proposta per richiesta, non per
  messaggio».
- Modifiche in corso: se due persone aprono la stessa proposta e la prima
  conferma, la seconda vede che è già stata decisa e non può confermarla di
  nuovo *(scelta del costruttore, come `already_handled` di oggi)*.

### Riunioni registrate *(maintainer)*

- L'email di Gemini con la trascrizione è riconosciuta come tale; Stubwise
  apre il Google Doc collegato con l'account di chi l'ha ricevuta.
- Si collega all'evento del calendario (stesso link Meet e orario)
  *(scelta del costruttore)*.
- Dalla trascrizione nascono: un **riassunto** (testo generato, segnato come
  tale) e le **proposte**, con le stesse regole delle email — una per
  progetto, condivise fra i partecipanti in Stubwise.
- **Riassunto e trascrizione li vede solo chi ha partecipato al Meet**
  *(maintainer)*: i partecipanti dell'evento che usano Stubwise. Gli altri
  membri del progetto vedono solo le task e le richieste nate dalla
  riunione, che sono normali oggetti del progetto.
- Il riassunto si legge dall'email, dall'evento e dalla scheda di
  preparazione delle riunioni successive.
- Nel registro decisioni entra solo ciò che qualcuno conferma, con un testo
  da template: il registro non è mai scritto dall'AI (invariante).

### Scrivere *(maintainer)*

- **Rispondi, Rispondi a tutti, Inoltra, Nuova email**, dalla casella
  scelta. Destinatari con completamento dalle persone del team e dai
  contatti visti nella posta, oggetto, testo, allegati (anche dal Drive del
  progetto, *scelta del costruttore*).
- **Bozza di Claude** *(maintainer)*: un pulsante chiede a Claude una bozza;
  Claude usa la conversazione, il progetto (task, stato) e un'indicazione
  facoltativa («digli che slitta a giovedì»). La bozza riempie il campo e
  si modifica liberamente. Non parte mai da sola.
- Le bozze non spedite restano salvate per conversazione *(scelta del
  costruttore)*. L'email inviata compare nella conversazione.
- Annulla l'invio: qualche secondo per annullare dopo «Invia» *(scelta del
  costruttore, come Gmail)*.

## Calendario

### Cosa si vede *(come il web)*

Giorno, Settimana (predefinita) e Mese; Oggi/Precedente/Successivo;
mini-mese; filtro per casella con un colore per account; dettaglio con ora,
partecipanti e risposte, descrizione isolata, luogo, Meet, promemoria,
ricorrenza, «Apri in Google Calendar»; serie ricorrenti spente di default e
la loro configurazione (progetto, azione, giorni di anticipo, «Agisci da
solo»). Restano le regole di oggi: un appuntamento passato o rifiutato non
diventa mai una proposta; un evento con orario si legge nel fuso locale,
uno «tutto il giorno» come data.

Ogni evento ha un **progetto**, deciso dal modello da titolo, descrizione e
partecipanti; si corregge a mano *(scelta del costruttore)*. Un evento
senza progetto mostra solo i suoi dettagli.

**Proposte dal calendario** *(scelta del costruttore)*: una riunione
normale non produce proposte. Le producono le serie ricorrenti accese (come
oggi), le trascrizioni dei Meet e un evento futuro che il modello riconosce
come scadenza o consegna (proposta: un traguardo). Una proposta di
calendario resta non passabile al progetto, come oggi.

### Agire *(maintainer)*

- **Nuova riunione**: titolo, giorno e ora (o tutto il giorno), durata,
  partecipanti (persone del team e indirizzi), descrizione, progetto,
  «Aggiungi Google Meet», casella da usare. Mostra se i partecipanti del
  team sono liberi, letto dai calendari collegati *(scelta del
  costruttore)*.
- **Rispondere a un invito**: Sì, Forse, No, con nota facoltativa.
- **Modificare, spostare, eliminare** gli eventi di cui si è organizzatori,
  anche trascinandoli nella griglia. Per una serie: «solo questo» o «tutta
  la serie» *(scelta del costruttore)*. Chi non è organizzatore cambia solo
  la propria risposta.

### Scheda di preparazione *(maintainer)*

Si apre da un evento con progetto (Calendario, «Prossimi appuntamenti»).
Una panoramica da leggere in un minuto:

1. **Ultime email** scambiate sul progetto — solo quelle che vede chi
   guarda.
2. **Ultime riunioni** del progetto, con le cose da fare decise lì e il
   loro stato di adesso (task aperta, chiusa, in ritardo); il riassunto
   compare solo nelle riunioni a cui chi guarda ha partecipato.
3. **Stato del progetto**: task in corso, in ritardo, ferme, prossime
   scadenze e traguardi. Riusa i pezzi della panoramica di progetto del
   desktop *(scelta del costruttore)*.

Chi non è membro del progetto vede solo i dettagli dell'evento.

## Allineamento *(maintainer: anti-obiettivo; forma del costruttore)*

- Posta e Calendario mostrano sempre «Aggiornato N min fa» per casella e un
  «Aggiorna ora».
- Oltre una soglia (5 minuti, *scelta del costruttore*) il dato è segnato
  come vecchio; una casella con il collegamento scaduto lo dice e offre
  «Ricollega».
- Una scrittura (email inviata, evento creato o spostato) appare subito e
  porta il segno «in invio» finché Google non conferma; se fallisce lo dice
  e offre «Riprova».

## Quanto è vero nel prototipo *(scelta del costruttore)*

- Posta, calendario, trascrizioni e classificazione sono dati finti; le
  nuove email «arrivano» con un ritardo simulato, e la classificazione
  compare dopo qualche secondo con lo stato «in analisi».
- Invio di email e scritture sul calendario aggiornano lo store finto; nulla
  esce dall'app.
- La bozza di Claude è un testo finto costruito dal contesto, con lo stesso
  streaming delle risposte di Claude nel desktop.
- «Apri in Gmail», «Apri in Google Calendar», «Apri la trascrizione»
  mostrano un avviso, come «Apri in Google Drive» nell'area 5.

## Permessi

- Posta e Calendario sono **personali**: non c'è un permesso per vederli,
  solo l'account Google collegato (Impostazioni → Account, area 5). Chi non
  l'ha collegato vede lo stato «Collega il tuo account Google».
- Confermare una proposta segue il permesso dell'azione nel progetto
  (invariante esistente); il «vedi come» deve mostrare la stessa proposta
  confermabile per un Project Lead e da passare per un Viewer.
- La scheda di preparazione mostra lo stato del progetto solo ai membri.
- Nessun permesso nuovo *(scelta del costruttore)*.

## Stati

Ogni pagina: caricamento, vuoto, errore con «Riprova», pieno, account non
collegato, collegamento scaduto. Per un'email: in analisi, classificata,
senza progetto, analisi fallita («Riproponi»). Per una proposta: aperta,
confermata (da chi), ignorata, passata, fallita. Per una trascrizione: in
lettura, pronta, documento non raggiungibile. Per l'invio: in invio,
inviata, fallita. Per un evento: in salvataggio, salvato, fallito.

## Dati finti

- Due persone con account collegato e una senza; una casella scaduta.
- Email su AUD e STW di importanza diversa, con scadenze; newsletter e una
  email personale senza progetto; una email incerta fra due progetti.
- Una email arrivata a tre persone del team, con una proposta condivisa
  aperta, e una già confermata da un collega.
- Un'email di Gemini dopo una riunione AUD con trascrizione, riassunto e
  quattro proposte di task, una assegnata a una persona del marketing che
  non era alla riunione.
- Una giornata piena in calendario: riunioni di progetto (con scheda), una
  personale, un invito in attesa di risposta, un evento tutto il giorno,
  una serie ricorrente spenta e una accesa.
- Riunioni passate dello stesso progetto con riassunti, per riempire la
  scheda di preparazione.

## Parità con il web

Le voci «Mail & Calendar» dell'inventario e le card `google.proposal` /
`google.proposal_handed` si portano tutte (tabella in
`apps/desktop/docs/area6-parity.md`, da scrivere). Non si portano, per
scelta *(maintainer)*: le «regole della posta» di progetto e l'ammissione
d'istanza («Admitted mail», domini ammessi). Il vuoto del calendario non
rimanda più alle regole della posta.

## Lasciato al costruttore

- Forma visiva di elenco, lettura, composizione, griglia, scheda (shape
  Impeccable).
- Come si mostra l'importanza (segno, colore, ordine).
- Testo dei prompt e tono di riassunti e bozze.
- Scorciatoie da tastiera di Posta e Calendario.

## Decisioni aperte

Nessuna.
