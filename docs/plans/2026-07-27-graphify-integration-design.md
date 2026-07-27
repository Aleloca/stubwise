# Integrazione graphify: grafo del codice per repo, PR di setup e tab "Grafo"

> Nota: questo repo non è collegato all'istanza Stubwise (scelta del 27 lug 2026):
> il tracking della feature vive in `feature-backlog.md`, nessuna voce di backlog/ticket.

## Contesto e obiettivo

[graphify](https://github.com/Graphify-Labs/graphify) (PyPI `graphifyy`, Apache
2.0) costruisce un knowledge graph del codice **localmente via tree-sitter**
(zero LLM, zero API): nodi = classi/funzioni/file, archi tipizzati
(`calls`/`imports`/`inherits`/…) con provenienza `EXTRACTED`/`INFERRED` e
file:riga. Query engine lessicale (IDF + trigram + BFS sul grafo, niente
embeddings), server MCP (stdio/HTTP multi-progetto), output: `graph.json`,
`GRAPH_REPORT.md` (god nodes, comunità Leiden, connessioni sorprendenti),
`graph.html` interattivo autocontenuto.

**Validazione empirica sul monorepo Stubwise** (v0.9.28, code-only): 41s, 5.701
nodi, 11.463 archi, 263 comunità, 0 token LLM. `graph.json` 5,8 MB,
`graph.html` 251 KB (vista aggregata automatica sopra 5.000 nodi).
`explain "streamChatResponse"` → tutti i chiamanti reali con file:riga esatti.
Limite noto: l'output di `query` è una **mappa** (nomi di nodi + archi), non
contenuto — ottimo per agenti che poi navigano, non sostituisce la RAG
vettoriale della chat.

Obiettivo di questa feature (la "fase 1" dell'adozione):

1. Generare e tenere fresco il grafo per-repository dal worker (server-side).
2. PR di setup sul repo target: i dev pullano e hanno grafo + skill + MCP pronti.
3. Tab "Grafo" nella sezione Docs per vedere report e grafo interattivo.
4. Servizio HTTP centrale `graphify serve` nel compose, pronto per i futuri
   consumatori (chat backlog/docs).

Fuori scope (fasi successive): retrieval ibrido nella chat RAG, impatto grafo
nella PR review, orient dei Docs seedato dal grafo.

## Architettura

Tre attori nuovi/modificati:

- **Worker (generatore)**: nuova famiglia di job `graph_build` nella coda
  esistente (claim SKIP LOCKED, serializer per-progetto). Il job apre un
  worktree read-only a HEAD del mirror (`MirrorManager.openWorktree`), esegue
  `graphify extract <worktree> --code-only` con
  `GRAPHIFY_OUT=/graphs/<repositoryId>/graphify-out`, chiude il worktree.
  Incrementale: cache SHA256 + manifest portabile (path relativi ri-ancorati,
  quindi i path effimeri dei worktree non invalidano la cache).
- **Volume condiviso `graphs`** (named volume): montato **rw sul worker**,
  **ro sul container graphify** e **ro sul server** (che serve
  report/html/json alla SPA dietro l'auth esistente). Postgres tiene solo i
  metadati — tabella `repo_graphs`: repositoryId, status
  (none/queued/running/done/failed), sha generato, contatori
  nodi/archi/comunità, error, timestamps. Niente blob in DB.
- **Container `graphify`**: immagine Python 3.12 + `graphifyy` **pinnata**,
  `python -m graphify.serve --transport http --stateless` senza grafo di
  default (multi-progetto puro: ogni chiamata passa
  `project_path=/graphs/<repositoryId>`). Hot-reload automatico su mtime di
  graph.json. Esposto SOLO sulla rete interna del compose (nessuna route
  caddy): consumatori = server e, in futuro, la chat.

L'immagine **worker** va estesa con Python 3.12 + `graphifyy[sql]` (l'extra
`sql` copre i file di migrazione: senza, 62 file .sql restano fuori dal grafo).

## Generazione: trigger, freshness, labeling

- **Trigger manuale**: bottone admin "Genera grafo" nella tab Grafo →
  `POST /api/repositories/:id/graph/generate` → job `graph_build` in coda →
  polling 10s in UI. Unicità sul job attivo per repo (niente doppi accodamenti).
- **Freshness automatica (modello ibrido)**: dopo il fetch del mirror sul
  webhook push, se il repo ha il grafo abilitato → `graph_build` con
  **debounce 60s per repo** (pattern `activity_recount_jobs`). Rigenerazione
  incrementale (secondi sui push tipici). **Nessun commit automatico sul
  repo**: il worker aggiorna solo il volume. `--force` passato solo quando il
  push contiene cancellazioni di file (lo shrink-guard di graphify resta attivo
  contro estrazioni parziali).
- **Report e labeling comunità**: dopo l'extract il job genera
  `GRAPH_REPORT.md` e `graph.html`. I nomi delle comunità usano il backend
  `claude-cli` di graphify col claude CLI già nel worker (una chiamata batch),
  gated da env `GRAPH_LABEL_ENABLED` (default on), soggetto a
  serializer/pausa-limite come gli altri run agente. Labeling fallito → grafo
  valido con placeholder "Community N": mai bloccante.
- **Abilitazione**: toggle per-repository (colonna su `repositories`, default
  **off**), gestito dal dettaglio progetto in /team come Docs/backlog.

## PR di setup ("i dev pullano e hanno tutto")

Bottone admin "Apri PR di setup" → job `graph_setup_pr` che riusa il
macchinario della fix pipeline (worktree → branch `stubwise/graphify-setup` →
commit → push → PR sul provider, con i safeguard anti-leak sui `git add`).
Contenuto del commit:

- **`graphify-out/`**: `graph.json`, `GRAPH_REPORT.md`, `graph.html`,
  `manifest.json` (copiati dallo stato corrente sul volume). Esclusi `cache/` e
  `cost.json` (righe `.gitignore`).
- **`.graphifyignore`** di partenza (derivato dal .gitignore del repo).
- **`.gitattributes`**: merge driver union per `graph.json` (niente conflict
  marker con commit paralleli).
- **`.mcp.json`**: voce `graphify` con
  `uvx --from "graphifyy[mcp]" python -m graphify.serve graphify-out/graph.json`
  — zero install per chi ha `uv`: tool `query_graph`/`get_node`/`shortest_path`
  disponibili al primo avvio di Claude Code.
- **Skill project-scoped** (`.claude/skills/graphify/`, output di
  `graphify install --project`) + **sezione CLAUDE.md** query-first. Niente
  PreToolUse hook nel PR (invasivo, opt-in personale).

Descrizione del PR: istruzioni dev (`uv tool install graphifyy` +
`graphify hook install` per post-commit rebuild locale e registrazione del
merge driver, che `.gitattributes` da solo non attiva). Il PR è idempotente:
rilanciarlo aggiorna il branch esistente.

## Tab "Grafo" nella sezione Docs

Nuova tab per-repository nella sidebar a tab. Stati: non abilitato (CTA verso
/team per gli admin) / mai generato (bottone Genera) / in coda-in generazione
(badge + polling 10s) / fallito (errore + Riprova). Vista a grafo pronto:

1. **Header metadati**: data, sha, contatori, badge "aggiornato al push";
   azioni admin Rigenera + Apri PR di setup (→ link al PR una volta aperto).
2. **`graph.html`** in **iframe sandboxed** (`sandbox="allow-scripts"`, no
   same-origin), servito dal server dal volume ro dietro auth di sessione.
3. **`GRAPH_REPORT.md`** renderizzato col componente `<Markdown>` esistente.
4. **Footer**: download `graph.json` + hint `graphify query "..."` copiabile.

Route server: `GET /api/repositories/:id/graph` (metadati/stato) + `/report`,
`/html`, `/json` (contenuti dal volume). File mancante con stato `done`
(volume ricreato) → stato torna a "mai generato" con invito a rigenerare.

## Error handling, test, deploy

- **Job**: pattern `backlog_jobs` — 3 tentativi, recovery orfani, errore su
  `repo_graphs` e in UI. Il build è corto, stateless e ri-eseguibile: un
  riavvio del worker a metà job non perde nulla → **non allunga la checklist
  del riavvio worker** (invariante docs).
- **Versioni**: `graphifyy` pinnata identica in worker e container graphify;
  upgrade deliberati (progetto fast-moving).
- **Test**: handler job con runner CLI mockato; route server con
  testcontainers (metadati, auth, 404 su volume vuoto); tab UI in happy-dom
  (4 stati). Niente E2E dedicato (worker fuori dallo stack E2E).
  `pnpm lint` prima del merge.
- **Deploy (in ordine)**: backup DB → migrazione (`repo_graphs` + toggle su
  `repositories` + debounce) → volume `graphs` nel compose → rebuild
  `worker` + `server` + `caddy` + nuovo servizio `graphify` → env `GRAPH_*`
  (facoltative). Toggle default off: al deploy nessun comportamento cambia.

## Decisioni prese (e alternative scartate)

- **Storage su volume condiviso**, non blob in Postgres: serve il hot-reload
  di `graphify serve` e evita blob da ~6 MB in DB.
- **Freshness ibrida** (worker server-side + hook locale dei dev), non
  auto-commit dal worker (rumore + rischio loop webhook) né solo-repo
  (stale-by-default).
- **UI dentro Docs**, non /team né sezione nuova: la mappa del codice è
  documentazione autogenerata.
- **Servizio HTTP nel compose fin da subito** (scelta esplicita, pur senza
  consumatori immediati) + config MCP committata per i dev locali.
