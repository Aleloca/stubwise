# Crea voce di backlog da design pronto — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development) per implementare task-per-task.

**Goal:** Un percorso "da design pronto": crea la voce di backlog sincrona col design **verbatim**, e un job leggero `estimate` stima **solo** i metadati (effort/rischio/urgenza) + calcola l'embedding, senza riscrivere il documento. Nuovo tool MCP + guidance fix.

**Architecture:** Nuovo job kind `estimate` (migrazione 0059, enum). Endpoint `POST /api/backlog/from-design` crea l'item sincrono + accoda `estimate {itemId}`. Worker `runEstimate` fa embedding + stima metadati-only e aggiorna l'item. Tool MCP `create_backlog_from_design`. Skill + descrizioni tool aggiornate.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, worker claude-CLI agent, @modelcontextprotocol/sdk, Vitest+testcontainers.

**Riferimento design:** `docs/plans/2026-07-24-backlog-from-design-design.md`.

**Convenzioni:** TDD; `pnpm lint` prima del merge; migrazioni via `pnpm --filter @stubwise/db exec drizzle-kit generate` applicate all'avvio server; schemi shared → build prima di typecheck/test server/worker; MCP autonomo a runtime (no import runtime da @stubwise/shared). ⚠️ **WORKTREE**: ogni implementer deve `cd /Users/aleloca/git/stubwise/.worktrees/backlog-from-design`, verificare `git rev-parse --show-toplevel` (finisce in /.worktrees/backlog-from-design) e `git branch --show-current` = `feature/backlog-from-design`, lavorare SOLO lì con path relativi, mai toccare il checkout main; se Read desse contenuto diverso da `git show HEAD:<file>`, fidarsi del disco/git e usare anchor unici.

**Ordine:** Task 1 (shared+db) → 2 (server) → 3 (worker) → 4 (MCP) → 5 (skill/descrizioni). 1→3 sono catena; 4 dipende da 2; 5 è doc.

---

## Task 1: Enum `estimate` + payload + migrazione 0059

**Files:** `packages/shared/src/schemas/backlog.ts`; migrazione `0059_*.sql`; `packages/db/src/schema.test.ts`.

**Step 1 — Shared.**
- Aggiungi `"estimate"` a `backlogJobKindSchema` (`z.enum([...])`, ~riga 37): `z.enum(["intake", "deep_dive", "chat_turn", "estimate"])`.
- Aggiungi `export const backlogEstimatePayloadSchema = z.object({ itemId: z.uuid() }).strict();` e inseriscilo nella union `backlogJobPayloadSchema` (~riga 101).
- Aggiungi `export const createBacklogFromDesignSchema = z.object({ projectId: z.uuid(), title: z.string().min(1).max(300), design: z.string().min(1).max(200_000) });` (per il Task 2).
Il `pgEnum` `backlogJobKind` in `packages/db/src/schema.ts:106` eredita il valore via `enumValues` — non serve toccarlo.

**Step 2 — Test schema (schema.test.ts).** Aggiungi un test (stile Drizzle, container condiviso): inserisci un `backlogJobs` con `kind: "estimate"`, `payload: { itemId: <un backlog_item id valido> }` e rileggilo. (Prima serve la migrazione — vedi Step 4.)

**Step 3 — Build shared + verifica FAIL** senza migrazione: `pnpm --filter @stubwise/shared build`; il test schema fallisce finché l'enum DB non ha `estimate` (i testcontainer applicano le migrazioni).

**Step 4 — Migrazione.** `pnpm --filter @stubwise/db exec drizzle-kit generate` → deve produrre `0059_*.sql` con `ALTER TYPE "public"."backlog_job_kind" ADD VALUE 'estimate';` (precedente: `0045_doc_page_kind_product.sql`). Se drizzle-kit non lo genera correttamente per gli enum, scrivi la migrazione a mano + aggiorna `meta/_journal.json` e lo snapshot come fa drizzle (verifica il pattern di 0045). Additivo, nessun uso in migrazioni successive → nessuna trappola.

**Step 5 — Verifica PASS:** `pnpm --filter @stubwise/db test -- schema.test.ts` (builda shared se serve).

**Step 6 — Commit:** `git add packages/shared/src/schemas/backlog.ts packages/db/drizzle packages/db/src/schema.test.ts && git commit -m "feat(db): job kind estimate + payload + createBacklogFromDesignSchema (0059)"`

---

## Task 2: Endpoint `POST /api/backlog/from-design`

**Files:** `apps/server/src/routes/backlog.ts`; `apps/server/src/routes/backlog.test.ts`.

**Step 1 — Test (backlog.test.ts).** Via `app.inject` (setup come i test esistenti):
- `POST /api/backlog/from-design` `{ projectId, title, design }` → **201** `{ itemId, url }`. Verifica in DB: il `backlog_items` esiste con `document === design` (verbatim), `source === "manual"`, `status === "new"`, effort/risk/urgency null, embedding null.
- Un `backlog_jobs` con `kind === "estimate"` e `payload.itemId === itemId` è stato accodato.
- 404 se projectId inesistente; 400 su body invalido (design vuoto, >200k, title mancante); 401 senza sessione.

**Step 2 — Verifica FAIL.**

**Step 3 — Implementa** nel plugin backlog (riusa `requireAuth`, `createBacklogFromDesignSchema` da @stubwise/shared, `apiError`, `app.publicUrl` per l'url). Handler `app.post("/from-design", ...)`:
```ts
async (request, reply) => {
  const { projectId, title, design } = request.body;
  const [project] = await app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) return apiError(reply, 404, "project_not_found", "Project not found");
  const itemId = await app.db.transaction(async (tx) => {
    const [item] = await tx.insert(backlogItems)
      .values({ projectId, title, document: design, source: "manual" })
      .returning({ id: backlogItems.id });
    await tx.insert(backlogJobs).values({ projectId, kind: "estimate", payload: { itemId: item!.id } });
    return item!.id;
  });
  return reply.code(201).send({ itemId, url: `${app.publicUrl}/backlog/${itemId}` });
}
```
Response schema `201: z.object({ itemId: z.uuid(), url: z.string() })`. Verifica il nome reale del campo publicUrl sul server (`app.publicUrl` è decorato in app.ts). `backlogItems`/`backlogJobs` sono già importati in backlog.ts.

**Step 4 — Verifica PASS:** `pnpm --filter @stubwise/server test -- backlog.test.ts` (builda db/shared se serve).

**Step 5 — Commit:** `feat(server): POST /api/backlog/from-design (crea sincrona + accoda estimate)`

---

## Task 3: Worker — handler `estimate`

**Files:** Create `apps/worker/src/backlog/estimate.ts` + `estimate.test.ts`; modify `apps/worker/src/backlog/poller.ts`; prompt in `apps/worker/src/backlog/prompts.ts`.

**Step 1 — LEGGI** `apps/worker/src/backlog/intake.ts` (schema output metadati `intakeOutputSchema`, `parseAgentJson`, uso di `deps.embeddingClient.embed`, `deps.runAgent`/come si lancia l'agente, permissionMode), `deep-dive.ts` (prompt che stima senza riscrivere), `poller.ts` (`BacklogPollerDeps`, `runBacklogJob`, il claim `IN`-list, `runIntakeFn`/`runDeepDiveFn` pattern). NON assumere: replica i meccanismi reali.

**Step 2 — Prompt metadati-only** in `prompts.ts`: `buildEstimatePrompt(document: string): string` che dà il `document` già pronto e chiede in JSON SOLO `{ effort (1-5), risk, riskNote?, urgency }` (riusa il testo "LE STIME" di `buildIntakePrompt`; NON chiedere title/document). Schema output `estimateOutputSchema = z.object({ effort: effortSchema, risk: backlogRiskSchema, riskNote: z.string().max(2000).optional(), urgency: backlogUrgencySchema })` (in estimate.ts).

**Step 3 — `estimate.ts`** → `runEstimate(deps, job, { itemId })`:
- Carica l'item (`select` document/status); se assente → errore/skip pulito; se `converted`/`archived` → skip (già chiuso).
- `const [vec] = await deps.embeddingClient.embed([item.document]);` (throw se nessun vettore → retry, come intake).
- Lancia l'agente col `buildEstimatePrompt(item.document)`, `permissionMode: "default"` (input non fidato, senza tool, come intake), parse con `parseAgentJson(estimateOutputSchema, output)`; se null → errore (retry/fail come intake).
- `await deps.db.update(backlogItems).set({ effort, risk, riskNote: riskNote ?? null, urgency, embedding: vec }).where(eq(backlogItems.id, itemId));` — NON tocca `document`.
Firma coerente con `runIntake`/`runDeepDive` (stessi `deps`, `job`).

**Step 4 — Poller** (`poller.ts`):
- Aggiungi `'estimate'` alla `IN`-list del claim del poller lento (dove c'è `IN ('intake', 'deep_dive')`).
- In `runBacklogJob`: nuovo ramo `if (job.kind === "estimate") { const runEstimateFn = deps.runEstimateFn ?? runEstimate; const parsed = backlogEstimatePayloadSchema.safeParse(job.payload); if (!parsed.success) throw new MalformedBacklogPayloadError(...); await runEstimateFn(deps, job, parsed.data); return; }`.
- Aggiungi `runEstimateFn?` a `BacklogPollerDeps` (pattern `runIntakeFn`/`runDeepDiveFn`).

**Step 5 — Test.**
- `estimate.test.ts`: con `embeddingClient` mock (ritorna un vettore) e agente mock (ritorna JSON metadati), `runEstimate` aggiorna l'item con effort/risk/urgency + embedding e lascia `document` INVARIATO; agente che ritorna JSON malformato → errore; item con document non toccato. Imita i test intake/deep-dive esistenti (come mockano deps).
- `poller.test.ts`: un job `kind:"estimate"` viene dispatchato a `runEstimateFn`; payload malformato (`{}`) → MalformedBacklogPayloadError; verifica che il claim del poller lento consideri `estimate`.

**Step 6 — Verifica:** `pnpm --filter @stubwise/worker test` (testcontainers, lento). Typecheck worker.

**Step 7 — Commit:** `feat(worker): handler estimate (metadati-only + embedding, no rewrite)`

---

## Task 4: MCP — tool `create_backlog_from_design`

**Files:** `packages/mcp/src/client.ts`, `packages/mcp/src/tools/write.ts`; test; `.changeset/*.md`.

**Step 1 — Test.** (a) client `createBacklogFromDesign(projectId, title, design)` → `POST /api/backlog/from-design` body `{ projectId, title, design }`, header auth, ritorna `{ itemId, url }`. (b) tool `create_backlog_from_design` `{ project?, title, design }`: risolve il progetto (resolveProject), chiama il client, output con itemId+url; errore client → ToolResult isError.

**Step 2 — Verifica FAIL.**

**Step 3 — Implementa.**
- `client.ts`: `createBacklogFromDesign(projectId, title, design): Promise<{ itemId: string; url: string }>` → `POST /api/backlog/from-design`. Valida la risposta come gli altri metodi (inline zod `{ itemId, url }`).
- `tools/write.ts`: tool `create_backlog_from_design` con inputSchema `{ project: z.string().optional(), title: z.string(), design: z.string().max(200_000) }`, via `runTool` + `resolveProject`. Descrizione: **usare quando hai già un design doc completo** — salva il design verbatim e stima solo i metadati (a differenza di `create_backlog_item`, che sintetizza feedback grezzo). Registra in `registerWriteTools`.
- Aggiorna anche la descrizione di `create_backlog_item` (nota che l'intake sintetizza) e di `set_design` (funziona anche su una voce appena creata, scrive verbatim) — parte del guidance fix.
- Mantieni autonomia runtime (no import runtime da @stubwise/shared).

**Step 4 — Verifica:** `pnpm --filter @stubwise/mcp test` + `typecheck`; `grep -rn "@stubwise/shared" packages/mcp/dist --include='*.js'` VUOTO.

**Step 5 — Changeset:** `.changeset/mcp-from-design.md` minor:
```
---
"@stubwise/mcp": minor
---
Nuovo tool create_backlog_from_design (design pronto → voce verbatim + stima metadati). Descrizioni di create_backlog_item/set_design chiarite.
```

**Step 6 — Commit:** `feat(mcp): tool create_backlog_from_design + descrizioni + changeset`

---

## Task 5: Skill — i tre percorsi

**Files:** `.claude/skills/stubwise/SKILL.md`.

Chiarisci i tre modi di portare contenuto in una voce di backlog:
- **Design già pronto** → `create_backlog_from_design` (verbatim + solo stima metadati). È il default quando l'utente ha un design doc completo.
- **Feedback/idea grezza** → `create_backlog_item` (l'intake AI lo sintetizza in un documento conciso; async).
- **Arricchire una voce/ticket ESISTENTE** → `set_design` (sostituisce il corpo verbatim, preserva l'origine; funziona anche su una voce appena creata) e `set_plan` (piano dedicato).
Aggiungi la nota che `create_backlog_item` NON conserva il testo verbatim (lo riassume) → per un design pronto usare `create_backlog_from_design`.

**Commit:** `docs(skill): tre percorsi di creazione voce (from-design / grezzo / set_design)`

---

## Verifica finale (prima del merge)

1. `pnpm build && pnpm typecheck && pnpm lint` — verdi.
2. Test per pacchetto: `db, server, worker, mcp`.
3. `superpowers:requesting-code-review` sul branch.

## Deploy

- Migrazione `0059` (enum ADD VALUE) all'avvio server → **backup DB**; rebuild `server` + `worker` (no UI). Worker restart: verificare `doc_generations` running/paused vuoto.
- MCP: changeset → merge PR "Version Packages" → pubblica `@stubwise/mcp` `0.3.0`.
- Skill: la copia via `curl` dal raw GitHub prende la nuova versione (o ri-copiare in `~/.claude/skills/`).
