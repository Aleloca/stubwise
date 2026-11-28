import { beforeEach, describe, expect, it } from "vitest";
import { resetApi } from "../api";
import { state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";
import {
  accessState,
  effectivePermissions,
  isMember,
  roleIdOf,
  workspaceOfProjectIn,
  writeAccess,
} from "./index";

// Il nucleo delle workspace (shape `workspaces.md`, decisioni del 27 nov
// 2026): chi è in una workspace vede i suoi progetti col ruolo di workspace,
// che si SOMMA al ruolo per progetto (D1); il reparto vale anche lì (D10);
// `project.memberIds` segue i posti, e chi esce resta un ex membro (D19).

beforeEach(() => resetApi());

const kinds = (personId: string, projectId: string, permission: string) =>
  (effectivePermissions(personId, projectId).get(permission) ?? []).map((s) => s.kind).sort();

describe("il seme", () => {
  it("due workspace, e un progetto in al più una (D2)", () => {
    const s = accessState();
    expect(s.workspaces.map((w) => w.name)).toEqual(["Clienti storici", "Prodotti"]);
    const projects = s.workspaceProjects.map((w) => w.projectId);
    expect(new Set(projects).size).toBe(projects.length);
    expect(workspaceOfProjectIn(s, "prj-ort")?.name).toBe("Clienti storici");
    expect(workspaceOfProjectIn(s, "prj-mkx")).toBeNull();
  });
});

describe("vedere dalla workspace", () => {
  it("Nicola vede ORT solo dalla workspace, da Viewer, con la fonte detta", () => {
    expect(isMember("p-nicola", "prj-ort")).toBe(false);
    expect(visibleProjectIds("p-nicola").has("prj-ort")).toBe(true);
    expect(can(viewerFor("p-nicola"), "docs.view", "prj-ort")).toBe(true);
    // Viewer non crea task: la workspace dà la visibilità, non di più.
    expect(can(viewerFor("p-nicola"), "tickets.create", "prj-ort")).toBe(false);
    expect(can(viewerFor("p-marco"), "tickets.create", "prj-ort")).toBe(true);
    expect(effectivePermissions("p-nicola", "prj-ort").get("docs.view")).toEqual([
      { kind: "workspace", workspaceId: "ws-storici", roleId: roleIdOf("viewer") },
    ]);
  });

  it("un progetto fuori dalla workspace resta come prima", () => {
    expect(visibleProjectIds("p-nicola").has("prj-vrd")).toBe(false);
    expect(effectivePermissions("p-nicola", "prj-vrd").size).toBe(0);
  });

  it("un progetto aggiunto alla workspace arriva subito a chi ne fa parte", () => {
    expect(visibleProjectIds("p-nicola").has("prj-vrd")).toBe(false);
    writeAccess((s) => {
      s.workspaceProjects = s.workspaceProjects.filter((w) => w.projectId !== "prj-vrd");
      s.workspaceProjects.push({ workspaceId: "ws-storici", projectId: "prj-vrd" });
    });
    expect(visibleProjectIds("p-nicola").has("prj-vrd")).toBe(true);
    expect(state.projectsById.get("prj-vrd")!.memberIds).toContain("p-nicola");
  });
});

describe("le fonti si sommano (D1)", () => {
  it("Marco in ORT: il ruolo per progetto E quello di workspace", () => {
    expect(isMember("p-marco", "prj-ort")).toBe(true);
    expect(kinds("p-marco", "prj-ort", "docs.view")).toEqual(["role", "workspace"]);
  });

  it("un ruolo per progetto più piccolo non toglie ciò che dà la workspace", () => {
    writeAccess((s) => {
      s.workspaceMembers.find((m) => m.personId === "p-marco")!.roleId = roleIdOf("project_lead");
      s.memberships.find((m) => m.personId === "p-marco" && m.projectId === "prj-ort")!.roleId =
        roleIdOf("viewer");
    });
    expect(can(viewerFor("p-marco"), "project.members.manage", "prj-ort")).toBe(true);
    expect(kinds("p-marco", "prj-ort", "project.members.manage")).toEqual(["workspace"]);
  });

  it("il reparto vale nei progetti visti dalla workspace (D10)", () => {
    // Stefano (Development) entra nella workspace: Development dà `support.manage`.
    writeAccess((s) => {
      s.workspaceMembers.push({ workspaceId: "ws-storici", personId: "p-stefano", roleId: roleIdOf("viewer") });
    });
    expect(isMember("p-stefano", "prj-spz")).toBe(false);
    expect(kinds("p-stefano", "prj-spz", "support.manage")).toContain("department");
  });
});

describe("uscire da una workspace", () => {
  it("chi esce smette di vedere, resta un ex membro (D19), e tiene i progetti dove è membro", () => {
    writeAccess((s) => {
      s.workspaceMembers = s.workspaceMembers.filter((m) => m.personId !== "p-nicola");
    });
    expect(visibleProjectIds("p-nicola").has("prj-ort")).toBe(false);
    expect(state.projectsById.get("prj-ort")!.memberIds).not.toContain("p-nicola");
    expect(accessState().formerMemberships).toContainEqual({ projectId: "prj-ort", personId: "p-nicola" });

    writeAccess((s) => {
      s.workspaceMembers = s.workspaceMembers.filter((m) => m.personId !== "p-marco");
    });
    expect(visibleProjectIds("p-marco").has("prj-ort")).toBe(true);
    expect(kinds("p-marco", "prj-ort", "docs.view")).toEqual(["role"]);
  });
});
