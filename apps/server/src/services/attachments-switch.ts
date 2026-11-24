import { instanceSettings, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { storageConfigured } from "../routes/settings.js";
import { changedFields, recordChange } from "./change-log.js";
import type { ObjectStorage } from "../storage/index.js";

/**
 * L'interruttore d'istanza degli allegati (lotto 6, voce 2; il prototipo,
 * `setAttachmentsAs` di `data/instance/storage.ts`): accenderlo chiede
 * l'archiviazione configurata e valida (`not_set_up`), spegnerlo no; niente
 * riconferma. La voce del registro è `storage.changed` col campo
 * `attachments`, come il prototipo. La usano la rotta e l'azione di Claude.
 */
export async function setAttachments(db: Db, encryptionKey: Buffer, actor: { id: string; email: string }, on: boolean): Promise<{ ok: true; was: boolean } | { ok: false; error: "not_set_up" }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).for("update");
    const was = row?.attachmentsSwitch ?? true;
    if (was === on) return { ok: true as const, was };
    if (on && !storageConfigured(row, encryptionKey)) return { ok: false as const, error: "not_set_up" as const };
    await tx.insert(instanceSettings).values({ id: 1, attachmentsSwitch: on }).onConflictDoUpdate({ target: instanceSettings.id, set: { attachmentsSwitch: on } });
    await recordChange(tx, { type: "storage.changed", actor, projectId: null, data: { object: { type: "storage", id: "storage", label: "storage" }, ...changedFields({ attachments: was }, { attachments: on })! } });
    return { ok: true as const, was };
  });
}

/** Il rifiuto di un caricamento con gli allegati spenti: 409, lo manda così l'error handler. */
export class AttachmentsOffError extends Error {
  readonly statusCode = 409;
  readonly code = "attachments_off";
  constructor() {
    super("Attachments are turned off for this instance");
  }
}

/**
 * Lo storage con gli allegati SPENTI: le scritture (caricare, copiare)
 * rifiutano con {@link AttachmentsOffError}; leggere ed eliminare restano
 * (il prototipo: «spenti» ferma i caricamenti nuovi, non ciò che c'è).
 */
export function uploadsOff(storage: ObjectStorage): ObjectStorage {
  const refuse = async (): Promise<never> => {
    throw new AttachmentsOffError();
  };
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "putObject" || prop === "putObjectStream" || prop === "copyObject") return refuse;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
