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
- **Suite intera instabile sotto carico** (28 ott 2026): con ~2500 test,
  una corsa su due o tre ha 1–7 fallimenti, ogni volta su test diversi e
  di aree diverse (Docs, Drive, costruttore). Lanciati da soli passano
  sempre. Probabili timeout sotto carico (92 s reali, oltre 500 s
  cumulati). Da guardare: annotare i nomi quando succede, o limitare i
  worker di vitest.

### Lavoro sul server: un progetto a parte

Il prototipo mostra l'interfaccia; il **motore sul server** non è in questa
area e non si decide qui: esecuzione durevole (coda, orologi, attese di
giorni), connettori veri (Audin, HubSpot, webhook in arrivo), invio delle
email dalla casella, passi di Claude veri sotto le tre regole
dell'anti-obiettivo, permessi `automations.manage` e invarianti dedicate in
`docs/invariants/`.
