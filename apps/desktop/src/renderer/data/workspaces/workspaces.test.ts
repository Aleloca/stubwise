import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency, workspaces } from "../api";
import { accessState, isMember, roleIdOf, writeAccess } from "../access/index";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { can, grantInstancePermission, viewerFor } from "../viewer";

// Lo strato dati delle workspace nel prototipo (shape `workspaces.md`,
// decisioni del 27 nov 2026): letture con R-G5 e D5, l'effetto prima di
// salvare, e le scritture con permesso (D4), escalation, riconferma (D11) e
// `last_manager` (D18). Un rifiuto non lascia né scritture né voci.

const ROBERTA = "p-roberta"; // full admin
const GIULIA = "p-giulia"; // Project Lead di ORT, non in SPZ, LNT, BSC
const STORICI = "ws-storici";

const as = (personId: string) => setSessionPersonId(personId);
const snapshot = () =>
  JSON.stringify({ access: accessState(), memberIds: state.projects.map((p) => p.memberIds) });

async function refused(call: () => Promise<unknown>, expected: Record<string, unknown>) {
  const before = snapshot();
  const entries = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});

describe("le letture", () => {
  it("il full admin le vede tutte, coi progetti e quelli fuori da ogni workspace", async () => {
    as(ROBERTA);
    const list = await workspaces.listWorkspaces();
    expect(list.canManage).toBe(true);
    expect(list.workspaces.map((w) => [w.name, w.projectCount])).toEqual([
      ["Clienti storici", 4],
      ["Prodotti", 3],
    ]);
    expect(list.noWorkspaceCount).toBe(visibleProjectIds(ROBERTA).size - 7);
  });

  it("D5: chi vede un solo progetto della workspace la vede, col conteggio dei soli visibili", async () => {
    as(GIULIA);
    const list = await workspaces.listWorkspaces();
    expect(list.canManage).toBe(false);
    const storici = list.workspaces.find((w) => w.id === STORICI)!;
    expect(storici).toMatchObject({ projectCount: 1, isMember: false });
    const view = await workspaces.getWorkspace("clienti-storici");
    expect(view.projectIds).toEqual(["prj-ort"]);
  });

  it("chi ne fa parte la vede intera; una workspace senza progetti visibili non esiste per chi non c'è (R-G5)", async () => {
    as("p-nicola");
    const storici = (await workspaces.listWorkspaces()).workspaces.find((w) => w.id === STORICI)!;
    expect(storici).toMatchObject({ projectCount: 4, isMember: true });

    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await workspaces.createWorkspace("Riservata")).toMatchObject({ ok: true, slug: "riservata" });
    as(GIULIA);
    expect((await workspaces.listWorkspaces()).workspaces.map((w) => w.name)).not.toContain("Riservata");
    await expect(workspaces.getWorkspace("riservata")).rejects.toThrow("not_found");
  });

  it("People: ruolo di workspace, ruoli per progetto in più, Viewer di base (D3)", async () => {
    as(ROBERTA);
    const view = await workspaces.listWorkspaceMembers(STORICI);
    expect(view.members.map((m) => [m.name, m.roleName])).toEqual([
      ["Marco Bellini", "Developer"],
      ["Nicola Orlando", "Viewer"],
    ]);
    const marco = view.members.find((m) => m.personId === "p-marco")!;
    expect(marco.projectRoles.map((r) => r.code).sort()).toEqual(["BSC", "LNT", "ORT", "SPZ"]);
    expect(view.members.find((m) => m.personId === "p-nicola")!.projectRoles).toEqual([]);
    expect(view.defaultRoleId).toBe(roleIdOf("viewer"));
    // I full admin non si aggiungono: vedono già tutto.
    expect(view.addable.map((p) => p.personId)).not.toContain(ROBERTA);
    expect(view.fullAdmins.map((p) => p.personId)).toContain(ROBERTA);
  });
});

describe("l'effetto prima di salvare", () => {
  it("mettere MKX in Clienti storici: chi comincia a vederlo, senza scrivere niente", async () => {
    as(ROBERTA);
    const before = snapshot();
    const effect = await workspaces.previewWorkspace({
      kind: "addProject",
      workspaceId: STORICI,
      projectId: "prj-mkx",
    });
    expect(effect.projects).toHaveLength(1);
    expect(effect.projects[0]!.startSeeing.map((p) => p.personId)).toContain("p-nicola");
    expect(effect.projects[0]!.stopSeeing).toEqual([]);
    expect(effect).toMatchObject({ lastManager: [], escalation: [], notManaged: [] });
    expect(snapshot()).toBe(before);
  });

  it("eliminare la workspace: chi smette di vedere (non i membri per progetto)", async () => {
    as(ROBERTA);
    const effect = await workspaces.previewWorkspace({ kind: "delete", workspaceId: STORICI });
    for (const p of effect.projects) {
      expect(p.stopSeeing.map((x) => x.personId)).toEqual(["p-nicola"]);
    }
  });
});

describe("le scritture", () => {
  it("invitare chiede la riconferma, poi la persona vede i progetti, e il registro lo dice", async () => {
    as(ROBERTA);
    await refused(() => workspaces.addWorkspaceMember(STORICI, "p-irene"), { error: "reauth_required" });
    markReauthenticated(ROBERTA);
    expect(await workspaces.addWorkspaceMember(STORICI, "p-irene")).toEqual({ ok: true });
    expect(visibleProjectIds("p-irene").has("prj-spz")).toBe(true);
    expect(accessState().workspaceMembers).toContainEqual({
      workspaceId: STORICI,
      personId: "p-irene",
      roleId: roleIdOf("viewer"),
    });
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "workspace.member_added",
      params: { person: "Irene Caruso", role: "Viewer" },
    });
  });

  it("senza `workspaces.manage` niente: crea, invita, sposta (D4)", async () => {
    as(GIULIA);
    markReauthenticated(GIULIA);
    await refused(() => workspaces.createWorkspace("Mia"), { error: "forbidden" });
    await refused(() => workspaces.addWorkspaceMember(STORICI, "p-irene"), { error: "forbidden" });
    await refused(() => workspaces.setProjectWorkspace("prj-ort", null), { error: "forbidden" });
  });

  it("con `workspaces.manage` ma non dove serve: progetto non gestito e escalation", async () => {
    grantInstancePermission(GIULIA, "workspaces.manage");
    as(GIULIA);
    markReauthenticated(GIULIA);
    // Un progetto che Giulia vede ma di cui non gestisce i membri: non può cambiare chi lo vede.
    const notHers = [...visibleProjectIds(GIULIA)].find(
      (p) => !can(viewerFor(GIULIA), "project.members.manage", p),
    )!;
    expect(notHers).toBeDefined();
    await refused(() => workspaceSet(notHers, STORICI), { error: "forbidden" });
    // Uno che non vede nemmeno: per lei non esiste (R-G5).
    await refused(() => workspaceSet("prj-spz", null), { error: "not_found" });
    // Developer in tutti i progetti della workspace: in SPZ, LNT e BSC non ha quei permessi.
    await refused(() => workspaces.addWorkspaceMember(STORICI, "p-irene", roleIdOf("developer")), {
      error: "escalation",
    });
  });

  it("D18: togliere l'unico che gestisce i membri di un progetto si rifiuta", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    // In SPZ nessuno gestisce i membri per progetto; Marco lo fa dalla workspace.
    writeAccess((s) => {
      for (const m of s.memberships) if (m.projectId === "prj-spz") m.roleId = roleIdOf("viewer");
      s.workspaceMembers.find((m) => m.personId === "p-marco")!.roleId = roleIdOf("project_lead");
    });
    const effect = await workspaces.previewWorkspace({
      kind: "removeMember",
      workspaceId: STORICI,
      personId: "p-marco",
      alsoFromProjects: false,
    });
    expect(effect.lastManager).toContain("SPZ");
    await refused(() => workspaces.removeWorkspaceMember(STORICI, "p-marco"), {
      error: "invalid",
      reason: "last_manager",
    });
  });

  it("D12: togliendo una persona i ruoli per progetto restano, salvo la casella", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await workspaces.removeWorkspaceMember(STORICI, "p-marco")).toEqual({ ok: true });
    expect(isMember("p-marco", "prj-ort")).toBe(true);
    resetApi();
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await workspaces.removeWorkspaceMember(STORICI, "p-marco", true)).toEqual({ ok: true });
    expect(isMember("p-marco", "prj-ort")).toBe(false);
  });

  it("spostare un progetto, eliminare la workspace: i progetti restano, in «No workspace»", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await workspaces.setProjectWorkspace("prj-ort", "ws-prodotti")).toEqual({ ok: true });
    expect(visibleProjectIds("p-nicola").has("prj-ort")).toBe(false);
    expect(await workspaces.deleteWorkspace(STORICI)).toEqual({ ok: true });
    expect(visibleProjectIds("p-nicola").has("prj-spz")).toBe(false);
    expect(state.projectsById.get("prj-spz")).toBeDefined();
    expect(accessState().workspaces.map((w) => w.id)).toEqual(["ws-prodotti"]);
    expect(state.changelog.slice(-3).map((c) => c.kind)).toEqual([
      "workspace.project_removed",
      "workspace.project_added",
      "workspace.deleted",
    ]);
  });

  it("rinominare non chiede la riconferma; un nome già usato si rifiuta", async () => {
    as(ROBERTA);
    expect(await workspaces.renameWorkspace(STORICI, "Clienti di sempre")).toEqual({
      ok: true,
      slug: "clienti-di-sempre",
    });
    await refused(() => workspaces.renameWorkspace(STORICI, "prodotti"), {
      error: "invalid",
      reason: "name_taken",
    });
  });
});

const workspaceSet = (projectId: string, workspaceId: string | null) =>
  workspaces.setProjectWorkspace(projectId, workspaceId);
