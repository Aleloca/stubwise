import { beforeEach, describe, expect, it } from "vitest";
import { access, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { PEOPLE } from "../seed/people";
import { visibleProjectIds } from "../store";
import { accessState, isFullAdmin, isMember, writeAccess } from "./index";
import { visiblePeopleFor } from "./whoCan";

// `api.access` (area 9a, Task 11): le risposte di «Who can?» con i nomi già
// risolti. R-G5: chi ha dato un permesso, se chi guarda non lo vede, non ha
// nome («given by hand»); e Claude, come sessione, non vede persone.

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const humans = PEOPLE.filter((p) => !p.isClaude).map((p) => p.id);
const isActive = (id: string) =>
  accessState().people.some((p) => p.personId === id && p.status === "active");
const unseenBy = (id: string) => humans.filter((x) => isActive(x) && !visiblePeopleFor(id).has(x));

describe("api.access", () => {
  it("R-G5: chi ha dato il permesso, se chi guarda non lo vede, resta senza nome", async () => {
    const viewer = humans.find((id) => isActive(id) && !isFullAdmin(id) && unseenBy(id).length)!;
    const giver = unseenBy(viewer)[0]!;
    // Una persona che chi guarda vede, in un progetto che vede, di cui è membro.
    const projectId = [...visibleProjectIds(viewer)][0]!;
    const person = [...visiblePeopleFor(viewer)].find((x) => isMember(x, projectId))!;
    writeAccess((s) => {
      s.grants.push({
        personId: person,
        projectId,
        permission: "servers.operate",
        grantedById: giver,
        at: "2026-10-20T10:00:00Z",
      });
    });
    setSessionPersonId(viewer);
    const view = await access.whatCan(person, projectId);
    if (!view.visible) throw new Error("invisibile");
    const row = view.groups.flatMap((g) => g.permissions).find((p) => p.permission === "servers.operate")!;
    expect(row.held).toBe(true);
    expect(row.reasons).toEqual([{ kind: "grant", byName: null, at: "2026-10-20T10:00:00Z" }]);
    // Chi lo vede (un full admin vede tutti) legge il nome.
    setSessionPersonId("p-roberta");
    const full = await access.whatCan(person, projectId);
    if (!full.visible) throw new Error("invisibile");
    const named = full.groups.flatMap((g) => g.permissions).find((p) => p.permission === "servers.operate")!;
    expect(named.reasons).toContainEqual({
      kind: "grant",
      byName: PEOPLE.find((p) => p.id === giver)!.name,
      at: "2026-10-20T10:00:00Z",
    });
  });

  it("Claude come sessione non vede persone: whoCan e whatCan come whoCanChoices", async () => {
    setSessionPersonId("p-claude");
    expect((await access.whoCanChoices()).people).toEqual([]);
    expect(await access.whoCan("approvePlan", "prj-acq")).toEqual({ visible: false });
    expect(await access.whatCan("p-marco", "prj-acq")).toEqual({ visible: false });
  });
});
