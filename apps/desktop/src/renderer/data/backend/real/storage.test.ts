import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealStorage, type StorageApi } from "./storage";

// Area 9, F3: Amministrazione → Storage su `/api/settings/instance` (72).

const settings = (over: Record<string, unknown> = {}) => ({
  contentLanguage: "it",
  monthlyBudgetUsd: 600,
  s3Endpoint: "https://s3.eu-south-1.amazonaws.com",
  s3Region: "eu-south-1",
  s3Bucket: "stubwise-files",
  s3AccessKey: "AKIAEXAMPLE",
  s3SecretKeySet: true,
  attachmentsEnabled: true,
  ...over,
});

/**
 * Il server finto fedele alla regola del PUT: una patch (72, F4), un campo
 * che manca resta com'era. Prima un budget che mancava si azzerava (review F3, C1).
 */
function fakeApi(over: Partial<StorageApi> = {}) {
  const saved: unknown[] = [];
  let current: Record<string, unknown> = settings();
  const api: StorageApi = {
    get: async () => current,
    save: async (input) => {
      saved.push(input);
      // Il PUT è una patch (72, F4): un campo che manca resta com'era.
      current = { ...current, ...input };
      return current;
    },
    ...over,
  };
  return { api, saved, now: () => current };
}

describe("l'archiviazione dal server (area 9, F3)", () => {
  // Rimandi, lotto 5, voce 6 (72, d68892e5d): le ultime 4 dal server; null
  // (segreto di prima, o sotto gli 8 caratteri) resta «••••» senza cifre.
  it("le ultime 4 della chiave segreta, quando il server le sa", async () => {
    const s = await createRealStorage(
      fakeApi({ get: async () => settings({ s3SecretKeyLast4: "9xQz" }) }).api,
    ).getStorage();
    expect(s.last4).toBe("9xQz");
    const old = await createRealStorage(
      fakeApi({ get: async () => settings({ s3SecretKeyLast4: null }) }).api,
    ).getStorage();
    expect(old.last4).toBe("");
  });

  it("la vista: i campi in chiaro, il segreto solo come «c'è», lo stato dagli allegati del server", async () => {
    const s = await createRealStorage(fakeApi().api).getStorage();
    expect(s).toMatchObject({
      endpoint: "https://s3.eu-south-1.amazonaws.com",
      region: "eu-south-1",
      bucket: "stubwise-files",
      accessKeyId: "AKIAEXAMPLE",
      last4: "",
      attachmentsEnabled: true,
      lastTest: null,
      status: "on",
    });
    const empty = await createRealStorage(
      fakeApi({
        get: async () =>
          settings({ s3Bucket: null, s3SecretKeySet: false, attachmentsEnabled: false }),
      }).api,
    ).getStorage();
    expect(empty).toMatchObject({ bucket: "", last4: null, status: "not_set_up" });
  });

  it("salvare: solo i campi dell'archiviazione (review F4, I3), la chiave solo se nuova; il budget resta", async () => {
    const { api, saved, now } = fakeApi();
    const st = createRealStorage(api);
    const fields = { endpoint: "https://e", region: "r", bucket: "b", accessKeyId: "k" };
    expect(await st.saveStorage(fields)).toEqual({ ok: true });
    expect(await st.saveStorage({ ...fields, secretAccessKey: "sec" })).toEqual({ ok: true });
    expect(saved).toEqual([
      {
        s3Endpoint: "https://e",
        s3Region: "r",
        s3Bucket: "b",
        s3AccessKey: "k",
      },
      {
        s3Endpoint: "https://e",
        s3Region: "r",
        s3Bucket: "b",
        s3AccessKey: "k",
        s3SecretKey: "sec",
      },
    ]);
    expect(now().monthlyBudgetUsd).toBe(600);
    const reauth = createRealStorage(
      fakeApi({
        save: async () => {
          throw new ApiError(403, "reauth_required", "reauth_required");
        },
      }).api,
    );
    expect(await reauth.saveStorage({ ...fields, secretAccessKey: "x" })).toEqual({
      ok: false,
      error: "reauth_required",
    });
  });
});
