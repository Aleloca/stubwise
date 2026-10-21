# Modelli per tipo di lavoro e consumi di token — design

Data: 21 ott 2026. Stato: bozza da approvare.

## Perché

Il maintainer vuole poter **cambiare il modello Anthropic usato da ogni tipo
di lavoro AI** direttamente dalle impostazioni, per **confrontare consumi e
risultati** fra un modello e l'altro. Oggi il modello si sceglie solo con
variabili d'ambiente del worker (o è scritto nel codice), quindi ogni prova
vuol dire modificare `/opt/stubwise/.env` e ribuildare/riavviare il worker —
cosa che qui costa (vedi «Worker fail-on-restart» in `CLAUDE.md`).

Per confrontare servono numeri: oggi però metà dei lavori AI non registra
alcun consumo. Il dato che interessa al maintainer sono i **token** (input,
output, cache), raggruppabili per tipo di operazione, progetto, modello e
giorno; il costo in dollari si conserva quando c'è, ma non è il centro.

## Obiettivi

1. Una sezione **«Modelli»** in Impostazioni → Automazione
   (`/settings/automation`, solo admin): una riga per tipo di lavoro, ciascuna
   con un menu del modello. Vale per **tutta l'istanza**.
2. **Ogni consumo di token, in qualunque punto del sistema** (worker e
   server), viene registrato con tipo di operazione, progetto (se c'è),
   versione effettiva del modello, token e — quando disponibile — costo.
3. La pagina **Utilizzo** (`/settings/usage`) permette di raggruppare quei
   consumi per tipo di operazione, progetto, modello e giorno, anche a due
   livelli (es. operazione × modello).

## Non obiettivi

- **Nessun fornitore diverso da Anthropic** (niente OpenAI, Gemini, modelli
  locali). Deciso dal maintainer: «per ora solo modelli di Anthropic».
- **Nessuna scelta dell'account per tipo di lavoro.** L'account resta deciso
  da `providers/select.ts` come oggi (preferenza/esclusività del progetto,
  classe `interactive`/`background`, failover al limite). Deciso dal
  maintainer: «per ora solo modello».
- **Nessun override per progetto.** Deciso dal maintainer: solo istanza.
- **Nessun grafico** nella pagina Utilizzo: è previsto un redesign completo
  dell'interfaccia, quindi la UI resta minima e coerente con lo stile
  attuale (tabelle).
- Nessun cambio all'app mobile (non legge queste rotte).
- Nessuna scelta di effort/thinking/max turns per tipo di lavoro.

## Anti-obiettivi (sarebbe un fallimento anche se «funziona»)

- Un cambio di modello che **rompe un'esecuzione in corso** o che richiede un
  riavvio del worker per avere effetto.
- Un modello scelto che **non arriva davvero** all'esecuzione (UI che dice
  Opus, run che gira su Sonnet) — il confronto sarebbe falsato in silenzio.
- Registrazione dei consumi che **fa fallire un lavoro** se l'insert va male:
  resta best-effort come oggi (`agent_runs`, docblock nello schema).
- Un consumo registrato **due volte** (es. un riassunto contato sia sotto il
  suo job sia come riga a sé), che falserebbe i totali.

## Cosa esiste oggi (ricognizione, 21 ott 2026)

**Modelli** — env del worker, parsate in `apps/worker/src/config.ts` e
cablate una volta in `apps/worker/src/index.ts`, passate al CLI con
`--model` (`agent/cli-args.ts`):

| Env | Default | Usata da |
|---|---|---|
| `FIX_PLAN_MODEL` | `opus` | piano del fix (+ ripresa del piano) |
| `FIX_EXECUTE_MODEL` | `sonnet` | esecuzione, self-repair, correzione post-PR |
| `PR_REVIEW_MODEL` | `sonnet` | review PR |
| `SUMMARY_MODEL` | `PR_REVIEW_MODEL` | plan_summary, pr_summary, failure summary, brief settimanale |
| `BACKLOG_MODEL` | `sonnet` | intake, stima, turno di refinement |
| `DOC_GENERATION_MODEL` | `opus` | generazione Docs (tutte le fasi; salvato in `doc_generations.model`) |
| `COMMIT_SUMMARY_MODEL` | `haiku` | riassunto commit (notturno e daily report) |
| `RELEASE_NOTES_MODEL` | `sonnet` | nota di rilascio notturna |
| `DOCS_NIGHTLY_MODEL` | `sonnet` | pagine notturne (update e create) |
| `DAILY_REPORT_MODEL` | `haiku` | daily report (progetto e per sviluppatore) |
| `GMAIL_MODEL` | `haiku` | classificazione/proposte della posta |

Scritti nel codice: triage `"haiku"` (`pipeline/triage.ts`), smoke plugin,
test credenziali, fallback del poller d'uso (tutti `"haiku"`). Le chat del
server (Docs repo/progetto, widget, Slack `/docs`, unione documento del
backlog) usano l'SDK Anthropic con `DEFAULT_CHAT_MODEL = "claude-opus-4-8"`
(`apps/server/src/routes/chat-llm.ts`) e la prima API key abilitata.

**Consumi** — `agent_runs` (una riga per run × modello, owner esattamente uno
fra `job_id`/`pr_review_id`/`email_message_id`, `phase` enum
`triage|fix|review|email_classify`) registra solo triage, fix, correzioni,
review e classificazione posta. A parte: `doc_generations.cost`,
`doc_nodes.cost`, `commit_summaries.model/cost_usd`. **Non registrati:**
intake/stima/refinement del backlog, brief, daily report, note di rilascio,
pagine notturne, plan/pr/failure summary, smoke plugin, test credenziali,
poller d'uso, tutte le chat del server. `extractUsage`
(`agent/claude-cli.ts`) ricava già token per modello dal JSON del CLI.

**Pagina Utilizzo** — `apps/server/src/routes/usage-costs.ts` aggrega per
giorno/modello/progetto/provider **solo** le righe con `job_id` (inner join su
`ai_jobs`): le review e la posta, pur registrate, non compaiono.

## Il design

### 1. Il catalogo dei tipi di lavoro

Un solo elenco dichiarato in `@stubwise/shared` (server, worker e web lo
leggono tutti), con per ogni voce: chiave stabile, gruppo, se il modello è
**configurabile**, e il default (che oggi è l'env o la costante). Le chiavi
sono la stessa dimensione usata dai consumi («tipo di operazione»), così
impostazione e statistiche parlano la stessa lingua.

Configurabili (proposta, raggruppati come nella UI):

- **Ticket**: `triage`, `fix_plan`, `fix_execute` (comprende self-repair e
  correzione post-PR, come oggi), `pr_review`, `summary` (plan, PR, failure)
- **Backlog**: `backlog_intake` (intake e stima), `backlog_refine`
- **Giro notturno**: `commit_summary`, `release_notes`, `docs_nightly`
- **Docs**: `docs_generation`
- **Report**: `daily_report`, `weekly_brief`
- **Posta**: `mail_classify`
- **Chat**: `chat` (Docs repo/progetto, widget, Slack `/docs`), `backlog_merge`

Non configurabili ma **registrati** nei consumi: `plugin_smoke`,
`credential_test`, `usage_probe` (fallback LLM del poller d'uso). Restano su
haiku fisso: sono controlli tecnici, non lavoro da confrontare.

Fuori da entrambi: le etichette delle community del grafo (`graphify
cluster-only --backend=claude-cli`): girano dentro graphify con l'auth del
container, Stubwise non vede né il modello né i token.

Nota: oggi `weekly_brief` condivide `SUMMARY_MODEL` coi riassunti e
`commit_summary` serve sia il notturno sia il daily report. La separazione di
`weekly_brief` è una novità (stesso default di oggi); `commit_summary` resta
unico perché è la stessa operazione (un commit si riassume una volta,
`docs/invariants/nightly.md`).

### 2. I modelli offerti

Menu con: **alias** `opus`, `sonnet`, `haiku` (seguono l'ultima versione) +
**versioni precise** da una lista mantenuta nel codice in `@stubwise/shared`
(es. `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, più le
versioni precedenti ancora utili). Deciso dal maintainer. Più una voce
«predefinito» = nessun valore salvato.

Il server valida il valore contro la lista (enum chiuso lato scrittura): un
refuso non può arrivare al worker.

### 3. Dove si salva e chi vince

Tabella nuova `ai_model_settings` (PK `operation`, colonna `model`), letta
dal worker **a ogni esecuzione** (non cablata all'avvio), così un cambio vale
dalla prossima esecuzione senza riavvii. Precedenza:

1. valore salvato in `ai_model_settings`;
2. env attuale (che resta il default per chi non tocca le impostazioni, e per
   le istanze self-hosted già configurate così);
3. default nel codice.

Un'esecuzione già partita tiene il modello con cui è partita: la generazione
Docs lo fissa già in `doc_generations.model` all'avvio e le fasi successive
devono leggerlo da lì, non dall'impostazione corrente. Lo stesso per la
ripresa di un piano/esecuzione dopo `ask_user` o limite: usa la risoluzione
al momento della ripresa (è un'esecuzione nuova del CLI) — *scelta mia, vedi
«Scelte fatte»*.

**Chat del server**: l'API non accetta gli alias, quindi lì `opus`/`sonnet`/
`haiku` si risolvono nella versione più recente della lista del punto 2.

La UI mostra per ogni riga anche il modello **effettivo** quando la riga è
su «predefinito» (es. «predefinito — sonnet, da `BACKLOG_MODEL`»), così non
serve indovinare cosa sta girando. Richiede che il server conosca i default
del worker: il catalogo condiviso contiene i default nel codice, ma le env
stanno sul worker — *lasciato al builder* come esporle (es. il worker scrive
le sue env risolte in una riga all'avvio, o la UI mostra solo «predefinito»).

### 4. La registrazione dei consumi

**Una sola tabella per tutti i consumi**: si estende `agent_runs`, non se ne
crea una seconda accanto (due tabelle = due verità da sommare in ogni
lettura).

- colonna nuova `operation` (chiave del catalogo, punto 1), obbligatoria;
  le righe esistenti si riempiono da `phase` (`triage`→`triage`,
  `review`→`pr_review`, `email_classify`→`mail_classify`, `fix`→`fix_execute`
  o `fix_plan` dove il modello del job lo permette di distinguere, altrimenti
  `fix_execute`) — *scelta mia*;
- colonna nuova `project_id` (nullable, `ON DELETE SET NULL`), valorizzata
  alla scrittura, così raggruppare per progetto non richiede join diversi
  per ogni owner;
- colonna nuova `cache_creation_tokens` (il CLI la riporta, oggi si perde);
- il CHECK sugli owner passa da «esattamente uno» a «al più uno»: i consumi
  senza un owner naturale (chat, smoke, brief, daily report…) hanno solo
  `operation` e `project_id`. Restano utili e opzionali eventuali FK nuove se
  servono a una cancellazione a cascata — *lasciato al builder*.

- `phase` diventa **nullable** e resta solo per i suoi valori di oggi: le
  righe nuove la lasciano nulla, e `email_classify` continua a marcare
  SOLTANTO la classificazione della posta. Serve perché ci sono lettori che
  filtrano per fase: il tetto giornaliero per casella e il cooldown per
  thread della posta (`google/classify.ts`, `phase = 'email_classify'`)
  devono continuare a contare solo le classificazioni. Niente valori nuovi
  nell'enum (vedi la trappola delle migrazioni in `CLAUDE.md`): la
  dimensione nuova è `operation` — *scelta mia*;
- **owner delle righe nuove**: una riga che nasce dentro un job (plan
  summary, failure summary) porta il `job_id` di quel job; il `pr_summary`
  porta il `pr_review_id` della sua review; le altre (chat, smoke, brief,
  daily report, notturno, backlog, Docs) nessun owner, solo `operation` e
  `project_id`. Conseguenza voluta: i riassunti entrano nel costo del ticket
  e nel suo tetto (`ticketCostUsd`, `max_cost_usd` della regola
  d'automazione), coerente con la decisione sul budget del punto 4b —
  *scelta mia*.

Ogni esecuzione AI scrive le sue righe, best-effort come oggi: worker via
`extractUsage` (esteso alla cache creation), server dalla `usage` della
risposta dell'SDK (streaming incluso). Le esecuzioni che oggi scrivono già
in `commit_summaries`/`doc_generations`/`doc_nodes` **in più** scrivono la
riga in `agent_runs`; quelle colonne restano com'erano (le leggono già altre
schermate).

Il costo (`cost_usd`) si salva quando il CLI lo riporta; per gli account in
abbonamento è una stima del CLI, non una spesa. L'SDK non riporta costo: le
righe delle chat hanno `cost_usd` nullo — *scelta mia*: niente tabella
prezzi da mantenere, il dato che conta sono i token.

### 4b. Il budget mensile conta TUTTO

`monthlyCostUsd` (`packages/db/src/cost.ts`) somma già ogni riga di
`agent_runs` del mese senza filtri, e ferma fix, correzioni post-PR e turni
di refinement quando supera `instance_settings.monthly_budget_usd`. Con
questo lavoro le righe crescono (Docs su Opus, notturno, daily report,
backlog, brief, smoke, test credenziali): **il maintainer ha deciso che il
budget le conti tutte**, perché è la spesa vera. Quindi nessun filtro per
operazione in `monthlyCostUsd`. Le chat del server hanno `cost_usd` nullo e
restano fuori di fatto.

Conseguenza da gestire, non da evitare: lo stesso limite si raggiunge prima.
Una notte di Docs può fermare i fix del giorno dopo. Serve:

- un avviso accanto all'impostazione del budget mensile che dica cosa conta
  («ogni consumo AI con un costo: fix, review, Docs, giro notturno, report,
  backlog…»);
- nella voce del deploy-log, un passo PRIMA del deploy: guardare il consumo
  del mese per le operazioni nuove (stimabile da `doc_generations.cost` e
  `commit_summaries.cost_usd`) e alzare il budget se serve;
- i lavori che il budget non ferma (Docs, notturno, report…) non cambiano
  comportamento: il budget continua a fermare solo ciò che fermava.

### 5. La pagina Utilizzo

Si amplia `/settings/usage` (nessuna pagina nuova):

- periodo: 7 giorni, 30 giorni, mese corrente, intervallo libero;
- **«Raggruppa per»**: operazione, progetto, modello, giorno; con un secondo
  livello facoltativo (es. operazione × modello);
- tabella: token input, output, cache read, cache creation, numero di
  esecuzioni, **media di token per esecuzione** (per confrontare due modelli
  sullo stesso lavoro anche con volumi diversi), costo dove c'è;
- le righe senza progetto finiscono sotto «nessun progetto».

La rotta di aggregazione legge **tutte** le righe di `agent_runs` (non più
solo quelle con `job_id`): oggi review e posta mancano dalle tabelle della
pagina, ed è un difetto che questo lavoro chiude.

Cosa conta come «un'esecuzione» nella media: una chiamata al CLI/SDK, non
una riga (un'esecuzione con subagent produce più righe, una per modello) —
serve quindi un identificatore d'esecuzione comune alle righe di uno stesso
run, *lasciato al builder*.

### 6. Rollout

- Migrazione additiva (colonne nuove nullable o con default, tabella nuova,
  CHECK allentato): prima il **server**, poi worker e caddy, come da regola
  ricorrente in `CLAUDE.md`. Voce nuova in `docs/operations/deploy-log.md`
  con rollback.
- Senza righe in `ai_model_settings` i modelli usati sono identici a oggi.
  Il budget mensile invece no: inizia a contare i consumi nuovi (punto 4b),
  quindi la voce del deploy-log dice di rivederlo prima del deploy.
- Le env restano documentate come default.

## Scelte fatte da me (da verificare leggendo)

- I raggruppamenti e le chiavi del catalogo (punto 1), incluso separare
  `weekly_brief` dai riassunti.
- Smoke plugin, test credenziali e poller d'uso: registrati ma non
  configurabili.
- Env come secondo livello di precedenza, invece di eliminarle.
- Una ripresa (dopo domanda o limite) usa il modello impostato al momento
  della ripresa; una generazione Docs invece tiene quello di partenza.
- Estendere `agent_runs` invece di una tabella nuova; backfill di
  `operation` dalle righe esistenti.
- Chat del server: costo nullo, solo token.
- `phase` nullable invece di valori nuovi nell'enum; `email_classify` resta
  solo per la classificazione.
- Riassunti legati al loro job/review: entrano nel costo e nel tetto del
  ticket (coerente con «il budget conta tutto», deciso dal maintainer).

## Lasciato al builder

- Come mostrare nella UI il default effettivo che viene dalle env del
  worker.
- L'identificatore d'esecuzione per la media per esecuzione.
- Indici della tabella per le aggregazioni sul periodo.
- La forma esatta della rotta di aggregazione (una generica con `groupBy`
  vs le rotte attuali estese), purché il web legga i campi nuovi con
  `?? 0`/`?? []` (il web non parsa le risposte, vedi `CLAUDE.md`).
