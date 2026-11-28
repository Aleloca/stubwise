import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleReturn } from "../../../../main/googleReturn";
import { session, setAppClientForTests } from "./client";
import { drive } from "./drive";
import { installFakeServer, ME_ID } from "./fakeServer";

// Lotto 4, §6, il giro completo coi pezzi veri: il main (`googleReturn`)
// prepara lo state, il renderer lo manda al server, il server risponde
// `returnTo: "desktop"`; il browser, dopo il consenso, torna dalla pagina
// dell'istanza con `stubwise://google?outcome&state`, che il main accetta e
// passa al renderer; il renderer chiude l'attesa. Il preload qui è un ponte
// diretto fra i due (lo stesso contratto: `prepareConnect`, `onReturned`).

const WS = "11111111-1111-4111-8111-111111111111";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const account = {
  id: ACC,
  email: "ada@acme.test",
  workspaceId: WS,
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-23T10:00:00.000Z",
  lastSyncAt: null,
  lastSyncError: null,
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
};

/** Main e preload: lo stesso giro di `index.ts` (`google:prepare-connect`, `google:returned`). */
function desktop() {
  const listeners = new Set<(ret: { state: string; outcome: string }) => void>();
  const main = createGoogleReturn({ notify: (ret) => listeners.forEach((cb) => cb(ret)) });
  vi.stubGlobal("stubwise", {
    google: {
      prepareConnect: async () => ({ ok: true as const, ...main.prepare() }),
      cancelConnect: async () => {
        main.cancel();
        return { ok: true };
      },
      onReturned: (cb: (ret: { state: string; outcome: string }) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  });
  vi.stubGlobal(
    "open",
    vi.fn(() => null),
  );
  return main;
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il ritorno da Google al desktop, dal main al renderer", () => {
  for (const [outcome, expected] of [
    ["domain_mismatch", { rejects: "invalid: wrong_domain" }],
    ["ok", { resolves: "ada@acme.test" }],
  ] as const) {
    it(`esito ${outcome}: prepare → server → browser → stubwise://google → renderer`, async () => {
      const main = desktop();
      let accounts: unknown[] = [];
      let returnState = "";
      const { seen } = installFakeServer({
        "GET /api/me/google/workspaces": {
          body: [{ id: WS, name: "Acme", domains: ["acme.test"], clientSecretSet: true }],
        },
        "POST /api/me/google/connect": (req) => {
          returnState = (req.body as { returnState: string }).returnState;
          return { body: { authorizeUrl: "https://accounts.google.com/x", returnTo: "desktop" } };
        },
        "GET /api/me/google/accounts": () => ({ body: accounts }),
      });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const pending = drive.connectGoogle();
      await vi.waitFor(() => expect(returnState).not.toBe(""));
      expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toMatchObject({
        client: "desktop",
      });
      // Il browser: Google → callback del server → `/#/desktop-google` → l'app.
      if (outcome === "ok") accounts = [account];
      expect(
        main.handleGoogleUrl(`stubwise://google?outcome=${outcome}&state=${returnState}`),
      ).toEqual({
        state: returnState,
        outcome,
      });
      if ("rejects" in expected) await expect(pending).rejects.toThrow(expected.rejects);
      else await expect(pending).resolves.toMatchObject({ email: expected.resolves });
      // Monouso: un secondo ritorno con lo stesso state si ignora.
      expect(
        main.handleGoogleUrl(`stubwise://google?outcome=${outcome}&state=${returnState}`),
      ).toBeNull();
    });
  }
});
