import { automationRuns, type Db } from "@stubwise/db";
import type { AutomationDetail, AutomationFlow } from "@stubwise/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AutomationError,
  automationRows,
  configErrorsOf,
  latestVersion,
  listAutomations,
  publishedVersion,
  visibleAutomation,
  type Viewer,
} from "../automations/model.js";
import { approveRun, chooseRunProject, controlRun, getRun, listRuns, rejectRun, runRowOf } from "../automations/runs.js";
import { listMyApprovals, listMyRuns } from "../automations/me.js";
import { automationOrigin, projectAutomations } from "../automations/entry.js";
import { simulationExamples } from "../automations/examples.js";
import { estimateTest, runTestClaude } from "../automations/test-claude.js";
import {
  activateAutomation,
  checkFlow,
  createAutomation,
  deleteDraft,
  duplicateAutomation,
  markTested,
  patchAutomation,
  pauseAutomation,
  publishAutomation,
  saveDraft,
  startManualRun,
} from "../automations/writes.js";

/**
 * LE ROTTE DELLE AUTOMATIONS (area 7, fetta 1). Le forme sono i tipi di
 * `@stubwise/shared/automations` (`Automation`, `AutomationRow`,
 * `AutomationDetail`, `AutomationRunRow`, `AutomationRunDetail`), come le
 * legge il client (`apps/desktop/.../real/automations.ts`). L'accesso è
 * `user` sulla rotta e si decide nel servizio, perché il progetto viene dal
 * codice dell'automazione: 404 a chi non vede il progetto (come una che non
 * esiste), 403 senza `automations.manage`; un'esecuzione la vede anche chi
 * deve decidere su di lei adesso. Gli errori sono `{ code, message }` più i
 * campi utili (`issues` per `config`, `rev` per `stale`).
 */

const ACCESS = { kind: "user" } as const;
const codeParams = z.object({ code: z.string().min(1).max(40) });
const runParams = codeParams.extend({ n: z.coerce.number().int().positive() });
const flowSchema = z.custom<AutomationFlow>((v) => {
  const f = v as { trigger?: unknown; steps?: unknown; titleTemplate?: unknown } | null;
  return !!f && typeof f === "object" && !!f.trigger && typeof f.trigger === "object" && Array.isArray(f.steps) && typeof f.titleTemplate === "string";
}, "A flow needs trigger, steps and titleTemplate");
const statusSchema = z.enum(["draft", "active", "paused"]);
const runStatusSchema = z.enum(["running", "waiting_approval", "waiting_event", "waiting_project", "suspended", "done", "failed", "cancelled"]);
const expected = { expectedPath: z.string().min(1), expectedRound: z.number().int().min(0).optional() };

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AutomationError) return reply.code(error.status).send({ code: error.code, message: error.message, ...error.extra });
    throw error;
  }
}

/** Il dettaglio: la riga, i problemi della bozza e della versione accesa, le ultime 20 esecuzioni. */
async function getAutomation(db: Db, viewer: Viewer, code: string): Promise<AutomationDetail> {
  const a = await visibleAutomation(db, viewer, code);
  const [row] = await automationRows(db, viewer, [a]);
  const latest = await latestVersion(db, a.id);
  const live = await publishedVersion(db, a.id);
  const owner = a.ownerId ?? viewer.id;
  const runs = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, a.id))
    .orderBy(sql`(${automationRuns.status} in ('running','waiting_approval','waiting_project','suspended')) desc`, desc(automationRuns.startedAt), desc(automationRuns.n))
    .limit(20);
  const rows = [];
  for (const r of runs) rows.push(await runRowOf(db, viewer, r, a));
  return {
    automation: row!,
    configErrors: latest ? await configErrorsOf(db, a, latest.flow as AutomationFlow, owner) : [],
    liveErrors: live ? await configErrorsOf(db, a, live.flow as AutomationFlow, owner) : [],
    runs: rows,
  };
}

export async function automationRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const me = (request: { user?: Viewer | null }) => request.user!;

  // --- le automazioni -------------------------------------------------------------
  // Le rotte con una parte letterale prima di `/:code` (la trappola di routing di CLAUDE.md).

  app.get(
    "/automations",
    {
      config: { access: ACCESS },
      schema: { querystring: z.object({ project: z.uuid().optional(), status: statusSchema.optional(), owner: z.uuid().optional(), mine: z.coerce.boolean().optional() }) },
    },
    async (request, reply) => handle(reply, async () => ({ items: await listAutomations(app.db, me(request), request.query) })),
  );

  app.post(
    "/automations",
    { config: { access: ACCESS }, schema: { body: z.object({ name: z.string().max(200), projectId: z.uuid(), description: z.string().max(2000).optional(), flow: flowSchema.optional() }) } },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await createAutomation(app.db, me(request), request.body))),
  );

  app.get("/automations/:code", { config: { access: ACCESS }, schema: { params: codeParams } }, async (request, reply) =>
    handle(reply, () => getAutomation(app.db, me(request), request.params.code)),
  );

  app.patch(
    "/automations/:code",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() }) } },
    async (request, reply) => handle(reply, () => patchAutomation(app.db, me(request), request.params.code, request.body)),
  );

  app.put(
    "/automations/:code/draft",
    {
      config: { access: ACCESS },
      schema: { params: codeParams, body: z.object({ flow: flowSchema, expectedRev: z.number().int().nullable(), name: z.string().max(200).optional(), description: z.string().max(2000).optional() }) },
    },
    async (request, reply) => handle(reply, () => saveDraft(app.db, me(request), request.params.code, request.body)),
  );

  app.delete(
    "/automations/:code/draft",
    { config: { access: ACCESS }, schema: { params: codeParams, querystring: z.object({ expectedRev: z.coerce.number().int().optional() }) } },
    async (request, reply) =>
      handle(reply, async () => {
        await deleteDraft(app.db, me(request), request.params.code, { expectedRev: request.query.expectedRev });
        return reply.code(204).send();
      }),
  );

  // Area 7, F2: la casella scelta accendendo o pubblicando (obbligatoria solo se il flusso manda email).
  const publishBody = z.object({ expectedRev: z.number().int().nullable().optional(), mailboxAccountId: z.uuid().optional() }).default({});
  app.post("/automations/:code/publish", { config: { access: ACCESS }, schema: { params: codeParams, body: publishBody } }, async (request, reply) =>
    handle(reply, () => publishAutomation(app.db, me(request), request.params.code, request.body ?? {})),
  );
  app.post("/automations/:code/activate", { config: { access: ACCESS }, schema: { params: codeParams, body: publishBody } }, async (request, reply) =>
    handle(reply, () => activateAutomation(app.db, me(request), request.params.code, request.body ?? {})),
  );
  app.post("/automations/:code/pause", { config: { access: ACCESS }, schema: { params: codeParams } }, async (request, reply) =>
    handle(reply, () => pauseAutomation(app.db, me(request), request.params.code)),
  );
  app.post(
    "/automations/:code/duplicate",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ name: z.string().max(200), version: z.number().int().positive().optional() }) } },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await duplicateAutomation(app.db, me(request), request.params.code, request.body))),
  );
  app.post("/automations/:code/check", { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ flow: flowSchema }) } }, async (request, reply) =>
    handle(reply, () => checkFlow(app.db, me(request), request.params.code, request.body.flow)),
  );
  // La prova: gli esempi veri e il contesto che i piani della prova leggono (sola lettura).
  app.get(
    "/automations/:code/examples",
    { config: { access: ACCESS }, schema: { params: codeParams, querystring: z.object({ version: z.union([z.literal("draft"), z.coerce.number().int().positive()]) }) } },
    async (request, reply) => handle(reply, () => simulationExamples(app.db, me(request), request.params.code, request.query.version)),
  );
  // F3: la stima della prova (gratuita) e un passo di Claude della prova (D4: chi gestisce, budget, lo stesso prompt).
  const testVersion = z.union([z.literal("draft"), z.number().int().positive()]);
  app.post(
    "/automations/:code/test/estimate",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ version: testVersion, event: z.record(z.string(), z.unknown()).default({}) }) } },
    async (request, reply) => handle(reply, () => estimateTest(app.db, me(request), request.params.code, request.body)),
  );
  app.post(
    "/automations/:code/test/claude",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ version: testVersion, rev: z.number().int().nullable().optional(), path: z.string().min(1).max(200), vars: z.record(z.string(), z.unknown()).default({}) }) } },
    async (request, reply) => handle(reply, () => runTestClaude(app.db, app.chatLlm, me(request), request.params.code, request.body)),
  );
  app.post(
    "/automations/:code/tested",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ version: z.number().int().positive(), rev: z.number().int().nullable() }) } },
    async (request, reply) =>
      handle(reply, async () => {
        await markTested(app.db, me(request), request.params.code, request.body);
        return reply.code(204).send();
      }),
  );

  // --- le letture personali ---------------------------------------------------------

  // «Da decidere»: ciò che aspetta chi guarda ADESSO.
  app.get("/me/automation-approvals", { config: { access: ACCESS } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listMyApprovals(app.db, me(request)) })),
  );
  // Il blocco Home: aspetta me, fallite che gestisco, mie non finite.
  app.get("/me/automation-runs", { config: { access: ACCESS }, schema: { querystring: z.object({ log: z.literal("none").optional() }) } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listMyRuns(app.db, me(request), { withLog: request.query.log !== "none" }) })),
  );

  // La sezione del progetto e la riga d'origine (R-G5: nascosto = inesistente).
  app.get("/projects/:projectId/automations", { config: { access: ACCESS }, schema: { params: z.object({ projectId: z.uuid() }) } }, async (request, reply) =>
    handle(reply, () => projectAutomations(app.db, me(request), request.params.projectId)),
  );
  app.get(
    "/automation-origin",
    { config: { access: ACCESS }, schema: { querystring: z.object({ task: z.string().max(40).optional(), milestone: z.uuid().optional() }).refine((q) => !!q.task !== !!q.milestone, "Pass task or milestone") } },
    async (request, reply) => handle(reply, () => automationOrigin(app.db, me(request), request.query)),
  );

  // --- le esecuzioni ----------------------------------------------------------------

  app.get(
    "/automation-runs",
    {
      config: { access: ACCESS },
      // `log=none`: righe senza registro (vuoto), per l'elenco letto spesso; il registro lo dà il dettaglio.
      schema: { querystring: z.object({ automation: z.string().max(40).optional(), project: z.uuid().optional(), status: runStatusSchema.optional(), cursor: z.string().max(200).optional(), log: z.literal("none").optional() }) },
    },
    async (request, reply) => handle(reply, () => listRuns(app.db, me(request), request.query)),
  );

  app.post(
    "/automations/:code/runs",
    { config: { access: ACCESS }, schema: { params: codeParams, body: z.object({ event: z.record(z.string(), z.unknown()).optional() }).default({}) } },
    async (request, reply) =>
      handle(reply, async () => {
        const run = await startManualRun(app.db, me(request), request.params.code, request.body ?? {});
        return reply.code(201).send(await getRun(app.db, me(request), request.params.code, run.n));
      }),
  );

  app.get("/automations/:code/runs/:n", { config: { access: ACCESS }, schema: { params: runParams } }, async (request, reply) =>
    handle(reply, () => getRun(app.db, me(request), request.params.code, request.params.n)),
  );

  app.post(
    "/automations/:code/runs/:n/approve",
    { config: { access: ACCESS }, schema: { params: runParams, body: z.object({ ...expected, edited: z.record(z.string(), z.string()).optional() }) } },
    async (request, reply) =>
      handle(reply, async () => {
        await approveRun(app.db, me(request), request.params.code, request.params.n, request.body);
        return reply.code(204).send();
      }),
  );
  app.post("/automations/:code/runs/:n/reject", { config: { access: ACCESS }, schema: { params: runParams, body: z.object(expected) } }, async (request, reply) =>
    handle(reply, async () => {
      await rejectRun(app.db, me(request), request.params.code, request.params.n, request.body);
      return reply.code(204).send();
    }),
  );
  app.post(
    "/automations/:code/runs/:n/project",
    { config: { access: ACCESS }, schema: { params: runParams, body: z.object({ ...expected, projectId: z.uuid() }) } },
    async (request, reply) =>
      handle(reply, async () => {
        await chooseRunProject(app.db, me(request), request.params.code, request.params.n, request.body);
        return reply.code(204).send();
      }),
  );
  for (const op of ["cancel", "retry", "skip"] as const) {
    app.post(`/automations/:code/runs/:n/${op}`, { config: { access: ACCESS }, schema: { params: runParams } }, async (request, reply) =>
      handle(reply, async () => {
        await controlRun(app.db, me(request), request.params.code, request.params.n, op);
        return reply.code(204).send();
      }),
    );
  }

}
