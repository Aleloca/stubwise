import { ApiError } from "@stubwise/api-client";
import type { StorageView } from "../../instance/storage";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → Storage nella build app (area 9, F3) su
// `/api/settings/instance` (72), lo stesso PUT di lingua e budget, che è una
// patch (F4): si mandano solo i campi dell'archiviazione.
// La chiave S3 si manda solo se è nuova, e allora il server chiede la
// riconferma. Il segreto non torna mai: la vista dice solo se c'è.
//
// Differenze dichiarate (parità): il server non ha la prova
// dell'archiviazione né l'interruttore degli allegati (li deriva dalla
// configurazione), quindi la pagina nell'app non li mostra; niente ultime 4
// della chiave («••••»).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.instanceSettings`). */
export interface StorageApi {
  get(): Promise<Any>;
  save(input: Record<string, unknown>): Promise<Any>;
}

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    const m = /s3(Endpoint|Region|Bucket|AccessKey|SecretKey)/.exec(error.message)?.[1];
    const reason =
      m === "AccessKey"
        ? "access_key_id"
        : m === "SecretKey"
          ? "secret_access_key"
          : (m?.toLowerCase() ?? "endpoint");
    return { ok: false, error: "invalid", reason };
  }
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

export function createRealStorage(api: StorageApi) {
  return {
    async getStorage(): Promise<StorageView> {
      const s = await api.get();
      const configured = !!(s.s3Endpoint && s.s3Bucket && s.s3AccessKey && s.s3SecretKeySet);
      return {
        endpoint: s.s3Endpoint ?? "",
        region: s.s3Region ?? "",
        bucket: s.s3Bucket ?? "",
        accessKeyId: s.s3AccessKey ?? "",
        // C'è una chiave, o non c'è. Le ultime 4 le dà il server (rimandi,
        // lotto 5, voce 6); una chiave di prima ne è senza: «••••».
        last4: s.s3SecretKeySet ? (s.s3SecretKeyLast4 ?? "") : null,
        attachmentsEnabled: !!s.attachmentsEnabled,
        lastTest: null,
        status: !configured ? "not_set_up" : s.attachmentsEnabled ? "on" : "attachments_off",
      };
    },

    async saveStorage(input: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey?: string;
    }): Promise<InstanceResult> {
      try {
        // Il PUT è una patch (72, F4): solo i campi dell'archiviazione; lingua
        // e budget restano com'erano (review F4, I3; prima review F3, C1).
        await api.save({
          s3Endpoint: input.endpoint.trim(),
          s3Region: input.region.trim(),
          s3Bucket: input.bucket.trim(),
          s3AccessKey: input.accessKeyId.trim(),
          ...(input.secretAccessKey ? { s3SecretKey: input.secretAccessKey } : {}),
        });
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: StorageApi = {
  get: () => appClient().instanceSettings.get(),
  save: (input) => appClient().instanceSettings.save(input as Any),
};

/** SOLO TEST: le rotte vere. */
export const liveStorageApiForTest = liveApi;

export const liveStorage = createRealStorage(liveApi);
