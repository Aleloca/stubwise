# Documentazione — Motore ricorsivo a DAG (design)

**Data:** 2026-06-23
**Stato:** design validato (brainstorming), pronto per il piano di implementazione.
**Sostituisce:** il motore di generazione piatto (pass strutturale + map-reduce + capability
deep-pass) di `docs/plans/2026-06-22-stubwise-docs-confluence-design.md`. Il *lato consumo*
(pagine, ricerca, chat, embedding, UI) resta invariato.

## Problema

Il motore attuale è **piatto e meccanico**: documenta le cartelle top-level (una pagina
ciascuna) e fa una passata funzionale al primo livello. Conseguenze osservate (Wilco):
- documenta cartelle che non sono architettura ma **contesto** (`plans`, `guides`, `docs`,
  `manual` — artefatti delle sessioni Claude);
- tratta `app` (il cuore della webapp, tutte le route) come una cartella qualsiasi: una sola
  pagina con un elenco parziale, invece di una decomposizione per route/file;
- il funzionale resta superficiale (elenchi di feature, poco approfonditi);
- nessun collegamento tra le pagine.

Si vuole una documentazione **gerarchica, ricorsiva e "intelligente"**, con profondità
proporzionale all'importanza, e con le pagine che si parlano tra loro.

## Decisioni di fondo (dal brainstorming)

1. **Chi decide:** un **agente Claude ricorsivo** decide quali unità documentare e quanto
   scendere (non template per framework, non scan deterministico).
2. **Esecuzione:** **job durabili con dipendenze (DAG)** — ogni unità è un job; il padre non
   blocca il worker (parcheggia dopo aver accodato i figli); la sintesi parte al completamento
   dei figli.
3. **Struttura:** **due alberi paralleli cross-linkati** — *tecnico* (per struttura del
   codice) e *funzionale* (per capacità).
4. **Granularità:** l'agente giudica "**merita una pagina propria?**"; il minore va dentro la
   madre. Profondità emergente; cap massimo solo come salvagente anti-loop.
5. **Cross-link:** principali **ancorati ai path** del codice (implementa/implementato-da);
   correlati per **similarità semantica** (pgvector); padre↔figlio dall'albero.
6. **Perimetro:** si **riscrive la generazione**, si **riusa il consumo** (output sempre
   `doc_pages` annidato + `doc_chunks`; UI/ricerca/chat/embedding invariati). Il vecchio codice
   di generazione viene rimosso a nuovo motore funzionante.
7. **Vincolo:** **costo/token irrilevanti, conta la qualità massima.**

## Architettura (4 stadi)

1. **Orientamento** (job radice): un agente perlustra il repo, rileva lo stack/framework,
   separa architettura da rumore, e semina le due radici (unità tecniche + capability di primo
   livello).
2. **Esplorazione ricorsiva** (job-nodo): ogni nodo esplora la sua unità (agentic, read-only),
   scrive la sua doc, decide i figli che meritano una pagina → accoda job-nodo figli → parcheggia.
3. **Join + sintesi:** a figli completi, il nodo sintetizza l'overview che linka i figli. La
   generazione finisce quando la radice è `done`.
4. **Cross-link + embedding:** risoluzione link *implements* (per path) → proiezione in
   `doc_pages` → chunk+embed → link *related* (semantici) → swap del puntatore corrente.

**Dove vive:** logica pura (prompt, parser output strutturato, helper DAG) in
`packages/docs-engine`; orchestrazione dei job-nodo durabili in `apps/worker` (estende la coda
doc-job); nuova tabella `doc_nodes` in `packages/db`. Server/web/ricerca/chat/embedding
invariati.

## Il DAG di job durabili (stato + anti-deadlock)

Ogni unità = una riga `doc_nodes` con uno stato. **Explore e synthesize sono due job
claimabili separati**: un padre non occupa mai il worker mentre i figli girano (no deadlock sul
worker singolo).

**Stati:** `pending → exploring → awaiting_children → ready_to_synthesize → synthesizing →
done` (una *foglia* salta l'attesa: `exploring → done`). Più `failed`.

1. Claim di un `pending` → **EXPLORE**: l'agente esplora, scrive il body, decide i figli. Se
   figli → crea righe figlie (`pending`), `pending_children = N`, padre → `awaiting_children`
   (rilascia il worker). Se foglia → body completo → `done`.
2. I figli vengono reclamati e processati ricorsivamente, **in parallelo** fino alla
   concorrenza del worker (il DAG parallelizza i fratelli).
3. **Join (atomico):** un figlio che arriva a `done` (o `failed`), in transazione con lock sul
   padre, decrementa `pending_children`; a 0 → padre `ready_to_synthesize`. Il lock evita la
   race di più figli concorrenti; un figlio fallito **conta** per il join (no blocco del padre).
4. Claim di un `ready_to_synthesize` → **SYNTHESIZE**: l'agente scrive l'overview che linka i
   figli + registra i path → `done` → ri-scatena il join sul *suo* padre.
5. La generazione finisce quando la **radice** è `done`.

**Worktree:** una sola copia per generazione (creata all'orientamento, riusata read-only da
tutti i nodi, rimossa a finalizzazione). La generazione "tiene" il mirror del progetto per la
sua durata → serializza verso i fix-job (per-progetto, catena esistente) ma parallelizza
internamente i nodi.

## Modello dati

**`doc_nodes`** (nuova) — il DAG + il contenuto di lavoro:
- `id`, `generation_id` (FK), `project_id`, `parent_id` (self-ref, null per le radici), `tree`
  (`technical` | `functional`);
- `status` (enum), `pending_children` (int, per il join), `depth`, `position`;
- `unit_ref` (path o capability), `title`, `slug`;
- `source_paths` (jsonb: path coperti — cross-link *e* futuro incrementale);
- `body` (markdown prodotto), `links` (jsonb risolto a fine: `[{type, slug, title}]`);
- `error`, usage/cost, timestamp.
- Indici: `(generation_id)`, claim su `status`, `(parent_id)`.

**Riuso:**
- `doc_generations` invariata (il DAG appartiene a una generazione).
- `doc_pages` invariata come formato: a **finalizzazione** i nodi `done` sono **proiettati** in
  `doc_pages` (`parent_id`→`parentId`, `tree`→`kind`, slug/title/body/source_path), poi swap
  atomico di `currentDocGenerationId`. `doc_nodes` resta tabella di lavoro (prunabile).
  **Aggiunta minima:** campo `links` jsonb su `doc_pages` per i cross-link.
- `doc_chunks` invariata (embed delle pagine finali).

**I job sono i nodi:** il worker reclama i `doc_nodes` claimabili (`pending`→explore,
`ready_to_synthesize`→synthesize) con `FOR UPDATE SKIP LOCKED`. Il vecchio
`doc_generation_jobs` resta il **trigger** d'ingresso: al claim esegue l'orientamento e crea le
radici.

## Orientamento

Il job-trigger crea il worktree di generazione e lancia l'**agente di orientamento**
(read-only, agentic):
- perlustra repo + manifest (`package.json`, config framework);
- **rileva lo stack/framework** e ragiona sulle convenzioni ("Next app router → tutto il
  user-facing in `app/`; le route hanno sotto-route");
- **classifica** le cartelle top-level architettura vs rumore (`plans`/`docs`/`manual`/`guides`
  → esclusi dal tecnico), **spiegando** la classificazione (auditabile/loggabile);
- produce un **piano strutturato**: figli della radice tecnica (unità di primo livello + perché
  + `source_paths`) e della radice funzionale (capability di primo livello + path che le
  implementano).

Il trigger crea: le due radici ("Architecture Overview", "Capability Map") + i nodi di primo
livello (`pending`). Output **strutturato** (marcatori/JSON) parsato in `doc_nodes`, forzato e
validato (no formato libero per output machine-parsed). Modello: Opus, alto sforzo.

## Esplorazione di un nodo (EXPLORE)

L'agente riceve `unit_ref`, contesto del padre, l'albero, e accesso read-only al worktree.
- **Nodo tecnico:** documenta a fondo l'unità di codice (cos'è, responsabilità, file/API,
  come funziona), ancorato al codice; decide le **sotto-unità** che meritano una pagina (figli
  con `unit_ref`/path, titolo, perché); registra i `source_paths`.
- **Nodo funzionale:** documenta a fondo la capability in **linguaggio non tecnico** (tutto ciò
  che si può fare, passi, opzioni, limiti — lo stile profondo già validato); decide le
  **sotto-capability** (figli con titolo + `source_paths` che le implementano); registra i path.

**Output strutturato:** `{ body, children: [{title, unit_ref|paths, why}], source_paths }`.
Il worker scrive body + path; con figli → crea righe + `awaiting_children`; senza → foglia →
`done`. Heartbeat via onProgress. Best-effort: explore fallita dopo retry → nodo `failed`,
sblocca comunque il join del padre, annotato nelle stats.

## Sintesi e cross-linking

**Sintesi** (ramo coi figli `done`): l'agente riceve il proprio intro + titoli/riassunti dei
figli; scrive l'**overview** che **linka i figli** (indice). Le foglie non sintetizzano.

**Cross-link**, in ordine:
1. **Padre↔figlio:** già nell'albero + link nell'overview.
2. **Implementa/implementato-da (per path):** mappa `source_path → nodo/i tecnico/i`; per ogni
   nodo funzionale, per ogni `source_path`, link ai nodi tecnici che coprono quel path (e
   inverso). Deterministico.
3. **Correlati (semantici):** *dopo* l'embedding, top-K pagine più simili (escludendo
   padre/figlio/già-linkate) via pgvector.

**Finalizzazione:** nodi `done` → link *implements* → proiezione in `doc_pages` (con i link) →
chunk+embed in `doc_chunks` → link *related* → scrittura `links` sulle pagine → swap del
puntatore corrente. I `links` resi come piccola sezione "Implementa / Correlati" (additiva).

## Limiti, errori, costo

**Salvagenti anti-runaway:** cap di profondità (es. 6, salvagente — l'agente di norma si ferma
prima); cap sul numero totale di nodi (es. qualche centinaio) con **logging esplicito** se
raggiunto; **dedup anti-ciclo** (un nodo non propone un figlio con path già coperto da un
antenato → scartato e loggato).

**Errori / best-effort:** explore/synthesize falliti → nodo `failed`, sblocca il join,
annotato. Generazione "parziale" con elenco dei falliti. Radice fallita o troppi fallimenti →
generazione `failed`, niente swap.

**Heartbeat/staleness:** explore e synthesize sono job brevi e separati → staleness limitata
per-nodo; ogni chiamata col timeout per-call (`DOC_AGENT_TIMEOUT_MS`).

**Costo:** tracciato per-nodo, aggregato in `doc_generations.cost` + stats (nodi, profondità,
fallimenti). Sull'account → nessun addebito. Budget cap opzionale.

## Predisposizione futura (non in questo scope)

Il DAG + i `source_paths` per-nodo rendono naturale l'**aggiornamento incrementale dai push**:
diff dei file cambiati → nodi toccati (per path) → ri-esegui explore/synthesize solo di quei
sottoalberi → ri-embed delle pagine cambiate. Stesso schema.

## Testing

- **`docs-engine` (puro):** prompt builder (orientamento/explore/synthesize); parser
  dell'output strutturato (marcatori + validazione); helper DAG (dedup figlio-vs-antenato,
  mappatura `source_path → nodo` per gli *implements*, selezione *related* data una funzione di
  similarità iniettata). Fixture, no I/O.
- **`db`:** migrazione `doc_nodes` + **join atomico** (race test: più figli concorrenti fanno
  scattare il padre esattamente una volta). Testcontainer.
- **`worker`:** macchina a stati dei job-nodo con `FakeAgentRunner` — explore-ramo → figli +
  `awaiting_children`; foglia → `done`; join → `ready_to_synthesize`; synthesize → `done`;
  radice `done` → finalizzazione → proiezione `doc_pages` + embed (`FakeEmbeddingClient`);
  nodo fallito sblocca il join; cap profondità/nodi loggati; worktree unico creato/ripulito.
- **`server`/`web`:** consumo riusato; component test per il rendering dei `links`; verifica
  che il `DocsTree` (già ricorsivo) renda un albero a 3 livelli.
- **E2E (CI):** generazione su mini-repo fixture → albero profondo annidato + cross-link.

**Principio:** AI non-deterministica → si testano la meccanica del DAG e il plumbing con agent
**fake** (output di orientamento/explore/synthesize finti ma strutturati), non il testo del
modello. La qualità si valida a mano; i link *implements* sono deterministici.

## Fuori scope
- Aggiornamento incrementale dai push (predisposto, fase successiva).
- Redesign della UI di consumo (l'albero è già ricorsivo; solo l'aggiunta additiva della
  sezione `links`).
- Chat cross-progetto, rerank ibrido (separati).
