import { isUnknown, readerNodeKinds, unsupportedNodeKinds } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { createEndpoints } from "./client.js";
import type { ApiRequest } from "./client.js";
import { createStubwiseClient } from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-02T10:00:00.000Z";

/**
 * Ogni schema di risposta che gli endpoint passano davvero al trasporto.
 *
 * Raccolto CHIAMANDO ogni metodo di ogni gruppo con un `request` tracciato, non
 * da un elenco scritto a mano: un endpoint (o un gruppo) aggiunto domani entra
 * in questi controlli da solo — che è l'unico modo perché "non ci si può
 * dimenticare" resti vero anche al task 20. Gli argomenti sono finti di
 * proposito: lo schema è scelto prima che il corpo conti qualcosa.
 */
function responseSchemas(): { name: string; schema: ZodType }[] {
  const collected: { name: string; schema: ZodType }[] = [];
  let current = "";
  const request = ((_m: string, _p: string, _b?: unknown, schema?: ZodType) => {
    if (schema) collected.push({ name: current, schema });
    return Promise.resolve(undefined);
  }) as unknown as ApiRequest;

  const groups = createEndpoints(request) as unknown as Record<string, Record<string, unknown>>;
  for (const [groupName, group] of Object.entries(groups)) {
    for (const [method, fn] of Object.entries(group)) {
      if (typeof fn !== "function") continue;
      current = `${groupName}.${method}`;
      try {
        (fn as (...a: unknown[]) => unknown).call(group, ID, ID, ID);
      } catch {
        // Argomenti finti: un errore qui non interessa, lo schema è già passato.
      }
    }
  }
  return collected;
}

describe("guardiano dei tipi di nodo", () => {
  it("ogni schema di risposta del client è attraversabile da readerSchema", () => {
    // Se uno schema contenesse un nodo che la derivazione non sa attraversare
    // (un `record`, un oggetto con catchall), passerebbe invariato — sicuro,
    // ma gli enum lì dentro resterebbero CHIUSI in silenzio: di nuovo il bug
    // che tutto questo esiste per evitare, proprio dove nessuno lo cerca.
    const offenders = responseSchemas()
      .map(({ name, schema }) => ({ name, kinds: unsupportedNodeKinds(schema) }))
      .filter((entry) => entry.kinds.length > 0);
    expect(offenders).toEqual([]);
  });

  it("il guardiano non passa a vuoto: gli schemi ci sono e contengono enum", () => {
    const schemas = responseSchemas();
    expect(schemas.length).toBeGreaterThan(30);
    expect(schemas.filter(({ schema }) => readerNodeKinds(schema).has("enum")).length).toBeGreaterThan(
      10,
    );
  });
});

describe("enum aperti sulla risposta vera", () => {
  function clientReturning(body: unknown, status = 200) {
    return createStubwiseClient({
      baseUrl: "",
      getAuthHeader: () => null,
      fetch: (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });
  }

  const item = (kind: string) => ({
    id: ID,
    kind,
    status: "open",
    text: "qualcosa è successo",
    actions: ["open"],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: NOW,
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
  });

  it("un kind di notifica SCONOSCIUTO non fa crollare la lista d'inbox", async () => {
    // Lo scenario per cui esiste tutto il meccanismo: server aggiornato con un
    // kind nuovo, app vecchia ancora sullo store. Prima: parse fallito e
    // schermata principale vuota, senza rebuild che ci salvi. Ora: una voce da
    // mostrare in modo generico, e il RESTO della lista intatto.
    const client = clientReturning({
      items: [item("job.plan_review"), item("project.qualcosa_di_nuovo")],
      nextCursor: null,
    });

    const page = await client.inbox.list();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.kind).toBe("job.plan_review");
    expect(isUnknown(page.items[1]!.kind)).toBe(true);
    // La voce sconosciuta resta LEGGIBILE: `text` arriva già localizzato dal
    // server, quindi la card generica ha comunque qualcosa da dire.
    expect(page.items[1]!.text).toBe("qualcosa è successo");
  });

  it("vale anche fuori dall'inbox: uno stato di job sconosciuto non rompe la timeline", async () => {
    const client = clientReturning([
      {
        id: ID,
        ticketId: ID,
        status: "modalita_nuova",
        log: "",
        error: null,
        prUrl: null,
        startedAt: null,
        finishedAt: null,
        providerLabel: null,
        providerKind: null,
        requestedByUserId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const jobs = await client.tickets.jobs(ID);
    expect(isUnknown(jobs[0]!.status)).toBe(true);
  });

  it("la corsia SENZA schema resta grezza: la SPA non vede enum aperti", async () => {
    const client = clientReturning({ kind: "qualcosa_di_ignoto" });
    await expect(client.request("GET", "/api/qualsiasi")).resolves.toEqual({
      kind: "qualcosa_di_ignoto",
    });
  });

  it("l'apertura NON salva un campo rimosso: resta un ApiError invalid_response", async () => {
    // Il limite dichiarato, pinnato da un test: verso un client che non
    // controlliamo, solo i cambi ADDITIVI sono sicuri.
    const client = clientReturning({ items: [{ id: ID }], nextCursor: null });
    await expect(client.inbox.list()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
