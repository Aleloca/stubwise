import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { SECOND_FACTOR_MAX_FAILURES } from "../../auth/constants";
import { createRealMeSecurity, eventKindOf, type MeSecurityApi } from "./meSecurity";

// Area 9, F1, R4b: Preferenze → Security sul server (`/api/me/security`,
// `client.me.sessions`). Il prototipo ha le sue firme; qui si traducono.

const PK = "22222222-2222-4222-8222-222222222222";
const EV = "33333333-3333-4333-8333-333333333333";

function fakeApi(over: Partial<MeSecurityApi> = {}) {
  const calls: string[] = [];
  const api: MeSecurityApi = {
    security: async () => ({
      totp: { configured: true, confirmedAt: "2026-11-01T09:00:00.000Z" },
      passkeys: [
        { id: PK, name: "MacBook", createdAt: "2026-11-02T09:00:00.000Z", lastUsedAt: null },
      ],
      backupCodesRemaining: 7,
      events: [
        {
          id: EV,
          kind: "login",
          actorEmail: null,
          detail: null,
          createdAt: "2026-11-16T09:00:00.000Z",
        },
        {
          id: EV,
          kind: "second_factor_reset",
          actorEmail: "roberta@example.com",
          detail: null,
          createdAt: "2026-11-15T09:00:00.000Z",
        },
      ],
      reauthUntil: null,
      attemptsLeft: 3,
    }),
    sessions: async () => [
      {
        id: "s1",
        kind: "browser",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120",
        label: null,
        createdAt: "2026-11-10T09:00:00.000Z",
        lastSeenAt: "2026-11-16T10:00:00.000Z",
        current: false,
      },
      {
        id: "s2",
        kind: "desktop",
        userAgent: null,
        label: "MacBook Pro",
        createdAt: "2026-11-01T09:00:00.000Z",
        lastSeenAt: "2026-11-16T11:00:00.000Z",
        current: true,
      },
    ],
    endSession: async (id) => {
      calls.push(`end ${id}`);
    },
    totpSetup: async () => ({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUrl: "otpauth://totp/Stubwise:sara?secret=JBSWY3DPEHPK3PXP",
    }),
    totpConfirm: async (code) => {
      calls.push(`confirm ${code}`);
      return { backupCodes: null };
    },
    backupCodes: async () => ({ codes: ["aaaaa-bbbbb"] }),
    renamePasskey: async (id, name) => {
      calls.push(`rename ${id} ${name}`);
    },
    removePasskey: async (id) => {
      calls.push(`remove ${id}`);
    },
    passkeyOptions: async () => ({}),
    createCredential: async () => ({}),
    registerPasskey: async () => ({ id: PK }),
    ...over,
  };
  return { api, calls };
}

const refusing = (status: number, code: string, details?: unknown) => async () => {
  throw new ApiError(status, code, code, { details });
};

describe("Preferenze → Security dal server (area 9, R4b)", () => {
  it("lo stato: TOTP e da quando, passkey, codici, sessioni (la corrente prima) e il registro coi tipi del prototipo", async () => {
    const s = await createRealMeSecurity(fakeApi().api, { desktop: () => false }).getMySecurity();
    expect(s).toMatchObject({
      on: true,
      totp: true,
      totpSince: "2026-11-01T09:00:00.000Z",
      backupCodesLeft: 7,
      backupCodesTotal: 10,
    });
    expect(s.passkeys).toEqual([
      {
        id: PK,
        name: "MacBook",
        addedAt: "2026-11-02T09:00:00.000Z",
        lastUsedAt: null,
        removable: true,
      },
    ]);
    expect(s.sessions.map((x) => [x.id, x.device.kind, x.current])).toEqual([
      ["s2", "desktop", true],
      ["s1", "browser", false],
    ]);
    expect(s.sessions[0]!.device.detail).toBe("MacBook Pro");
    expect(s.sessions[1]!.device.detail).toBe("Chrome on Windows");
    expect(s.sessions[1]!.lastUsedAt).toBe("2026-11-16T10:00:00.000Z");
    expect(s.events.map((e) => [e.kind, e.byName])).toEqual([
      ["signed_in", null],
      ["second_factor_reset", "roberta@example.com"],
    ]);
  });

  it("sul desktop le passkey non ci sono (vivono nel browser)", async () => {
    const s = await createRealMeSecurity(fakeApi().api, { desktop: () => true }).getMySecurity();
    expect(s.passkeys).toEqual([]);
  });

  it("i tipi del registro: quelli del server diventano quelli del prototipo; uno ignoto è «other»", () => {
    expect(eventKindOf("login")).toBe("signed_in");
    expect(eventKindOf("enrolled")).toBe("second_factor_enabled");
    expect(eventKindOf("totp_reconfigured")).toBe("authenticator_changed");
    expect(eventKindOf("locked")).toBe("second_factor_locked");
    expect(eventKindOf("password_reset_link")).toBe("password_reset_link_created");
    expect(eventKindOf("email_changed")).toBe("email_changed");
    expect(eventKindOf("vault_activated")).toBe("vault_activated");
    expect(eventKindOf("__unknown__")).toBe("other");
  });

  it("chiudere una sessione; la corrente è «current» come nel prototipo", async () => {
    const { api, calls } = fakeApi();
    expect(await createRealMeSecurity(api, { desktop: () => false }).endSession("s1")).toEqual({
      ok: true,
    });
    expect(calls).toEqual(["end s1"]);
    const current = createRealMeSecurity(
      fakeApi({ endSession: refusing(409, "current_session") }).api,
      { desktop: () => false },
    );
    expect(await current.endSession("s2")).toEqual({
      ok: false,
      error: "invalid",
      reason: "current",
    });
  });

  it("l'app di autenticazione: la chiave e il QR vero; la conferma; un codice sbagliato rilegge i tentativi rimasti", async () => {
    const { api, calls } = fakeApi();
    const sec = createRealMeSecurity(api, { desktop: () => false });
    const setup = await sec.startTotpSetup();
    if (!setup.ok) throw new Error(setup.error);
    expect(setup.setup.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(setup.setup.qrSvg).toContain("<svg");
    expect(await sec.confirmTotp("123456")).toEqual({ ok: true, backupCodes: null });
    expect(calls).toContain("confirm 123456");
    const wrong = createRealMeSecurity(
      fakeApi({ totpConfirm: refusing(401, "invalid_second_factor") }).api,
      { desktop: () => false },
    );
    expect(await wrong.confirmTotp("000000")).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: 3,
    });
    // Un server di prima non manda i tentativi: la frase senza contatore.
    const old = createRealMeSecurity(
      fakeApi({
        totpConfirm: refusing(401, "invalid_second_factor"),
        security: async () => ({ ...(await fakeApi().api.security()), attemptsLeft: null }),
      }).api,
      { desktop: () => false },
    );
    expect(await old.confirmTotp("000000")).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: SECOND_FACTOR_MAX_FAILURES - 1,
    });
    const locked = createRealMeSecurity(
      fakeApi({
        totpConfirm: refusing(423, "second_factor_locked", {
          lockedUntil: "2026-11-16T12:00:00.000Z",
        }),
      }).api,
      { desktop: () => false },
    );
    expect(await locked.confirmTotp("000000")).toEqual({
      ok: false,
      error: "locked",
      lockedUntil: "2026-11-16T12:00:00.000Z",
    });
  });

  it("codici nuovi e passkey (rinomina, rimuovi) con la riconferma dove il server la chiede", async () => {
    const { api, calls } = fakeApi();
    const sec = createRealMeSecurity(api, { desktop: () => false });
    expect(await sec.regenerateBackupCodes()).toEqual({ ok: true, codes: ["aaaaa-bbbbb"] });
    expect(await sec.renamePasskey(PK, "Work Mac")).toEqual({ ok: true });
    expect(await sec.removePasskey(PK)).toEqual({ ok: true });
    expect(calls).toEqual([`rename ${PK} Work Mac`, `remove ${PK}`]);
    const reauth = createRealMeSecurity(
      fakeApi({ backupCodes: refusing(403, "reauth_required") }).api,
      { desktop: () => false },
    );
    expect(await reauth.regenerateBackupCodes()).toEqual({ ok: false, error: "reauth_required" });
    const gone = createRealMeSecurity(
      fakeApi({ removePasskey: refusing(404, "passkey_not_found") }).api,
      { desktop: () => false },
    );
    expect(await gone.removePasskey(PK)).toEqual({ ok: false, error: "not_found" });
  });

  it("aggiungere una passkey nel browser: opzioni, la cerimonia del browser, la registrazione col nome", async () => {
    const calls: string[] = [];
    const { api } = fakeApi({
      passkeyOptions: async () => {
        calls.push("options");
        return { challenge: "c" };
      },
      createCredential: async (options) => {
        calls.push(`create ${JSON.stringify(options)}`);
        return { id: "cred" };
      },
      registerPasskey: async (name, response) => {
        calls.push(`register ${name} ${JSON.stringify(response)}`);
        return { id: PK };
      },
    });
    expect(
      await createRealMeSecurity(api, { desktop: () => false }).addPasskey("Work Mac"),
    ).toEqual({
      ok: true,
      passkeyId: PK,
    });
    expect(calls).toEqual([
      "options",
      'create {"challenge":"c"}',
      'register Work Mac {"id":"cred"}',
    ]);
    // Il browser rifiuta (annullata, nessun autenticatore): «passkey_failed».
    const cancelled = createRealMeSecurity(
      fakeApi({
        passkeyOptions: async () => ({}),
        createCredential: async () => {
          throw new DOMException("cancelled", "NotAllowedError");
        },
      }).api,
      { desktop: () => false },
    );
    expect(await cancelled.addPasskey("Work Mac")).toEqual({
      ok: false,
      error: "invalid",
      reason: "passkey_failed",
    });
    // La riconferma la chiede il server alle opzioni: torna come reauth_required.
    const reauth = createRealMeSecurity(
      fakeApi({ passkeyOptions: refusing(403, "reauth_required") }).api,
      { desktop: () => false },
    );
    expect(await reauth.addPasskey("Work Mac")).toEqual({ ok: false, error: "reauth_required" });
  });

  it("sul desktop aggiungere una passkey non si può: è del browser", async () => {
    const { api } = fakeApi();
    expect(await createRealMeSecurity(api, { desktop: () => true }).addPasskey("Work Mac")).toEqual(
      {
        ok: false,
        error: "invalid",
        reason: "browser_only",
      },
    );
  });
});
