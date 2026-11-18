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

function fakeApi(over: Partial<StorageApi> = {}) {
  const saved: unknown[] = [];
  const api: StorageApi = {
    get: async () => settings(),
    save: async (input) => {
      saved.push(input);
      return settings();
    },
    ...over,
  };
  return { api, saved };
}

describe("l'archiviazione dal server (area 9, F3)", () => {
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

  it("salvare: la lingua di adesso (obbligatoria sul server), i campi, la chiave solo se nuova", async () => {
    const { api, saved } = fakeApi();
    const st = createRealStorage(api);
    const fields = { endpoint: "https://e", region: "r", bucket: "b", accessKeyId: "k" };
    expect(await st.saveStorage(fields)).toEqual({ ok: true });
    expect(await st.saveStorage({ ...fields, secretAccessKey: "sec" })).toEqual({ ok: true });
    expect(saved).toEqual([
      {
        contentLanguage: "it",
        s3Endpoint: "https://e",
        s3Region: "r",
        s3Bucket: "b",
        s3AccessKey: "k",
      },
      {
        contentLanguage: "it",
        s3Endpoint: "https://e",
        s3Region: "r",
        s3Bucket: "b",
        s3AccessKey: "k",
        s3SecretKey: "sec",
      },
    ]);
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
