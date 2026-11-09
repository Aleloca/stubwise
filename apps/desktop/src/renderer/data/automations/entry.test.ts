import { beforeEach, describe, expect, it } from "vitest";
import { automations, resetApi, setLatency } from "../api";
import { AUTOMATION_CASES } from "../seed/automations";
import { NEW_CONTRACT_MILESTONE_ID } from "../seed/automations/created";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantProjectRole } from "../viewer";

// I punti d'ingresso (Task 8): il blocco Home, la sezione del progetto,
// l'origine di task e traguardi, l'anteprima condivisa del passo da approvare.

const as = (personId: string) => setSessionPersonId(personId);
const A = AUTOMATION_CASES.automations;
const R = AUTOMATION_CASES.runs;
const AUD = "prj-aud";
const CBV = "prj-cbv";
const run = (id: string) => state.automationRuns.find((r) => r.id === id)!;
const leave = (personId: string, projectId: string) => {
  const p = state.projectsById.get(projectId)!;
  p.memberIds = p.memberIds.filter((id) => id !== personId);
};

beforeEach(() => {
  setLatency(0);
  resetApi();
  as("p-giulia");
});

describe("listMyRuns: solo le esecuzioni che mi riguardano [A 25]", () => {
  it("Matteo: prima quelle che aspettano lui, poi le fallite che gestisce, poi le sue in corso", async () => {
    as("p-matteo");
    const mine = await automations.listMyRuns();
    // Dalla più recente dentro ogni gruppo. La fallita di BTG-A1 non c'è:
    // Matteo non è più membro di BTG, non la gestisce (né la vede).
    expect(mine.map((r) => [r.id, r.concern])).toEqual([
      [R.waitingProject, "waiting_me"],
      [R.waitingApproval, "waiting_me"],
      [R.waitingEvent, "owner"],
    ]);
    // Le finite che non lo aspettano non ci sono.
    expect(mine.map((r) => r.id)).not.toContain(R.done);
  });

  it("chi gestisce l'automazione ha le sue esecuzioni fallite", async () => {
    grantProjectRole("p-giulia", "prj-btg", "project_lead");
    const btg = state.projectsById.get("prj-btg")!;
    if (!btg.memberIds.includes("p-giulia")) btg.memberIds.push("p-giulia");
    expect((await automations.listMyRuns()).map((r) => [r.id, r.concern])).toEqual([
      [R.failed, "failed"],
    ]);
  });

  it("Giulia (membro di AUD, non proprietaria né approvatrice) non ha niente, pur vedendo le esecuzioni", async () => {
    expect((await automations.listRuns({ projectId: AUD })).length).toBeGreaterThan(0);
    expect(await automations.listMyRuns()).toEqual([]);
  });

  it("un approvatore che perde l'accesso al progetto non ha più la riga «aspetta me»", async () => {
    as("p-matteo");
    leave("p-matteo", AUD);
    const mine = await automations.listMyRuns();
    expect(mine.find((r) => r.id === R.waitingApproval)).toBeUndefined();
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toEqual([R.waitingProject]);
  });
});

describe("getProjectAutomations: la sezione del progetto [A 22] [A 23]", () => {
  it("AUD per Giulia: l'automazione del progetto e le sue esecuzioni non finite, senza poter creare", async () => {
    const view = (await automations.getProjectAutomations(AUD))!;
    expect(view.show).toBe(true);
    expect(view.canCreate).toBe(false);
    expect(view.automations.map((a) => a.code)).toEqual(["AUD-A1"]);
    expect(view.runs.every((r) => r.linkable && r.automationCode === "AUD-A1")).toBe(true);
    expect(view.runs.map((r) => r.id).sort()).toEqual([R.waitingApproval, R.waitingEvent].sort());
    expect(view.general).toEqual([]);
  });

  it("una generale che ha agito qui: chi non la vede ha l'esecuzione senza nome né link, chi la vede anche l'automazione", async () => {
    run(R.waitingProject).projectIds = [CBV];
    as("p-sara");
    const sara = (await automations.getProjectAutomations(CBV))!;
    expect(sara.show).toBe(true);
    const row = sara.runs.find((r) => r.id === R.waitingProject)!;
    expect(row).toMatchObject({ code: "AUT-1 #2", linkable: false, automationName: "" });
    expect(row.title).not.toBe("");
    // Nessun registro, evento o variabile nella riga.
    expect(Object.keys(row).sort()).toEqual(
      [
        "automationCode",
        "automationName",
        "code",
        "id",
        "linkable",
        "n",
        "startedAt",
        "status",
        "title",
      ].sort(),
    );
    expect(sara.general).toEqual([]);

    as("p-matteo");
    const matteo = (await automations.getProjectAutomations(CBV))!;
    expect(matteo.runs.find((r) => r.id === R.waitingProject)).toMatchObject({
      linkable: true,
      automationName: "Nuovo contratto",
    });
    expect(matteo.general).toEqual([expect.objectContaining({ code: "AUT-1", runCount: 2 })]);
  });

  it("niente automazioni né esecuzioni: la voce c'è solo per chi può crearne", async () => {
    const view = (await automations.getProjectAutomations("prj-stw"))!;
    // STW ha la bozza STW-A1: la vede ogni membro.
    expect(view.automations.map((a) => a.code)).toEqual(["STW-A1"]);
    state.automations = state.automations.filter((a) => a.projectId !== "prj-stw");
    expect((await automations.getProjectAutomations("prj-stw"))!.show).toBe(false);
    grantProjectRole("p-giulia", "prj-stw", "project_lead");
    expect(await automations.getProjectAutomations("prj-stw")).toMatchObject({
      show: true,
      canCreate: true,
    });
  });

  it("`show` segue ciò che questa persona riceve: una generale finita che non vede non basta", async () => {
    // In CBV ha agito solo AUT-1 #1, finita: Sara non vede AUT-1 né ha esecuzioni aperte.
    as("p-sara");
    expect(await automations.getProjectAutomations(CBV)).toMatchObject({
      show: false,
      runs: [],
      general: [],
    });
    // Roberta (admin) vede la generale che vi ha agito.
    as("p-roberta");
    expect((await automations.getProjectAutomations(CBV))!.show).toBe(true);
  });

  it("un progetto che non vedo risponde come uno che non esiste (R-G5)", async () => {
    as("p-sara");
    expect(await automations.getProjectAutomations(AUD)).toBeNull();
    expect(await automations.getProjectAutomations("prj-nope")).toBeNull();
  });
});

describe("automationOrigin: «Created by automation…» [A 24]", () => {
  const ref = { automationId: A.newContract, runId: R.done };

  it("chi vede l'automazione ha codice, nome, numero e la riga del registro che l'ha creata", async () => {
    as("p-matteo");
    const task = await automations.automationOrigin(ref, "CBV-6");
    expect(task).toMatchObject({ visible: true, code: "AUT-1", name: "Nuovo contratto", n: 1 });
    expect(task.visible && task.entry).toBeTruthy();
    const ms = await automations.automationOrigin(ref, NEW_CONTRACT_MILESTONE_ID);
    expect(ms.visible && ms.entry).toBeTruthy();
  });

  it("chi non la vede sa solo che l'ha creata un'automazione", async () => {
    as("p-sara");
    expect(await automations.automationOrigin(ref, "CBV-6")).toEqual({ visible: false });
    expect(
      await automations.automationOrigin({ automationId: "nope", runId: R.done }, "CBV-6"),
    ).toEqual({ visible: false });
  });
});

describe("l'anteprima condivisa del passo da approvare", () => {
  it("l'email in attesa: da, a, oggetto e testo come li vedrà chi riceve", async () => {
    as("p-matteo");
    const [d] = (await automations.listMyApprovals()).filter((x) => x.runId === R.waitingApproval);
    expect(d!.effect).toMatchObject({
      kind: "email",
      to: "amministrazione@cantinabellavista.example",
      subject: "Mancano ancora alcuni dati per Centralino AI",
    });
    expect(d).toMatchObject({ automationCode: "AUD-A1", n: 1, automationVisible: true });
    const detail = (await automations.getRun(R.waitingApproval))!;
    expect(detail.pendingEffect).toEqual(d!.effect);
  });

  it("«scegli il progetto» porta il cliente, e nessuna anteprima", async () => {
    as("p-matteo");
    const d = (await automations.listMyApprovals()).find((x) => x.runId === R.waitingProject)!;
    expect(d.clientName).not.toBe("");
    expect(d.effect).toBeNull();
  });
});

describe("R-J8 con l'«Undo»: la decisione vale per il passo su cui si è cliccato", () => {
  it("con un passo diverso da quello in attesa: not_waiting, e niente cambia", async () => {
    as("p-matteo");
    const before = run(R.waitingApproval).log.length;
    await expect(
      automations.approve(R.waitingApproval, { subject: "x" }, { expectedPath: "0" }),
    ).rejects.toThrow("invalid: not_waiting");
    await expect(automations.reject(R.waitingApproval, { expectedPath: "0" })).rejects.toThrow(
      "invalid: not_waiting",
    );
    await expect(
      automations.chooseProject(R.waitingProject, AUD, { expectedPath: "nope" }),
    ).rejects.toThrow("invalid: not_waiting");
    await automations.whenAutomationsIdle();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
    expect(run(R.waitingApproval).log).toHaveLength(before);
    // Col passo giusto passa.
    const cursor = run(R.waitingApproval).cursor!;
    await automations.approve(R.waitingApproval, undefined, { expectedPath: cursor });
    await automations.whenAutomationsIdle();
    expect(run(R.waitingApproval).status).not.toBe("waiting_approval");
  });
});
