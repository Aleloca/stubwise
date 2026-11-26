import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealWhoCan, type WhoCanApi } from "./whoCan";

// Area 9, F1, R9: «Chi può farlo?» sul server (`GET /api/access/who-can` e
// `what-can`). La mappa azione → permesso resta nel client (è catalogo e
// testo); il calcolo è del server.

const PRJ = "11111111-1111-4111-8111-111111111111";
const LAURA = "22222222-2222-4222-8222-222222222222";
const MARCO = "33333333-3333-4333-8333-333333333333";
const ROBERTA = "44444444-4444-4444-8444-444444444444";
const DEPT = "55555555-5555-4555-8555-555555555555";

function fakeApi(over: Partial<WhoCanApi> = {}) {
  const calls: string[] = [];
  const api: WhoCanApi = {
    whoCan: async (q) => {
      calls.push(`who ${q.permission} ${q.projectId ?? "-"}`);
      return {
        permission: q.permission,
        projectId: q.projectId ?? null,
        people: [
          {
            userId: LAURA,
            email: "laura@example.com",
            displayName: "Laura Costa",
            reasons: [
              {
                kind: "role",
                roleId: "r1",
                roleName: "Project Lead",
                byUserId: null,
                at: null,
                departmentId: null,
              },
            ],
          },
          {
            userId: MARCO,
            email: "marco@example.com",
            displayName: null,
            reasons: [
              {
                kind: "grant",
                roleId: null,
                roleName: null,
                byUserId: ROBERTA,
                at: "2026-11-01T09:00:00.000Z",
                departmentId: null,
              },
              {
                kind: "department",
                roleId: null,
                roleName: null,
                byUserId: null,
                at: null,
                departmentId: DEPT,
              },
            ],
          },
        ],
      };
    },
    whatCan: async (q) => {
      calls.push(`what ${q.userId} ${q.projectId ?? "-"}`);
      return {
        userId: q.userId,
        instance: [
          {
            permission: "users.view_all",
            reasons: [
              {
                kind: "role",
                roleId: "r2",
                roleName: "User",
                byUserId: null,
                at: null,
                departmentId: null,
              },
            ],
          },
        ],
        projects: q.projectId
          ? [
              {
                projectId: PRJ,
                projectName: "Acquedotto",
                permissions: [{ permission: "tickets.create", reasons: [] }],
              },
            ]
          : [],
      };
    },
    people: async () => [
      { id: LAURA, name: "Laura Costa", initials: "LC", isClaude: false },
      { id: MARCO, name: "Marco Bellini", initials: "MB", isClaude: false },
      { id: ROBERTA, name: "Roberta Fontana", initials: "RF", isClaude: false },
      { id: "claude", name: "Claude", initials: "C", isClaude: true },
    ],
    projects: async () => [{ id: PRJ, code: "ACQ", name: "Acquedotto" }],
    departments: async () => [{ id: DEPT, name: "Customer care" }],
    ...over,
  };
  return { api, calls };
}

describe("«Chi può farlo?» dal server (area 9, R9)", () => {
  it("da un'azione: il permesso del catalogo, le persone coi motivi in parole del prototipo, Claude fisso", async () => {
    const { api, calls } = fakeApi();
    const r = await createRealWhoCan(api).whoCan("approvePlan", PRJ);
    expect(calls).toEqual([`who plans.approve ${PRJ}`]);
    if (!r.visible) throw new Error("invisibile");
    expect(r).toMatchObject({ permission: "plans.approve", scope: "project", projectCode: "ACQ" });
    expect(r.agent).toEqual({ actsFor: "confirmer" });
    expect(r.people).toEqual([
      {
        personId: LAURA,
        name: "Laura Costa",
        initials: "LC",
        reasons: [{ kind: "role", roleName: "Project Lead" }],
      },
      {
        personId: MARCO,
        name: "Marco Bellini",
        initials: "MB",
        reasons: [
          { kind: "grant", byName: "Roberta Fontana", at: "2026-11-01T09:00:00.000Z" },
          { kind: "department", departmentName: "Customer care" },
        ],
      },
    ]);
  });

  it("un'azione d'istanza va senza progetto; una di progetto senza progetto non ha risposta", async () => {
    const { api, calls } = fakeApi();
    await createRealWhoCan(api).whoCan("manageRoles", null);
    expect(calls).toEqual(["who roles.manage -"]);
    expect(await createRealWhoCan(fakeApi().api).whoCan("approvePlan", null)).toEqual({
      visible: false,
    });
    expect(await createRealWhoCan(fakeApi().api).whoCan("no-such-action", PRJ)).toEqual({
      visible: false,
    });
  });

  it("un progetto invisibile (404) non ha risposta, come uno che non esiste", async () => {
    const hidden = createRealWhoCan(
      fakeApi({
        whoCan: async () => {
          throw new ApiError(404, "not_found", "not_found");
        },
      }).api,
    );
    expect(await hidden.whoCan("approvePlan", PRJ)).toEqual({ visible: false });
  });

  it("da una persona: tutti i permessi del livello, raggruppati, con «ha» o no; membro del progetto", async () => {
    const r = await createRealWhoCan(fakeApi().api).whatCan(MARCO, PRJ);
    if (!r.visible) throw new Error("invisibile");
    expect(r).toMatchObject({
      personId: MARCO,
      name: "Marco Bellini",
      projectCode: "ACQ",
      member: true,
    });
    const all = r.groups.flatMap((g) => g.permissions);
    expect(all.find((p) => p.permission === "tickets.create")).toEqual({
      permission: "tickets.create",
      held: true,
      reasons: [],
    });
    expect(all.find((p) => p.permission === "plans.approve")).toMatchObject({ held: false });
    const inst = await createRealWhoCan(fakeApi().api).whatCan(MARCO, null);
    if (!inst.visible) throw new Error("invisibile");
    expect(inst.member).toBeNull();
    expect(
      inst.groups.flatMap((g) => g.permissions).find((p) => p.permission === "users.view_all"),
    ).toMatchObject({
      held: true,
      reasons: [{ kind: "role", roleName: "User" }],
    });
  });

  it("persone e reparti si leggono UNA volta per chiamata, non una per riga (review F1, M2)", async () => {
    const reads = { people: 0, departments: 0 };
    const base = fakeApi().api;
    const counted = createRealWhoCan({
      ...base,
      people: async () => {
        reads.people++;
        return base.people();
      },
      departments: async () => {
        reads.departments++;
        return base.departments();
      },
    });
    await counted.whoCan("approvePlan", PRJ);
    expect(reads).toEqual({ people: 1, departments: 1 });
    reads.people = 0;
    reads.departments = 0;
    await counted.whatCan(MARCO, PRJ);
    expect(reads.people).toBe(1);
    expect(reads.departments).toBeLessThanOrEqual(1);
  });

  it("F8: il nome del reparto lo dà il server (departmentName); senza, si cerca nei reparti come prima", async () => {
    const base = fakeApi().api;
    let deptReads = 0;
    const api = createRealWhoCan({
      ...base,
      departments: async () => {
        deptReads++;
        return [];
      },
      whoCan: async (q) => {
        const r = (await base.whoCan(q)) as { people: { reasons: Record<string, unknown>[] }[] };
        for (const p of r.people)
          for (const x of p.reasons) if (x.kind === "department") x.departmentName = "Support team";
        return r as never;
      },
    });
    const who = await api.whoCan("approvePlan", PRJ);
    expect(JSON.stringify(who)).toContain("Support team");
    // Il reparto non si cerca: chi non gestisce i reparti non lo leggerebbe pieno.
    expect(deptReads).toBe(0);
  });

  it("le scelte: i progetti visibili e le persone, senza Claude", async () => {
    expect(await createRealWhoCan(fakeApi().api).whoCanChoices()).toEqual({
      projects: [{ projectId: PRJ, code: "ACQ", name: "Acquedotto" }],
      people: [
        { personId: LAURA, name: "Laura Costa" },
        { personId: MARCO, name: "Marco Bellini" },
        { personId: ROBERTA, name: "Roberta Fontana" },
      ],
    });
  });
});
