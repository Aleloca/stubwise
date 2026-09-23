import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Endpoint `repositories` costruito dal CLIENT: url e metodo. Come i gemelli
 * accanto, non c'è un server dietro — `fetch` è finto: i test del server
 * iniettano il payload e non vedono MAI come il client compone il path.
 */
const REPOSITORY = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  name: "Portale B2B",
  slug: "portale-b2b",
  provider: "github",
  repoUrl: "https://github.com/acme/portale-b2b",
  defaultBranch: "main",
  gitAccountId: "33333333-3333-4333-8333-333333333333",
  gitAccountName: "acme-bot",
  testCommand: "pnpm test",
  installCommand: "pnpm install",
  webhookConfiguredAt: "2026-09-01T10:00:00.000Z",
  graphEnabled: true,
  createdAt: "2026-08-01T10:00:00.000Z",
};

function clientConRepository() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(REPOSITORY), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

describe("endpoints repositories", () => {
  it("get: indirizza per SLUG, non per id", async () => {
    const { client, fetchImpl } = clientConRepository();
    await client.repositories.get("portale-b2b");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories/portale-b2b");
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("GET");
  });

  it("uno slug con caratteri da codificare non esce dal path", async () => {
    const { client, fetchImpl } = clientConRepository();
    await client.repositories.get("a/b?c");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories/a%2Fb%3Fc");
  });

  it("legge i campi che il dettaglio mostra, compresi i comandi della pipeline", async () => {
    const { client } = clientConRepository();
    const repository = await client.repositories.get("portale-b2b");
    expect(repository.defaultBranch).toBe("main");
    expect(repository.installCommand).toBe("pnpm install");
    expect(repository.testCommand).toBe("pnpm test");
    expect(repository.graphEnabled).toBe(true);
  });

  /**
   * ⚠️ Il segreto HMAC del webhook non fa parte della proiezione pubblica
   * (permetterebbe di forgiare webhook di merge e forzare i ticket a `done`),
   * e `repositorySchema` è un `z.object`, che STRIPPA i campi in più: anche
   * se un server lo mandasse per errore, non arriverebbe a nessuna UI.
   */
  it("un campo che il server non deve mandare non arriva comunque al client", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ...REPOSITORY, webhookSecret: "non-deve-passare" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const repository = await client.repositories.get("portale-b2b");
    expect(repository).not.toHaveProperty("webhookSecret");
  });
});
