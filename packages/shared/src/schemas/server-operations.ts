import { z } from "zod";
import { serverAnalysisLimitsSchema } from "../servers/operations.js";

/**
 * Le forme delle operazioni sui server (area 8, F4b) per i client. Le regole
 * stanno in docs/invariants/server-operations.md. Ciò che chi guarda PUÒ fare
 * lo calcola il server (`can…`); ogni campo nuovo ha un default che non
 * concede niente. L'uscita di un server (`output`, `diagnosis`) è contenuto
 * NON fidato: si mostra come testo, mai come markup né come comando.
 */

const userRefSchema = z.object({ id: z.uuid(), name: z.string() });

/** Un comando (o una lettura) nel registro (S8). */
export const serverCommandViewSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  kind: z.enum(["change", "read"]),
  /** `ssh` per una lettura SSH, `agent` per un comando dell'agente. */
  via: z.enum(["agent", "ssh"]).default("agent"),
  status: z.enum(["pending", "delivered", "done", "failed", "expired", "cancelled"]),
  requestedBy: userRefSchema.nullable().default(null),
  approvalId: z.uuid().nullable().default(null),
  issuedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  /** Troncata a 16 KB, NON fidata. */
  output: z.string().nullable().default(null),
});
export type ServerCommandView = z.infer<typeof serverCommandViewSchema>;

/** Un'analisi per server (S5) e la sua attribuzione validata (S5b). */
export const serverAnalysisViewSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  episodeId: z.uuid().nullable().default(null),
  status: z.enum(["running", "done", "failed", "blocked"]),
  /** null = automatica, all'allarme. */
  startedBy: userRefSchema.nullable().default(null),
  /** La diagnosi: NON fidata. */
  diagnosis: z.string().nullable().default(null),
  attribution: z
    .object({
      kind: z.enum(["attributed", "undetermined"]),
      projectCode: z.string().nullable().default(null),
      reason: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** La task nata nel progetto attribuito, se chi guarda la vede. */
  taskCode: z.string().nullable().default(null),
  blockedBy: z.enum(["monthly_budget", "cap", "disabled"]).nullable().default(null),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable().default(null),
});
export type ServerAnalysisView = z.infer<typeof serverAnalysisViewSchema>;

/** Un passo del piano di correzione, col suo stato. */
export const serverFixStepViewSchema = z.object({
  index: z.number().int(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  why: z.string(),
  status: z.enum(["waiting", "running", "done", "failed", "skipped"]).default("waiting"),
  commandId: z.uuid().nullable().default(null),
});

/** La correzione di una task di server (S6): il piano, l'approvazione, i passi, cosa può fare chi guarda. */
export const serverFixViewSchema = z.object({
  taskId: z.uuid(),
  serverId: z.uuid(),
  serverCode: z.string().nullable().default(null),
  status: z.enum(["none", "proposing", "awaiting_approval", "approved", "running", "done", "failed", "stopped", "rejected"]),
  steps: z.array(serverFixStepViewSchema).default([]),
  approval: z.object({ by: userRefSchema, at: z.iso.datetime() }).nullable().default(null),
  rejection: z.object({ by: userRefSchema, at: z.iso.datetime(), note: z.string() }).nullable().default(null),
  /** L'agente ha le operazioni accese (senza, nessun piano si esegue). */
  operationsOn: z.boolean().default(false),
  canRequestPlan: z.boolean().default(false),
  canApprove: z.boolean().default(false),
  canStop: z.boolean().default(false),
  /** Perché l'ultimo piano proposto non è stato salvato (`schema`, `container_of_other_project`, `operations_off`…). Additivo. */
  planError: z.string().nullable().default(null),
  /**
   * F4b-8 = c: un passo `docker.prune` agisce su TUTTO il server. Gli ALTRI
   * progetti che toccherebbe (i nomi che chi guarda vede, più quanti non vede),
   * calcolati dal server; null = nessuna pulizia nel piano. Additivo.
   */
  pruneWarning: z.object({ projects: z.array(z.string()), hiddenCount: z.number().int() }).nullable().default(null),
});
export type ServerFixView = z.infer<typeof serverFixViewSchema>;

/** L'accesso SSH di sola lettura di un server (S7). Mai la privata. */
export const serverSshAccessViewSchema = z.object({
  status: z.enum(["none", "pending", "verified", "failed", "revoked"]),
  username: z.string().default("stubwise-read"),
  host: z.string().nullable().default(null),
  port: z.number().int().default(22),
  publicKey: z.string().nullable().default(null),
  /** La riga per `authorized_keys`, con `restrict`. */
  authorizedKeysLine: z.string().nullable().default(null),
  /** Il comando che crea l'utente senza gruppi. */
  setupCommand: z.string().nullable().default(null),
  verifiedAt: z.iso.datetime().nullable().default(null),
  verifyResult: z
    .object({ groups: z.array(z.string()), sudo: z.boolean(), docker: z.boolean(), journal: z.boolean(), ok: z.boolean() })
    .nullable()
    .default(null),
  canManage: z.boolean().default(false),
});
export type ServerSshAccessView = z.infer<typeof serverSshAccessViewSchema>;

/** `GET/PUT /api/settings/server-analysis` (S11). */
export const serverAnalysisSettingsSchema = serverAnalysisLimitsSchema;
