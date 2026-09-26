# Una mail, più azioni e più progetti — design

26 set 2026. Il maintainer ha segnalato che quando una mail parla di più cose,
la proposta suggerisce correttamente più azioni ma ne fa scegliere una sola.
Invece ognuna dovrebbe poter diventare, per esempio, una voce di backlog, e
anche su progetti diversi.

**Il caso reale**: la mail di Calvizie del 21 set, «Audin e l'assistente AI —
cosa vede oggi e cosa mi manca». Propone tre voci di backlog, tutte giuste e
tutte diverse: uno strumento MCP per le telefonate, la ricerca delle
trattative estesa e il filtro sullo stato. Le mostra però come ALTERNATIVE:
toccandone una la card si chiude e le altre due si perdono. In produzione
**11 proposte su 53** hanno più di un'azione di creazione. Le mail che hanno
generato card su più progetti sono **2 su 48**.

Decisioni del maintainer:
1. **Selezione multipla**: le azioni proposte dal modello diventano caselle,
   tutte già spuntate; si conferma una volta e si crea tutto.
2. **Una card per progetto** (il modello della fase 6b, invariato): se la mail
   parla di un altro progetto, nasce anche la sua card. I progetti non li
   decidono più solo le regole di smistamento.
3. **Slack**: un bottone «Crea tutte (N)» accanto ai singoli. Per scegliere
   un sottoinsieme si usa l'app o il web.

## §1 — Premesse (verificate su `main` f1d3e7f6; mappa completa con i riferimenti nella sessione del 26 set)

- **Perimetro** (`apps/worker/src/google/classify.ts`). `loadContext`
  (:769-923) costruisce l'insieme dei progetti ammessi da `scopeProjectIds`,
  che viene dal routing. Solo quando è vuoto (smistamento) prende TUTTI i
  progetti (:817-827). Il prompt elenca solo i progetti ammessi e dice al
  modello che gli id non elencati vengono scartati (i18n `catalog.ts:331`).
  `revalidateProposal` li scarta davvero (:963). I test che fissano lo scarto
  sono `classify.test.ts:364, :1598, :1979`.
- **Ripartizione**: al massimo 3 proposte per progetto
  (`CLASSIFY_MAX_PROPOSALS`, :135) e al massimo 5 progetti per mail
  (`GMAIL_MAX_PROJECTS_PER_MESSAGE`, env). A valle nessuno ricontrolla il
  perimetro: una riga `email_proposals` su qualunque progetto viene
  pubblicata (`poller.ts:1474-1484`, `proposal.ts:364`).
- **Card**: `buildEmailProposalEvent` (`proposal.ts:358-406`) mette nella card
  le proposte del modello, poi «Sposta su un altro progetto», poi «Non fare
  nulla». `options[]` e `actions[]` sono allineate 1:1.
- **Risposta**: `POST /api/inbox/:id/actions/answer` →
  `answerGoogleProposal` (`apps/server/src/services/google-proposal.ts:929`),
  con `optionIndex` scalare, UNA azione (:959-975), claim con
  `propagateHandled`, `dispatchAction` in UNA transazione (:530), un outcome
  solo (`markSourceOutcome` :400). `create_backlog_item` fa solo
  `enqueueBacklogIntake(tx)`, una riga in `backlog_jobs`, senza AI nella
  transazione: N azioni stanno comode nella stessa transazione.
- **Client**:
  - web: `QuestionPanel` a scelta singola, condiviso con le domande
    dell'agente (`apps/web/src/components/question-panel.tsx:159-203`);
  - app: `GoogleProposalScreen` manda subito l'indice al tap (:205-232);
  - Slack: un bottone per opzione (`slack-blocks.ts:422-497`).
- ⚠️ **Difetto già presente su Slack**: `MAX_OPTIONS = 4`
  (`slack-blocks.ts:213`) taglia le opzioni, ma una card con 3 proposte ne ha
  5. Su Slack «Non fare nulla» sparisce, sia la riga sia il bottone.

## §2 — La regola: quali opzioni si sommano

Una funzione PURA in `@stubwise/shared`, `multiSelectableIndices(actions)`:
gli indici delle azioni proposte dal modello (`create_backlog_item`,
`create_milestone`, `update_ticket`, `comment_ticket`, `record_decision`),
solo per le card di posta, e **solo se sono almeno due**. «Sposta» e «Non fare
nulla» non ci stanno mai: sono esclusive. La chiamano sia il server per
MOSTRARE (vedi sotto) sia il server per ACCETTARE, così le due cose non
possono divergere.

**Derivata a lettura, non scritta nell'evento** (invariante del CLAUDE.md,
dall'incidente del 17 set): `readGoogle` (`apps/server/src/services/inbox.ts`)
aggiunge a `InboxGoogle` il campo `multiSelectIndices: number[]`,
`.default([])` nello schema, calcolato da `actions[]`. Vale subito anche per le
card già in inbox, compresa quella di Calvizie. I client leggono il campo e
non ricalcolano la regola. Il web lo legge con `?? []`, perché fa un cast e
non un parse.

## §3 — La risposta multipla (server)

- Il corpo della risposta guadagna `optionIndices?: number[]`, **facoltativo**.
  `answerBodySchema` e il body largo della rotta accettano esattamente uno fra
  `optionIndex`, `optionIndices` e `text`. Un'app vecchia manda `optionIndex`
  e continua a funzionare.
- Controlli su `optionIndices`: almeno 1 indice, nessun doppione, tutti dentro
  `multiSelectableIndices(actions)`. Altrimenti `invalid_answer`, e **niente
  viene scritto**: nessun claim, nessuna azione. `projectId` resta rifiutato.
- Esecuzione: UN claim (`propagateHandled`), poi TUTTE le azioni in UNA
  transazione, nell'ordine degli indici. **O tutte o nessuna**: un
  `target_gone` o un'eccezione su una sola annulla tutto, come oggi per
  un'azione singola. La card va `failed` con l'errore, e dal messaggio resta
  «Riproponi».
- Outcome nuovo `{ type: "multiple", results: [<outcome di ogni azione>] }`,
  registrato nel vocabolario di `packages/shared/src/closed-reason.ts` (c'è un
  test che lo pretende). Un `create_milestone` che esiste già conta come
  successo, come oggi.
- La nota di `mirrorDecision` elenca le etichette scelte. `record_decision`,
  se è fra quelle scelte, scrive ognuna la sua decisione, idempotente su
  `sourceKey` come oggi.
- `optionIndex` singolo su una card multipla resta valido: crea quella sola e
  chiude. È ciò che fanno Slack e le app vecchie.

## §4 — Più progetti (worker)

- `loadContext`: i progetti ammessi sono **sempre tutti** quelli dell'istanza,
  non solo il perimetro del routing. Il perimetro resta l'ordinamento: i suoi
  progetti vengono per primi nel prompt e vincono sul tetto dei 5 progetti.
  Il progetto risolto dal routing (`resolvedProjectId`) resta il valore di
  ripiego per un'azione senza `projectId`, come oggi.
- Prompt (i18n it e en): i progetti del perimetro sono marcati «matched by
  your routing rules»; gli altri «other projects». Istruzione: proponi azioni
  per un altro progetto **solo se la mail ne parla esplicitamente**, e mai
  per somiglianza di nome. Resta «usa solo gli id elencati».
- `revalidateProposal`: il controllo del progetto diventa «esiste fra quelli
  elencati». Gli altri controlli non cambiano: ticket aperto nel contesto
  caricato, data futura.
- Invariati: il percorso di smistamento (perimetro vuoto e nessun vincitore),
  la riclassificazione dopo «Sposta» (resta forzata sul progetto scelto) e la
  relazione di thread.
- I test che fissano «fuori perimetro = scartata» vanno RISCRITTI apposta:
  diventano «fuori perimetro ma esistente = card sul suo progetto» e
  «progetto inesistente = scartata». Non vanno cancellati.
- **Costo, dichiarato**: con 12 progetti ogni classificazione porta il
  contesto di tutti (10 righe ciascuno), cioè lo stesso prompt dello smistamento
  di oggi. I tetti `GMAIL_MAX_PER_DAY` e il budget mensile restano.
- **Come si verifica che serva** (dopo qualche giorno di posta nuova): le mail
  con card su più progetti erano 2 su 48; e le card su un progetto FUORI dal
  perimetro, confermate o ignorate, dicono se il modello attribuisce bene.
  Da guardare, non da automatizzare.

## §5 — I client

- **Web** (`inbox-item.tsx` e `QuestionPanel`): una modalità a caselle
  **attivata apposta**, solo quando `multiSelectIndices` non è vuoto. Le
  domande dell'agente non cambiano. Le caselle sono tutte spuntate
  all'inizio; il bottone dice «Crea N» e, a zero caselle, è disattivato.
  «Sposta» e «Non fare nulla» restano scelte a sé, sotto.
- **App** (`GoogleProposalScreen`): stesse caselle, tutte spuntate, e un
  bottone primario «Create N». «Sposta» e «Non fare nulla» restano righe che
  agiscono al tap, come oggi. Aggiungi `optionIndices` al doppio del client
  prima dei test.
- **Slack** (`buildQuestionBlocks`):
  - `MAX_OPTIONS` sale a 6, correggendo il difetto del §1;
  - le card multiple hanno un bottone in più «Crea tutte (N)», con
    `action_id inbox:answer:all`, che manda `optionIndices` =
    `multiSelectIndices`;
  - i bottoni singoli restano;
  - il gestore Slack (`apps/server/src/slack/inbox-actions.ts`) riconosce
    `all` e ricalcola gli indici dal server, senza fidarsi del bottone.

## §6 — Rilascio e rollback

Rebuild **server + worker + caddy**; l'app si aggiorna a parte. Nessuna
migrazione, nessun kind di notifica, nessun valore aggiunto a un enum che
entri in una risposta esistente.

- **Rollback del server**: `multiSelectIndices` sparisce dalla risposta e i
  client ricadono sulla scelta singola (l'app dal `.default`, il web dal
  `?? []`). Ma un client nuovo che manda `optionIndices` a un server vecchio
  riceve `invalid_answer`. Succede solo con una card già aperta sullo schermo
  nel momento del rollback: alla prima rilettura il campo manca e le caselle
  spariscono. Accettato.
- **Rollback del worker**: il perimetro torna quello del routing. Le card già
  nate su altri progetti restano valide.
