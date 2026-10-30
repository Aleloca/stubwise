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

## Area 3 — minori aperti

Chiuso dall'area 3 (Task 11): la riga «il resto è privato» di una
conversazione pubblica stava SOPRA i messaggi invece che dopo l'ultimo
leggibile (`Conversation.tsx`, con test). I buchi di parità (voci
dell'inventario senza posto) stanno in `area3-parity.md`, «Buchi». L'elenco
per task: `.superpowers/sdd/2026-10-24-desktop-area3-claude-plan/deferred-minors.md`.

### Dati e flusso (Task 1–4)

- Seed: il test della sessione di posta (proprietario unico) è sottile; la coerenza `task.claude` è controllata solo da sessioni a task; le sessioni notturne dei Docs sono datate prima delle 02:00 di Roma.
- Stream: commento fuorviante in `stream.test.ts` (~887); `void runScript` senza catch; `patch` non vincolato (porta `id`/`at` con un cast); `chunksOf` e spazi iniziali; i timer di pausa non si cancellano al reset; una chiave scaduta mostra «live»; nessun test di un'azione che finisce durante un'interruzione.
- Intenti: una sigla dopo una preposizione («for CSV files») scavalca il progetto del contesto; due codici in un messaggio prendono il primo; un'apertura cortese + verbo dentro una domanda potrebbe proporre.
- Proposte: i testi del registro decisioni sono in inglese nel codice; `confirmProposal` ha una finestra in cui `prepareRun` può lanciare due run; una `task_run` orfana cade nel testo di `refineReply`; durante la coda privata gli aggiornamenti di proposte nella parte pubblica suggeriscono attività; una coda riconfermata chiede di riabbonarsi; `resultCodes` di una proposta pubblica può nominare una task nuova; un messaggio che nomina un progetto che `respond()` non trova viene rilasciato; un turno in corso durante `resetApi` scrive nel nuovo store; `confirmProposal` durante un turno trattenuto; il titolo si prende al momento della chiamata.

### Conversazione e destinazione (Task 5–6)

- La finestra di 120 voci scorre mentre si legge (non è virtualizzazione); «Stop» ripetuti prendono ordinali; `completeEditedProposal` accetta qualunque codice visibile (rischio di doppia creazione); «stoppedBeforeTurn» in lingua fissa; test debole sullo streaming (`startsWith`); «Edit» solo per `createTask`/`createRequest`.
- Fuoco: solo il piano ha il test «il fuoco va alla riga»; domanda e proposta no; chi ha il fuoco sul body lo perde quando un altro risolve una carta; effetto collaterale dentro l'updater di `setDrafts`.
- Una continuazione eredita il titolo dell'origine (righe identiche in Mine); tetto di lunghezza di `ask` solo nel router; manca la voce di menu Electron «New conversation»; voce di handoff orfana se la navigazione non monta mai; una conversazione vuota per primo invio fallito è raggiungibile solo dalla pagina.
- ~~Pannello laterale delle sessioni (`ObjectSide`): «Status» vuoto per STW-13 e a metà stream~~ — chiuso dal Task 12: gli stati si leggevano solo dopo la task (seconda lettura in cascata); ora col progetto della sessione, con un segnaposto mentre arrivano e senza la riga se lo stato non si sa nominare.
- ~~Dopo un cambio di persona la conversazione non scorre da sola in fondo~~ — chiuso dal Task 12: chi è in fondo ci resta a ogni disegno e quando il riquadro si accorcia; lo scatto non scorre più a mano.

### Sezione Claude della task, refinement, Decide (Task 7–9)

- Righe di PR solo testuali non si agganciano mai (restano aperte); selettore di scorrimento fragile nei test.
- Tre mutazioni duplicano `runPreconditions` in linea (solo il «relaunch» lo chiama); `requestChanges` non controlla una task chiusa; il budget fermo non è modellato (`resumeCorrection` chiede solo `corrections.request`: deviazione registrata); nessun test che la pagina della sessione parta dopo una lettura passiva.
- Refinement: il `DetailPanel` agganciato ha un `onClose` vuoto che inghiotte Esc (renderlo opzionale); il motivo in testata viene da `request.status`, non dalla fase di chiusura; «Start» su convertita/archiviata via URL; `applyRefinePatch` senza selezione dei campi a runtime; «Updated» può mostrare una scrittura rifiutata; altezza di riga fissa in `Clamped`; `dangerButton` per una chiusura non distruttiva; nessuna live region per gli aggiornamenti del lato.
- Decide: `decidePlan` con `planId` opzionale (renderlo obbligatorio); `byId ?? ''` in `PlanCard`; altri timer a livello di modulo (rinvio di Undo) potrebbero perdersi nei test; alcuni test modificano lo stato finto direttamente; TasksPage va in timeout con tre suite in parallelo (CPU).

### Activity per persona (Task 10)

- `EntryRow` duplica striscia/codice/titolo di `TaskRow` (estrarre il pezzo comune); il report conta il giorno UTC, l'activity il giorno locale; `linkCommitAuthor` controlla i commit senza la visibilità; il test del fuso effettivo non distingue UTC da un fuso negativo (asserire `resolvedOptions().timeZone`).

### Residui della revisione finale (area 3)

- Etichette delle azioni in italiano: si traduce solo il verbo iniziale («Letto the advertising kit…») perché il testo del seme è inglese.
- `confirmProposal`: le esecuzioni si aprono prima della patch della proposta; se quella fallisse (conversazione eliminata a metà), restano aperte senza copione.
- Pagina della sessione: la riga di stato e il titolo della scheda del piano dicono entrambi «in attesa» (la correzione V4 riguardava solo la sezione della task).
- Seme: l'esito delle decisioni sui piani si legge dal testo inglese (tre righe).
- Verbi d'azione sconosciuti restano come scritti.
- Contratto visivo: `seed:1d874331d6e60edc` della direzione «Catalogo numerato» non risulta a `impeccable concept-seed --check-seed` su questa macchina (eredità dell'ossatura): da verificare contro il roll originale.

## Area 4 — minori aperti

Chiuso dall'area 4 (Task 9): `useCodeCitations` ha il commento aggiornato
(R-G5, Task 8) e Shift+Esc segna tutto come letto (`ChatColumn.tsx`, Task 6).
I buchi di parità stanno in `area4-parity.md`, «Buchi». L'elenco per task:
`.superpowers/sdd/2026-10-25-desktop-area4-chat-plan/progress.md`.

### Confermato dal maintainer (24 ott 2026)

- Palette ⌘K: il titolo del gruppo «More» / «Altro» (messaggi della Chat dopo
  gli oggetti e i comandi), `i18n/locales/{en,it}.json`.
- R-G6: avvisano **solo** le menzioni dirette `@persona` (anche a chi legge il
  canale senza esserne membro); `@canale` e `@reparto` contano per il
  distintivo del canale ma non creano notifica (`data/chat/writes.ts`). Costo:
  chi non è nel canale può non vedere un `@canale`.
- Colonna della Chat: i progetti né fissati né con non letti o menzioni si
  raccolgono in una riga chiusa «Other projects · N» / «Altri progetti · N»,
  così i DM stanno sopra la piega a 1440×900.

### Residui della revisione finale (area 4)

- «Vedi come»: le cache paginate e della ricerca si invalidano solo per la
  persona corrente → tornando a una persona, un testo eliminato resta visibile
  ~150–400 ms (stesso schema delle aree 1–3).
- `editMessage` non riconsegna le menzioni: aggiungere «@Nome …?» con una
  modifica la mette in «Da decidere» ma non crea la notifica; toglierla lascia
  la notifica.
- `fold()` (senza maiuscole né accenti) è scritto quattro volte (`reads.ts`,
  `search.ts`, `BrowseChannels.tsx`, `PeoplePicker.tsx`).
- Prestazioni: `emitChat` → `presentMessage` con il `channelData` di default
  riscandisce tutti i messaggi per ogni iscritto a ogni pezzo di Claude.
- Una domanda rivolta a chi legge un canale aperto senza esserne membro gli
  arriva come menzione semplice (`chat.mention`), non come domanda: «Da
  decidere», come per le domande di @Claude, chiede di essere membro, e la
  notifica non promette una voce che non c'è. Per rispondere si entra nel
  canale (scelta del costruttore, da confermare se serve di più).

### Dati e flusso (Task 1–3)

- `data/api.ts`: un riformattamento prettier estraneo; nessun esempio seed di una risposta di Claude eliminata; il test `countsOf` rifà la logica dei non letti.
- Eventi: il testo dell'evento porta il titolo della task (rischio di fuga se arrivasse una visibilità per task); ogni pezzo di Claude riemette e notifica; `channelOfStream` accetta qualunque cosa dopo `chat:`; un post scartato dice sempre «forbidden» (motivo fuorviante); gli eventi verso canali archiviati si scartano (voluto).
- Test: il test di Roberta sull'eliminazione usa un `toThrow` nudo (stringere a `forbidden`); la risposta di Claude al chiamante conta come non letta per lui; il percorso dei 24 h è senza test in chat; gli enclitici («spiegami») non sono riconosciuti.

### Canale, thread, colonna (Task 4–6)

- Canale: la fascia «archiviato» non dice chi e quando (nessun campo nel modello); le bozze tengono solo il testo (i token scelti si perdono); la barra degli strumenti non ha roving; le reazioni disattivate non prendono il fuoco; il selettore non rende il fuoco; l'elenco `@` taglia prima di ordinare; misura di `ChatAvatar`; la pila di avatar è cambiata.
- Annunci: due conteggi consecutivi uguali non riattivano la regione viva; il lotto in attesa si perde al cambio canale.
- `#` nelle menzioni: la ricerca non è stata verificata contro un oracolo di esistenza (da rivedere).
- Thread: la sovrapposizione della task non ha velo né trappola del fuoco come il pannello del thread; la domanda di Claude parte solo da «assegna senza persona»; le domande non scadono; `requestReplyFocus` può restare in sospeso; l'apertura automatica ignora la ricerca; da verificare che ogni via di rimozione di un membro passi da `forgetMember`.
- Colonna: la conferma di «Elimina» non dice quanti messaggi (condivisa con chi gestisce senza leggere); l'atterraggio di `/chat` per Roberta non è su STW; il conteggio di «Mentions» è dei non letti mentre la vista mostra tutto; ⌥⇧ senza test; ⌘N di pagina riconosciuto da una regex di rotta (spostare il gestore di pagina in fase di cattura così `defaultPrevented` copre ogni proprietario).

### Ricerca e menzioni (Task 7–8)

- Ricerca: il clic con modificatore sui risultati viene inghiottito; `toItem` ha un'indentazione da sistemare.
- Notifiche: il titolo ripete il canale (testo del Task 2); lo scatto della domanda di @Claude non è catturato (serve una chiamata dal vivo).

## Area 5 — minori aperti

Parità e buchi: `area5-parity.md`.
Chiusa dall'area 5 (Task 9): la decisione aperta dell'area 4 sulla struttura
del Drive per gli allegati — l'allegato ha «Save to Drive»
(`pages/chat/SaveToDrive.tsx`), in un DM o in un canale generale chiede il
progetto; vedi `area4-parity.md`.

### Decisioni del controller (confermate dal maintainer il 25 ott 2026)

- **R-H1** — nel grafo «spento», «Enable» (`repos.manage`) lo accende e lo
  costruisce subito: il prototipo non ha la pagina impostazioni del repository,
  quindi un passo in meno del web.
- **R-H2** — i codici `<PRJ>-D<n>` scritti a mano restavano testo semplice
  finché non c'era il collegamento; superata dal Task 3 (ora sono collegati, e
  R-G5 vale per costruzione: una pagina invisibile non ha codice).
- **R-H3** — «Add from Google Drive» è un elenco piatto con ricerca (i file del
  seme Google non hanno cartella): niente sfoglia-cartelle quando si aggiungono
  file singoli, a differenza di quanto chiedeva lo shape.
- **R-H4** — ⌘K tiene l'ordine visivo di shape A5; la riga preselezionata è la
  prima di un oggetto esatto, altrimenti la prima azione che corrisponde al
  nome, altrimenti la prima; «More» sta per ultimo. Così Invio esegue ancora il
  comando (area 4), ma la riga evidenziata può stare sotto File/Canali/Messaggi.
- **R-H5** — una citazione di file registrata in una risposta di Claude si
  disegna uguale (tenue, solo il codice) per ogni causa per cui chi guarda non
  la vede (progetto invisibile, file nascosto, file tolto); un codice scritto a
  mano e non registrato è testo semplice (coerente con R-G5).

### Dati e modello (Task 1, 3)

- `graph.json` scaricato è un riassunto (comunità e nodi principali), non
  ogni nodo: `data/seed/`, `pages/docs/DocGraph.tsx`.
- Manca il test di `resolveCodes` per chi vede AUD senza `docs.view`:
  `data/docs/docs.test.ts`.
- `LocalProjectPermission` non ha `docs.view` (cast `as never`): `data/store.ts`.
- `slugify` di un titolo non latino dà uno slug vuoto, quindi non valido:
  `domain/docs.ts`.
- Il test «2 nuovi messaggi» di `ChannelView` è stato instabile una volta
  (tempi): `pages/chat/ChannelView.test.tsx`.

### Docs (Task 2)

- Il separatore dell'albero non risponde a Home/End e non ha `aria-valuetext`:
  `pages/docs/DocSpace.tsx`.
- `$repo` è il nome del repository ma l'unicità non è imposta:
  `data/docs/reads.ts`.
- J/K ascoltano `window` e non il fuoco, quindi dall'albero saltano nell'indice:
  `pages/docs/DocSpace.tsx`.
- Una scheda inattiva ha `aria-controls` verso un pannello non montato:
  `pages/docs/DocSpace.tsx`.
- Mancano il test dello stato di caricamento di `RepoIndex` e quello «senza
  oracolo» su un progetto invisibile con il modulo spento:
  `pages/docs/Docs.test.tsx`.

### Drive: dati e seme (Task 4–5)

- Il test del seme non asserisce `access_lost`: `data/drive/drive.test.ts`.
- I file non disponibili tengono il contenuto «pronto» (voluto, non fissato da
  un test): `data/drive/content.ts`.
- I file nascosti di una cartella restano visibili sui percorsi lato Google
  (documentato); la simulazione di `syncFolder` e dell'estrazione in corso ha
  buchi: `data/drive/writes.ts`.
- Scollegare l'account di chi ha collegato la cartella rende i file non
  disponibili per tutti, e solo lui li ripristina; un altro gestore può solo
  scollegare e ricollegare, perdendo i conteggi (i dialoghi lo dicono):
  `pages/drive/DriveBanners.tsx`, `pages/drive/GoogleAccountCard.tsx`.

### Drive: pagine e ricerca (Task 6–8)

- La vista globale non è paginata (va bene ai volumi del prototipo):
  `pages/drive/DriveList.tsx`.
- Gli URL degli oggetti si revocano solo a eliminazione e `pagehide`:
  `pages/drive/blobs.ts`.
- «Share to…» di un DM con membri ignoti mostra l'etichetta vuota:
  `pages/drive/ShareToChat.tsx`.
- Dall'anteprima aperta dalla miniatura il fuoco ricade sul pannello:
  `pages/drive/FilePreview.tsx`.
- Il `⋯` della riga è solo da mouse (nel dettaglio c'è Hide) e il menu può
  essere tagliato sulle ultime righe: `pages/drive/DriveRow.tsx`.
- La palette importa `openLinkFolder` da un modulo di pagina (strati):
  `palette/commands.ts`, `pages/drive/LinkFolderDialog.tsx`.
- I risultati della ricerca non sono a pagine da 20 (lo shape lo chiede):
  `pages/drive/DriveSearch.tsx`.
- Il flag di modulo `personaChangedWithQuery` si regge sul rimontaggio, e la
  preselezione di ⌘K salta da un'azione a un oggetto quando arrivano risultati
  freschi: `pages/drive/DriveSearch.tsx`, `palette/CommandPalette.tsx`.

### Citazioni e Claude (Task 9)

- L'anteprima di una citazione di file è un `role="tooltip"` con azioni a sola
  etichetta, mentre lo shape chiede un dialogo non modale:
  `pages/claude/conversation/citations.tsx`.
- @Claude in un canale di progetto cerca in tutti i progetti di chi chiede,
  mentre la sezione della task si limita al progetto della task:
  `data/chat/claude.ts`, `data/drive/reads.ts`.
- La ricerca per codici citati e i `citedCodes` di @Claude ignorano il Drive
  (come per i Docs): `data/chat/claude.ts`.
- Un «Ferma» che arriva quando il messaggio è già consegnato ma mentre Claude
  sta ancora scrivendo la risposta sui file, in una sessione in pausa, lascia
  che la ripresa riparta dopo lo stop (precedente all'area 5):
  `data/api-mutations.ts` (~1598).

### Dalla revisione finale (rimandati)

- **Strati**: il livello dati importa dalle pagine — `data/drive/reads.ts` e
  `data/docs/reads.ts` da `pages/chat/search` (`fold`, `searchWords`,
  `highlightParts`), il Drive anche da `pages/drive/driveFilters` —, e
  `data/chat/reads.ts` (~720) ha una sua copia di `fold`. Gli helper di testo
  e di filtro vanno spostati in `domain/`, con un solo `fold`.
- **Helper doppi**: la mappatura in `FolderLinkView` tre volte;
  `track`/`pending`/`whenIdle` due volte; `need`/`forbidden`/`notFound` due
  volte; tre estrattori di passaggio (`drivePassage` in `data/drive/reads.ts`,
  `passageOf` in `data/docs/reads.ts`, quello dei file per Claude in
  `domain/claude/intents/files.ts`). Da riunire quando si tocca la parte.

## Area 6 — minori aperti

Parità e buchi: `area6-parity.md`. Qui solo ciò che è stato **rimandato**
apposta; i minori della revisione finale dell'area si correggono con
l'ondata finale e non stanno in questo elenco.

### Rimandati (decisioni del controller)

- **Proposta fallita senza «Repropose» e stati di errore dell'originale**
  (R-I16): una proposta in stato `failed` non si può riproporre (si
  riprova solo l'analisi del messaggio), e la lettura dell'originale in un
  frame isolato non ha i suoi stati di errore (messaggio sparito, token
  scaduto, Google non disponibile): `pages/mail/MailProposalCard.tsx`,
  `pages/mail/Outcome.tsx`, `pages/mail/UntrustedHtmlFrame.tsx`.
- **Creare una serie ricorrente dall'editor** (R-I18): l'editor crea e
  sposta eventi singoli; la serie nasce solo dal seme e si configura da
  `SeriesSettings`: `pages/calendar/EventEditor.tsx`.
- **Cambio di persona con il pannello dell'evento aperto** (R-I19): il
  pannello si chiude invece di ricaricare la scheda di preparazione per chi
  guarda adesso: `pages/calendar/CalendarPage.tsx`, `MeetingPrep.tsx`.

### Minori

- Tutte le sezioni della scheda di preparazione vanno in errore insieme: la
  scheda è una sola lettura (`getMeetingPrep`), non tre:
  `data/calendar/prep.ts`, `pages/calendar/MeetingPrep.tsx`.
- Il link «In ritardo» (Overdue) della scheda porta a un elenco con una data
  d'inizio arbitraria, non a quella delle task in ritardo:
  `pages/calendar/MeetingPrep.tsx`.

### Lavoro sul server: un progetto a parte

Il prototipo mostra l'interfaccia; ciò che la regge sul server non è in
questa area e non si decide qui: classificare **tutta** la posta (senza
ammissione), leggere i Google Doc delle trascrizioni, gli scope OAuth di
invio e di scrittura del calendario, e riscrivere
`docs/invariants/mail-calendar.md` per l'ammissione senza filtro e le
proposte condivise (oggi le invarianti descrivono l'audience `mailbox_owner`
e le regole della posta del progetto, entrambe tolte qui).

## Area 7 — minori aperti

Notes e copertura: `area7-notes.md`. Qui solo ciò che è stato **rimandato**
apposta; i minori della revisione finale dell'area si correggono con
l'ondata finale e non stanno in questo elenco.

### Rimandati (decisioni del controller)

- **Casella dell'inizio «email in arrivo», allegati dal Drive, file del Drive
  come input di Claude** (R-J18): rimandati. L'inizio `mail_received` non ha
  una scelta della casella; l'email di un passo non allega file del Drive; un
  passo di Claude non legge file del Drive.
- **Niente allegati nella risposta simulata del cliente** (R-J20): la risposta
  scritta nella prova è solo testo.
- **Claude che costruisce e prova le automazioni**: è della fase sull'integrazione
  di Claude nell'app, non di questa area. Il flusso è già un documento
  dichiarativo validabile (`domain/automations/validate.ts`) apposta.
- **Deviazioni accettate dal Task 8**: il tooltip della timeline delle task è
  sempre generico («creata da un'automazione»), anche per chi vede la riga
  intera (`pages/tasks/TaskTimeline.tsx`); la scelta del progetto di
  «scegli il progetto» in «Da decidere» è un `select` semplice, non il
  selettore con ricerca dei progetti
  (`pages/home/blocks/AutomationDecisionItem.tsx`).

### Lavoro sul server: un progetto a parte

Il prototipo mostra l'interfaccia; il **motore sul server** non è in questa
area e non si decide qui: esecuzione durevole (coda, orologi, attese di
giorni), connettori veri (Audin, HubSpot, webhook in arrivo), invio delle
email dalla casella, passi di Claude veri sotto le tre regole
dell'anti-obiettivo, permessi `automations.manage` e invarianti dedicate in
`docs/invariants/`.

## Area 8a — minori aperti

Parità e copertura: `area8-parity.md`. Qui solo ciò che è stato **rimandato
apposta**; i minori della revisione finale dell'area si correggono con
l'ondata finale e non stanno in questo elenco.

### Esclusi di proposito da 8a

- **Notifica di sistema di Electron.** Il piano costruisce solo il pannello
  delle notifiche; la notifica del sistema operativo (il design la prevede
  «se il builder la aggiunge senza toccare la sicurezza del processo
  principale») non c'è. Va decisa insieme al processo principale, non in
  un'area di sola interfaccia.
- **Nuova etichetta di `prs.adopt`.** Il design cambia l'etichetta in
  «Gestire le correzioni sulle PR di altri» (la chiave resta). Il desktop
  non mostra l'etichetta dei permessi di progetto, quindi non c'è dove
  scriverla: la cambia il registro dei permessi di `@stubwise/shared` col
  backend.

### Rimandato per mancanza del dato

- **Link dal rilascio alla nota di rilascio (R-K17).** Il dettaglio di un
  rilascio non rimanda alla nota di rilascio dei Docs che lo racconta: il
  seme non lega un rilascio a una nota e nel prototipo non c'è un dato da
  cui ricavarlo. Si fa quando un rilascio sa quale nota lo contiene (col
  motore, o con un campo nel seme).

### Dalla re-review dell'ondata finale

- **Due numerazioni dopo una correzione fallita.** Nella task «Correction N»
  conta anche le correzioni fallite, «Round N of M» no (R-K8: nel tetto
  contano solo `pushed` e `running`). Dopo una fallita i due numeri
  divergono; va deciso se allinearli o spiegarlo nella UI.
- **Toast `needs_maintainer` della task senza test UI.** La regola è coperta
  a livello dati; manca il test del messaggio nella task.
- **`prCycles` conta solo le sessioni visibili.** Chi guarda senza
  `repos.view` vedrebbe meno giri di quelli che il tetto conta. Nessun
  preset del seme ha `corrections.request` senza `repos.view`, quindi oggi
  non si presenta; diventa vero col registro dei permessi del backend.
- **Titolo di «Fai sistemare».** Il dialogo mostra il titolo tradotto, la
  task nasce col titolo inglese: va scelta una lingua (quella di chi crea).

### Invarianti del CLAUDE.md da riscrivere prima del motore

Il design (sezione «Invarianti del CLAUDE.md che quest'area cambia
DELIBERATAMENTE», §1–5) le decide; quando si costruirà il motore vanno
riscritte in `CLAUDE.md` e in `docs/invariants/` **prima** del codice. Qui non
si riscrivono.

- **§1 — costruita nel prototipo (8b), da riscrivere prima del motore.**
  «Stubwise non fa deploy: il merge è il confine (fase 8)». *Cosa NON
  cambia*: per i rilasci il merge resta l'unica azione (nessun deploy,
  nessuna esecuzione di pipeline, nessun riavvio); lo stato del rilascio
  **legge** (run di CI, commit che l'agente di monitoraggio riporta, con la
  stessa regola `sameCommit` di `release.ts`), e «non ancora in produzione»
  resta un'osservazione, mai qualcosa che Stubwise potrebbe rendere vero.
  *Cosa cambia*: esiste ora **un'azione sull'ambiente**, una sola, la
  **correzione di un problema di un server**, partita da una task, con
  l'accesso SSH di correzione di quel server, avviata da chi ha
  `servers.operate` e con il piano sempre approvato prima. Gli ambienti
  (`project_environments`) smettono di essere «pura anagrafica» solo in
  questo senso: un server collegato può avere un accesso di correzione.
  *Il confine nuovo*: l'accesso di correzione non si usa per rilasciare,
  aggiornare un'immagine, fare il pull di un commit o riavviare servizi
  come passo di un rilascio; si usa per riportare il server a funzionare
  come prima, secondo la diagnosi della task. Una task di correzione server
  che «rilascia» è un piano da rifiutare; il prompt lo dice, il gate lo
  controlla. Nel prototipo: `data/servers/fix.ts`, `domain/servers/fixGate.ts`.
- **§2 — costruita nel prototipo (8b), da riscrivere prima del motore.**
  «I due divieti dell'operatore» (divieto 2). Il divieto sul **merge** resta
  identico; il divieto 2 si riscrive così: «Chi non ha `release.merge` non
  può mergiare. Un'azione su un server (l'unica: la correzione da task) ha
  **due condizioni, sempre**: chi la avvia ha `servers.operate` nel
  progetto, e il piano di Claude è **approvato prima che parta qualunque
  comando** — anche se chi l'avvia ha `plans.approve`. Non esiste la
  pre-approvazione né il «parte subito» per chi ha `plans.approve`: la
  stessa persona può approvare il piano che ha avviato, se ha
  `plans.approve`, ma deve farlo come gesto esplicito.» È un'eccezione
  **voluta** alla riga del gate di `jobs.ts` (`needsApproval =
  (!plans.approve && !planPreApproved) || requirePlanApproval`): per una
  correzione server `requirePlanApproval` è sempre vero e `planPreApproved`
  non conta. Col backend va verificato **negativamente**: senza
  `servers.operate` 403 e nessun job; con `servers.operate` e
  `plans.approve`, il job nasce fermo sul piano e nessun comando parte prima
  dell'approvazione.
- **§3** `docs/invariants/pr-corrections.md`: superata «Adottare una PR
  aperta da altri» e la frase sul ramo di una PR di una persona; «Il ciclo di
  correzione non si innesca da sé» cambia per le PR dei colleghi; un motore e
  un tetto per tutte. **Riguarda l'8a** (il prototipo già li mostra).
- **§4** Le istruzioni del server MCP per i collaboratori: niente più «di
  solito bastano tre domande», domande una alla volta finché non è chiaro
  cosa vuole il cliente; vale anche per il widget. **Riguarda l'8a**
  (Support).
- **§5** Notifiche: ogni `notification_kind` nuovo porta la regola di
  rollback e quella dei cambi additivi verso l'app; sparisce il DM Slack
  delle preferenze. **Riguarda l'8a** (catalogo degli avvisi).
- **§6 — «Nessuna escalation, e il bersaglio è protetto»
  (`docs/invariants/permissions.md`): costruita nel prototipo (9a), da
  riscrivere prima del motore.** Il design (30 ott 2026) la cambia in tre
  punti:
  - **niente `target_above`, cioè niente gerarchia**: chi ha il permesso di
    gestione (`project.members.manage`, `users.manage`, `roles.manage`,
    `departments.manage`) modifica chiunque, anche chi ha più permessi di
    lui: gli toglie permessi, gli cambia il ruolo, lo allontana. Restano il
    rifiuto su sé stessi (ruolo d'istanza, reset, disattivazione) e «resta
    sempre un full admin»;
  - **escalation solo su ciò che si dà**, e misurata sui **permessi
    effettivi** nel progetto dove il permesso arriva (ruolo, concessioni
    personali e reparto, compresi i permessi locali del prototipo), a
    livelli separati (istanza e progetto non si sostituiscono). Togliere un
    permesso non passa da `escalation`. Una funzione sola nel livello dati
    (`domain/access/escalation.ts`) per Members, People, inviti, Roles e
    Departments;
  - **ultimo gestore**: un full admin attivo conta sempre come gestore dei
    membri di ogni progetto, perché è membro implicito.
  - **conseguenza dichiarata, rischio accettato dal maintainer il 30 ott
    2026** (I3 della revisione finale del 9a): senza gerarchia, chi ha
    `users.manage` può azzerare il secondo fattore e creare il link di reset
    della password di chiunque tranne sé stesso, **compreso un full admin**.
    Scenario: Marco ha `users.manage` da un ruolo d'istanza ma non è full
    admin; azzera il secondo fattore di Roberta, crea il link di reset per
    lei, lo apre e sceglie la password; entra come Roberta (il login non
    chiede il secondo fattore, appena azzerato) ed è full admin. Sul web
    questo era chiuso da R31 («un link di reset è l'account intero»,
    `apps/server/src/routes/users.ts`). Il maintainer ha deciso «Va bene
    così»: non si corregge nel prototipo. Il motore deve riscrivere
    l'invariante dicendolo, oppure scegliere una delle due chiusure
    proposte dalla revisione (reset e azzeramento verso chi ha permessi
    d'istanza che chi agisce non ha richiedono un full admin; oppure, dopo
    un azzeramento, il login impone l'iscrizione prima di aprire la
    sessione). Lo stesso vale per `reactivatePerson`: riattivare rende
    l'account intero ed è solo `+R`, senza escalation.
- **§7 — permessi di reparto, costruiti nel prototipo (9a), da riscrivere
  prima del motore.** Un reparto può dare permessi di progetto, ma **solo
  nei progetti di cui la persona è già membro**: il permesso di reparto non
  rende membro di niente. Si legge a lettura (togliere la persona dal
  reparto toglie il permesso senza riscrivere righe) e dà `escalation` come
  ogni altro modo di dare. Il motore deve decidere lo schema (permessi per
  reparto) e come si cancella un reparto con persone dentro.
- **§8 — concessioni personali (permessi in più per membro e progetto),
  costruite nel prototipo (9a), da riscrivere prima del motore.** Sul web un
  membro ha un ruolo; qui ha il ruolo **più** permessi in più, qualunque
  permesso di progetto, purché chi lo dà lo abbia. Chi esce dal progetto
  perde le sue concessioni di quel progetto (rientrando non le ritrova); un
  cambio di ruolo azzera le revoche. Le concessioni portano l'autore («given
  by»).
- **§9 — pausa della coda di un progetto e Stato dell'istanza: costruita
  nel prototipo (9b), da riscrivere prima del motore.** Sul web non esiste;
  va scritta nell'invariante «Stubwise non fa deploy» (`CLAUDE.md`, «il
  merge è il confine») **prima** del codice, perché lo Stato dell'istanza
  aggiunge due azioni e la frase deve dire che agiscono **solo sulla coda di
  Stubwise**: nessuna riavvia, ridistribuisce o tocca un server, un ambiente
  o un processo (nel prototipo le etichette lo garantiscono anche in
  italiano: `test/noDeploy.ts`, «Rimetti in coda», mai «Riprova»). Le regole
  costruite (Task 5, `data/instance/queue.ts`, `retry.ts`, `status.ts`):
  - **cosa aspetta**: con la coda di un progetto in pausa, **ogni avvio**
    di lavoro AI di quel progetto resta fermo senza fallire (Start, Rilancia,
    Chiedi modifiche, Riprendi la correzione, la correzione e l'analisi di un
    server, i passi d'automazione che usano Claude, Retry); la sessione nasce
    «in attesa» e non accetta messaggi né «Stop and send», solo Stop. **Non**
    aspetta «Chiedi a Claude», la conversazione libera (decisione del
    maintainer del 30 ott 2026): la ferma solo il budget;
  - **cosa finisce**: il lavoro già partito prima della pausa finisce;
  - **la ripresa**: i lavori fermi ripartono nell'ordine d'arrivo, ognuno
    una volta; prima di ripartire si rilegge il blocco (se nel frattempo vale
    il budget, il lavoro resta fermo col blocco nuovo e il suo posto). Stop
    su un lavoro in attesa lo toglie dalla fila (ruling 14);
  - **Retry** solo su una **sessione `task_run` fallita** degli ultimi 7
    giorni, mai su una correzione ferma (`pr-corrections.md`) né su un
    fallito già superato da un lavoro più recente della stessa task; chiede
    `settings.manage` **e** `runs.start` nel progetto (decisione del
    maintainer del 30 ott 2026), parte a nome di chi preme e passa dal gate
    del piano come «Avvia»;
  - **Pause/Resume** chiedono `settings.manage` su un progetto visibile; una
    pausa già messa è `already_paused`; registrano chi e da quando, anche
    dopo una disattivazione («(deactivated)»).
- **§10 — lavoro fermo per budget: costruito nel prototipo (9b), da
  riscrivere prima del motore.** Decisione del maintainer del 30 ott 2026:
  un **passo d'automazione** che userebbe Claude col budget mensile esaurito
  **resta fermo** (non fallisce) e **riparte da solo** quando il budget torna
  disponibile, cioè quando chi ha `settings.manage` alza il budget sopra lo
  speso (o, nel prototipo, spegne «Simulate budget reached»). Gli altri avvii
  col budget esaurito sono rifiutati prima, in parole (`monthly_budget`), e
  il lavoro già partito finisce. Per il motore:
  - il passo fermo riparte da solo, una volta, nell'ordine d'arrivo, come
    nel prototipo (`releaseBudgetHolds`);
  - **al cambio di mese**: nel prototipo i passi fermi **non** ripartono
    (lo speso non si azzera e «Pass time» non li sblocca, ruling 15). Il
    motore deve decidere se al primo del mese ripartono da soli.
  - ⚠️ **verificato sul codice del web il 30 ott 2026, da far confermare**:
    il piano e lo shape dicono «come il `budget_held` del web», ma sul web
    un job `held` con `held_reason = "budget"` **non riparte da solo**, né
    al rialzo né al cambio di mese: resta fermo fino a un avvio a mano
    (`apps/worker/src/pipeline/job-outcomes.ts`, «avvio manuale per
    forzare»; il resume poller riaccoda solo `held_reason = "limit"`,
    `apps/worker/src/providers/limit-resume-poller.ts`). La ripartenza
    automatica del prototipo è quindi una **regola nuova**, non una parità:
    va scritta come tale nell'invariante, e il maintainer deve dire se vale
    anche per gli altri `budget_held` del web. **Confermata dal maintainer il
    31 ott 2026**: il passo riparte da solo, ed è una cosa in più rispetto al
    web che il motore dovrà fare.

## Area 8b — minori aperti

Parità e copertura: `area8-parity.md` (sezione «Server → area 8b»). Qui solo
ciò che il piano o i ruling hanno deciso **per il prototipo** e che il
maintainer deve confermare prima del motore; i minori della revisione finale
dell'area si correggono con l'ondata finale e non stanno in questo elenco.

### Scelte da far confermare

- **R-L2 — un server per repository, non per ambiente.** In un ambiente ogni
  repository dice su quale server gira (`servers: { repositoryId | null,
  serverCode, … }[]`, `null` = tutto il progetto); un rilascio legge solo il
  server della propria repository («in produzione», «Già su staging?»,
  simulazioni). Resta una sola produzione per progetto. Seme: SRV-4 è di
  `audin-admin`, SRV-3 di `audin-app`. Cambia il modello degli ambienti
  dell'8a: per il motore va deciso se è anche lo schema del DB.
- **R-L4 — «mai collegato» non è in salute.** Un server senza campioni sta in
  un gruppo a sé («Waiting for the agent»), con salute sconosciuta: né verde
  né rosso. Scelta di prodotto nata in revisione, non nello shape.
- **R-L5 — `journalctl` senza `sudo`.** `stubwise-read` entra nel gruppo
  `systemd-journal` (sola lettura del journal) e `isReadCommand` accetta per
  `journalctl` un elenco POSITIVO di opzioni (nessuna abbreviazione
  getopt_long fuori elenco). Il piano diceva `sudo journalctl`: superato.
  Da verificare su un server vero, con le distribuzioni che si supportano.
- **R-L8 — Rigenera autorizza vecchia E nuova chiave** fino alla verifica
  delle nuove; a verifica riuscita Stubwise distrugge le vecchie private (la
  pubblica vecchia rimasta sul server è innocua). Il comando successivo
  (Rigenera o Revoca) scrive solo le chiavi correnti. Alternativa scartata:
  sovrascrivere `authorized_keys` subito (ma le vecchie smettono di
  funzionare mentre il modello le dà usabili).
- **R-L9 — Claude è membro implicito di ogni progetto**, con i permessi di
  LAVORO (vedere, `tickets.create`, avviare run, lettura repo) e mai quelli
  di decisione (`plans.approve`, `release.merge`, `servers.operate`,
  `servers.ssh.manage`, `monitor.manage`, `decisions.record`, `prs.adopt`,
  gestione progetto e membri; R-L11). Continua a non ricevere avvisi (R-K5).
  Decisione del maintainer, ma è una regola di permessi del motore.
- **R-L10 — i tipi di avviso `server.*` sono accesi anche per il full admin
  non membro**: opzione additiva del tipo (`catalog.ts` intatto), consentita
  perché il full admin ha `servers.operate` implicito.
- **R-L3 — «risolto/non risolto» del controllo finale è un campo esplicito**
  del work_result `server_check`, non l'esito della sessione (una sessione
  può fallire per altro).
- **R-L6 / R-L7 — guardie del server.** `deleteServer` rifiutato (`busy`) con
  un'analisi o una correzione in corso; un server senza righe negli ambienti
  lo vede chi ha `monitor.manage` (d'istanza), così non resta orfano. La
  vista d'istanza dei server è dell'area 9.
- **Il comando ⌘K «Link SSH access»** si vede finché l'accesso non è
  verificato (e non durante la rigenerazione), anche negli stati intermedi:
  porta a completare la procedura. Era più stretto («solo non collegato»).
- **`servers.operate` solo nel seme.** La pagina Membri del progetto è
  dell'area 9: oggi nessuna UI assegna `servers.operate` né
  `servers.ssh.manage`.
- **Rifiuto del piano con approvazione spenta**: ammesso (rifiutare è
  sicuro), ma il client legge `canRejectPlan` calcolato dal livello dati, non
  lo deduce. Un piano così resta in «Waiting on me» e in Decide per chi può
  rifiutarlo, con la ragione in parole e il solo rifiuto (ondata finale, I1):
  finché aspetta tiene occupato il server (R-L6). La sessione non si chiude
  da sola alla revoca: lo shape vuole `awaiting_approval` con l'approvazione
  spenta.
- **Analisi e piano si fermano se il server lascia il progetto**: l'analisi
  finisce `stopped` senza aprire la task (nessuna «Diagnosis ready»), il piano
  si ferma con `server_gone` prima di ogni lettura. Il motore deve rifare lo
  stesso controllo prima di ogni lettura, non solo all'avvio.
- **Lo script SSH nella lingua di chi lo legge**: commenti ed `echo` di
  installazione e rimozione seguono la lingua dell'interfaccia (i comandi
  sono identici). Alternativa scartata: una lingua sola (inglese) per un
  artefatto che resta sul server. **Confermata dal maintainer il 29 ott
  2026.**

### Non fatti nell'ondata finale (con il motivo)

- **Il progetto invisibile si intuisce** («Diagnoses go to another project»,
  `onlyHere` calcolato su tutti gli ambienti): resta com'è. C'è un precedente
  nell'app («in a project you can't see» delle automazioni): né nome né link
  del progetto. **Confermato dal maintainer il 29 ott 2026** come eccezione
  accettata a R-G5.
- **`orphaned()` della pagina Ambienti** resta nel client: calcola l'effetto
  di una modifica NON ancora salvata (la bozza del dialogo) partendo da
  `onlyHere` del livello dati; spostarla nel livello dati vorrebbe una
  lettura «cosa succederebbe se», non un campo della vista.
- **Il riordino in 200 ms** c'è sull'elenco dei server, non sul riquadro Now
  del dettaglio: lì i motivi non si riordinano, compaiono e spariscono.
- **I comandi di Link, Rigenera e Revoca** restituiscono ancora lo script in
  inglese (`linkSshAccess`, `revokeSshAccess`): la UI non lo usa, legge
  sempre `getInstallCommand`/`getRemovalCommand` con la lingua.
- **«Fix stopped by» mentre le persone caricano**: il ramo che aspetta il
  nome non ha un test (le persone si rileggono da più parti del pannello e un
  errore simulato non le tiene ferme).
- **Nessun test delle invalidazioni dopo un cambio d'ambiente**
  (`ENVIRONMENT_AREAS`): servirebbe un test UI che, con la scheda del piano
  aperta, tolga il server dalla pagina Ambienti e veda Approve spegnersi.
- **Due test mai visti rossi**: chiave e comando dell'agente in `font-code`
  (`Servers.test.tsx`, scritto dopo la correzione) ed Esc col pannello della
  task (`ServerDetail.test.tsx`, verde anche senza la guardia per l'ordine dei
  listener).
- **«SRV-n · deleted»**: decide la lapide di `deleteServer` (i progetti che
  usavano il server in quel momento). Il motore deve conservarla: senza,
  nascosto e inesistente tornano distinguibili per chi il server non lo
  vedeva (R-G5).
- **Un piano di correzione non si approva da Decide** (Home): lì c'è «Open the
  task», dove i comandi sono elencati. Alternativa scartata: portare i comandi
  anche in Decide (una seconda superficie d'approvazione da tenere allineata).
- **Rifiuto di un piano bloccato** (dalla re-review dei residui): nella UI si
  rifiuta con un clic, senza indicazioni (non potrebbero produrre un piano
  diverso senza accesso usabile). Restano tre minori:
  - un rifiuto con indicazioni via API le registra comunque nel piano e nel
    registro decisioni, senza riscrivere il piano;
  - se il campo del rifiuto è già aperto quando il piano diventa bloccato,
    promette una riscrittura che non avviene (senza test);
  - il rifiuto da Decide non ha conferma né Undo (come nella scheda del piano).

### Limiti del prototipo (per scelta)

- L'analisi e la correzione sono simulate (pannello «Prototype only»): nessun
  SSH vero, nessun modello. Il motore dovrà ricontrollare in sola lettura
  ogni comando contro `isReadCommand` (lato server, non nel client).
- Le chiavi private stanno solo in `data/servers/secrets.ts`, in memoria; nel
  motore vanno cifrate a riposo e mai restituite da una lettura.

## Area 9a — minori aperti

Parità e copertura: `area9-parity.md`. Qui solo ciò che il design o i ruling
hanno deciso **per il prototipo** e che il maintainer deve confermare prima
del motore; i minori che la revisione finale chiude con l'ondata finale non
stanno in questo elenco. Le invarianti da riscrivere prima del motore (§6–§9)
stanno sotto «Invarianti del CLAUDE.md da riscrivere prima del motore».

### Scelte da far confermare

Del controller, nel design (`docs/plans/2026-10-29-desktop-area9-admin-design.md`):

- **Riconferma con finestra di grazia di 10 minuti, per persona.** Cambiare
  persona col «vedi come» non passa la finestra all'altra; tornare alla prima
  la ritrova se non è scaduta.
- **Iscrizione al volo.** Chi non ha un secondo fattore entra lo stesso (Sara
  non è bloccata al login) e lo attiva alla prima azione delicata.
- **Permessi di Claude come insieme fisso**, slegato dai preset (copiato una
  volta, confrontato da un test con l'elenco R-L9). Restano fuori
  `departments.manage`, `instance.status.view` e `changelog.view`.
- **Permessi nuovi del preset Admin:** `departments.manage`,
  `instance.status.view`, `changelog.view`.
- **`changelog.view`**, permesso d'istanza che legge tutte le voci
  d'istanza; le voci di progetto restano filtrate per i progetti visibili.
- **Il registro non si modifica né si cancella.**
- **L'istanza vuota è davvero vuota** (resta solo Claude) e si raggiunge dal
  riquadro «Prototype only» («Reset to empty instance»).
- **Una persona disattivata** non compare nel «vedi come» e non entra dal
  login.
- **L'inventario in un file** (`area9-inventory.md`) e la forma
  dell'Amministrazione (voci a sinistra, ciascuna col suo permesso).

Dai ruling del ledger durante l'area:

- **R-M1 — il registro si legge con `changelog.view`, anche per le voci di
  progetto dei progetti visibili.** Una voce di progetto è leggibile se il
  progetto è visibile **e** chi guarda ha `changelog.view`, oppure
  `project.settings.manage` / `project.members.manage`, oppure il
  `readPermission` del tipo, in quel progetto.
- **R-M2 — l'escalation si misura nel progetto dove il permesso arriva.**
  Un ruolo si confronta in ogni progetto dove è assegnato o promesso (anche
  da un invito in sospeso); un reparto in ogni progetto dei suoi membri e in
  quelli della persona aggiunta; i livelli (istanza, progetto) restano
  separati. Come `heldForProjectRole` del web.
- **Claude è un insieme fisso**, non derivato dal preset Developer: cambiare
  un ruolo non lo tocca.
- **Il blocco dopo 5 codici vale anche nella riconferma** (e la sessione non
  si chiude), non solo al login.
- **Prima attivazione del TOTP senza riconferma** (chi non ha fattori non ha
  niente da riconfermare), come `setup_allowed`.
- **`endSession` e `confirmTotp` senza riconferma:** chiudere una sessione
  riduce l'accesso; `confirmTotp` segue `startTotpSetup`, che la chiede.
- **Progetti seguiti = progetti fissati** nel binario; gli avvisi seguono le
  iscrizioni dell'8a, non questo elenco.
- **Ordine conferma in posto → riconferma** (lo shape voleva il contrario;
  costa una riconferma a vuoto in più, minore).
- **«No department» superato:** ogni task ha un reparto (ossatura), quindi
  l'opzione non si offre.
- **Reset della password vero:** il link ha una rotta
  (`/reset-password/$token`), chiude le sessioni e scade in un'ora.

### Limiti noti

- **Il runner delle automazioni dell'area 7 non avvisa il proprietario
  quando un passo fallisce** (solo `failWith`). Con la disattivazione delle
  persone il caso è più probabile: una persona fissa disattivata fa fallire
  la prova, ma nessun avviso arriva a chi possiede l'automazione.
- **Il salvataggio di nome e colore del reparto è immediato**, non fa parte
  della bozza atomica di persone, Home e permessi (che invece si salva in un
  colpo, con una sola riconferma).

### Dall'ondata finale (30 ott 2026)

Decisioni prese nell'ondata, confermate dal maintainer il 30 ott 2026:

- **Primo reparto «General».** Il primo avvio crea anche il reparto
  «General» con dentro il primo admin, e l'ultimo reparto non si elimina
  (`invalid: last_department`): ogni task ha un reparto, e una task nuova
  prende il primo di chi la crea (I1 della revisione finale).
- **Una proposta della posta che aggiunge un incaricato è un ingresso come in
  Members** (C1): stessa regola (`judgeJoin`), la riconferma di
  `admin.addMember` e la voce `member.added`. Per questo parte subito, senza
  la finestra dell'«Undo» di «Da decidere»; il rifiuto si dice sulla scheda.
- **Link di reset usato e scaduto: una frase sola** («This link doesn't work
  any more»), come la 410 del server. Un link sconosciuto, sostituito o
  dimenticato resta «isn't valid» (l'invito invece distingue «già usato», per
  il ruling I-1 del Task 6).
- **Il riquadro «Prototype only» del login ha un campo solo** per il link
  d'invito e per quello di reset (R4): il tipo lo riconosce `entryLinkOf`.
- **Il nome di chi ha dato un permesso si vede ovunque** (Minor 3 della
  revisione finale): anche «Who can?» lo mostra sempre, come Members e il
  registro, pure quando chi guarda non vede quella persona. Il resto di
  R-G5 (progetti e persone che non si vedono non esistono nelle risposte,
  nei filtri, nei conteggi) resta com'è.
- **Disattivare una persona revoca i suoi inviti in attesa** (Minor 4): come
  una revoca a mano (il link dice «revocato»), con una voce
  `invite.revoked` per invito a nome di chi disattiva; gli scaduti restano
  come sono, e riattivare non li fa tornare. Il dialogo lo dice.

Minori lasciati aperti, col motivo:

- **Seconde copie delle regole di bozza** (Minor 2 della revisione finale;
  Task 4 m2 e m-c): `setDepartmentMembers`, `setHomeManagers`,
  `setDepartmentPermissions`, `setMemberRole`, `grantMemberPermission`,
  `revokeMemberPermission` restano accanto a `saveDepartment`/`saveMember`.
  Nessuna pagina le usa, ma sono la superficie di ~50 test delle aree 2–9
  (e `useSetMemberRole` di un test di Members), con codici di rifiuto propri
  (`already_granted`, `not_granted`) che `saveMember` non ha. Farle
  delegare cambia quei codici: da decidere col motore se spariscono o
  diventano scorciatoie dei test. Il confronto del ruolo è già unico
  (`roleMissingIn`); restano la severità di `setMemberRole` su permessi già
  avuti (m-c) e l'azzeramento delle revoche senza escalation (m2, solo test).
- **«Member since» nella pagina della persona** (R7 della revisione visiva;
  Task 8): il seme non ha la data d'ingresso, e quella da inventare deve
  stare d'accordo con `instance.first_admin_created` (giorno -30), che è già
  incoerente col secondo fattore di Marco e Laura (giorni -40 e -60, Task 11
  m-2). Va deciso insieme il calendario del seme.
- **Elenco di People virtualizzato oltre 50 persone e registro oltre le
  centinaia di voci** (Task 8, Task 11 m-6): nessuna istanza del seme ci
  arriva; è lavoro del motore, con la paginazione del server.
- **«View only» su Settings per chi gestisce solo i membri** (Task 10
  Minor 2): con i preset non capita; la forma (segno sulla voce o sulle
  sezioni) va decisa col 9c, che porta le altre sezioni.
- **Comando di Claude Code «già creato»** (Task 7 Minor 2, `madeBefore`
  locale) e **`canConnect` delle caselle** (Task 7 Minor 3): servono campi
  nuovi del livello dati (un token nato dal comando, quante caselle si
  possono collegare) che il modello di oggi non distingue; la seconda
  dipende dalle 0–4 caselle dello shape, non ancora nel modello.
- **Test mai visti rossi** (Task 6: `no_second_factor` nel dialogo, blocco
  nella riconferma, Home vuota dopo il setup; Task 11 m-4: Claude e «Who
  can?»; Task 7 Minor 5 e 6): i comportamenti ci sono e i test passano;
  farli fallire apposta richiede mutazioni una per una, non fatte in
  questa ondata.
- **Parità dei non full admin in «Who can?»** (Task 2 m3; Task 11 m-5): il
  test usa `visiblePeopleFor` come oracolo della visibilità; la visibilità
  è provata altrove (i test di Sara). Resta un limite del test.
- **Coerenza del seme del registro** (Task 11): `department.updated` nel test
  di coerenza esce in silenzio se il reparto non c'è, `latest()` non copre
  una persona tolta e rimessa con voci separate, gli inviti `inv-old-*`
  esistono solo nel registro, il reset di Giorgio e il link di Davide non
  sono in `SECURITY_EVENTS`.
- **Test che scrivono `project.memberIds` a mano** (Task 1 m2): diversi test
  delle aree 2–8 lo fanno ancora; i permessi seguono le appartenenze, quindi
  quei test non provano più ciò che dicono quando «tolgono» un membro. Da
  riallineare test per test.
- **Frasi del registro all'infinito** («gave Marco Bellini start a server
  fix», Task 11 m-7): lo stile viene dallo shape; una riscrittura delle
  frasi dei permessi in forma nominale tocca tutte le pagine che le
  compongono.
- ~~**§9 dei follow-up** (Task 13 Minor 5)~~: **chiuso col 9b** (Task 14):
  §9 riscritto come «costruita nel prototipo (9b)», con le regole della
  coda, e §10 per il lavoro fermo per budget.
- **Titolo di test per «Notifiche per progetto, tipo, canale»** (Task 13
  Minor 3): il test citato copre solo «Always for you»; le notifiche sono
  dell'8a e lì hanno i loro test.
- **Dalla ri-revisione dell'ondata finale** (30 ott 2026), quattro minori
  parcheggiati:
  - con più persone aggiunte da una proposta della posta, la frase
    dell'escalation le nomina tutte, anche quelle che entrerebbero;
  - il test architetturale cerca solo `memberships.push(`: un altro modo di
    aggiungere un'appartenenza gli sfugge;
  - nessun test dell'interfaccia mostra la frase del rifiuto
    `last_department` (il livello dati è provato);
  - a 1440 la frase della barra di Members va su due righe accanto a
    Discard/Save.

## Area 9b — minori aperti

Parità e copertura: `area9-parity.md` (sezioni C ed E). Le invarianti da
riscrivere prima del motore sono §9 (coda e Stato dell'istanza) e §10
(lavoro fermo per budget), sotto «Invarianti del CLAUDE.md da riscrivere
prima del motore». Qui: le decisioni del maintainer, le scelte del
controller da far confermare (ognuna col suo costo se sbagliata), le
eccezioni dichiarate e i minori rimasti aperti dopo l'ondata finale di
correzioni (30 ott 2026): la revisione finale li ha smistati, quelli da
correggere prima del push sono chiusi e tolti da qui, e ognuno di quelli
che restano dice perché resta.

### Decisioni del maintainer (30 ott 2026)

Le quattro domande del piano:

- **L'URL del webhook in uscita si rilegge in chiaro**, come sul web: non è
  un segreto, entra nel prima/dopo del registro e cambiarlo non chiede la
  riconferma (nessun salvataggio del webhook è +R).
- **Permessi di Retry**: `settings.manage` **e** `runs.start` nel progetto;
  parte a nome di chi preme e passa dal gate del piano come «Avvia».
- **Passi fermi per budget**: un passo d'automazione col budget esaurito
  resta fermo, non fallisce, e riparte da solo quando il budget torna
  disponibile (§10, con l'avvertenza sul `budget_held` del web).
- **La pausa della coda non tocca «Chiedi a Claude»**: la conversazione
  libera la ferma solo il budget.

Le altre dello stesso giorno, già applicate: le risposte dei clienti non
escono mai col webhook; la casella «Mi fido» è obbligatoria, con la
riconferma, per registrare o aggiornare un plugin; «Queue paused by …» sta
anche nella testata del progetto e nella riga di «Tutti i progetti»; un
server creato da Amministrazione nasce senza progetto.

### Scelte del controller da far confermare

Di prodotto (cambiano ciò che una persona vede o può fare):

- **Ruling 1 — «Administration» la conta solo `git_accounts.manage`**, non
  `.view`: Sara legge Git accounts in sola lettura (il preset User dà
  `.view` a tutti) ma la voce del profilo resta «People». *Se sbagliata*:
  ogni User leggerebbe «Administration» e `People.test.tsx` diventa rosso.
- **Ruling 11 — senza un account AI libero la sessione parte con provider
  `null`**; niente `provider_limit` né attese per quota nel prototipo.
  *Se sbagliata*: manca un'attesa per quota che il maintainer potrebbe
  volere.
- **Ruling 13 — «Riprendi la correzione» segue le regole di budget e
  pausa** come gli altri avvii. *Se sbagliata*: una correzione ripartirebbe
  col budget esaurito.
- **Ruling 14 — Stop su un lavoro in attesa lo toglie dalla fila**, e alla
  ripresa parte solo ciò che è ancora in attesa. *Se sbagliata*: un lavoro
  fermato ripartirebbe alla ripresa.
- **Ruling 15 — un'esecuzione d'automazione ferma per budget resta
  `running`** con una voce «waiting», fuori da «Needs attention»; «Pass
  time» non la sblocca. *Se sbagliata*: serve un `RunStatus` nuovo e
  cambiano gli elenchi delle automazioni.
- **Ruling 16 — un worker occupato in un progetto che non si vede** dice
  solo che è occupato lì, senza l'id del lavoro (R-G5). *Se sbagliata*:
  trapelerebbe l'id di un lavoro invisibile.
- **Ruling 25 — nessuna rinomina di un provider AI** (tolta dallo shape:
  nessuna funzione rinomina). *Se sbagliata*: manca una funzione di
  rinomina che il maintainer voleva.
- **Ruling (T1) — chi gestisce un progetto legge anche le voci `queue`
  del registro** di quel progetto (R-M1 invariato). *Se sbagliata*: serve
  un'eccezione in `readable`/`readsType`.
- **Ruling (T3) — il registro salva valori stabili** (on/off, id
  d'operazione, fonte + modello, locale, importo) e li traduce a lettura.
  *Se sbagliata*: solo una mappa di traduzione in più.
- **Ruling (T4 I2) — cambiare workspace a un revisore predefinito lo
  spegne** nella stessa voce, invece di rifiutare. *Se sbagliata*: il
  maintainer preferirebbe un rifiuto `conflict`.
- **Ruling (T5 I1) — una correzione ferma compare nello Stato come riga in
  attesa**, senza Retry, con la sua frase. *Se sbagliata*: una riga in più.
- **Ruling (T5 I2) — una ripartenza che fallisce segna il lavoro come
  fallito** con la frase, visibile nello Stato; solo un `reset` passa in
  silenzio. *Se sbagliata*: un errore di programma si vede come
  fallimento invece di esplodere.
- **Ruling (T6) — tutte le parti dello shape `instance-effects`**, nessun
  taglio: righe della storia, testata della sessione, `aria-live`, registro
  dell'automazione con due blocchi, «(deactivated)», «Queue paused» anche
  col budget; una sessione in attesa non è «Claude working». *Se
  sbagliata*: solo lavoro in più.
- **Ruling (T7 I2) — con `monitor.manage` il server è un oggetto
  d'istanza**: si elencano e si aprono tutti (dettaglio, metriche,
  scritture), mentre ambienti, principale, analisi e task dei progetti
  invisibili restano filtrati («in projects you can't see»). *Se
  sbagliata*: un monitor-manager tocca server usati da progetti che non
  vede.
- **Ruling (T7 I1) — il progetto principale nel registro si salva come id**
  e si risolve a lettura; invisibile → «a project you can't see». *Se
  sbagliata*: solo una frase.
- **Ruling (T7) — «Each point averages …» calcolata dall'intervallo** (per
  esempio «about 2 hours» a 30d); il tetto `METRIC_POINTS_MAX` resta. *Se
  sbagliata*: il maintainer vuole più punti.
- **Ruling (T8) — al cambio di scheda il fuoco resta sulla scheda**
  (tablist WAI-ARIA), non va al primo controllo come dice lo shape §6. *Se
  sbagliata*: un `focus()` in più.
- **Ruling (T10) — «3 in projects you can't see»** per Sara con
  `git_accounts.manage`: il numero viene dal seme. *Se sbagliata*: si sposta
  un repository nel seme.
- **Ruling (T10) — tre frasi diverse dallo shape** (Validate, conflitto sul
  nome, slug solo se diverso), perché la UI dica il vero. *Se sbagliata*:
  tre frasi da rimettere.
- **Ruling (T10) — le mutazioni con un segreto negli argomenti hanno
  `gcTime: 0`** (account git, provider AI), come le mutazioni con segreti
  della 9a. *Se sbagliata*: costo minimo; il token resterebbe in memoria 5
  minuti.
- **Ruling (T12) — Servers ha 4 gruppi**: resta «Waiting for the agent»
  dell'8b per i server mai collegati. *Se sbagliata*: un gruppo in più
  nell'elenco.
- **Ruling (T12) — un orfano dice sempre** «Link this server to a project
  first…» nel dettaglio, non solo in difficoltà. *Se sbagliata*: una riga
  in più.
- **Ruling 18 — l'errore dello Stato dell'istanza usa «Load again» /
  «Ricarica»**, perché `noDeploy` vieta «Riprova». *Se sbagliata*:
  `expectNoDeploy` fallisce nello stato d'errore.

Tecniche (forma del codice e dei test, nessun effetto visibile): ruling 2
(il test del gate di Retry usa Marco con una concessione di
`settings.manage`, non Laura che ha `plans.approve`), 3 (seme d'istanza
senza import dei segreti; blocchi in un modulo foglia), 4 e 5 (link,
prima/dopo, gruppi e chiavi i18n dei tipi 9b nel registro), 6 e 7 (hook
`useAiBlock`/`useStorageAllowsUploads`, ri-esportati da `data/queries.ts`),
8 (`TaskWork.blocked` in `data/types.ts`), 9 (30d/90d in `RANGE_MS`), 10 (i
parametri nuovi accettati da `validateSearch`), 12 (`RunProvider` porta
l'id), 17 (`InstanceJob.code`), 19–23, 26 e 27 (spostamenti e casi dei
test), 24 (`ProvidedSecretKind`), il ruling (T13) sui 10 s già provati dal
test dell'«Avvia». Se una fosse sbagliata, il costo è un refactor locale o
un test in più.

### Eccezioni dichiarate

- **L'orologio dello Stato dell'istanza** (ruling T13 I3). «Updated
  hh:mm:ss» e «Couldn't update at …» usano l'orologio **vero** della
  finestra, non `now()` di `data/store.ts` come vuole la GC: dicono quando
  QUESTA finestra ha ricaricato, un fatto del client e non del dato, mentre
  l'adesso del prototipo è fermo e li terrebbe immobili. Il commento sta
  sul `clock` di `InstanceStatusPage.tsx`. *Se sbagliata*: si passa a
  `now()` e l'indicatore non si muove mai.
- **L'anteprima del webhook nell'istanza vuota** mostra «ACQ-42»: sono i
  dati d'esempio dichiarati («Example data»), non dati dell'istanza; il
  test dell'istanza vuota li scusa per nome (`examples`). Trovato al Task
  14.

### Minori rimasti aperti, per task

La revisione finale (30 ott 2026) li ha smistati uno per uno e li segna
tutti come rinviabili: nessuno dice il falso all'utente in un percorso
normale né tocca un Review Focus (segreti, R-G5, «(deactivated)», «Stubwise
non fa deploy»). Dove il triage ha dato un motivo più preciso, è scritto
sulla voce.

Task 1 (stato d'istanza, voci, segreti):
- `changelog/reads.ts`: `INSTANCE_OBJECTS` indicizzato con un `type`
  qualunque («constructor» risolve al prototipo); innocuo per caso.
- `ChangeEntry.tsx`: l'ultimo ramo dei link dà per scontato `server`, senza
  controllo di esaustività; un link nuovo finirebbe a Servers.
- `ChangeEntry.tsx`: il link `admin` apre la sezione e ignora l'id, salvo i
  plugin (collegati al Task 10).
- `seed/tasks.ts`, `CLAUDE_OVERRIDES`: la chiave `t-acq-3` dipende dal
  formato degli id; coperto solo in modo indiretto da un test.
- Ciclo d'import `reads → adminSections → admin/changeTypes → changelog →
  reads`: regge perché le chiamate avvengono a runtime.
- `InstanceChangeParams` è solo documentazione: `recordChange` non lo
  impone, e una voce senza `kind`/`scope` mostrerebbe la chiave grezza.

Task 2 (consumi, livello dati):
- `usage.ts`: «No project» inglese cablato nel livello dati invece di una
  chiave stabile.
- `seed/usage.ts`: i token non si riscalano col costo, e il minimo di 0,01
  sposta i totali; la tolleranza del test li assorbe.
- `seed/usage.ts`: le voci di sessione non sono filtrate a `<= NOW`; il
  test usa una data cablata.
- `spentThisMonthUsd` non ha il limite `<= now()`; innocuo senza voci
  future.
- `boundsOf` non difende un intervallo con `from > to`; non sono provati
  `from > to`, `thenBy === groupBy` e la riga «No project».
- `usage.test.ts`, «una voce per ogni sessione»: rifà il filtro
  dell'implementazione, manca il numero atteso.
- `seed/usage.ts` importa `hashOf`/`seededRandom` da `seed/servers/metrics`
  (accoppiamento a un altro dominio).

Task 3 (AI, livello dati):
- `automation.ts`: con la revisione delle PR spenta, cambiare solo il tetto
  scrive «PR review off → PR review off».
- `automation.ts`: «no auto-fix up to effort 2» si legge male.
- `deleteProvider` non toglie `simulate.nextTest[id]`; innocuo finché gli id
  non si riusano.
- `simulateNextTest` risponde `not_found` prima di `forbidden`: chi non ha
  permessi distingue un id esistente da uno inesistente.
- `budget.ts`: `contentLanguage in LANGUAGE_NAMES` è vero anche per
  «toString»; il tipo lo impedisce.
- `ai.test.ts`, «le altre scritture non chiedono la riconferma»: non copre
  `saveAutomation`, `simulateNextTest`, `simulateBudgetReached`.
- `ai.test.ts`: la banda `ok` della quota non è provata con una quota
  presente, né il bordo 79/80 %.

Task 4 (integrazioni, livello dati):
- `cleanSubdir` rifiuta solo `..`, non `.` né il backslash come il server.
- Alla prima configurazione dell'archiviazione si scrive
  `storage.secret_replaced` senza niente da sostituire.
- `google.ts`, rifiuto `in_use`: una persona con due caselle compare due
  volte; dal Task 11 la stessa regola vive nella vista e nel rifiuto.
- `webhook.ts` importa l'origine da `admin/secrets`, `plugins.ts`
  `hashOf`/`seededRandom` da `seed/servers/metrics`.
- `plugins.test.ts`, «resetApi a metà»: il controllo di generazione di
  `after()` non è esercitato da solo.

Task 5 (coda e Stato, livello dati):
- I test dell'ordine di ripartenza non lo provano con `start` asincrone: le
  `start` partono insieme, non in serie.
- Retry oltre i 7 giorni: la vista non mostra il lavoro, ma `retryJob` lo
  accetta.
- `quota[].quota` è `QuotaView | null` con `kind` ed `enabled`: contratto
  cambiato rispetto al brief, motivato dalla chiave API senza quota.

Task 6 (effetti nelle altre aree):
- Incollare un file nel composer della Chat coi caricamenti spenti lo
  ignora in silenzio; lo shape vuole la frase per 4 s.
- Drive, con la lettura dei caricamenti fallita, dice «Uploads are off»
  (falso); durante il caricamento «Upload» resta acceso. *Rinviato*: è
  contro shape EF §5, ma solo sul percorso d'errore.
- `useInstanceChanges` si iscrive una volta per ogni `useAiBlock`: in Tutti
  i progetti N ascoltatori e N invalidazioni.
- Elenco delle automazioni: la frase usa l'etichetta del tipo, non il
  numero e il nome del passo.
- `sinceText` (`components/InstanceBlock.tsx`) usa la costante `NOW` delle
  notifiche invece di `now()`: resta con l'orologio «11 h fa» (sotto, «Visti
  negli scatti finali»), una correzione di sistema sola.
- «Chiedi a Claude» col messaggio rifiutato lo tiene come «non consegnato»
  con Resend; lo shape vuole il testo di nuovo nel composer. *Rinviato*:
  è una deviazione dallo shape da far confermare al maintainer, non da
  correggere d'ufficio.
- `aiStartBlock`, `runIdentity`, `startOrHold` escono anche da `api.*`.
- `stopWaiting` su una correzione del server in attesa salta
  `stopServerFixAs`: resta una nota in memoria.
- L'annuncio «Claude started on …» scatta anche se la sessione in attesa
  viene fermata da un'altra finestra.
- Una correzione di server ferma in fila lascia la task `working`; se la
  ripartenza fallisce, la task resta `waiting` per sempre. *Rinviato*:
  percorso raro.
- Chiave i18n `taskDetail.claude.story.run_startedVia` non usata.

Task 7 (server e repository, livello dati):
- `checkType` esce nel prima/dopo come id grezzo; una soglia `null` si legge
  «none», non «Off».
- Una verifica dell'accesso scrive solo se cambia `accessState`: due esiti
  diversi dentro `verify_failed` non lasciano voce; va almeno scritto nel
  commento.
- Il test di RF 2 non prova l'assenza di AUD in tutta la riga.
- `repositories.test.ts`: un cast su `repos.view` nasconde il tipo di
  `revokeProjectPermission`.
- A 30d/90d «Response time» copre solo l'ultima settimana, senza dirlo.
- `"@hidden"` duplicato fra `reads.ts` e `ChangeEntry.tsx`.
- `searchServers` elenca tutti i server a un monitor-manager (conseguenza
  del ruling T7 I2); il codice del progetto ricade sul primo visibile.

Task 8 (AI, pagine):
- La barra delle schede scorre senza l'ombra di bordo; la sottolineatura non
  si ricalcola al cambio di lingua.
- `NextTestBox` tiene l'esito in uno stato locale: cambiare account scrive
  una simulazione, e il segmento torna a «Works» dopo una prova.
- `SimulateBox` non gestisce un rifiuto: l'interruttore resta ottimistico.
- Automation: gli errori dei costi restano finché non si salva di nuovo.
- `AddProviderDialog`: la posizione nel toast è presa dalla cache.
- La transizione di dnd-kit non va a zero con `prefers-reduced-motion`
  (anche in `ProjectStatusesSettings.tsx` e `HomeEditor.tsx`).
- `duration-[var(--duration-base)]` usa un token che non esiste
  (`ProvidersPanel.tsx`, e copiato in `GitAccountsPage.tsx`,
  `GooglePage.tsx`): l'evidenza della riga aggiunta non sfuma.
- Il `radiogroup` di `AddProviderDialog` non ha frecce né tabindex mobile.
- `<li role="group">` toglie la semantica di voce d'elenco (Models,
  Automation).
- Chiavi i18n non usate: `admin.ai.providers.turnedOn`,
  `admin.ai.automation.byType`, `admin.ai.secret.replaceOf`,
  `admin.ai.secret.saved`, `admin.ai.retry`.
- Casi non provati: riaccendere un account spento, `SecretField` con un
  `onSave` che risponde `""`.

Task 9 (Usage):
- Il codice del progetto non è in cifre tabellari separate dal nome.
- La nota `aria-live` si aggiorna anche al passaggio del mouse.
- Esc chiama `preventDefault()` anche senza una nota aperta.
- Ogni cambio di periodo torna allo scheletro e chiude le righe aperte.
- Il campo data nativo segue la lingua del browser («10/01/2026» per il 1°
  ottobre).
- `Usage.test.tsx`: un cast di `usage.view` a `LocalInstancePermission`.

Task 10 (Git accounts e Plugin, pagine):
- Il riquadro «Prototype only» di Git tiene l'esito in uno stato locale
  (lo stesso difetto di `NextTestBox`).
- Il titolo «Inventory» è `text-lg`; lo shape vuole `text-xl`.
- Frasi composte concatenando chiavi i18n (`RegisterPluginDialog`,
  `GitAccountDialog`).
- Chiavi i18n non usate: `admin.git.retry`, `admin.plugins.retry`.
- `useReadyAnnouncement` gira a ogni render (array ricreato); innocuo.

Task 11 (Google, Storage, Webhooks):
- Il test «il fuoco su un evento cambia l'anteprima» clicca l'interruttore:
  il fuoco da solo non è provato.
- Un errore di `previewWebhook` lascia lo scheletro per sempre.
  *Rinviato*: `previewWebhook` è sincrono su un id dell'elenco, oggi non ci
  si arriva.
- «Copy» di `GoogleAppDialog` dice «Copied» anche se la copia fallisce, e
  il timer non si annulla.
- `Disclosure`: `aria-controls` punta a un elemento assente a sezione
  chiusa.
- Lo stato vuoto di Google non ha il suo «Add an app».
- Storage: «Check connection» prova la configurazione salvata, e col modulo
  modificato la pagina non lo dice.
- `GOOGLE_SETUP` copia gli scope di `packages/google` senza un test che le
  leghi.
- Il fuoco non torna al «⋯» dopo un dialogo aperto da `RowMenu`
  (`GitAccountsPage`, `GooglePage`; shape §6).

Task 12 (Servers e Repositories):
- A 30d/90d il cursore del grafico mostra un'ora che il dato non dimostra.
- Le soglie di posizione dell'etichetta (0,8 e 0,9) non hanno un nome, e un
  solo test le prova.
- `RepositoriesAdminPage`: un cast `as "/"` spegne le rotte tipate.
- Col filtro attivo il conteggio del gruppo non è più il totale del
  progetto.
- La «×» nativa del campo di ricerca ha il colore del browser (anche in
  People).
- A 1024 i codici dei progetti ripetono quelli della riga degli ambienti:
  lo shape lo chiede, va fatto vedere al maintainer.
- ⌘K non trova un server orfano: `searchServers` lo scarta se manca un
  progetto da cui aprirlo; per chi ha `monitor.manage` potrebbe aprirlo su
  `/admin/servers/SRV-n`.

Task 13 (Stato dell'istanza):
- Il dialogo di Pausa può dire «Queue paused by » finché le persone non
  arrivano.
- `ageWords` passa a «yesterday» dopo la mezzanotte UTC anche dopo un'ora.
- `aria-live` non annuncia una coda nuova né un messaggio uguale al
  precedente.
- Chiavi i18n `placeholder.admin.*` senza lettori, da togliere.
- I test non seguono il link del toast di Retry, e non c'è un test per
  «Show 50 more».
- Stato d'errore: «Ricarica» sta più in basso della riga di testo.
- Il test del fuoco dopo Retry non è mai stato visto rosso da solo; i casi
  «nightly» e «accounts» dell'istanza vuota non sono stati provati con una
  mutazione.

Visti negli scatti finali (Task 14):
- La task di STW «In attesa: coda in pausa» dice «11 h fa» accanto a una
  sessione appena avviata. **Causa** (revisione finale, M1): non la
  cattura, ma due «adesso» nel prototipo. `relativeTime`
  (`notifications/time.ts`) e `sinceText` (`components/InstanceBlock.tsx`)
  misurano contro la costante `NOW` = `TODAY T23:00Z`, mentre il livello
  dati scrive i tempi con `now()` = `TODAY T12:00Z` (`data/store.ts`): la
  differenza è sempre di 11 h, deterministica. C'era già prima del 9b per
  ogni sessione avviata nell'app; il 9b ha aggiunto un secondo lettore di
  `NOW`. *Resta aperto perché* è di sistema: serve un solo «adesso»
  (`relativeTime` e `sinceText` con un riferimento dal dato, come
  `refreshedAt` dello Stato, oppure `NOW` allineata a `now()`), e tocca
  ogni pagina che dice un'età — fuori dal perimetro di un giro di
  correzioni del 9b.

Lasciati aperti dall'ondata finale (revisione finale e Impeccable), col
perché:
- Due formattatori d'età con due riferimenti: `ageWords` dello Stato su
  `refreshedAt`, `relativeTime` su `NOW` (M5). *Perché*: si chiude con
  l'orologio unico qui sopra.
- La riga dei consumi di rete a 30d e 90d dice ancora «peak» sul massimo
  delle medie; CPU, memoria, disco e carico dicono «highest N-hour
  average» (Impeccable 4). *Perché*: la rete non ha un episodio che la
  smentisca, e la frase a due valori (in/out) va riscritta a parte.
- Il picco dei grafici a 30d/90d è il massimo delle medie, non dei
  campioni grezzi: l'ondata ha scelto la frase onesta, non il calcolo sui
  grezzi (l'altra strada di Impeccable 4). *Perché*: il livello dati
  dovrebbe portare un picco grezzo per metrica; da decidere col motore.
- Le righe meta di Git accounts e Google usano ancora `Dot` in un
  `flex-wrap`, non `MetaLine`: i loro pezzi (i codici dei progetti, il
  client ID) possono essere lunghi, e `MetaLine` non spezza un pezzo. Negli
  scatti a 1024 non va a capo nessuna. *Perché*: serve un pezzo che possa
  andare a capo dentro di sé, non solo il primo.
- Un'analisi di server non partita per il budget non riparte quando il
  budget torna (`analysisBlocked`): il riquadro lo dice finché l'episodio
  è aperto. *Perché*: è il comportamento dello shape EF (l'analisi non è
  un passo d'automazione), da confermare col motore.
