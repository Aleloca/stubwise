import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import type { AutomationSourceView, ClientLinkView } from "@stubwise/shared";
import { createRealSources, type SourcesApi } from "./automationSources";

// Area 7, F4 (R4): le sorgenti e la tabella cliente → progetto sulle rotte
// vere, con le firme del prototipo. Il segreto del webhook esce SOLO dalla
// creazione e dalla rigenerazione (F4-1, C-F4-1): l'elenco non ce l'ha.

const view = (over: Partial<AutomationSourceView> = {}): AutomationSourceView =>
  ({
    id: "s1",
    kind: "webhook",
    name: "Ordini",
    status: "connected",
    connectedById: "ada",
    sampleEvents: [],
    fields: [{ key: "ordine.id", label: "Ordine id", type: "text" }],
    permissions: { manage: true },
    usedBy: null,
    ...over,
  }) as AutomationSourceView;

function fakeApi(over: Partial<SourcesApi> = {}) {
  const calls: string[] = [];
  const log = (s: string) => calls.push(s);
  const api: SourcesApi = {
    sources: {
      list: async () => (log("GET sources"), { items: [view()] }),
      createWebhook: async (b) => (
        log(`POST sources ${b.name}`),
        { source: view({ name: b.name }), address: "https://x/webhooks/in/SEGRETO" }
      ),
      rename: async (id, b) => (log(`PATCH ${id} ${b.name}`), view({ name: b.name })),
      regenerate: async (id) => (
        log(`POST ${id}/regenerate`),
        { source: view(), address: "https://x/webhooks/in/NUOVO" }
      ),
      previewExample: async (id, json) => (
        log(`POST ${id}/preview ${json}`),
        { error: null, fields: [], missing: [] }
      ),
      setExample: async (id, json) => (
        log(`PUT ${id}/example ${json}`),
        view({ fields: [{ key: "a", label: "A", type: "number" }] })
      ),
      updateField: async (id, key, patch) => (
        log(`PATCH ${id}/fields/${key} ${JSON.stringify(patch)}`),
        view()
      ),
      events: async (id) => (log(`GET ${id}/events`), { items: [] }),
    },
    clientLinks: {
      list: async () => (
        log("GET links"),
        {
          items: [
            {
              clientKey: "rossi.it",
              clientName: "Rossi",
              projectId: "p1",
              projectVisible: true,
            } as ClientLinkView,
          ],
        }
      ),
      suggestions: async () => (
        log("GET suggestions"),
        { items: [{ clientKey: "verdi.com", clientName: "Verdi" }] }
      ),
      put: async (key, b) => (
        log(`PUT link ${key} ${JSON.stringify(b)}`),
        { clientKey: key, ...b, projectVisible: true } as ClientLinkView
      ),
      remove: async (key) => void log(`DELETE link ${key}`),
    },
    ...over,
  };
  return { api, calls };
}

describe("le sorgenti e la tabella sulle rotte vere (F4, R4)", () => {
  it("creare e rigenerare danno l'indirizzo col segreto; l'elenco no", async () => {
    const { api, calls } = fakeApi();
    const r = createRealSources(api);
    const created = await r.createWebhookSource("Ordini e-shop");
    expect(created.address).toBe("https://x/webhooks/in/SEGRETO");
    expect(await r.regenerateWebhookAddress("s1")).toBe("https://x/webhooks/in/NUOVO");
    const [listed] = await r.listSources();
    expect(listed!.address).toBeUndefined();
    expect(calls).toEqual(["POST sources Ordini e-shop", "POST s1/regenerate", "GET sources"]);
  });

  it("nome, esempio (i campi nuovi), campi e anteprima", async () => {
    const { api, calls } = fakeApi();
    const r = createRealSources(api);
    await r.renameSource("s1", "Ordini 2");
    expect(await r.setWebhookExample("s1", '{"a":1}')).toEqual([
      { key: "a", label: "A", type: "number" },
    ]);
    await r.updateWebhookField("s1", "righe.nome", { label: "Nome" });
    await r.previewWebhookExample("s1", "{}");
    expect(calls).toEqual([
      "PATCH s1 Ordini 2",
      'PUT s1/example {"a":1}',
      'PATCH s1/fields/righe.nome {"label":"Nome"}',
      "POST s1/preview {}",
    ]);
  });

  it("la tabella: elenco, suggerimenti, scrivere e togliere una riga", async () => {
    const { api, calls } = fakeApi();
    const r = createRealSources(api);
    expect((await r.listClientLinks()).map((l) => l.clientKey)).toEqual(["rossi.it"]);
    expect(await r.listClientSuggestions()).toEqual([
      { clientKey: "verdi.com", clientName: "Verdi" },
    ]);
    await r.setClientLink({ clientKey: "Rossi.IT", clientName: "Rossi", projectId: "p1" });
    await r.removeClientLink("rossi.it");
    expect(calls).toEqual([
      "GET links",
      "GET suggestions",
      'PUT link Rossi.IT {"clientName":"Rossi","projectId":"p1"}',
      "DELETE link rossi.it",
    ]);
  });

  it("un server senza la F4 (404): nessuna sorgente né riga, non un errore", async () => {
    const missing = async (): Promise<never> => {
      throw new ApiError(404, "not_found", "not_found");
    };
    const { api } = fakeApi();
    const r = createRealSources({
      sources: { ...api.sources, list: missing },
      clientLinks: { ...api.clientLinks, list: missing, suggestions: missing },
    });
    expect(await r.listSources()).toEqual([]);
    expect(await r.listClientLinks()).toEqual([]);
    expect(await r.listClientSuggestions()).toEqual([]);
  });

  it("gli eventi recenti di una sorgente (solo con integrations.manage: 403 → nessuno)", async () => {
    const { api } = fakeApi({
      sources: {
        ...fakeApi().api.sources,
        events: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      },
    });
    expect(await createRealSources(api).listSourceEvents("s1")).toEqual([]);
  });
});
