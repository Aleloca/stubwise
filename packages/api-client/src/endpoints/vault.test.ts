import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * I gruppi `vault` e `credentials` (25 nov 2026, la cassaforte del desktop):
 * solo le LETTURE e le scritture in chiaro. Creazione, cambio password,
 * reveal e lettori restano nel main, dove sta la chiave: qui non ci sono
 * apposta. `fetch` è finto: url, metodo, corpo, e il parse della risposta.
 */

const P = "7f1c2a1e-0000-4000-8000-0000000000a1";
const C = "7f1c2a1e-0000-4000-8000-0000000000c1";
const K = "7f1c2a1e-0000-4000-8000-0000000000b1";
const U = "7f1c2a1e-0000-4000-8000-0000000000e1";
const NOW = "2026-11-25T10:00:00.000Z";

function clientAnswering(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: status === 204 ? {} : { "content-type": "application/json" },
      }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

function lastCall(fetchImpl: ReturnType<typeof clientAnswering>["fetchImpl"]) {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  const parsed = new URL(String(url), "http://x");
  return {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
    method: String(init!.method),
    body: init!.body === undefined || init!.body === null ? undefined : JSON.parse(String(init!.body)),
  };
}

/** Una riga come la manda un server di PRIMA dei campi calcolati: senza `canEdit`/`canShare`. */
const oldItem = {
  id: C,
  projectId: P,
  service: "Aruba",
  label: null,
  url: null,
  username: null,
  notes: null,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  updatedByUserId: null,
  access: "pending",
};

describe("vault.status", () => {
  it("GET /api/vault/status; un server senza `publicKey` dà `undefined`, non un errore", async () => {
    const { client, fetchImpl } = clientAnswering({
      activated: true,
      myKey: { id: K, status: "pending", createdAt: NOW },
      seals: [],
      passkeys: [],
    });
    const status = await client.vault.status();
    expect(lastCall(fetchImpl)).toMatchObject({ path: "/api/vault/status", method: "GET", body: undefined });
    expect(status.myKey).toEqual({ id: K, status: "pending", createdAt: NOW });
    expect(status.myKey?.publicKey ?? null).toBeNull();
  });

  it("la pubblica arriva quando il server la manda", async () => {
    const { client } = clientAnswering({ activated: true, myKey: { id: K, status: "pending", createdAt: NOW, publicKey: "{}" }, seals: [], passkeys: [] });
    expect((await client.vault.status()).myKey?.publicKey).toBe("{}");
  });
});

describe("credentials", () => {
  it("mine: GET /api/vault/credentials; `canEdit`/`canShare` assenti prendono `false`", async () => {
    const { client, fetchImpl } = clientAnswering({ items: [oldItem] });
    const { items } = await client.credentials.mine();
    expect(lastCall(fetchImpl)).toMatchObject({ path: "/api/vault/credentials", method: "GET" });
    expect(items[0]).toMatchObject({ id: C, access: "pending", canEdit: false, canShare: false });
  });

  it("ofProject: GET /api/projects/:projectId/credentials", async () => {
    const { client, fetchImpl } = clientAnswering({ items: [{ ...oldItem, access: "read", canEdit: true, canShare: true }] });
    const { items } = await client.credentials.ofProject(P);
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${P}/credentials`, method: "GET" });
    expect(items[0]).toMatchObject({ access: "read", canEdit: true, canShare: true });
  });

  it("log: senza filtro nessun parametro; con `credentialId` e `limit` in querystring; `via` assente → `browser`", async () => {
    const entry = { id: U, credentialId: C, credentialSnapshot: "Aruba", userId: null, userEmail: "a@b.c", action: "show", createdAt: NOW };
    const { client, fetchImpl } = clientAnswering({ items: [entry] });
    const { items } = await client.credentials.log(P);
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${P}/credentials/log`, query: {}, method: "GET" });
    expect(items[0]!.via).toBe("browser");
    await client.credentials.log(P, { credentialId: C, limit: 50 });
    expect(lastCall(fetchImpl).query).toEqual({ credentialId: C, limit: "50" });
  });

  it("readers: GET /api/credentials/:id/readers (lettori e stato, nessuna copia)", async () => {
    const { client, fetchImpl } = clientAnswering({
      readers: [{ id: U, userId: U, email: "a@b.c", roleId: null, roleName: null, createdAt: NOW }],
      people: [{ userId: U, email: "a@b.c", fullAdmin: false, status: "can_read", keyStatus: "confirmed" }],
    });
    const view = await client.credentials.readers(C);
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/credentials/${C}/readers`, method: "GET" });
    expect(view.readers[0]).toMatchObject({ creator: false });
    expect(view.people[0]).toMatchObject({ status: "can_read" });
  });

  it("update: PATCH /api/credentials/:id col solo corpo dato; risponde la riga", async () => {
    const { client, fetchImpl } = clientAnswering({ ...oldItem, service: "Aruba 2", access: "read", canEdit: true, canShare: false });
    const item = await client.credentials.update(C, { service: "Aruba 2", notes: null });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/credentials/${C}`, query: {}, method: "PATCH", body: { service: "Aruba 2", notes: null } });
    expect(item).toMatchObject({ service: "Aruba 2", canEdit: true });
  });

  it("remove: DELETE /api/credentials/:id, nessun corpo", async () => {
    const { client, fetchImpl } = clientAnswering(null, 204);
    await client.credentials.remove(C);
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/credentials/${C}`, query: {}, method: "DELETE", body: undefined });
  });
});
