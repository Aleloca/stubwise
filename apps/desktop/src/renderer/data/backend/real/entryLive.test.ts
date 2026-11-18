import { beforeEach, describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dell'ingresso (area 9, R5): `entry.test.ts`
// usa un'API finta. Qui si guarda la richiesta.

const request = vi.fn(async () => ({}));
vi.mock("./client", () => ({
  appClient: () => ({ request }),
  session: { personId: null, partial: false, empty: false },
}));

beforeEach(() => request.mockClear());

describe("ingresso, i percorsi veri", () => {
  it("reset, primo avvio e nome stanno sotto /api/auth", async () => {
    const { liveEntryApiForTest: api } = await import("./entry");
    await api.resetLink("tok");
    await api.resetPassword("tok", "a-long-one");
    await api.setup("r@example.com", "a-long-one", "Roberta");
    await api.invite("inv");
    await api.register("inv", "a-long-one", "Nora");
    expect(request.mock.calls).toEqual([
      ["GET", "/api/auth/password-reset/tok"],
      ["POST", "/api/auth/password-reset/tok", { password: "a-long-one" }],
      [
        "POST",
        "/api/auth/setup",
        { email: "r@example.com", password: "a-long-one", displayName: "Roberta" },
      ],
      ["GET", "/api/auth/invites/inv"],
      ["POST", "/api/auth/register", { token: "inv", password: "a-long-one", displayName: "Nora" }],
    ]);
  });
});
