# Ossatura — cose rimaste aperte (23 ott 2026)

Emerse dalle revisioni della parte 1 (ossatura) e lasciate deliberatamente
per dopo. Da riprendere all'inizio dell'area 2, prima di costruirci sopra.

## Primo passo dell'area 2

- [x] (area 2, T1) **Livello dati consapevole di chi guarda.** Oggi «vedi come» cambia i
  permessi ma non i dati: ogni persona vede i progetti fissati, le notifiche
  e i segnali di Giulia, e un Contributor trova via ⌘K anche progetti di cui
  non è membro (il server risponderebbe 404). Serve una «sessione» nel
  livello finto (`currentPersonId` in `data/api.ts`, impostato da
  `ViewerProvider`, nelle chiavi delle query), con filtri per membro e
  destinatario su `listProjects`, `search`, `listNotifications`, progetti
  fissati. Reparti e persone letti via query, non importando il seed
  (`DeptStrip`, `ProfileMenu`).
- [x] (area 2) **`DetailPanel`** (`layout/useDetailPanel.ts`): Esc globale che ignora
  `defaultPrevented` (con la palette aperta chiude entrambi) e nessun
  spostamento/ritorno del fuoco nella modalità sovrapposta.
- [x] (area 2, pagine e pannello) **Windows**: l'overlay dei controlli finestra copre l'angolo in alto a
  destra dell'area di lavoro; le testate delle pagine devono riservare
  ~32px in alto e ~140px a destra (o `env(titlebar-area-*)`).
- [x] (area 2, derivato dai dati) **Segnale «ti aspetta»** sulle tessere: oggi non è legato a task o
  decisioni reali del seed.

## Minori, quando capita

- Testata della colonna di progetto su query fallita: mostra solo il codice.
- [x] (area 2) URL di progetto in minuscolo (`#/p/aud`) non normalizzati.
- Mutazioni delle notifiche senza `onError` e non ottimistiche.
- Menu dell'applicazione solo in inglese (serve la lingua del renderer via IPC).
- Primo disegno col tema del sistema, non con la preferenza salvata.
- Allineamento dei semafori macOS col logo da verificare a occhio.
- Freccette nella navigazione del menu profilo e del menu «rimanda».
- [x] (area 2, T15) `capture.mjs`: uccidere il gruppo di processi di vite, non solo pnpm.
- Con la finestra alla minima altezza il binario mostra poche tessere.

## Area 2 — minori aperti

Rimasti dopo l'ondata finale dell'area 2 (24 ott 2026), per superficie, uno
per riga. I buchi di parità sono in `area2-parity.md`.

### Dati e dominio

- `domain/filters.ts` duplica `DAY_MS`/`iso`/`mondayOf` di `weeks.ts`; `stalled.ts` scrive `86_400_000` a mano.
- `domain/fixtures.ts` è un modulo di test sotto `src` (nome e bundle).
- `daysSince` può andare sotto zero se `since` è dopo `TODAY` (serve un minimo a 0).
- `openDecisions` rifiltrate anche se documentate già aperte; il test di `weekLabel` dipende dall'ICU.
- La sessione è un globale scritto durante il render mentre le chiavi vengono dal contesto: più solido passare la persona al `queryFn` dalla chiave.
- `notifications/time.ts` importa `data/dates.ts` (riesporta il seed): il test d'architettura non distingue riesportazione e scavalco.
- `prepareTaskPatch`: il traguardo non è verificato; una patch senza differenze passa anche senza `tickets.edit`.
- Regola di visibilità dei filtri duplicata (`canSeeFilter` in `api.ts` e `filterFor`); tre helper `isFullAdmin`.
- `setProjectStatuses` non rifiuta id doppi né la riassegnazione a uno stato creato nella stessa chiamata.
- `slipWeeks` rifà slittare le task del seed a ogni reset; «slittate» = `slipCount > 0`.
- Test di rifiuto deboli (stato di `createRequest` invariato, `not_found` su task invisibile per bulk/plan/update).
- Nessun test dedicato per l'invalidazione a fine `useUpdateTask` e per i doppioni in bulk.
- Query lanciate con id vuoti (`useProject("")`, `useProjectStatuses("")`, `useMilestones("")` in Tasks, BulkBar, Planning, NewTaskDialog).
- `?request=` porta l'id della richiesta, non il codice `STW-R3` (le task usano il codice).

### Seed

- Follower doppi in alcune task (es. `t-stw-1` con `p-marco` due volte).
- Titoli dei `plan_review` col codice senza il nome; il commento dovrebbe dire che sono nella lingua dell'istanza.
- Giulia (persona di default) ha lavoro stimato in una sola settimana passata: in Home e La mia settimana vede le taglie, non la barra (la vede Marco).

### Componenti condivisi

- Toast non sospendibili al passaggio o al fuoco (WCAG 2.2.1); `role=status` inserito già pieno, serve una regione `aria-live` persistente.
- FilterBar: un chip aggiunto vuoto può restare bloccato; togliere un chip manda il fuoco al `body`; i periodi assoluti non si modificano.
- `DetailPanel`: la larghezza salvata non si rilegge al cambio di persona; il ritorno del fuoco è una seconda implementazione accanto a `useRestoreFocus` (serve il perché in un docblock).
- `LoadBar`: il nome accessibile perde la divisione fra i tratti; FilterBar unisce con `", "` fisso; in italiano «Chiuse» al plurale.
- Trascinare per selezionare il testo di una cella apre la task al rilascio.
- Il pannello di una task in sola lettura (Sara) sembra uguale a quello modificabile: manca un segno che i campi non si cambiano.

### Palette e routing

- `validateSearch` accetta forme di `view`/`request` che `isAppRoute` rifiuta (la Home deve controllare `view === "week"`); `brief` accettato ovunque.
- `router.tsx`: import indentato male e docblock di `HomeColumn` staccato.
- Il comando «New task» toglie `?task`/`?view` già presenti.

### Home e La mia settimana

- J/K sulla Home scorrono tutte le righe; la shape dice la sezione corrente.
- La bozza dell'editor «mine» non è filtrata per i blocchi disponibili (Irene vede New requests nell'editor).
- «What's new» elenca tutti i blocchi di reparto assenti dalla Home personale, anche quelli tolti apposta.
- «Remove block» su un filtro dato dal reparto crea in silenzio una Home personale: il toast dovrebbe dirlo.
- `ChangedLine` segna visto senza attendere; «Answered on » con codice vuoto; `aria-controls` delle schede di My tasks; ombra grezza in `EditorRow`; `NewTaskDialog` da richiesta senza permesso è un vicolo cieco.

### Tasks (elenco, board, timeline)

- `allQuery` in attesa mostra per un attimo «No tasks yet».
- Un blur durante la scelta da tastiera annulla senza annunciarlo.
- Test dello scheletro di TasksPage dipendente dall'ordine (le chiamate in volo consumano il `failNext` dopo): azzerare `failNext` in `afterEach`.
- I nomi dei traguardi nell'intestazione della timeline si leggono due volte (banda `aria-hidden`).
- Carta della board: la riga 3 aggiunge la scadenza e la ferma sale alla riga 1 (scarto dalla shape).
- Il riferimento del rifocus può restare se il fuoco va in un'area non focalizzabile; il FLIP misura tutte le carte a ogni render; niente test per animazioni e movimento ridotto.
- Esc con `stopPropagation` sull'evento sintetico può non fermare gli ascoltatori del documento (il pannello potrebbe chiudersi annullando una presa).

### Pannello della task

- Nessun test per `ClaudeSection` e per l'eliminazione da moderatore; tooltip «edited» in ISO grezzo; riga di cambio campo costruita fuori dall'i18n; un `toBeDefined` che non prova niente.
- Id di progetto segnaposto nelle query di `NewTaskDialog`; iniziali di Claude «CL» uguali a Chiara Lombardi.
- Nessuna guardia contro i giri di parent; due `relates` reciproci compaiono due volte.
- I commenti esportati appiattiscono le risposte (nessun segno di «in risposta a»).

### Planning

- Le task chiuse senza stima gonfiano «+N no estimate»; la settimana in vista non è nell'URL; l'anello di fuoco dopo un rilascio da tastiera va verificato a mano.
- Nessun test per «+N more»/«Show fewer»; il test d'errore della griglia non verifica che la vasca resti usabile.
- `lockReason` impreciso per una task non assegnata senza `tickets.edit`.
- Nella vista trasversale Claude sta nelle righe di ogni reparto, quindi le sue task in ogni vasca.
- Valori grezzi (ombra dell'overlay, `w-[240px]`, `size-[22px]`); `aria-description` poco supportato; le statistiche vanno a capo da 10 in su; `useProject("")` nella vista trasversale.
- Chiave di rifocus stantia dopo un ritorno indietro.

### Requests

- Testo del merge «no other open requests» mentre le convertite sono candidate.
- Stato dei dialoghi Convert/Merge non azzerato al cambio di persona; buchi nei test (richiesta davvero invisibile, richiedenti sovrapposti); filtri non nell'URL; un progetto con sole chiuse dice «No requests match».
- Il pannello resta in attesa per sempre se `useProjects` fallisce; confronto del codice progetto sensibile alle maiuscole (la route le alza già).

### Overview e progetti

- `StalledSection` sposta il layout al caricamento; punto di rottura del contenitore ~1248 e non 1280; un test aspetta 1 s in un layout.
- Si apre solo l'ultimo brief (manca `getBrief(id)`).
- Etichetta della soglia in sola lettura con `htmlFor` su uno `span`; le righe strette di Activity nascondono il nome del progetto; chiave di riassegnazione non controllata contro gli id tolti; scheda e filtri del portafoglio non nell'URL.

### Filtri

- Un admin che rende privato il filtro pubblico di un altro lo perde (nascondere la scelta a chi non è l'autore, o avvisare).
- La guardia di J/K non vede i popover `role=dialog` non modali (ProfileMenu).

### Residui della revisione dell'ondata finale

- Seed: Giulia (persona di default) non ha settimane passate sufficienti, quindi non vede la barra «settimana tipica» di La mia settimana; seminarle almeno 2 settimane passate con taglie.
- Seed: la descrizione del traguardo STW «Desktop prototype» dice «with fake data»: togliere la frase.
- Colonna: `column.coming.filters` e `column.coming.planning` promettono «sarà elencato qui» accanto a pagine che già esistono.
- ⌘K: i risultati di ricerca in cache non si invalidano dopo una creazione (task, richiesta).
- `createTask` non valida `departmentId` contro i reparti esistenti (le patch sì).
- `a2-tasks-list-sara.png` da solo non mostra uno stato in sola lettura.
