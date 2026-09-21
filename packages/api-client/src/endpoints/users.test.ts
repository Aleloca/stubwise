import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ALTRO_ID = "22222222-2222-4222-8222-222222222222";

function clientCon(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints users", () => {
  it("list: legge identità e ruolo, e SPOGLIA i campi della pagina Team", async () => {
    // La rotta dichiara `teamUserSchema` (username Bitbucket, identità git),
    // qui si parsa con la proiezione pubblica: chi legge questo elenco
    // disegna un selettore di assegnatari. I campi in più non arrivano, e
    // quindi non possono romperne il parse quando ne nascerà un altro.
    const { client, fetchImpl } = clientCon([
      { id: ID, email: "mario@acme.test", role: "admin", bitbucketUsername: "mario", gitIdentities: [] },
      { id: ALTRO_ID, email: "lucia@acme.test", role: "member", bitbucketUsername: null, gitIdentities: [] },
    ]);

    const users = await client.users.list();

    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/users");
    expect(users.map((user) => user.email)).toEqual(["mario@acme.test", "lucia@acme.test"]);
    expect(users[0]).not.toHaveProperty("bitbucketUsername");
  });

  it("list: un ruolo che questa build non conosce non fa saltare l'elenco", async () => {
    const { client } = clientCon([
      { id: ID, email: "mario@acme.test", role: "admin" },
      { id: ALTRO_ID, email: "nuovo@acme.test", role: "observer" },
    ]);

    const users = await client.users.list();

    expect(users.map((user) => user.email)).toEqual(["mario@acme.test", "nuovo@acme.test"]);
  });
});
