import { describe, expect, it } from "vitest";
import { createRealMembers, type MembersApi } from "./adminMembers";
import { sourceOf } from "./adminPeople";
import { createRealWhoCan, type WhoCanApi } from "./whoCan";

// Le fonti delle workspace nella build app (contratto con 54, 99be31cb8):
// la fonte `workspace`, le righe di Members di chi vede il progetto solo
// dalla workspace, la ragione e la riga sulla visibilità di Who can?.

const PRJ = "11111111-1111-4111-8111-111111111111";
const NICOLA = "22222222-2222-4222-8222-222222222222";
const MARCO = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const VIEWER = "55555555-5555-4555-8555-555555555555";

describe("la fonte `workspace`", () => {
  it("diventa la fonte del prototipo, col ruolo e la workspace", () => {
    expect(
      sourceOf({ kind: "workspace", workspaceId: WS, workspaceName: "Clienti storici", roleId: VIEWER, roleName: "Viewer" }),
    ).toEqual({ kind: "workspace", workspaceId: WS, workspaceName: "Clienti storici", roleId: VIEWER, roleName: "Viewer" });
  });
});

describe("Members", () => {
  it("chi vede il progetto solo dalla workspace: explicit false e la workspace; un server di prima: membro, senza workspace", async () => {
    const api = {
      view: async () => ({
        projectId: PRJ,
        members: [
          {
            personId: NICOLA,
            name: "Nicola Orlando",
            email: "nicola@example.com",
            status: "active",
            role: { id: VIEWER, name: "Viewer", permissions: [] },
            workspace: { workspaceId: WS, workspaceName: "Clienti storici", roleName: "Viewer" },
            explicit: false,
          },
          {
            personId: MARCO,
            name: "Marco Bellini",
            email: "marco@example.com",
            status: "active",
            role: { id: VIEWER, name: "Developer", permissions: [] },
          },
        ],
        canManage: true,
        roleChoices: [],
      }),
    } as unknown as MembersApi;
    const view = await createRealMembers(api).listProjectMembers(PRJ);
    expect(view.members[0]).toMatchObject({
      explicit: false,
      workspace: { workspaceId: WS, workspaceName: "Clienti storici", workspaceSlug: WS, roleName: "Viewer" },
    });
    expect(view.members[1]).toMatchObject({ explicit: true, workspace: null });
  });
});

describe("Who can?", () => {
  const api = (reasons: { kind: string; [k: string]: unknown }[], workspaceName: string | null): WhoCanApi => ({
    whoCan: async () => ({
      permission: "docs.view",
      projectId: PRJ,
      people: [{ userId: NICOLA, email: "nicola@example.com", displayName: "Nicola Orlando", reasons }],
    }),
    whatCan: async () => ({
      userId: NICOLA,
      instance: [],
      projects: [{ projectId: PRJ, projectName: "Ortofrutta", workspaceName, permissions: [{ permission: "docs.view", reasons }] }],
    }),
    people: async () => [{ id: NICOLA, name: "Nicola Orlando", initials: "NO", isClaude: false }],
    projects: async () => [{ id: PRJ, code: "ORT", name: "Ortofrutta" }],
    departments: async () => [],
  });

  it("la ragione `workspace` in parole; solo dalla workspace non è membro, e la riga dice da dove vede", async () => {
    const real = createRealWhoCan(
      api([{ kind: "workspace", workspaceId: WS, workspaceName: "Clienti storici", roleId: VIEWER, roleName: "Viewer" }], "Clienti storici"),
    );
    const who = await real.whoCan("seeProjectUsage", PRJ);
    if (!who.visible) throw new Error("invisible");
    expect(who.people[0]!.reasons).toEqual([{ kind: "workspace", workspaceName: "Clienti storici", roleName: "Viewer" }]);
    const what = await real.whatCan(NICOLA, PRJ);
    expect(what).toMatchObject({ member: false, workspaceName: "Clienti storici" });
  });

  it("con un ruolo nel progetto è membro; senza workspace la riga non c'è", async () => {
    const what = await createRealWhoCan(api([{ kind: "role", roleId: VIEWER, roleName: "Developer" }], null)).whatCan(NICOLA, PRJ);
    expect(what).toMatchObject({ member: true, workspaceName: null });
  });
});
