import { z } from "zod";

/**
 * Area 9, F4: lo Stato dell'istanza (`GET /api/instance/status`), nella forma
 * del prototipo (`apps/desktop/src/renderer/data/instance/status.ts`,
 * `InstanceStatusView`). Tutto calcolato dal server: chi legge non deduce
 * permessi, blocchi né visibilità. Solo letture: nessuna azione sui server.
 */

/** Perché un lavoro aspetta: il budget del mese o la coda del progetto in pausa. */
export const aiBlockSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("monthly_budget") }),
  z.object({ reason: z.literal("queue_paused"), byId: z.string().nullable().default(null), byName: z.string().default(""), since: z.string() }),
]);
export type AiBlockView = z.infer<typeof aiBlockSchema>;

const availabilitySchema = z.enum(["allowed", "forbidden", "unavailable"]);

export const instanceJobKindSchema = z.enum(["task_run", "correction", "pr_review", "server_analysis", "server_fix", "automation", "product_doc_update", "nightly"]);

export const instanceJobSchema = z.object({
  id: z.string(),
  kind: instanceJobKindSchema,
  projectId: z.string().nullable(),
  projectCode: z.string().default(""),
  title: z.string().default(""),
  /** La task «ACQ-57», l'esecuzione «ACQ-A2 #7», il server «SRV-2». */
  code: z.string().nullable().default(null),
  state: z.enum(["running", "waiting", "failed"]),
  /** Il blocco, solo per `waiting`; null su un lavoro che aspetta un worker o una persona. */
  waiting: aiBlockSchema.nullable().default(null),
  since: z.string(),
  /** Lo slot del worker che lo fa (`<worker>:<n>`), dall'heartbeat. */
  workerId: z.string().nullable().default(null),
  retry: availabilitySchema.default("unavailable"),
  /** Con `retry` forbidden: il permesso che manca. */
  retryNeeds: z.enum(["manageSettings", "startRun"]).nullable().default(null),
  /** Coi permessi giusti, il blocco che spegne Retry. */
  retryBlock: z.object({ reason: z.literal("monthly_budget") }).nullable().default(null),
  /** Chi riprova non ha `plans.approve`: Claude si ferma al piano. */
  retryStopsAtPlan: z.boolean().default(false),
  /** Il server non conosce le rotte del renderer: il link lo compone il client da `kind`, `projectCode` e `code`. */
  href: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  startFailed: z.boolean().default(false),
  superseded: z.boolean().default(false),
});
export type InstanceJob = z.infer<typeof instanceJobSchema>;

const countsSchema = z.object({ running: z.number().int(), waiting: z.number().int(), failed: z.number().int() });

export const instanceStatusSchema = z.object({
  queues: z.array(
    countsSchema.extend({
      projectId: z.string(),
      code: z.string(),
      name: z.string(),
      paused: z.object({ byId: z.string().nullable(), byName: z.string(), at: z.string() }).nullable().default(null),
      pause: availabilitySchema.default("forbidden"),
      /** I lavori in attesa che il budget del mese terrebbe fermi anche alla ripresa. */
      budgetAfterResume: z.number().int().default(0),
    }),
  ),
  otherProjects: countsSchema.nullable().default(null),
  jobs: z.array(instanceJobSchema),
  workers: z.array(z.object({ id: z.string(), jobId: z.string().nullable().default(null), hidden: z.boolean().default(false) })).default([]),
  quota: z
    .array(
      z.object({
        providerId: z.string(),
        name: z.string(),
        kind: z.string(),
        enabled: z.boolean(),
        quota: z
          .object({
            fiveHourPct: z.number(),
            weeklyPct: z.number(),
            readAt: z.string(),
            band: z.enum(["ok", "near", "limited"]),
            limitedUntil: z.string().nullable().default(null),
          })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
  errors: z
    .array(z.object({ jobId: z.string(), at: z.string(), summary: z.string(), startFailed: z.boolean().default(false), href: z.string().nullable().default(null) }))
    .default([]),
  nightly: z
    .array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        projectCode: z.string(),
        repositoryName: z.string(),
        phase: z.enum(["commit_summary", "release_note", "docs"]),
        state: z.enum(["running", "waiting", "failed", "done"]),
        at: z.string(),
        summary: z.string().nullable().default(null),
      }),
    )
    .default([]),
  refreshedAt: z.string(),
});
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;
