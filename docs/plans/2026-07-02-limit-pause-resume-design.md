# Pausa/ripresa sul limite di utilizzo — design

Data: 2026-07-02 · Stato: implementato (branch feat/limit-pause-resume; vedi 2026-07-02-limit-pause-resume-implementation.md)

## Problema

Quando l'utilizzo Claude raggiunge il 100% a metà di un lavoro dell'agente, oggi:

- **Docs (DAG)**: il run torna output degradato, il parser non trova i marcatori,
  il retry (che è ancora al limite) fallisce, il nodo va `failed`. La generazione
  conclude `succeeded` ma incompleta (caso reale: 32 nodi persi su 138, silenzioso).
  Il DAG non usa `isLimitError`: il limite è indistinguibile da un output rotto.
- **Fix**: failover di catena già presente; con TUTTI i provider al limite il job
  va `held`, ma la ripresa è SOLO manuale (POST /run-ai) e `held` non distingue
  il motivo (limite vs budget vs gate).
- **Review**: `isLimitError` c'è ma l'esito è terminale (`failed`), nessun retry.

## Obiettivo

Qualunque lavoro fermato dal limite si mette in pausa e riprende da solo quando
l'utilizzo si libera. Nessun nodo/job perso, nessun intervento umano richiesto.

## Rilevazione (Docs — il pezzo mancante)

Gli handler del DAG (explore, orient, synthesize) aggiungono il check
`isLimitError` (da `providers/limit.ts`, già usato da fix/triage/review) su ogni
esito dell'agente, PRIMA del loop di retry: un run al limite NON consuma il
retry e NON fallisce il nodo.

## Pausa per pipeline

### Docs: pausa a livello di generazione

- Al rilevamento: il nodo torna `pending` (l'explore è idempotente, ripartirà
  da zero) e la generazione passa al nuovo stato `paused` (nuovo valore
  dell'enum `doc_generation_status` + colonne `paused_at`, `pause_reason`).
- `claimNextNode` esclude via join i nodi delle generazioni `paused`: un solo
  segnale ferma l'intero DAG, niente run bruciati sugli altri nodi. I nodi già
  in volo completano o rilevano a loro volta il limite (transizione
  `running → paused` status-guarded: il secondo segnale è no-op).
- Ripresa banale: `paused → running`, i nodi `pending` tornano claimabili.
- INVARIATI: worktree in-memoria e `failGenerationOnRestart` (un riavvio del
  worker durante la pausa fallisce la generazione — rischio ACCETTATO, i deploy
  già evitano le generazioni attive), gate `allRootsDone`, `requeueStaleNodes`
  (ignora i `pending`), mutua esclusione fix↔generazione.

### Fix: `held` con motivo + riaccodo automatico

- Nuova colonna `ai_jobs.held_reason` (enum `limit` | `budget` | `other`,
  nullable), valorizzata nei punti che chiamano `holdJob`.
- Il resume poller riaccoda SOLO gli `held` con `held_reason='limit'`
  (status → `queued` + commento AI "riprovo dopo il reset"); budget e gate
  restano decisioni umane. Gli `held` storici (reason null) non vengono mai
  riaccodati (conservativo).

### Review: riuso della coda con `notBefore`

- Su `isLimitError`: la riga `pr_reviews` chiude `failed` con errore esplicito
  ("limite provider, riaccodata") E il job viene ri-upsertato in
  `pr_review_jobs` con `notBefore = now + cooldown` (default 30').
- Se il limite persiste al claim successivo, si ri-accoda: un run sonda ogni
  30', autolimitante. La chiusura della PR pulisce la coda (già implementato).
- Il resume poller NON tocca questa coda: il `notBefore` basta.

## Resume poller

Task separato (pattern dei poller esistenti: setInterval, unref, AbortSignal,
best-effort, mai crash). Ogni tick (default 5', allineato al poll dell'usage):

1. Cerca generazioni `paused` e `ai_jobs` `held_reason='limit'`.
2. Risolve il provider interessato (pin della generazione o `chain[0]` per i
   Docs; per i fix basta che UNA credenziale della catena abbia margine).
3. Headroom:
   - **`account`**: ultimo snapshot `ai_usage_snapshots` (il poller `/usage`
     già li produce ogni 5', gratis) con sessione < soglia (default 95% used)
     E settimanale < 100%. Snapshot stantio/assente → degrada al fallback a
     tempo (la pausa non è mai eterna).
   - **`api_key`**: nessuno snapshot → fallback a tempo: headroom quando
     `now - paused_at > cooldown` (default 60'). Se il limite persiste, il
     primo run lo rileva e la pausa riparte (backoff a intervallo fisso).
4. Su headroom: generazione `paused → running` (log); job `held → queued`
   (+ commento AI).

## Config (env worker, nessuna UI)

- `LIMIT_RESUME_POLL_MINUTES` (default 5, 0 = disabilitato → comportamento
  odierno, tutto manuale)
- `LIMIT_RESUME_HEADROOM_PERCENT` (default 95)
- `LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES` (default 60)

## UI

- Pagina Docs del repository: badge sullo stato `paused` ("In pausa — limite
  di utilizzo, riprende da sola") + pulsante admin **"Riprendi ora"**
  (`paused → running` senza aspettare il poller).
- Ticket: i job `held` mostrano già stato e rilancio manuale (override umano).

## Notifiche

- Nuovo kind `usage.limit_paused` (toggle dedicato, default on): quando una
  generazione va in pausa o un fix va `held` per limite — il momento in cui
  l'operatore può voler agire (piano, credenziali).
- NESSUNA notifica alla ripresa automatica (log e timeline bastano); le review
  non notificano la pausa (retry economico e silenzioso).

## Test

- Unit: `isLimitError` nei tre handler DAG (run limit-shaped → nodo `pending`,
  generazione `paused`, retry NON consumato).
- Integrazione worker: claim esclude generazioni `paused`; resume poller
  (snapshot con headroom → running; senza → resta paused; api_key → cooldown;
  snapshot stantio → fallback); riaccodo review con `notBefore`; requeue
  automatico held-limit; doppio segnale concorrente (no-op).
- Server: endpoint "riprendi ora".
- Parità i18n per notifica e UI.

## Decisioni chiave (con motivazione)

- Pausa a livello di GENERAZIONE (non per-nodo): un segnale ferma tutto,
  niente thundering herd di retry per-nodo.
- Ripresa snapshot-driven dove possibile (precisa e gratuita), fallback a
  tempo altrove: il reset time machine-readable non esiste (solo label TUI).
- Rischio riavvio-durante-pausa accettato: rendere le generazioni
  riavvio-safe è un cambio profondo al cuore del DAG, rimandato.
- `held_reason` invece di un nuovo stato: riusa la semantica `held` esistente
  e la UI che già la mostra.

## Scostamenti in implementazione

1. **Notifica solo per le generazioni Docs** (`docs.limit_paused`): il fix
   held-limit era già coperto dal kind `job.held` esistente — nessun nuovo
   evento per quel caso.
2. **Orientamento al limite** → il trigger va `held` (reason "limit") e la
   generazione va `failed` con messaggio esplicito: "pausa" non è definita
   senza un DAG già seminato (non c'è nulla da riprendere).
3. **Sintesi al limite** → nessuna pagina di fallback: il nodo torna `pending`
   come per l'explore (la sintesi ripartirà da capo alla ripresa).
4. **`GET /docs/status` espone la generazione `paused` con precedenza sulla
   `current`**: senza questa precedenza il badge "in pausa" non sarebbe mai
   apparso (la selezione della current avrebbe continuato a mostrare l'ultimo
   stato terminale).
5. **`recordNodeCost` ora accumula** (`coalesce(cost,0) + costUsd`) invece di
   sovrascrivere: bug pre-esistente scoperto durante la review — con più run
   per nodo (retry, ripresa dopo pausa) il costo veniva perso.
6. **Durante una pausa il worktree resta registrato** nel registry in-memoria:
   i fix dello stesso progetto restano esclusi dal claim per tutta la durata
   della pausa (anche ore). È coerente con la mutua esclusione fix↔generazione
   già prevista, ma la finestra di esclusione si allunga rispetto a una
   generazione che corre senza pause.
