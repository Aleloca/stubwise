import { z } from "zod";

/**
 * Area 9, F6 (D-8): perché un progetto non si archivia adesso. Solo il
 * lavoro IN ESECUZIONE (L-5 = a): quello fermo in attesa di una persona
 * riparte riaprendo. Le forme del prototipo
 * (`projectSettings/types.ts`, `BusyReason`) più `doc_generation`.
 *
 * - `claude_session`: una sessione di Claude al lavoro (un job dell'agente,
 *   una review di PR, una conversazione). `code` e `title` sono `null`
 *   quando chi archivia non la vede (P23 del prototipo).
 * - `release`: un rilascio con le run non concluse; `code` è il codice del
 *   rilascio (`<CODICE>-V<n>`).
 * - `doc_generation`: una generazione Docs in corso o in pausa.
 *
 * Non un'unione discriminata: `readerSchema` apre l'enum di `kind`, non le
 * unioni (stessa scelta di `webhookSecretResultSchema`).
 */
export const busyReasonSchema = z.object({
  kind: z.enum(["claude_session", "release", "doc_generation"]),
  code: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  waiting: z.boolean().default(false),
  repository: z.string().nullable().default(null),
  paused: z.boolean().default(false),
});
export type BusyReason = z.infer<typeof busyReasonSchema>;

/** Cosa dice il dialogo prima di archiviare: le esecuzioni che si annulleranno e le ragioni di `busy`. */
export const archivePreviewSchema = z.object({
  openAutomationRuns: z.number().int().default(0),
  busy: z.array(busyReasonSchema).default([]),
});
export type ArchivePreview = z.infer<typeof archivePreviewSchema>;

/** I 409 di `POST …/archive` (`busy` con le ragioni, `already_archived`): piatti, come ogni errore del server. */
export const archiveBusyErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  reasons: z.array(busyReasonSchema).default([]),
});

/**
 * Quante cose ha il progetto: la pagina dell'archiviato e l'anteprima di
 * Delete (le dieci chiavi del prototipo, `DeletionCounts`). Sempre tutte:
 * 0 dove l'area non ha righe.
 */
export const deletionCountsSchema = z.object({
  tasks: z.number().int().default(0),
  requests: z.number().int().default(0),
  docPages: z.number().int().default(0),
  conversations: z.number().int().default(0),
  channels: z.number().int().default(0),
  driveFiles: z.number().int().default(0),
  automations: z.number().int().default(0),
  environments: z.number().int().default(0),
  envFiles: z.number().int().default(0),
  releases: z.number().int().default(0),
});
export type DeletionCounts = z.infer<typeof deletionCountsSchema>;

/**
 * Una riga della scheda «Archived» (`ArchivedProjectRow` del prototipo),
 * per i membri di allora e i full admin. `archivedBy` è il NOME di chi l'ha
 * archiviato, `null` se la persona non c'è più. I permessi li calcola il
 * server.
 */
export const archivedProjectRowSchema = z.object({
  projectId: z.uuid(),
  code: z.string(),
  name: z.string(),
  clientName: z.string().nullable().default(null),
  archivedAt: z.iso.datetime(),
  archivedBy: z.string().nullable().default(null),
  canReopen: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});
export type ArchivedProjectRow = z.infer<typeof archivedProjectRowSchema>;

/** Gli interruttori com'erano all'archiviazione: tornano così riaprendo. */
export const projectSwitchesSchema = z.object({
  docsNightly: z.boolean().default(false),
  dailyReport: z.boolean().default(false),
  backlogDiscovery: z.boolean().default(false),
  pulse: z.boolean().default(false),
  weeklyBrief: z.boolean().default(false),
});

/** La pagina dell'archiviato (`ArchivedProjectView` del prototipo). */
export const archivedProjectViewSchema = archivedProjectRowSchema.extend({
  description: z.string().default(""),
  /** I membri umani, col ruolo di progetto per nome; Claude e i bot non ci sono. */
  members: z.array(z.object({ personId: z.uuid(), name: z.string(), role: z.string() })).default([]),
  counts: deletionCountsSchema,
  /** I nomi, in ordine alfabetico: a Delete restano senza progetto. */
  repositories: z.array(z.string()).default([]),
  switchesOnReopen: projectSwitchesSchema,
  pulseEveryDays: z.number().int(),
});
export type ArchivedProjectView = z.infer<typeof archivedProjectViewSchema>;

/**
 * Cosa toglie Delete e cosa resta senza progetto (il prototipo,
 * `getDeletionPreview`): i conteggi, i server che resterebbero senza
 * ambienti (codici `SRV-<n>`, R-L7) e i repository che restano staccati
 * (nomi).
 */
export const deletionPreviewSchema = z.object({
  counts: deletionCountsSchema,
  orphanServers: z.array(z.string()).default([]),
  detachedRepositories: z.array(z.string()).default([]),
});
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;

/** Il corpo di `DELETE /api/projects/:projectId`: il codice del progetto, scritto esatto. */
export const deleteProjectSchema = z.object({ confirmCode: z.string().min(1).max(20) });
export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>;

/**
 * Un repository STACCATO (il suo progetto è stato eliminato), come lo legge
 * l'Amministrazione (`data/instance/repositories.ts` del prototipo). Il nome
 * intero e la provenienza solo a chi conosceva il progetto di prima (gli ex
 * membri e i full admin): il workspace può nominare il cliente (ruling T11).
 * `linkTargets` li calcola il server: i progetti APERTI dove chi guarda ha
 * `repos.manage` (tutti per un full admin).
 */
export const detachedRepositorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `owner/nome` intero a chi conosceva il progetto, altrimenti solo l'ultimo segmento. */
  fullName: z.string().nullable().default(null),
  /** L'URL solo a chi conosceva il progetto. */
  repoUrl: z.string().nullable().default(null),
  provider: z.string(),
  gitAccountName: z.string().nullable().default(null),
  gitAccountProvider: z.string().nullable().default(null),
  detachedAt: z.iso.datetime().nullable().default(null),
  formerProject: z.object({ code: z.string(), name: z.string() }).nullable().default(null),
  canDelete: z.boolean().default(false),
  linkTargets: z.array(z.object({ projectId: z.uuid(), code: z.string(), name: z.string() })).default([]),
});
export type DetachedRepository = z.infer<typeof detachedRepositorySchema>;

/** Il corpo di `POST /api/repositories/:id/link`: il progetto di destinazione. */
export const linkRepositorySchema = z.object({ projectId: z.uuid() });
