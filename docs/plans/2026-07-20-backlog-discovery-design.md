# Backlog di discovery — design

Data: 2026-07-20 · Stato: validato, da implementare

## Obiettivo

I ticket di tipo `feedback` e `feature` non vanno eseguiti come i bug/task: vanno
raccolti, deduplicati e raffinati fino a diventare un design doc pronto per lo
sviluppo. Nasce una pagina `/backlog` per progetto, alimentata automaticamente da
quei ticket (o a mano), dove ogni idea si evolve chattando con un agente RAG e può
concludersi in due modi: export `.md` per agenti locali, oppure conversione in un
ticket `task` eseguibile dalla pipeline Stubwise.

In più: `/tickets` di default nasconde gli stati terminali (`done`, `closed`).

## Modello dati (migrazione nuova)

**`backlog_items`**
- `projectId`, `title`, `document` (markdown), `status`
- Metadati: `effort` (1–5, scala ticket), `risk` (`low|medium|high`) + `riskNote`,
  `urgency` (`low|medium|high|urgent`)
- `requestCount`, `similarToId` (nota "simile a X" della zona grigia dedup)
- `embedding vector(1024)` (bge-m3, come `doc_chunks`) per la similarity search
- `source` (`ticket|manual`), timestamps

**Ciclo di vita**: `new` → `refining` → `ready` → `converted`, più `archived`
(reversibile). Transizioni manuali tranne `new→refining` (primo messaggio in chat)
e `→converted` (conversione). Gli `archived` escono dalla similarity search del
dedup: un feedback nuovo su un'idea scartata ricrea l'item.

**`backlog_item_tickets`** (`itemId`, `ticketId`, `role`): `role=origin` per i
ticket che hanno alimentato l'item (N via merge; `requestCount` deriva da qui),
`role=converted_to` per il task creato dalla conversione.

**`backlog_chat_messages`** (`itemId`, `role`, `content`, `citations`): una sola
conversazione per item, pattern di `docChatMessages`. Niente sessioni multiple.

**`projects.backlogEnabled`** (default off), pattern `dailyReportEnabled`.

Il documento NON è versionato: solo versione corrente + `updatedAt` (la chat è la
storia del raffinamento).

## Intake automatico

Deviazione totale dalla pipeline fix, condizionata a `backlogEnabled`:

1. **All'ingresso** (ingest processor + creazione ticket): ticket già
   `feedback`/`feature` → nessun `aiJobs` di fix, si accoda un job di intake.
2. **Dopo il triage**: se il classificatore riclassifica un bug/task in
   `feedback`/`feature`, il job di fix chiude `skipped` e si accoda l'intake.

**Coda `backlog_jobs`** (kind `intake|deep_dive`), stesso pattern
`FOR UPDATE SKIP LOCKED` di `aiJobs`, eseguita dal worker, serializzata
per-progetto. Passi dell'intake:

1. Embedding di titolo+corpo del ticket.
2. Similarity search sugli item non-archiviati del progetto:
   - **≥ `BACKLOG_MERGE_THRESHOLD`** (~0.90): merge automatico — linka il ticket,
     `requestCount++`, chiamata AI che integra nel documento ciò che il nuovo
     feedback aggiunge.
   - **≥ `BACKLOG_SIMILAR_THRESHOLD`** (~0.78): item nuovo con `similarToId`
     valorizzato → badge "simile a X", fusione manuale possibile.
   - Sotto: item nuovo e basta.
3. Item nuovi: retrieval RAG sulla documentazione del progetto (logica di
   `retrieveChunksForProject` estratta in modulo condiviso server/worker) +
   chiamata AI → titolo, documento iniziale (contesto, cosa fare, punti aperti),
   stime effort/rischio/urgenza.
4. **Chiude il ticket d'origine** (`closed`, evento in timeline che punta
   all'item).

Fallimento → retry; il ticket resta aperto finché l'intake non riesce.

## Raffinamento

**Chat RAG (streaming).** Endpoint SSE server-side che riusa il trasporto di
`docs-chat-core`: retrieval ibrido sulla documentazione del progetto a ogni
messaggio. Nel prompt di sistema: documento corrente, metadati, corpi dei ticket
d'origine. Messaggi persistiti con citazioni.

**"Aggiorna documento" (su comando).** Endpoint dedicato: una chiamata AI riceve
documento corrente + conversazione dall'ultimo aggiornamento, restituisce la nuova
versione del documento (sostituita direttamente) e metadati eventualmente rivisti
(proposti in UI con conferma, es. "suggerisce effort 4, era 2" — mai sovrascritti
in silenzio).

**Deep dive (asincrono, on demand).** Job `deep_dive` sul worker: run claude CLI
**read-only** su worktree del mirror (approccio PR review) con prompt = documento
+ verifica di fattibilità, punti di contatto col codice, rischi di regressione
concreti. Output: sezione "Analisi tecnica" nel documento + metadati proposti.
UI: "analisi in corso" con polling; a fine run un messaggio di sistema in chat
riporta l'esito. Multi-repo: scelta del repo, default quello con più match nel
retrieval.

## Uscite e azioni

- **Esporta .md**: copia negli appunti o download `<slug>.md` con frontmatter
  (titolo, progetto, effort/rischio/urgenza, ticket d'origine).
- **Converti in task**: crea ticket `type=task`, body = documento, stato `open`,
  `priority` mappata dall'urgency, `effort` già valorizzato. NON accoda niente:
  seguono le regole di automazione normali o il run manuale esistente. Linka con
  `role=converted_to`, item → `converted`.
- **Fondi con…**: destinazione precompilata da `similarToId`; ticket e contatore
  si sommano, chiamata AI integra i documenti, la chat dell'assorbito chiude con
  messaggio-ponte, assorbito → `archived` con riferimento al superstite.
- **Archivia/Riapri**, **Segna come pronto** (`ready`, sola etichetta).

## UI

**`/backlog`**: impianto di /tickets (filtri nell'URL: progetto, stato, urgenza,
rischio, ricerca). Card con badge effort/rischio/urgenza, "richiesto N volte"
(se >1), "simile a X", stato. Default: nasconde `converted` e `archived`.
"Nuovo item" → form titolo+descrizione che accoda lo **stesso job di intake**
(dedup e RAG compresi).

**`/backlog/$id`**: due colonne — documento renderizzato con metadati editabili e
ticket linkati a sinistra, chat a destra. Barra azioni: Aggiorna documento,
Analisi approfondita, Esporta, Converti in task, Fondi con…, Archivia.

**`/tickets` default**: senza `status` nell'URL mostra solo gli stati attivi
(`open`, `triaged`, `in_progress`, `in_review`); il filtro esplicita l'esclusione
e "Tutti" la rimuove. Viste salvate invariate (se specificano uno stato, comanda
lui). Solo frontend: il default vive nella pagina, non nell'API.

## Configurazione e deploy

- Toggle `backlogEnabled` nel dettaglio progetto in /team.
- Env: `BACKLOG_MERGE_THRESHOLD` (default ~0.90), `BACKLOG_SIMILAR_THRESHOLD`
  (default ~0.78) — da tarare sul campo.
- Deploy: migrazione nuova, rebuild `server` + `worker` + `caddy`. Nessun impatto
  sui progetti col toggle off.

## Decisioni chiave (e perché)

- **Entità separata dal ticket**: lifecycle e chat propri, creazione manuale senza
  ticket finti; il ticket d'origine viene chiuso automaticamente.
- **Deviazione totale con toggle per-progetto**: rollout sicuro, niente doppio
  binario ambiguo (stessa richiesta fixata E raffinata).
- **Ibrido RAG + deep dive**: chat fluida per il grosso, agente sul codice quando
  serve fondatezza.
- **Documento aggiornato su comando**: controllo esplicito, niente riscritture a
  sorpresa.
- **Metadati AI-proposti, umano corregge**: sempre editabili da UI.
- **Conversione "crea e basta"**: nessun avvio automatico, decide il gate o
  l'umano.
- **Dedup auto-merge con soglia + zona grigia segnalata**: i falsi positivi
  restano visibili e fondibili a mano.
