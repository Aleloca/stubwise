import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import type {
  Automation,
  AutomationDetail,
  AutomationFlow,
  AutomationRow,
  AutomationRunRow,
} from "@stubwise/shared";
import { createRealAutomations, type AutomationsApi } from "./automations";

// R2 della F1 (area 7): il livello dati delle Automations sulle rotte vere,
// con la firma del prototipo (le pagine sono quelle). Le rotte vanno per
// codice (`/api/automations/:code`), le pagine per id: l'adattatore ricorda
// il codice e la revisione dalle letture. Errori nelle parole del
// prototipo; un 409 `stale` sulla bozza è `invalid: stale`, che il
// costruttore sa dire («ricarica», il testo resta a schermo).

const FLOW = {
  trigger: { kind: "manual" },
  steps: [],
  titleTemplate: "x",
} as unknown as AutomationFlow;
const automation = (rev: number, over: Partial<Automation> = {}): Automation =>
  ({
    id: "a-1",
    code: "AUD-A1",
    name: "Avvio",
    description: "",
    projectId: "prj-1",
    ownerId: "ada",
    status: "draft",
    versions: [
      {
        n: 1,
        flow: FLOW,
        publishedAt: null,
        publishedById: null,
        savedAt: "",
        savedById: "ada",
        rev,
        testedRev: rev,
      },
    ],
    ...over,
  }) as unknown as Automation;
const row = (rev = 4): AutomationRow =>
  ({ ...automation(rev), permissions: { manage: true } }) as unknown as AutomationRow;
const runRow = (n: number): AutomationRunRow =>
  ({
    id: `run-${n}`,
    automationCode: "AUD-A1",
    n,
    code: `AUD-A1 #${n}`,
    cursor: null,
  }) as unknown as AutomationRunRow;

const conflict = (code: string) => new ApiError(409, code, code);

function fakeApi(over: Partial<AutomationsApi> = {}) {
  const calls: string[] = [];
  const log = (s: string) => calls.push(s);
  const api: AutomationsApi = {
    list: async (q) => (log(`GET list ${JSON.stringify(q)}`), { items: [row()] }),
    get: async (code) => (
      log(`GET ${code}`),
      { automation: row(), configErrors: [], liveErrors: [], runs: [] } as AutomationDetail
    ),
    check: async (code, flow) => (
      log(`POST ${code}/check ${flow.titleTemplate}`),
      { issues: [] }
    ),
    create: async (body) => (
      log(`POST create ${JSON.stringify(body)}`),
      automation(1, { id: "a-2", code: "AUD-A2" })
    ),
    saveDraft: async (code, body) => (
      log(`PUT ${code}/draft ${body.expectedRev}`),
      automation(body.expectedRev! + 1)
    ),
    patch: async (code, body) => (log(`PATCH ${code} ${JSON.stringify(body)}`), automation(4)),
    publish: async (code, body) => (log(`POST ${code}/publish ${body.expectedRev}`), automation(4)),
    activate: async (code, body) => (
      log(`POST ${code}/activate ${body.expectedRev}`),
      automation(4)
    ),
    pause: async (code) => (log(`POST ${code}/pause`), automation(4)),
    duplicate: async (code, body) => (
      log(`POST ${code}/duplicate ${JSON.stringify(body)}`),
      automation(1, { id: "a-3", code: "AUD-A3" })
    ),
    deleteDraft: async (code, body) => void log(`DELETE ${code}/draft ${body.expectedRev}`),
    runs: async (q) => (log(`GET runs ${JSON.stringify(q)}`), { items: [runRow(2)] }),
    startRun: async (code, body) => (log(`POST ${code}/runs ${JSON.stringify(body)}`), runRow(3)),
    cancelRun: async (code, n) => void log(`POST ${code}/runs/${n}/cancel`),
    retryStep: async (code, n) => void log(`POST ${code}/runs/${n}/retry`),
    skipStep: async (code, n) => void log(`POST ${code}/runs/${n}/skip`),
    chooseProject: async (code, n, body) =>
      void log(`POST ${code}/runs/${n}/project ${JSON.stringify(body)}`),
    projectAutomations: async (projectId) => {
      log(`GET project ${projectId}`);
      throw new ApiError(404, "not_found", "not_found");
    },
    origin: async (q) => (log(`GET origin ${JSON.stringify(q)}`), { visible: false }),
    myRuns: async () => ({ items: [] }),
    myApprovals: async () => ({ items: [] }),
    run: async (code, n) => ({ ...runRow(n), automationCode: code }) as never,
    approve: async () => {},
    reject: async () => {},
    ...over,
  };
  return { api, calls };
}

describe("il livello dati delle Automations sulle rotte vere", () => {
  it("l'elenco passa i filtri al server, e da lì le pagine arrivano per id alle rotte per codice", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    expect(
      (await r.listAutomations({ projectId: "prj-1", status: "draft", ownerId: "ada" })).map(
        (a) => a.id,
      ),
    ).toEqual(["a-1"]);
    await r.getAutomation("a-1");
    expect(calls).toEqual([
      `GET list {"project":"prj-1","status":"draft","owner":"ada"}`,
      "GET AUD-A1",
    ]);
  });

  it("un'automazione mai letta o invisibile: null, come il prototipo", async () => {
    const { api, calls } = fakeApi({
      get: async () => {
        throw new ApiError(404, "not_found", "not_found");
      },
    });
    const r = createRealAutomations(api);
    expect(await r.getAutomation("a-1")).toBeNull();
    expect(calls).toEqual([]);
    await r.listAutomations();
    expect(await r.getAutomation("a-1")).toBeNull();
  });

  it("salvare la bozza: PUT col rev che il costruttore dice; la risposta dà il rev per pubblicare", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    await r.listAutomations();
    const saved = await r.saveDraft("a-1", FLOW, {}, { expected: 7 });
    expect(saved.versions.at(-1)!.rev).toBe(8);
    await r.publish("a-1");
    // Anche la pubblicazione dà il rev nuovo (4, nel finto): lo usa la scrittura dopo.
    await r.activate("a-1");
    expect(calls.slice(1)).toEqual([
      "PUT AUD-A1/draft 7",
      "POST AUD-A1/publish 8",
      "POST AUD-A1/activate 4",
    ]);
  });

  it("il 409 stale sulla bozza è `invalid: stale` (il costruttore offre «ricarica» e non butta il testo)", async () => {
    const { api } = fakeApi({
      saveDraft: async () => {
        throw new ApiError(409, "stale", "stale", { details: { rev: 9 } });
      },
    });
    const r = createRealAutomations(api);
    await r.listAutomations();
    await expect(r.saveDraft("a-1", FLOW, {}, { expected: 4 })).rejects.toThrow(/^invalid: stale$/);
  });

  it("pubblicare con errori di configurazione: `invalid: config`; senza permesso: `forbidden`", async () => {
    const { api } = fakeApi({
      publish: async () => {
        throw conflict("config");
      },
      activate: async () => {
        throw new ApiError(403, "forbidden", "forbidden");
      },
    });
    const r = createRealAutomations(api);
    await r.listAutomations();
    await expect(r.publish("a-1")).rejects.toThrow(/^invalid: config$/);
    await expect(r.activate("a-1")).rejects.toThrow(/^forbidden$/);
  });

  it("gli errori di un flusso non ancora salvato li dice il server", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    await r.listAutomations();
    expect(await r.checkDraft("a-1", FLOW)).toEqual([]);
    expect(calls.at(-1)).toBe("POST AUD-A1/check x");
  });

  it("creare: solo da zero (P2 = a); nome e progetto, e il codice nuovo si ricorda", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    const a = await r.createAutomation({ name: "Nuova", projectId: "prj-1" });
    await r.getAutomation(a.id);
    expect(calls).toEqual([`POST create {"name":"Nuova","projectId":"prj-1"}`, "GET AUD-A2"]);
    await expect(
      r.createAutomation({ name: "Da modello", projectId: "prj-1", template: "newContract" }),
    ).rejects.toThrow(/^invalid: not_available$/);
    // Le automazioni generali sono della F4: niente richiesta.
    await expect(r.createAutomation({ name: "Generale", projectId: null })).rejects.toThrow(
      /^invalid: not_available$/,
    );
    expect(calls).toHaveLength(2);
  });

  it("rinomina, pausa, duplica, elimina la bozza col rev", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    await r.listAutomations();
    await r.renameAutomation("a-1", { name: "Altro" });
    await r.pause("a-1");
    await r.duplicateAutomation("a-1", { version: 1, name: "Copia" });
    await r.deleteDraft("a-1", { expected: 4 });
    expect(calls.slice(1)).toEqual([
      `PATCH AUD-A1 {"name":"Altro"}`,
      "POST AUD-A1/pause",
      `POST AUD-A1/duplicate {"version":1,"name":"Copia"}`,
      "DELETE AUD-A1/draft 4",
    ]);
  });

  it("le esecuzioni: Run now dà l'id, e annulla/riprova/salta vanno per codice e numero", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    await r.listAutomations();
    const id = await r.startManual("a-1", { avvio: { data: "2026-11-13" } });
    expect(id).toBe("run-3");
    await r.listRuns({ automationId: "a-1", status: "failed" });
    await r.cancelRun("run-3");
    await r.retryStep("run-2");
    await r.skipStep("run-2");
    await r.chooseProject("run-2", "prj-9", { expectedPath: "0" });
    expect(calls.slice(1)).toEqual([
      `POST AUD-A1/runs {"event":{"avvio":{"data":"2026-11-13"}}}`,
      `GET runs {"automation":"AUD-A1","status":"failed"}`,
      "POST AUD-A1/runs/3/cancel",
      "POST AUD-A1/runs/2/retry",
      "POST AUD-A1/runs/2/skip",
      `POST AUD-A1/runs/2/project {"projectId":"prj-9","expectedPath":"0","expectedRound":0}`,
    ]);
  });

  it("la sezione del progetto invisibile: null; la riga d'origine di una task e di un traguardo", async () => {
    const { api, calls } = fakeApi();
    const r = createRealAutomations(api);
    expect(await r.getProjectAutomations("prj-1")).toBeNull();
    expect(
      await r.automationOrigin({ automationId: "a-1", runId: "run-1" }, "AUD-12", "task"),
    ).toEqual({ visible: false });
    await r.automationOrigin({ automationId: "a-1", runId: "run-1" }, "m-1", "milestone");
    expect(calls).toEqual([
      "GET project prj-1",
      `GET origin {"task":"AUD-12"}`,
      `GET origin {"milestone":"m-1"}`,
    ]);
  });
});
