import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __secretValuesForTest } from "../admin/secrets";
import { accessState } from "../access/index";
import { configErrorsOf } from "../automations/reads";
import { visiblePeopleFor, whoCan } from "../access/whoCan";
import { currentWeek } from "../../domain/weeks";
import {
  access,
  automations,
  changelog,
  docs,
  listClaudeDecisions,
  listConversations,
  listDayArrangements,
  listMilestones,
  listPinnedProjectIds,
  listPortfolioActivity,
  listRequestsToConvert,
  listStalled,
  listTasks,
  listWaitingOnMeProjectIds,
  instance,
  listNotifications,
  listProjects,
  projectSettings,
  resetApi,
  search,
  servers,
  setLatency,
  startRun,
} from "../api";
import { markReauthenticated } from "../auth/reauth";
import { repositoryById } from "../docs/reads";
import type { Release } from "../model";
import { createProject } from "../api-mutations";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { archivedProjectIdsFor, now, signalAutomations, state, visibleProjectIds } from "../store";
import { whenIdle } from "../stream";
import type { AutomationFlow } from "../types";
import { grantInstancePermission, grantProjectPermission, grantProjectRole } from "../viewer";

// Archivia, riapri, elimina (area 9c, Task 5), livello dati. Persone del
// seme: Laura (Project Lead in ACQ, mai membro di RNC), Sara (Contributor
// in ACQ: senza `repos.view`, mai membro di RNC), Giulia (Project Lead in
// RNC, l'archiviato del seme), Roberta (full admin), Paolo (in nessuno dei
// due). RNC ha `shop-frontend` su «GitHub Shop», il server SRV-5 e un file
// d'ambiente di produzione.

const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const PAOLO = "p-paolo";
const ACQ = "prj-acq";
const RNC = "prj-rnc";

const as = (personId: string) => setSessionPersonId(personId);
const project = (id: string) => state.projectsById.get(id)!;
const idle = () => automations.whenAutomationsIdle();

async function settle(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await whenIdle(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Le stringhe dello stato (Map, Set, array, oggetti) che contengono `needle`, col loro percorso. */
function scan(value: unknown, path: string, needle: string, out: string[]): void {
  if (typeof value === "string") {
    if (value.includes(needle)) out.push(path);
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      scan(k, `${path}<key>`, needle, out);
      scan(v, `${path}[${String(k)}]`, needle, out);
    }
  } else if (value instanceof Set) {
    for (const v of value) scan(v, `${path}{}`, needle, out);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, needle, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`, needle, out);
  }
}

/** Ciò che un rifiuto non deve toccare. */
const snapshot = () =>
  JSON.stringify({
    projects: state.projects,
    changelog: state.changelog.length,
    repositories: state.repositories,
    detached: state.detachedRepositories,
    deleted: state.deletedProjects,
    tasks: state.tasks.length,
    runs: state.automationRuns,
  });

/** Un rilascio di ACQ appena mergiato: senza run lette, nei primi 30 minuti è «running». */
function runningRelease(): Release {
  return {
    id: "rel-acq-test",
    code: "ACQ-V1",
    projectId: ACQ,
    repositoryId: "repo-acq",
    pr: { ...state.releases[0]!.pr },
    title: "Bill download fix",
    mergeSha: "0123456789abcdef0123456789abcdef01234567",
    mergedAt: now(),
    mergedById: LAURA,
    mergedGitName: "Laura Costa",
    viaStubwise: true,
    runs: [],
    seenInProductionAt: null,
    fixTaskId: null,
  };
}

/** Un'automazione di ACQ accesa, a nome di Laura, che aspetta un giorno: le sue esecuzioni restano aperte. */
async function acqAutomation(trigger: AutomationFlow["trigger"] = { kind: "manual" }) {
  as(LAURA);
  const a = await automations.createAutomation({
    name: "Reminder",
    projectId: ACQ,
    flow: { trigger, steps: [{ id: "w", kind: "wait", for: { days: 1 } }], titleTemplate: "Wait" },
  });
  await automations.activate(a.id);
  return a.id;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  await idle();
  resetApi();
});

describe("RF 4: busy", () => {
  it("una sessione task_run viva di ACQ → busy col suo codice; lo stato non cambia", async () => {
    as(LAURA);
    const run = await startRun("t-acq-3");
    const before = snapshot();
    expect(await projectSettings.archiveProject(ACQ)).toEqual({
      ok: false,
      error: "busy",
      reasons: [
        {
          kind: "claude_session",
          code: state.tasksById.get("t-acq-3")!.code,
          title: run.title,
          waiting: false,
        },
      ],
    });
    expect(snapshot()).toBe(before);
    await settle(run.id);
  });

  it("la stessa sessione in attesa per la coda in pausa → busy con waiting: true", async () => {
    as(ROBERTA);
    await instance.pauseQueue(ACQ);
    as(LAURA);
    const run = await startRun("t-acq-3");
    expect(state.conversations.find((c) => c.id === run.id)!.waiting).toBeTruthy();
    const r = await projectSettings.archiveProject(ACQ);
    expect(r).toMatchObject({
      ok: false,
      error: "busy",
      reasons: [
        { kind: "claude_session", code: state.tasksById.get("t-acq-3")!.code, waiting: true },
      ],
    });
  });

  it("un rilascio in corso → busy col suo codice", async () => {
    state.releases.push(runningRelease());
    as(LAURA);
    expect(await projectSettings.archiveProject(ACQ)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "release", code: "ACQ-V1" }],
    });
  });

  it("una sessione finita non conta: ACQ ha cv-run-acq-3 finita e si archivia", async () => {
    expect(state.conversations.find((c) => c.id === "cv-run-acq-3")!.state).toBe("finished");
    as(LAURA);
    expect(projectSettings.busyReasonsOf(ACQ)).toEqual([]);
    expect(await projectSettings.archiveProject(ACQ)).toEqual({ ok: true });
  });

  it("P23: chi non vede la sessione legge title e code null", async () => {
    as(LAURA);
    const run = await startRun("t-acq-3");
    grantProjectPermission(SARA, ACQ, "project.settings.manage" as never);
    as(SARA);
    const r = await projectSettings.archiveProject(ACQ);
    expect(r).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "claude_session", code: null, title: null, waiting: false }],
    });
    expect(JSON.stringify(r)).not.toContain(run.title);
    await settle(run.id);
  });
});

describe("archiviare ACQ", () => {
  it("nessuno lo vede più; i suoi membri e i full admin lo ritrovano da archiviato, Claude no", async () => {
    expect(project(ACQ).memberIds).not.toContain(PAOLO);
    as(LAURA);
    expect(await projectSettings.archiveProject(ACQ)).toEqual({ ok: true });
    expect(project(ACQ).archived).toEqual({ at: now(), byId: LAURA });
    for (const person of [LAURA, SARA, GIULIA, ROBERTA, PAOLO, CLAUDE_ID])
      expect(visibleProjectIds(person).has(ACQ)).toBe(false);
    expect(archivedProjectIdsFor(LAURA).has(ACQ)).toBe(true);
    expect(archivedProjectIdsFor(SARA).has(ACQ)).toBe(true);
    expect(archivedProjectIdsFor(ROBERTA).has(ACQ)).toBe(true);
    expect(archivedProjectIdsFor(PAOLO).has(ACQ)).toBe(false);
    expect(archivedProjectIdsFor(CLAUDE_ID).size).toBe(0);
    // La voce, nel progetto, col codice.
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "project.archived",
      actorId: LAURA,
      projectId: ACQ,
      object: { type: "project", id: ACQ, label: "ACQ" },
    });
  });

  it("already_archived, forbidden senza project.settings.manage, not_found per chi non lo vede", async () => {
    as(LAURA);
    await projectSettings.archiveProject(ACQ);
    expect(await projectSettings.archiveProject(ACQ)).toEqual({
      ok: false,
      error: "invalid",
      reason: "already_archived",
    });
    as(PAOLO);
    expect(await projectSettings.archiveProject("prj-stw")).toEqual({
      ok: false,
      error: "not_found",
    });
    as(SARA);
    expect(await projectSettings.archiveProject("prj-stw")).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("RF 1: liste, ⌘K, notifiche, Who can?, Stato dell'istanza e Usage non nominano ACQ", async () => {
    as(LAURA);
    const notesBefore = (await listNotifications()).filter((n) => n.projectId === ACQ);
    expect(notesBefore.length).toBeGreaterThan(0);
    as(ROBERTA);
    const usage = (input: { groupBy: "project" }) =>
      instance.getUsage({ range: { days: 90 }, ...input });
    const before = await usage({ groupBy: "project" });
    const acqCost = before.rows.find((r) => r.key === ACQ)!.costUsd;
    const otherBefore = before.rows.find((r) => r.key === "other")?.costUsd ?? 0;
    expect(acqCost).toBeGreaterThan(0);

    as(LAURA);
    await projectSettings.archiveProject(ACQ);

    expect((await listProjects()).map((p) => p.code)).not.toContain("ACQ");
    for (const q of ["ACQ", "Acquedotto"]) {
      const found = JSON.stringify(await search(q));
      expect(found).not.toContain("ACQ");
      expect(found).not.toContain(ACQ);
    }
    const notes = await listNotifications();
    expect(notes.filter((n) => n.projectId === ACQ)).toEqual([]);
    expect(notes.filter((n) => n.objectCode.startsWith("ACQ"))).toEqual([]);
    // La scelta del progetto di Who can? non lo elenca, per nessuno (P10).
    for (const person of [LAURA, ROBERTA]) {
      as(person);
      const choices = await access.whoCanChoices();
      expect(choices.projects.map((p) => p.code)).not.toContain("ACQ");
    }
    // Chi non ne era membro non ha risposta (P10: ai membri sì, per Reopen).
    expect(whoCan(PAOLO, "manageProjectSettings", ACQ)).toEqual({ visible: false });

    as(ROBERTA);
    const status = JSON.stringify(await instance.getInstanceStatus());
    expect(status).not.toContain("ACQ");
    expect(status).not.toContain(ACQ);
    const after = await usage({ groupBy: "project" });
    expect(after.rows.map((r) => r.key)).not.toContain(ACQ);
    expect(after.rows.map((r) => r.code ?? null)).not.toContain("ACQ");
    expect(after.rows.find((r) => r.key === "other")!.costUsd).toBeCloseTo(
      otherBefore + acqCost,
      5,
    );

    as(LAURA);
    await expect(startRun("t-acq-1")).rejects.toThrow("not_found");
  });

  it("un evento di ACQ non fa partire le sue automazioni", async () => {
    const id = await acqAutomation({ kind: "stubwise", event: "task_created" });
    signalAutomations({ kind: "task_created", taskId: "t-acq-1" });
    await idle();
    const runsOf = () => state.automationRuns.filter((r) => r.automationId === id);
    expect(runsOf()).toHaveLength(1);
    await projectSettings.archiveProject(ACQ);
    signalAutomations({ kind: "task_created", taskId: "t-acq-2" });
    await idle();
    expect(runsOf()).toHaveLength(1);
  });

  it("una ricorrenza di ACQ non parte da archiviato; riaperto, riparte", async () => {
    const id = await acqAutomation({ kind: "schedule", rule: "FREQ=DAILY;BYHOUR=9" });
    await projectSettings.archiveProject(ACQ);
    as(ROBERTA);
    await automations.runDueSchedules();
    await idle();
    const runsOf = () => state.automationRuns.filter((r) => r.automationId === id);
    expect(runsOf()).toHaveLength(0);
    as(LAURA);
    await projectSettings.reopenProject(ACQ);
    as(ROBERTA);
    await automations.runDueSchedules();
    await idle();
    expect(runsOf()).toHaveLength(1);
  });

  it("un'automazione generale che agisce su ACQ archiviato finisce non riuscita (Needs attention)", async () => {
    as(ROBERTA);
    const a = await automations.createAutomation({
      name: "Into ACQ",
      projectId: null,
      flow: {
        trigger: { kind: "manual" },
        steps: [
          {
            id: "t",
            kind: "createTask",
            title: "From the general one",
            description: "",
            assignee: null,
            dueInDays: null,
            project: { mode: "fixed", projectId: ACQ },
            milestoneRef: null,
            approval: { mode: "auto" },
          },
        ],
        titleTemplate: "Into ACQ",
      },
    });
    await automations.activate(a.id);
    as(LAURA);
    await projectSettings.archiveProject(ACQ);
    as(ROBERTA);
    const runId = await automations.startManual(a.id);
    await idle();
    const run = state.automationRuns.find((r) => r.id === runId)!;
    expect(run.status).toBe("failed");
    // Task 6 ([PX 5]): la ragione è il progetto non più disponibile, non un permesso perso.
    expect(run.error).toBe("project_unavailable");
    expect(state.tasks.some((t) => t.title === "From the general one")).toBe(false);
    const mine = await automations.listMyRuns();
    expect(mine.find((r) => r.id === runId)?.concern).toBe("failed");
  });
});

describe("l'anteprima d'archiviazione e le automazioni aperte ([AR 3])", () => {
  it("due esecuzioni aperte → openAutomationRuns: 2; archiviando si annullano con «Project archived»", async () => {
    const id = await acqAutomation();
    const first = await automations.startManual(id);
    const second = await automations.startManual(id);
    await idle();
    expect(await projectSettings.getArchivePreview(ACQ)).toEqual({
      ok: true,
      openAutomationRuns: 2,
      busy: [],
    });
    expect(await projectSettings.archiveProject(ACQ)).toEqual({ ok: true });
    for (const runId of [first, second]) {
      const run = state.automationRuns.find((r) => r.id === runId)!;
      expect(run.status).toBe("cancelled");
      expect(run.endedAt).not.toBeNull();
      expect(run.log.at(-1)).toMatchObject({
        outcome: "cancelled",
        reason: "Project archived",
        why: { code: "projectArchived" },
        byId: LAURA,
      });
    }
  });

  it("con una sessione viva dà anche la ragione di busy; Sara → forbidden; un archiviato → not_found", async () => {
    as(LAURA);
    const run = await startRun("t-acq-3");
    expect(await projectSettings.getArchivePreview(ACQ)).toEqual({
      ok: true,
      openAutomationRuns: 0,
      busy: [
        {
          kind: "claude_session",
          code: state.tasksById.get("t-acq-3")!.code,
          title: run.title,
          waiting: false,
        },
      ],
    });
    as(SARA);
    expect(await projectSettings.getArchivePreview(ACQ)).toEqual({ ok: false, error: "forbidden" });
    as(GIULIA);
    expect(await projectSettings.getArchivePreview(RNC)).toEqual({ ok: false, error: "not_found" });
    as(PAOLO);
    expect(await projectSettings.getArchivePreview(ACQ)).toEqual({ ok: false, error: "not_found" });
    await settle(run.id);
  });
});

describe("Reopen", () => {
  it("tutto torna, notifiche comprese; un interruttore spento prima resta spento", async () => {
    as(LAURA);
    const settings = (await projectSettings.getProjectSettings(ACQ))!;
    await projectSettings.saveProjectAutomations(ACQ, {
      switches: { ...settings.switches, weeklyBrief: false },
      pulseEveryDays: settings.pulseEveryDays,
      correctionCap: settings.correctionCap,
    });
    const notes = (await listNotifications()).filter((n) => n.projectId === ACQ).map((n) => n.id);
    await projectSettings.archiveProject(ACQ);
    expect(await projectSettings.getProjectSettings(ACQ)).toBeNull();

    expect(await projectSettings.reopenProject(ACQ)).toEqual({ ok: true });
    expect(project(ACQ).archived ?? null).toBeNull();
    expect(visibleProjectIds(LAURA).has(ACQ)).toBe(true);
    expect(archivedProjectIdsFor(LAURA).has(ACQ)).toBe(false);
    expect((await listProjects()).map((p) => p.code)).toContain("ACQ");
    expect((await listNotifications()).filter((n) => n.projectId === ACQ).map((n) => n.id)).toEqual(
      notes,
    );
    const back = (await projectSettings.getProjectSettings(ACQ))!;
    expect(back.switches.weeklyBrief).toBe(false);
    expect(back.switches).toEqual({ ...settings.switches, weeklyBrief: false });
    expect(state.changelog.at(-1)).toMatchObject({ kind: "project.reopened", projectId: ACQ });
  });

  it("su un attivo → invalid not_archived; chi non ne era membro → not_found; senza permesso → forbidden", async () => {
    as(LAURA);
    expect(await projectSettings.reopenProject(ACQ)).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_archived",
    });
    as(SARA);
    expect(await projectSettings.reopenProject(RNC)).toEqual({ ok: false, error: "not_found" });
    as("p-marco");
    expect(archivedProjectIdsFor("p-marco").has(RNC)).toBe(true);
    expect(await projectSettings.reopenProject(RNC)).toEqual({ ok: false, error: "forbidden" });
    expect(project(RNC).archived).toBeTruthy();
  });
});

describe("RF 3: la scheda Archived e la pagina dell'archiviato", () => {
  it("Sara non ha RNC, e getArchivedProject è null come per un codice che non c'è", async () => {
    as(SARA);
    expect((await projectSettings.listArchivedProjects()).map((r) => r.code)).not.toContain("RNC");
    expect(await projectSettings.getArchivedProject("RNC")).toBeNull();
    expect(await projectSettings.getArchivedProject("NOPE")).toBeNull();
  });

  it("Giulia lo legge con Reopen e senza Delete; Roberta con Delete", async () => {
    as(GIULIA);
    const rows = await projectSettings.listArchivedProjects();
    expect(rows).toEqual([
      {
        projectId: RNC,
        code: "RNC",
        name: "Vetrina online Tenuta Ronchi",
        clientName: "Tenuta Ronchi Srl",
        archivedAt: project(RNC).archived!.at,
        archivedBy: "Roberta Fontana",
        canReopen: true,
        canDelete: false,
      },
    ]);
    const view = (await projectSettings.getArchivedProject("RNC"))!;
    expect(view).toMatchObject({ code: "RNC", canReopen: true, canDelete: false });
    expect(view.description).toContain("winery");
    expect(view.repositories).toEqual(["shop-frontend"]);
    expect(view.members.map((m) => m.personId)).toEqual(
      expect.arrayContaining([GIULIA, "p-marco", "p-elena"]),
    );
    expect(view.members.map((m) => m.personId)).not.toContain(CLAUDE_ID);
    expect(view.members.find((m) => m.personId === GIULIA)!.role).toBe("Project Lead");
    expect(view.counts).toEqual({
      tasks: 6,
      requests: 2,
      docPages: 2,
      conversations: 1,
      channels: 1,
      driveFiles: 3,
      automations: 0,
      environments: 1,
      envFiles: 1,
      releases: 0,
    });
    expect(view.switchesOnReopen).toEqual(state.projectSettings.get(RNC)!.switches);
    as(ROBERTA);
    expect((await projectSettings.getArchivedProject("RNC"))!.canDelete).toBe(true);
  });

  it("«Who?» di Reopen: Giulia ha la risposta, Sara no; la scelta del progetto non elenca RNC", async () => {
    const r = whoCan(GIULIA, "manageProjectSettings", RNC);
    expect(r.visible).toBe(true);
    if (r.visible) {
      expect(r.people.map((p) => p.personId)).toEqual(expect.arrayContaining([GIULIA, ROBERTA]));
    }
    expect(whoCan(SARA, "manageProjectSettings", RNC)).toEqual({ visible: false });
    for (const person of [GIULIA, ROBERTA, SARA]) {
      as(person);
      expect((await access.whoCanChoices()).projects.map((p) => p.code)).not.toContain("RNC");
    }
  });

  it("P21: il filtro dei progetti del registro di Giulia ha RNC con archived: true, quello di Laura no", async () => {
    as(GIULIA);
    const giulia = await changelog.listChangeFilterChoices();
    expect(giulia.projects.find((p) => p.code === "RNC")).toEqual({
      projectId: RNC,
      code: "RNC",
      name: "Vetrina online Tenuta Ronchi",
      archived: true,
    });
    expect(giulia.projects.find((p) => p.code === "MKX")!.archived).toBeUndefined();
    as(LAURA);
    const laura = JSON.stringify(await changelog.listChangeFilterChoices());
    expect(laura).not.toContain("RNC");
    expect(laura).not.toContain("Ronchi");
  });

  it("le voci di un archiviato le legge chi lo vede da archiviato (R-M1), non chi non ne era membro", async () => {
    as(GIULIA);
    await projectSettings.reopenProject(RNC);
    await projectSettings.archiveProject(RNC);
    const kinds = (await changelog.listChanges({ projectId: RNC })).map((e) => e.kind);
    expect(kinds).toEqual(["project.archived", "project.reopened"]);
    // Archiviato, non ha Settings da aprire: la voce porta alla sua pagina (Task 12).
    expect((await changelog.listChanges({ projectId: RNC }))[0]!.objectLink).toEqual({
      to: "archived",
      code: "RNC",
    });
    as(LAURA);
    expect(JSON.stringify(await changelog.listChanges())).not.toContain("RNC");
  });
});

describe("Amministrazione → Servers: inArchivedOnly", () => {
  it("SRV-5 sta solo in RNC archiviato: inArchivedOnly e nessun progetto, per tutti; SRV-1 no", async () => {
    for (const person of [ROBERTA, GIULIA]) {
      as(person);
      grantInstancePermission(person, "monitor.manage" as never);
      const rows = await servers.listAllServers();
      expect(rows.find((s) => s.code === "SRV-5")).toMatchObject({
        inArchivedOnly: true,
        orphan: false,
        projects: [],
      });
      expect(rows.find((s) => s.code === "SRV-1")!.inArchivedOnly).toBe(false);
    }
    // Anche nel dettaglio (SRV-5 è solo di RNC), senza progetti.
    as(ROBERTA);
    expect(await servers.getServer("SRV-5")).toMatchObject({
      inArchivedOnly: true,
      orphan: false,
      productionProjects: [],
    });
    expect((await servers.getServer("SRV-1")).inArchivedOnly).toBe(false);
    as(GIULIA);
    await projectSettings.reopenProject(RNC);
    as(ROBERTA);
    const reopened = (await servers.listAllServers()).find((s) => s.code === "SRV-5")!;
    expect(reopened).toMatchObject({ inArchivedOnly: false, projects: [{ code: "RNC" }] });
  });
});

describe("R-G5 delle superfici del Task 1: RNC archiviato per Laura, che non ne era membro", () => {
  /** Nessun nome, codice o id di RNC nella lettura. */
  const clean = (label: string, value: unknown) => {
    const text = JSON.stringify(value);
    for (const needle of ["RNC", RNC, "Ronchi"])
      expect(text, `${label}: ${needle}`).not.toContain(needle);
  };

  it("Docs, Home, La mia settimana, fissati e notifiche (anche d'istanza) non nominano RNC", async () => {
    // Lo stato che tenterebbe le letture: RNC fissato da Laura, una task di
    // RNC assegnata a lei in questa settimana e messa in un giorno, un avviso
    // di RNC e un allarme di SRV-5 (solo di RNC) con Laura che gestisce il monitor.
    const week = currentWeek();
    const rncTask = state.tasks.find((t) => t.projectId === RNC)!;
    rncTask.assigneeId = LAURA;
    rncTask.plannedWeek = week;
    state.arrangements.push({ personId: LAURA, week, taskId: rncTask.id, day: 1 } as never);
    state.pinned.set(LAURA, [...(state.pinned.get(LAURA) ?? []), RNC]);
    const seeded = state.notifications.find((n) => n.projectId === RNC)!;
    state.notifications.push({
      ...structuredClone(seeded),
      id: "n-rnc-laura",
      recipientIds: [LAURA],
    });
    grantInstancePermission(LAURA, "monitor.manage" as never);
    as(ROBERTA);
    await servers.simulateServerAlert("SRV-5", "memory");

    as(LAURA);
    // Docs.
    expect(await docs.listDocSpaces(RNC).catch(() => [])).toEqual([]);
    expect(await docs.getDocSpace("repo-rnc")).toBeNull();
    expect(await docs.getProjectDocsHome(RNC)).toBeNull();
    for (const page of state.docPages.filter((p) => p.projectId === RNC))
      expect(await docs.getDocPage(page.repositoryId, page.slug)).toBeNull();
    for (const q of ["shop", "Ronchi", "booking"])
      clean(`searchDocs ${q}`, await docs.searchDocs(q));
    // Fissati, binario, Home.
    clean("pinned", await listPinnedProjectIds());
    clean("projects", await listProjects());
    clean("waitingOnMe", await listWaitingOnMeProjectIds());
    clean("tasks", await listTasks());
    clean("stalled", await listStalled({}));
    clean("portfolio", await listPortfolioActivity());
    clean("claudeDecisions", await listClaudeDecisions());
    clean("requestsToConvert", await listRequestsToConvert());
    clean("milestones", await listMilestones());
    for (const scope of ["live", "finished", "public"] as const)
      clean(`conversations ${scope}`, await listConversations({ scope, includeOlder: true }));
    // La mia settimana: le task di Laura e la loro sistemazione nei giorni.
    clean("myWeek", await listTasks({ assigneeIds: [LAURA] }));
    clean("arrangements", await listDayArrangements(week));
    // Notifiche, comprese quelle d'istanza (l'allarme di SRV-5).
    clean("notifications", await listNotifications());
    // Ricerca ⌘K.
    for (const q of ["RNC", "Ronchi", rncTask.code]) clean(`search ${q}`, await search(q));
  });

  it("la pagina dell'archiviato dà a Giulia i nomi dei membri e di chi ha archiviato, anche se stanno solo in RNC", async () => {
    const outsider = PEOPLE.find(
      (p) =>
        !p.isClaude &&
        p.id !== ROBERTA &&
        !visiblePeopleFor(GIULIA).has(p.id) &&
        !project(RNC).memberIds.includes(p.id),
    )!;
    expect(outsider).toBeDefined();
    grantProjectRole(outsider.id, RNC, "contributor");
    project(RNC).archived = { at: project(RNC).archived!.at, byId: outsider.id };
    // Altrove Giulia non incontra questa persona: sta solo in RNC, archiviato.
    expect(visiblePeopleFor(GIULIA).has(outsider.id)).toBe(false);

    as(GIULIA);
    const view = (await projectSettings.getArchivedProject("RNC"))!;
    expect(view.members).toContainEqual({
      personId: outsider.id,
      name: outsider.name,
      role: "Contributor",
    });
    expect(view.archivedBy).toBe(outsider.name);
    const [row] = await projectSettings.listArchivedProjects();
    expect(row!.archivedBy).toBe(outsider.name);
  });
});

describe("RF 4: Delete rifiutato", () => {
  it("not_archived, forbidden, code_mismatch, reauth_required; niente cambia", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    const before = snapshot();
    expect(await projectSettings.deleteProject(ACQ, { confirmCode: "ACQ" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_archived",
    });
    as(GIULIA);
    markReauthenticated(GIULIA);
    expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    as(ROBERTA);
    expect(await projectSettings.deleteProject(RNC, { confirmCode: "rnc" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "code_mismatch",
    });
    state.reauth.clear();
    expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(snapshot()).toBe(before);
    as(SARA);
    expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("getDeletionPreview: solo il full admin, solo su un archiviato", async () => {
    as(GIULIA);
    expect(await projectSettings.getDeletionPreview(RNC)).toEqual({
      ok: false,
      error: "forbidden",
    });
    as(ROBERTA);
    expect(await projectSettings.getDeletionPreview(ACQ)).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_archived",
    });
  });
});

describe("Delete di RNC da Roberta", () => {
  it("anteprima, poi nessuna riga dello stato nomina prj-rnc; SRV-5 orfano; nessun segreto resta", async () => {
    // Un segreto per ogni tipo: un valore d'ambiente, il secret del webhook, la chiave d'ingestione.
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    await projectSettings.reopenProject(RNC);
    expect(
      await projectSettings.setEnvVar("envf-rnc-prod", "PAYMENTS_SECRET_KEY", "sk-rnc-9f8e7d"),
    ).toEqual({ ok: true });
    const webhook = await projectSettings.regenerateWebhookSecret("repo-rnc");
    const ingestion = await projectSettings.regenerateIngestionKey(RNC);
    if (!webhook.ok || !ingestion.ok) throw new Error("setup");
    await projectSettings.archiveProject(RNC);

    expect(await projectSettings.getDeletionPreview(RNC)).toEqual({
      ok: true,
      counts: {
        tasks: 6,
        requests: 2,
        docPages: 2,
        conversations: 1,
        channels: 1,
        driveFiles: 3,
        automations: 0,
        environments: 1,
        envFiles: 1,
        releases: 0,
      },
      orphanServers: ["SRV-5"],
      detachedRepositories: ["shop-frontend"],
    });
    const members = [...project(RNC).memberIds];
    // I1: un invito in sospeso che promette RNC e un'automazione generale con
    // un passo fisso su RNC (il seme non ne ha: la scansione deve vederli).
    const roleId = state.invites.find((i) => i.projects.length > 0)!.projects[0]!.roleId;
    state.invites.push({
      ...structuredClone(state.invites[0]!),
      id: "inv-rnc-test",
      projects: [
        { projectId: RNC, roleId },
        { projectId: ACQ, roleId },
      ],
    });
    const general = await automations.createAutomation({
      name: "Into RNC",
      projectId: null,
      flow: {
        trigger: { kind: "manual" },
        steps: [
          {
            id: "t",
            kind: "createTask",
            title: "From the general one",
            description: "",
            assignee: null,
            dueInDays: null,
            project: { mode: "fixed", projectId: "prj-stw" },
            milestoneRef: null,
            approval: { mode: "auto" },
          },
        ],
        titleTemplate: "Into RNC",
      },
    });
    const generalRow = state.automations.find((a) => a.id === general.id)!;
    for (const v of generalRow.versions)
      (v.flow.steps[0] as { project: { projectId: string } }).project.projectId = RNC;

    expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({ ok: true });

    const found: string[] = [];
    // Escluso il registro, `deletedProjects` e `detachedRepositories[].formerProjectId`.
    const { deletedProjects, detachedRepositories } = state;
    const rest = Object.fromEntries(
      Object.entries(state).filter(
        ([key]) => !["changelog", "deletedProjects", "detachedRepositories"].includes(key),
      ),
    );
    scan({ ...rest, access: accessState() }, "state", RNC, found);
    scan(
      detachedRepositories.map((d) => ({ ...d, formerProjectId: "" })),
      "detachedRepositories",
      RNC,
      found,
    );
    expect(found).toEqual([]);
    // L'invito perde RNC e tiene il resto; il passo fisso resta senza progetto,
    // non valido, col segno che il costruttore dice (Task 6, [PX 5]).
    const invite = state.invites.find((i) => i.id === "inv-rnc-test")!;
    expect(invite.projects.map((p) => p.projectId)).toEqual([ACQ]);
    const flow = generalRow.versions.at(-1)!.flow;
    expect((flow.steps[0] as { project: unknown }).project).toEqual({
      mode: "fixed",
      projectId: "",
      unavailable: true,
    });
    expect(configErrorsOf(generalRow, flow, ROBERTA).map((i) => i.code)).toContain("incomplete");
    expect(deletedProjects).toEqual([
      {
        id: RNC,
        code: "RNC",
        name: "Vetrina online Tenuta Ronchi",
        memberIds: members,
        deletedAt: now(),
        deletedById: ROBERTA,
      },
    ]);
    expect(detachedRepositories).toMatchObject([
      {
        formerProjectId: RNC,
        detachedById: ROBERTA,
        repository: {
          id: "repo-rnc",
          name: "shop-frontend",
          url: "https://github.com/vetrina-web/shop-frontend",
          gitAccountId: "git-github-shop",
          protectedBranches: ["main"],
          webhook: { state: "not_configured", configuredAt: null, secretId: null, last4: null },
        },
      },
    ]);
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "project.deleted",
      actorId: ROBERTA,
      projectId: null,
      params: { detachedRepositories: "1" },
    });

    // SRV-5 resta, orfano (R-L7).
    const row = (await servers.listAllServers()).find((s) => s.code === "SRV-5")!;
    expect(row).toMatchObject({ orphan: true, inArchivedOnly: false, projects: [] });

    // Nessun segreto di RNC resta nel caveau.
    const values = __secretValuesForTest().flatMap((s) => s.values);
    expect(values).not.toContain("sk-rnc-9f8e7d");
    expect(values).not.toContain(webhook.secret);
    expect(values).not.toContain(ingestion.key);

    // I Docs non raggiungono più il repository (Task 4 ⚠️).
    expect(repositoryById("repo-rnc")).toBeUndefined();
    expect(await projectSettings.getArchivedProject("RNC")).toBeNull();
    expect((await projectSettings.listArchivedProjects()).map((r) => r.code)).not.toContain("RNC");
  });

  it("I1: un progetto nuovo col codice di RNC non eredita storia, consumi né provenienza", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    // Una spesa di RNC nel mese: è la spesa del cliente eliminato.
    const range = { days: 90 } as const;
    state.instance.usage.push({
      ...state.instance.usage[0]!,
      id: "usage-rnc-test",
      at: now(),
      projectId: RNC,
      conversationId: null,
    });
    // E una voce del suo registro: il nome di prima nomina il cliente.
    await projectSettings.reopenProject(RNC);
    await projectSettings.updateProjectGeneral(RNC, { name: "Vetrina Ronchi 2" });
    await projectSettings.archiveProject(RNC);
    await projectSettings.deleteProject(RNC, { confirmCode: "RNC" });

    // Laura non era membro di RNC: crea un progetto nuovo con lo stesso codice.
    grantInstancePermission(LAURA, "projects.create");
    as(LAURA);
    const fresh = await createProject({ code: "RNC", name: "Rinnovi", template: "empty" });
    expect(fresh.id).not.toBe(RNC);

    const changes = await changelog.listProjectChanges(fresh.id);
    expect(changes.map((c) => c.kind)).toEqual(["member.added"]);
    expect(JSON.stringify(changes)).not.toMatch(/ronchi|vetrina/i);

    const usage = await projectSettings.getProjectUsage(fresh.id, { range, groupBy: "model" });
    expect(usage!.totals.runs).toBe(0);

    as(ROBERTA);
    const after = await instance.getUsage({ range, groupBy: "project" });
    expect(after.rows.find((r) => r.key === fresh.id)).toBeUndefined();
    // I repository senza progetto non dicono di venire dal progetto nuovo.
    const detached = await instance.listDetachedRepositories();
    expect(detached.find((d) => d.name === "shop-frontend")!.formerProject).toEqual({
      code: "RNC",
      name: "Vetrina Ronchi 2",
    });
  });

  it("RF 3, project.deleted: Roberta legge il codice e il nome, chi non era membro la chiave nascosta", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    await projectSettings.deleteProject(RNC, { confirmCode: "RNC" });
    const deletedOf = async () => (await changelog.listChanges({ kind: "project.deleted" }))[0]!;

    const roberta = await deletedOf();
    expect(roberta.object.label).toBe("RNC · Vetrina online Tenuta Ronchi");
    expect(roberta.objectLabelKey ?? null).toBeNull();

    as(GIULIA);
    grantInstancePermission(GIULIA, "changelog.view");
    expect((await deletedOf()).object.label).toBe("RNC · Vetrina online Tenuta Ronchi");

    grantInstancePermission(LAURA, "changelog.view");
    as(LAURA);
    const laura = await deletedOf();
    expect(laura.object.label).toBe("");
    expect(laura.objectLabelKey).toBe("changelog.values.hiddenProject");
    expect(laura.params).toEqual({ detachedRepositories: "1" });
    const text = JSON.stringify(laura);
    expect(text).not.toContain("RNC");
    expect(text).not.toContain("Ronchi");

    // Senza changelog.view né full admin non la legge affatto.
    as(SARA);
    expect(await changelog.listChanges({ kind: "project.deleted" })).toEqual([]);
  });
});
