# App desktop Stubwise, parte 1: l'ossatura — design

Data: 23 ott 2026. Primo documento di una serie: questo fissa l'ossatura
dell'app desktop (navigazione, linguaggio visivo, modelli trasversali, dove
finisce ogni funzione di oggi). Ogni area dell'app avrà poi un suo documento
di design, approvato prima di essere costruito nel prototipo. Contesto di
prodotto: `apps/desktop/PRODUCT.md`. Inventario del web attuale, lista di
controllo per la parità: `apps/desktop/docs/web-inventory.md`.

## Perché

Stubwise oggi è lo strumento del reparto tecnico: ticket, backlog, pipeline
dell'agente che pianifica, scrive codice e apre PR. L'obiettivo è farne il
**centro di tutti i progetti dell'azienda** — una cinquantina attivi, fra
prodotti interni e commesse — per **tutti i reparti**: commerciale,
marketing, assistenza, sviluppo, amministrazione. Sostituisce Jira (costoso)
e Slack (gratuito, cancella lo storico). L'AI, che oggi lavora solo sui
ticket tecnici, diventa un collega su ogni tipo di task.

Web e app mobile di oggi non reggono questo salto: estetica «terminale»
pensata per sviluppatori, funzioni aggiunte dove c'era posto, voci difficili
da distinguere. La nuova esperienza nasce come **app desktop Electron**
(macOS e Windows), ripensata da zero. Web e mobile restano come sono.

## Cosa si costruisce ora

Un **prototipo cliccabile con dati finti**: nessun DB, nessuna API, ma
navigazione, transizioni e stati veri. Il prototipo **è la specifica**
dell'app completa: ogni pagina va definita fino in fondo (contenuti, azioni,
stati vuoto/caricamento/errore/pieno, permessi, transizioni). Nessuna area
abbozzata. L'app vera evolverà da questo stesso codice (`apps/desktop`).

## Obiettivi

- Una struttura in cui **ogni funzione ha un posto pensato**, decisa adesso
  per tutte le aree, comprese quelle che arriveranno dopo.
- **Parità con il web**: ogni funzione di `apps/web` entra, ridisegnata e
  ricollocata (mappa più sotto).
- Leggibile e chiara per chi non è tecnico; professionale; transizioni
  semplici e pulite che spiegano cosa è successo.
- Il passaggio fra la vista generale e un progetto, e fra progetti, è
  immediato.

## Non obiettivi

- Toccare `apps/web` o `apps/mobile`.
- Backend, API, migrazioni: il prototipo non ne ha. Le entità nuove (reparti,
  settimana pianificata, chat, drive, automazioni) sono definite qui a livello
  di prodotto; il modello dati vero è un lavoro successivo.
- Decidere cosa fa concretamente l'AI su ogni tipo di task non tecnica: si
  decide caso per caso, man mano che i reparti portano le loro task. Il
  prototipo mostra il **modello** (Claude come collega), non i flussi di ogni
  reparto.
- CRM: contratti e trattative restano in Audin, HubSpot o altri sistemi, e
  arrivano come eventi.
- Sprint ed epiche alla Jira (vedi «Pianificazione»).

## Anti-obiettivi (fallimento anche se funziona)

- Estetica da terminale, monospace diffuso, aria «da sviluppatori».
- Codici al posto dei nomi: chi non è tecnico deve capire senza decifrare.
- Due posti per la stessa cosa (com'era l'Inbox accanto a «Waiting on you»).
- Una nuova funzione aggiunta «dove c'è spazio» invece che nel suo posto.
- Colore come unico modo di riconoscere qualcosa.

## Vincoli

- Electron, React + TypeScript + Vite, nel monorepo pnpm come
  `apps/desktop` (scelta delegata: stesso linguaggio del resto, così il
  prototipo diventa l'app). Dati finti scritti a mano, realistici, in moduli
  dedicati facilmente sostituibili da chiamate all'API in futuro.
- **Lingue**: inglese di default, italiano come seconda. Tutti i testi da
  file di traduzione fin dal prototipo; lunghezze diverse non rompono il
  layout.
- **Temi**: chiaro e scuro, entrambi curati alla pari; l'app segue il
  sistema, con override nelle preferenze.
- **Piattaforme**: identità propria uguale su Mac e Windows, ma convenzioni
  di ciascun sistema rispettate (barra della finestra, ⌘ / Ctrl nelle
  scorciatoie, menu dell'applicazione).
- **Densità**: media; compatta dove si lavora su molte righe (elenchi task,
  richieste, board).
- **Prodotto distribuibile** (self-hosted per altre aziende): niente reparti,
  nomi o flussi cablati su una sola organizzazione. I reparti sono
  configurabili.
- Nome **Stubwise** e logo attuale (monogramma «S_», ambra `#f5a623` su
  `#0f1318`) restano; tutto il resto dell'identità è nuovo.

## Il linguaggio visivo: «Catalogo numerato»

Scelto dal maintainer fra quattro direzioni (decision page di Impeccable,
bozza in `apps/desktop/.impeccable/mocks/decision/challenger-catalog.html`,
tavola di riferimento in `apps/desktop/.impeccable/refs/`). Deriva dal
catalogo di Factory Records di Peter Saville, dove ogni oggetto ha un numero.

- **Tesi**: ogni cosa che si cita — task, pagina di documentazione, file del
  drive, automazione, evento in arrivo — è una voce di catalogo con un codice
  citabile ovunque. Il codice è l'àncora della riga, il **nome si legge
  sempre** accanto.
- **Materiale**: superfici piatte, **filetti sottili** al posto di riquadri e
  ombre, molto spazio calmo. Etichette maiuscole spaziate solo per le
  intestazioni di gruppo, mai per testi lunghi.
- **Colore**: pochi colori pieni che *codificano* qualcosa, mai decorativi.
  Il colore principale è quello dei **reparti** (striscia sottile a sinistra
  di ogni riga, con legenda). Stato (rosso critico, ambra attenzione, verde
  attivo) solo dove porta significato. L'ambra del marchio resta al logo.
- **Temi**: lo scuro è la copertina (nero opaco, inchiostro bianco); il
  chiaro è il suo negativo (carta, inchiostro nero), stessa cura.
- **Tipografia**: una grottesca precisa con cifre tabellari per codici e
  date, in un solo carattere (la bozza usa Geist, segnalato come troppo
  diffuso: il carattere definitivo si sceglie in costruzione con lo stesso
  carattere, meno visto). Monospace mai, tranne il logo.
- **Mossa distintiva**: il codice di catalogo come àncora di ogni riga e
  riferimento vivo — scritto in chat o in un commento diventa un link con
  anteprima — più la striscia del reparto.
- Discipline prese dalle direzioni scartate e portate in questa:
  - la task successiva è sempre a un tasto (J/K), già caricata;
  - nelle timeline la lunghezza di una barra è la sua durata esatta;
  - una griglia sola: i pannelli si ridimensionano per colonne intere;
  - una task ha la stessa forma e posizione in ogni stato, così il cambio
    di stato si legge come cambio.
- **Movimento**: 150–250 ms, solo per dire cosa è cambiato (entrare in un
  progetto, aprire un pannello, una task che cambia stato, un elemento che
  arriva). Nessuna sequenza d'ingresso. Riduzione del movimento rispettata.

Il direction contract di Impeccable si registra nel surface brief all'avvio
della costruzione; DESIGN.md lo scrive il documentatore a fine costruzione.

## L'ossatura: binario + colonna

```
┌────┬──────────────┬──────────────────────────────┐
│ S_ │ AUD Audin 2.0│ AUD · Board                  │
│────│──────────────│                              │
│ ⌂  │ Overview     │                              │
│ 💬 │ Tasks        │   area di lavoro             │
│ ✉  │ Planning     │                              │
│ ▦  │ Requests     │                              │
│ ✦  │ Docs         │                              │
│ ⚡ │ Drive        │                              │
│────│ Chat         │                              │
│AUD●│ Releases     │                              │
│BRN │ Support      │                              │
│CBV │ Servers      │                              │
│ ⋯  │ Settings     │                              │
│ 🔔 │              │                              │
│ ⌘K │              │                              │
│ GF │              │                              │
└────┴──────────────┴──────────────────────────────┘
```

**Binario** (stretto, sempre visibile, uguale ovunque):

- Logo.
- Destinazioni personali, trasversali a tutti i progetti: **Home**, **Chat**,
  **Mail**, **Calendar**, **Claude**, **Automations**.
- **Progetti fissati** come tessere col codice (AUD, BRN…). Sulla tessera:
  un punto quando nel progetto c'è qualcosa che aspetta te (decisione,
  domanda, menzione), un indicatore animato quando Claude ci sta lavorando.
  Nessun numero. Poi «Tutti i progetti».
- In fondo: **campanella delle notifiche**, **ricerca ⌘K**, **profilo** (con
  preferenze e, per chi ha i permessi, **Amministrazione**).

**Colonna** (accanto al binario): la navigazione del contesto corrente. Per
le destinazioni personali mostra le loro sottoviste (es. i canali in Chat);
dentro un progetto diventa la navigazione del progetto, con in testa codice e
nome del progetto. Entrare in un progetto = la colonna scorre sulla sua
navigazione (transizione), il binario non si muove: Home, Chat e notifiche
restano a un clic da dentro qualunque progetto.

**Area di lavoro**: la pagina. Un pannello di dettaglio a destra (task,
conversazione, file) si apre sopra l'elenco senza cambiare pagina, ridimen-
sionabile per colonne.

**Cambio progetto**: tessere per i fissati; ⌘K per tutti gli altri (digiti
codice o nome); scorciatoie ⌘1…⌘9 per le tessere. Con 50 progetti nessuno
deve passare da un elenco per cambiare progetto.

## Destinazioni personali

- **Home — «My work»**. La porta d'ingresso. In cima **«Da decidere»**:
  tutto ciò che aspetta una tua decisione (piani da approvare, domande di
  Claude, proposte del polso, proposte nate dalle email, menzioni che ti
  chiedono qualcosa), risolvibile sul posto. Sotto, **le tue task** di tutti
  i progetti, per scadenza (in ritardo, oggi, questa settimana…) e con le
  viste «assegnate a me / delegate / che seguo». Qui vive anche **la mia
  settimana** (vedi «Pianificazione»).
- **Chat**: canali di progetto, canali generali, messaggi diretti. Si possono
  allegare/citare task, file del drive, pagine di documentazione, con
  anteprima. Messaggi non letti con il loro contatore; una menzione diretta
  compare anche fra le decisioni della Home. Prende il posto dei flussi Slack
  di oggi (domande dell'agente nei DM, `/docs`).
- **Mail**: la posta collegata di ciascuno, letta per conversazione, con le
  proposte che Stubwise ne ricava accanto all'email da cui nascono.
- **Calendar**: il calendario collegato, con le proposte dagli eventi e le
  serie ricorrenti.
- **Claude**: cosa sta facendo l'AI, ovunque — sessioni dal vivo e passate
  (oggi «Agents»), con la possibilità di seguirne una, intervenire, fermarla.
- **Automations**: le sorgenti esterne collegate (Audin, HubSpot, webhook) e
  il costruttore di regole evento → condizioni → azioni (task per reparto o
  persona, altre automazioni, lavoro affidato a Claude). Le regole le crea il
  team, non solo gli sviluppatori.
- **Notifiche** (campanella → pannello laterale): ciò che è successo nei tuoi
  progetti e non chiede nulla (PR aperta, lavoro fallito, server giù, brief
  pronto). Si legge, si archivia, si rimanda.

**L'Inbox come sezione a sé non esiste più** (decisione del maintainer): le
decisioni stanno nella Home, le informazioni nelle notifiche, le proposte
delle email nella Mail. Rimandare e «segnare come gestito» restano, dove
servono.

## La vista di un progetto

**Moduli per progetto** (decisione del maintainer). Non tutti i progetti hanno
repository, widget o server: una campagna di marketing non ha Releases. Ogni
progetto **accende i suoi moduli** nelle Settings; alla creazione si sceglie
un **modello** che li preimposta — *Software*, *Marketing*, *Commessa
cliente*, *Vuoto* (i modelli sono configurabili dall'amministrazione, nessuno
cablato). **Sempre presenti**: Overview, Tasks, Planning, Requests, Drive,
Chat, Settings. **Moduli**: Docs (generati dai repository), Releases,
Support, Servers. Un modulo spento non compare nella colonna; riaccenderlo
non perde dati. La composizione precisa dei modelli si fissa nel documento
dell'area 2.

- **Overview**: il polso (cosa aspetta chi, cosa gira, cosa è fermo), il
  brief settimanale, i traguardi con avanzamento, la timeline (oggi
  «Roadmap»), il registro decisioni, il report giornaliero (oggi «Activity»,
  per progetto).
- **Tasks**: elenco con filtri e viste salvate, board a colonne, timeline.
  Sono i ticket di oggi allargati a tutti i reparti.
- **Planning**: la settimana del progetto (vedi sotto).
- **Requests**: oggi «Backlog» — idee e richieste che l'AI aiuta a rifinire
  (sessioni di refinement) prima che diventino task. Rinominato perché chi
  non è tecnico capisca dove proporre una cosa nuova, e perché «backlog» in
  Jira vuol dire un'altra cosa.
- **Docs**: documentazione generata dai repository e pagine del progetto, con
  ricerca e chat.
- **Drive**: spazio file del progetto. **Concetto nuovo**: oggi non esiste.
- **Chat**: i canali di questo progetto, vissuti dentro il progetto
  (decisione del maintainer). Sono **gli stessi canali** della Chat globale,
  non copie: un messaggio scritto qui compare là e viceversa, e i non letti
  sono gli stessi. La Chat globale (binario) contiene i messaggi diretti e
  **tutti** i canali, raggruppati per progetto più quelli generali.
- **Releases**: PR, coda di rilascio, ambienti e versioni che vi girano. Il
  merge resta l'unica azione: Stubwise non fa deploy.
- **Support**: le conversazioni del widget customer service.
- **Servers**: i server monitorati legati al progetto.
- **Settings**: generali e AI, membri, repository, integrazione (SDK,
  webhook), widget, regole della posta, plugin, traguardi, zona pericolosa.

## Tutti i progetti

*(scelta del costruttore, confermabile)* «Tutti i progetti», dal binario, è
la **pagina del portafoglio**: tutti i progetti visibili con il loro polso
(aspetta te, in lavorazione, fermo da N giorni), l'elenco di ciò che è
fermo, filtri (interni/commesse, reparto, cliente, preferiti) e l'attività
trasversale di tutti i progetti (oggi «Activity» per data). Da qui si
fissano/sganciano i progetti nel binario e se ne crea uno nuovo. La
documentazione di più progetti insieme si cerca da ⌘K (il «Docs hub» di oggi
non ha una pagina sua). Appartiene all'area 2.

## Amministrazione

Dal profilo, per chi ha i permessi d'istanza: persone e **reparti** (oggi
«Team», con inviti, identità collegate, reset), ruoli e permessi, provider
AI, modelli e consumi, account git, Google, archiviazione, notifiche,
plugin, vista complessiva dei server. Le impostazioni personali (account,
sicurezza e secondo fattore, token, Claude Code, lingua, tema) stanno nelle
**preferenze** del profilo.

## Modelli trasversali

### Codici di catalogo

Ogni oggetto citabile ha un codice stabile:

- task: prefisso del progetto + numero (`CBV-19`);
- pagine di documentazione, file del drive, automazioni, eventi in arrivo
  (contratti ecc.): ciascuno col suo prefisso, definito nel documento della
  sua area;
- le **conversazioni no**: si citano col link al messaggio.

Ogni codice scritto in chat, in un commento o in una descrizione diventa un
link con anteprima al passaggio del mouse. Il codice è sempre accompagnato
dal nome, salvo dove lo spazio lo impedisce (e lì il nome è nell'anteprima).

### Reparti

- Configurabili dall'amministrazione (nome, colore da una palette
  progettata), nessuno cablato.
- Una persona può appartenere a **più** reparti.
- Ogni task ha un **reparto di pertinenza**, indipendente da chi la esegue:
  nasce con un valore proposto (reparto di chi la crea, o deciso
  dall'automazione o dall'AI che la genera) e **si può sempre cambiare**.
  La striscia colorata della riga è quel reparto.
- Claude non ha un reparto.

### Claude come collega

Claude compare come un membro del team: si **assegna** a una task come una
persona, ha uno **stato visibile** (sta lavorando, aspetta una risposta,
aspetta un'approvazione, fermo), e quando deve decidere **chiede** — la
domanda arriva fra le decisioni della Home e, se la conversazione è in chat,
in chat. Il suo lavoro dal vivo si segue dalla task o da «Claude». Cosa sa
fare su ogni tipo di task si definisce per area e per reparto.

### Pianificazione: la settimana, non lo sprint

Il team non lavora a sprint né per epiche: in Jira li usava per raggruppare
il lavoro di settimana in settimana. Quindi:

- Ogni task può avere la **settimana** in cui si pensa di farla.
- **La mia settimana** (Home): ognuno sistema le proprie task nei giorni o
  nella settimana.
- **La settimana del progetto** (Planning): colonne «Questa settimana»,
  «Prossima», «Più avanti», «Da pianificare», col carico per persona.
  Chi ha il permesso **«pianificare le task altrui»** (assegnabile a un ruolo,
  non un ruolo fisso da PM) sposta le task degli altri; l'interessato è
  avvisato nelle notifiche di cosa è cambiato e da chi.
- Ciò che non si chiude **slitta da solo** alla settimana successiva, e si
  vede che è slittato.
- I **traguardi** (obiettivi con una data: lancio, consegna al cliente)
  restano, con avanzamento: fanno il lavoro delle epiche senza il gergo.

### Ricerca e comandi (⌘K)

Una palette unica: cerca (task, progetti, documenti, file, persone, posta,
canali), salta (a un progetto per codice o nome) e — a differenza di oggi —
**esegue azioni** (nuova task, assegna a Claude, cambia tema…).

### Permessi

Il modello di oggi (permessi d'istanza e di progetto, ruoli preimpostati) si
mantiene. Il client mostra o nasconde le azioni secondo i permessi calcolati
dal server (nel prototipo, simulati da un selettore «vedi come» con ruoli
diversi, per verificare ogni pagina con e senza permessi). Permesso nuovo:
«pianificare le task altrui».

## Dove finisce ogni funzione del web di oggi

| Oggi (web) | Nell'app desktop |
|---|---|
| Login, secondo fattore, registrazione su invito, setup, reset password | Flussi d'accesso dell'app (prima finestra) |
| Inbox | Decisioni → Home; informazioni → Notifiche; proposte email → Mail |
| Agents, sessione dal vivo | Claude (binario) + dalla task |
| Mail, Calendar | Mail, Calendar (binario) |
| Tickets, dettaglio ticket, Board | Progetto → Tasks (elenco, board, timeline), dettaglio come pannello |
| Backlog, voce di backlog, refinement | Progetto → Requests |
| Projects (elenco con polso, fermi) | Tutti i progetti (portafoglio) + Overview di ciascuno |
| Project detail (impostazioni, membri, integrazione, widget, regole posta, ambienti, plugin, traguardi) | Progetto → Settings; ambienti → Releases; server → Servers; widget conversazioni → Support |
| Roadmap, weekly brief, registro decisioni | Progetto → Overview |
| Repositories | Progetto → Settings → Repository (elenco complessivo in Amministrazione) |
| Docs (hub, spazio per repository, ricerca, chat, generazione) | Progetto → Docs (modulo); hub → ricerca ⌘K |
| Release queue | Progetto → Releases; vista trasversale nella Home per chi può mergiare |
| Monitor | Progetto → Servers; vista complessiva in Amministrazione |
| Activity (report giornaliero) | Tutti i progetti (attività trasversale) + Progetto → Overview |
| Team | Amministrazione → Persone e reparti |
| Settings personali (account, sicurezza, token, Claude Code) | Profilo → Preferenze |
| Settings d'istanza (AI, notifiche, consumi, git, storage, Slack, Google, provider, plugin, ruoli) | Amministrazione (Slack da rivedere quando la chat interna lo sostituisce) |
| Ricerca globale ⌘K | ⌘K con azioni |
| Riconferma col secondo fattore | Uguale, dialogo dell'app |

Ogni documento d'area riprende la sua riga dell'inventario e la chiude voce
per voce.

## Ordine delle aree

1. **Ossatura** (questo documento): costruzione di binario, colonna,
   temi, tipografia, componenti comuni, ⌘K, notifiche, dati finti di base.
2. Nucleo delle task: Home, Tasks (elenco, board, timeline, dettaglio),
   Planning, Requests, Overview.
3. Claude come collega: sessioni, domande, approvazioni.
4. Chat.
5. Docs e Drive.
6. Mail e Calendar.
7. Automations.
8. Releases, Support, Servers.
9. Amministrazione, preferenze, accesso.

Ogni area: documento di design → approvazione → costruzione nel prototipo →
revisione di Impeccable.

*(scelta del costruttore)* Finché un'area non è costruita, la sua
destinazione esiste già nella navigazione con titolo, colonna e
transizioni, e mostra uno stato neutro «da progettare»: è uno stadio di
lavoro del prototipo, sparisce area per area, e non conta come pagina
abbozzata. ⌘K e notifiche dell'ossatura cercano e linkano i dati finti di
base (progetti, persone, task) anche verso pagine ancora «da progettare».

**Consegna** (decisione del maintainer): il prototipo si avvia dal repo sul
Mac (`pnpm --filter @stubwise/desktop dev`, finestra Electron). Nessun
installer, nessuna firma, nessun job di CI per ora. Le convenzioni Windows si
progettano (barra della finestra, Ctrl, menu) ma si verificano su Windows più
avanti.

## Dati finti

Un'azienda verosimile e **dichiaratamente finta**: ~50 progetti (prodotti
interni come Stubwise e Audin, commesse per clienti inventati), 5 reparti,
~25 persone, Claude, task in ogni stato e reparto, conversazioni, file,
documenti, automazioni. Nessun cliente reale, prezzo o metrica presentati
come veri. L'utente di default è una persona del marketing; un selettore
«vedi come» permette di cambiare persona e ruolo per provare le pagine con
permessi diversi.

*(scelta del costruttore)* I dati finti stanno **dietro un'interfaccia di
dati** (un modulo per entità, funzioni asincrone con latenza simulata, così
caricamenti ed errori sono stati veri) e hanno **la forma degli schemi reali**
di `@stubwise/shared` dove esistono (ticket, job, permessi, ruoli
preimpostati: il «vedi come» usa le chiavi di permesso vere). Le entità nuove
(reparti, settimana pianificata, chat, drive, automazioni, codici) hanno
tipi propri nel prototipo, scritti come proposta di schema. L'app vera
sostituirà l'implementazione finta con `@stubwise/api-client` senza toccare
le pagine.

## Decisioni aperte (non inventarle in costruzione)

- Cosa fa l'AI per ogni tipo di task non tecnica.
- Prefissi dei codici per documenti, file, automazioni, eventi.
- Struttura del Drive (concetto nuovo).
- Destino dell'integrazione Slack quando la chat interna è attiva.
