# Fase 2b graphify — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Le chat interne (Docs repo/progetto, refinement backlog) arricchiscono ogni risposta con il sottografo del knowledge graph + snippet di codice reali, in parallelo al retrieval pgvector, fail-open.

**Architecture:** Modulo `apps/server/src/graph-chat/`: client MCP (Streamable HTTP, `@modelcontextprotocol/sdk`) verso il container `graphify` → `query_graph` → parser dei nodi → snippet dai bare mirror (volume `mirrors` ro, `git show <commitSha>:<path>`) → blocco di prompt appeso al system delle chat. Design completo: `docs/plans/2026-07-28-graphify-chat-retrieval-design.md` (LEGGILO PRIMA).

**Tech Stack:** `@modelcontextprotocol/sdk` ^1.20 (stessa major di packages/mcp); git CLI nell'immagine server; niente migrazioni DB, niente UI.

**Convenzioni trasversali:** TDD; `pnpm --filter @stubwise/server test` (testcontainers, serve Docker); commit `feat(server):`/`chore:` in italiano; `pnpm lint` + `pnpm typecheck` prima del merge; commenti in italiano nello stile dei file; lavorare nel worktree dedicato (verifica `git rev-parse --abbrev-ref HEAD` = branch feature prima di ogni commit). Regola d'oro del design: **la chat non deve MAI peggiorare per colpa del grafo** (fail-open ovunque).

---

### Task 1: `mirrorSlug` in packages/shared

**Files:** Create `packages/shared/src/mirror-slug.ts` (+ test) spostando la funzione da `apps/worker/src/git/mirrors.ts:173` (copia IDENTICA, stessi commenti); export dall'index di shared; in `mirrors.ts` sostituisci la definizione con re-export (`export { mirrorSlug } from "@stubwise/shared"`) così i chiamanti worker (fix.ts) non cambiano. Test: 2-3 casi (https URL, ssh URL, stabilità dell'hash — copia i valori attesi da un'esecuzione della funzione originale, NON inventarli). Poi `pnpm --filter @stubwise/shared build` (dist consumata da server e worker) e suite shared+worker verdi. Commit `chore(shared): mirrorSlug condiviso tra worker e server`.

### Task 2: Config server + dipendenza MCP

**Files:** `apps/server/src/config.ts` (+test) — env `GRAPHIFY_MCP_URL` (default `http://graphify:8080/mcp`; stringa vuota → undefined = spento), `GRAPH_CHAT_TOKEN_BUDGET` (int, 1200), `GRAPH_CHAT_SNIPPET_MAX_CHARS` (6000), `GRAPH_CHAT_SNIPPET_NODES` (6), `MIRRORS_DIR` (default `/var/stubwise/mirrors`, come il worker — verifica il default reale in `apps/worker/src/config.ts` e allineati). `apps/server/package.json`: aggiungi `@modelcontextprotocol/sdk` (stessa versione di packages/mcp). Pattern env esistenti del file. Commit.

### Task 3: Modulo graph-chat — client MCP con circuit breaker

**Files:** Create `apps/server/src/graph-chat/client.ts` + test.
- `createGraphMcpClient(url)`: singleton pigro sul `Client` + `StreamableHTTPClientTransport` dell'sdk; metodo `queryGraph({ projectPath, question, tokenBudget, timeoutMs })` → chiama il tool `query_graph` (argomenti: `question`, `project_path`, `token_budget`) e ritorna il TESTO del risultato, o `null` su qualunque errore/timeout (~2s, `AbortSignal.timeout`).
- Circuit breaker minimale: dopo 3 errori consecutivi, `queryGraph` ritorna `null` senza tentare per 5 minuti (timestamp in memoria); un successo azzera. Un solo `log.warn` all'apertura del circuito, non a ogni chiamata.
- Su errore di trasporto chiudi/azzera il client cached (riconnessione pigra al tentativo successivo).
- Test con un finto server MCP HTTP locale (usa l'sdk lato server in-process su una porta effimera, pattern dei test di packages/mcp se esiste; altrimenti mock del Client sdk): risposta ok → testo; errore → null + circuito che si apre dopo 3; riapertura dopo il cooldown (inietta un clock/fake timer).

### Task 4: Parser del sottografo + snippet dai mirror

**Files:** Create `apps/server/src/graph-chat/subgraph.ts` + `snippets.ts` + test.
- `parseSubgraphNodes(text)`: estrae in ordine le righe `NODE <label> [src=<path> loc=L<n> ...]` (regex tollerante; fixture: un output REALE di query_graph — generane uno col graphify del worker in locale o riusa l'esempio nel design). Salta nodi senza `src`/`loc`, nodi-file (`loc=L1` e label = basename del path) e duplicati stesso file con `|L1-L2| < 10`.
- `extractSnippets({ mirrorsDir, repoUrl, commitSha, nodes, maxNodes, maxTotalChars })`: per ogni nodo (fino a maxNodes) esegue `git --git-dir=<mirrorsDir>/<mirrorSlug(repoUrl)> show <commitSha>:<path>` (execa, timeout breve), fallback `HEAD:<path>` se lo sha non risolve, skip silenzioso su errore; finestra righe `[L-3, L+35]` (clamp ai bordi), accumula finché `maxTotalChars`; ritorna `{ path, startLine, endLine, code }[]`.
- Test di `extractSnippets` su un **bare repo git vero** creato in tmp (init + commit di 2 file + `git clone --bare`): finestra corretta, fallback HEAD, file inesistente → skip, tetto chars rispettato. Niente mock di git.

### Task 5: `retrieveGraphContext` + blocco di prompt

**Files:** Create `apps/server/src/graph-chat/context.ts` + test.
- `buildGraphContextBlock(subgraphText, snippets, commitSha)`: il formato del design (§3) con le due righe di istruzioni (domande STRUTTURALI, cita `file:riga`, priorità alle docs per il funzionale). Testo istruzioni in inglese come `buildDocsSystemPrompt` (verifica la lingua reale dei system esistenti e adeguati).
- `retrieveGraphContext(deps, { repositoryId, question, budget })`: gating (repo `graphEnabled` + `repo_graphs.status='done'` + `commitSha` non null — una select), `queryGraph` via client, parse, snippet, blocco. Ritorna `string | null`; QUALUNQUE eccezione interna → `null` (try/catch di modulo con log debug). Variante `retrieveGraphContextForProject(projectId, ...)`: repo abilitati del progetto, query in parallelo con `tokenBudget/N`, blocchi concatenati (ordine stabile per nome repo).
- Test con client/git mockati (qui sì): gating off → null e NESSUNA chiamata MCP; query null → null; happy path → blocco con sottografo+snippet; eccezione → null.

### Task 6: Innesto nelle tre superfici (widget ESCLUSO)

**Files:** Modify `apps/server/src/routes/docs-chat.ts`, `project-docs.ts`, `backlog.ts` (+ i loro test) — e NIENT'ALTRO.
- In ciascuna: dove si costruisce il `system` dai chunk recuperati, lancia `retrieveGraphContext` (o `...ForProject` nella chat di progetto) **in `Promise.all` col retrieval pgvector**, e appendi il blocco (se non null) al system. Le deps (client MCP, config, db) arrivano dal plumbing esistente delle route (guarda come ricevono `chatLlm`/db e replica).
- Test per superficie (harness esistente, MCP client mockato): (a) repo con grafo → il system passato al ChatLlm contiene `STRUTTURA DEL CODICE`; (b) grafo assente/client che fallisce → system identico a prima (snapshot/confronto) e risposta OK; (c) **widget**: test negativo in `widget-chat.test.ts` — il system della chat widget NON contiene mai il blocco (e nessuna chiamata al client).
- Commit per superficie o unico, a discrezione.

### Task 7: Immagine server + compose + verifica finale

**Files:** `apps/server/Dockerfile` (aggiungi `git` all'apt del runtime stage), `docker-compose.yml` (server: mount `mirrors:/var/stubwise/mirrors:ro` — il volume `mirrors` esiste già; env `GRAPHIFY_MCP_URL`/`MIRRORS_DIR` esplicite + le `GRAPH_CHAT_*` col pattern `${VAR:-default}` usato per le altre), `.env.example` (documenta le nuove env).
- Verifiche: `docker build -f apps/server/Dockerfile .` ok + `docker run --rm <img> git --version` ok; `docker compose config` valido (env-file .env.example + POSTGRES_PASSWORD fittizia).
- Finale: `pnpm typecheck`, `pnpm lint`, `pnpm test` dalla radice tutti verdi; poi superpowers:finishing-a-development-branch (merge --no-ff su main).
- **Deploy (con l'utente, non in autonomia)**: rebuild solo `server`; rollback = `GRAPHIFY_MCP_URL=` vuota in .env.
