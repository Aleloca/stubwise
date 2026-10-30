import { forgetSecret, storeProvidedSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import { gate, notifyInstanceChange, now, state } from "../store";
import { forbidden, writer } from "../writer";
import { storageAllowsUploads, storageConfigured } from "./blocks";
import { canI, reauthRefusal, refuse } from "./common";
import type { StorageSettings, TestOutcome } from "./state";
import type { InstanceResult } from "./types";

// L'archiviazione d'istanza (area 9b, Task 4): il bucket compatibile S3 dei
// file del Drive e degli allegati. Si legge e si scrive con
// `settings.manage`. La chiave segreta va nel caveau: qui restano l'id e le
// ultime 4 cifre (RF 1); salvare CON una chiave nuova chiede la riconferma,
// senza no. Spegnere gli allegati blocca solo i caricamenti nuovi, i file
// già caricati restano (shape [IN 3]).
//
// `storageAllowsUploads` (in `blocks.ts`, la foglia che leggono Drive e
// composer) dice se si può caricare: configurata, allegati accesi e
// l'ultima prova non fallita. `getStorage` lo dice in una parola
// (`status`), la riga di stato in testa alla pagina.

export { storageAllowsUploads } from "./blocks";

const MANAGE = "settings.manage";
const OBJECT = { type: "storage", id: "storage", label: "storage" };

/** La riga di stato: caricamenti attivi, allegati spenti, ultima prova fallita, non configurata. */
export type StorageStatus = "on" | "attachments_off" | "check_failed" | "not_set_up";

export type StorageView = Omit<StorageSettings, "secretId"> & { status: StorageStatus };

function statusOf(s: StorageSettings): StorageStatus {
  if (!storageConfigured()) return "not_set_up";
  if (!s.attachmentsEnabled) return "attachments_off";
  return storageAllowsUploads() ? "on" : "check_failed";
}

/** La configurazione, senza la chiave segreta. */
export async function getStorage(): Promise<StorageView> {
  const me = await gate("instance.getStorage");
  if (!canI(me, MANAGE)) throw forbidden();
  const s = state.instance.storage;
  return {
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    last4: s.last4,
    attachmentsEnabled: s.attachmentsEnabled,
    lastTest: s.lastTest ? { ...s.lastTest } : null,
    status: statusOf(s),
  };
}

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "";
  } catch {
    return false;
  }
};

/**
 * Salva la configurazione. La chiave segreta è facoltativa se ce n'è già
 * una; con una chiave nuova serve la riconferma (+R), e la voce
 * `storage.secret_replaced` si aggiunge a `storage.changed`. Ogni cambio
 * rimette la prova a «non ancora verificata».
 */
export async function saveStorage(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
}): Promise<InstanceResult> {
  const me = await writer("instance.saveStorage");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const s = state.instance.storage;
  const endpoint = input.endpoint.trim();
  if (!isHttpUrl(endpoint)) return refuse.invalid("endpoint");
  const region = input.region.trim();
  if (!region) return refuse.invalid("region");
  const bucket = input.bucket.trim();
  if (!bucket) return refuse.invalid("bucket");
  const accessKeyId = input.accessKeyId.trim();
  if (!accessKeyId) return refuse.invalid("access_key_id");
  const secret = input.secretAccessKey?.trim();
  if (secret === "" || (secret === undefined && s.secretId === null))
    return refuse.invalid("secret_access_key");
  if (secret !== undefined) {
    const blocked = reauthRefusal(me, "instance.saveStorage");
    if (blocked) return blocked;
  }

  const diff = changedFields(
    { endpoint: s.endpoint, region: s.region, bucket: s.bucket, accessKeyId: s.accessKeyId },
    { endpoint, region, bucket, accessKeyId },
  );
  if (diff) {
    Object.assign(s, { endpoint, region, bucket, accessKeyId, lastTest: null });
    recordChange({
      kind: "storage.changed",
      actorId: me,
      projectId: null,
      object: OBJECT,
      ...diff,
    });
  }
  if (secret !== undefined) {
    if (s.secretId) forgetSecret(s.secretId);
    const stored = storeProvidedSecret("storage_secret", "storage", secret);
    s.secretId = stored.id;
    s.last4 = stored.last4;
    s.lastTest = null;
    recordChange({ kind: "storage.secret_replaced", actorId: me, projectId: null, object: OBJECT });
  }
  notifyInstanceChange();
  return { ok: true };
}

/** Accende o spegne gli allegati, subito e senza riconferma. Accenderli chiede un'archiviazione configurata. */
export async function setAttachments(on: boolean): Promise<InstanceResult> {
  const me = await writer("instance.setAttachments");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const s = state.instance.storage;
  if (s.attachmentsEnabled === on) return { ok: true };
  if (on && !storageConfigured()) return refuse.invalid("not_set_up");
  s.attachmentsEnabled = on;
  recordChange({
    kind: "storage.changed",
    actorId: me,
    projectId: null,
    object: OBJECT,
    ...changedFields({ attachments: !on }, { attachments: on })!,
  });
  notifyInstanceChange();
  return { ok: true };
}

/**
 * Verifica la connessione: l'esito scelto nel riquadro «Prototype only»
 * (`simulateNextTest("storage", …)`, vale una volta), altrimenti `ok`.
 * Nessuna voce: una prova non è una modifica.
 */
export async function testStorage(): Promise<InstanceResult<{ outcome: TestOutcome }>> {
  const me = await writer("instance.testStorage");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  if (!storageConfigured()) return refuse.invalid("not_set_up");
  const next = state.instance.simulate.nextTest;
  const outcome = next.storage ?? "ok";
  delete next.storage;
  state.instance.storage.lastTest = { at: now(), outcome };
  notifyInstanceChange();
  return { ok: true, outcome };
}
