import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealMeAccount, type MeAccountApi } from "./meAccount";

// Area 9, F1, R4a: Preferenze → Account sul server (Task 7, 8 e 11 di 72).
// Il prototipo ha le sue firme; qui si traducono rotte ed errori.

const ME = "11111111-1111-4111-8111-111111111111";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function fakeApi(over: Partial<MeAccountApi> = {}) {
  const calls: string[] = [];
  const api: MeAccountApi = {
    me: async () => ({
      user: {
        id: ME,
        email: "sara@example.com",
        displayName: "Sara Montanari",
        avatarUrl: null,
      },
    }),
    setDisplayName: async (name) => {
      calls.push(`name ${name}`);
    },
    putAvatar: async (bytes) => {
      calls.push(`avatar ${bytes.byteLength}`);
    },
    deleteAvatar: async () => {
      calls.push("avatar delete");
    },
    avatarDataUrl: async (url) => `data:image/png;base64,from:${url}`,
    emailChange: async () => ({ available: true, pending: null }),
    startEmailChange: async (email) => {
      calls.push(`start ${email}`);
      return {
        available: true,
        pending: { newEmail: email, expiresAt: "2026-11-17T10:00:00.000Z" },
      };
    },
    cancelEmailChange: async () => {
      calls.push("cancel");
    },
    emailChangeLink: async () => ({ status: "valid", newEmail: "sara@new.example.com" }),
    confirmEmailChange: async () => ({ email: "sara@new.example.com" }),
    changePassword: async (current, next) => {
      calls.push(`password ${current}→${next}`);
    },
    sessions: async () => [{ current: true }, { current: false }, { current: false }],
    ...over,
  };
  return { api, calls };
}

const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

describe("Preferenze → Account dal server (area 9, R4a)", () => {
  it("il profilo: nome, email, foto letta come data URL, l'email in attesa e se il cambio è disponibile", async () => {
    const { api } = fakeApi({
      me: async () => ({
        user: {
          id: ME,
          email: "sara@example.com",
          displayName: null,
          avatarUrl: `/api/users/${ME}/avatar?v=1`,
        },
      }),
      emailChange: async () => ({
        available: false,
        pending: { newEmail: "sara@new.example.com", expiresAt: "2026-11-17T10:00:00.000Z" },
      }),
    });
    expect(await createRealMeAccount(api).getMyProfile()).toEqual({
      // Senza nome visualizzato, la parte locale dell'email (come il server).
      name: "sara",
      initials: "S",
      email: "sara@example.com",
      photo: `data:image/png;base64,from:/api/users/${ME}/avatar?v=1`,
      departmentId: null,
      pendingEmail: { email: "sara@new.example.com", expiresAt: "2026-11-17T10:00:00.000Z" },
      emailChangeAvailable: false,
    });
  });

  it("nome e foto: PATCH del nome, la foto come byte grezzi, null la toglie; 415 e 413 nelle parole del prototipo", async () => {
    const { api, calls } = fakeApi();
    const account = createRealMeAccount(api);
    expect(await account.updateProfile({ name: "Sara M." })).toEqual({ ok: true });
    expect(await account.updateProfile({ avatar: PNG })).toEqual({ ok: true });
    expect(await account.updateProfile({ avatar: null })).toEqual({ ok: true });
    expect(calls).toEqual(["name Sara M.", "avatar 8", "avatar delete"]);
    const bad = createRealMeAccount(fakeApi({ putAvatar: refusing(415, "unsupported_image") }).api);
    expect(await bad.updateProfile({ avatar: PNG })).toEqual({
      ok: false,
      error: "invalid",
      reason: "avatar_type",
    });
    const big = createRealMeAccount(fakeApi({ putAvatar: refusing(413, "payload_too_large") }).api);
    expect(await big.updateProfile({ avatar: PNG })).toMatchObject({ reason: "avatar_size" });
  });

  it("una foto troppo grande o di un tipo sbagliato si rifiuta PRIMA di mandarla (review F1, M5)", async () => {
    const { api, calls } = fakeApi();
    const account = createRealMeAccount(api);
    const bigPng = `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\n" + "x".repeat(600 * 1024))}`;
    expect(await account.updateProfile({ avatar: bigPng })).toEqual({
      ok: false,
      error: "invalid",
      reason: "avatar_size",
    });
    const gif = `data:image/gif;base64,${btoa("GIF89a....")}`;
    expect(await account.updateProfile({ avatar: gif })).toMatchObject({ reason: "avatar_type" });
    expect(calls).toEqual([]);
  });

  it("una foto fuori dall'istanza (Slack) si usa così com'è; quella dell'istanza si legge con l'autenticazione (M5)", async () => {
    const read: string[] = [];
    const base = fakeApi().api;
    const withUrl = (avatarUrl: string) =>
      createRealMeAccount({
        ...base,
        me: async () => ({ user: { ...(await base.me()).user, avatarUrl } }),
        avatarDataUrl: async (url) => {
          read.push(url);
          return `data:image/png;base64,from:${url}`;
        },
      });
    const slack = "https://avatars.slack-edge.com/2026-11/sara_192.png";
    expect((await withUrl(slack).getMyProfile()).photo).toBe(slack);
    expect(read).toEqual([]);
    expect((await withUrl("/api/me/avatar").getMyProfile()).photo).toBe(
      "data:image/png;base64,from:/api/me/avatar",
    );
    expect(read).toEqual(["/api/me/avatar"]);
  });

  it("il cambio d'email: la richiesta, gli errori nelle parole del prototipo, l'annullo", async () => {
    const { api, calls } = fakeApi();
    const account = createRealMeAccount(api);
    expect(await account.requestEmailChange("sara@new.example.com")).toEqual({
      ok: true,
      pending: { email: "sara@new.example.com", expiresAt: "2026-11-17T10:00:00.000Z" },
    });
    expect(await account.cancelEmailChange()).toEqual({ ok: true });
    expect(calls).toEqual(["start sara@new.example.com", "cancel"]);
    const cases: [number, string, unknown][] = [
      [409, "email_taken", { ok: false, error: "invalid", reason: "email_taken" }],
      [409, "email_transport_unavailable", { ok: false, error: "email_transport_unavailable" }],
      [502, "email_send_failed", { ok: false, error: "email_send_failed" }],
      [403, "reauth_required", { ok: false, error: "reauth_required" }],
    ];
    for (const [status, code, expected] of cases) {
      const a = createRealMeAccount(fakeApi({ startEmailChange: refusing(status, code) }).api);
      expect(await a.requestEmailChange("x@example.com"), code).toEqual(expected);
    }
  });

  it("la pagina del link: la lettura non conferma; la conferma dà la nuova email; invalid_token è «link»", async () => {
    const { api } = fakeApi();
    const account = createRealMeAccount(api);
    expect(await account.getEmailChangeLink("t")).toEqual({
      status: "valid",
      email: "sara@new.example.com",
    });
    expect(
      await createRealMeAccount(
        fakeApi({ emailChangeLink: async () => ({ status: "invalid" }) }).api,
      ).getEmailChangeLink("t"),
    ).toEqual({ status: "invalid" });
    expect(await account.confirmEmailChange("t")).toEqual({
      ok: true,
      email: "sara@new.example.com",
    });
    const invalid = createRealMeAccount(
      fakeApi({ confirmEmailChange: refusing(400, "invalid_token") }).api,
    );
    expect(await invalid.confirmEmailChange("t")).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });
    const taken = createRealMeAccount(
      fakeApi({ confirmEmailChange: refusing(409, "email_taken") }).api,
    );
    expect(await taken.confirmEmailChange("t")).toMatchObject({ reason: "email_taken" });
  });

  it("la password: quante altre sessioni si chiudono; la corrente sbagliata, la riconferma", async () => {
    const { api, calls } = fakeApi();
    expect(
      await createRealMeAccount(api).changePassword({ current: "old", next: "a-long-one" }),
    ).toEqual({
      ok: true,
      signedOut: 2,
    });
    expect(calls).toEqual(["password old→a-long-one"]);
    const wrong = createRealMeAccount(
      fakeApi({ changePassword: refusing(400, "invalid_current_password") }).api,
    );
    expect(await wrong.changePassword({ current: "x", next: "a-long-one" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "wrong_password",
    });
    const reauth = createRealMeAccount(
      fakeApi({ changePassword: refusing(403, "reauth_required") }).api,
    );
    expect(await reauth.changePassword({ current: "x", next: "a-long-one" })).toEqual({
      ok: false,
      error: "reauth_required",
    });
  });
});
