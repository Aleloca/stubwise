# Orient dei Docs seedato dal knowledge graph (fase 2c graphify)

> Nota: repo non collegato all'istanza Stubwise; tracking in `feature-backlog.md`.

## Obiettivo e perimetro (conservativo)

La generazione Docs spende run agente per ricostruire la mappa del repo che il
grafo ha già, gratis e deterministica. La 2c è **puramente additiva**: arricchisce
i PROMPT dei run della pipeline Docs e la loro allowlist — **nessun cambiamento
alla logica della pipeline** (orient/parse/DAG/finalize/auto-update intoccati).
Un repo senza grafo produce prompt byte-identici a oggi (fail-open, pattern
`briefContext`).

**Escluso esplicitamente** (follow-up futuro, rischioso): usare il diff del
grafo per il RILEVAMENTO delle "aree nuove" dell'auto-update — la detection
resta quella attuale.

## Design

**1. Mappa del grafo per l'orientamento — `apps/worker/src/graph/docs-summary.ts`**
- `summarizeGraphForDocs(graphJsonPath, caps)` → `string | null` (fail-open su
  file assente/JSON corrotto, MAI throw). Blocco deterministico "CODE GRAPH
  MAP" in inglese (la lingua dei prompt docs): le comunità del grafo (nome
  etichettato, conteggio nodi, 3-5 file rappresentativi = i `source_file` più
  frequenti della comunità) ordinate per dimensione con cap (default 15), e i
  god nodes (label, grado, file) con cap (default 10). Chiusa da una riga che
  dice che la mappa è derivata dal grafo e va verificata sul repo reale.
- Il parsing del graph.json node-link esiste già in
  `apps/worker/src/graph/blast-radius.ts`: estrai gli helper condivisi
  (load+degree+community) in un modulo comune invece di duplicarli — refactor
  minimo, i test di blast-radius devono restare verdi e invariati nel
  comportamento.

**2. Prompt additivi (pattern `briefContext`)**
- `buildOrientPrompt(survey, briefContext?, graphContext?)` in
  `packages/docs-engine/src/recursive/orient.ts`: il blocco mappa entra dopo il
  survey, con una riga che invita a usarlo come ipotesi di decomposizione da
  VERIFICARE (mai da copiare ciecamente: le comunità del grafo non coincidono
  necessariamente con le unità documentali). Parametro assente → prompt
  identico a oggi.
- I run di ESPLORAZIONE (explore/node) NON ricevono la mappa intera (rumore
  per un nodo singolo): ricevono il blocco CODE GRAPH della 2a
  (`renderGraphHint`) così l'agente può fare query mirate sulla SUA area.
  docs-engine resta puro: il blocco arriva dal worker come parte del contesto
  già previsto dai prompt (verifica il punto di innesto reale in
  `node-dispatch.ts`/`explore.ts` e usa il parametro opzionale più naturale).

**3. Allowlist e cablaggio worker**
- I run docs girano in plan-mode/acceptEdits senza Bash graphify: aggiungi
  `GRAPHIFY_AGENT_ALLOWED_TOOLS` ai run di orientamento, brief ed
  esplorazione SOLO quando il repo ha il grafo (pattern 2a; in plan-mode è
  la sola apertura Bash).
- `graphsDir?` nelle deps del sottosistema docs del worker (pattern 2a),
  cablata da `index.ts`; `resolveRepoGraphJson` per il gating.
- Il mini-orient dell'auto-update (Fase 3 aree nuove) passa da
  `buildOrientPrompt`: se il cablaggio del chiamante è lo stesso, eredita la
  mappa gratis; NON modificare la sua logica di detection.

**4. Fail-open e invarianti**
- Qualunque problema col grafo → prompt identici a oggi. La pipeline Docs non
  acquisisce nuovi stati, nuovi errori né nuove scritture: gli invarianti
  (fail-on-restart, finalize, pause) non sono toccati.

**Test**: unit di `summarizeGraphForDocs` su fixture (comunità, cap, corrotto →
null); orient/explore prompt con/senza blocco (byte-identici senza); wiring dei
run (allowlist presente col grafo, assente senza) sugli harness esistenti;
suite docs-engine + worker complete verdi.

**Deploy**: solo `worker` (+ dist di docs-engine ricompilata nel build immagine).
Il beneficio si vede alla prossima generazione/rigenerazione Docs di un repo
col grafo abilitato.
