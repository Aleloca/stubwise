import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealGitAccounts, type GitAccountsApi } from "./gitAccounts";

// Area 9, F3: Amministrazione → Git accounts su `/api/git-accounts` (72).

const A = "70000000-0000-4000-8000-000000000001";
const acc = (over: Record<string, unknown> = {}) => ({
  id: A,
  name: "Bitbucket Audin",
  provider: "bitbucket",
  workspace: "audin",
  isDefaultReviewer: false,
  createdAt: "2026-11-01T09:00:00.000Z",
  ...over,
});
const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

function fakeApi(over: Partial<GitAccountsApi> = {}) {
  const calls: string[] = [];
  const api: GitAccountsApi = {
    list: async () => [acc()],
    create: async (input) => {
      calls.push(`create ${JSON.stringify(input)}`);
      return acc({ id: "70000000-0000-4000-8000-000000000002" });
    },
    update: async (id, patch) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`);
      return acc();
    },
    validate: async () => ({ ok: true, checks: [] }),
    setDefaultReviewer: async (id) => {
      calls.push(`reviewer on ${id}`);
      return {
        account: acc({ isDefaultReviewer: true }),
        replaced: { id: "x", name: "Old" },
        warnings: [],
      };
    },
    unsetDefaultReviewer: async (id) => {
      calls.push(`reviewer off ${id}`);
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("gli account git dal server (area 9, F3)", () => {
  // Rimandi, lotto 5, voce 6 (72, d68892e5d): le ultime 4 dal server; null
  // (segreto di prima, o sotto gli 8 caratteri) resta «••••» senza cifre.
  it("le ultime 4 del token, quando il server le sa", async () => {
    const [a] = await createRealGitAccounts(
      fakeApi({ list: async () => [acc({ tokenLast4: "Ab12" })] }).api,
    ).listGitAccounts();
    expect(a!.last4).toBe("Ab12");
  });

  it("l'elenco nella forma del prototipo; la validazione la ricorda la sessione", async () => {
    const g = createRealGitAccounts(fakeApi().api);
    const [a] = await g.listGitAccounts();
    expect(a).toMatchObject({
      id: A,
      name: "Bitbucket Audin",
      provider: "bitbucket",
      workspace: "audin",
      defaultReviewer: false,
      last4: "",
      lastValidation: null,
      repositories: [],
      hiddenRepositories: 0,
      replacesAsReviewer: null,
    });
    expect(await g.validateGitAccount(A)).toEqual({ ok: true, outcome: "ok" });
    expect((await g.listGitAccounts())[0]!.lastValidation?.outcome).toBe("ok");
    const bad = createRealGitAccounts(
      fakeApi({
        validate: async () => ({
          ok: false,
          checks: [{ name: "token", ok: false, detail: "401" }],
        }),
      }).api,
    );
    expect(await bad.validateGitAccount(A)).toEqual({ ok: true, outcome: "invalid_credentials" });
  });

  it("le scritture: crea col token nelle credenziali, cambia, sostituisce il token, revisore, elimina", async () => {
    const { api, calls } = fakeApi();
    const g = createRealGitAccounts(api);
    expect(
      await g.createGitAccount({
        name: " GH ",
        provider: "github",
        workspace: null,
        token: "ghp_x",
      }),
    ).toEqual({ ok: true, accountId: "70000000-0000-4000-8000-000000000002" });
    expect(await g.updateGitAccount(A, { workspace: "audin-srl" })).toEqual({ ok: true });
    expect(await g.replaceGitToken(A, "bb-new")).toEqual({ ok: true });
    expect(await g.setDefaultReviewer(A, true)).toEqual({ ok: true, replaced: "Old" });
    expect(await g.setDefaultReviewer(A, false)).toEqual({ ok: true, replaced: null });
    expect(await g.deleteGitAccount(A)).toEqual({ ok: true });
    expect(calls).toEqual([
      'create {"name":"GH","provider":"github","credentials":{"token":"ghp_x"}}',
      `update ${A} {"workspace":"audin-srl"}`,
      `update ${A} {"credentials":{"token":"bb-new"}}`,
      `reviewer on ${A}`,
      `reviewer off ${A}`,
      `remove ${A}`,
    ]);
  });

  it("in uso (senza l'elenco dei repository, il server non lo dà) e la riconferma", async () => {
    const inUse = createRealGitAccounts(
      fakeApi({ remove: refusing(409, "git_account_in_use") }).api,
    );
    expect(await inUse.deleteGitAccount(A)).toEqual({
      ok: false,
      error: "in_use",
      usedBy: [],
      hiddenCount: 0,
    });
    const reauth = createRealGitAccounts(fakeApi({ update: refusing(403, "reauth_required") }).api);
    expect(await reauth.replaceGitToken(A, "x")).toEqual({ ok: false, error: "reauth_required" });
  });
});
