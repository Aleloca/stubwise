import { beforeEach, describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Tokens (area 9, R4c): `meTokens.test.ts`
// usa un'API finta. Qui si guarda la richiesta.

const request = vi.fn(async () => ({}));
const pats = { revoke: vi.fn(async () => undefined) };
vi.mock("./client", () => ({ appClient: () => ({ request, pats }) }));

beforeEach(() => request.mockClear());

describe("Tokens, i percorsi veri", () => {
  it("elenco e creazione su /api/pats; la revoca dal client", async () => {
    const { liveMeTokensApiForTest: api } = await import("./meTokens");
    await api.list();
    await api.create("CI", null);
    await api.revoke("t1");
    expect(request.mock.calls).toEqual([
      ["GET", "/api/pats"],
      ["POST", "/api/pats", { name: "CI", expiresAt: null }],
    ]);
    expect(pats.revoke).toHaveBeenCalledWith("t1");
  });
});
