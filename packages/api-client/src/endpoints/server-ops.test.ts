import { isUnknown } from "@stubwise/shared";
import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Area 8, F4b: l'endpoint `serverOps` costruito dal CLIENT (url, metodo,
 * lettura). `fetch` finto. Le risposte di un server più vecchio (senza i
 * campi nuovi) si leggono coi default che non concedono niente.
 */
const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof clientReturning>["fetchImpl"]) => {
  const [url, init] = f.mock.calls[0]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

const ANALYSIS = { id: SERVER_ID, serverId: SERVER_ID, status: "done", startedAt: "2026-11-14T10:00:00.000Z" };
const FIX = { taskId: TICKET_ID, serverId: SERVER_ID, status: "awaiting_approval" };

describe("endpoints serverOps", () => {
  it("analisi: l'elenco legge un'analisi SENZA i campi additivi coi default che non concedono niente", async () => {
    const { client, fetchImpl } = clientReturning({ analyses: [ANALYSIS] });
    const [a] = (await client.serverOps.analyses(SERVER_ID)).analyses;
    expect(call(fetchImpl)).toMatchObject({ url: `/api/servers/${SERVER_ID}/analyses`, method: "GET" });
    expect(a).toMatchObject({ canViewDiagnosis: false, sessionId: null, diagnosis: null, attribution: null });
  });

  it("SSH: collega, verifica, rigenera, revoca", async () => {
    const view = { status: "pending" };
    for (const [run, url, method] of [
      [(c: ReturnType<typeof clientReturning>["client"]) => c.serverOps.connectSsh(SERVER_ID, { host: "h.example" }), "/ssh", "PUT"],
      [(c: ReturnType<typeof clientReturning>["client"]) => c.serverOps.verifySsh(SERVER_ID), "/ssh/verify", "POST"],
      [(c: ReturnType<typeof clientReturning>["client"]) => c.serverOps.regenerateSsh(SERVER_ID), "/ssh/regenerate", "POST"],
      [(c: ReturnType<typeof clientReturning>["client"]) => c.serverOps.revokeSsh(SERVER_ID), "/ssh", "DELETE"],
    ] as const) {
      const r = clientReturning(view);
      const out = await run(r.client);
      expect(call(r.fetchImpl)).toMatchObject({ url: `/api/servers/${SERVER_ID}${url}`, method });
      expect(out).toMatchObject({ canManage: false, publicKey: null });
    }
  });

  it("la correzione: un server vecchio senza planError/pruneWarning si legge; i permessi a false", async () => {
    const r = clientReturning(FIX);
    const fix = await r.client.serverOps.fix(TICKET_ID);
    expect(fix).toMatchObject({ planError: null, pruneWarning: null, canApprove: false, canStop: false, canRequestPlan: false, steps: [] });
    const rej = clientReturning(FIX);
    await rej.client.serverOps.reject(TICKET_ID, "prima i log");
    expect(call(rej.fetchImpl)).toMatchObject({ url: `/api/tasks/${TICKET_ID}/server-fix/reject`, method: "POST", body: { note: "prima i log" } });
  });

  it("approve manda la versione del piano visto (review F4b, I6)", async () => {
    const r = clientReturning(FIX);
    await r.client.serverOps.approve(TICKET_ID, "abc123");
    expect(call(r.fetchImpl)).toMatchObject({ url: `/api/tasks/${TICKET_ID}/server-fix/approve`, method: "POST", body: { planDigest: "abc123" } });
  });

  it("uno stato di correzione nuovo non rompe la lettura (enum aperto)", async () => {
    const r = clientReturning({ ...FIX, status: "quarantined" });
    expect(isUnknown((await r.client.serverOps.fix(TICKET_ID)).status)).toBe(true);
  });
});
