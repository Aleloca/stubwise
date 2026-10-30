import { beforeEach, describe, expect, it } from "vitest";
import { ACTIONS, groupsFor } from "../../domain/access/actions";
import { resetApi } from "../api";
import { visibleProjectIds } from "../store";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { PROJECTS } from "../seed/projects";
import {
  CLAUDE_INSTANCE_PERMISSIONS,
  CLAUDE_PROJECT_PERMISSIONS,
  can,
  grantProjectPermission,
  viewerFor,
  type Permission,
} from "../viewer";
import { accessState, isMember, roleIdOf, writeAccess } from "./index";
import { visiblePeopleFor, whatCan, whoCan } from "./whoCan";

beforeEach(() => resetApi());

const pid = (code: string) => PROJECTS.find((p) => p.code === code)!.id;
const ACQ = pid("ACQ");

const isActive = (id: string) =>
  accessState().people.some((p) => p.personId === id && p.status === "active");
const HUMANS = PEOPLE.filter((p) => !p.isClaude).map((p) => p.id);

/**
 * Nel seme Sara vede tutti (è in 26 progetti): per avere qualcuno che non
 * vede, Matteo esce da ogni progetto di Sara e resta in uno che lei non vede.
 * Matteo ha `automations.manage` d'istanza: un'azione d'istanza lo
 * troverebbe, se la visibilità non lo togliesse.
 */
function hideMatteoFromSara(): string {
  const saras = visibleProjectIds("p-sara");
  const elsewhere = PROJECTS.find((p) => !saras.has(p.id))!.id;
  writeAccess((s) => {
    s.memberships = s.memberships.filter(
      (m) => m.personId !== "p-matteo" || !saras.has(m.projectId),
    );
    if (!s.memberships.some((m) => m.personId === "p-matteo" && m.projectId === elsewhere))
      s.memberships.push({
        personId: "p-matteo",
        projectId: elsewhere,
        roleId: roleIdOf("developer"),
      });
  });
  return "p-matteo";
}

/** Le persone attive per cui `can()` è vero: la risposta attesa di Roberta, che vede tutti. */
const expectedFor = (perm: string, projectId: string | undefined) =>
  HUMANS.filter((id) => isActive(id) && can(viewerFor(id), perm as Permission, projectId)).sort();

const peopleOf = (r: ReturnType<typeof whoCan>) => {
  if (!r.visible) throw new Error("invisibile");
  return r.people.map((p) => p.personId).sort();
};

describe("whoCan: parità con can() (RF 5)", () => {
  it("per ogni azione × progetto, Roberta vede esattamente le persone attive per cui can() è vero", () => {
    for (const action of ACTIONS) {
      const projects = action.scope === "project" ? PROJECTS.map((p) => p.id) : [null];
      for (const projectId of projects) {
        const r = whoCan("p-roberta", action.id, projectId);
        expect(peopleOf(r), `${action.id} @ ${projectId}`).toEqual(
          expectedFor(action.permission, projectId ?? undefined),
        );
      }
    }
  });

  it("per chi non è full admin, la risposta è can() ristretto alle persone che vede", () => {
    for (const viewerId of ["p-laura", "p-marco", "p-sara", "p-matteo", "p-giulia"]) {
      const visible = visiblePeopleFor(viewerId);
      const projects = [...visibleProjectIds(viewerId)];
      for (const action of ACTIONS) {
        for (const projectId of action.scope === "project" ? projects : [null]) {
          const expected = expectedFor(action.permission, projectId ?? undefined).filter((id) =>
            visible.has(id),
          );
          expect(
            peopleOf(whoCan(viewerId, action.id, projectId)),
            `${viewerId} ${action.id}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it("segue le scritture: una concessione nuova compare subito", () => {
    expect(peopleOf(whoCan("p-roberta", "fixServer", ACQ))).not.toContain("p-laura");
    grantProjectPermission("p-laura", ACQ, "servers.operate");
    expect(peopleOf(whoCan("p-roberta", "fixServer", ACQ))).toContain("p-laura");
  });

  it("le persone disattivate non compaiono: non hanno più permessi (Task 5), e resta la loro appartenenza", () => {
    const simoneProject = PROJECTS.find((p) => isMember("p-simone", p.id))!.id;
    expect(can(viewerFor("p-simone"), "tickets.create", simoneProject)).toBe(false);
    expect(peopleOf(whoCan("p-roberta", "createTasks", simoneProject))).not.toContain("p-simone");
  });

  it("le fonti vengono da effectivePermissions, nell'ordine ruolo → concessione → reparto → full admin", () => {
    const r = whoCan("p-roberta", "fixServer", ACQ);
    if (!r.visible) throw new Error("invisibile");
    expect(r.people.map((p) => p.personId)).toEqual(["p-marco", "p-roberta"]);
    expect(r.people[0]!.sources).toEqual([
      expect.objectContaining({ kind: "grant", grantedById: "p-roberta" }),
    ]);
    expect(r.people[1]!.sources).toEqual([{ kind: "full_admin" }]);
    // Development dà support.reply: Marco ce l'ha dal ruolo e dal reparto, il ruolo prima.
    const reply = whoCan("p-roberta", "replyCustomers", ACQ);
    if (!reply.visible) throw new Error("invisibile");
    const marco = reply.people.find((p) => p.personId === "p-marco")!;
    expect(marco.sources.map((s) => s.kind)).toEqual(["role", "department"]);
    expect(reply.people.at(-1)!.personId).toBe("p-roberta");
  });

  it("il rango della fonte viene prima del nome", () => {
    // Su ACQ release.merge ce l'hanno Laura e Matteo dal ruolo; Marco lo
    // riceve a mano: per nome starebbe fra i due, per rango va dopo.
    writeAccess((s) =>
      s.grants.push({
        personId: "p-marco",
        projectId: ACQ,
        permission: "release.merge",
        grantedById: "p-laura",
        at: "2026-10-29T10:00:00Z",
      }),
    );
    const r = whoCan("p-roberta", "release", ACQ);
    if (!r.visible) throw new Error("invisibile");
    expect(r.people.map((p) => p.personId)).toEqual([
      "p-laura",
      "p-matteo",
      "p-marco",
      "p-roberta",
    ]);
  });

  it("dentro lo stesso rango, per nome", () => {
    const r = whoCan("p-roberta", "createTasks", ACQ);
    if (!r.visible) throw new Error("invisibile");
    const roleHolders = r.people.filter((p) => p.sources[0]!.kind === "role");
    const names = roleHolders.map((p) => PEOPLE.find((x) => x.id === p.personId)!.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("whoCan: visibilità (R-G5)", () => {
  const notSaras = PROJECTS.find((p) => !visibleProjectIds("p-sara").has(p.id))!.id;
  const sarasProject = [...visibleProjectIds("p-sara")][0]!;

  it("Sara su un progetto che non vede: { visible: false }, come uno che non esiste", () => {
    expect(whoCan("p-sara", "approvePlan", notSaras)).toEqual({ visible: false });
    expect(whoCan("p-sara", "approvePlan", "prj-inesistente")).toEqual({ visible: false });
  });

  it("Sara su un suo progetto non vede persone fuori dai suoi progetti", () => {
    const matteo = hideMatteoFromSara();
    const visible = visiblePeopleFor("p-sara");
    const hidden = HUMANS.filter((id) => isActive(id) && !visible.has(id));
    expect(hidden).toEqual([matteo]);
    // Roberta lo vede ancora: è la visibilità di Sara che lo toglie, non can().
    expect(peopleOf(whoCan("p-roberta", "manageGeneralAutomations", null))).toContain(matteo);
    expect(peopleOf(whoCan("p-sara", "manageGeneralAutomations", null))).not.toContain(matteo);
    for (const action of ACTIONS) {
      const r = whoCan("p-sara", action.id, action.scope === "project" ? sarasProject : null);
      for (const id of peopleOf(r)) expect(hidden).not.toContain(id);
    }
  });

  it("chi si vede: chi condivide un progetto visibile, i full admin, sé stessi", () => {
    const visible = visiblePeopleFor("p-sara");
    expect(visible.has("p-sara")).toBe(true);
    expect(visible.has("p-roberta")).toBe(true);
    expect(visible.has(CLAUDE_ID)).toBe(false);
    for (const id of visible) {
      const shares = [...visibleProjectIds("p-sara")].some((projectId) => isMember(id, projectId));
      expect(shares || id === "p-roberta" || id === "p-sara", id).toBe(true);
    }
  });

  it("un'azione di progetto senza progetto, o un'azione sconosciuta: { visible: false }", () => {
    expect(whoCan("p-roberta", "approvePlan", null)).toEqual({ visible: false });
    expect(whoCan("p-roberta", "nonEsiste", ACQ)).toEqual({ visible: false });
  });

  it("un'azione d'istanza ignora il progetto", () => {
    expect(whoCan("p-sara", "manageSshAccess", notSaras)).toEqual(
      whoCan("p-sara", "manageSshAccess", null),
    );
  });
});

describe("whoCan: Claude", () => {
  it("non approva un piano, avvia un run", () => {
    const approve = whoCan("p-roberta", "approvePlan", ACQ);
    const start = whoCan("p-roberta", "startRun", ACQ);
    expect(approve.visible && approve.claude).toEqual({ allowed: false });
    expect(start.visible && start.claude).toEqual({ allowed: true });
  });

  it("non sta mai fra le persone", () => {
    for (const action of ACTIONS) {
      const r = whoCan("p-roberta", action.id, action.scope === "project" ? ACQ : null);
      expect(peopleOf(r)).not.toContain(CLAUDE_ID);
    }
  });

  it("claude.allowed è can(Claude) per ogni azione", () => {
    for (const action of ACTIONS) {
      const projectId = action.scope === "project" ? ACQ : undefined;
      const r = whoCan("p-sara", action.id, projectId ?? null);
      if (!r.visible) continue;
      expect(r.claude.allowed, action.id).toBe(
        can(viewerFor(CLAUDE_ID), action.permission as Permission, projectId),
      );
    }
  });
});

describe("whatCan", () => {
  const flat = (r: ReturnType<typeof whatCan>) => {
    if (!r.visible) throw new Error("invisibile");
    return r.groups.flatMap((g) => g.permissions.map((p) => p.permission));
  };

  it("in un progetto: i permessi per cui can() è vero, raggruppati come i ruoli", () => {
    const r = whatCan("p-roberta", "p-marco", ACQ);
    if (!r.visible) throw new Error("invisibile");
    const perms = flat(r);
    expect(perms).toContain("servers.operate");
    expect(perms).not.toContain("release.merge");
    for (const g of r.groups) {
      const order = groupsFor("project").find((x) => x.key === g.groupKey)!.permissions;
      const idx = g.permissions.map((p) => order.indexOf(p.permission));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      for (const p of g.permissions)
        expect(can(viewerFor("p-marco"), p.permission as Permission, ACQ)).toBe(true);
    }
    const op = r.groups
      .flatMap((g) => g.permissions)
      .find((p) => p.permission === "servers.operate")!;
    expect(op.sources).toEqual([expect.objectContaining({ kind: "grant" })]);
  });

  it("nell'istanza (null): i permessi d'istanza", () => {
    const perms = flat(whatCan("p-roberta", "p-matteo", null));
    expect(perms).toContain("automations.manage");
    expect(perms).not.toContain("roles.manage");
  });

  it("un progetto di cui la persona non è membro: nessun permesso di progetto", () => {
    const notMarcos = PROJECTS.find((p) => !isMember("p-marco", p.id))!.id;
    expect(whatCan("p-roberta", "p-marco", notMarcos)).toEqual({ visible: true, groups: [] });
  });

  it("Claude: sempre visibile, i suoi permessi di lavoro, senza fonti", () => {
    const inProject = flat(whatCan("p-sara", CLAUDE_ID, [...visibleProjectIds("p-sara")][0]!));
    expect(new Set(inProject)).toEqual(new Set(CLAUDE_PROJECT_PERMISSIONS));
    expect(new Set(flat(whatCan("p-sara", CLAUDE_ID, null)))).toEqual(
      new Set(CLAUDE_INSTANCE_PERMISSIONS),
    );
    const r = whatCan("p-sara", CLAUDE_ID, null);
    if (!r.visible) throw new Error("invisibile");
    for (const g of r.groups) for (const p of g.permissions) expect(p.sources).toEqual([]);
  });

  it("R-G5: un progetto o una persona che chi guarda non vede", () => {
    const notSaras = PROJECTS.find((p) => !visibleProjectIds("p-sara").has(p.id))!.id;
    expect(whatCan("p-sara", "p-sara", notSaras)).toEqual({ visible: false });
    const hidden = hideMatteoFromSara();
    expect(whatCan("p-roberta", hidden, null).visible).toBe(true);
    expect(whatCan("p-sara", hidden, null)).toEqual({ visible: false });
    expect(whatCan("p-sara", "p-sconosciuto", null)).toEqual({ visible: false });
  });

  it("segue le scritture dello stato", () => {
    expect(flat(whatCan("p-roberta", "p-laura", ACQ))).not.toContain("servers.operate");
    writeAccess((s) =>
      s.grants.push({
        personId: "p-laura",
        projectId: ACQ,
        permission: "servers.operate",
        grantedById: "p-roberta",
        at: "2026-10-29T10:00:00Z",
      }),
    );
    expect(flat(whatCan("p-roberta", "p-laura", ACQ))).toContain("servers.operate");
  });
});
