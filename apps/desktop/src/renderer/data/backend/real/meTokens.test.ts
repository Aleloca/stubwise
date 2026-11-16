import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealMeTokens, type MeTokensApi } from "./meTokens";

// Area 9, F1, R4c: Preferenze → Tokens e Claude Code sul server
// (`/api/pats`). Il prototipo ha le sue firme; qui si traducono.

const T1 = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-16T12:00:00.000Z";

function fakeApi(over: Partial<MeTokensApi> = {}) {
  const calls: string[] = [];
  const api: MeTokensApi = {
    list: async () => [
      {
        id: T1,
        name: "CI",
        createdAt: "2026-11-01T09:00:00.000Z",
        expiresAt: "2026-11-10T09:00:00.000Z",
        lastUsedAt: null,
      },
    ],
    create: async (name, expiresAt) => {
      calls.push(`create ${name} ${expiresAt}`);
      return { id: T1, name, createdAt: NOW, expiresAt, lastUsedAt: null, token: "stw_pat_secret" };
    },
    revoke: async (id) => {
      calls.push(`revoke ${id}`);
    },
    origin: async () => "https://stubwise.acme.test",
    now: () => NOW,
    ...over,
  };
  return { api, calls };
}

const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

describe("Preferenze → Tokens e Claude Code dal server (area 9, R4c)", () => {
  it("l'elenco: scaduto o no rispetto a adesso", async () => {
    expect(await createRealMeTokens(fakeApi().api).listTokens()).toEqual([
      {
        id: T1,
        name: "CI",
        createdAt: "2026-11-01T09:00:00.000Z",
        expiresAt: "2026-11-10T09:00:00.000Z",
        expired: true,
        lastUsedAt: null,
      },
    ]);
  });

  it("creare: il token una volta; revocare; la riconferma come rifiuto", async () => {
    const { api, calls } = fakeApi();
    const tokens = createRealMeTokens(api);
    expect(await tokens.createToken({ name: "CI", expiresAt: null })).toEqual({
      ok: true,
      tokenId: T1,
      token: "stw_pat_secret",
    });
    expect(await tokens.revokeToken(T1)).toEqual({ ok: true });
    expect(calls).toEqual(["create CI null", `revoke ${T1}`]);
    const reauth = createRealMeTokens(fakeApi({ create: refusing(403, "reauth_required") }).api);
    expect(await reauth.createToken({ name: "CI", expiresAt: null })).toEqual({
      ok: false,
      error: "reauth_required",
    });
    const bad = createRealMeTokens(fakeApi({ create: refusing(400, "validation") }).api);
    expect(await bad.createToken({ name: "", expiresAt: null })).toEqual({
      ok: false,
      error: "invalid",
      reason: "name",
    });
  });

  it("Claude Code: un token col nome del giorno e il comando con l'indirizzo vero dell'istanza", async () => {
    const { api, calls } = fakeApi();
    const r = await createRealMeTokens(api).createClaudeCodeCommand();
    if (!r.ok) throw new Error(r.error);
    expect(calls).toEqual(["create Claude Code · Nov 16 null"]);
    expect(r).toMatchObject({ tokenId: T1, tokenName: "Claude Code · Nov 16" });
    expect(r.command).toContain("--url https://stubwise.acme.test --token stw_pat_secret");
    expect(r.command.startsWith("claude plugin marketplace add Aleloca/stubwise")).toBe(true);
  });
});
