import { beforeEach, describe, expect, it } from "vitest";
import {
  listRequests,
  mail,
  projectSettings,
  releases,
  resetApi,
  setLatency,
  support,
} from "./api";
import { INACTIVE_DAYS, lastActivityOf } from "./projectActivity";
import { CLOCK_START } from "./seed/dates";
import { setSessionPersonId } from "./session";
import { now, state, visibleProjectIds } from "./store";
import { can, viewerFor, type Permission } from "./viewer";

// Il seme del 10b (area 10b, Task 1): quattro progetti inattivi, due richieste
// dal supporto e una PR pronta in ACQ, la task convertita, i consumi del mese.

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const LUCA = "p-luca";
const DAVIDE = "p-davide";
const SARA = "p-sara";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const holds = (personId: string, perm: string, projectId: string) =>
  can(viewerFor(personId), perm as Permission, projectId);

beforeEach(() => {
  setLatency(0);
  resetApi();
});

/** I progetti aperti che `personId` vede e che non hanno attività da `INACTIVE_DAYS`. */
function inactiveFor(personId: string): string[] {
  const limit = new Date(Date.parse(now()) - INACTIVE_DAYS * 86_400_000).toISOString();
  return state.projects
    .filter((p) => !p.archived && visibleProjectIds(personId).has(p.id))
    .filter((p) => (lastActivityOf(p.id) ?? "") < limit)
    .map((p) => p.code)
    .sort();
}

describe("i progetti inattivi", () => {
  it("sono in fondo, dopo RNC: gli indici di prima non si spostano", () => {
    const codes = state.projects.map((p) => p.code);
    expect(codes.slice(-5)).toEqual(["RNC", "ORT", "SPZ", "LNT", "BSC"]);
  });

  it("Roberta ne vede esattamente quattro (RNC, archiviato, no)", () => {
    expect(inactiveFor(ROBERTA)).toEqual(["BSC", "LNT", "ORT", "SPZ"]);
  });

  it("Giulia vede ORT e nessun altro dei nuovi, e lo gestisce", () => {
    expect(inactiveFor(GIULIA)).toEqual(["ORT"]);
    for (const code of ["spz", "lnt", "bsc"])
      expect(visibleProjectIds(GIULIA).has(`prj-${code}`)).toBe(false);
    expect(holds(GIULIA, "project.settings.manage", "prj-ort")).toBe(true);
  });

  it("Laura vede LNT e non lo gestisce", () => {
    expect(inactiveFor(LAURA)).toEqual(["LNT"]);
    expect(holds(LAURA, "project.settings.manage", "prj-lnt")).toBe(false);
  });

  it("ogni progetto nuovo ha due o tre task, con l'ultima attività fra 95 e 140 giorni prima", () => {
    for (const code of ["ort", "spz", "lnt", "bsc"]) {
      const tasks = state.tasks.filter((t) => t.projectId === `prj-${code}`);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks.length).toBeLessThanOrEqual(3);
      for (const t of tasks) {
        const days = (Date.parse(CLOCK_START) - Date.parse(t.lastActivityAt)) / 86_400_000;
        expect(days, t.code).toBeGreaterThanOrEqual(95);
        expect(days, t.code).toBeLessThanOrEqual(140);
      }
    }
  });

  it("BSC ha una sessione di Claude viva, quindi non si può archiviare adesso", () => {
    as(ROBERTA);
    expect(projectSettings.busyReasonsOf("prj-bsc")).not.toEqual([]);
    expect(projectSettings.busyReasonsOf("prj-ort")).toEqual([]);
  });
});

describe("ACQ", () => {
  it("due richieste dal supporto, una `high` e una `low`, nate da ACQ-S5 e ACQ-S6", async () => {
    const fromSupport = state.requests.filter(
      (r) => r.projectId === ACQ && r.origin?.kind === "support",
    );
    const byConversation = Object.fromEntries(
      fromSupport.map((r) => [
        state.supportConversations.find((c) => c.id === r.origin!.conversationId)!.code,
        r.urgency,
      ]),
    );
    expect(byConversation).toMatchObject({ "ACQ-S5": "high", "ACQ-S6": "low" });
    as(ROBERTA);
    expect((await listRequests(ACQ)).filter((r) => r.origin?.kind === "support")).toHaveLength(4);
  });

  it("ACQ-S2 aspetta il team: è la conversazione che le scene del supporto usano", async () => {
    as(LAURA);
    expect((await support.getSupportConversation("ACQ-S2"))!.state).toBe("waiting_us");
  });

  it("chi può cosa in ACQ", () => {
    expect(visibleProjectIds(LUCA).has(ACQ)).toBe(false);
    expect(holds(LAURA, "project.members.manage", ACQ)).toBe(true);
    expect(holds(LAURA, "automations.manage", ACQ)).toBe(true);
    expect(holds(DAVIDE, "support.reply", ACQ)).toBe(true);
    expect(holds(SARA, "automations.manage", ACQ)).toBe(false);
    expect(holds(SARA, "project.usage.view", ACQ)).toBe(false);
    expect(holds(SARA, "usage.view", ACQ)).toBe(false);
    // Almeno una persona del reparto Support vede ACQ.
    const support = state.access.departments.find((d) => d.departmentId === "dep-support")!;
    expect(support.memberIds.some((id) => visibleProjectIds(id).has(ACQ))).toBe(true);
  });

  it("la task convertita: la richiesta `high`, descrizione vuota, assegnata a Laura che può modificarla", () => {
    const request = state.requests.find((r) => r.id === "req-acq-3")!;
    expect(request.urgency).toBe("high");
    const t = state.tasks.find((x) => x.requestId === request.id)!;
    expect(t).toMatchObject({ projectId: ACQ, code: "ACQ-7", description: "", assigneeId: LAURA });
    expect(request.taskIds).toEqual([t.id]);
    expect(holds(LAURA, "tickets.edit", ACQ)).toBe(true);
  });

  it("Giulia ha una conversazione della Posta con un messaggio a cui rispondere", async () => {
    as(GIULIA);
    const rows = await mail.listMailThreads();
    expect(rows.length).toBeGreaterThan(0);
    // La scena sceglie la più recente scritta da un altro: la nomina qui.
    const mine = state.mailboxes.find((b) => b.personId === GIULIA)!.email;
    const incoming = state.mailMessages
      .filter((m) => m.mailboxPersonIds.includes(GIULIA) && m.kind === "email")
      .filter((m) => m.from.email !== mine)
      .sort((a, b) => b.at.localeCompare(a.at));
    expect(incoming.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.threadId === incoming[0]!.threadId)).toBe(true);
  });

  it("la PR del seme è in coda di rilascio per Laura, senza note, con tre commit di cui uno senza codice", async () => {
    as(LAURA);
    const queue = await releases.listReleaseQueue(ACQ);
    const item = queue.find((q) => q.id === "opr-acq-77")!;
    expect(item).toMatchObject({ origin: "stubwise", taskId: "t-acq-7", canMerge: true });
    expect(item).not.toHaveProperty("releaseNotes");
    const commits = item.commits!;
    expect(commits).toHaveLength(3);
    expect(commits.filter((c) => /\bACQ-\d+\b/.test(c.message))).toHaveLength(2);
  });
});

describe("i consumi del mese", () => {
  it("coprono almeno cinque progetti, fra il 1° e CLOCK_START", () => {
    const month = CLOCK_START.slice(0, 7);
    const records = state.instance.usage.filter(
      (r) => r.at.startsWith(month) && r.at <= CLOCK_START,
    );
    const projects = new Set(records.flatMap((r) => (r.projectId ? [r.projectId] : [])));
    expect(projects.size).toBeGreaterThanOrEqual(5);
    // Laura ne vede almeno due con `project.usage.view` e almeno uno senza.
    const withView = [...projects].filter((id) => holds(LAURA, "project.usage.view", id));
    const without = [...projects].filter((id) => !holds(LAURA, "project.usage.view", id));
    expect(withView.length).toBeGreaterThanOrEqual(2);
    expect(without.length).toBeGreaterThanOrEqual(1);
  });
});
