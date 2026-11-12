import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Il cassetto Google (area 6, fetta 1): Workspace, collegare (l'URL di
// consenso), le caselle con `missingScopes`, proposte sì/no, scollegare.
const ACCOUNT = "7f1c2a1e-0000-4000-8000-0000000000a1";
const WS = "7f1c2a1e-0000-4000-8000-0000000000b2";
const account = {
  id: ACCOUNT,
  email: "ada@acme.com",
  workspaceId: WS,
  workspaceName: "Acme",
  scopes: ["openid", "email"],
  proposalsEnabled: true,
  connectedAt: "2026-11-12T10:00:00.000Z",
  lastSyncAt: null,
  disabledAt: null,
  disabledReason: null,
};

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof client>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

describe("endpoints google", () => {
  it("le caselle; una senza `missingScopes` (un server di prima) si legge con []", async () => {
    const a = client([account]);
    expect(await a.c.google.accounts()).toMatchObject([{ id: ACCOUNT, missingScopes: [] }]);
    expect(last(a.fetchImpl)).toMatchObject({ url: "/api/me/google/accounts", method: "GET" });
  });

  it("Workspace, collegare (URL di consenso), proposte sì/no, scollegare", async () => {
    const w = client([{ id: WS, name: "Acme", domains: ["acme.com"], clientSecretSet: true }]);
    await w.c.google.workspaces();
    expect(last(w.fetchImpl)).toMatchObject({ url: "/api/me/google/workspaces", method: "GET" });
    const k = client({ authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x" });
    expect(await k.c.google.connect(WS)).toEqual({ authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x" });
    expect(last(k.fetchImpl)).toEqual({ url: "/api/me/google/connect", method: "POST", body: { workspaceId: WS } });
    const p = client({ ...account, proposalsEnabled: false });
    await p.c.google.setProposals(ACCOUNT, false);
    expect(last(p.fetchImpl)).toEqual({ url: `/api/me/google/accounts/${ACCOUNT}`, method: "PATCH", body: { proposalsEnabled: false } });
    const d = client(null, 204);
    await d.c.google.disconnect(ACCOUNT);
    expect(last(d.fetchImpl)).toMatchObject({ url: `/api/me/google/accounts/${ACCOUNT}`, method: "DELETE" });
  });
});
