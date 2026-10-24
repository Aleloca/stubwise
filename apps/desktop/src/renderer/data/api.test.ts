import { beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  getProjectByCode,
  getSavedFilter,
  getTaskByCode,
  listDecisionRequests,
  listNotifications,
  listPinnedProjectIds,
  listProjects,
  listRequests,
  listSavedFilters,
  listStalled,
  listTasks,
  listWaitingOnMeProjectIds,
  markNotification,
  resetApi,
  search,
  setLatency,
  setPinned,
  visibleProjectIds,
} from "./api";
import { SAVED_FILTERS } from "./seed/filters";
import { familyOf, state } from "./store";
import { PROJECTS } from "./seed/projects";
import { getSessionPersonId, setSessionPersonId } from "./session";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const codeOf = (id: string) => PROJECTS.find((p) => p.id === id)!.code;

describe("api finta", () => {
  it("getProjectByCode di un codice sconosciuto dà null", async () => {
    expect(await getProjectByCode("XXXX")).toBeNull();
    expect((await getProjectByCode("CBV"))?.code).toBe("CBV");
  });

  it("setPinned cambia i fissati", async () => {
    setSessionPersonId("p-roberta");
    const id = (await getProjectByCode("TLM"))!.id;
    expect(await listPinnedProjectIds()).not.toContain(id);
    await setPinned(id, true);
    expect(await listPinnedProjectIds()).toContain(id);
    await setPinned(id, false);
    expect(await listPinnedProjectIds()).not.toContain(id);
  });

  it("failNext fa fallire solo la chiamata successiva", async () => {
    setSessionPersonId("p-roberta");
    failNext("listProjects");
    await expect(listProjects()).rejects.toThrow();
    await expect(listProjects()).resolves.toHaveLength(50);
  });

  it("markNotification aggiorna la notifica", async () => {
    const first = (await listNotifications())[0]!;
    await markNotification(first.id, { read: true, archived: true });
    const again = (await listNotifications()).find((n) => n.id === first.id)!;
    expect(again.read).toBe(true);
    expect(again.archived).toBe(true);
  });

  it("search('cbv') trova progetto e task, senza badare alle maiuscole", async () => {
    const results = await search("cbv");
    expect(results.some((r) => r.kind === "project" && r.code === "CBV")).toBe(true);
    expect(results.some((r) => r.kind === "task" && r.code?.startsWith("CBV-"))).toBe(true);
    expect(await search("")).toEqual([]);
  });

  it("resetApi riporta la sessione alla persona di default", () => {
    setSessionPersonId("p-sara");
    resetApi();
    expect(getSessionPersonId()).toBe("p-giulia");
  });
});

describe("visibilità per chi guarda", () => {
  it("il full admin vede tutti i progetti, gli altri solo quelli di cui sono membri", () => {
    expect(visibleProjectIds("p-roberta").size).toBe(50);
    const sara = visibleProjectIds("p-sara");
    for (const p of PROJECTS) expect(sara.has(p.id)).toBe(p.memberIds.includes("p-sara"));
    expect(sara.size).toBeGreaterThan(0);
    expect(sara.size).toBeLessThan(50);
  });

  it("Sara vede solo i progetti di cui è membro; uno invisibile è come inesistente", async () => {
    setSessionPersonId("p-sara");
    const projects = await listProjects();
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) expect(p.memberIds).toContain("p-sara");
    expect(await getProjectByCode("AUD")).toBeNull();
    expect(await getProjectByCode("MKX")).toBeNull();
    expect((await getProjectByCode("STW"))?.code).toBe("STW");
  });

  it("listTasks e getTaskByCode non danno task di progetti invisibili", async () => {
    setSessionPersonId("p-sara");
    const visible = visibleProjectIds("p-sara");
    const tasks = await listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(visible.has(t.projectId)).toBe(true);
    expect(await getTaskByCode("MKX-2")).toBeNull();
    expect((await getTaskByCode("STW-1"))?.code).toBe("STW-1");
  });

  it("search('Audin') per chi non è membro di AUD non dà né il progetto né le sue task", async () => {
    setSessionPersonId("p-sara");
    const results = await search("Audin");
    expect(results.some((r) => r.code === "AUD")).toBe(false);
    expect(results.some((r) => r.code?.startsWith("AUD-"))).toBe(false);
    const byCode = await search("AUD-");
    expect(byCode.filter((r) => r.kind === "task")).toEqual([]);
    setSessionPersonId("p-giulia");
    expect((await search("Audin")).some((r) => r.code === "AUD")).toBe(true);
  });

  it("listNotifications dà solo le notifiche di cui la persona è destinataria", async () => {
    setSessionPersonId("p-sara");
    const mine = await listNotifications();
    expect(mine.length).toBeGreaterThan(0);
    for (const n of mine) expect(n.recipientIds).toContain("p-sara");
    setSessionPersonId("p-giulia");
    const giulia = await listNotifications();
    expect(giulia.map((n) => n.id)).not.toEqual(mine.map((n) => n.id));
  });

  it("i fissati sono per persona: setPinned di Sara non tocca quelli di Giulia", async () => {
    const giuliaBefore = await listPinnedProjectIds();
    setSessionPersonId("p-sara");
    const saraBefore = await listPinnedProjectIds();
    expect(saraBefore).not.toEqual(giuliaBefore);
    expect(saraBefore.length).toBeGreaterThanOrEqual(6);
    const unpinned = saraBefore[0]!;
    await setPinned(unpinned, false);
    expect(await listPinnedProjectIds()).not.toContain(unpinned);
    setSessionPersonId("p-giulia");
    expect(await listPinnedProjectIds()).toEqual(giuliaBefore);
  });

  it("non si fissa un progetto invisibile", async () => {
    setSessionPersonId("p-sara");
    await setPinned("prj-aud", true);
    expect(await listPinnedProjectIds()).not.toContain("prj-aud");
  });

  it("un filtro privato di Giulia: per Sara non esiste, nemmeno nell'elenco", async () => {
    const privateOfGiulia = SAVED_FILTERS.find(
      (f) => f.ownerId === "p-giulia" && f.visibility === "private",
    )!;
    expect(await getSavedFilter(privateOfGiulia.id)).not.toBeNull();
    setSessionPersonId("p-sara");
    expect(await getSavedFilter(privateOfGiulia.id)).toBeNull();
    const list = await listSavedFilters();
    expect(list.some((f) => f.id === privateOfGiulia.id)).toBe(false);
    for (const f of list) expect(f.visibility === "public" || f.ownerId === "p-sara").toBe(true);
  });

  it("il filtro pubblico «Open» di un autore con più visibilità dà a Sara solo le task sue", async () => {
    const open = SAVED_FILTERS.find((f) => f.name === "Open" && f.visibility === "public")!;
    setSessionPersonId("p-sara");
    const filter = (await getSavedFilter(open.id))!;
    const tasks = await listTasks(filter.criteria);
    const visible = visibleProjectIds("p-sara");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(visible.has(t.projectId)).toBe(true);
    setSessionPersonId("p-roberta");
    expect((await listTasks(open.criteria)).length).toBeGreaterThan(tasks.length);
  });

  it("listRequests di un progetto invisibile è vuoto", async () => {
    setSessionPersonId("p-sara");
    expect(await listRequests("prj-mkx")).toEqual([]);
    setSessionPersonId("p-giulia");
    expect((await listRequests("prj-mkx")).length).toBeGreaterThan(0);
  });

  it("decisioni e ferme restano dentro i progetti visibili", async () => {
    setSessionPersonId("p-sara");
    const visible = visibleProjectIds("p-sara");
    const tasks = new Map((await listTasks()).map((t) => [t.id, t]));
    for (const d of await listDecisionRequests({})) expect(tasks.has(d.taskId)).toBe(true);
    for (const { task } of await listStalled()) expect(visible.has(task.projectId)).toBe(true);
  });

  it("una bloccante invisibile non ferma la task per chi non la vede", async () => {
    const giuliaSees = visibleProjectIds("p-giulia");
    const saraSees = visibleProjectIds("p-sara");
    setSessionPersonId("p-sara");
    const stalledForSara = new Set((await listStalled()).map((s) => s.task.id));
    // Una task aperta e non ferma che Sara vede, e una aperta in un progetto
    // che vede solo Giulia: la seconda blocca la prima.
    const target = state.tasks.find(
      (t) =>
        saraSees.has(t.projectId) &&
        giuliaSees.has(t.projectId) &&
        familyOf(t) !== "closed" &&
        !stalledForSara.has(t.id),
    )!;
    const blocker = state.tasks.find(
      (t) => giuliaSees.has(t.projectId) && !saraSees.has(t.projectId) && familyOf(t) !== "closed",
    )!;
    blocker.links.push({ kind: "blocks", taskId: target.id });

    expect((await listStalled()).find((s) => s.task.id === target.id)).toBeUndefined();
    expect(await listTasks({ stalled: true })).not.toContainEqual(expect.objectContaining({ id: target.id }));
    setSessionPersonId("p-giulia");
    const forGiulia = (await listStalled()).find((s) => s.task.id === target.id);
    expect(forGiulia?.stall.reason).toEqual({ kind: "blocked_by", taskId: blocker.id });
  });

  it("«ti aspetta» si ricava da decisioni aperte e richieste nuove", async () => {
    const giulia = await listWaitingOnMeProjectIds();
    expect(giulia.map(codeOf)).toContain("STW");
    expect(giulia.map(codeOf)).not.toContain("AUD");
    const asked = await listDecisionRequests({ askedOfId: "p-giulia", open: true });
    expect(asked.length).toBeGreaterThanOrEqual(3);
    setSessionPersonId("p-sara");
    const sara = await listWaitingOnMeProjectIds();
    expect(sara.length).toBeGreaterThan(0);
    for (const id of sara) expect(visibleProjectIds("p-sara").has(id)).toBe(true);
  });
});
