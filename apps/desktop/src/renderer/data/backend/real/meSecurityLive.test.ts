import { beforeEach, describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Preferenze → Security (area 9, R4b):
// `meSecurity.test.ts` usa un'API finta, quindi un percorso sbagliato (404
// sul server vero) passerebbe. Qui si guarda la richiesta.

const request = vi.fn(async () => ({}));
const me = { sessions: vi.fn(async () => []), endSession: vi.fn(async () => undefined) };
vi.mock("./client", () => ({ appClient: () => ({ request, me }) }));

beforeEach(() => request.mockClear());

describe("Security, i percorsi veri", () => {
  it("lo stato, l'app di autenticazione, i codici e le passkey stanno sotto /api/me/security", async () => {
    const { liveMeSecurityApiForTest: api } = await import("./meSecurity");
    await api.security();
    await api.totpSetup();
    await api.totpConfirm("123456");
    await api.backupCodes();
    await api.renamePasskey("pk-1", "Work Mac");
    await api.removePasskey("pk-1");
    await api.passkeyOptions();
    await api.registerPasskey("Work Mac", { id: "cred" });
    expect(request.mock.calls).toEqual([
      ["GET", "/api/me/security"],
      ["POST", "/api/me/security/totp/setup"],
      ["POST", "/api/me/security/totp/setup/confirm", { code: "123456" }],
      ["POST", "/api/me/security/backup-codes"],
      ["PATCH", "/api/me/security/passkeys/pk-1", { name: "Work Mac" }],
      ["DELETE", "/api/me/security/passkeys/pk-1"],
      ["POST", "/api/me/security/passkeys/options"],
      ["POST", "/api/me/security/passkeys", { name: "Work Mac", response: { id: "cred" } }],
    ]);
  });

  it("le sessioni passano dal client (client.me)", async () => {
    const { liveMeSecurityApiForTest: api } = await import("./meSecurity");
    await api.sessions();
    await api.endSession("s1");
    expect(me.sessions).toHaveBeenCalled();
    expect(me.endSession).toHaveBeenCalledWith("s1");
  });
});
