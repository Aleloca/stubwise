import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { auth } from "./session";

const startAuthentication = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));

const user = { id: ME_ID, email: "ada@example.com", role: "member" };

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  startAuthentication.mockReset();
  setAppClientForTests(null);
});

describe("login web (cookie)", () => {
  it("password giusta: login a metà, il cancello dice secondo fattore", async () => {
    const { seen } = installFakeServer({
      "POST /api/auth/login": { body: { user, stage: "second_factor" } },
    });
    expect(await auth.login({ email: "ada@example.com", password: "pw" })).toEqual({
      ok: true,
      stage: "second_factor",
    });
    expect(auth.readEntry().stage).toBe("second_factor");
    expect(seen[0]).toMatchObject({ credentials: "include", body: { email: "ada@example.com", password: "pw" } });
  });

  it("password sbagliata: la frase unica, nessun login a metà", async () => {
    installFakeServer({ "POST /api/auth/login": { status: 401, body: { code: "invalid_credentials" } } });
    expect(await auth.login({ email: "x@example.com", password: "no" })).toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(auth.readEntry().stage).toBe("out");
  });

  it("il codice giusto porta dentro", async () => {
    installFakeServer({
      "POST /api/auth/second-factor/verify": { body: { user, backupCodesRemaining: 8 } },
    });
    session.partial = true;
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toEqual({
      ok: true,
      stage: "in",
      personId: ME_ID,
    });
    expect(auth.readEntry().stage).toBe("in");
  });

  it("codice sbagliato, blocco e login scaduto nella forma del prototipo", async () => {
    installFakeServer({
      "POST /api/auth/second-factor/verify": ({ body }) =>
        (body as { code: string }).code === "000000"
          ? { status: 401, body: { code: "invalid_second_factor", message: "x" } }
          : (body as { code: string }).code === "111111"
            ? { status: 423, body: { code: "second_factor_locked", message: "x", lockedUntil: "2026-11-09T11:00:00.000Z" } }
            : { status: 401, body: { code: "unauthorized", message: "x" } },
    });
    expect(await auth.loginSecondFactor({ method: "totp", code: "000000" })).toMatchObject({
      ok: false,
      error: "invalid_code",
    });
    expect(await auth.loginSecondFactor({ method: "backup_code", code: "111111" })).toEqual({
      ok: false,
      error: "locked",
      lockedUntil: "2026-11-09T11:00:00.000Z",
    });
    expect(await auth.loginSecondFactor({ method: "totp", code: "222222" })).toEqual({
      ok: false,
      error: "login_expired",
    });
  });

  it("la passkey passa dalla cerimonia del browser con le opzioni del server", async () => {
    const options = { challenge: "abc", allowCredentials: [{ id: "cred", type: "public-key" }] };
    const assertion = {
      id: "cred",
      rawId: "cred",
      type: "public-key",
      response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
    };
    startAuthentication.mockResolvedValue(assertion);
    const { seen } = installFakeServer({
      "POST /api/auth/second-factor/passkey/options": { body: options },
      "POST /api/auth/second-factor/passkey/verify": { body: { user, backupCodesRemaining: 10 } },
    });
    expect(await auth.loginSecondFactor({ method: "passkey" })).toMatchObject({ ok: true, personId: ME_ID });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(seen.at(-1)).toMatchObject({ body: { response: assertion } });
  });

  it("una passkey annullata dal browser non arriva al server", async () => {
    startAuthentication.mockRejectedValue(new Error("NotAllowedError"));
    const { seen } = installFakeServer({
      "POST /api/auth/second-factor/passkey/options": { body: { challenge: "abc" } },
    });
    expect(await auth.loginSecondFactor({ method: "passkey" })).toMatchObject({ ok: false, error: "invalid_code" });
    expect(seen.map((r) => r.path)).toEqual(["/api/auth/second-factor/passkey/options"]);
  });

  it("configurazione al login: lo stadio, il segreto, il primo codice e i codici di riserva", async () => {
    installFakeServer({
      "GET /api/auth/second-factor": {
        body: { stage: "enrollment", passkeys: false, backupCodesRemaining: 0, lockedUntil: null },
      },
      "POST /api/auth/second-factor/enroll": {
        body: { secret: "JBSWY3DP", otpauthUrl: "otpauth://totp/Stubwise:ada?secret=JBSWY3DP" },
      },
      "POST /api/auth/second-factor/enroll/confirm": { body: { user, backupCodes: ["a1", "b2"] } },
    });
    expect(await auth.loginStage()).toBe("enrollment");
    expect(await auth.startLoginEnrollment()).toEqual({
      secret: "JBSWY3DP",
      otpauthUrl: "otpauth://totp/Stubwise:ada?secret=JBSWY3DP",
    });
    expect(await auth.confirmLoginEnrollment("123456")).toEqual({
      ok: true,
      personId: ME_ID,
      backupCodes: ["a1", "b2"],
    });
    expect(auth.readEntry().stage).toBe("in");
  });

  it("sul desktop il modulo di password non esiste (il login passa dal browser)", async () => {
    window.stubwise = { platform: "darwin", api: { request: vi.fn() } };
    try {
      await expect(auth.login({ email: "a@b.c", password: "x" })).rejects.toThrow(/desktop/);
    } finally {
      delete window.stubwise;
    }
  });
});
