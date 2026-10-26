import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visitSteps } from "../../domain/automations/fields";
import { automations, resetApi, setLatency } from "../api";
import { AUTOMATION_CASES } from "../seed/automations";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { Step } from "../types";
import { resetViewerGrants } from "../viewer";

// Il costruttore (Task 6): le bozze dai modelli (shape builder [A 20]), gli
// errori di una bozza non ancora salvata e il salvataggio che si ferma se un
// altro ha cambiato la bozza nel frattempo ([A 12]).

const as = (personId: string) => setSessionPersonId(personId);
const A = AUTOMATION_CASES.automations;
const auto = (id: string) => state.automations.find((a) => a.id === id)!;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  as("p-giulia");
});

describe("modelli", () => {
  it("«New contract»: il flusso dell'esempio con sorgente, approvatori e reparti vuoti", async () => {
    as("p-roberta");
    const a = await automations.createAutomation({
      name: "Contratti",
      projectId: null,
      template: "newContract",
    });
    const flow = a.versions[0]!.flow;
    expect(flow.trigger).toEqual({ kind: "source", sourceId: "", event: "deal_won" });
    const steps: Step[] = [];
    visitSteps(flow.steps, (s) => steps.push(s));
    expect(steps.map((s) => s.kind)).toContain("claude");
    for (const s of steps) {
      if ("approval" in s && s.approval.mode === "ask" && "personId" in s.approval.who)
        expect(s.approval.who).toEqual({ personId: "" });
      if (s.kind === "createTask" && s.assignee && "departmentId" in s.assignee)
        expect(s.assignee.departmentId).toBe("");
    }
    // Chi approva: mai una persona del seme; «il proprietario» non è una scelta personale e resta.
    expect(steps.find((s) => s.id === "nc-welcome")).toMatchObject({
      approval: { mode: "ask", who: { owner: true } },
    });
    // Nessuna persona del seme: approvazioni e reparti sono problemi da completare.
    expect(JSON.stringify(flow)).not.toMatch(/p-[a-z]+|dep-[a-z]+/);
    const detail = await automations.getAutomation(a.id);
    const codes = detail!.configErrors.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain("trigger:unknown_ref");
    expect(detail!.configErrors.some((i) => i.message === "Manca l'incaricato.")).toBe(true);
  });

  it("«Ask the client»: ripeti con il suo massimo, l'attesa della risposta, Claude con due uscite", async () => {
    as("p-laura");
    const a = await automations.createAutomation({
      name: "Dati",
      projectId: "prj-stw",
      template: "askClient",
    });
    const flow = a.versions[0]!.flow;
    expect(flow.trigger).toEqual({ kind: "source", sourceId: "", event: "webhook" });
    const kinds: string[] = [];
    visitSteps(flow.steps, (s) => kinds.push(s.kind));
    expect(kinds).toEqual(expect.arrayContaining(["sendEmail", "wait", "repeatUntil", "claude"]));
  });
});

describe("modelli in inglese", () => {
  it("oggetti, corpi, istruzioni, uscite e campi di Claude nella lingua di chi crea", async () => {
    as("p-laura");
    const a = await automations.createAutomation({
      name: "Data",
      projectId: "prj-stw",
      template: "askClient",
      language: "en",
    });
    const flow = a.versions[0]!.flow;
    expect(flow.titleTemplate).toBe("Data for {{richiesta.funzione}} – {{cliente.nome}}");
    const steps: Step[] = [];
    visitSteps(flow.steps, (s) => steps.push(s));
    expect(steps.find((s) => s.id === "cd-ask")).toMatchObject({
      subject: "We need some information to activate {{richiesta.funzione}}",
    });
    const verify = steps.find((s) => s.id === "cd-verify") as Extract<Step, { kind: "claude" }>;
    expect(verify.outcomes).toEqual(["all present", "something is missing"]);
    expect(Object.keys(verify.branches)).toEqual(["all present", "something is missing"]);
    expect(verify.fields[0]!.label).toBe("What is missing");
    // Nessun testo italiano rimasto nei testi del flusso.
    expect(JSON.stringify(flow)).not.toMatch(/Gentile|Grazie|mancano|Promemoria/);
    // Si traducono i nomi, non la struttura: gli stessi problemi del modello italiano.
    const it = await automations.createAutomation({
      name: "Dati",
      projectId: "prj-stw",
      template: "askClient",
    });
    expect((await automations.getAutomation(a.id))!.configErrors.map((i) => i.code)).toEqual(
      (await automations.getAutomation(it.id))!.configErrors.map((i) => i.code),
    );
  });
});

describe("checkDraft", () => {
  it("gli errori di un flusso non ancora salvato, come li vedrebbe la bozza", async () => {
    as("p-matteo");
    const live = auto(A.newContract).versions.at(-1)!.flow;
    expect(await automations.checkDraft(A.newContract, live)).toEqual([]);
    // Il traguardo spostato dopo il «Per ogni»: le task non lo trovano più.
    const moved = structuredClone(live);
    const [milestone] = moved.steps.splice(1, 1);
    moved.steps.splice(2, 0, milestone!);
    const issues = await automations.checkDraft(A.newContract, moved);
    expect(issues.some((i) => i.code === "unknown_ref" && i.path.startsWith("1/"))).toBe(true);
    // Non scrive niente.
    expect(auto(A.newContract).versions.at(-1)!.flow).toEqual(live);
  });

  it("chi non vede l'automazione: not_found", async () => {
    as("p-laura");
    await expect(
      automations.checkDraft(A.newContract, auto(A.newContract).versions[0]!.flow),
    ).rejects.toThrow("not_found");
  });
});

describe("saveDraft con la bozza attesa ([A 12])", () => {
  it("scrive chi e quando; un altro che ha salvato dopo ferma il salvataggio", async () => {
    as("p-matteo");
    const before = auto(A.newContract).versions.at(-1)!;
    const base = before.rev ?? null;
    const flow = structuredClone(before.flow);
    flow.titleTemplate = "Matteo";
    const saved = await automations.saveDraft(A.newContract, flow, {}, { expected: base });
    const draft = saved.versions.at(-1)!;
    expect(draft.savedById).toBe("p-matteo");
    expect(draft.savedAt).toBeTruthy();

    as("p-roberta");
    flow.titleTemplate = "Roberta";
    // Roberta aveva aperto la bozza prima del salvataggio di Matteo.
    await expect(
      automations.saveDraft(A.newContract, flow, {}, { expected: base }),
    ).rejects.toThrow("invalid: stale");
    expect(auto(A.newContract).versions.at(-1)!.flow.titleTemplate).toBe("Matteo");
    // Ricaricata, salva.
    await automations.saveDraft(A.newContract, flow, {}, { expected: draft.rev! });
    expect(auto(A.newContract).versions.at(-1)!.flow.titleTemplate).toBe("Roberta");
  });

  it("la stessa persona non si ferma da sola (due salvataggi di fila)", async () => {
    as("p-matteo");
    const flow = structuredClone(auto(A.newContract).versions.at(-1)!.flow);
    const base = auto(A.newContract).versions.at(-1)!.rev ?? null;
    await automations.saveDraft(A.newContract, flow, {}, { expected: base });
    await expect(
      automations.saveDraft(A.newContract, flow, {}, { expected: base }),
    ).resolves.toBeTruthy();
  });

  it("su un'attiva senza bozza: la bozza nata da un altro nel frattempo ferma il salvataggio", async () => {
    as("p-matteo");
    const a = auto(A.clientData);
    expect(a.versions.at(-1)!.publishedAt).not.toBeNull();
    const flow = structuredClone(a.versions[0]!.flow);
    await automations.saveDraft(A.clientData, flow, {}, { expected: null });
    as("p-roberta");
    await expect(automations.saveDraft(A.clientData, flow, {}, { expected: null })).rejects.toThrow(
      "invalid: stale",
    );
  });

  it("la bozza non cambia le esecuzioni in corso né la versione pubblicata", async () => {
    as("p-matteo");
    const a = auto(A.newContract);
    const published = structuredClone(a.versions[0]!.flow);
    const runs = state.automationRuns.filter((r) => r.automationId === a.id);
    const versions = runs.map((r) => r.version);
    const flow = structuredClone(a.versions.at(-1)!.flow);
    flow.steps = [];
    await automations.saveDraft(A.newContract, flow);
    expect(a.versions[0]!.flow).toEqual(published);
    expect(
      state.automationRuns.filter((r) => r.automationId === a.id).map((r) => r.version),
    ).toEqual(versions);
  });
});
