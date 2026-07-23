# Design doc & piano di implementazione su backlog/ticket — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development) per implementare questo piano task-per-task.

**Goal:** Salvare su backlog e ticket un design doc (che sostituisce il corpo, preservando l'origine) e un piano di implementazione (campo dedicato), con CRUD completo via API + tool MCP + UI; e (Fase 2) far eseguire direttamente il piano salvato dalla pipeline di fix.

**Architecture:** Due colonne nuove (`implementation_plan`, `origin_content`) su `backlog_items` e `tickets` (migrazione 0058). Endpoint sotto-risorsa dedicati (`/design`, `/plan`, PUT/DELETE, `requireAuth`) su backlog e ticket; read di dettaglio esteso; convert che eredita i campi. 4 tool MCP (`set_design`/`delete_design`/`set_plan`/`delete_plan` con `target`) + read esteso. UI di dettaglio: render piano + origine + delete. Fase 2: `run-ai` con `implementation_plan` → job `resumeMode=execute`+`planText` → esecuzione diretta.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, React+TanStack, @modelcontextprotocol/sdk, Vitest+testcontainers.

**Riferimento design:** `docs/plans/2026-07-23-design-plan-fields-design.md`.

**Convenzioni:** TDD; `pnpm lint` prima del merge; migrazioni generate con `pnpm --filter @stubwise/db exec drizzle-kit generate`, applicate all'avvio server; schemi condivisi in `@stubwise/shared` richiedono build prima di typecheck/test del server; i test di schema additivo vanno in `schema.test.ts` (non file migration-00xx dedicati); MCP autonomo a runtime (schemi-valore inline, `@stubwise/shared` in devDeps — non reintrodurre import runtime da shared).

**Ordine:** Fase 1 (Task 1→8) prima; Fase 2 (Task 9) dopo, isolata.

---

# FASE 1 — storage + authoring + visibilità

## Task 1: Colonne DB + migrazione 0058

**Files:** `packages/db/src/schema.ts` (tabelle `backlogItems` ~riga 2014, `tickets` ~riga 452); migrazione `0058_*.sql` (generata); test in `packages/db/src/schema.test.ts`.

**Step 1 — Test (schema.test.ts).** Aggiungi, in stile Drizzle sul container condiviso: (a) un `backlog_item` con `implementationPlan`/`originContent` di default null, poi update dei due campi e rilettura; (b) idem per un `ticket`. Imita i test esistenti.

**Step 2 — Verifica FAIL:** `pnpm --filter @stubwise/db test -- schema.test.ts`.

**Step 3 — Implementa.** In `backlogItems` e `tickets` aggiungi (dopo il campo corpo/`document`/`body`):
```ts
implementationPlan: text("implementation_plan"),
originContent: text("origin_content"),
```
Entrambi nullable. Attenzione: su `tickets` NON toccare la colonna generata `search_tsv` (resta su title+body).

**Step 4 — Migrazione:** `pnpm --filter @stubwise/db exec drizzle-kit generate` → verifica `0058_*.sql` con SOLO le 4 ADD COLUMN (2 per tabella). Nessun diff spurio → altrimenti fermati.

**Step 5 — Verifica PASS:** `pnpm --filter @stubwise/db test -- schema.test.ts` (builda `@stubwise/shared` se dist stale).

**Step 6 — Commit:** `git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle && git commit -m "feat(db): implementation_plan + origin_content su backlog_items e tickets (0058)"`

---

## Task 2: Schemi condivisi + estensione dettaglio

**Files:** `packages/shared/src/schemas/backlog.ts`, `packages/shared/src/schemas/ticket.ts` (o dove è definito lo schema ticket di risposta). Verifica PRIMA dove sono i detail schema.

**Step 1 — Schemi payload.** Aggiungi uno schema condiviso per il body degli endpoint:
```ts
export const setContentSchema = z.object({ content: z.string().min(1).max(20_000) });
```
(riusabile per design e plan, backlog e ticket; mettilo in un punto neutro es. `schemas/shared.ts` o in entrambi i file — segui la convenzione esistente).

**Step 2 — Estendi i detail schema** per esporre i nuovi campi:
- Backlog: `backlogItemBaseSchema`/detail (in `apps/server/src/routes/backlog.ts` ~riga 89-97 c'è `document: z.string()`) → aggiungi `implementationPlan: z.string().nullable()`, `originContent: z.string().nullable()`. Se lo schema di dettaglio è in shared, aggiorna lì; verifica.
- Ticket: lo schema di risposta del ticket (`ticketSchema` in shared) → aggiungi gli stessi due campi nullable. Verifica dove è definito (`packages/shared/src/schemas/ticket.ts`).

**Step 3 — Build shared + typecheck.** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared typecheck`.

**Step 4 — Commit:** `feat(shared): setContentSchema + campi implementationPlan/originContent nei detail schema`.

---

## Task 3: Endpoint backlog design/plan + read + convert

**Files:** `apps/server/src/routes/backlog.ts`; test `apps/server/src/routes/backlog.test.ts`.

**Step 1 — Test (backlog.test.ts).** Casi via `app.inject` (setup come i test esistenti):
- `PUT /api/backlog/:id/design` `{content}` → 200; il `document` diventa `content`; `originContent` = vecchio document (preservato). Un SECONDO `PUT /design` NON ri-preserva (originContent invariato).
- `DELETE /api/backlog/:id/design` → 200/204; `document` torna a `originContent`; `originContent` = null. Su item senza design attivo (originContent null) → 404.
- `PUT /api/backlog/:id/plan` `{content}` → `implementationPlan = content`. `DELETE …/plan` → null.
- `GET /api/backlog/:id` espone `implementationPlan` e `originContent`.
- `POST /api/backlog/:id/convert` → il ticket creato eredita `body=document`, `implementationPlan`, `originContent`.
- 401 senza sessione; 404 id inesistente; 400 content > 20k.

**Step 2 — Verifica FAIL.**

**Step 3 — Implementa gli handler** nel plugin (riusa `requireAuth`, `setContentSchema`, `apiError`). Esempio design PUT:
```ts
app.put("/:id/design", { preHandler: requireAuth, schema: { params: idParamsSchema, body: setContentSchema, response: { 200: backlogItemDetailSchema, 404: errorSchema, ...authErrorResponses } } },
  async (request, reply) => {
    return app.db.transaction(async (tx) => {
      const [item] = await tx.select().from(backlogItems).where(eq(backlogItems.id, request.params.id));
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      const origin = item.originContent ?? item.document; // preserva una volta
      await tx.update(backlogItems).set({ document: request.body.content, originContent: origin }).where(eq(backlogItems.id, item.id));
      // rileggi e ritorna il detail
    });
  });
```
DELETE /design: se `originContent` null → 404; altrimenti `document = originContent`, `originContent = null`. PUT/DELETE /plan: set/clear `implementationPlan`. Estendi la SELECT del detail (`GET /:id`) e il `toDetail` per includere i due campi. Estendi il convert (`createTicket(tx, {..., body: item.document})` ~riga 1267) aggiungendo `implementationPlan: item.implementationPlan, originContent: item.originContent` (richiede che `createTicket` accetti questi campi — vedi Task 4/estensione createTicket).

**Step 4 — Verifica PASS.** **Step 5 — Commit** `feat(server): endpoint design/plan backlog + convert eredita i campi`.

---

## Task 4: Endpoint ticket design/plan + read + audit

**Files:** `apps/server/src/routes/tickets.ts` (+ eventuale `createTicket` helper); test `apps/server/src/routes/tickets.test.ts`.

**Step 1 — Test.** Come Task 3 ma su ticket (`body`/`originContent`): PUT/DELETE design (preserva/ripristina), PUT/DELETE plan, `GET /api/tickets/:id` espone i campi, `PUT /design` genera un `ticket_event` di audit (verifica in `/api/tickets/:id/activity` o sulla tabella eventi), 401/404/400.

**Step 2 — Verifica FAIL.**

**Step 3 — Implementa.** Handler `PUT/DELETE /:id/design` e `/:id/plan` con `requireAuth`. Il set del design aggiorna `body` in transazione e genera l'evento (riusa `diffTicketEvents`, come la PATCH a `tickets.ts:992`). Estendi la risposta di dettaglio (`GET /:id`) + il mapping per includere `implementationPlan`/`originContent`. Estendi l'helper `createTicket` (usato anche dal convert) per accettare/persistere `implementationPlan` e `originContent` opzionali.

**Step 4 — Verifica PASS.** **Step 5 — Commit** `feat(server): endpoint design/plan ticket + audit event + createTicket esteso`.

---

## Task 5: MCP — client, 4 tool, read esteso, changeset

**Files:** `packages/mcp/src/client.ts`, `packages/mcp/src/tools/write.ts`, `packages/mcp/src/tools/read.ts`, `.changeset/<nome>.md`; test relativi.

**Step 1 — Test.** (a) client: `setDesign/deleteDesign/setPlan/deletePlan` per target backlog|ticket chiamano il path/metodo giusto (fetch mockato); (b) tool `set_design/delete_design/set_plan/delete_plan` (handler diretti, client mock): input valido → chiamata giusta, errori del client → ToolResult isError; (c) `get_backlog_item`/`get_ticket` includono i nuovi campi nell'output.

**Step 2 — Verifica FAIL.**

**Step 3 — Implementa.**
- `client.ts`: metodi `setDesign(target, id, content)`, `deleteDesign(target, id)`, `setPlan(...)`, `deletePlan(...)` → `PUT/DELETE ${target==='backlog'?'/api/backlog':'/api/tickets'}/${id}/{design|plan}`. NON reintrodurre import runtime da `@stubwise/shared` (usa tipi locali/inline). Estendi i tipi `BacklogItemDetail`/`Ticket` con `implementationPlan`/`originContent`.
- `tools/write.ts`: 4 tool con inputSchema `{ target: z.enum(["backlog","ticket"]), id: z.string().uuid(), content?: z.string() }` (content solo per i set). Registra in `registerWriteTools`. Usano `runTool`.
- `tools/read.ts`: `get_backlog_item`/`get_ticket` includono `implementationPlan`/`originContent` nell'output testuale.

**Step 4 — Verifica:** `pnpm --filter @stubwise/mcp test/typecheck`, `eslint`, e `grep -rn "@stubwise/shared" packages/mcp/dist --include='*.js'` VUOTO.

**Step 5 — Changeset:** crea `.changeset/mcp-design-plan-tools.md`:
```
---
"@stubwise/mcp": minor
---
Nuovi tool set_design/delete_design/set_plan/delete_plan (backlog e ticket) + get_* estesi con implementationPlan/originContent.
```

**Step 6 — Commit** `feat(mcp): tool design/plan + read esteso + changeset`.

---

## Task 6: UI dettaglio backlog

**Files:** `apps/web/src/routes/backlog/$id.tsx`; `apps/web/src/lib/api.ts`/`queries.ts`; i18n `backlog` (en+it); test.

**Step 1 — Binding API + tipi** in `lib/api.ts`: `setBacklogDesign`/`deleteBacklogDesign`/`setBacklogPlan`/`deleteBacklogPlan`, e tipi con `implementationPlan`/`originContent`.

**Step 2 — Test** (happy-dom): render con `implementationPlan` → sezione "Piano di implementazione"; con `originContent` → blocco collassabile "Richiesta originale"; delete plan/design con conferma → chiama l'API.

**Step 3 — Implementa.** In `$id.tsx:313` la sezione `document` resta (rietichetta "Design / Descrizione"). Aggiungi: sezione "Piano di implementazione" (`<Markdown source={item.implementationPlan}/>` con empty state), blocco collassabile "Richiesta originale" se `originContent`, e pulsanti Elimina design/Elimina piano (conferma a due passi, invalidano la query). Aggiorna `exportMarkdown` per includere il piano. Chiavi i18n en+it (parità).

**Step 4 — Verifica:** `pnpm --filter @stubwise/web test/typecheck`. **Step 5 — Commit** `feat(web): design/piano/origine nel dettaglio backlog`.

---

## Task 7: UI dettaglio ticket

**Files:** `apps/web/src/routes/tickets/$id.tsx`; `lib/api.ts`; i18n `tickets`; test. Come Task 6, su `ticket.body`/`implementationPlan`/`originContent` (sezione dopo la descrizione a `$id.tsx:321`). Binding `setTicketDesign`/`deleteTicketDesign`/`setTicketPlan`/`deleteTicketPlan`. **Commit** `feat(web): design/piano/origine nel dettaglio ticket`.

---

## Task 8: Aggiornamento skill

**Files:** `.claude/skills/stubwise/SKILL.md`.

Aggiungi i flussi: da un backlog o ticket, design finalizzato → `set_design`; piano finalizzato → `set_plan`; rigenerare solo il piano → `set_plan` di nuovo; eliminare → `delete_design`/`delete_plan`; per i ticket, ricordare che Run AI dalla UI eseguirà il piano salvato. Nota che `set_design` sostituisce il corpo preservando l'origine. **Commit** `docs(skill): flussi design/piano su backlog e ticket`.

---

# FASE 2 — integrazione col fix (isolata, rischiosa)

## Task 9: run-ai esegue direttamente col piano salvato

**Files:** `apps/server/src/routes/tickets.ts` (handler `run-ai` ~riga 1034-1089); `apps/worker/src/pipeline/fix.ts` (`resolveFixMode` ~333) / `apps/worker/src/queue.ts` (enqueue); test server + worker.

**Step 1 — LEGGI** il flusso reale: `run-ai` handler, come crea/riaccoda l'`ai_job`, `queue.ts:269-285` (set `awaiting_plan_approval`+`planText`), `resolveFixMode` (execute-only se `resumeMode==="execute" && planText`), `handler.ts:107-113` (resume). Capisci come accodare un job che parte in `execute` con un `planText` fornito, SENZA passare da planning/approval.

**Step 2 — Test.**
- server: `POST /api/tickets/:id/run-ai` su un ticket CON `implementationPlan` → accoda un `ai_job` con `resumeMode="execute"` e `planText = implementationPlan`, stato `queued` (verifica in DB). Con `mode:"ai_plan"` (o senza piano) → flusso normale invariato (triage/planning).
- worker: un job `resumeMode="execute"` + `planText` (senza planning pregresso) → `resolveFixMode` ritorna execute-only ed esegue col piano; un job senza planText → flusso invariato. Imita i test worker esistenti della pipeline (mock dell'agente).

**Step 3 — Implementa.** Nel handler `run-ai`: se `ticket.implementationPlan` presente e `mode !== "ai_plan"`, accoda il job in modalità execute-diretta col `planText`. Estendi lo schema del body di `run-ai` con `mode?: "ai_plan"` opzionale. Assicurati che il percorso worker execute gestisca un job che inizia in execute senza contesto di planning (verifica `resolveFixMode` e l'handler); se serve un piccolo adattamento nel worker, fallo minimale e testato.

**Step 4 — Verifica:** `pnpm --filter @stubwise/server test`, `pnpm --filter @stubwise/worker test`, typecheck. **Step 5 — Commit** `feat: run-ai esegue direttamente col piano di implementazione salvato`.

---

# Verifica finale (prima del merge)

1. `pnpm build && pnpm typecheck && pnpm lint` — verdi (lint è il gate CI).
2. Test per pacchetto toccato: `db, server, worker, web, mcp`.
3. `superpowers:requesting-code-review` sul branch.
4. E2E Playwright per le pagine di dettaglio (a mano).

# Deploy

- Migrazione `0058` all'avvio server → **backup DB** prima; rebuild `server` + `worker` + `caddy`.
- MCP: il changeset → merge della PR "Version Packages" → pubblica `@stubwise/mcp` (minor, es. 0.2.0); su Audin/altri repo `npx` prende la nuova versione.
- Skill aggiornata: ricopiare `.claude/skills/stubwise/SKILL.md` in `~/.claude/skills/stubwise/` per l'uso cross-repo.
