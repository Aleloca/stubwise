import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Test dell'endpoint `pats` che il CLIENT costruisce da sé: url e metodo. Non
 * c'è un server dietro — `fetch` è finto.
 *
 * A differenza di `deleteDevice` (`me.ts`), qui l'id nel path NON è un
 * segreto (è l'id UUID della riga PAT, non il token in chiaro): il verbo REST
 * `DELETE /api/pats/:id` è quello che la rotta server dichiara davvero
 * (`apps/server/src/routes/pat.ts`), lo stesso usato da `apps/web/src/lib/api.ts`.
 */
function clientSenzaRisposta() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  const client = createStubwiseClient({
    baseUrl: "",
    getAuthHeader: () => null,
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

function lastCall(fetchImpl: ReturnType<typeof clientSenzaRisposta>["fetchImpl"]) {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return { url: String(url), method: String(init!.method), body: init!.body };
}

describe("endpoints pats", () => {
  it("revoke: DELETE su /api/pats/:id, nessun corpo", async () => {
    const { client, fetchImpl } = clientSenzaRisposta();
    await client.pats.revoke("pat-123");
    const call = lastCall(fetchImpl);
    expect([call.url, call.method]).toEqual(["/api/pats/pat-123", "DELETE"]);
    expect(call.body).toBeUndefined();
  });
});
