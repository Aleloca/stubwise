import { beforeEach, describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Preferenze → Account (area 9, R4a): i
// test di `meAccount.test.ts` usano un'API finta, quindi un percorso
// sbagliato (404 sul server vero) passerebbe. Qui si guarda la richiesta.

const request = vi.fn(async () => undefined);
vi.mock("./client", () => ({ appClient: () => ({ request }) }));

beforeEach(() => request.mockClear());

describe("Account, i percorsi veri", () => {
  it("la password è POST /api/auth/me/password (prefisso /api/auth, auth.ts)", async () => {
    const { liveMeAccountApiForTest } = await import("./meAccount");
    await liveMeAccountApiForTest.changePassword("old", "a-long-one");
    expect(request).toHaveBeenCalledWith("POST", "/api/auth/me/password", {
      currentPassword: "old",
      newPassword: "a-long-one",
    });
  });

  it("il nome è PATCH /api/auth/me col displayName", async () => {
    const { liveMeAccountApiForTest } = await import("./meAccount");
    await liveMeAccountApiForTest.setDisplayName("Sara M.");
    expect(request).toHaveBeenCalledWith("PATCH", "/api/auth/me", { displayName: "Sara M." });
  });
});
