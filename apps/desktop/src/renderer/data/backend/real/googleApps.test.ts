import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealGoogleApps, type GoogleAppsApi } from "./googleApps";

// Area 9, F3: Amministrazione → Google Workspace su `/api/settings/google-workspaces` (72).

const G = "60000000-0000-4000-8000-000000000001";
const ws = (over: Record<string, unknown> = {}) => ({
  id: G,
  name: "Example",
  domains: ["example.com"],
  clientId: "123.apps.googleusercontent.com",
  clientSecretSet: true,
  accountCount: 2,
  redirectUri: "https://stubwise.acme.test/api/me/google/callback",
  createdAt: "2026-11-01T09:00:00.000Z",
  ...over,
});
const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

function fakeApi(over: Partial<GoogleAppsApi> = {}) {
  const calls: string[] = [];
  const api: GoogleAppsApi = {
    list: async () => [ws()],
    create: async (input) => {
      calls.push(`create ${JSON.stringify(input)}`);
      return ws({ id: "60000000-0000-4000-8000-000000000002" });
    },
    update: async (id, patch) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`);
      return ws(patch);
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
    },
    origin: async () => "https://stubwise.acme.test",
    ...over,
  };
  return { api, calls };
}

describe("le app Google dal server (area 9, F3)", () => {
  // Rimandi, lotto 5, voce 6 (72, d68892e5d): le ultime 4 dal server; null
  // (segreto di prima, o sotto gli 8 caratteri) resta «••••» senza cifre.
  it("le ultime 4 del client secret, quando il server le sa", async () => {
    const [a] = await createRealGoogleApps(
      fakeApi({ list: async () => [ws({ clientSecretLast4: "k3Yz" })] }).api,
    ).listGoogleApps();
    expect(a!.last4).toBe("k3Yz");
  });

  it("l'elenco: le caselle collegate contate (i nomi il server non li dà), senza ultime 4", async () => {
    const [a] = await createRealGoogleApps(fakeApi().api).listGoogleApps();
    expect(a).toMatchObject({
      id: G,
      name: "Example",
      domains: ["example.com"],
      clientId: "123.apps.googleusercontent.com",
      last4: "",
      mailboxCount: 2,
      mailboxPeople: [],
      hiddenMailboxCount: 2,
    });
  });

  it("l'indirizzo di ritorno: quello del server; senza app, l'origine dell'istanza", async () => {
    expect(await createRealGoogleApps(fakeApi().api).getGoogleRedirectUri()).toBe(
      "https://stubwise.acme.test/api/me/google/callback",
    );
    expect(
      await createRealGoogleApps(fakeApi({ list: async () => [] }).api).getGoogleRedirectUri(),
    ).toBe("https://stubwise.acme.test/api/me/google/callback");
  });

  it("le scritture: crea, cambia, sostituisce il secret, elimina; in uso e riconferma", async () => {
    const { api, calls } = fakeApi();
    const g = createRealGoogleApps(api);
    expect(
      await g.createGoogleApp({
        name: "Acme",
        domains: ["acme.it"],
        clientId: "c",
        clientSecret: "s",
      }),
    ).toEqual({ ok: true, appId: "60000000-0000-4000-8000-000000000002" });
    expect(await g.updateGoogleApp(G, { domains: ["example.com", "example.org"] })).toEqual({
      ok: true,
    });
    expect(await g.replaceGoogleSecret(G, "GOCSPX-new")).toEqual({ ok: true });
    expect(await g.deleteGoogleApp(G)).toEqual({ ok: true });
    expect(calls).toEqual([
      'create {"name":"Acme","domains":["acme.it"],"clientId":"c","clientSecret":"s"}',
      `update ${G} {"domains":["example.com","example.org"]}`,
      `update ${G} {"clientSecret":"GOCSPX-new"}`,
      `remove ${G}`,
    ]);
    const inUse = createRealGoogleApps(fakeApi({ remove: refusing(409, "workspace_in_use") }).api);
    expect(await inUse.deleteGoogleApp(G)).toEqual({
      ok: false,
      error: "in_use",
      usedBy: [],
      hiddenCount: 2,
    });
    const reauth = createRealGoogleApps(fakeApi({ update: refusing(403, "reauth_required") }).api);
    expect(await reauth.replaceGoogleSecret(G, "x")).toEqual({
      ok: false,
      error: "reauth_required",
    });
  });
});
