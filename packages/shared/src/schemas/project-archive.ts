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
