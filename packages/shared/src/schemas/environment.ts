import { z } from "zod";

/**
 * Schemi degli AMBIENTI di progetto (fase 8 — ambienti e coda di rilascio).
 *
 * Un ambiente è ANAGRAFICA, mai esecuzione: Stubwise registra dove un
 * progetto gira (test | staging | production), un URL facoltativo e un
 * collegamento facoltativo a un server già monitorato — non lo esegue, non lo
 * rilascia mai. L'unico ambiente che la pipeline di fix può leggere è `test`
 * (invariante di `apps/worker/src/pipeline/env-files.ts`, vedi CLAUDE.md).
 */
export const environmentKindSchema = z.enum(["test", "staging", "production"]);
export type EnvironmentKind = z.infer<typeof environmentKindSchema>;

/**
 * Proiezione pubblica di un ambiente. `runningImage`/`runningCommitSha` sono
 * OPZIONALI (fase 8, Task 4): valorizzati solo quando l'ambiente è collegato a
 * un server monitorato E l'ultimo campione dell'agente ha trovato un servizio
 * con quel nome — un agente vecchio, o nessun server collegato, li lascia
 * entrambi assenti, mai un errore.
 */
export const projectEnvironmentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string().min(1).max(200),
  kind: environmentKindSchema,
  url: z.url().nullable(),
  serverId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Immagine del servizio (docker) trovato sul server collegato, se noto. */
  runningImage: z.string().optional(),
  /** `org.opencontainers.image.revision` del servizio, se il servizio la porta. */
  runningCommitSha: z.string().optional(),
  /**
   * Area 8, F1 (R-L2): su quale server gira ogni repository del progetto in
   * questo ambiente (repository diverse su server diversi). `.default([])`:
   * un server più vecchio non lo manda (e lì vale `serverId` per tutte).
   */
  servers: z.array(z.object({ repositoryId: z.uuid(), serverId: z.uuid() })).default([]),
});
export type ProjectEnvironment = z.infer<typeof projectEnvironmentSchema>;

/**
 * Corpo di creazione: `name`+`kind` obbligatori (l'unique è per (progetto,
 * nome)), `url`/`serverId` opzionali. Niente `.optional()` di comodo sui
 * primi due: senza un nome e un tipo l'ambiente non significa nulla.
 */
export const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(200),
  kind: environmentKindSchema,
  url: z.url().nullable().optional(),
  serverId: z.uuid().nullable().optional(),
  /** Area 8, F1 (R-L2): il server per repository; vince su `serverId` per le repository che nomina. */
  servers: z.array(z.object({ repositoryId: z.uuid(), serverId: z.uuid() })).max(200).optional(),
});
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;

/**
 * Corpo di modifica: PATCH, campi assenti = invariati. `kind` NON è
 * modificabile qui apposta — un ambiente `test` che cambiasse tipo per errore
 * lascerebbe il progetto senza l'unico ambiente che la pipeline può leggere;
 * chi vuole un ambiente di un altro tipo ne crea uno nuovo.
 */
export const patchEnvironmentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.url().nullable().optional(),
  serverId: z.uuid().nullable().optional(),
  /**
   * Area 8, F1 (R-L2): il server delle repository nominate (`serverId: null`
   * lo toglie a quella repository); le altre restano come sono.
   */
  servers: z.array(z.object({ repositoryId: z.uuid(), serverId: z.uuid().nullable() })).max(200).optional(),
});
export type PatchEnvironmentInput = z.infer<typeof patchEnvironmentSchema>;
