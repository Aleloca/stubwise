# Pausa/ripresa sul limite di utilizzo — piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Qualunque lavoro dell'agente fermato dal limite di utilizzo Claude (nodi del DAG Docs, fix, review) si mette in pausa e riprende da solo quando l'utilizzo si libera.

**Architecture:** Rilevazione `isLimitError` nei tre handler del DAG (oggi assente: il limite muore come "output invalido"); pausa a livello di GENERAZIONE (nuovo stato `paused`, il claim dei nodi la esclude); `held_reason` su `ai_jobs`/`doc_generation_jobs` per distinguere gli held-per-limite; review riaccodata via `notBefore` (coda già temporizzata). Un resume poller decide la ripresa: snapshot `/usage` (già raccolti ogni 5', gratis) per i provider `account`, cooldown a tempo per gli `api_key` e come fallback su snapshot stantii.

**Tech Stack:** Drizzle/Postgres (testcontainers), worker Node (poller pattern), Fastify+Zod, React+TanStack Query.

**Design di riferimento:** `docs/plans/2026-07-02-limit-pause-resume-design.md`

**Scostamenti dal design (emersi dall'analisi del codice, da riportare nel design doc al Task 10):**
- Il fix in `held` per limite NOTIFICA GIÀ via il kind `job.held`: la notifica nuova (`docs.limit_paused`) serve solo per la pausa delle generazioni Docs. Richiede un piccolo refactor di format.ts: oggi TUTTI gli eventi hanno `ticketNumber`/`ticketTitle` obbligatori.
- Limite durante l'ORIENTAMENTO (DAG non ancora seminato): niente pausa della generazione (non ben definita lì) — il trigger job va `held` (reason `limit`) e la generazione fallisce con messaggio esplicito; alla ripresa il job riaccodato crea una generazione fresca. Perdita: il solo run di orientamento.
- La sintesi oggi NON fallisce mai (fallback page su output invalido): sul limite NON deve produrre il fallback — nuovo esito `limit` anche lì.

**Convenzioni trasversali (OGNI task):** TDD; commenti italiani why-focused nello stile del file; commit per task; test lenti (testcontainers) lanciati mirati con `npx vitest run <pattern>` nella dir del package; a fine piano `pnpm typecheck && pnpm lint && pnpm test` dalla radice (la CI fallisce su lint). TRAPPOLA MIGRAZIONI (vissuta): il migratore drizzle esegue il batch in UNA transazione — la migrazione qui aggiunge un valore enum ma NESSUNA migrazione deve USARLO (nessun seed); le query runtime possono usarlo liberamente. Vedi memoria `stubwise-drizzle-migration-batch-tx`.

---

## Task 1: enum e colonne (shared + db + migrazione 0038)

**Files:**
- Modify: `packages/shared/src/schemas/docs.ts:23-29`
- Modify: `packages/db/src/schema.ts` (docGenerations ~990-1019, aiJobs ~571-616, docGenerationJobs)
- Create: `packages/db/drizzle/0038_limit_pause.sql` (generata)
- Test: `packages/db/src/schema.test.ts`

**Step 1: shared** — in `docs.ts`:

```ts
export const docGenerationStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
]);
```

E accanto (nuovo, riusato da db e worker):

```ts
/** Motivo per cui un job è in `held`: solo `limit` è auto-ripristinabile. */
export const heldReasonSchema = z.enum(["limit", "budget", "other"]);
export type HeldReason = z.infer<typeof heldReasonSchema>;
```

(esporta da packages/shared/src/index.ts se serve — segui il pattern degli altri schemi docs).

**Step 2: schema.ts** —

1. Nuovo pgEnum accanto agli altri: `export const heldReason = pgEnum("held_reason", enumValues(heldReasonSchema));`
2. In `docGenerations`, dopo `error`:

```ts
    // Pausa per limite di utilizzo del provider: la generazione resta viva (i
    // nodi tornano pending, il claim li salta) e il resume poller la rimette
    // running quando l'utilizzo si libera. Il worktree è in-memoria: un
    // riavvio del worker durante la pausa la fallisce (fail-on-restart,
    // rischio accettato dal design).
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
```

3. In `aiJobs` e in `docGenerationJobs`, dopo la colonna status (o vicino a error):

```ts
    // Motivo dell'ultimo `held`: SOLO `limit` viene riaccodato automaticamente
    // dal resume poller; budget/gate restano decisioni umane. Null per gli
    // held storici (mai riaccodati: conservativo).
    heldReason: heldReason("held_reason"),
```

**Step 3: genera la migrazione** — `cd packages/db && npx drizzle-kit generate --name limit_pause` → ispeziona `0038_limit_pause.sql`: `ALTER TYPE doc_generation_status ADD VALUE 'paused'`, `CREATE TYPE held_reason`, 2 ADD COLUMN su doc_generations, 1 su ai_jobs, 1 su doc_generation_jobs. NIENTE di distruttivo, NESSUN INSERT/UPDATE che usa 'paused' (trappola batch). `npx drizzle-kit check` → ok.

**Step 4: test** — in schema.test.ts aggiungi (accanto ai test PR Review) un test che inserisce una `doc_generations` con `status: "paused"` + pausedAt e la rilegge; e un `ai_jobs` con `heldReason: "limit"`. Run: `pnpm --filter @stubwise/db test` → PASS.

**Step 5: typecheck dalla radice** — `pnpm typecheck`: scova switch/Record esaustivi rotti da `paused` (probabile: nessuno lato web — `JOB_STATUS_KEY` mappa il JOB status, invariato; verifica `Record<DocGenerationStatus` con grep). Sistemali minimamente se emergono.

**Step 6: commit** — `feat(db): stato paused per doc_generations, held_reason su ai_jobs/doc_generation_jobs`

---

## Task 2: helper DAG — requeueNode, pauseGeneration, resumeGeneration, claim che esclude le pause

**Files:**
- Modify: `apps/worker/src/docs/nodes.ts` (claimNextNode :51-69; nuovo requeueNode accanto a requeueStaleNodes :305-320)
- Create o Modify: helper generazioni (guarda se esiste un modulo per gli update di doc_generations — es. finalize.ts/queue.ts — e mettili nel posto più coerente, altrimenti in nodes.ts)
- Test: il file di test esistente dei nodi (trovalo: `ls apps/worker/src/docs/*.test.ts apps/worker/src/docs/recursive/*.test.ts`)

**Step 1: test (TDD)**

```ts
it("requeueNode rimette exploring→pending (e synthesizing→ready_to_synthesize) SENZA joinare il padre", async () => {
  // nodo exploring con padre awaiting_children: dopo requeueNode il nodo è
  // pending e il contatore/stato del padre è INVARIATO (a differenza di failNode).
});

it("pauseGeneration: running→paused con pausedAt/pauseReason; già paused → no-op (guarded)", async () => { ... });

it("resumeGeneration: paused→running e azzera pausedAt/pauseReason; non-paused → no-op", async () => { ... });

it("claimNextNode NON reclama nodi di generazioni paused", async () => {
  // gen A paused con nodo pending, gen B running con nodo pending creato DOPO:
  // il claim ritorna il nodo di B; con solo A → null.
});
```

**Step 2: FAIL** → **Step 3: implementa**

`requeueNode` (stesso CASE di requeueStaleNodes, per singolo id, guarded su ACTIVE_STATUSES, NIENTE joinParent — commento sul perché):

```ts
/**
 * Rimette in coda UN nodo attivo (limite provider rilevato): exploring→pending,
 * synthesizing→ready_to_synthesize. A differenza di failNode NON tocca il join
 * del padre: il nodo non è concluso, verrà rieseguito alla ripresa.
 */
export async function requeueNode(db: DbOrTx, nodeId: string): Promise<boolean> {
  const updated = await db
    .update(docNodes)
    .set({
      status: sql`CASE WHEN ${docNodes.status} = 'exploring' THEN 'pending'::doc_node_status ELSE 'ready_to_synthesize'::doc_node_status END`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(docNodes.id, nodeId), inArray(docNodes.status, [...ACTIVE_STATUSES])))
    .returning({ id: docNodes.id });
  return updated.length > 0;
}
```

`pauseGeneration` / `resumeGeneration` (status-guarded, il secondo segnale concorrente è no-op):

```ts
export async function pauseGeneration(db: DbOrTx, generationId: string, reason: string): Promise<boolean> {
  const updated = await db
    .update(docGenerations)
    .set({ status: "paused", pausedAt: sql`now()`, pauseReason: reason })
    .where(and(eq(docGenerations.id, generationId), eq(docGenerations.status, "running")))
    .returning({ id: docGenerations.id });
  return updated.length > 0;
}

export async function resumeGeneration(db: DbOrTx, generationId: string): Promise<boolean> {
  const updated = await db
    .update(docGenerations)
    .set({ status: "running", pausedAt: null, pauseReason: null })
    .where(and(eq(docGenerations.id, generationId), eq(docGenerations.status, "paused")))
    .returning({ id: docGenerations.id });
  return updated.length > 0;
}
```

`claimNextNode`: la subquery diventa

```sql
(SELECT id FROM doc_nodes
  WHERE status IN ('pending', 'ready_to_synthesize')
    AND generation_id NOT IN (SELECT id FROM doc_generations WHERE status = 'paused')
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
```

(commento: un solo segnale di limite ferma l'intero DAG senza bruciare run sugli altri nodi).

**Step 4: PASS** → **Step 5: commit** — `feat(worker): pausa/ripresa generazioni e requeue nodo nel DAG docs`

---

## Task 3: rilevazione del limite negli handler explore/synthesize + ramo nel dispatcher

**Files:**
- Modify: `apps/worker/src/docs/recursive/explore-handler.ts` (:69-74 outcome, :129-159 runExploreAgent, :247-256 chiamante)
- Modify: `apps/worker/src/docs/recursive/synthesize-handler.ts` (:53-58 outcome, :100-124 runSynthesizeAgent, ~:150-184 chiamante)
- Modify: `apps/worker/src/docs/recursive/node-dispatch.ts` (runClaimedNode ~:205-236)
- Test: i test esistenti degli handler (fake runner) — trovali e segui il pattern

**Step 1: test (TDD)** — con un fake runner che ritorna `{ output: "API Error: usage limit reached", exitCode: 1, usage: { totalCostUsd: 0.01, models: [] } }`:

```ts
it("explore su run al limite: outcome 'limit', UN solo run (retry non consumato), nodo NON failed", async () => { ... });
it("synthesize su run al limite: outcome 'limit', NESSUNA pagina fallback scritta, nodo non done", async () => { ... });
it("dispatcher su outcome limit: nodo tornato pending e generazione paused (con reason), costo registrato", async () => {
  // via runClaimedNode o il livello testabile equivalente; verifica anche che
  // maybeFinalize NON venga chiamata sul ramo limit.
});
it("secondo limite concorrente: pauseGeneration no-op, nessun errore", async () => { ... });
```

**Step 2: FAIL** → **Step 3: implementa**

a) `runExploreAgent`: dentro il loop, SUBITO dopo `costUsd += ...; await touchNode(...)`:

```ts
    // Limite di rate/usage del provider: NON è un output invalido — non
    // consuma il retry e non fallisce il nodo. Il chiamante mette in pausa
    // l'intera generazione (i run al limite tornano output degradato: ogni
    // retry qui sarebbe un run bruciato).
    if (isLimitError(result)) return { limit: true, costUsd };
```

Return type: `Promise<{ explore: ExploreOutput; costUsd: number } | { limit: true; costUsd: number } | null>`. Import `isLimitError` da `../../providers/limit.js`.

b) chiamante `runExplore`: PRIMA del ramo `!run`:

```ts
  if (run && "limit" in run) {
    return { outcome: "limit", costUsd: run.costUsd };
  }
```

e `ExploreOutcome` diventa `"branch" | "leaf" | "failed" | "limit"`.

c) `runSynthesizeAgent`: stesso check nel loop → `return { limit: true, costUsd }` (adatta il return type); il chiamante, sul limit, ritorna `{ outcome: "limit", costUsd }` SENZA scrivere il fallback né completare il nodo. `SynthesizeOutcome` += `"limit"`.

d) `node-dispatch.ts`, `runClaimedNode` — cattura l'outcome (oggi ignora tutto tranne costUsd):

```ts
    let outcome: "ok" | "limit" = "ok";
    if (phase === "explore") {
      const r = await runExplore(exploreDeps, node);
      costUsd = r.costUsd;
      if (r.outcome === "limit") outcome = "limit";
    } else {
      const r = await runSynthesize(synthDeps, node);
      costUsd = r.costUsd;
      if (r.outcome === "limit") outcome = "limit";
    }
```

e dopo `recordNodeCost` (i costi del run parziale si registrano comunque), PRIMA di `maybeFinalize`:

```ts
    if (outcome === "limit") {
      // Pausa a livello di GENERAZIONE: il nodo torna claimabile (pending) ma
      // il claim salta le generazioni paused — un solo segnale ferma il DAG.
      // Ordine: prima il requeue del nodo, poi la pausa (se il processo muore
      // in mezzo, un nodo pending su generazione running è semplicemente
      // rieseguito). La ripresa è del resume poller (o del pulsante admin).
      await requeueNode(db, node.id);
      const paused = await pauseGeneration(
        db,
        node.generationId,
        "limite di rate/usage del provider AI",
      );
      if (paused) {
        console.error(
          `[stubwise-worker] docs: generazione ${node.generationId} in pausa per limite provider`,
        );
        // Notifica best-effort (kind docs.limit_paused, Task 7): qui il punto
        // di aggancio, la dispatch arriva col Task 7.
      }
      return;
    }
```

(la notifica reale si aggancia nel Task 7 — lascia il commento segnaposto o integra se il Task 7 è già fatto).

**Step 4: PASS** (test nuovi + esistenti degli handler) → **Step 5: commit** — `feat(worker): limite provider nel DAG docs → nodo requeued e generazione in pausa`

---

## Task 4: orientamento al limite + held_reason nei punti di hold

**Files:**
- Modify: `apps/worker/src/docs/recursive/orient-handler.ts` (:284-310 runOrientAgent, :456-466 chiamante)
- Modify: `apps/worker/src/docs/queue.ts` (`holdDocJob` :140-153 — aggiungi heldReason)
- Modify: `apps/worker/src/queue.ts` (`holdJob` :240-252 — aggiungi heldReason)
- Modify: `apps/worker/src/handler.ts` (holdJobWithReason/holdAllProvidersLimited :163-181, ramo strict :199-220)
- Modify: `apps/worker/src/pipeline/fix.ts:563`, `apps/worker/src/pipeline/triage.ts:335` (classifica il motivo)
- Test: test esistenti di handler/queue/orient

**Step 1: test (TDD)**

```ts
it("orientamento su run al limite: trigger job held con held_reason 'limit', generazione failed con messaggio esplicito, UN solo run", async () => { ... });
it("holdJob scrive held_reason; i due hold-per-limite del fix hanno reason 'limit', il budget hold 'budget'", async () => { ... });
```

**Step 2: FAIL** → **Step 3: implementa**

a) `runOrientAgent`: stesso check `isLimitError(result)` nel loop → `return { limit: true, costUsd }` (adatta il tipo). Chiamante:

```ts
    if (orient && "limit" in orient) {
      await worktree.close();
      // Il DAG non esiste ancora: la pausa della generazione non è definita
      // qui. Il trigger va held (reason limit, il resume poller lo riaccoda)
      // e la generazione fallisce con messaggio esplicito: alla ripresa il
      // job riaccodato ne crea una FRESCA (si perde solo questo run).
      await failOrientation(
        db,
        ctx.generationId,
        job.id,
        "provider AI al limite di rate/usage: la generazione verrà ritentata automaticamente",
      );
      await holdDocJob(db, job.id, {
        reason: "provider AI al limite di rate/usage",
        heldReason: "limit",
      });
      return "held";
    }
```

ATTENZIONE all'ordine/semantica reale di `failOrientation` (fallisce anche il job? leggila): se fallisce anche il trigger job, inverti — prima `failOrientation` SOLO sulla generazione o rifattorizza per non toccare il job, poi `holdDocJob`. Obiettivo finale VERIFICABILE: generazione `failed` (con quel messaggio), job `held` con `held_reason='limit'`. Adatta il tipo di ritorno del chiamante se serve.

b) `holdDocJob` e `holdJob`: aggiungi `heldReason` all'input e al `set` (`heldReason: input.heldReason`). Tipo: `HeldReason` da shared.

c) Classifica i chiamanti: `holdAllProvidersLimited` e il ramo strict-limite → `heldReason: "limit"`; il ramo provider-non-disponibile → `"other"`; `fix.ts:563` (budget) → `"budget"`; `triage.ts:335` → leggi il contesto e classifica (budget → `"budget"`, altrimenti `"other"`). `holdJobWithReason` propaga il parametro.

**Step 4: PASS** → **Step 5: commit** — `feat(worker): held_reason sui job e orientamento docs al limite → held riaccodabile`

---

## Task 5: review al limite → riaccodo con notBefore

**Files:**
- Modify: `apps/worker/src/review/run-review.ts:556-565`
- Test: `apps/worker/src/review/run-review.test.ts`

**Step 1: test (TDD)** — sostituisci/estendi il test esistente "limite del provider":

```ts
it("limite del provider: riga failed con errore esplicito E job riaccodato in pr_review_jobs con notBefore ~+30'", async () => {
  // run limit-shaped → pr_reviews failed (error contiene 'riaccodata'),
  // pr_review_jobs contiene una riga per (repo, prNumber) con TUTTI i campi
  // del job originale e notBefore >= now+29' e <= now+31'.
  // NESSUN commento/ticket/notifica.
});
```

**Step 2: FAIL** → **Step 3: implementa** — nel ramo `isLimitError`:

```ts
    // Limite di rate/usage: la review non ha failover di catena, ma la sua
    // coda è già temporizzata — si riaccoda con un cooldown. Se il limite
    // persiste al prossimo claim, si ri-accoda di nuovo: un run sonda ogni
    // cooldown, autolimitante. La chiusura della PR pulisce la coda.
    if (isLimitError(result)) {
      await failRunningReview(
        deps.db,
        reviewId,
        "provider AI al limite di rate/usage: review riaccodata",
      );
      await requeueReviewJob(deps.db, job);
      return;
    }
```

con, nel modulo:

```ts
/** Cooldown del riaccodo su limite provider (fallback a tempo, come da design). */
const LIMIT_REQUEUE_COOLDOWN_MS = 30 * 60 * 1000;

/** Ri-upserta il job della review con notBefore spostato oltre il cooldown (best-effort). */
async function requeueReviewJob(db: Db, job: PrReviewJobRow): Promise<void> {
  try {
    const notBefore = new Date(Date.now() + LIMIT_REQUEUE_COOLDOWN_MS);
    await db
      .insert(prReviewJobs)
      .values({ ...job, notBefore })
      .onConflictDoUpdate({
        target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
        set: { notBefore },
      });
  } catch (err) {
    console.error(`[stubwise-worker] pr-review: riaccodo su limite fallito (${errText(err)})`);
  }
}
```

(import `prReviewJobs`; su conflitto NON sovrascrivere head/metadati: se un webhook ha già ri-upsertato un push più nuovo, i suoi metadati vincono — aggiorna solo notBefore. Commenta il perché.)

**Step 4: PASS** — `npx vitest run run-review` → **Step 5: commit** — `feat(worker): review al limite riaccodata con cooldown invece che failed terminale`

---

## Task 6: resume poller + config + wiring

**Files:**
- Create: `apps/worker/src/providers/limit-resume-poller.ts`
- Create: `apps/worker/src/providers/limit-resume-poller.test.ts`
- Modify: `apps/worker/src/config.ts`, `apps/worker/src/index.ts`

**Step 1: test (TDD)** (testcontainers; nessun agente — solo DB):

```ts
it("generazione paused + provider account con headroom (snapshot fresco <95% sessione, <100% weekly) → running", async () => { ... });
it("senza headroom (sessione 100%) → resta paused", async () => { ... });
it("provider api_key: riprende solo dopo il cooldown (pausedAt vecchio)", async () => { ... });
it("snapshot stantio (capturedAt vecchio) su account → degrada al fallback a tempo", async () => { ... });
it("ai_jobs held con held_reason 'limit' e headroom su UNA credenziale della catena → queued + commento AI", async () => { ... });
it("held_reason 'budget' o null → MAI riaccodato", async () => { ... });
it("doc_generation_jobs held reason limit → queued", async () => { ... });
it("un item che lancia non blocca gli altri, il tick non propaga", async () => { ... });
```

**Step 2: FAIL** → **Step 3: implementa** — struttura sul pattern dei poller esistenti (`startXxxPoller`: setInterval + guard running + unref + AbortSignal + `<=0` disabled; `pollLimitResumeOnce(deps)` esportata per i test, try/catch per-item e per-tick).

Logica del tick:

```ts
// 1. Raccogli il lavoro in pausa per limite.
const pausedGens = await db.select(...).from(docGenerations).where(eq(status, "paused"));
const heldFixJobs = await db.select(...).from(aiJobs).where(and(eq(status, "held"), eq(heldReason, "limit")));
const heldDocJobs = await db.select(...).from(docGenerationJobs).where(and(eq(status, "held"), eq(heldReason, "limit")));
if (niente) return 0;

// 2. Snapshot più recente per provider account (selectDistinctOn come il
//    server, apps/server/src/routes/usage-snapshots.ts:71-87) + catena.
const chain = await loadProviderChain(db, encryptionKey);
const snapshots = await latestSnapshotsByProvider(db); // Map<providerId, {capturedAt, sessionRemaining, weeklyRemaining, parseOk}>

// 3. headroom(provider, pausedSince): 
//    - account con snapshot fresco (capturedAt entro maxSnapshotAgeMs, default
//      3× l'intervallo del poll usage) e parseOk: sessione.percentUsed <
//      headroomPercent E weekly.percentUsed < 100.
//    - account con snapshot stantio/assente O api_key: fallback a tempo —
//      now - pausedSince > cooldownMs.
//    pausedSince: pausedAt per le generazioni, finishedAt per i job held.

// 4. Applica:
//    - generazione: provider = pinnedProviderId (loadProviderById; se non
//      risolvibile → skip con log) altrimenti chain[0]; headroom → resumeGeneration + log.
//    - fix job: headroom su ALMENO UNA credenziale della catena (o sul pin di
//      progetto se presente — risolvi come handler.ts) → status queued
//      (update guarded su held) + commento AI t(lang, "comment.limitResumed")
//      + log nel job. Il commento è best-effort.
//    - doc job: come il fix ma senza commento (nessun ticket) → queued.
```

Chiave i18n nuova in `packages/i18n/src/catalog.ts` (en+it):

```ts
"comment.limitResumed": "The provider usage limit has reset: the job was requeued automatically.",
// it: "Il limite di utilizzo del provider è rientrato: il job è stato riaccodato automaticamente."
```

Config (stile esistente, docblock italiani):
- `LIMIT_RESUME_POLL_MINUTES` → `limitResumePollMinutes` (int ≥ 0, 0 = disabilitato, default 5)
- `LIMIT_RESUME_HEADROOM_PERCENT` → `limitResumeHeadroomPercent` (int 1-100, default 95)
- `LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES` → `limitResumeCooldownMs` (min ≥ 1, default 60, ×60_000)
Aggiorna `.env.example` e i test di config.

Wiring in index.ts sotto gli altri poller (stesso stile di commento; deps: db, encryptionKey, i 3 valori config, signal) + riga nel log di avvio.

**Step 4: PASS** → `npx vitest run limit-resume` e poi l'INTERA suite worker `pnpm --filter @stubwise/worker test`.

**Step 5: commit** — `feat(worker): resume poller — ripresa automatica di generazioni paused e job held-limit`

---

## Task 7: notifica `docs.limit_paused` (evento senza ticket)

**Files:**
- Modify: `packages/notifications/src/format.ts` (union :120-128, EMOJI :156, KEY_FOR_KIND :225, linkParam :198, textParams :237, formatGeneric :323, sampleEvents :384)
- Modify: `packages/notifications/src/dispatch.ts` (row + TOGGLE_FOR_KIND :67 + select)
- Modify: `packages/db/src/schema.ts` (colonna `notify_docs_limit_paused` default true) + **APPEND alla migrazione 0038 SE non ancora deployata, altrimenti 0039** (verifica: se il Task 1 è già committato ma non rilasciato, rigenera la 0038 con drizzle-kit come fatto nel branch PR Review)
- Modify: `packages/i18n/src/catalog.ts` (chiavi notify.docsLimitPaused en+it)
- Modify: `apps/server/src/routes/settings.ts` (route notifiche: campo con default true)
- Test: format/dispatch/settings esistenti (pattern del kind review.completed)

**Step 1: il refactor minimo "senza ticket".** Oggi ogni evento ha `ticketNumber`/`ticketTitle` obbligatori e `renderText`/`plainMessage`/`formatGeneric` li usano dalla base. Introduci il nuovo evento:

```ts
/** Generazione Docs in pausa per limite di utilizzo del provider (nessun ticket). */
export interface DocsLimitPausedEvent {
  kind: "docs.limit_paused";
  projectName: string;
  repositoryName: string;
  /** URL della pagina Docs del repository (al posto del ticketUrl). */
  docsUrl: string;
  reason: string;
}
```

e adegua i punti comuni con narrowing sul kind (l'approccio (a) dei fatti raccolti): `renderText`/`plainMessage` usano `ref` solo se l'evento ha ticketNumber (`"ticketNumber" in event`); `formatGeneric` per questo kind emette `{ event, projectName, repositoryName, message, docsUrl, reason }`; `linkParam` linka `docsUrl` con label "Docs". Mantieni INVARIATO l'output degli 8 kind esistenti (i test lo garantiscono).

**Step 2: chiavi i18n**

```ts
// en
"notify.docsLimitPaused": "Docs generation paused for {repositoryName} ({projectName}): provider usage limit reached. It will resume automatically. {link}",
// it
"notify.docsLimitPaused": "Generazione Docs in pausa per {repositoryName} ({projectName}): limite di utilizzo del provider raggiunto. Riprenderà da sola. {link}",
```

(allinea i placeholder a come renderText inietta `{link}`; verifica i nomi reali).

**Step 3: dispatch dal worker** — nel ramo limit di `runClaimedNode` (Task 3), dopo `pauseGeneration` riuscita: dispatch best-effort del nuovo evento (recupera projectName/repositoryName con una select; docsUrl = `${publicUrl}/docs/${repositoryId}` — verifica il path reale della SPA). Segui il pattern `notify` del worker (best-effort, mai lancia). NOTA: il fix held-limit NON prende la notifica nuova (già coperto da `job.held`).

**Step 4: TDD come al solito** (format slack/generic, gate del toggle, settings server con default true per client legacy). Poi web toggle nel Task 8.

**Step 5: commit** — `feat(notifications): evento docs.limit_paused (senza ticket) con toggle dedicato`

---

## Task 8: server — POST /docs/resume

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (dopo il blocco generate :246-290)
- Test: `apps/server/src/routes/docs.test.ts`

**Step 1: test (TDD)** (pattern del describe generate: member 403, no session 401, 404 repo):

```ts
it("admin su generazione paused → 200 e la generazione torna running", async () => { ... });
it("nessuna generazione paused → 409 generation_not_paused", async () => { ... });
```

**Step 2: FAIL** → **Step 3: implementa**

```ts
  // Ripresa manuale di una generazione in pausa per limite (override del
  // resume poller: l'admin sa che il limite è rientrato e non vuole aspettare
  // il prossimo tick). Solo la generazione più recente in stato paused.
  app.post(
    "/repositories/:repositoryId/docs/resume",
    { preHandler: requireAdmin, schema: { params: repositoryIdParamsSchema, response: { 200: generationSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      // 404 repo come generate; poi:
      const [gen] = await app.db
        .select()
        .from(docGenerations)
        .where(and(eq(docGenerations.repositoryId, repositoryId), eq(docGenerations.status, "paused")))
        .orderBy(desc(docGenerations.createdAt))
        .limit(1);
      if (!gen) return apiError(reply, 409, "generation_not_paused", "No paused generation");
      await app.db
        .update(docGenerations)
        .set({ status: "running", pausedAt: null, pauseReason: null })
        .where(and(eq(docGenerations.id, gen.id), eq(docGenerations.status, "paused")));
      // rileggi e ritorna con toGeneration/serializzazione del file
    },
  );
```

(adatta a helper/serializzatori reali del file: `generationSchema`, funzioni di mapping).

**Step 4: PASS** → **Step 5: commit** — `feat(server): ripresa manuale delle generazioni docs in pausa`

---

## Task 9: web — badge paused, "Riprendi ora", toggle notifica, i18n

**Files:**
- Modify: `apps/web/src/components/docs-generation-panel.tsx` (blocchi condizionali :100-129)
- Modify: `apps/web/src/lib/docs-api.ts` (:164 accanto a generateDocs), tipi `DocGeneration` (:123 — lo status ora include "paused": verifica se il tipo è locale o da shared)
- Modify: `apps/web/src/components/notifications-section.tsx` (EVENT_TOGGLES :31, SAMPLE_LABELS :43) + `apps/web/src/lib/api.ts` (NotificationSettings + PUT body)
- Modify: `apps/web/src/i18n/locales/en.json` + `it.json` (namespace docs.generation: statusPaused/jobPaused/resume/pausedNotice; notifications: toggle+sample)
- Test: test esistenti del panel (trovali) + settings.test.tsx per il toggle

**Step 1: test (TDD)**

```ts
it("generazione paused: badge 'in pausa' con motivo e pulsante Riprendi ora (admin)", async () => { ... });
it("click su Riprendi ora → POST /docs/resume e invalidazione dello status", async () => { ... });
it("toggle notifica docs.limit_paused presente e incluso nel PUT", async () => { ... });
```

**Step 2: FAIL** → **Step 3: implementa**

Nel panel, accanto ai blocchi failed/held:

```tsx
{status.generation?.status === "paused" && (
  <>
    <p className="mt-2 font-mono text-[12px] text-warn" role="status">
      {t("docs:generation.paused")}
    </p>
    {isAdmin && (
      <button type="button" disabled={resume.isPending} onClick={() => resume.mutate()} className={/* classi del bottone generate */}>
        {resume.isPending ? t("docs:generation.resuming") : t("docs:generation.resume")}
      </button>
    )}
  </>
)}
```

i18n (it): `"paused": "Generazione in pausa: limite di utilizzo del provider. Riprende da sola al reset."`, `"resume": "Riprendi ora"`, `"resuming": "Ripresa…"` (en speculare). `resumeDocs(repositoryId)` in docs-api + mutation con invalidazione `docsKeys.status`. Verifica come il panel sa se l'utente è admin (guarda il bottone generate esistente) e riusa il meccanismo. Toggle notifiche: `notifyDocsLimitPaused` in EVENT_TOGGLES + `docs.limit_paused` in SAMPLE_LABELS + campo in api.ts (inviato SEMPRE esplicitamente) + label i18n en/it.

**Step 4: PASS** — `cd apps/web && npx vitest run` (intera suite web, parità i18n inclusa) → **Step 5: commit** — `feat(web): badge pausa generazione docs, riprendi ora, toggle notifica`

---

## Task 10: guida utente, design doc e verifica finale

**Files:**
- Modify: `apps/docs/src/content/docs/` (pagina della generazione Docs e/o configurazione: documenta pausa/ripresa, le 3 env nuove in reference/configuration.md, il toggle notifica in notifications/index.md)
- Modify: `docs/plans/2026-07-02-limit-pause-resume-design.md` (stato → implementato + i 3 scostamenti dichiarati in testa a questo piano)
- Verifica completa

**Step 1: guida** — sezione breve "Pausa sul limite di utilizzo": cosa succede (i lavori si fermano senza perdere nodi, ripresa automatica), il badge e "Riprendi ora", il vincolo del riavvio worker durante la pausa, le env di tuning.

**Step 2: design doc** — stato "implementato" + nota scostamenti (notifica solo Docs perché il fix usa job.held; orientamento → held+failed; sintesi senza fallback sul limite).

**Step 3: VERIFICA COMPLETA** — `pnpm typecheck && pnpm lint && pnpm build && pnpm test` dalla radice: tutto verde, numeri nel report.

**Step 4: commit** — `docs: guida pausa/ripresa sul limite e chiusura piano`

---

## Fuori scope (rimandato, dal design)

- Generazioni riavvio-safe (worktree riapribile a commit registrato): cambio profondo al DAG.
- Notifica alla ripresa automatica (rumore; log e timeline bastano).
- Parsing della `resetsLabel` TUI in un reset time machine-readable.
- Deploy: backend-only tranne il panel web → ribuildare `caddy`+`server`+`worker`; migrazione additiva; feature attiva di default (poll 5') ma innocua senza pause in corso.
