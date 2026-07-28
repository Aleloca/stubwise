# Retrieval strutturale dal knowledge graph nelle chat (fase 2b graphify)

> Nota: questo repo non è collegato all'istanza Stubwise (scelta del 27 lug 2026):
> il tracking vive in `feature-backlog.md`, nessuna voce di backlog/ticket.

## Contesto e obiettivo

Con la fase 1 ogni repository può avere un knowledge graph (graphify, AST-only)
tenuto fresco dal worker sul volume `graphs`, e un container `graphify serve`
MCP HTTP gira sulla rete interna **senza ancora consumatori**. Con la 2a gli
agenti CLI lo interrogano nei loro run.

Obiettivo della 2b (l'obiettivo originario dell'adozione di graphify):
**rispondere alle domande strutturali sul codice direttamente nelle chat**
("chi chiama X?", "dove si gestisce Y?", "come sono collegati A e B?") senza
spawnare una sessione claude CLI — gratis e in millisecondi, fondando le
risposte sul codice corrente invece che solo sulle docs generate (che possono
essere indietro).

Decisioni prese in brainstorming (28 lug 2026):
- **Superfici: entrambe da subito** — chat Docs (repo e progetto) e refinement
  del backlog, con meccanismo condiviso. Il **widget resta fuori** (superficie
  pubblica: il codice non deve trafilarci).
- **Routing: sempre**, in parallelo al retrieval pgvector (niente classificatori
  né tool-use: la query al grafo è locale e gratuita, il modello ignora il
  contesto irrilevante).
- **Snippet: sì**, letti dai bare mirror montati read-only sul server,
  best-effort.

## 1. Architettura del retrieval ibrido

Nuovo modulo `apps/server/src/graph-chat/` con
`retrieveGraphContext(repositoryId, question, budget)`:

- **Client MCP** verso `http://graphify:8080/mcp` (env `GRAPHIFY_MCP_URL`,
  vuota = feature spenta) con `@modelcontextprotocol/sdk` (Streamable HTTP).
  Singleton con riconnessione pigra; il serve è `--stateless`.
- **Una chiamata `query_graph`** per domanda: `question` = domanda utente,
  `project_path=/graphs/<repositoryId>`, `token_budget` da env
  `GRAPH_CHAT_TOKEN_BUDGET` (default ~1.200), depth default. **Timeout ~2s**,
  fail-open totale (container giù / grafo assente / vuoto → chat identica a
  oggi).
- **Gating automatico, nessun toggle nuovo**: solo repo con `graphEnabled` e
  `repo_graphs.status='done'`.
- **Innesto**: `answerDocsQuestion`, `answerProjectDocsQuestion` e il refinement
  backlog lanciano grafo e pgvector **in parallelo** (`Promise.all`: la query è
  più veloce dell'embedding, latenza invariata). Chat di progetto: query sui
  grafi di tutti i repo abilitati, budget diviso per N.

## 2. Snippet di codice dai mirror

Il sottografo elenca nodi `NODE label [src=<path> loc=L<n> ...]` (seed per
primi, formato stabile):

- **Selezione**: primi K nodi (env `GRAPH_CHAT_SNIPPET_NODES`, default 6)
  nell'ordine del sottografo, saltando i nodi-file (loc=L1 con label=basename)
  e i quasi-duplicati per file:riga.
- **Lettura**: il server monta il volume **`mirrors` in read-only** e legge i
  blob con `git --git-dir=<mirror> show <sha>:<path>`, dove `<sha>` è
  **`repo_graphs.commitSha`** (il commit su cui il grafo è stato costruito: le
  righe combaciano anche se il mirror è avanzato). Fallback `HEAD`, poi skip.
- **Finestra** ~`[L-3, L+35]` per nodo, tetto complessivo
  `GRAPH_CHAT_SNIPPET_MAX_CHARS` (default ~6.000); oltre, si smette di
  aggiungere snippet — la mappa resta intera.
- **Requisiti**: `git` nell'immagine server (apt); `mirrorSlug(repoUrl)` si
  SPOSTA in `packages/shared` (il worker la ri-esporta, zero doppioni); env
  `MIRRORS_DIR` sul server, stesso path del worker.
- **Fail-open per snippet**: fetch concorrente del worker, file assente, path
  anomalo → si salta quel singolo snippet (log debug), mai errori in chat.

## 3. Fusione nel prompt e citazioni

- **`buildGraphContextBlock(subgraphText, snippets, commitSha)`** appeso al
  system prompt esistente delle chat, dopo i chunk documentali:

  ```
  --- STRUTTURA DEL CODICE (knowledge graph al commit <sha7>) ---
  <sottografo di query_graph>
  --- ESTRATTI DAL CODICE ---
  ### <path>:L38-L74
  <fence col codice>
  ```

  con due righe di istruzioni: usa questa sezione per le domande STRUTTURALI e
  cita sempre `file:riga`; per le domande funzionali restano prioritarie le
  pagine di documentazione.
- **Anti-injection invariata**: sottografo e snippet = contenuto del repo,
  stesso livello di fiducia dei chunk delle docs generate; blocco delimitato.
- **Citazioni UI invariate** (YAGNI): le citations cliccabili restano le pagine
  doc; i riferimenti al codice vivono nel testo come `path:riga`.
- **Perimetro**: SOLO superfici interne. Il percorso di retrieval del widget
  NON viene toccato.
- **Budget prevedibile**: ~1.200 token di sottografo + ~6.000 char di snippet
  (~1.500 token) per domanda.

## 4. Error handling, config, test, deploy

- **La chat non peggiora MAI per colpa del grafo**: timeout ~2s,
  circuit-breaker semplice (N errori consecutivi → pausa di qualche minuto, un
  warning), qualunque fallimento degrada alla chat di oggi. Nessun retry
  sincrono dentro la richiesta SSE.
- **Env (tutte con default)**: `GRAPHIFY_MCP_URL`
  (`http://graphify:8080/mcp`; vuota = spento), `GRAPH_CHAT_TOKEN_BUDGET`
  (1200), `GRAPH_CHAT_SNIPPET_MAX_CHARS` (6000), `GRAPH_CHAT_SNIPPET_NODES`
  (6), `MIRRORS_DIR`. Niente migrazioni, niente UI nuova.
- **Test**: parser dei `NODE` su output reale di query_graph; builder del
  blocco; estrattore di snippet su un **repo git bare vero in tmp** (no mock di
  git); superfici chat con client MCP mockato (blocco presente col grafo,
  assente su fail/spento, widget MAI); circuit-breaker.
- **Deploy**: rebuild `server` (git nell'immagine + sdk MCP + shared
  ribuildato) + mount `mirrors:ro` e env nel compose. Worker/caddy intoccati;
  graphify è già su. Rollback: `GRAPHIFY_MCP_URL=` vuota.
