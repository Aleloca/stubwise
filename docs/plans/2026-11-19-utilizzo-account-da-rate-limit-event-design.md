# L'utilizzo degli account dal `rate_limit_event` — design

19 nov 2026. Branch `fix/usage-da-rate-limit-event`, nato dal commit che gira
in produzione (`d3e94841`), non da `main`.

## Perché

Il residuo degli abbonamenti Claude (gli account del registro provider) lo
legge oggi `apps/worker/src/agent/usage-poller.ts`: ogni 5 minuti apre la TUI
di `claude` in un PTY, digita `/usage`, passa il testo a un parser a regex e,
se fallisce, chiede a Haiku di estrarre i numeri — **su una chiave API**, per
non toccare la quota degli abbonamenti.

Il 30 ottobre 2026 Anthropic ha tolto il limite di 5 ore agli account Ultra
verificati: il pannello `/usage` non mostra più «Current session», il parser
pretende entrambe le finestre e dal 31 ottobre fallisce **sempre**, su tutti e
tre gli account. Da allora ogni giro passa al fallback: 864 chiamate Haiku al
giorno, ~$12/giorno fatturati sulla chiave API (operazione `usage_probe`,
$227 al 19 novembre), e il fallback stesso non estrae nulla (chiede la
sessione, che non c'è). Effetti a valle, tutti spenti da tre settimane senza
che nessuno se ne accorgesse:

- il pannello d'uso degli account (Impostazioni → AI) non si aggiorna;
- la soglia settimanale dei lavori di sfondo (`selectProviders`,
  `workClass: "background"`) non scatta mai: senza snapshot valido l'account
  è ammesso;
- lo sblocco anticipato di un account «al limite» (`clearLimitIfHeadroom`) e
  la ripresa per margine del resume poller (`hasHeadroom`) non scattano: si
  aspetta il fallback a tempo.

La strada è fragile per costruzione: legge un'interfaccia pensata per gli
occhi, che Anthropic cambia senza preavviso.

## La fonte nuova, verificata

Ogni `claude -p --output-format stream-json --verbose` emette **un**
`rate_limit_event`, subito dopo la risposta del modello. Provato il 19 nov
2026 nel container del worker di produzione, col CLI pinnato **2.1.287** e i
token `setup-token` veri dei tre account (un run Haiku da un turno ciascuno):

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795428000,
 "rateLimitType":"seven_day","overageStatus":"allowed","overageResetsAt":1796083200,
 "isUsingOverage":false,"unifiedWindows":{"seven_day":{"utilization":0.28,"resetsAt":1795428000}}},
 "uuid":"…","session_id":"…"}
```

`utilization` è una frazione 0–1, `resetsAt` epoch in secondi. La percentuale
c'è anche con `status: "allowed"`. Coincide con `/usage` (Account Leo: 0.28
contro «27% used, Resets Nov 23, 10am (UTC)»). Nessuno dei tre account ha più
la finestra `five_hour`.

Seconda prova, stesso giorno, con **gli argomenti veri del runner in
streaming** (`buildCliArgs(…, "stream")`: `--input-format stream-json
--include-partial-messages --replay-user-messages`, prompt su stdin) e un run
da tre chiamate API (due tool Bash e la risposta): l'evento esce **una volta
sola per run**, alla prima risposta del modello (5,6 s), non a ogni chiamata.
Non verificato: se un run respinto per limite emetta l'evento, e con che
forma.

## Approcci considerati

1. **`GET api.anthropic.com/api/oauth/usage`** (CodexBar, cship e simili):
   gratis e completo, ma vuole lo scope `user:profile`; i token `setup-token`
   hanno solo `user:inference` e ricevono 403. Richiederebbe di collegare gli
   account con un login OAuth completo e refresh token. Scartato.
2. **Header `anthropic-ratelimit-unified-*` con una chiamata diretta a
   `/v1/messages`** col token dell'abbonamento: funziona, ma è l'uso del token
   fuori da Claude Code — rischio di termini di servizio. Scartato.
3. **`rate_limit_event` dello stream-json** — dato strutturato, emesso da
   Claude Code stesso, gratis nei run che il worker fa comunque. **Scelto.**
4. Correggere il parser di `/usage` e tenere il PTY: resta il pezzo che si è
   appena rotto, e il fallback LLM. Scartato.

Per gli account **fermi** (nessun run, nessun evento) il maintainer ha scelto
(19 nov 2026) un **run minimo ogni tanto**: un `claude -p` da un turno su
Haiku col token di quell'account, che produce l'evento. Alternative scartate:
tenere `/usage` nel PTY per i soli fermi, o nessuna lettura.

## Obiettivi

- Lo snapshot d'uso di un account si scrive dal `rate_limit_event` di ogni run
  vero fatto con quell'account, e da un run minimo quando l'account è fermo.
- Le tre letture a valle (pannello, soglia settimanale di sfondo, sblocco e
  ripresa per margine) tornano a funzionare con le finestre che esistono
  davvero, senza presumere quella di 5 ore.
- Nessuna chiamata AI sulla chiave API per misurare gli abbonamenti.
- Rilasciabile in produzione **da solo**, senza portarsi dietro il lavoro in
  corso delle altre sessioni (vedi «Vincoli»).

## Non obiettivi

- Le finestre per modello o l'overage (`seven_day_opus`, `overageStatus`…):
  si ignorano. Il formato `unifiedWindows` le porterebbe come chiavi in più;
  usarle è un lavoro a parte. (Nota a margine per il maintainer: Account Leo ha
  `overageStatus: "allowed"`, quindi al limite può consumare credito extra
  invece di cedere il posto all'account successivo.)
- Ritoccare `limited_until` a partire da un evento `rejected`: la marcatura
  «al limite» resta quella di oggi (`markProviderLimited`, dal testo
  dell'errore). Lo snapshot nuovo la migliora comunque, perché
  `weeklyResetAt` ora è una data vera (prima era sempre null).
- Rifare la UI del pannello d'uso.

## Anti-obiettivi

- Un run dell'agente che fallisce, o rallenta, per colpa della scrittura dello
  snapshot. Tutto il percorso è fail-open: un errore si logga e il run
  prosegue con il suo esito.
- Una migrazione del DB (vedi «Vincoli»).
- Un run minimo che consuma quota senza motivo: si lancia solo quando manca
  una lettura recente.

## Vincoli

- **Niente migrazioni.** Il migratore Drizzle
  (`drizzle-orm/pg-core/dialect.js`) applica solo le migrazioni il cui
  `folderMillis` è **maggiore** del `created_at` dell'ultima applicata. Sui
  branch delle altre sessioni ci sono le migrazioni 0107–0125, non ancora in
  `main` né in produzione e datate prima di oggi: una migrazione nostra
  applicata per prima in produzione le farebbe **saltare in silenzio** al
  loro rilascio. Quindi niente valore nuovo nell'enum `ai_usage_source`: gli
  snapshot nuovi si scrivono con `source = 'deterministic'` e
  `parse_ok = true`. «Deterministic» resta corretto nel senso che conta:
  dato letto senza LLM. Il docblock dell'enum nello schema e quello della
  rotta lo dicono.
- **Base = produzione.** Il branch nasce da `d3e94841` (la produzione), così
  ribuildare `server`/`worker` da qui porta in produzione solo questo lavoro.
  Fra produzione e `main` in `apps/worker`, `apps/server`, `packages/db`,
  `packages/shared` e `apps/web` cambiano solo due file del calendario: il
  merge successivo in `main` non dovrebbe avere conflitti.
- Il CLI pinnato resta 2.1.287. L'evento è un formato non documentato: chi
  aggiorna il pin deve riverificarlo (si aggiunge agli scenari golden, vedi
  «Verifica»).
- La regola di CLAUDE.md sul runner in streaming vale: toccando
  `streaming-cli.ts` si rilanciano gli scenari golden.

## Il design

### 1. Lettura dell'evento (runner in streaming)

`StreamingClaudeRunner` (`apps/worker/src/agent/streaming-cli.ts`) oggi
scarta `rate_limit_event`. Lo legge e lo consegna **nel momento in cui
arriva** a una callback opzionale nuova delle opzioni del run
(`onRateLimit` su `AgentRunOptions`, `apps/worker/src/agent/runner.ts`), con
l'istante di arrivo. Non a fine run: l'evento esce una volta sola, alla prima
risposta, e uno snapshot scritto alla fine di un fix da un'ora porterebbe un
`captured_at` di un'ora più giovane del dato. La callback è
fire-and-forget: il runner non la aspetta e un suo errore non tocca il run.
La lettura vive in un modulo puro a sé (es. `agent/rate-limit-event.ts`),
difensivo, che restituisce `status`, `rateLimitType` e le finestre
normalizzate (`Record<string, { usedPercent: number; resetsAt: Date | null }>`,
**tutte** le chiavi di `unifiedWindows`, anche quelle che non si salvano):

- prima `rate_limit_info.unifiedWindows`; se manca, la forma vecchia
  (`utilization` + `rateLimitType` + `resetsAt` al primo livello) come
  finestra unica;
- `utilization` è una frazione (verificato): ×100, arrotondata; **sopra 1
  vale 100** (overage: oltre il limite, mai «1% usato»); negativa o non
  numerica → la finestra si scarta;
- un evento senza nessuna finestra valida = nessuna consegna.

Il runner storico (`ClaudeCliRunner`, `--output-format json`) non ha l'evento:
resta senza `rateLimit`. In produzione `AGENT_STREAMING` è acceso, quindi
quasi tutti i run passano dallo streaming; con il rollback
`AGENT_STREAMING=false` restano i run minimi (vedi 3), che usano sempre lo
streaming.

### 2. Scrittura dello snapshot (un posto solo)

Lo scrive `TrackingAgentRunner` (`agent/tracking-runner.ts`), che avvolge ogni
run e conosce già il provider: se `opts.provider?.kind === "account"`, passa al
runner interno una `onRateLimit` (concatenata a quella del chiamante, se c'è)
che inserisce una riga in `ai_usage_snapshots`, con `captured_at` = istante
d'arrivo dell'evento:

| colonna | valore |
|---|---|
| `session_remaining` | dalla finestra `five_hour`, o null se assente |
| `weekly_remaining` | dalla finestra `seven_day`, o null se assente |
| `session_reset_at` / `weekly_reset_at` | `resetsAt` delle stesse finestre |
| `source` / `parse_ok` | `deterministic` / `true` |
| `raw_text` | null |

Il jsonb delle finestre resta nella forma che i lettori conoscono già
(`{ percentUsed, percentRemaining, resetsLabel: null }`), così pannello web,
rotta e `parseWindow` non cambiano formato. La scrittura avviene **anche con
`record: false`** (quel flag riguarda `agent_runs`, non lo snapshot), in un
try/catch che logga e non rilancia. Un run con auth storica (nessun
`provider`) non scrive niente. Lo snapshot si scrive qualunque sia lo
`status` (anche un `rejected` porta percentuali e reset veri).

Subito dopo, lo stesso punto decide lo **sblocco per margine** (oggi
`clearLimitIfHeadroom` in `usage-poller.ts`, da spostare in
`providers/usage-window.ts`): azzera `limited_until` **solo se** lo `status`
è `allowed` **e** nessuna finestra dell'evento — comprese quelle che non si
salvano, come un `seven_day_opus` — è a 100. La decisione si prende qui, con
l'evento in mano, perché `status` e finestre extra non finiscono in DB (la
tabella non ha dove metterli e niente migrazioni). Serve a evitare un
ping-pong: una sonda Haiku accettata mentre il run vero è bloccato da una
finestra per modello sbloccherebbe l'account, il run vero ri-fallirebbe,
`markProviderLimited` lo rimarcherebbe, e così via a ogni giro.

### 3. Run minimo per gli account fermi

`usage-poller.ts` resta il task periodico (`USAGE_POLL_MINUTES`, default 5,
0 = spento), ma a ogni giro, per ogni account abilitato della catena
(`loadProviderChain`, anche quelli «al limite»: devono poter essere sbloccati):

- **account al limite** (`limited_until` futuro): run minimo se l'ultimo
  snapshot è più vecchio di un giro, **tranne** quando quello snapshot ha già
  una finestra a 100 con reset futuro: lì si sa perché è fermo e fino a
  quando, e una sonda servirebbe solo a consumare credito extra su un account
  con l'overage acceso (Account Leo). Passato quel reset, la sonda riparte.
  Se il margine è tornato, lo snapshot nuovo lo sblocca (regola del punto 2).
- **altri account**: run minimo se l'ultimo snapshot è più vecchio di
  `USAGE_PROBE_IDLE_MINUTES` (env nuova, default **30**, intero ≥ 1).
- altrimenti niente: un account che lavora si aggiorna da sé. Un account
  impegnato in un run più lungo di 30′ può ricevere una sonda (il suo evento
  è uscito all'inizio): è voluto, costa poco e rinfresca il dato.

Non è verificato che un run respinto per limite emetta l'evento: se non lo
fa, la sonda su un account al limite non produce nulla e lo sblocco resta
quello a tempo di oggi. Nessun danno, solo un processo inutile ogni giro per
gli account al limite.

Il run minimo passa da un `TrackingAgentRunner` attorno a uno
`StreamingClaudeRunner` **senza hook** (nessuna sessione, nessun relay),
indipendente da `AGENT_STREAMING`: operazione `usage_probe` (operazione tecnica, non
configurabile: il modello lo passa il poller, `haiku`, come oggi), prompt fisso di una riga,
`maxTurns: 1`, timeout 60 s, cwd in una directory temporanea vuota,
`provider` = l'account stesso. Lo snapshot lo scrive il punto 2, come per ogni
run: il poller non scrive snapshot da sé. Gli account si sondano uno alla
volta; ogni account è isolato in un try/catch; il giro intero non lancia mai e
non si sovrappone a sé stesso (come oggi). Se un run minimo non produce
l'evento (CLI che cambia formato, errore), lo si logga e basta: le letture a
valle degradano da sole al fallback a tempo, come fanno oggi.

Costo: al più 3 account × 48 run al giorno, sulla quota degli abbonamenti
(~$0,015 di valore equivalente ciascuno, nulla fatturato); in pratica meno,
perché gli account che lavorano non vengono sondati.

### 4. Finestre che possono mancare

Una finestra **assente** nell'ultimo snapshot vuol dire «nessun limite in
quella finestra», non «dato rotto». Una finestra il cui `reset_at` è già
passato vale 0% usato (si è azzerata). La regola sta in **una** funzione in
`providers/usage-window.ts` (accanto a `parseWindow`), usata da:

- `hasHeadroom` (`providers/limit-resume-poller.ts`): margine = sessione
  (se c'è) sotto `LIMIT_RESUME_HEADROOM_PERCENT` **e** settimanale (se c'è)
  sotto 100. Oggi pretende entrambe, e con la sola settimanale ricade sempre
  nel fallback a tempo.
- lo sblocco per margine (punto 2): stessa regola.
- la soglia di sfondo in `selectProviders` già ammette `weekly === null`;
  cambia solo che un `weekly_reset_at` passato conta come 0%.

`MAX_SNAPSHOT_AGE_MS` passa da 15′ a **45′** (soglia del run minimo + un giro
+ margine): con la sonda ogni 30′ uno snapshot da 15′ risulterebbe stantio per
metà del tempo. Resta una costante derivata, col commento aggiornato.
`.env.example` documenta `USAGE_PROBE_IDLE_MINUTES` e il legame.

### 5. Cosa si toglie

- `agent/usage-pty.ts`, `agent/usage-parser.ts`, i loro test,
  `buildRunLlmFromChain` e il fallback LLM: nessuna chiamata sulla chiave API.
- La dipendenza `node-pty` da `apps/worker/package.json` e le righe del
  `apps/worker/Dockerfile` che esistono solo per lei (toolchain degli addon
  nativi, `chmod` dello `spawn-helper`) — **se** nient'altro ne ha bisogno: va
  verificato prima di togliere la toolchain. Task separato e ultimo, così si
  può rimandare senza toccare il resto (cambia il lockfile, che è il file più
  esposto a conflitti col lavoro delle altre sessioni).

### 6. Server e web

- Rotta `GET /api/ai-usage/snapshots`: nessun cambio di forma. Aggiornare solo
  i docblock («dal `rate_limit_event`», `resetsLabel` sempre null per i nuovi).
- Pannello web (`ai-providers-section.tsx`): funziona già (mostra la barra di
  sessione solo se c'è, usa `weeklyResetAt` quando `resetsLabel` manca; nota
  LLM e banner di diagnosi restano per i vecchi snapshot). Due ritocchi
  minimi, a giudizio di chi costruisce: mostrare l'età dello snapshot
  («aggiornato 12 min fa») e togliere il riferimento al parser `/usage` dai
  testi. Se si toccano, si rifà anche `caddy` al deploy.

## Verifica

- Unit test del parse dell'evento con le **tre righe vere** raccolte in
  produzione il 19 nov 2026 (sopra), più la forma vecchia, una `utilization`
  fuori scala, un evento senza finestre.
- `TrackingAgentRunner`: scrive lo snapshot per un account (con e senza
  `record: false`) con `captured_at` = arrivo dell'evento, non lo scrive per
  una chiave API né senza provider, e un insert che fallisce non fa fallire il
  run. Sblocco: sì con `allowed` e tutte le finestre sotto 100; no con
  `rejected`, e no con `allowed` ma una finestra extra (es. `seven_day_opus`)
  a 100; `utilization` 1,04 → 100.
- Poller: chi viene sondato (fermo, al limite, attivo, spento), isolamento per
  account.
- `hasHeadroom` e la soglia di sfondo con la sola finestra settimanale, con un
  reset passato, con entrambe.
- Scenari golden (manuali): obbligatori perché si tocca `streaming-cli.ts`; ci
  si aggiunge la verifica che un run produca un `rateLimit` con almeno una
  finestra, così un aggiornamento del CLI che cambia l'evento viene fuori lì.
- Dopo il deploy: in produzione uno snapshot nuovo per ciascun account entro
  30′, `parse_ok = true`, e nessuna riga `usage_probe` nuova sulla chiave API.

## Rilascio

Voce nuova in `docs/operations/deploy-log.md`. Ordine: `server` (solo
docblock, può anche non servire) → `worker` (senza generazioni Docs vive né
giro notturno in corso, regole di sempre). `caddy` solo se si è toccato il
web. Il deploy si fa **da questo branch**, non da `main` (che è 642 commit
avanti col lavoro delle altre sessioni); il merge in `main` segue con una PR.
Come portare il checkout di `/opt/stubwise` su questo branch e poi riportarlo
su `main` lo decide il maintainer al momento del deploy.

Rollback: l'immagine vecchia del worker torna al PTY (rotto, ma innocuo); gli
snapshot scritti nel frattempo sono righe valide nel formato di sempre. Niente
da ripulire, nessuna migrazione da invertire.

## Lasciato a chi costruisce

- I nomi dei tipi e del modulo di parse; la forma esatta di `rateLimit`.
- Il testo del prompt del run minimo.
- I due ritocchi del pannello web (6), sì o no.
- Se la toolchain del Dockerfile serve ad altri addon (5).
