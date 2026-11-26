import { instanceSettings, s3ConfigFromSettings, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { changedFields, recordChange } from "./change-log.js";

/**
 * L'interruttore d'istanza degli allegati (lotto 6, voce 2; il prototipo,
 * `setAttachmentsAs` di `data/instance/storage.ts`): accenderlo chiede
 * l'archiviazione configurata e valida (`not_set_up`), spegnerlo no; niente
 * riconferma. La voce del registro è `storage.changed` col campo
 * `attachments`, come il prototipo. La usano la rotta e l'azione di Claude.
 */
export async function setAttachments(db: Db, encryptionKey: Buffer | null, actor: { id: string; email: string }, on: boolean): Promise<{ ok: true; was: boolean } | { ok: false; error: "not_set_up" }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).for("update");
    const was = row?.attachmentsSwitch ?? true;
    if (was === on) return { ok: true as const, was };
    // Senza chiave (la prova a secco del catalogo): i campi e il segreto ci sono; al run vero, valida davvero.
    const configured = encryptionKey
      ? validStorage(row, encryptionKey)
      : !!(row?.s3Endpoint && row.s3Bucket && row.s3AccessKey && row.s3SecretKeyEncrypted);
    if (on && !configured) return { ok: false as const, error: "not_set_up" as const };
    await tx.insert(instanceSettings).values({ id: 1, attachmentsSwitch: on }).onConflictDoUpdate({ target: instanceSettings.id, set: { attachmentsSwitch: on } });
    await recordChange(tx, { type: "storage.changed", actor, projectId: null, data: { object: { type: "storage", id: "storage", label: "storage" }, ...changedFields({ attachments: was }, { attachments: on })! } });
    return { ok: true as const, was };
  });
}

/**
 * La stessa regola di `storageConfigured` (routes/settings.ts), senza
 * importarlo: questo modulo lo raggiunge il catalogo di Claude, che non deve
 * arrivare ai moduli dello storage (`claude-actions-effects.test.ts`).
 */
function validStorage(row: typeof instanceSettings.$inferSelect | undefined, encryptionKey: Buffer): boolean {
  if (!row) return false;
  try {
    return s3ConfigFromSettings(row, encryptionKey) !== null;
  } catch {
    return false;
  }
}
