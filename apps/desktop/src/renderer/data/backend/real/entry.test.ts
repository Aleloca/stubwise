import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealEntry, type EntryApi } from "./entry";

// Area 9, F1, R5: le pagine d'ingresso della web «app» sul server (il reset
// della password e il primo avvio). Il prototipo ha le sue firme.

const ME = "11111111-1111-4111-8111-111111111111";

function fakeApi(over: Partial<EntryApi> = {}) {
  const calls: string[] = [];
  const api: EntryApi = {
    resetLink: async () => ({ email: "marco@example.com", expiresAt: "2026-11-16T13:00:00.000Z" }),
    resetPassword: async (token, password) => {
      calls.push(`reset ${token} ${password}`);
    },
    stillSignedIn: async () => true,
    signedInBefore: () => false,
    setup: async (email, password) => {
      calls.push(`setup ${email} ${password}`);
      return { user: { id: ME } };
    },
    setDisplayName: async (name) => {
      calls.push(`name ${name}`);
    },
    entered: (id) => {
      calls.push(`entered ${id}`);
    },
    invite: async () => ({
      status: "valid",
      email: "nora@example.com",
      invitedByName: "Roberta Fontana",
      projects: [{ code: "ACQ", name: "Acquedotto", roleName: "Developer" }],
      instanceRoleName: null,
      expiresAt: "2026-11-23T09:00:00.000Z",
    }),
    register: async (token, password) => {
      calls.push(`register ${token} ${password}`);
      return { user: { id: ME } };
    },
    ...over,
  };
  return { api, calls };
}

const refusing = (status: number, code?: string) => async () => {
  throw new ApiError(status, code ?? "x", code);
};

describe("l'ingresso della web «app» dal server (area 9, R5)", () => {
  it("il link di reset: valido; il 410 unico del server è «spent» (una frase sola)", async () => {
    expect(await createRealEntry(fakeApi().api).getResetLink("t")).toEqual({ status: "valid" });
    const spent = createRealEntry(
      fakeApi({ resetLink: refusing(410, "password_reset_invalid") }).api,
    );
    expect(await spent.getResetLink("t")).toEqual({ status: "spent" });
  });

  it("la password nuova: il link usato una volta; chi era dentro con quell'account esce", async () => {
    const { api, calls } = fakeApi();
    expect(await createRealEntry(api).resetPassword("t", { password: "a-long-one" })).toEqual({
      ok: true,
      signedOutHere: false,
    });
    expect(calls).toEqual(["reset t a-long-one"]);
    const here = createRealEntry(
      fakeApi({ signedInBefore: () => true, stillSignedIn: async () => false }).api,
    );
    expect(await here.resetPassword("t", { password: "a-long-one" })).toEqual({
      ok: true,
      signedOutHere: true,
    });
    const spent = createRealEntry(
      fakeApi({ resetPassword: refusing(410, "password_reset_invalid") }).api,
    );
    expect(await spent.resetPassword("t", { password: "a-long-one" })).toEqual({
      ok: false,
      error: "spent",
    });
    const short = createRealEntry(fakeApi({ resetPassword: refusing(400) }).api);
    expect(await short.resetPassword("t", { password: "x" })).toEqual({
      ok: false,
      error: "invalid_input",
      reason: "password",
    });
  });

  it("il primo avvio: email e password al server, poi il nome; si è dentro come full admin", async () => {
    const { api, calls } = fakeApi();
    expect(
      await createRealEntry(api).createFirstAdmin({
        name: "Roberta Fontana",
        email: "roberta@example.com",
        password: "a-long-one",
      }),
    ).toEqual({ ok: true, personId: ME });
    expect(calls).toEqual([
      "setup roberta@example.com a-long-one",
      `entered ${ME}`,
      "name Roberta Fontana",
    ]);
    const full = createRealEntry(fakeApi({ setup: refusing(403, "setup_done") }).api);
    expect(
      await full.createFirstAdmin({ name: "R", email: "r@example.com", password: "a-long-one" }),
    ).toEqual({ ok: false, error: "not_empty" });
    const bad = createRealEntry(fakeApi({ setup: refusing(400) }).api);
    expect(
      await bad.createFirstAdmin({ name: "R", email: "r@example.com", password: "x" }),
    ).toEqual({ ok: false, error: "invalid_input", reason: "password" });
  });

  it("l'invito: i dettagli solo se valido; scaduto o non valido, solo lo stato", async () => {
    expect(await createRealEntry(fakeApi().api).getInvite("t")).toEqual({
      status: "valid",
      email: "nora@example.com",
      invitedByName: "Roberta Fontana",
      projects: [{ projectId: "ACQ", code: "ACQ", name: "Acquedotto", roleName: "Developer" }],
      instanceRoleName: null,
      expiresAt: "2026-11-23T09:00:00.000Z",
    });
    const expired = createRealEntry(fakeApi({ invite: async () => ({ status: "expired" }) }).api);
    expect(await expired.getInvite("t")).toEqual({ status: "expired" });
    const odd = createRealEntry(fakeApi({ invite: async () => ({ status: "__unknown__" }) }).api);
    expect(await odd.getInvite("t")).toEqual({ status: "invalid" });
  });

  it("la registrazione: token e password, poi il nome; gli errori nelle parole del prototipo", async () => {
    const { api, calls } = fakeApi();
    expect(
      await createRealEntry(api).register("t", { name: "Nora Bassi", password: "a-long-one" }),
    ).toEqual({ ok: true, personId: ME });
    expect(calls).toEqual(["register t a-long-one", `entered ${ME}`, "name Nora Bassi"]);
    const cases: [number, string, unknown][] = [
      [410, "invite_expired", { ok: false, error: "expired" }],
      [410, "invite_invalid", { ok: false, error: "invalid" }],
      [409, "email_already_exists", { ok: false, error: "invalid_input", reason: "email_taken" }],
      [400, "validation", { ok: false, error: "invalid_input", reason: "password" }],
    ];
    for (const [status, code, expected] of cases) {
      const e = createRealEntry(fakeApi({ register: refusing(status, code) }).api);
      expect(await e.register("t", { name: "N", password: "x" }), code).toEqual(expected);
    }
    expect(
      await createRealEntry(api).register("t", { name: "  ", password: "a-long-one" }),
    ).toEqual({ ok: false, error: "invalid_input", reason: "name" });
  });
});
