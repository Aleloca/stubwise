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
- **§11 — progetti archiviati ed eliminati, repository senza progetto:
  costruita nel prototipo (9c), da riscrivere prima del motore.** Va
  scritta in `docs/invariants/permissions.md` **prima** del codice: «Un
  progetto invisibile risponde 404 `not_found`, come uno che non esiste»
  resta, e le si aggiunge l'archiviato. La regola costruita (Task 5, 11 e
  12; `data/projectSettings/archive.ts`, `purge.ts`,
  `data/instance/repositories.ts`, `archivedProjectIdsFor` in
  `data/store.ts`):
  - **un progetto archiviato è invisibile come uno inesistente** (R-G5):
    niente nome né codice in liste, ⌘K, notifiche, «Who can?», Stato
    dell'istanza, Usage, Servers, registro; **tranne ai suoi membri e ai
    full admin, in sola lettura**: lo ritrovano in All projects → Archived
    e nella sua pagina (`/archived/<CODE>`), con Reopen per chi ha
    `project.settings.manage` lì. Claude no, anche se è fra i membri.
    Precisazioni decise durante l'area: gli ex membri e i full admin leggono
    sulla sua pagina i nomi dei membri e di chi ha archiviato anche se
    quelle persone non si vedono altrove (ruling T5); il registro dà loro
    l'archiviato nel filtro con «(archived)» e le sue voci, chi non ne era
    membro non le legge (P21);
  - **archiviare** non ferma il lavoro: un lavoro vivo lo rende `busy`, e
    il titolo d'una sessione che chi archivia non vede non esce (P23); le
    esecuzioni d'automazione aperte si annullano con «Project archived» e
    non contano come `busy` (decisione del maintainer, 31 ott 2026);
  - **l'eliminazione è del solo full admin e solo da archiviato**, col
    codice esatto e la riconferma; dopo, nessuna riga dello stato nomina
    il progetto tranne il registro, l'elenco degli eliminati e la
    provenienza dei repository; i consumi restano nel budget del mese e si
    leggono «Other projects» (ruling T5);
  - **i repository di un progetto eliminato restano senza progetto**, nel
    gruppo «Not in any project» di Amministrazione → Repositories; **si
    collegano a un altro progetto con `repos.manage` nel progetto di
    destinazione, o da full admin** (voce `repository.linked`, che non
    nomina la provenienza); **dicono da dove vengono solo agli ex membri e
    ai full admin**, e a chi non la sa si mostra solo l'ultimo segmento del
    nome completo, perché il workspace può nominare il cliente (ruling
    T11);
  - **un repository senza progetto lo elimina solo il full admin, con la
    riconferma** (decisione del maintainer del 31 ott 2026, [AR 9] (b)): la
    voce `repository.deleted` non dice la provenienza a chi non la vede, e
    l'account git smette di contarlo «in uso».

  **Per il motore**: sul web un repository ha sempre un progetto
  (`repositories.project_id` obbligatorio); il motore deve renderlo
  facoltativo, e decidere dove sta la provenienza (nel prototipo
  `detachedRepositories[].formerProjectId`, mai restituito: si legge solo
  il codice, e solo da chi lo sa).
- **§12 — gli strumenti del riquadro: costruita nel prototipo (10a), da
  riscrivere prima del motore**, accanto a `docs/invariants/permissions.md`.
  «Gli strumenti del riquadro girano con la sessione della persona, lato
  server; `via: "claude"` lo mette il server sullo strumento chiamato, mai
  il client; la classe la calcola il server sui dati del momento e il
  client la legge.» Nel prototipo:
  - ogni voce del catalogo (`data/claude/catalog.ts`) chiama la forma
    `…As(me, …)` della scrittura pubblica, con gli stessi permessi, la
    stessa riconferma e la stessa voce del registro (prova:
    `data/claude/syncWrites.test.ts`, pubblica e `…As` sullo stesso stato);
  - il segno lo scrive solo `runAsClaude` (`data/claude/via.ts`), e nessuna
    funzione di `data/api.ts` accetta un parametro di tipo `ViaClaude`
    (`via.test.ts`, «nessuna funzione esportata da data/api.ts ha un
    parametro col segno»): sul server una richiesta che arriva col segno da
    un client si ignora;
  - la classe (`data/claude/classes.ts`) ha due soli criteri *(maintainer)*:
    avvisa qualcuno oltre a chi chiede, o fa partire un'automazione; parte
    dalla classe dichiarata e non scende mai; la C viene solo da
    `REAUTH_REQUIRED`. Si ricalcola alla conferma: se è salita nel
    frattempo, la scheda lo dice prima di eseguire (`classRaised`). Come
    `canMerge`, il client la legge e non la deduce;
  - un gruppo è tutto o niente: un fallimento ripristina lo stato (compresi
    registro, decisioni e task eliminate) e non lascia avvisi né esecuzioni
    d'automazione partite (i segnali sono trattenuti fino al gruppo
    riuscito, ruling 5). Fuori dal ripristino restano gli effetti già fuori
    dallo stato (timer, `releaseBudgetHolds`, eventi di Chat asincroni): il
    motore li deve mettere dentro la transazione o dopo il commit.
- **§13 — «Annulla»: costruita nel prototipo (10a), da riscrivere prima del
  motore**, accanto a «Un commento eliminato non ha più testo». «"Annulla" è
  uno strumento a sé: l'inverso come azione nuova, solo di chi l'ha
  chiesta, solo se nessuno ha scritto sull'oggetto dopo; "Annullato da" si
  deriva a lettura.» Nel prototipo (`data/claude/actions.ts`,
  `undoClaudeActions`, `undoViewOf`):
  - l'inverso ripassa dalla `…As` con i permessi del momento: un permesso
    perso dà `forbidden` col suo «Who?», una C dà `reauth_required`;
  - «com'era» è un confronto per **scritture**, non per versioni *(scelta
    del costruttore)*: c'è una scrittura dopo l'azione (per `seq`, mai per
    `at`, ruling 4) fuori dal gruppo, e si rifiuta con `changed_after` e il
    nome di chi ha scritto se chi chiede lo vede. Aprire o leggere non
    conta;
  - un «Annulla» di più azioni è tutto o niente come il gruppo;
  - la voce dell'inversa porta `undoOf` verso quella annullata, e chi la
    legge senza leggere l'annullata non vede «Undid:»; la creazione di una
    task, che non ha una voce, annullata scrive `task.deleted` col segno ma
    senza `undoOf` (ruling T5);
  - **un «Annulla» che avviserebbe qualcuno o farebbe partire
    un'automazione non parte da solo** (ruling del controller sull'I1 della
    revisione finale, 2 nov 2026): la classe degli inversi si calcola con
    `classOf` sui dati di adesso, e con un motivo `notifies` o
    `automation` nasce una scheda B (o più alta, mai più bassa) coi motivi,
    `undoOf` sul gruppo, confermata come le altre; la riga dice «Confirm
    below to undo» finché la scheda è aperta, un secondo clic la ritrova.
    La conferma rilegge le regole di «Annulla» e lascia uscire gli avvisi
    che la scheda ha detto (`announce` nel segno). Vale per ogni inverso,
    non solo per riapri/chiudi (`undo.test.ts`, «riapri → «Annulla» con
    un'automazione su `task_closed`»);
  - dentro un «Annulla» che parte da solo non parte nessuna notifica:
    quella di prima si legge «Undone by …», derivato a lettura, mai scritto
    nell'evento (stessa dottrina di «I campi che un client legge su una
    card di inbox si DERIVANO A LETTURA»);
  - non si annulla ciò che fa partire lavoro, distrugge o si rimetterebbe
    solo con la riconferma: `registerPlugin`, `updatePluginRef`,
    `rerunSmoke`, `removePlugin`, `retryJob`, `startRun`, `deleteTask`,
    `deleteComment`, `deleteMilestone`, `convertRequest`, `createRequest`
    (`undoable: false` in `data/claude/catalog.ts`);
  - fuori dal confronto, per ora: modifica ed eliminazione di commenti
    esistenti, sessioni `task_run` aperte da `servers/fix.ts`, refine e
    intake sulle richieste, sistemazioni dei giorni di altri. Il motore deve
    decidere se contano come scritture.
- **§14 — «Cosa Claude non fa»: costruita nel prototipo (10a), da scrivere
  prima del motore** in `docs/invariants/`, con un test sul **sorgente**
  dello stesso schema di `apps/server/src/services/decisions-never-ai.test.ts`.
  Nel prototipo è `data/claude/neverInCatalog.test.ts`: il catalogo e gli
  intenti non hanno un **riferimento di codice** (chiamata, import, accesso)
  a merge, deploy, approvare o rifiutare un piano, rispondere al posto della
  persona, registrare una decisione, scritture di segreti, verifiche e
  `simulate…` (ruling 11: parole e commenti non contano, un nome composto a
  runtime e un riferimento dentro una regex letterale con `//` o apostrofi
  sfuggono, ed è dichiarato nell'intestazione del test). Le richieste
  vietate diventano una riga D che porta al posto vero
  (`domain/claude/intents/refused.ts`), mai un controllo che lo faccia: il
  deploy non ha nemmeno il link. Vale anche per la riga D del piano
  («Approving or rejecting a plan is yours to do.» col link «Open the plan
  of **AUD-4** →»): il gate di `jobs.ts` resta l'unico punto in cui si
  approva.
- **§15 — eliminare una task: costruita nel prototipo (10a), da scrivere
  prima del motore** in `docs/invariants/`. Sul web oggi non c'è: nessuna
  rotta elimina un ticket. Nel prototipo (`data/taskDelete.ts`; decisione
  del maintainer del 2 nov 2026):
  - chi elimina: chi ha `tickets.moderate` nel progetto, o l'autore con
    `tickets.edit`; Claude collega no, se non l'ha creata lui (P24);
  - si rifiuta (`busy`, con le ragioni) se c'è lavoro vivo: una sessione di
    Claude non finita (anche in attesa), una PR aperta (anche della pipeline
    senza numero, ruling T2), una correzione di server o di rilascio aperta;
  - **figlie**: restano, senza madre; **collegamenti**: si tolgono da
    entrambe le parti; vanno via attività, accordi della giornata e domande
    della task;
  - **il codice non si riusa mai**: la task successiva prende max+1 contando
    anche le eliminate (`deletedTasks`); il codice eliminato si legge come
    uno inesistente in ricerca, ⌘K, citazioni e Chat (R-G5);
  - **traccia**: la voce `task.deleted` (leggibile da chi gestisce il
    progetto e da chi modera), `task_deleted` nella storia del progetto, la
    rassegna che la conta; la richiesta d'origine dice «Task X was
    deleted», la notifica resta con `objectGone` e non apre niente,
    l'effetto d'automazione dice «task deleted»: tutto derivato a lettura,
    mai salvato;
  - nessun «Annulla», né a mano né da Claude: la scheda di Claude è B col
    Confirm rosso e «Can't be undone».
- **§16 — le bozze di Claude: costruita nel prototipo (10b), da scrivere
  prima del motore** in `docs/invariants/`, accanto a «I campi che un
  client legge su una card di inbox si derivano a lettura». **Le bozze di
  Claude vanno solo in un campo dichiarato della pagina aperta (risposta di
  supporto, note di rilascio, corpo dell'email nella propria casella,
  descrizione di una task), non si salvano né si inviano da sole, e il
  segno resta finché il testo è quello di Claude** *(maintainer, D1, 2 nov
  2026)*. Nel prototipo (`layout/claudePanel/fillable.ts`,
  `data/claude/drafts.ts`): un campo esiste finché la sua pagina è montata e
  lo dichiara la pagina, mai il livello dati; la Chat non è un campo; il
  testo di un'email resta una bozza (inviare è un gesto della persona, classe
  D) e la descrizione scritta nel campo è classe A, una modifica solo quando
  la persona salva. Il corpo di un'email lo legge solo il proprietario della
  casella (`mailbox_owner`), nemmeno chi vede la conversazione; chi non vede
  l'oggetto del campo legge una riga senza codice né testo (R-G5).
- **§17 — le automazioni scritte da Claude: costruita nel prototipo (10b),
  da scrivere prima del motore** in `docs/invariants/`. **Un'automazione
  scritta da Claude nasce spenta e senza proprietario; la prova di Claude
  non ha effetti e non approva; accendere è un gesto della persona.** Il
  test è sul **sorgente**, come §14: `data/claude/neverInCatalog.test.ts`
  (con `domain/automations/draftFlow.ts` fra i file guardati, ruling T5 I4;
  la prova sta in `data/claude/trial.ts`, che lo stesso glob legge)
  verifica che il catalogo, gli intenti e il flusso della bozza non
  abbiano un riferimento di codice a `activate`, `publish`, `decidePlan`,
  `sendDraft` e alle altre funzioni vietate; `createAutomation` forza `status:
  "draft"` e `ownerId: null` qualunque cosa dicano gli argomenti, e rifiuta
  `projectId: null`. «Created by Claude on behalf of …» resta anche dopo
  l'accensione *(maintainer, [AU 8])*.
- **§18 — le risposte sui dati non contano né sommano l'invisibile: costruita
  nel prototipo (10b), da scrivere prima del motore** in `docs/invariants/`.
  **Le risposte sui dati non contano né sommano l'invisibile**: la spesa
  d'istanza solo con `usage.view` (senza, la somma dei progetti che chi
  chiede vede, nessun totale), «e altri N» sui soli progetti visibili, il
  motivo di un rifiuto senza nomi invisibili (S2, S3, S4 e le note «On N of
  these you can't archive», con `codes` facoltativo e solo codici visibili).
  Un progetto che chi chiede non vede risponde come uno che non esiste.
  Il motore lo calcola sul server nella WHERE, prima del conteggio, come per
  gli elenchi di `docs/invariants/permissions.md`; i test R-G5 non
  distinguono maiuscole e minuscole.

- **§19 — il corpo di una pagina di prodotto: costruita nel prototipo
  (11a), da scrivere prima del motore** in `docs/invariants/`, accanto a «Un
  commento eliminato non ha più testo, in nessun posto».
  **Il corpo di una pagina di prodotto è un documento a blocchi con id
  stabili che non si riusano mai; ogni ancora (commento, presenza, segno)
  sta su un id di blocco o di cella; unendo due blocchi le ancore del
  secondo passano al blocco unito, un'ancora cancellata si dice «Frase
  eliminata»; il testo di una frase è testo più segni a intervalli, e un
  link è solo http(s)** *(maintainer, 5 nov 2026, Q2 e Q3)*. Nel prototipo
  (`domain/productDocs/blocks.ts`, `richText.ts`; `data/productDocs/writes.ts`):
  - un id di blocco non si riusa, né nella stessa pagina né in un'altra:
    `insert` con un id già usato o già eliminato dà `invalid: block_id_taken`.
    **Eccezione unica e dichiarata**: ⌘Z di una cancellazione nella stessa
    sessione dell'editor rimette il blocco con lo STESSO id (ruling del
    controller, 5 nov 2026), perché i suoi commenti tornino; la memoria è per
    sessione (`productSessionDeletes`), e «gli id non si riusano» vale per
    blocchi **diversi**;
  - l'**unione** è un'operazione (`merge`), e `mergedFrom` nasce SOLO da lì:
    da due array non si distingue un'unione da «elimina e riscrivi». I
    commenti del secondo blocco passano al blocco unito (`onAnchorsMerged`);
    se invece qualcuno cancella a mano, i fili dicono «Frase eliminata» e
    non sono ricostruibili. Una scrittura contiene al più un `merge`;
  - il testo di una frase è `RichText` (testo più intervalli di grassetto,
    corsivo e link), **mai HTML salvato**; un link è accettato solo se
    `safeLinkHref` lo dà per http(s), e la stessa regola vale per un link
    scritto da Claude. Una regola copiata in due posti (renderer e processo
    principale) ha una sola tabella di casi nei test; sul server ne serve una
    terza (`area11-parity.md`);
  - l'ancora di un commento è un id di blocco **o di cella**; chi la legge
    deriva `anchorGone` dal documento di adesso, non lo salva;
  - la ricerca legge il testo senza segni: l'indirizzo di un link non si
    trova.
- **§20 — l'app desktop esce dal renderer verso il disco solo dal canale
  `file:save`: costruita nel prototipo (11a), da scrivere prima del motore**
  in `docs/invariants/`. **L'app desktop esce dal renderer verso il disco
  solo dal canale `file:save`, validato nel processo principale; il percorso
  scelto non torna al renderer** *(decisione 8 della spec)*. Nel prototipo
  (`src/main/security.ts`, `index.ts`, `src/preload/index.ts`):
  - il canale è UNO (`main/main.test.ts` verifica sul sorgente che i canali
    nominati da main e preload siano `file:save`, `menu:*` e `theme:changed`,
    e nessun altro): un canale in più è una decisione, non un dettaglio;
  - il frame mittente si controlla PRIMA di leggere gli argomenti
    (`isNavigationAllowed`), e la richiesta si valida subito dopo
    (`parseSaveFileRequest`: formato, nome ≤ 120 senza caratteri di
    controllo, nessun campo in più, `data` solo per il Word, firma zip,
    tetto 25 MB);
  - si scrive SOLO dove la persona sceglie nella finestra di salvataggio
    (`showSaveDialog`); il renderer riceve `{saved}` o un motivo, mai il
    percorso; il PDF lo stampa il processo principale (`printToPDF`).
- **§21 — rinviata al 11b** *(P34, 5 nov 2026)*. La decisione 1 della spec
  (l'apertura di email e riunioni private nella doc, accanto
  all'invariante `mailbox_owner`) la scrive il piano 11b **prima del
  motore**: il 11a non legge né cita posta o riunioni, quindi non c'è
  nulla da scrivere ora. Se il 11b non parte, la nota resta qui come
  promemoria che quella regola manca.

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
- ~~**«View only» su Settings per chi gestisce solo i membri** (Task 10
  Minor 2)~~: **chiuso col 9c** (Task 7). Decisione del maintainer sugli
  shape del 31 ott 2026, [PS 3] (a): il segno sta su «Settings» se tutto è
  in sola lettura, sulle voci rientrate se è misto (il caso di chi gestisce
  solo i membri), e la riga ○ sta sempre in testa alla sezione
  (`pages/settings/ViewOnly.tsx`; test in `GeneralAiAutomations.test.tsx`,
  «chi ha il solo project.members.manage: il segno sulle voci in sola
  lettura, non su Members né su Settings»).
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
- ~~`sinceText` (`components/InstanceBlock.tsx`) usa la costante `NOW` delle
  notifiche invece di `now()`: resta con l'orologio «11 h fa» (sotto, «Visti
  negli scatti finali»), una correzione di sistema sola.~~ — chiuso
  dall'orologio unico: `sinceText` misura su `now()` (vedi la voce «11 h fa»
  qui sotto).
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
- ~~La task di STW «In attesa: coda in pausa» dice «11 h fa» accanto a una
  sessione appena avviata.~~ **Causa** (revisione finale, M1): non la
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
  correzioni del 9b. — chiuso dall'orologio unico: la costante `NOW` delle
  notifiche non c'è più, e ogni età o «quando» delle superfici misura su
  `now()` del livello dati (`relativeTime`, `sinceText`, l'ora della
  conversazione, il Drive, il rimando delle notifiche). L'adesso di
  partenza è `CLOCK_START` (`seed/dates.ts`, mezzogiorno di `TODAY`), da cui
  partono `now()` e i tempi del seme che dicono un'età: le notifiche si
  scrivono «N ore» prima di lì, le ultime attività di oggi stanno prima di
  mezzogiorno, e il registro della sicurezza segue le sue notifiche. Lo
  fissano `data/architecture.clock.test.ts` (formattatori su `now()`,
  nessuna superficie con un suo «adesso», seme mai nel futuro) e la
  sezione Claude («Just now» su una sessione appena avviata). Resta fuori,
  deciso (ruling T13 I3): «Updated hh:mm:ss» e «Couldn't update at…» dello
  Stato, sull'orologio vero della finestra. Gli scatti d'archivio con età
  delle notifiche (`notifications-open*`, `t8-notif-*`, le Home `a2-home-*`,
  `a3-home-decide-*`, `a6-home-*`) precedono l'orologio unico e non sono
  stati rifatti: le età vi sono di un'ora in più, alcune oggi invece di
  «Yesterday»; il layout non cambia. Nella revisione dell'orologio unico
  (Minor 2) anche `grantedAt` (`data/viewer.ts`), l'unica altra scrittura a
  runtime con un suo mezzogiorno, è passata a `now()`.

Lasciati aperti dall'ondata finale (revisione finale e Impeccable), col
perché:
- ~~Due formattatori d'età con due riferimenti: `ageWords` dello Stato su
  `refreshedAt`, `relativeTime` su `NOW` (M5). *Perché*: si chiude con
  l'orologio unico qui sopra.~~ — chiuso dall'orologio unico: `relativeTime`
  misura su `now()`, e `refreshedAt` è `now()` letto con la vista (la stessa
  lettura dei lavori che misura), quindi l'orologio è uno.
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

Lasciati aperti dalla revisione dell'orologio unico, col perché:
- Àncore del seme che ripetono il valore di `CLOCK_START` invece di
  importarlo: `NOW` in `seed/usage.ts` e `NOW_MS` in
  `seed/servers/metrics.ts` (Minor 3). *Perché*: sono calcolate una volta
  sola e devono restare ferme anche dopo «Fai passare il tempo», quindi oggi
  dicono il vero; il difetto è solo la copia del valore, una riga per file
  quando si tocca il seme (con la voce sui consumi `<= NOW`).
- La guardia di `data/architecture.clock.test.ts` vede solo `…NOW` e
  `${TODAY}T<ora>`: un adesso scritto come `${daysFromToday(0)}T15:00:00Z`
  o come stringa letterale le sfugge (Minor 5). *Perché*: per un prototipo
  basta così; il limite è scritto nel commento del test.

## Area 9c — minori aperti

Parità e copertura: `area9-parity.md` (sezione D, e la riga «Tutti i
repository» della sezione E). L'invariante da riscrivere prima del motore
è §11 (progetti archiviati ed eliminati, repository senza progetto), sotto
«Invarianti del CLAUDE.md da riscrivere prima del motore». Qui: le decisioni
del maintainer, le scelte del controller da far confermare (ognuna col suo
costo se sbagliata), le frasi nuove fuori dagli shape e i minori rimandati
dalle revisioni dei Task 1–12 (31 ott 2026), che la revisione finale del
branch smisterà.

### Decisioni del maintainer (31 ott 2026)

Le quattro domande del piano:

- **Cosa si apre di un progetto archiviato → (a)**: una pagina sua, in sola
  lettura, con sintesi, membri, conteggi, Reopen e Delete.
- **I repository di un progetto eliminato → (b)**: restano senza progetto,
  nel gruppo «Not in any project» di Amministrazione → Repositories; si
  collegano a un altro progetto con `repos.manage` nel progetto di
  destinazione, o da full admin; il dialogo di Delete li conta, e il
  collegamento scrive `repository.linked`; da dove vengono lo leggono solo
  gli ex membri e il full admin.
- **Effetti di report giornaliero e discovery backlog → (a)**: report
  spento, la riga dice «off» e «Generate report» a mano resta; discovery
  spenta, spegne il pulse e nient'altro.
- **Le automazioni aperte quando si archivia → (a)**: si annullano con la
  nota «Project archived» e non rendono il progetto `busy`.

Le quattro domande degli shape:

- **«View only» → (a)** ([PS 3]): segno su «Settings» se tutto è in sola
  lettura, sulle voci rientrate se è misto, sempre la riga in testa alla
  sezione.
- **Conflitto dei plugin → (a)** ([PG 5]): la bozza resta, con «Keep my
  changes on theirs» e «Use theirs».
- **Automazione generale verso un progetto archiviato → (a)** ([PX 5]):
  l'esecuzione finisce non riuscita, in «Needs attention».
- **Un repository senza progetto si elimina → (b)** ([AR 9]): solo il full
  admin, da Amministrazione → Repositories, con conferma in rosso, la
  riconferma e la voce `repository.deleted` senza provenienza per chi non la
  vede; l'account git smette di contarlo «in uso».

### Decisioni del controller da confermare

Del controller, lo stesso giorno delle decisioni del maintainer:

- **Il seme di STW ha l'ambiente `test`, quello di ACQ il repository
  `portale-utenti`** (`not_configured`). *Se sbagliata*: solo il seme, e i
  test e gli scatti che lo leggono.
- **Il plugin base `stubwise` in ogni progetto**, sempre acceso, fuori dal
  registro e dalle scelte. *Se sbagliata*: «/» e le sessioni di un progetto
  hanno `/stubwise:*` dove il maintainer non lo voleva; una riga in
  `skillsForRun`.
- **`access.integration.canEdit` = `project.settings.manage` o
  `repos.manage`**: chi gestisce i repository rigenera anche la chiave
  d'ingestione. *Se sbagliata*: un permesso in più a chi ha solo
  `repos.manage`; una riga in `adminSections.ts`.
- **`getArchivePreview` con `openAutomationRuns`**: il dialogo d'archivio
  conta le esecuzioni che si annulleranno. *Se sbagliata*: una riga in meno
  nel dialogo.
- **«Save as file…» della guida SDK**, un `.md` con lo stesso testo di
  «Copy guide». *Se sbagliata*: un bottone in più.
- **`/p/<CODE>/settings` apre General** ([PS 2]). *Se sbagliata*: il
  maintainer voleva un'altra sezione d'arrivo; una costante.

Dal pre-flight del piano (P1–P29), di prodotto (cambiano ciò che una
persona vede o può fare):

- **P3 — il seme spegne superpowers (tutte le skill e gli hook) nei progetti
  dove oggi non c'era.** *Se sbagliata*: «/» e i run di marketing, client e
  ZNC cambiano; si riscrive il seme delle scelte.
- **P8 — i test che si aspettavano SRV-5 passano a SRV-6/SRV-7**
  (decisione del coordinatore): il server di RNC prende SRV-5. *Se
  sbagliata*: solo numerazione nel seme e nei test.
- **P9 — RNC nei membri di riferimento, Giulia Project Lead in RNC.** *Se
  sbagliata*: cambia chi riapre RNC nel seme, e con lui gli scenari dei
  test di Reopen.
- **P10 — lo scope di «Who can?» è visibili ∪ archiviati per chi li vede**;
  la scelta del progetto resta sui visibili. *Se sbagliata*: «Who?» su
  Reopen torna vuoto, o un archiviato compare fra i progetti da scegliere.
- **P15 — `chosenUnavailable` vale solo per l'account eliminato**; lo
  spento ha la sua riga. *Se sbagliata*: un riquadro diverso sullo spento.
- **P16 — la sessione ricorda `requiredProvider` alla nascita** e la frase
  è quella di [PX 3]. *Se sbagliata*: la frase seguirebbe l'impostazione di
  adesso, non quella con cui la sessione è nata.
- **P18 — il costruttore e l'esecuzione dicono «project isn't available
  anymore»** per un progetto non disponibile. *Se sbagliata*: due frasi.
- **P20 — il fuoco dopo un collegamento o un'eliminazione segue [AR 8]**
  (il Link della riga dopo, o l'h1). *Se sbagliata*: un `focus()` diverso.
- **P21 — il registro dà agli ex membri e ai full admin l'archiviato con
  `archived: true`**; RF 1 vale per chi non ne era membro. *Se sbagliata*:
  gli ex membri non leggono più le voci dell'archiviato; una condizione in
  `readable`.
- **P23 — nel `busy` titolo e codice sono `null` se chi archivia non vede
  la sessione** (decisione del coordinatore). *Se sbagliata*: il dialogo
  direbbe meno di quanto il maintainer vuole; mai di più.
- **P25 — un terzo account git usato solo da `shop-frontend`**, rinominato
  «GitHub Shop» (ruling T1: «Ronchi» avrebbe nominato il cliente a chi non
  ne era membro). *Se sbagliata*: solo il seme.
- **P27 — il ramo predefinito esce dalla patch di `updateRepository`**: si
  legge e basta (decisione del coordinatore). *Se sbagliata*: manca un
  campo che il maintainer voleva modificabile; rimetterlo lascia lo stato
  libero di contraddire la piattaforma.
- **P28 — gli esempi degli shape corretti sul seme** («When reopened» di
  RNC, «Skills in this run · 11», «GitHub Shop»). *Se sbagliata*: solo
  testo degli shape.

Dal ledger durante l'area:

- **Ruling (T1) — chi ha `repos.manage` legge le voci del gruppo
  repositories e vede Change log**; «Administration» resta quella del 9b.
  *Se sbagliata*: Marco non deve vedere la voce; una condizione in
  `adminSections.ts`.
- **Ruling (T2) — le impostazioni di un progetto nuovo nascono a lettura**
  (`settingsOf`), non in `createProject`. *Se sbagliata*: `createProject`
  le scrive; nessun effetto visibile.
- **Ruling (T4) — lo scenario «in sola lettura» dei repository si fa con
  Marco** (`repos.view`), il seme di Sara resta. *Se sbagliata*: si cambia
  il seme.
- **Ruling (T5) — i consumi di un progetto eliminato restano** e si
  leggono «Other projects»: il budget del mese non scende eliminando. *Se
  sbagliata*: una riga in `purge.ts`.
- **Ruling (T5) — sulla pagina dell'archiviato ex membri e full admin
  leggono i nomi dei membri e di chi ha archiviato**, anche se quelle
  persone stanno solo lì. *Se sbagliata*: i nomi vanno nascosti come «a
  person you can't see».
- **Ruling (T6) — «project isn't available anymore» per archiviato o
  eliminato; un progetto aperto che il proprietario non vede più resta
  «permission lost»**. *Se sbagliata*: una funzione in `plans.ts`.
- **Ruling (T8) — Cancel della creazione guidata passa dalla stessa
  conferma «Discard?» di Esc; la riga mostra `releaseBranch`**. *Se
  sbagliata*: una conferma in più.
- **Ruling (T10) — una scelta salvata su una skill che l'inventario non ha
  più si scarta salvando**, nel livello dati, senza `invalid`. *Se
  sbagliata*: il salvataggio rifiuterebbe per un dato che l'utente non può
  togliere.
- **Ruling (T11) — di un repository senza progetto, a chi non era membro
  né full admin si mostra solo l'ultimo segmento del nome completo.** *Se
  sbagliata*: solo meno informazione.
- **Ruling (T12) — la voce dell'account AI salva anche il nome di allora**
  (`params.accountBefore/After`) per dire «Backup Max (deleted)»; il prima
  e dopo resta un id. *Se sbagliata*: la voce perde il nome dopo
  l'eliminazione.

Tecniche (forma del codice e dei test, nessun effetto visibile): P1
(`ApiFnName` con i tre `instance.*` e `getArchivePreview`), P2
(`seed/commands.ts` e `seed.test.ts` nel Task 1), P4 (`listCommands`
compone, `commandsFor` puro), P5 e P6 (import per effetto dei tipi di voce;
store, sezioni e registro importano solo
`projectSettings/{state,seed,changeTypes}`), P7 (i test di parità filtrano
gli archiviati), P11 (il test dei Docs notturni prova la frase positiva),
P12 (`getUsage` per progetto da Roberta), P13 (un test sul sorgente vieta
`can(` e `data/viewer` in `pages/settings/**`), P14 (`getProjectUsage`
restituisce `null`), P17 (`TaskRun.skills` e `requiredProvider` copiati in
`getTaskWork`), P19 (il test «Backup Max al limite, senza exclusive → Team
Max»), P22 (`changelog.values.hiddenProject`), P24 (gli helper nuovi di
`changelog/reads` non si esportano), P26 (gli hook delle query nei file dei
Task 8, 10 e 11), P29 (lo stato delle verifiche e delle simulazioni sta
nello State). Se una fosse sbagliata, il costo è un refactor locale o un
test in più.

### Frasi nuove fuori dagli shape

Da far vedere al maintainer: ognuna dice il vero, ma lo shape non la
scriveva.

- `settings.ai.chosenOffExclusive` (Task 7, I4): «It's off: until someone
  turns it on, Claude's new work in ACQ starts without an account.» / «È
  spento: finché qualcuno non lo accende, il lavoro nuovo di Claude su ACQ
  parte senza account.» Lo shape aveva la frase solo senza esclusività, che
  con l'esclusività sarebbe falsa.
- Creazione guidata e pagina del repository (Task 8): «Use a name without
  spaces or /.», «Choose one of the git accounts.», «It comes from
  Bitbucket: Stubwise reads it, and doesn't change it.» (sotto il ramo
  predefinito, P27), «Couldn't load the git accounts.», «Choose a git
  account.», «Choose a repository.», «Verify access first: it has to
  work.», «This repository isn't in ACQ.».
- File d'ambiente (Task 9): il toast di Remove («… removed from …»), il
  titolo «Delete .env (Staging)?» del dialogo di un file senza variabili,
  «Choose a file…».
- «How it works» di un'automazione (Task 6, M4): «in a project that's no
  longer available» anche fuori dal costruttore, per chi non vede il
  progetto mentre il proprietario sì: lì «no longer» afferma più di quanto
  il dato dimostra, e il registro dell'esecuzione dice «in a project you
  can't see». Da decidere se tenerla solo nel costruttore.
- Registro (Task 12): `repository.linked` in italiano dice «al progetto
  ACQ», non «ad **ACQ**» dello shape («ad» va solo davanti a vocale);
  `{{project}}` non è in grassetto; `project.deleted` mette in grassetto
  tutta l'etichetta «RNC · …» e `switch_changed_*` anche l'articolo («**the
  weekly brief**»).
- `/archived/<CODE>` sconosciuto (Task 11, M8): è «Project not found» con
  «Back to Home», identico a un codice inesistente (R-G5, provato byte per
  byte), non «← All projects» dello shape.

### Dalla revisione finale del branch (ondata finale, 31 ott 2026)

La revisione finale (I1–I6, M1–M3, il triage dei minori) e il passaggio di
Impeccable (2 bloccanti, 11 rifiniture) sono chiusi nell'ondata finale,
tranne queste voci. Ognuna dice perché resta.

- **M1 — `repository.updated` salva l'account git per nome, non per id.**
  Un account rinominato in Amministrazione lascia nel registro il nome
  vecchio come valore «di adesso». *Perché*: allinearlo all'account AI
  (id più nome di allora, ruling T12) vuol dire risolvere il nome a
  lettura in `changelog/reads.ts` per le voci `fields` e dire «(deleted)»
  nella riga del campo: non costa poco, e oggi la voce non dice il falso
  sul momento in cui è stata scritta.
- **Eliminare un ambiente con dei file d'ambiente non avverte** (I5). I file
  e i loro valori ora se ne vanno con l'ambiente (`dropEnvironmentFiles`,
  test RF 2), ma il dialogo di Releases → Environments non lo dice e la
  voce `environment.deleted` non conta i file. *Perché*: il dialogo è
  dell'8a e la lettura degli ambienti (`environments.manage`) non sa dei
  file (`repos.manage`): dire quanti file si perdono a chi non li vede è
  una regola nuova da far decidere al maintainer.
- **Il segnaposto «Groups of projects will be listed here.» nella colonna
  di All projects e di `/archived/<CODE>`** (rifinitura 5 di Impeccable).
  *Perché*: le due fonti non concordano. Il triage della revisione lo
  lascia nei follow-up (lo stato neutro della colonna è dell'area 1, e il
  9c lo eredita perché `contextOf` mappa `/archived` su `projects`,
  `Column.tsx`); Impeccable chiede di toglierlo o di metterci i gruppi di
  All projects. È l'ultima destinazione con lo stato neutro, provato da
  `Column.test.tsx`: colonna vuota o elenco dei gruppi è una scelta del
  maintainer. **Decisione del maintainer (2 nov 2026): resta com'è**,
  finché non arrivano i gruppi di progetti.
- **Area 2: a 1024 il pannello della task copre i titoli, senza ellissi**
  (rifinitura 13, `a9c-effects-claude-exclusive-narrow-en`). *Perché*: è il
  layout del dettaglio della task, fuori dal perimetro del 9c. Il rimedio è
  lo stesso del costruttore (bloccante 2): sovrapposto, il pannello lascia
  alla pagina lo spazio della sua larghezza (`DetailPanel`, `onWidth`).
- **Il costruttore a 1024 col pannello del passo allargato a mano fino a
  640 px scorre in orizzontale.** Il `padding-right` del canvas
  (`data-builder-canvas`, `BuilderPage.tsx`) segue la larghezza del
  pannello, e con `min-w-[520px]` dell'albero la somma supera la finestra.
  *Perché*: è raro (un pannello allargato a mano in una finestra stretta),
  e il rimedio, limitare il padding a `min(pannello, larghezza − 520)`,
  vuole la larghezza del costruttore misurata: da fare insieme al rimedio
  dell'area 2 qui sopra, con lo stesso `onWidth`.
- **Un episodio di server aperto a cavallo dell'archiviazione o della
  riapertura dà avvisi spaiati** (I2). Archiviato con l'episodio aperto, il
  progetto tiene «Server in trouble» senza il suo «back to normal»;
  riaperto con l'episodio aperto, riceve «back to normal» senza aver
  ricevuto l'avviso. *Perché*: gli avvisi seguono gli ambienti vivi nel
  momento in cui partono (`liveEnvironments`); appaiarli vuol dire
  ricordare sull'episodio a chi è andato l'avviso, una regola del motore
  degli episodi, non del 9c.
- **I `<select>` nativi della pagina del repository.** *Perché*: è il
  controllo di form dell'app (`selectClass`, anche nel costruttore e in
  Usage); cambiarlo è una scelta di sistema, non del 9c (Impeccable lo
  smentisce come difetto dell'area).
- **`font-mono` è ancora Archivo in alcune pagine di prima del 9c**
  (gli esempi JSON dei webhook dell'area 7, il manifest e i percorsi dei
  plugin del 9b, il codice in «Add provider»). Le chiavi mascherate e
  `SecretField` ora sono `font-code` ovunque (test `styles/monospace.test.ts`)
  e DESIGN.md dichiara l'eccezione dei letterali. *Perché*: sono blocchi di
  codice di altre aree; passarli a `font-code` cambia la loro resa, da
  rivedere con i loro scatti.
- **`/p/<CODE>` subito dopo l'archiviazione** mostra la pagina senza un
  «not found» di passaggio (Task 11). *Perché*: la scrittura porta già ad
  All projects; il caso è un indirizzo riaperto a mano, raro.
- **Un test di contratto unico** «nessuna funzione che fa nascere lavoro
  (analisi, proposte, run) accetta un progetto archiviato» (raccomandazione
  2 della revisione). Oggi la regola ha una prova per ogni via: `canStartRun`
  e `projectSwitchOn` (Task 5 e 6), i `plan*` delle automazioni, gli allarmi
  dei server e la posta (`archive.test.ts` «I2», `mail.test.ts`). *Perché*:
  un test che le enumeri tutte va scritto quando il motore avrà un punto
  solo da cui nasce il lavoro.

### Minori rimandati, per task

Segnati Minor dalle revisioni dei task e lasciati alla revisione finale del
branch: nessuno dice il falso in un percorso normale né tocca un Review
Focus (segreti, R-G5, eliminazione). Ognuno dice perché resta. Quelli che
l'ondata finale ha chiuso non ci sono più.

Task 1 (stato, sezioni, seme):
- `ChangeEntry.link.test.tsx`: il test «una destinazione sconosciuta non
  compila» non prova l'esaustività; la garanzia vera è il `never` di
  `ChangeEntry.tsx`. *Perché*: la garanzia c'è ed è di `tsc`; resta il
  titolo che dice di più.
- Il «Who?» di Integration nomina solo `manageProjectSettings`, non anche
  `manageRepos`: `SectionAccess` ha una sola azione. *Perché*: serve un
  secondo campo nella forma del brief.
- `router.tsx`: con nessuna sezione visibile il ripiego è General, anch'essa
  invisibile. *Perché*: oggi `getProjectByCode` dà `null` prima.
- `projectSettings/seed.ts`: `seedInstanceState()` ricostruito per ognuno
  dei 51 progetti a ogni `freshState`, e `hashOf` preso dal modulo dei
  server. *Perché*: costo dei test, nessun effetto.
- `ProjectChangeParams` non lo impone nessuno: un writer che dimentica un
  parametro compila. *Perché*: i writer sono provati uno per uno.
- Il gruppo `projects` del registro si chiama «Deleted projects» ma
  contiene anche `repository.deleted`. *Perché*: solo un nome nel filtro.

Task 2 (General, AI, Automations, Usage: dati):
- I limiti di 120 e 1000 caratteri non hanno test ai bordi. *Perché*:
  copertura.
- Nessun test fissa `forbidden` prima di `invalid`. *Perché*: è vero per
  costruzione (`managedProject` davanti).
- `settingsOf` scrive nello stato dentro una lettura. *Perché*: conseguenza
  del ruling (T2), nessun difetto oggi.
- `general.ts` riscrive `""` su una descrizione `undefined` anche senza
  cambi. *Perché*: innocuo, nessuna voce.
- Un commento di `queries/projectSettings.ts` va a capo a metà frase.
  *Perché*: cosmetico.
- `AI_WRITE_AREAS` ricarica conversazioni e task senza bisogno. *Perché*:
  solo un'invalidazione in più.

Task 3 (registro delle scritture di prima):
- `updateEnvironment` e `updateWidget` scrivono «updated» anche quando non
  cambia niente. *Perché*: una voce in più, mai una in meno.
- Del widget il registro dice solo il nome. *Perché*: dichiarato; gli altri
  campi non hanno un valore stabile.
- Input rifiutati non coperti per `setProjectStatuses`,
  `updateEnvironment`, `deleteEnvironment`; mancano asserzioni sul diff di
  kind/url e sul nome del widget. *Perché*: copertura.
- `setProjectStatuses` non asserisce etichetta e id dell'oggetto, né il
  salvataggio identico. *Perché*: copertura.
- Un modo PR assente vale `analyze_and_fix` nel registro. *Perché*:
  corretto, ma il default è duplicato.

Task 4 (repository, file d'ambiente, Integration, plugin: dati):
- Le righe dei webhook git di Integration non hanno lo stato: la pagina lo
  legge da `useProjectRepositories` (anche Task 9). *Perché*: due
  sorgenti, nessun dato sbagliato.
- `configureRepositoryWebhook` crea un secret senza riconferma (lo shape lo
  vuole) e senza un test RF 2 su quel secret. *Perché*: scelta dello shape;
  il test manca.
- Il commento in testa a `repositories.test.ts` dice che Sara ha
  `repos.view`, il test dice di no. *Perché*: solo il commento.
- La rinomina «GitHub Shop» è entrata al Task 4, non al 5, riscrivendo il
  testo del piano. *Perché*: procedura, nessun effetto.

Task 5 (archiviare, eliminare, repository senza progetto: dati):
- `busyReasonsOf` esce dal barile `api.projectSettings` senza `gate`.
  *Perché*: nessuna pagina lo raggiunge (precedente: `skillsForRun`).
- Un repository collegato con `graphEnabled: true` riceve uno spazio col
  grafo `disabled`. *Perché*: nel seme non capita.
- `orphanServersOf` ordina con `Number(slice(4))` invece di `codeNumber`.
  *Perché*: stesso risultato.

Task 6 (effetti nelle altre aree):
- `RunNow.tsx`: la ragione «project isn't available anymore» si ripete
  sotto il titolo che già la dice. *Perché*: cosmetico.
- La derivazione «interruttore letto e spento» è copiata in cinque pagine;
  `useNightlyOff` è esportato da una pagina; il `Link` di `PulseText` copia
  `AutomationsSettingsLink`; `SwitchOffLine.kind` è `string`. *Perché*:
  refactor in un hook `useSwitchOff`.
- «no longer available» fuori dal costruttore: vedi «Frasi nuove fuori
  dagli shape».
- «Senza ricaricare» è provato sull'hook e con una navigazione, non sulla
  BriefCard montata. *Perché*: stessa area d'invalidazione.
- La testata del costruttore «General · uses the client's project» è
  imprecisa con un passo fisso. *Perché*: stringa dell'area 7, fuori
  perimetro.

Task 7 (General, AI, Automations, Usage: pagine):
- La frase della regola del pulse non è nell'`aria-describedby`
  dell'interruttore spento. *Perché*: c'è nel `title` e a schermo.
- La lettura in parole del tetto dice anche i valori fuori intervallo
  («Up to 11…») prima del rifiuto. *Perché*: il salvataggio rifiuta.
- Il test «riaccendere la discovery non riaccende il pulse» gira dopo il
  salvataggio, e manca un test con timer finti sul cambio di frase dopo
  4 s. *Perché*: copertura.
- Per Sara in AI la descrizione della casella spenta non è asserita.
  *Perché*: copertura; il codice la mette.
- `UsagePanel` con `null` non mostra nessuno stato. *Perché*: la rotta
  risponde prima «not found».
- Il campo dei giorni, spento col pulse spento, non ha la sua frase.
  *Perché*: la frase dell'interruttore è accanto.

Task 8 (repository: pagine):
- Riaperto il passo 1 e cambiato account, i passi 3 e 4 restano cliccabili
  e vuoti. *Perché*: percorso raro.
- Un rifiuto `invalid` della verifica o del webhook si perde in silenzio
  (`onInvalid` vuoto). *Perché*: oggi non ci si arriva dalla UI.
- Il revisore, senza gli account letti, dice «No default reviewer»; e la
  lettura chiede `git_accounts.view`, diverso da `repos.manage`. *Perché*:
  con i preset non capita.
- `?new=1` senza permesso resta nell'indirizzo. *Perché*: non apre niente.
- Un repository che sparisce lascia RELEASES con la sola testata.
  *Perché*: percorso raro.
- La gara del riquadro «Prototype only» è corretta ma senza test (si
  riproduce solo con la latenza casuale). *Perché*: copertura.

Task 9 (file d'ambiente e Integration: pagine):
- «Copy» dell'indirizzo git e «Copy guide» falliscono in silenzio senza
  appunti. *Perché*: da allineare a `SecretOnce`.
- [RE 8] (riconferma annullata: l'area dell'import resta vuota) senza test.
  *Perché*: copertura; il codice è giusto.
- `EnvFiles.tsx`: il link a Releases → Environments passa da `as never`.
  *Perché*: scavalca il tipo della rotta.
- I webhook git letti da un'altra query: vedi Task 4.
- Il dialogo del secret: la frase sulla piattaforma e «Nothing was
  changed.» non sono provate. *Perché*: copertura.

Task 10 (plugin: pagina):
- Lo stato di caricamento è uno scheletro unico, non «il plugin base + 2
  blocchi». *Perché*: cosmetico.
- Un `invalid` diverso da `base_plugin` dice «Couldn't save. Try again.»
  senza Retry. *Perché*: dopo il ruling (T10) resta solo il plugin tolto
  dal registro mentre si modifica.
- Casi dello shape senza test: più di 12 skill, `materializing`, vuoto,
  `forbidden`, `not_found`, errore con Retry, secondo conflitto di fila,
  fuoco dopo il preset, link «Administration → Plugins». *Perché*:
  copertura; il codice c'è.
- Le caselle spente in sola lettura si distinguono appena (opacità 50 %).
  *Perché*: la parola «Off» sulla riga resta il segnale.
- `void onReload()` dentro `onConflict` è ridondante. *Perché*: innocuo.
- Il test del preset non prova una skill del preset assente
  dall'inventario. *Perché*: copertura.
- La riga di una scelta fuori inventario si vede fino al salvataggio che la
  scarta. *Perché*: il ruling (T10) chiede lo scarto al salvataggio.

Task 11 (archiviare, Archived, Delete, repository senza progetto: pagine):
- `useLifecycleWrite` lascia vecchie le letture di **tutti** i progetti,
  non solo del soggetto: riaprendo un progetto aperto prima da archiviato
  si vede «not found» per un attimo. *Perché*: percorso raro.
- I due cambi a `tasks-ui/Menu.tsx` (clic e tasti dal riquadro di «Who?»)
  non hanno un test proprio. *Perché*: corretti e innocui; manca la prova.
- Con la lettura degli archiviati in errore la tablist perde la scheda
  selezionata. *Perché*: solo sul percorso d'errore.
- La scheda non scrive nell'URL: «Open Archived» di un toast successivo può
  non fare niente. *Perché*: raro.
- `busy` passa come `{ ok: true, busy }` per non essere un errore di
  `useSettingsWrite`. *Perché*: il tipo mente, il comportamento è giusto.
- Struttura: `routeOfCode` importato da un componente di Claude; export di
  una pagina usati dai fratelli; il glifo ✕ e la lista delle conseguenze
  copiati. *Perché*: refactor.
- Manca «(deactivated)» accanto a chi ha archiviato: la vista dà solo il
  nome. *Perché*: serve un campo nel livello dati del Task 5.
- Nel dialogo «Link to a project…» oltre 10 progetti non c'è la ricerca.
  *Perché*: nessuna persona del seme ci arriva.
- `Archive.test.tsx`: «senza esecuzioni la riga non c'è» si verifica dopo
  un `setTimeout`. *Perché*: test fragile, non sbagliato.
- Il `busy` è provato solo con una sessione e un codice: non le righe
  `waiting`, `release`, «solo titolo», «hidden», il plurale; né i rifiuti
  di Reopen e Link nella UI. *Perché*: il livello dati li copre.
- `useSettingsWrite`: una seconda scrittura sulla stessa istanza durante
  una in corso restituisce `false` in silenzio. *Perché*: ogni chiamante ne
  fa una; manca una riga nel docblock.
- `ArchivedProjects.tsx`: con un filtro la «riga dopo» può essere nascosta
  e il fuoco va al titolo. *Perché*: il ripiego è accettabile.

Task 12 (voci del 9c nel registro):
- «al progetto ACQ» e i grassetti: vedi «Frasi nuove fuori dagli shape».
- Il titolo di un test dice «Laura no», ma il caso di Laura sta nel test
  dopo. *Perché*: solo il titolo.
- Nessun test rende `env_file.imported` (plurale) né il ripiego «an account
  that was deleted» delle voci AI scritte prima del Task 12. *Perché*:
  copertura.
- `fileParams` ripiega su `""` se ambiente o repository mancano, e la frase
  diventa «for  in ». *Perché*: oggi non capita.

## Area 10a — minori aperti

Parità e copertura: `area10-parity.md`. Le invarianti da riscrivere prima
del motore sono §12 (gli strumenti del riquadro), §13 («Annulla»), §14
(«Cosa Claude non fa») e §15 (eliminare una task), sotto «Invarianti del
CLAUDE.md da riscrivere prima del motore». Qui: le scelte del costruttore
del piano, i rinvii al 10b, i minori rimandati dalle revisioni dei Task
1–11 (2 nov 2026), quello che si vede negli scatti del Task 12, ciò che
l'ondata finale ha lasciato aperto e, in fondo,
le decisioni del maintainer e del controller sulle domande del piano.
Ognuna delle scelte ha il suo costo se è sbagliata.

### Scelte del costruttore del piano

- **Le scritture d'istanza fuori dal catalogo.** Restano senza forma `…As`,
  e quindi fuori dalla portata di Claude: quelle che creano, sostituiscono o
  cancellano un segreto (`createProvider`, `replaceProviderCredential`,
  `deleteProvider`, `createGitAccount`, `replaceGitToken`,
  `deleteGitAccount`, `createGoogleApp`, `replaceGoogleSecret`,
  `deleteGoogleApp`: le tre `delete…` non portano il segreto negli
  argomenti, ma lo distruggono, e il loro inverso dovrebbe riscriverlo); le
  verifiche (`testProvider`, `validateGitAccount`, `testStorage`,
  `testWebhook`), che non cambiano un'impostazione; le `simulate…` del
  riquadro «Prototype only». *Se sbagliata*: Claude risponde con la riga
  che porta alla pagina dove una persona lo fa; per aggiungerne una servono
  la `…As`, la voce del catalogo e il suo caso in `catalog.test.ts`.
- **`saveStorage` è sempre C**, anche senza una chiave nuova (il 9b chiede
  il codice solo con la chiave): la classe segue `REAUTH_REQUIRED` e non
  scende mai. Nessuna chiave entra dal catalogo (`invalid:
  secret_access_key`), e l'inverso rimette tutto tranne la chiave. *Se
  sbagliata*: un codice chiesto in più per cambiare regione o bucket.
- **Il catalogo per le voci che il design non elenca** (classe di partenza,
  inverso e «Who?» della tabella del Task 4 del piano). *Se sbagliata*: una
  riga di `catalog.ts` per voce.
- **«Com'era» per scritture, non per versioni** (§13). *Se sbagliata*: un
  campo versione su ogni oggetto del catalogo, e il confronto si rifà.
- **Una classe sale, mai scende** (`declaredClassOf` come pavimento). *Se
  sbagliata*: schede in più per azioni che oggi non avviserebbero nessuno.

### Rinviati al 10b

- **«Show N more»** oltre 5 righe in una scheda (shape claude-actions §5):
  nel 10a nessun intento produce schede con più di 5 azioni; nasce con le
  schede in blocco del 10b (T9 M2).
- **Filtro, lingua e tema lato pagina** (decisione 4 del piano, scelta del
  controller): Claude non scrive nei filtri della pagina né cambia lingua o
  tema; il riquadro sa solo cosa si sta guardando.
- **Le differenze deliberate 3, 4 e 5 del design** (risposta onesta, segno
  delle bozze di Posta e Supporto, i due dati nuovi del motore delle
  automazioni): appartengono agli scenari del 10b.

Il resto di ciò che il piano rinvia (`docs/plans/2026-11-02-desktop-area10a-plan.md`,
introduzione e «Cosa vale del design»), una riga per voce:

- **Gli scenari S0–S6b e i loro dati** (piano, introduzione): nessuna
  scena del 10a li riproduce.
- **La costruzione e la prova delle automazioni dal riquadro**, con **le tre
  righe delle automazioni del catalogo** (piano, introduzione e «parte 2»):
  il catalogo del 10a non ha voci che creano o provano un'automazione.
- **«Le pagine che si possono riempire»** (design, parte 1; piano, «Cosa
  vale del design»): il riquadro non riempie i campi della pagina.
- **Le righe «Claude può aiutarti a…»** (piano, introduzione).
- **Le righe «Filtro» e «Bozza in un campo» del catalogo**, e **la bozza
  «Bozza di Claude» nei campi** (piano, introduzione e «parte 2»): sono
  azioni che vivono nella pagina, non nel livello dati (*scelta del
  controller*). Le differenze 3–5 qui sopra ne coprono solo il segno nella
  Posta e nel Supporto.
- **Lingua e tema di «Le tue preferenze»** (piano, «parte 2»): le notifiche
  delle preferenze restano nel 10a (`setSubscription`).
- **Le azioni in blocco di S4** (piano, «parte 5»): oltre a «Show N more»
  qui sopra, le schede che toccano molte task insieme.

### Minori rimandati, per task

Segnati Minor dalle revisioni e lasciati alla revisione finale del branch:
nessuno dice il falso in un percorso normale né tocca un Review Focus
(R-G5, segreti, eliminazione). Ognuno dice perché resta. Quelli chiusi nei
giri di correzione non ci sono.

Task 1 (forme `…As`):
- `retryJob` scrive `job.retried` prima degli eventi della sessione, e la
  voce resta anche se `launchRun` lancia. *Perché*: inevitabile con questa
  forma (la `…As` scrive la voce senza far partire la sessione); manca un
  commento che lo dica.
- `launchRun` rilegge il blocco con `aiBlockFor` invece di rifiutare
  `monthly_budget`, e `state.tasksById.get(...)!` crasherebbe su una task
  sparita. *Perché*: ruling T4, fra le due non passa tempo nel prototipo.
- `syncWrites.test.ts` non copre i `forbidden` su progetto invisibile di
  `saveAutomation`, `moveProvider`, `setProjectAi`, `reopenProject`,
  `setSubscription`, `pauseQueue`. *Perché*: copertura; le pubbliche li
  hanno.
- `resetReauth` dichiarata dopo il suo uso nel test. *Perché*: funziona.
- Il docblock delle `…As` è una riga sola oltre i 100 caratteri. *Perché*:
  cosmetico.
- `syncWrites.test.ts` costa circa 25 s alla suite. *Perché*: si dimezza con
  uno snapshot dello stato, non necessario ora.

Task 2 («Elimina task», livello dati):
- `claude_session.code` porta il codice della task, non della sessione.
  *Perché*: il Task 10 ha aggiunto `conversationId?` per il link; il campo
  resta ambiguo.
- `open_pr` mostra repo e numero anche a chi non vede la sessione da cui
  vengono. *Perché*: non è R-G5, le PR della piattaforma le vedono tutti.
- Mancano i test di `forbidden` prima di `busy`, di una figlia in un
  progetto invisibile e di `whoAction: null` per l'autrice. *Perché*:
  copertura.
- `taskGone` confronta progetto e codice senza guardare il `kind`.
  *Perché*: i prefissi dei codici oggi bastano; manca il commento.
- Le notifiche della Chat non ricevono `objectGone`. *Perché*: parlano di un
  messaggio, non di una task.

Task 3 (il segno `via`, `task.assigned`):
- `newId("ca")` consuma il contatore anche quando il gruppo fallisce.
  *Perché*: innocuo, solo l'asserzione «tutto o niente» più debole.
- `ActivityEntry.claudeActionId` esce al client con `listActivity`.
  *Perché*: opaco, non R-G5; il registro lo nasconde.
- Con una `fn` async, `runAsClaude` lascia le scritture della parte
  sincrona. *Perché*: errore del programmatore, la guardia lo fa scoprire.
- Un'asserzione contorta in `via.test.ts` («nessun segno» a mano).
  *Perché*: solo leggibilità.
- `Offenders` vede l'ultimo overload e tre livelli di namespace. *Perché*:
  nessun buco noto; manca il commento.
- Il silenzio dentro un «Annulla» vale per ogni kind, non solo
  `task.assigned`. *Perché*: è la regola del Task 5, coerente con lo shape.

Task 4 (catalogo e classi):
- `taskFromAction` accetta la prima task di qualunque azione precedente.
  *Perché*: `prepareRunAs` ricontrolla, nessun permesso in più.
- «Due Avvia nello stesso gruppo» guarda solo `runs`: `startRun` seguito da
  `retryJob` sulla stessa task apre due sessioni. *Perché*: improbabile,
  nessun intento lo produce.
- `convertRequest` con un assegnatario diverso manda `task.assigned` ma la
  classe non lo nomina in `notifies`. *Perché*: è già B; la scheda direbbe
  una persona in meno.
- `notifies` non porta il progetto, e `classOfGroup` fonde i `more` di
  progetti diversi. *Perché*: il T9 l'ha chiuso per il caso di un progetto
  solo; su due progetti la frase resta generica.
- Il tokenizzatore di `neverInCatalog.test.ts` non riconosce le regex
  letterali. *Perché*: limite dichiarato (§14).
- `catalog.ts` cresce in un file solo. *Perché*: si separa quando il 10b
  aggiunge voci.
- Il ripristino del gruppo non annulla gli effetti fuori dallo stato (timer
  di `removePlugin`, `releaseBudgetHolds`, `publishChatEvent` asincroni).
  *Perché*: il prototipo non ha transazioni; scritto in §12 per il motore.

Task 5 (esecuzione e «Annulla»):
- La doc di `ActivityEntry.seq` dice «ultima scrittura», ma `seq` nasce solo
  con la voce. *Perché*: fuori dal «com'era» per ora (§13).
- Nessun test per il ripristino a metà di un «Annulla» di più azioni.
  *Perché*: il meccanismo è quello di `applyActions`, già provato.
- I rami R-G5 di `describeLater` e `refusalOf` non sono esercitati.
  *Perché*: copertura; il codice nasconde nome e codice.
- `classReason.notifies` unisce i nomi con «, » invece di «and/e» (anche in
  `change.ts`), e prende solo il primo motivo, mentre `ReasonRows` usa
  «and/e» e «and N more»: la frase sopra la scheda e la riga «Notifies»
  possono dire cose diverse con due persone (M6 della revisione finale).
  *Perché*: con una persona sola, il caso del seme, non si vede; una
  funzione di `domain/` per l'elenco dei nomi va fatta col 10b.
- `settleInConversation` e il ramo Chat di `settleProposal` sono quasi
  gemelli. *Perché*: refactor.
- Il test della coda in pausa ha asserzioni deboli. *Perché*: copertura.
- `classRaised` sostituisce solo il `say` subito prima. *Perché*: il motore
  lo mette sempre.
- Nuovo ciclo d'import `claude/actions.ts` ↔ `api-mutations.ts` senza
  commento. *Perché*: usato solo dentro le funzioni.
- Fuori dal «com'era»: modifica ed eliminazione di commenti, sessioni
  `task_run` di `servers/fix.ts`, refine e intake sulle richieste.
  *Perché*: §13, da decidere col motore.

Task 6 (intenti e righe D):
- `within: 5` di `refused.ts`: un segreto vicino al verbo trasforma una
  creazione in una riga D («Create a task to rotate tokens»); `server` e
  `record_decision` hanno lo stesso rischio. *Perché*: il guasto è sicuro,
  niente viene eseguito.
- «Delete SRV-2» risponde «Can't find SRV-2». *Perché*: frase falsa ma
  nessuna fuga; mancano i verbi nel tema `server`.
- `run.ts`: con `taskIds` vuoto una richiesta convertita risponde
  `convertedDeleted`. *Perché*: caso improbabile.
- `send` dice «Open Mail →» / «Open Support of ACQ →», lo shape «Open the
  reply →». *Perché*: da riallineare o da accettare con un ruling.
- R-G5 non provato per automazioni, `answer_question`, `secret`, `send` con
  un progetto invisibile. *Perché*: il codice è corretto, manca la prova.
- Gli indirizzi fuori da `CASES` non passano da `isAppRoute` nei test.
  *Perché*: una riga per test.
- `recordDecision=1` passa `validateSearch` su ogni percorso e sopprime il
  pannello della task fuori dall'Overview. *Perché*: si raggiunge solo a
  mano.
- La task del dialogo si risolve due volte, e si può salvare prima che le
  task siano caricate. *Perché*: stretto.
- Il dialogo aperto dal link ha Cancel senza «Discard?». *Perché*:
  preesistente (area 5).

Task 7 (il seme):
- La scena 1 sposta una task chiusa nel passato. *Perché*: Giulia non ha
  task aperte in MKX.
- `chg-seed-claude-3` non ha `seq`. *Perché*: nessun «com'era» la guarda.
- `summaryText` dei due `planTask` del seme non è quello dell'intento vero,
  e manca l'azione di lettura `get_ticket`. *Perché*: si legge solo.
- `void sendMessage;` e un titolo di test che dice altro. *Perché*:
  pulizia.
- I conteggi attesi derivati dal dato sotto test (`CLAUDE_CHANGES.length`).
  *Perché*: meno severi, non sbagliati.
- `SEED_MAX_SEQ` scritto a mano. *Perché*: il test lo controlla.
- La scena A non asserisce che il replay non scriva notifiche. *Perché*:
  copertura.

Task 8 (il riquadro):
- La chiusura non è animata (150 ms dello shape §7). *Perché*: solo
  l'uscita; `hidden` toglie subito.
- Il test a 1024 non prova la posizione, e `useDockGeometry` non ha un test
  unitario. *Perché*: la provano gli scatti.
- Un `MutationObserver` su tutto il `body`, anche a riquadro chiuso.
  *Perché*: costo, non comportamento.
- La × si annulla con qualunque cambio di search, non solo di pagina.
  *Perché*: stretto.
- «Now showing …» non sparisce scrivendo in una conversazione esistente.
  *Perché*: il timer di 4 s lo copre.
- L'effetto di `usePageContext` ha dipendenze incomplete senza soppressione
  dichiarata. *Perché*: commentato.
- Il ritorno del fuoco è ricostruito a mano invece di `useRestoreFocus`.
  *Perché*: refactor.
- ⌘J in Electron non provato dal vivo (doppio evento menu + tastiera).
  *Perché*: da provare sull'app impacchettata.

Task 9 (righe e schede):
- `openRoutes` per `#/admin/people?invite=1`, releases e
  settings/integration guarda solo la visibilità del progetto, non il
  permesso della pagina. *Perché*: nessuna fuga; promette un'azione che la
  pagina poi non offre.
- Verbi della riga diversi dallo shape per `setSubscription`,
  `saveProjectAutomations` e `updateTask` di stato. *Perché*: nessun intento
  del 10a le produce; meno precise ma non false.
- «I'm asking first: it notifies Matteo Conti.» invece di «Matteo Conti
  follows new tasks in AUD.». *Perché*: il dato non dice se è iscritto o
  assegnatario.
- `key={row.kind}` ripete le chiavi con più righe `automation`. *Perché*:
  solo un warning.
- «and 2 more» insieme a `more` dà due code nella stessa frase. *Perché*:
  sopra tre nomi, non nel seme.
- L'`UndoControl` della scheda sta accanto all'esito, non sotto. *Perché*:
  posizione, non contenuto.
- «Didn't run» con `not_found` ricade su `errorText`. *Perché*: raro.
- «Undone by …» confronta i nomi invece degli id. *Perché*: chi non ha
  chiesto legge `not_yours`.
- La pubblica letta da Roberta, che vede tutto: [CA 7] non provato con un
  lettore che non vede il progetto. *Perché*: copertura.
- Senza test: `needsReauth` di Undo, `reauth_cancelled` della riga, `busy`,
  `already_undone`, `not_found`. *Perché*: copertura.
- `DocsTools.test.tsx > l'ora dell'orologio` è flaky sotto carico.
  *Perché*: preesistente.
- Salto di layout transitorio della riga durante lo stream. *Perché*: dura
  quanto lo stream.

Task 10 («Elimina task», UI):
- I collegamenti si calcolano nella pagina (`linksOf` su `useTasks()`),
  invece di un `hasLinks` nella vista. *Perché*: lo shape lo consente
  («letti dalla task aperta»); la riga compare dopo.
- Bottone rosso spento senza frase se la vista riletta dice `canDelete:
  false` senza un rifiuto in corso. *Perché*: stretto (permesso tolto fra
  menu e dialogo).
- Un `MenuGroup` vuoto quando la vista è `null`. *Perché*: un filetto
  orfano, se c'è.
- Il fuoco si aspetta col polling del DOM (40 × 25 ms). *Perché*: ha sempre
  un esito, riga o h1.
- Senza test: «Checking…» e il suo errore, l'errore del dialogo,
  `not_found`, la riga precedente quando la task era l'ultima. *Perché*:
  copertura.
- Il dialogo resta su «Deleting…» finché `onSettled` rilegge tutte le
  query. *Perché*: nel prototipo la lettura è breve.
- Esc o Cancel durante «Deleting…» chiudono il dialogo, ma un fallimento a
  dialogo chiuso non lo dice nessuno. *Perché*: lo shape non lo copre.

Task 11 (trascrizione):
- A 1024 nel registro scende solo «Clear filters», non anche Period.
  *Perché*: il senso dello shape («Made with Claude» in prima riga) regge.
- `reveal` annuncia «Filters cleared» anche senza filtri. *Perché*: solo se
  la voce manca per altri motivi (il registro di un progetto).
- Il fuoco portato da `reveal` sparisce alla vista dopo 1,5 s. *Perché*:
  manca un `focus-visible`.
- R-G5 col corpo salvato: «Claude on behalf of someone: <body>» per i tipi
  diversi da `task.assigned` e `planning.changed`. *Perché*: i destinatari
  sono membri del progetto.
- `DeletedTaskSubject` comincia con «someone» minuscolo e ha un `title` non
  tradotto. *Perché*: cosmetico.
- Il corpo salvato delle notifiche diverse da `task.assigned` e
  `planning.changed` resta in inglese, come prima del 10a. *Perché*:
  preesistente.
- Righe PR e del registro decisioni verso task eliminate senza test
  dedicato. *Perché*: copertura.

### Dagli scatti del Task 12

Rifatti tutti gli scatti `a10a-*` sulla versione finale (22 scene × 6
varianti: 1440 chiaro/scuro × en/it, 1024 scuro-en e chiaro-it). Scene
nuove in `scripts/capture.mjs`: `a10a-actions-changed-*` («changed it
afterwards»), `a10a-actions-panel-reauth-*` (la scheda C col dialogo della
riconferma sopra il riquadro); la scheda B di `a10a-actions-flow-*` ha ora
anche il motivo dell'automazione. Rimandati come gli altri minori:

- **Il fuoco dopo «Elimina task» (portato avanti dal T10): non è un
  difetto.** Gli scatti vecchi mostravano la lista senza le task create dal
  seme di `capture.mjs`, che le scrive nello stato senza passare dalle
  query: `rowAfter` non trovava la riga e il fuoco andava all'h1. Con la
  lista riletta prima di aprire il pannello, in tutte e sei le varianti il
  fuoco va sulla riga dopo (ACQ-7 eliminata → ACQ-8, verificato leggendo
  `document.activeElement`). Dopo un clic col mouse l'anello non si vede
  (`:focus-visible` di Chromium), da tastiera sì: comportamento del
  browser. Il toast di prima non copre più lo scatto busy.
- **Chiusi nell'ondata finale** (2 nov 2026): `task.assigned` e
  `planning.changed` senza Claude in lingua mista (I2), «Per aggiungi…»
  nella riconferma (M1), «W44» nelle schede in it (M2, convenzione unica
  `shortWeekIn`), le settimane grezze nelle righe d'attività, «Annulla»
  doppio in it (l'Undo è «Annulla l'azione», da confermare: vedi sotto), le
  virgolette nel dialogo e nel riassunto d'eliminazione.
- **Il chip del riquadro in it dice «ACQ-3 · task»: resta così.** **Confermato dal maintainer il 2 nov 2026.** La
  tabella dello shape approvato (claude-panel.md, «Il chip del contesto»)
  vuole «ACQ-14 · task» anche in it, e «task» è il nome dell'oggetto in
  tutta l'app («Nuova task», «Elimina task»); «Attività» è il nome della
  pagina, e il chip di pagina dice infatti «MKX · Attività». La revisione
  finale lo metteva fra le correzioni, Impeccable lo ha smentito: vale lo
  shape. *Se sbagliata*: una stringa.
- **La legenda dei reparti in fondo alla pagina si taglia sotto il
  riquadro**: non è un difetto (Impeccable). Il riquadro copre l'area di
  lavoro senza stringerla, come vuole [CP 11]; la legenda continua sotto.
- **La velatura dei dialoghi copre anche il riquadro** (rifinitura 1 di
  Impeccable, verificata): sotto «Conferma che sei tu» il riquadro sembra
  più chiaro della pagina, ma è velato come lei (255 → 199 nei pixel, e
  `elementFromPoint` sopra il riquadro trova la velatura): la differenza è
  quella fra `surface` e `ground`. Nessuna modifica.
- **Il «…» sotto la nota della richiesta dopo l'eliminazione** è il menu
  «Altre azioni» (esportazione), che c'è per tutti per scelta dell'area 2:
  isolato perché una richiesta trasformata non ha altre azioni. *Perché
  resta*: preesistente. La sezione «Chiesta da» vuota è chiusa (rifinitura
  6).
- **Preesistenti, visti negli scatti e non del 10a**: «Settimana impostato a
  S46» (concordanza, chiave `moveSet`/`set` dell'area 2); i titoli e i corpi
  salvati delle notifiche diverse da `task.assigned` e `planning.changed`,
  in inglese anche in it; i nomi degli stati nelle righe d'attività
  («stato: Idea → Published»), che sono dati del progetto.

### Dall'ondata finale (2 nov 2026)

Lasciati aperti, ognuno col suo motivo:

- **M4: il ramo Chat di `settleProposal` esegue tutto il catalogo, senza
  classe né motivi.** Una proposta di @Claude con `deleteTask`,
  `archiveProject` o `removeMember` non direbbe «Can't be undone» né
  «Notifies …». *Perché resta*: latente, il motore della Chat non le
  produce; il fix è un insieme esplicito di `fn` della Chat (come
  `MAIL_FNS`), da fare quando il motore della Chat cresce.
- **M5: «Annulla» di una task creata non vede i collegamenti messi dopo da
  altri.** Marco segna la sua OLV-4 figlia di OLV-9 (creata da Claude per
  Giulia): il collegamento si salva su OLV-4, `laterChangeOf` non lo vede e
  l'«Annulla» elimina OLV-9 col collegamento. *Perché resta*: di bordo; il
  fix (contare in `writesOn` le attività `links` delle altre task che
  nominano la task, o rifiutare l'inverso `deleteTask` se
  `getTaskDeletion` ha figlie o collegamenti) tocca il «com'era», da fare
  col motore.
- **M6: i due esecutori quasi gemelli** (`settleInConversation` e il ramo
  Chat di `settleProposal`). *Perché resta*: refactor, col 10b.
- **`planning.changed` a chi PERDE la task dice «… planned OLV-1 for
  W45».** La frase composta (con Claude e ora anche a mano) parla della
  settimana, non del passaggio a un altro: per chi la perde è imprecisa.
  Si vede nel seme (la notifica a Marco dell'«Annulla» confermato). *Perché
  resta*: la frase è del T11; serve un valore stabile in più (a chi è
  andata), da decidere con la regola di R-G5 sul nome.
- **La settimana nei parametri delle frasi di Claude si salva nella lingua
  di chi chiede** (`summaryText.params.week` = «S44»): riletta in un'altra
  lingua resta «S44». *Perché resta*: come il resto dei parametri (titoli,
  nomi), la conversazione è di chi l'ha scritta; un parametro numerico con
  la lettera nel modello cambierebbe tutte le chiavi delle risposte.
- **«Annulla l'azione» per l'Undo in it** (bloccante 4 di Impeccable):
  scelta del controller nell'ondata finale, **confermata dal maintainer il 2 nov 2026**. Lo shape
  (claude-actions.md §7) voleva «Annulla» per Cancel e Undo «mai insieme»,
  e negli scatti stavano insieme. *Se sbagliata*: tre stringhe.
- **La convenzione «W» in en e «S» in it vale ora per tutta l'app**
  (`shortWeekIn`), pagine dell'area 2 comprese (task, timeline, planning,
  la mia settimana). *Se sbagliata*: una chiave (`week.short`).
- **Un «Annulla» passato dalla scheda avvisa** (la scheda lo ha detto),
  anche chi riceve di nuovo una task o la perde. *Se sbagliata*: il
  ruling chiedeva solo che non parta da solo; la conferma silenziosa
  renderebbe falsa la riga «Notifies» della scheda.

### Decisioni del maintainer (2 nov 2026)

Le domande del piano:

- **Le impostazioni d'istanza nel catalogo**: tutte le scritture del 9b che
  non portano segreti; le +R sono classe C.
- **«Modifica» solo dove il dialogo vero esiste già**: `createTask` e
  `createRequest`.
- **Le conferme di @Claude nella Chat portano «Claude on behalf of …»**
  nel registro e nelle notifiche; le regole dell'area 4 restano (tutto
  proposte, niente «Annulla» in Chat).
- **Un'azione A eseguita non mostra un toast**: bastano la riga e la voce.
- **«Elimina task» a mano**: dialogo col bottone rosso, senza codice da
  scrivere né riconferma.
- **Assegnare una task avvisa chi la riceve** (`task.assigned`), da una
  persona o da Claude per conto di qualcuno; non chi si assegna da solo.

### Decisioni del controller da confermare

Sulle domande del piano:

- **Una task non assegnata, creata da Claude senza avvisi né automazioni, è
  A**: i criteri del design sono solo due. *Se sbagliata*: una scheda in più
  per ogni task senza assegnatario.
- **Filtro, lingua e tema lato pagina → 10b.** *Se sbagliata*: il 10a non
  ha una parte che il maintainer voleva subito.
- **«Notifies» con persone che chi chiede non vede → «… and others who
  follow this in AUD»**, mai un numero. *Se sbagliata*: una frase.
- **Note accettate**: il nome del seme è Matteo **Conti**; la frase
  dell'atterraggio di Claude si sostituisce ([CP 9]); «Ask Claude… ⌘J» nel
  menu dell'app ([CP 7]). *Se sbagliata*: testi.

I ruling del pre-flight (P1–P26) e dei task, uno per riga:

- **P1, P2** la voce del seme e «Undid:» come in `claude-trace.md`;
  corretto al T11 sul template vero («turned off the weekly brief in MKX.»
  + «Weekly brief: On → Off»). *Se sbagliata*: stringhe attese nei test.
- **P2 (ruling 2)** la voce di un «Annulla» è l'inversa col prefisso + la
  riga «Undid: … · data». *Se sbagliata*: rifare `ChangeEntry` e il suo
  test.
- **P3** le scene con Marco in OLV, `saveProjectAutomations` su MKX. *Se
  sbagliata*: seme e test da spostare di progetto.
- **P4** il «com'era» per `seq`, escludendo il gruppo. *Se sbagliata*: campi
  `seq` in più su attività e registro.
- **P5** `createTask` del catalogo con `createTaskAs`, segnali delle
  automazioni trattenuti fino al gruppo riuscito. *Se sbagliata*: conteggi di
  avvisi ed esecuzioni nelle suite dell'area 3 da aggiornare.
- **P6** `FailureCode` con `busy`/`reauth_required`, `Applied` con
  `reasons`, `catalogRuns` e `after`. *Se sbagliata*: una firma più larga per
  la Posta.
- **P7** `applyActions(me, actions, { catalogOnly })`. *Se sbagliata*:
  un'opzione dimenticata riaprirebbe la strada laterale (coperto dal test
  RF3).
- **P8** = decisione del maintainer su `task.assigned`. *Costo* (ledger):
  un `notification_kind` nuovo e i conteggi di notifiche da aggiornare in
  più suite.
- **P9** `planTask` è B quando avvisa qualcuno. *Costo* (ledger): qualche
  spostamento in più chiede la scheda.
- **P10** i tipi del catalogo nella foglia `data/claude/types.ts`. *Se
  sbagliata*: un file in più.
- **P11** `neverInCatalog` cerca riferimenti di codice, non parole. *Se
  sbagliata*: un riferimento dinamico sfuggirebbe.
- **P12** il test «nessuna API accetta `via`» guarda il tipo `ViaClaude`.
  *Se sbagliata*: un parametro con un tipo diverso non sarebbe coperto.
- **P13** `expectNoDeploy` in `ExecutedRow.test.tsx`, con la riga D resa.
  *Costo*: nessuno.
- **P14** `palette/commands.test.ts` aggiornato nel T8. *Costo*: nessuno.
- **P15** il test sulle `…As` controlla che il risultato non sia una
  Promise. *Costo*: nessuno.
- **P16** `ChangeEntryView` senza `undoOf`/`claudeActionId` per spread.
  *Costo*: nessuno.
- **P17** `DeletedTask.via` nel T3. *Costo*: nessuno.
- **P18** `RecordDecisionDialog` con la prop `taskId`. *Costo*: una prop.
- **P19** `whoAction` `string | null`; i traguardi su `editTasks`, nuova
  solo `commentTasks`. *Costo*: nessuno.
- **P20** la voce di menu «Ask Claude» con la guardia `aria-modal`. *Costo*:
  nessuno.
- **P21** `runAsClaude` in `settleProposal` per ogni posto. *Se sbagliata*:
  per qualche task la conversazione ha il segno prima dell'«Annulla».
- **P22** i percorsi del T11 in `pages/projects/`. *Costo*: nessuno.
- **P23** test per [CA 6], [CA 3] e «Didn't run … · Who?». *Costo*:
  nessuno.
- **P24** Claude collega non elimina una task non sua, e `whoCan` non lo
  include. *Costo*: nessuno.
- **P25** `ConversationDetail.undo` facoltativo. *Costo*: nessuno.
- **P26** la corsa «automazione accesa fra calcolo ed esecuzione» si prova
  dentro uno spy di `ctx.classify`. *Se sbagliata*: il test dipende dal
  punto in cui `freeTurn` ricalcola.
- **(pre-flight)** quando `planTask` riassegna, il nuovo assegnatario
  riceve solo `task.assigned`, non anche `planning.changed`. *Se
  sbagliata*: un avviso in meno.
- **(T2)** una PR aperta della pipeline senza repo né numero conta come
  `busy`, e il dialogo dice la frase senza numero. *Se sbagliata*: solo una
  frase più generica.
- **(T3)** `task.assigned` non parte per una task creata da un'automazione
  né se l'assegnatario è Claude; `reassignTask` alla disattivazione avvisa
  chi riceve. *Se sbagliata*: un avviso in più o in meno.
- **(T3 I1)** `convertRequestAs` corretto subito, il `createTask` di
  `applyActions` chiuso al T4. *Se sbagliata*: nessuno, il test c'è.
- **(T4)** il budget di `retryJob` si controlla in `openRunAs`, `launchRun`
  resta com'è. *Se sbagliata*: una sessione resterebbe in attesa invece di
  essere rifiutata.
- **(T4)** tolta la regola «`updateTask` su una task non di chi chiede = B»:
  la classe dipende solo da avvisi e automazioni. *Se sbagliata*: modificare
  la task di un altro senza avvisi parte subito (ma si annulla).
- **(T5)** l'«Annulla» di una task creata scrive `task.deleted` col segno ma
  senza `undoOf`. *Se sbagliata*: serve una voce `task.created`.
- **(T5)** sopra una scheda B vale la frase dello shape («I'm asking first:
  <motivo>»). *Se sbagliata*: una frase da rimettere.
- **(T6 I1)** senza `decisions.record` la riga D non promette il link: lo
  dice in parole, con «Who?». *Se sbagliata*: solo una frase.
- **(T8)** a 1024 resta a vista la colonna: il riquadro si stringe allo
  spazio libero (320, mai sotto 300). *Se sbagliata*: si sacrifica la
  colonna.
- **(T9)** i link `#/admin/…` delle righe D solo se chi legge apre quella
  sezione. *Se sbagliata*: solo lavoro in più.

## Area 10b — minori aperti

Parità e copertura: `area10-parity.md`. Le invarianti da riscrivere prima del
motore sono §16 (le bozze di Claude), §17 (le automazioni scritte da Claude)
e §18 (le risposte sui dati non contano né sommano l'invisibile), sotto
«Invarianti del CLAUDE.md da riscrivere prima del motore». Qui: le scelte del
costruttore del piano, le decisioni del maintainer, i ruling del controller
sui Task 1–12 (accettati, rimandati, limiti), i limiti documentati del
Task 12, i minori rimandati alla revisione finale e le decisioni D1–D4.
Ognuna delle scelte ha il suo costo se è sbagliata. Dettaglio per task:
`.superpowers/sdd/2026-11-02-desktop-area10b-plan/task-N-review.md`.

### Scelte del costruttore del piano

- **La prova non è una voce del catalogo.** Non scrive nulla da annullare,
  quindi non ha inverso, e una voce A senza inverso violerebbe il test del
  registro del 10a; la esegue `freeTurn` dopo il gruppo. *Se sbagliata*: la
  prova non compare nel registro di Claude né si annulla, e un'azione che
  produce effetti veri non potrebbe passare da lì.
- **Due domande per richiesta, al massimo** (progetto, poi reparto): dopo
  la seconda il riquadro dice cosa manca in una riga invece di chiedere
  ancora. Il contatore riconosce la richiesta dal prefisso del testo (T4
  m2) ed è per richiesta (`freeRequestOf`/`continues` in
  `api-mutations.ts`), non per intento: regge anche ora che a fare domande
  sono due intenti, l'automazione (progetto, reparto) e il membro (persona,
  ruolo). *Se sbagliata*: una conversazione chiederebbe tre cose in fila, o
  una richiesta cambiata a metà farebbe contare male.
- **La Chat (@Claude) non ha un clic su S0**: l'elenco delle nove voci è
  testo, senza bottoni né frasi nella casella; `trial`, `draft` e
  `pageAction` non nascono lì e c'è una riga che rimanda al riquadro (P11).
  *Se sbagliata*: chi chiede dalla Chat fa un passo in più.
- **La memoria del «prima» delle azioni della pagina** (filtro, lingua,
  tema) vive in memoria nel riquadro, non nel dato: dopo un ricaricamento la
  riga dice «Can't be undone anymore» (T9, T10 m2). *Se sbagliata*: un
  «Undo» che sopravvive al ricaricamento chiede un posto dove tenere il
  valore di prima.
- **L'ipotesi di S2 solo per `idle` senza settimana** («Maybe it fell out
  of planning: it has no week»). *Se sbagliata*: una causa plausibile resta
  non detta, o una ipotesi si afferma dove il dato non la dimostra.
- **L'«Annulla» di un `removeMember` diventa una scheda** *(ruling del
  controller (pre-flight), P7)*: annullare un `removeMember` rimette la
  persona nel progetto, e D4 fa avvisare `addMember`, quindi l'«Annulla»
  chiede conferma come una scheda. *Se sbagliata*: un «Annulla» in più che
  chiede conferma.
- **«Testo generato» non usato**: nessun intento del prototipo scrive un
  riassunto lungo. *Se sbagliata*: serve un intento che lo scriva, e il
  tipo di bozza che lo porta.
- **Il messaggio della Chat fuori dai campi delle bozze** (D1): la Chat non
  è un campo; una bozza non entra mai nella casella di un messaggio. *Se
  sbagliata*: «scrivi la risposta» dalla Chat non produce niente di
  visibile.

### Ruling del controller sui Task 1–12

Ognuno col suo costo se sbagliato (una riga per voce; il testo intero è nel
registro del piano).

- **(T1)** Davide entra in ACQ e l'eccezione alla parità di
  `effective.test.ts` vale solo per i guadagni attesi di `p-davide|prj-acq`,
  non per le perdite. *Se sbagliata*: si usa un'altra persona del Support.
- **(T1 I3)** Laura in LNT con `support.reply` dal reparto Development è una
  coppia attesa. *Se sbagliata*: si cambia il seme, non la regola.
- **(P1)** ORT/SPZ/LNT/BSC esclusi dalla parità di `effective.test.ts`: un
  progetto nuovo sfugge al confronto. **(P2)** `ValidateContext.departmentSees`
  facoltativa: un chiamante che dimentica di passarla non lo segnala.
  **(P3)** dal riquadro non nasce un'automazione generale
  (`projectId: null` rifiutato). **(P4)** un'eccezione al «Who?» in più
  (filtri salvati con `whoAction` null). **(P5)** tipi lontani dal loro
  calcolo (`model.ts` non importa da `domain/`).
- **(P6)** `oldest.reason` è lo `StallReason` intero, più `thresholdDays`:
  un campo in più da filtrare per R-G5. **(P8)** i casi «sé stesso» e
  «Claude» di `member.added` si provano su `memberAddedRecipientOf`: la
  regola non è provata end-to-end. **(P9)** `inviteProject`, `inviteRole`,
  `sim` nel router: tre parametri da validare. **(P10)** S2/S3, archivio,
  membro e pagina si riconoscono dopo `refused` e prima dei comandi: una
  frase di creazione può essere presa per un intento nuovo.
- **(P16)** S2 ristretto al progetto del contesto e nessun suggerimento a
  budget esaurito: una domanda generale fatta dall'Overview riceve una
  risposta ristretta. **(P17)** `openSimId` null apre `/edit`, `filteredOut`
  senza «Turn on», menu dell'urgenza: tre stati UI in più da provare.
  **(P18)** per ciò che il motore non sa fare si costruisce il resto e si
  nomina `notify` a parole: chi voleva l'avviso deve chiederlo. **(P19)** RF2
  riscritto: Giulia non vede gli altri, Laura ne vede uno che non gestisce.
  **(P21)** «questo filtro» è l'ultimo `pageAction` `filter` `done` della
  conversazione: un filtro fatto a mano non si salva da Claude. **(P22)** in
  T9 il runner esegue solo i `pageAction`. **(P23)** `NotifyPlan.personIds`:
  più file toccati. **(P24)** `freeResume` riceve il `cut` di «Ferma».
  **(P25)** `member.added` anche per le aggiunte dalla posta (`writeJoin`):
  più notifiche dalla posta. **(P26)** «Save again» / «Salva di nuovo» al
  posto di «Retry»: `test/noDeploy.ts` vieta «riprova»; una parola diversa dal
  resto dell'app.
- **(T2 ⚠️)** le etichette dei campi seguono la lingua di chi legge
  («Urgency»/«From support» in en, «Urgenza»/«Dal supporto» in it). *Se
  sbagliata*: solo stringhe.
- **(T3)** l'inverso di `saveAutomationDraft` su un'automazione accesa senza
  bozza è `deleteAutomationDraft`, non un risalvataggio identico. *Se
  sbagliata*: una riga in `catalogMore.ts`.
- **(T4 ⚠️)** la ripresa dopo una scheda di scelta conta come un turno
  «chat» nei consumi. *Se sbagliata*: il conteggio raddoppia per le richieste
  con domanda.
- **(T5)** le frasi di Claude nella conversazione restano testo nella lingua
  di chi ha chiesto; la regola «en/it composti in lettura» vale per UI,
  registro, notifiche ed eventi strutturati. *Se sbagliata*: serve un evento
  strutturato per ogni frase.
- **(T5 I2)** `request_created` non ha un indirizzo del cliente: Claude non
  aggiunge il passo email e lo nomina a parole. *Se sbagliata*: serve un dato
  «email del cliente» sulla richiesta.
- **(T6)** `thresholdDays` = `activeDays`; S2 ristretto dà la frase del
  progetto singolo senza elencare le task; `#/projects?view=stalled` è un
  indirizzo nuovo. *Se sbagliata*: solo frasi o una rotta.
- **(T6 I1)** un solo controllo «è una domanda come-si-fa» condiviso da
  tutti i riconoscitori nuovi. *Se sbagliata*: ogni intento ripete
  l'esclusione.
- **(T7)** S4 senza candidati: righe di testo di Claude con un «Who?» per
  codice (Q1); link di invito solo a chi può invitare (Q2); riga `member.added`
  nel seme (Q3); la riga del seme è Stefano in AUD (m4). *Se sbagliate*: T11
  disegna note senza scheda, un link in più, una notifica in più nell'inbox
  di Davide.
- **(T8)** `freeReply` non discriminato (difesa in profondità); il «Who?» delle
  note è chi fa il merge; la frase della Chat accettata. *Se sbagliate*: un
  giro in più.
- **(T9 I2)** il runner si monta anche nella pagina intera della
  conversazione; un `pending` vecchio (seguito da un altro messaggio di una
  persona) si chiude `failed`. *Se sbagliata*: un'azione può partire in
  ritardo senza messaggi successivi.
- **(T9)** M2 accettato (azione idempotente), «Show» dopo `changed_after` e
  la chiave `page.private` ratificati. *Se sbagliati*: un giro più lungo.
- **(T10)** m2 «Undo» solo a pagina aperta e «Show» che naviga (emendamento
  in `claude-drafts.md`); m3 `changed_after` immediato accettato; m10 Matteo
  negli scatti accettato. *Se sbagliati*: un «Undo» che sopravvive al
  ricaricamento, o scatti con un'altra persona.
- **(T11)** concern (a): se nessun esempio passa, D2 atterra su `/edit` col
  costruttore sotto il pannello (emendamento in `claude-automations.md`);
  concern (b) conforme a §6; m2 e m5 accettati come documentati. *Se
  sbagliato*: l'atterraggio di D2 per quel caso.
- **(T12)** i limiti 1–4 qui sotto accettati come documentati; la voce
  `ThemeProvider` qui sotto aperta. *Se sbagliati*: vedi ciascuno.
- **(T13, Consumi)** la riga «Claude can help you…» di Consumi compare per
  chi ha `usage.view` anche sull'istanza vuota: lo shape
  `claude-suggestions.md` la vuole «sempre», e il «nessun suggerimento
  compare» del brief del T13 era impreciso. *Se sbagliata*: una riga che
  offre il riassunto di una spesa di $0.

### Decisioni del maintainer (5 nov 2026)

- **Sul Supporto, con una bozza di Claude già pronta la riga di suggerimento
  non compare** (Impeccable 8): «Claude prepared a draft · Use draft» è già
  la proposta per quella risposta. La regola sta in `suggestionFor`
  (`data/claude/suggestions.ts`), provata in `suggestions.test.ts` e
  `ClaudeSuggestionRow.test.tsx`; la pagina non la ricalcola. ACQ-S2 nel
  seme ha la bozza, quindi lì la riga non c'è finché la bozza non è usata;
  ACQ-S7 aspetta noi senza bozza, ed è lì che la riga si vede (scatti
  `a10b-sugg-support*`, senza più toccare il seme a mano). *Se sbagliata*: chi
  vuole chiedere a Claude qualcosa di diverso dalla bozza pronta passa dal
  riquadro.
- **S3 oltre cinque progetti resta senza link «apri l'elenco»**
  (`spend.ts`, «and N more»): non c'è una pagina che elenchi la spesa per
  progetto a chi non ha `usage.view` (solo Impostazioni → Consumi di ogni
  progetto), e un link prometterebbe un elenco che non esiste. *Se
  sbagliata*: chi vuole il dettaglio apre i progetti uno per uno.
- **Una seconda conversazione in attesa senza bozza — corretto (5 nov
  2026)**: ACQ-S7 (Marta Colombo, dal widget, richiesta ACQ-R5 `medium`,
  Davide ha già risposto una volta) è `waiting_us` senza `claudeDraft`, e
  mostra la riga «Claude can help you write the reply». Conteggi del
  Supporto e di «Customers waiting» aggiornati (due in attesa, S2 prima
  perché aspetta da più tempo). *Se sbagliata*: la Home di chi ha
  `support.reply` in ACQ mostra due clienti in attesa invece di uno.

### Dalla ri-revisione finale (5 nov 2026)

- **`CreatedAutomation` mostra il codice spento finché `useAutomations` non
  carica — corretto (5 nov 2026)**: mentre l'elenco carica il codice è
  neutro (inchiostro pieno, sottolineatura trasparente, nessun «You can't
  open this»), poi link o spento secondo il dato
  (`CreatedAutomation.test.tsx`). *Se sbagliata*: un attimo di codice senza
  link prima che arrivi.
- **La riga «Used:» del riquadro a 1440 può lasciare un « ·» in fondo a una
  riga andata a capo — corretto (5 nov 2026)** (`UsedLine`, scatto
  `a10b-scen-s4-light-en`): il «·» sta in coda al suo pezzo e si spegne
  (`visibility`, stessa larghezza, quindi l'a capo non cambia) quando il
  pezzo dopo è sulla riga sotto; misurato all'avvio e a ogni
  ridimensionamento della riga (`UsedLine.test.tsx`). Non il contenitore che
  taglia della testata della prova: le anteprime dei codici ne escono. *Se
  sbagliata*: in fondo a una riga resta uno spazio vuoto largo quanto « · ».

### Voci del registro del piano che mancavano (revisione finale)

- **(P13)** `mailBody` lo dichiara la pagina della conversazione, e `put`
  apre «Reply». *Se sbagliata*: una bozza può aprire una risposta che la
  persona non aveva aperto.
- **(P14, P15, P20)** la fixture senza i campi nuovi è `PrPanel`/
  `ReleaseDetail`; `canEditReleaseNotes` sta in `releases/visibility.ts`;
  `getUsage` usa `groupBy: "project"` nel test. *Se sbagliate*: nessun costo.
- **(T9)** «nessun test che due runner scrivano una volta»: **chiusa** nella
  revisione finale (`pageActions.test.tsx`, due runner montati prima del
  messaggio: una chiusura e un cambio di lingua; `fillable.test.tsx`, la
  bozza entra una volta). *Se sbagliata*: un doppio runner scrive due volte.
- **(T10)** tre test scritti dopo il codice, verificati per mutazione. *Se
  sbagliata*: uno dei tre potrebbe passare per il motivo sbagliato.

### Limiti documentati del Task 12

- **[SG 6] tiene il testo non inviato della vecchia conversazione solo in
  memoria, come testo semplice**: i token `#`/`@` tornano a essere parole e
  un ricaricamento perde il testo. *Se sbagliata*: chi apre un suggerimento
  con una bozza a metà la ritrova senza `#`/`@` strutturati, o non la
  ritrova affatto.
- **Con `fresh`, il testo scritto in una conversazione nuova non ancora
  inviata viene sostituito dalla richiesta del suggerimento.** *Se
  sbagliata*: una frase digitata si perde.
- **Nessuna proposta del polso è nel seme**, quindi il «mai se» dell'Overview
  è provato dai test (`suggestions.test.ts`) ma non si vede nell'app.
  *Se sbagliata*: la regola potrebbe non funzionare quando le proposte
  arrivano dal worker vero e nessuno lo scoprirebbe dal prototipo.
- **Su una PR, anche una richiesta di decisione aperta fra persone nasconde
  la riga** («Write the release notes»): il «mai se» guarda `openDecisions`
  della task, non solo i piani e le domande di Claude. *Se sbagliata*: la
  riga manca in un caso in cui sarebbe utile.

### Test da rivedere

- **`theme/ThemeProvider.test.tsx` spia `Storage.prototype`**
  (`getItem`/`setItem` nel caso «un localStorage che lancia»), ma in
  happy-dom `window.localStorage` non passa da quel prototipo: il test
  potrebbe non provare ciò che dichiara (un `localStorage` che lancia non
  rompe niente). *Costo se sbagliata*: la copertura del fallback del tema
  è solo apparente. Da verificare facendolo fallire apposta (come nella
  nota del CLAUDE.md sui test che passano per il motivo sbagliato).

### Minori rimandati alla revisione finale (aperti, non corretti nel Task 13)

- **Tre regex quasi uguali per «come si fa»**: `parse.ts` `HOWTO_QUESTION`,
  `intents.ts` `HOWTO`, `intents/howto.ts` `HOWTO_LEAD` (T6). *Se non si
  uniscono*: un'altra frase entra in una e non nelle altre. **Corretto nella
  revisione finale**: una fonte sola dei verbi, `HOWTO_VERBS` in `parse.ts`.
- **Una prova fallita dice «would fail before the end»** senza passo né
  motivo, perché `TrialOutcome` non ha quei campi (T5). *Se sbagliata*: la
  persona non sa dove correggere senza aprire la prova.
- **`SourcePanel.tsx` e `builder/issues.ts` leggono ancora `f.label`**, con
  le etichette in italiano anche in en («Titolo della richiesta») (T2). Il
  terzo punto, `FlowSummary.tsx`, è stato sistemato. *Se sbagliata*: un
  testo in italiano in una pagina inglese. **Corretto nella revisione
  finale** per i dati della richiesta che S1 usa (`localFieldLabel`); gli
  altri inizi restano con le etichette del dato (area 7).
- **A 1024 con l'anteprima chiusa il riepilogo «If this were real» non sta
  nella colonna del flusso** (T11). *Se sbagliata*: a 1024 una parte della
  prova non si legge.
- **Lo spacer lascia un vuoto quando l'anteprima sovrapposta sposta il
  pannello** (T11).
- **Il rientro delle righe di S2 a capo varia di pochi px in `narrow-it`**
  (T11).
- **`data/queries.ts` e `data/queries/instance` si importano a vicenda**
  (T12, import circolare): oggi funziona, ma cambia l'ordine di
  inizializzazione se uno dei due esegue qualcosa all'import. **Corretto
  nella revisione finale**: la riga di Claude sta in `data/queries/claude.ts`,
  e `architecture.queries.test.ts` lo tiene.
- **Altri minori**: `task-N-review.md` di ogni task, la sezione «Minor».
  Fra quelli con un'indicazione: T1 (`seed.10b.test.ts` non nomina la
  conversazione di posta di Giulia; duplicazione fra `projectActivity.test.ts`
  e `seed.10b.test.ts`), T2 («Test started» per una prova che non è
  partita), T3 (`saveAutomationDraft` senza controllo
  del flusso; chiavi `claude.trial.example*` senza lettori), T4 (una ripresa
  che trova il `cut` cambiato ritorna in silenzio), T5 (`catch {}` della
  prova ingoia l'errore; «Ferma» fra calcolo e riga lascia `testedRev` senza
  riga; l'email in testa a una richiesta finisce nel rifiuto D dell'invio),
  T6 (S3 `projects` oltre 5 righe senza link «open the list»), T7 (`spoken` e
  i parametri data ISO; etichette uguali nella scheda di scelta), T8
  (`withTailGesture` divide su e/and ovunque), T9 (tema da `localStorage`;
  runner smontato durante l'`await`), T10 (`data-ask-first` senza test
  diretto; campo occupato da «Ask Claude» → T11/final), T11 (m1 è la
  seconda voce di questo elenco, la prova fallita senza passo né motivo; m4
  è la terza, `f.label`).

- **Esito della revisione finale (5 nov 2026)**: corretti i punti 1–8 di
  `final-review.md` (le tre regex «come si fa» in una fonte sola, il fuoco
  nella casella di Claude in tutti e quattro i punti, l'import circolare,
  `f.label` per i dati della richiesta di S1, il «Who?» nella Chat, il test
  dei due runner, `__resetFillableForTest` usato, «ad» e i livelli
  dell'urgenza in un posto solo), più P1–P3 della revisione Impeccable.
  Restano aperti, coi motivi di `final-review.md`: la prova fallita senza
  passo né motivo, i tre minori di layout del T11 (1024 a anteprima chiusa,
  spacer, rientro in `narrow-it`), T1, T2 «Test started», T3, T4, T5, T7,
  T8, T9 tema/smontaggio, T10 `data-ask-first`, T11 m5, `ThemeProvider` e
  i limiti 1–4 del T12; la frase dell'esito della prova scritta due volte,
  il parsing del codice di rotta e `plainName` duplicati, e le etichette
  degli altri inizi in italiano (modello dell'area 7).

### Decisioni del maintainer (2 nov 2026)

- **D1 — i campi delle bozze sono quattro**: risposta di supporto, note di
  rilascio, corpo dell'email e descrizione di una task; la Chat resta
  esclusa. Il corpo dell'email resta una bozza (inviare è un gesto della
  persona, classe D); la descrizione nel campo aperto è classe A e diventa
  una modifica solo quando la persona salva. §16.
- **D2 — finita la prova, Claude apre da sé il costruttore**, col riquadro
  aperto e «Back to <pagina>»; la pagina lasciata ritrova indirizzo e
  scorrimento, i testi non salvati restano dove la pagina li tiene già.
- **D3 — il filtro sta sull'inizio**, e la prova (anche a mano) dice
  «Wouldn't start» / «Non partirebbe» quando il filtro non passa.
- **D4 — `member.added`**: «You've been added to ACQ as Developer» / «Sei
  stato aggiunto ad ACQ come Developer». Parte quando una persona aggiunge
  qualcuno e quando lo fa Claude per conto di qualcuno; non parte per chi
  aggiunge sé stesso. En e it, test propri, «Undone by …» derivato a
  lettura. Per il motore è un `notification_kind` nuovo, con la sua regola di
  rollback (`area10-parity.md`).
- **Accettate** anche le scelte del costruttore del piano, i quattro shape
  del Task 0 (S0 a nove voci, «Non ora» per oggetto, l'origine «Created by
  Claude on behalf of …» che resta, «Ask Claude» nel Supporto, `codes` sulla
  nota `not_manageable`, ⌘J al riquadro).

## Area 11a — minori aperti

Parità e copertura: `area11-parity.md`. Le invarianti da riscrivere prima del
motore sono §19 (il corpo di una pagina di prodotto: id stabili, ancore,
segni) e §20 (il solo canale `file:save`), sotto «Invarianti del CLAUDE.md da
riscrivere prima del motore»; la §21 (decisione 1 della spec, l'apertura di
email e riunioni private nella doc) la scrive il piano 11b prima del
motore, e qui resta il promemoria. Qui: le scelte del costruttore del piano,
i ruling del controller sui Task 1–12, i minori rimandati alla revisione
finale, ciò che va verso il 11b, e in fondo le decisioni del maintainer.
Ognuna delle scelte ha il suo costo se è sbagliata. Dettaglio per task:
`.superpowers/sdd/2026-11-05-desktop-area11a-plan/task-N-review.md`.

### Scelte del costruttore del piano

- **Nessuna libreria d'editor: un `contenteditable` controllato per blocco,
  con `beforeinput` e il ridisegno dal modello.** Il modello (`RichText` per
  blocco) è la verità e il DOM si ridisegna da lì; ProseMirror, Slate o
  TipTap avrebbero un modello proprio da far coesistere con gli id stabili,
  i commenti ancorati e le operazioni di Claude del 11b. *Se sbagliata*: il
  caret, l'IME e il correttore vanno rifiniti a mano (il codice sta in
  `pages/productDocs/editor/`, `BlockEditor.tsx` ha più di 850 righe); il
  motore vero sul web potrebbe voler una libreria, e portare gli id stabili
  dentro costa più di averli fin dall'inizio.
- **⌘K resta alla palette; il link si mette solo dalla barra della
  selezione.** ⌘K è già «Search and commands» in tutta l'app, e un editor che
  se lo prende sul testo avrebbe due significati. *Se sbagliata*: chi viene
  da Notion o Google Docs preme ⌘K sul testo e apre la ricerca; costa un
  gesto e una frase nel tooltip, non dati.
- **L'incolla tiene solo grassetto, corsivo e link** (`richFromHtml`: legge
  anche `style` per Google Docs e ignora l'involucro `docs-internal-guid`;
  Office ha un suo frammento). Titoli, elenchi nidificati e tabelle
  incollati diventano paragrafi. *Se sbagliata*: una pagina portata da Google
  Docs perde titoli e tabelle e va rifatta a mano; il frammento di prova è
  scritto a mano, non catturato (vedi «Da fare a mano»).
- **Una revisione per sessione dell'editor** (le scritture della stessa
  sessione si uniscono: primo `before`, ultimo `after`, `last_seq` per
  l'ordine; una scrittura con fonte non si unisce mai). Una cronologia con una
  riga per tasto sarebbe illeggibile. *Se sbagliata*: «cosa ha scritto chi» è
  meno fine, e «Annulla» del 11b (che usa `touchedAfter` sull'ultima
  scrittura) lavora su pezzi più grossi.
- **Niente modifica né eliminazione dei commenti**, uno per uno. Si risolvono
  e si riaprono. *Se sbagliata*: un refuso nel commento resta; il 11b che
  vorrà modificarlo avrà bisogno di un `commentId` nella notifica di
  menzione (oggi tiene la radice del filo), e il testo salvato della card
  potrebbe non essere più quello di adesso.
- **Niente «Ripristina» nella cronologia**: si legge «Before» / «After», non
  si torna indietro. ⌘Z copre la sessione corrente. *Se sbagliata*: chi
  sbaglia ieri non ha un gesto per tornare; il 11b ha «Annulla» solo per le
  modifiche di Claude.
- **Una pagina con sottopagine non si elimina** (`invalid: has_children`;
  «Delete» spento con la sua frase, senza «Who?»). *Se sbagliata*: per
  eliminare un ramo si elimina foglia per foglia; l'alternativa (eliminare a
  cascata o riattaccare le figlie) è una scelta di prodotto con un costo
  d'errore alto.
- **La chat di un repository non cita le pagine di prodotto** (la fonte
  «from Product» c'è solo nella chat del progetto). *Se sbagliata*: una
  domanda fatta dal repository non vede la doc scritta a mano; si apre la chat
  del progetto.
- **La serie `-D` è condivisa** fra i Docs dei repository e quelli di
  prodotto (`initialDocCodeSeq()` legge `DOC_PAGES` **e** `PRODUCT_PAGES`,
  P3). *Se sbagliata*: i codici di un progetto saltano numeri quando le due
  specie si mescolano; il contrario (due serie) avrebbe due `ACQ-D5` e
  `resolveCodes` aprirebbe la pagina sbagliata.
- **Il nome `product` è riservato** per i repository (`name_reserved`), e la
  categoria «Product» dei Docs dei repository è «Product overview» /
  «Panoramica di prodotto» *(maintainer, 5 nov 2026, P26)*. *Se sbagliata*:
  due «Product» fianco a fianco nella stessa sezione e nei risultati di
  ricerca; un repository già chiamato «product» nel motore andrebbe
  rinominato in migrazione.
- **Il WebP resta fuori dal Word**: PNG, JPEG e GIF entrano con le loro
  dimensioni lette dai byte d'intestazione; un WebP o un SVG esce con la sola
  didascalia, e l'avviso finale dice «1 image was left out of the Word file».
  *Se sbagliata*: un Word con immagini mancanti; il PDF le ha tutte.
- **`docx` solo con uscite senza `Buffer`** (Blob o ArrayBuffer) e importato
  dinamicamente all'esportazione (P36): il renderer è `sandbox` senza Node e
  `docx` pesa. *Se sbagliata*: il Word esce in dev e si rompe impacchettato.
- **Il colore della presenza esiste solo dentro l'editor** (sei token
  `--presence-1…6`, sempre accanto al nome; «The Presence Exception» in
  `DESIGN.md`) *(maintainer, 5 nov 2026)*. *Se sbagliata*: un colore di
  persona fuori dall'editor va a cozzare con il resto del design, che non ne
  ha.
- **A 1024 la colonna dei commenti è sovrapposta, 360 dal bordo destro**; col
  pannello della task vince l'ultimo aperto, e il riquadro di Claude sta alla
  sua sinistra. A 1200 con la barra di progetto l'albero è un cassetto
  quando la colonna dei commenti è aperta (emendamento del controller,
  aritmetica di PE 20). *Se sbagliata*: sovrapposta copre la lettura, e i
  fili non sono allineati ai blocchi.
- **La colonna dei commenti a 1440 si apre da sola** se la pagina ha fili
  aperti, e il gesto a mano si ricorda per persona *(maintainer, 5 nov
  2026)*. *Se sbagliata*: chi non la vuole la chiude ogni volta.
- **Si segue solo creando la pagina o premendo «Follow»**: commentare o essere
  menzionati non fa seguire *(maintainer, 5 nov 2026)*. *Se sbagliata*:
  chi commenta non riceve gli aggiornamenti del 11b senza premere il bottone.
- **⌘Z e ⇧⌘Z fanno parte del 11a**, per pagina e per sessione dell'editor,
  sulle stesse `ProductBlockOp`, solo le operazioni della propria sessione
  *(maintainer, 5 nov 2026)*.
- **⌘Z di una cancellazione rimette il blocco con lo STESSO id**, nella stessa
  sessione (ruling del controller; è l'eccezione unica di §19). *Se
  sbagliata*: un'eccezione al «gli id non si riusano» da ricordare, ma
  perdere i commenti con ⌘Z è un errore che la persona non si aspetta.
- **ACQ ha nove pagine di prodotto** (ruling del controller: vale l'albero del
  brief, non il numero 8; codici ACQ-D3..D11, prossimo ACQ-D12). *Se
  sbagliata*: un numero nei test.
- **Gli avatar della presenza si sovrappongono di 2 px** (emendamento datato
  dello shape: la seconda iniziale resta leggibile; a 4 px ne copriva una).
- **Trascinare un blocco per ⋮⋮ sta nel Task 8** (ruling del controller:
  nessun task successivo lo copriva). *Se sbagliata*: lo spostamento resta a
  ⌥⇧↑/↓ e al menu del blocco.
- **La pulizia di un progetto eliminato** toglie pagine, revisioni, commenti,
  seguaci e presenze con `pageId` in `purge.ts` (P13); il motore lo fa con le
  chiavi esterne. *Se sbagliata*: righe orfane che `followersOf` e la
  cronologia vedrebbero come pagine che non esistono.

### Ruling del controller sui Task 1–12 (accettati, rimandati, limiti)

Dettaglio in `task-N-review.md`. I minori **rimandati alla revisione finale**
(«minor (deferred, final)») sono qui perché sopravvivano al branch:

- **Task 1**: un NBSP letterale in `richText.ts` da scrivere come escape;
  `plainTextOf` quadratico sulle tabelle; nessun test del nuovo `-S`
  `CodeLink` in `AsideRow`/`ProposalCard`. La regex dei codici unica **cambia
  la Chat e Claude** (un `ACQ-S2` diventa un `CodeLink`): voluto (P7, scelta
  (a): `ISO-8601` e `COVID-19` si leggono come codici spenti, coerente con
  R-G5).
- **Task 2**: quattro risposte diverse per un id inesistente e per uno non
  leggibile (`listProductRevisions`, follow); uno spostamento o una sessione
  annullata aggiornano `updatedAt` senza scrivere una revisione (la cronologia
  non mostra un riordino); `getProductPage` risponde `forbidden` anche per un
  codice che non c'è, per non rivelare se esiste.
- **Task 3**: `acq.ts` con `3+i` codificato; il test di `nextSeq` sul seme
  con disuguaglianza.
- **Task 4**: `comments.ts` scrive frasi inglesi in titolo e corpo a lettura
  (meglio vuoti: l'inglese in `objectGone` non arriva mai a chi legge in
  italiano); il test della card «gone» è sensibile alle maiuscole; un
  commento «ridondante apposta» su `!p.isClaude`; una menzione scritta a
  mano non è filtrata per chi il mittente vede.
- **Task 5**: `writersNear` esportato senza filtro per chi guarda (id di
  persone, mai nomi, e `docs.edit` non controllato); il `catch` muto del
  copione da loggare; il test R-G5 di `presence` non discrimina
  `visiblePeopleFor` (nessuno è invisibile nel seme); `moveProductPage` emette
  `blocks` senza uno spostamento; nessun `onAnchorsMerged` per la presenza.
- **Task 6**: nessun test del vecchio caso «ab poi a» in ⌘K; la parola
  Product/Prodotto fissata nel testo della risposta (un follow-up composto a
  lettura); nel menu `#` le pagine di prodotto vengono dopo quelle dei
  repository nel limite di 6; la palette carica gli spazi dei repository
  dentro lo spazio Prodotto.
- **Task 7**: le guardie del doppio clic (`DocsTurnedOff` in volo, target di
  General) restano bloccate se la rilettura non conferma mai; il caso `-240`
  di `treeMoves` non discrimina; `getProductSpace` forbidden/null verso il
  Task 2 da verificare nella revisione finale.
- **Task 8**: nessun avviso di modifiche non salvate all'uscita (le bozze si
  salvano allo smontaggio; un errore a pagina chiusa non si vede più);
  `undoOf` può nominare una revisione rimossa da un'unione; un `op` `invalid`
  fa cadere tutto il lotto di bozze, e il messaggio «la pagina era
  cambiata» compare anche per `invalid marks` e `block_id_taken`; la voce di
  undo di una scrittura scartata resta; `not_found` e `forbidden` ancora in
  «Retry»; ↑/↓ cambiano blocco solo con il cursore a 0 / alla fine del
  testo (niente righe visive nel prototipo, P41).
- **Task 9**: un file copiato dal Finder porta anche il nome in testo
  semplice, quindi l'incolla può inserire il nome invece dell'immagine; uscendo
  dalla tabella la cella ricordata non si azzera; il campo link in una cella
  più un clic su un altro blocco lascia due `data-editing`; l'altezza minima
  del menu tolta; una decisione appena scelta mostra lo scheletro fino alla
  rilettura (accettato, nota per il 11b); verificare `page.decisions` null
  per una decisione invisibile e `useDriveFile` vuoto per un file di un
  progetto invisibile.
- **Task 10**: `taskPanelHasText` considera non salvata anche una descrizione
  aperta e invariata; il ramo `contenteditable` non trova nulla e salta i
  valori vuoto/`plaintext-only`; la lettura del DOM del pannello è fragile
  (meglio un segnale esplicito di bozza). A 1024 i fili non sono allineati ai
  blocchi (stanno in fila); il segno del blocco sta nei 32 px di margine
  destro (`-right-8`).
- **Task 11**: l'etichetta del cursore copre la riga sopra; `savedLength`
  sposta di poco il cursore remoto; `useProductPresence` è montato due volte;
  l'avatar che esce sfuma dopo il «+N»; nessun cursore altrui dentro una
  cella (il seme non ha copioni sulle celle).
- **Task 12**: `withExtension` può sovrascrivere `X.docx` se si scrive `X`;
  nel `preview:web` il PDF chiama `window.print()` e non dà nessun avviso (non
  si può sapere l'esito); a 1024 «Export ▾» resta nella barra (Comments e
  History non vanno nel «⋯» perché ci stanno).
- **Task 13**: la palette sale a `z-50` perché la colonna dei commenti
  sovrapposta (`z-[45]`) ne copriva il bordo destro sotto i 1200 px; trovato
  dallo scatto `a11a-extra-palette-narrow-*`.

### Verso il 11b

Il 11b non cambia le interfacce del 11a (le usa e aggiunge in coda: «Cosa il
piano 11b consuma» nel piano). Da ricordare:

- **Il campo del segno a margine** non c'è in 11a (P14): il 11b lo aggiunge in
  coda, facoltativo. Un campo vuoto senza forma non servirebbe a niente.
- **`wireframe`** è il solo tipo di blocco che il 11b aggiunge a
  `ProductBlock` e a `SLASH_ITEMS`; l'esportazione (`blockOf`) dovrà
  aggiungere un caso, e le bozze di schermata escono come immagini.
- **La cronologia del 11b** aggiunge «per conto di», la fonte e «Annulla»; il
  `kind: "undo"` del 11b deve decidere come mostrare le scritture di ⌘Z, che
  nel 11a sono `kind: "edit"` con `undoOf`.
- **Il gutter destro** per il segno di Claude va ripensato: il segno del
  commento sta già nei 32 px di margine.
- **Il segnale dal vivo**: il 11b ascolti anche `blocks` (una sezione si
  libera anche con una scrittura o con la perdita di `docs.view`, senza un
  evento di presenza); `writersNear` non controlla `docs.edit`.
- **Le notifiche**: `product_doc.updated` e `product_doc.question` seguono la
  forma di `product_doc.mention` (composizione a lettura, `objectGone`).
- **La modifica o l'eliminazione dei commenti** vorranno `commentId` e corpo
  derivato a lettura.
- **La scrittura di Claude sulle ancore**: `merge` per scrittura, rifiutare un
  `insert` di un id assorbito, un gruppo TEXT/INSERT in `SLASH_ITEMS`.
- **§21**: scritta prima del motore del 11b.

### Da fare a mano, a fine area (aperti per il maintainer)

Il 11a non può chiudere da solo tre prove che vogliono una persona davanti a
una finestra vera (ruling del controller, 5 nov 2026):

1. **L'esportazione in Electron**, a mano: PDF di una pagina e dello spazio,
   Word con le immagini PNG, «Annulla» nella finestra di salvataggio, e un
   PDF **chiaro** con l'app scura. Il percorso Electron vero (`printToPDF`, la
   finestra, la scrittura, il controllo del frame) non lo esegue nessun test:
   sono coperte la validazione pura, i test sul sorgente dei canali e il
   renderer con un `saveFile` finto. *Se sbagliata la prova mancata*: il
   Word o il PDF escono rotti solo nell'app impacchettata.
2. **⌘Z dal menu Modifica di Electron** (Task 8): il `keydown` annullato non
   dovrebbe arrivare anche al ruolo `undo` del menu, ma non è stato provato
   nell'app, solo nel browser degli scatti. *Se sbagliata*: ⌘Z annulla due
   volte, o il grassetto non si mette (P18).
3. **L'incolla vero da Google Docs e dal Finder** (Task 1, 8, 9): il
   frammento HTML di prova è scritto a mano nella forma che Google Docs
   produce in Chrome, e un file copiato dal Finder può portare il nome in
   testo semplice insieme all'immagine. *Se sbagliata*: il caso d'uso
   centrale (la doc portata da Google Docs) perde i segni, o incolla il nome
   invece dell'immagine.

Gli scatti `a11a-*` non hanno prodotto lo scenario «Elena» (MKX, membro senza
la gestione di Docs): Elena non è fra le persone di «vedi come», ed è coperto
dal test di `ProductSpace.test.tsx`.

### Decisioni del maintainer (5 nov 2026)

- **Q1 — una @menzione avvisa la persona**: notifica diretta
  `product_doc.mention`, il primo dei tre `notification_kind` dell'area (gli
  altri due sono del 11b), con la regola di rollback e i cambi additivi verso
  l'app in `area11-parity.md`.
- **Q2 — grassetto, corsivo e link dentro una frase, come in Notion**: il
  testo di ogni frase è `RichText`; gli id dei blocchi restano la verità; i
  link sono solo http(s). §19.
- **Q3 — unendo due blocchi, i commenti del secondo passano al blocco
  unito**; «Frase eliminata» resta per un'ancora cancellata. §19.
- **Q4 — l'interruttore «Docs» sta in Settings → General**: spento, nasconde
  Docs e Prodotto e **tiene le pagine**; riacceso, le pagine ci sono.
- **Shape del Task 0** (approvati con la risposta consigliata): colori della
  presenza solo nell'editor; colonna sovrapposta 360 a 1024; ⌘Z / ⇧⌘Z in
  11a; la colonna dei commenti si apre da sola; si segue solo creando o
  premendo «Follow». Più le scelte del costruttore degli shape: la barra
  unica della pagina e il suo ordine (stato di salvataggio, avatar, Follow,
  Comments, History, Export, «⋯»), Invio che apre e F2 che rinomina
  nell'albero, al più una colonna a destra della lettura, il gruppo «Code»
  al posto di «Spaces» e la prima pagina radice del Prodotto in START HERE.
- **P26**: la categoria «Product» dei Docs dei repository si rinomina
  «Product overview» / «Panoramica di prodotto»; «Product / Prodotto» è solo
  lo spazio nuovo.
