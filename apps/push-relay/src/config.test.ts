import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { loadRelayConfig } from "./config.js";

/** Una chiave EC P-256 vera: le `.p8` di Apple sono esattamente questo. */
function p8Base64(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return Buffer.from(pem, "utf8").toString("base64");
}

function serviceAccountBase64(overrides: Record<string, unknown> = {}): string {
  const json = JSON.stringify({
    type: "service_account",
    project_id: "stubwise-push",
    client_email: "relay@stubwise-push.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    ...overrides,
  });
  return Buffer.from(json, "utf8").toString("base64");
}

function baseEnv(): Record<string, string | undefined> {
  return { FCM_SERVICE_ACCOUNT_JSON: serviceAccountBase64() };
}

describe("loadRelayConfig", () => {
  it("con la sola chiave FCM parte: in v1 iOS passa da FCM e le APNS_* non servono", () => {
    const config = loadRelayConfig(baseEnv());
    expect(config.iosPushVia).toBe("fcm");
    expect(config.apns).toBeNull();
    expect(config.fcm.projectId).toBe("stubwise-push");
    expect(config.port).toBe(8090);
    expect(config.rate).toEqual({ perTokenHour: 60, perTokenDay: 500, perIpMinute: 600 });
  });

  it("senza FCM_SERVICE_ACCOUNT_JSON lancia: è l'unico canale attivo", () => {
    expect(() => loadRelayConfig({})).toThrow(/FCM_SERVICE_ACCOUNT_JSON/);
  });

  it("base64 non valido lancia", () => {
    expect(() => loadRelayConfig({ FCM_SERVICE_ACCOUNT_JSON: "non-è-base64!!" })).toThrow(
      /FCM_SERVICE_ACCOUNT_JSON/,
    );
  });

  it("base64 valido che non è JSON lancia", () => {
    expect(() =>
      loadRelayConfig({ FCM_SERVICE_ACCOUNT_JSON: Buffer.from("ciao").toString("base64") }),
    ).toThrow(/FCM_SERVICE_ACCOUNT_JSON/);
  });

  it("un service account senza project_id lancia", () => {
    expect(() =>
      loadRelayConfig({
        FCM_SERVICE_ACCOUNT_JSON: serviceAccountBase64({ project_id: undefined }),
      }),
    ).toThrow(/project_id/);
  });

  /**
   * ⚠️ Il messaggio d'errore finisce nel log d'avvio: NOMINA la variabile, non
   * ne ripete mai il valore. `private_key` di un service account è la chiave
   * con cui si mandano push a nome di Stubwise a OGNI telefono.
   */
  it("nessun errore di config ripete il contenuto del segreto", () => {
    const secret = "SEGRETISSIMO-private-key-material";
    const cases: Array<Record<string, string | undefined>> = [
      { FCM_SERVICE_ACCOUNT_JSON: Buffer.from(secret).toString("base64") },
      { FCM_SERVICE_ACCOUNT_JSON: serviceAccountBase64({ project_id: undefined, extra: secret }) },
      { ...baseEnv(), IOS_PUSH_VIA: "apns", APNS_KEY_P8: Buffer.from(secret).toString("base64") },
    ];
    for (const env of cases) {
      expect(() => loadRelayConfig(env)).toThrow();
      try {
        loadRelayConfig(env);
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  describe("IOS_PUSH_VIA", () => {
    it("con `apns` pretende TUTTE le APNS_*: l'errore è al boot, non alla prima consegna", () => {
      expect(() => loadRelayConfig({ ...baseEnv(), IOS_PUSH_VIA: "apns" })).toThrow(/APNS_/);
    });

    it("con `apns` e le chiavi complete configura il client APNs", () => {
      const config = loadRelayConfig({
        ...baseEnv(),
        IOS_PUSH_VIA: "apns",
        APNS_KEY_P8: p8Base64(),
        APNS_KEY_ID: "ABC1234567",
        APNS_TEAM_ID: "TEAM123456",
        APNS_BUNDLE_ID: "com.app.aleloca.stubwise",
      });
      expect(config.iosPushVia).toBe("apns");
      expect(config.apns?.keyId).toBe("ABC1234567");
      expect(config.apns?.bundleId).toBe("com.app.aleloca.stubwise");
      expect(config.apns?.sandbox).toBe(false);
    });

    it("un valore diverso da fcm/apns lancia invece di ricadere su un default", () => {
      expect(() => loadRelayConfig({ ...baseEnv(), IOS_PUSH_VIA: "APNS" })).toThrow(/IOS_PUSH_VIA/);
    });
  });

  describe("APNS_SANDBOX", () => {
    function apnsEnv(sandbox: string | undefined): Record<string, string | undefined> {
      return {
        ...baseEnv(),
        IOS_PUSH_VIA: "apns",
        APNS_KEY_P8: p8Base64(),
        APNS_KEY_ID: "ABC1234567",
        APNS_TEAM_ID: "TEAM123456",
        APNS_BUNDLE_ID: "com.app.aleloca.stubwise",
        APNS_SANDBOX: sandbox,
      };
    }

    it("`true` accende il sandbox, `false` no", () => {
      expect(loadRelayConfig(apnsEnv("true")).apns?.sandbox).toBe(true);
      expect(loadRelayConfig(apnsEnv("false")).apns?.sandbox).toBe(false);
    });

    /**
     * ⚠️ Nessuna truthiness: `APNS_SANDBOX=1` letto come "falso" (o `0` come
     * "vero") manda ogni push all'ambiente sbagliato, e APNs risponde
     * `BadDeviceToken` — lo STESSO codice di un token inventato. Meglio un
     * relay che non parte di uno che parla con l'ambiente sbagliato.
     */
    it.each(["1", "0", "yes", "TRUE", "", " true"])(
      "il valore %o non è né true né false: lancia",
      (value) => {
        expect(() => loadRelayConfig(apnsEnv(value))).toThrow(/APNS_SANDBOX/);
      },
    );
  });

  describe("tetti numerici", () => {
    it("valori espliciti sostituiscono i default", () => {
      const config = loadRelayConfig({
        ...baseEnv(),
        PORT: "9000",
        RELAY_RATE_PER_TOKEN_HOUR: "10",
        RELAY_RATE_PER_TOKEN_DAY: "20",
        RELAY_RATE_PER_IP_MINUTE: "30",
      });
      expect(config.port).toBe(9000);
      expect(config.rate).toEqual({ perTokenHour: 10, perTokenDay: 20, perIpMinute: 30 });
    });

    it.each(["zero", "-1", "0", "1.5"])("il tetto %o non è un intero positivo: lancia", (value) => {
      expect(() => loadRelayConfig({ ...baseEnv(), RELAY_RATE_PER_TOKEN_HOUR: value })).toThrow(
        /RELAY_RATE_PER_TOKEN_HOUR/,
      );
    });
  });
});
