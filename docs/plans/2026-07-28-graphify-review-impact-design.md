# Impatto del grafo nella PR review (fase 2d graphify)

> Nota: repo non collegato all'istanza Stubwise; tracking in `feature-backlog.md`.

## Obiettivo

La pipeline di PR review usa il knowledge graph in due modi:

1. **Parità con la 2a**: l'agente reviewer (run plan-mode) riceve il blocco CODE
   GRAPH nel prompt e l'allowlist `GRAPHIFY_AGENT_ALLOWED_TOOLS` — la 2a aveva
   coperto fix/deep dive/sessioni ma non la review.
2. **Blast radius deterministico**: dai file toccati dal diff si calcola, sul
   `graph.json` del volume, quali comunità del codice la PR attraversa e quali
   god nodes coinvolge. Il risultato (a) guida il reviewer nel prompt, (b)
   diventa una sezione "Impatto sul codice" nel commento di review pubblicato
   sulla PR (2-4 righe, dato deterministico non allucinabile). Decisione del
   28 lug 2026: visibile, non solo prompt.

I tool `graphify prs` nativi sono GitHub-only (noi Bitbucket): il calcolo è
fatto in casa, in Node, nel worker.

## Design

**Modulo `apps/worker/src/graph/blast-radius.ts`** (puro, testabile):
- `computeBlastRadius({ graphJsonPath, changedFiles, caps })` → `null` su
  qualunque problema (file assente, JSON illeggibile) o
  `{ communities: [{ name, filesTouched, nodesTouched }], godNodes: [{ label,
  degree }], nodesTouched, filesInGraph, filesNotInGraph }`.
- graph.json è node-link NetworkX: nodi con `source_file`, `community`,
  `community_name`; archi in `links`. Grado = conteggio archi per nodo; god
  node = nodo toccato che sta nel top-p (es. grado ≥ p95 del grafo, min 10).
  Parse una volta per review (niente cache: le review sono rare, ~6MB JSON è
  <1s). `changedFiles` = path relativi estratti dalle righe `diff --git` del
  diff già disponibile in `run-review.ts` (`getPrDiff`).
- Render: `renderBlastRadiusPromptBlock(...)` (inglese, per il prompt) e
  `renderBlastRadiusSection(lang, ...)` (lingua dei contenuti d'istanza via
  `@stubwise/i18n`, per il commento pubblicato — segui la convenzione reale
  della review per i testi pubblicati; se la review pubblica hardcoded, adegua).

**Cablaggio in `apps/worker/src/review/run-review.ts` + `prompts.ts`:**
- `resolveRepoGraphJson` (helper 2a) sul repository della PR; se null → tutto
  invariato (fail-open, nessun blocco né sezione).
- Prompt: blocco CODE GRAPH (renderGraphHint, singolo repo) + blocco blast
  radius; `allowedTools: GRAPHIFY_AGENT_ALLOWED_TOOLS` sul run (plan-mode,
  stesso razionale del deep dive).
- Commento pubblicato: sezione "Impatto sul codice" appesa DOPO l'output
  dell'agente, generata deterministicamente dal calcolo (mai dall'agente);
  omessa se il calcolo è null o vuoto (nessun file del diff nel grafo).
- Deps: `graphsDir?: string` nelle deps della review (pattern 2a), cablata da
  index.ts.

**Test**: unit di blast-radius su un graph.json fixture piccolo e scritto a
mano (3 comunità, god node evidente, file fuori grafo); parser dei changed
files dal diff (rename, delete, path con spazi); prompts con/senza blocco;
run-review esteso (graphsDir presente/assente, sezione nel commento, allowlist
sul run). Fail-open: graph.json corrotto → review identica a prima.

**Deploy**: solo `worker`. Nessuna migrazione, env, UI.
