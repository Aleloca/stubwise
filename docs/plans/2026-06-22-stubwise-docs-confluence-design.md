# Stubwise — Documentazione autogenerata stile Confluence (design)

**Data:** 2026-06-22
**Stato:** design validato (brainstorming), pronto per il piano di implementazione.

## Obiettivo

Dopo aver replicato la parte "Jira" (ticketing + pipeline AI), replicare la parte
"Confluence": una **documentazione autogenerata e approfondita** a partire dai repo
collegati. Il codice è il *source of truth*: la documentazione deve coprire ciò che il
codice copre e *come funziona*, servendo due audience:

- **Dev** → "come funziona X?" → risposte/lettura **tecnica** (architettura, moduli,
  API pubbliche, flussi reali nel codice).
- **Business/commerciale** → "si può fare X?" → risposta **funzionale**: descrizione +
  passi se fattibile, oppure spiegazione del *perché* non è fattibile — il tutto
  ancorato a cosa il codice effettivamente fa.

La documentazione è consultabile su **pagine dedicate navigabili** e tramite **chat**
(RAG). L'aggiornamento incrementale dai push è una fase successiva (v2), ma lo schema v1
è già predisposto.

## Decisioni di fondo (dal brainstorming)

1. **Editabilità:** doc generate **read-only/rigenerabili** + uno **spazio di pagine
   manuali separato** (vero wiki accanto, senza merge con la generazione). Hybrid pulito.
2. **Repo target:** anche **monorepo grandi** → profondità mirata, non file-per-file
   esaustivo. Prioritizzazione + limiti espliciti.
3. **Modello di profondità:** due strati complementari sopra lo stesso repo —
   **tecnico** (architettura → moduli → API pubbliche in dettaglio, modello "a strati con
   drill-down" che scala) e **funzionale/capability** (cosa è possibile/non possibile,
   flussi). La chat pesca da entrambi e adatta il registro alla domanda.
4. **Vector store:** **pgvector** sul Postgres esistente (no nuovi servizi; backup e
   migrazioni unificati). Sottile astrazione interna per lasciare aperta un'alternativa
   futura.
5. **Motore di generazione:** **map-reduce gerarchico structure-aware**, con **map
   agentico** (nella fase map l'agent può seguire import/leggere dipendenze oltre i file
   stretti del modulo, entro un cap di costo).
6. **Retrieval chat:** **semantico self-hosted** con **Ollama + bge-m3** (container
   ~3-4 GB RAM, CPU, multilingue), provider scritto contro **API OpenAI-compatibile**
   così resta aperto ad altri server/modelli (TEI, Infinity, vLLM, LocalAI, OpenAI/Voyage
   gestiti) senza nuovo codice. Ibrido semantico+full-text come plus opzionale.
7. **Navigazione:** **Docs come sezione di primo livello** nella sidebar generale → hub
   degli spazi (un progetto = uno spazio) → albero del singolo progetto.

### Embedding: chiarimento concettuale

Tre componenti distinti, da non confondere:

- **LLM (Claude):** genera le risposte. Invariato.
- **Modello di embedding:** *non* genera risposte; trasforma un testo in un vettore che
  ne rappresenta il significato. Serve sia in scrittura (ogni chunk → vettore) sia in
  lettura (la domanda → vettore). Non è un secondo LLM da gestire.
- **Vector store (pgvector):** conserva i vettori e trova i più vicini. Da solo non sa
  trasformare il testo in vettori — per quello serve il modello di embedding.

Flusso: *embedding per trovare i pezzi giusti → Claude per rispondere.*

### Costi embedding (contesto)

- Generazione (one-time): si embeddano **solo i doc generati** (prosa), non il codice →
  ~200k–1M token tipici; a $0,02–0,13/1M sono **frazioni di centesimo–~15 cent** per
  generazione completa, **trascurabili** vs i dollari/decine di dollari della fase Claude.
  Con self-hosting (Ollama) il costo API è **zero**, in cambio di ~3-4 GB RAM.
- Query-time: si embedda solo la domanda → **praticamente gratis**.
- Storage pgvector: vettori ~4 KB ciascuno → decine di MB, trascurabili.
- Velocità ricerca: dominata da pgvector (pochi–decine di ms con HNSW); l'embedding della
  query aggiunge ~20–150 ms su CPU, impercettibile rispetto ai secondi di Claude.

## Architettura

Nuovo dominio "Docs" appoggiato all'infra esistente, **senza nuovi servizi a runtime**
oltre all'estensione pgvector (e il container Ollama per l'embedding self-hosted).

- **`apps/worker`** — ospita la **doc-generation pipeline** come nuovo tipo di job,
  accanto ai job di fix AI. Riusa: clone in worktree, esecuzione Claude, tracking costi,
  budget/guardrail, gestione staleness.
- **`packages/docs-engine`** (nuovo) — logica pura e testabile (no I/O di rete): pass
  strutturale, orchestrazione map-reduce, chunking, costruzione prompt, e (per la v2) il
  mapping *file cambiati → moduli toccati*.
- **`apps/server`** — nuove API REST: trigger generazione, lettura pagine, ricerca,
  endpoint chat (RAG). Riusa auth, AI provider configurabili, secret cifrate.
- **`apps/web`** — sezione **Docs** di primo livello: hub spazi, albero+pagina, ricerca,
  widget chat, editor delle pagine manuali (riuso del `MarkdownEditor`).
- **`packages/db`** — nuove tabelle + migrazione, estensione **pgvector**.

**Flusso dati:** trigger → job worker → `docs-engine` clona e analizza → map agentico per
modulo → reduce (overview tecnica + mappa funzionale) → salva pagine in Postgres →
chunk + embed in pgvector. Consultazione: web legge pagine via server; chat → server fa
retrieval da pgvector + Claude con citazioni alle pagine/sorgenti.

## Modello dati

Postgres + estensione `pgvector`. Cinque tabelle nuove.

### `doc_generations` (versionamento)
Una riga per run di generazione.
- `project_id`, `status` (pending/running/succeeded/failed), `commit_sha` (commit
  documentato), `trigger` (manual/push), `model`, `cost`, `stats` (jsonb: n.
  moduli/file/chunk, moduli falliti), `started_at`/`finished_at`, `error`.
- Il progetto punta alla generazione "corrente" (ultima `succeeded`).

### `doc_pages` (albero navigabile)
- `project_id`, `generation_id` (**null per le pagine manuali**), `kind`
  (`technical` | `functional` | `manual`), `slug`, `title`, `parent_id` + `position`
  (albero), `source_path` (modulo/file documentato, per le citazioni), `body` (markdown),
  `is_manual`, `created_by`, `updated_at`.
- Pagine generate → appartengono a una generation. Manuali → `generation_id` null,
  **sopravvivono intatte a ogni rigenerazione**.

### `doc_chunks` (ricerca semantica)
- `page_id`, `project_id`, `generation_id`, `content`, `embedding vector(N)`, `metadata`
  (jsonb: layer, source_path, heading), `token_count`.
- Indice **HNSW** su `embedding`; indice su `project_id` per il filtro.

### `doc_chat_sessions` / `doc_chat_messages` (storico)
- Sessione per `project_id` + `user_id`.
- Messaggi con `role`, `content`, `citations` (jsonb: riferimenti a `doc_pages`/
  `source_path`).

### Versionamento
La rigenerazione crea una nuova `doc_generation` + nuovo set di pagine/chunk; alla
conclusione **swap atomico** del puntatore "corrente" e **pruning** delle generation
vecchie (si tiene corrente + 1 precedente) per non gonfiare pgvector. Le pagine manuali
non vengono mai toccate.

## Pipeline di generazione (cuore)

Quattro fasi nel job worker, orchestrate da `docs-engine`.

### 1. Pass strutturale (deterministico, economico)
- Clone nel worktree (riuso). Walk dell'albero escludendo `node_modules`/`vendor`/build
  via `.gitignore` + euristiche.
- Rilevamento linguaggi e manifest (`package.json`, `composer.json`, `pyproject.toml`,
  `go.mod`…).
- Definizione **moduli** = confini di package/manifest, poi sottodirectory a profondità
  scelta. Rilevamento leggero della superficie pubblica (export, route HTTP, comandi CLI)
  e del **dependency graph** tra moduli.
- Output: **repo map** strutturato (JSON).
- **Monorepo enormi:** ranking moduli (dimensione, centralità nel grafo, superficie
  pubblica) + **limiti per-repo** (max moduli/token). Ciò che si taglia viene **loggato
  esplicitamente** (niente cap silenziosi).

### 2. Map (per modulo, parallelo, agentico)
- Un agent per modulo riceve i file del modulo + il repo map come contesto, e **può
  seguire import/leggere le dipendenze** entro un cap di tool-call/costo per modulo.
- Produce un doc di modulo strutturato: tecnica (responsabilità, API pubbliche con firme,
  flussi, design interno, dipendenze) + capability funzionali (cosa abilita, vincoli).
- Concorrenza limitata da budget e rate del provider.

### 3. Reduce (sintesi)
- Agent di sintesi aggregano i doc di modulo + repo map in:
  - **(a)** overview architetturale tecnica (come si incastrano i moduli, flussi
    cross-cutting, data flow, deploy);
  - **(b)** mappa delle capability funzionali (inventario feature, cosa è possibile/non
    possibile, flussi utente).
- Si costruisce l'albero pagine: tecnico (overview + pagine per modulo) e funzionale
  (pagine capability).

### 4. Embedding
- Chunking markdown-aware per heading (token target + overlap), embed di ogni chunk
  (Ollama) in pgvector con metadati.

### Costi & fallimenti
- Budget per-generation (riuso guardrail): held/stop al superamento, costo tracciato in
  `doc_generations`.
- Fallimenti per-modulo **best-effort**: il modulo è marcato fallito, la generazione
  prosegue e lo annota nelle stats.
- Map/reduce usano il provider Claude configurato; embeddings via embedding-provider
  separato e configurabile (Ollama default).

## Chat / RAG

**Endpoint:** `POST /api/projects/:id/docs/chat` (legato a una `doc_chat_session`),
risposta in **streaming**.

**Flusso:**
1. Domanda → embedding (Ollama) → vettore.
2. Ricerca pgvector filtrata per `project_id` + generazione corrente → top-K chunk.
   Opzionale **ibrido** con full-text (tsvector) per match esatti di nomi/termini.
3. Chunk + domanda + storico → **Claude** → risposta.

**Adattamento audience (system prompt):**
- Domanda **tecnica** → risposta tecnica con riferimenti a moduli/API.
- Domanda **capability** ("si può fare X") → risposta funzionale con **passi se
  fattibile**, oppure spiegazione del **perché non è fattibile**.
- **Rispondere solo dal contesto recuperato** (anti-allucinazione): se non basta, dirlo.
- **Citare** sempre pagine/sorgenti usate.

**Citazioni:** ritornate alla UI come link cliccabili alle pagine doc (e al `source_path`
dove utile) → tracciabilità, niente scatola nera.

**Storico:** salvato in `doc_chat_sessions`/`messages` con citazioni. **Costo:** tracciato
come gli altri job AI, dentro i budget/guardrail esistenti.

**Scope v1:** chat **per-progetto**. Cross-progetto (non filtrare per `project_id`) →
fase successiva.

## Navigazione e UI

Sezione **"Docs" di primo livello** nella sidebar generale.

- **Hub documentazione:** elenco progetti, ognuno uno **spazio** doc. Selezione progetto →
  albero.
- **Layout a tre zone** dentro lo spazio:
  - Sidebar: albero con tre spazi — **Tecnico** / **Funzionale** / **Manuale**.
  - Centro: render markdown (riuso `MarkdownEditor`); ogni pagina generata mostra badge
    "**documenta `source_path`**" + "**generato al commit `abc123`**".
  - Drawer **chat** con citazioni cliccabili.
- **Stato generazione:** pulsante "Genera documentazione" + stato ultima generazione
  (commit, data, costo, stats, moduli falliti). Rigenerazione da qui. In futuro:
  indicatore "documentazione non aggiornata".
- **Pagine manuali:** crea/modifica/elimina nello spazio Manuale con `MarkdownEditor`; mai
  toccate dalla rigenerazione.
- **Ricerca:** barra dedicata (distinta dalla chat): semantica + full-text, risultati che
  linkano alla pagina.
- **Permessi:** riuso ruoli esistenti (admin/maintainer genera, membri editano il
  manuale). Niente nuovo sistema di permessi.

## Trigger, costi/limiti, integrazione worker

**Trigger (v1):** generazione **manuale** dallo spazio Docs. No auto-trigger alla
connessione (controllo costi).

**Costi/limiti (riuso guardrail):**
- Budget per-generation: stop con parziale + held + notifica al superamento.
- Limiti strutturali per-repo (max moduli/token), troncamenti **loggati**.
- Notifiche via webhook Slack/Discord: "docs generate", "generazione fallita",
  "budget held".

**Integrazione worker (attenzione):**
1. **Staleness:** un job doc lungo può superare `WORKER_STALE_MINUTES` → gestire con
   **heartbeat** durante map/reduce o soglia consapevole del tipo di job (coerente con
   l'invariante staleness tenuto in sync su config/compose/index).
2. **Non affamare i fix:** worker singolo con lock in-process → priorità o separazione di
   coda per non bloccare i fix AI. Da definire nel piano.

## Aggancio ai push (fase 2 — predisposto in v1)

Lo schema v1 è già pronto: `commit_sha` per generazione e `source_path` per pagina/chunk.
Fase 2: webhook di push → diff tra `commit_sha` documentato e nuovo HEAD → mapping file
cambiati → moduli (via repo map) → **ri-esegui map solo sui moduli toccati** + reduce +
ri-embedda solo i chunk cambiati. Indicatore "documentazione non aggiornata" nel mentre.

## Strategia di test

Coerente col monorepo (package puri in isolamento, AI/servizi esterni mockati, E2E solo
in CI).

- **`packages/docs-engine`** (puro, deterministico): pass strutturale su **mini-repo
  fixture**, prioritizzazione e limiti, chunking, costruzione prompt, mapping *file
  cambiati → moduli* (v2).
- **`packages/db`:** migrazione + query (albero pagine, insert/ricerca chunk, ricerca
  pgvector HNSW). Rispetto limiti concorrenza testcontainer (`maxForks`).
- **`apps/server`:** API (trigger, lettura pagine, ricerca, chat) con **Claude e
  embedding-provider mockati**.
- **`apps/worker`:** job doc-generation con **agent mockati** — orchestrazione map-reduce,
  best-effort sui fallimenti, budget held, swap atomico, heartbeat/staleness.
- **`apps/web`:** componenti (albero, render pagina, chat) con API mockata.
- **E2E Playwright** (solo CI): navigazione Docs + chat, per le modifiche UI.

Principio: l'output AI è non-deterministico → si testa **pipeline e plumbing con agent
mockati**, non il testo prodotto. Qualità dei doc validata a mano in v1, con eval dedicata
più avanti.

## Fasatura

- **v1:** generazione manuale completa + navigazione (sezione Docs di primo livello) +
  chat per-progetto + pagine manuali.
- **v2:** aggiornamento incrementale dai push.
- **Futuro:** chat cross-progetto, rerank ibrido, embedding del codice (oltre alla prosa).
