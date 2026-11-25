// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { me, PROJECT_ID } from "./fakeServer";
import * as desk from "./vaultDesktop";
import * as reads from "./vaultReads";

// Review C1 (25 nov 2026): nell'app il proxy del main rifiuta al renderer
// ogni `/api/vault*` e il reveal (`isVaultOnlyPath`, 403 `vault_via_main`).
// Qui il ponte `api` VERO del desktop (non il fetch globale): ogni funzione
// dell'adattatore della cassaforte deve riuscire senza mai chiedere quei
// percorsi al proxy — le letture /api/vault* passano dai canali del main.

/** La regola del proxy (`src/main/apiProxy.ts`, `isVaultOnlyPath`). */
const vaultOnly = (path: string) =>
  /^\/api\/vault(\/|$)/i.test(path.split("?")[0]!) ||
  /^\/api\/credentials\/[^/]+\/reveal\/?$/i.test(path);

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const item = {
  id: C1,
  projectId: PROJECT_ID,
  service: "Aruba hosting",
  label: null,
  url: null,
  username: "admin",
  notes: null,
  createdByUserId: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  updatedByUserId: null,
  access: "read",
  canEdit: true,
  canShare: true,
};

const routes: Record<string, unknown> = {
  "GET /api/auth/me": me({
    projectPermissions: {
      [PROJECT_ID]: ["credentials.create", "credentials.edit", "credentials.share"],
    },
  }),
  [`GET /api/projects/${PROJECT_ID}/credentials`]: { items: [item] },
  [`GET /api/projects/${PROJECT_ID}/credentials/log`]: { items: [] },
  [`GET /api/credentials/${C1}/readers`]: { readers: [], people: [] },
  [`GET /api/projects/${PROJECT_ID}/members`]: [],
  "GET /api/people": [],
  [`PATCH /api/credentials/${C1}`]: item,
  [`DELETE /api/credentials/${C1}`]: null,
};

let asked: string[] = [];

beforeEach(() => {
  asked = [];
  setAppClientForTests(null);
  vi.stubGlobal("stubwise", {
    api: {
      request: vi.fn(async (req: { method: string; path: string }) => {
        asked.push(req.path);
        if (vaultOnly(req.path))
          return {
            status: 403,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "vault_via_main", message: "x" }),
          };
        const key = `${req.method} ${req.path.split("?")[0]}`;
        if (!(key in routes))
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "not_found", message: key }),
          };
        const body = routes[key];
        return body === null
          ? { status: 204, headers: {}, body: "" }
          : {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            };
      }),
    },
    vault: {
      status: async () => ({ state: "open", fingerprint: "fp", touchId: true }),
      serverStatus: async () => ({ ok: true, activated: true, myKey: null }),
      mine: async () => ({ ok: true, items: [item] }),
      pending: async () => ({ ok: true, items: [] }),
      setPassword: async () => ({ ok: true }),
      create: async () => ({ ok: true, id: C1 }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("nell'app le letture /api/vault* passano dal main, mai dal proxy", () => {
  it("ogni funzione dell'adattatore riesce col ponte vero, e nessuna chiede un percorso della cassaforte al proxy", async () => {
    expect((await desk.getVaultStatus()).state).toBe("no_key");
    expect((await reads.listCredentials({})).map((c) => c.service)).toEqual(["Aruba hosting"]);
    expect(await reads.listCredentials({ projectId: PROJECT_ID })).toHaveLength(1);
    expect((await reads.getCredential(C1))?.service).toBe("Aruba hosting");
    expect((await reads.getCredentialsEntry(PROJECT_ID)).show).toBe(true);
    expect((await reads.getVaultEntry()).show).toBe(true);
    expect(await reads.listReaders(C1)).toMatchObject({ canShare: true });
    expect(await reads.listAccessLog({ projectId: PROJECT_ID, credentialId: C1 })).toEqual([]);
    expect(await reads.listShareTargets(C1)).toEqual({ people: [], roles: [] });
    expect(await reads.updateCredential(C1, { label: "x", password: "pw" })).toEqual({ ok: true });
    expect(await reads.deleteCredential(C1)).toEqual({ ok: true });
    expect(
      await reads.createCredential(PROJECT_ID, {
        service: "S",
        label: null,
        url: null,
        username: null,
        notes: null,
        password: "pw",
      }),
    ).toEqual({ ok: true, id: C1 });
    expect(asked.filter(vaultOnly)).toEqual([]);
  });
});
