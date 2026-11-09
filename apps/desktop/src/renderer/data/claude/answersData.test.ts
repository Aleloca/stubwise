import { beforeEach, describe, expect, it } from "vitest";
import { stallOf } from "../../domain/stalled";
import * as api from "../api";
import { visiblePeopleFor } from "../access/whoCan";
import { setSessionPersonId } from "../session";
import { PEOPLE } from "../seed/people";
import { recordUsage } from "../instance/usage";
import { advanceNow, familyOf, now, openDecisions, state } from "../store";
import type { Task } from "../types";
import { can, viewerFor } from "../viewer";
import { spendThisMonthFor, stalledProjectsFor } from "./answersData";

// Le letture delle risposte di Claude sui dati (area 10b, Task 6): i numeri
// sono quelli che chi chiede ritrova a mano. Le ferme si ricontano qui con
// `stallOf` sui soli progetti che la persona vede; la spesa si rilegge con
// le letture di Usage (`getUsage`, `getProjectUsage`).

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const SARA = "p-sara";

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

/** Il calcolo indipendente: per progetto visibile, quante ferme e i giorni della più vecchia. */
async function expectedStalled(personId: string) {
  setSessionPersonId(personId);
  const projects = await api.listProjects();
  const tasks = await api.listTasks();
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, { stalled: number; oldestDays: number }>();
  for (const p of projects) {
    const days = tasks
      .filter((t) => t.projectId === p.id)
      .flatMap((t: Task) => {
        const stall = stallOf(t, {
          family: familyOf(t),
          openDecisions: openDecisions(),
          tasksById,
          familyOf,
          thresholds: p.stallThresholds,
        });
        return stall ? [stall.days] : [];
      });
    if (days.length > 0) out.set(p.code, { stalled: days.length, oldestDays: Math.max(...days) });
  }
  return out;
}

describe("stalledProjectsFor", () => {
  for (const personId of [ROBERTA, GIULIA]) {
    it(`${personId}: i numeri del calcolo indipendente, dal più fermo`, async () => {
      const expected = await expectedStalled(personId);
      const rows = stalledProjectsFor(personId);
      expect(
        new Map(rows.map((r) => [r.code, { stalled: r.stalled, oldestDays: r.oldest.days }])),
      ).toEqual(expected);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1]!.oldest.days).toBeGreaterThanOrEqual(rows[i]!.oldest.days);
      }
      for (const r of rows) {
        expect(r.thresholdDays).toBe(
          state.projectsById.get(r.projectId)!.stallThresholds.activeDays,
        );
      }
    });
  }

  it("Giulia non riceve progetti che vede solo Roberta", () => {
    const giulia = new Set(stalledProjectsFor(GIULIA).map((r) => r.code));
    const roberta = stalledProjectsFor(ROBERTA).map((r) => r.code);
    const onlyRoberta = roberta.filter((c) => !giulia.has(c));
    expect(onlyRoberta.length).toBeGreaterThan(0);
    setSessionPersonId(GIULIA);
    for (const r of stalledProjectsFor(GIULIA)) {
      expect(viewerFor(GIULIA).personId).toBe(GIULIA);
      expect(onlyRoberta).not.toContain(r.code);
    }
  });

  it("con `projectId`: solo quel progetto; uno invisibile dà l'elenco vuoto", () => {
    const mkx = state.projects.find((p) => p.code === "MKX")!;
    const rows = stalledProjectsFor(GIULIA, mkx.id);
    expect(rows.map((r) => r.code)).toEqual(["MKX"]);
    expect(rows[0]).toEqual(stalledProjectsFor(GIULIA).find((r) => r.code === "MKX"));
    const lnt = state.projects.find((p) => p.code === "LNT")!;
    expect(stalledProjectsFor(ROBERTA, lnt.id)).toHaveLength(1);
    expect(stalledProjectsFor(GIULIA, lnt.id)).toEqual([]);
  });

  it("la persona della decisione c'è solo se chi chiede la vede (R-G5)", () => {
    const mkx = state.projects.find((p) => p.code === "MKX")!;
    const oldest = stalledProjectsFor(GIULIA, mkx.id)[0]!.oldest;
    const task = state.tasks.find((t) => t.code === oldest.taskCode)!;
    // La segnalazione a mano viene prima della decisione (`stallOf`).
    task.manualStall = null;
    const ask = (askedOfId: string) => {
      state.decisions.push({
        id: `dr-test-${askedOfId}`,
        taskId: task.id,
        askedById: GIULIA,
        askedOfId,
        question: "Which one?",
        options: ["A", "B"],
        // Più vecchia di ogni altra ferma di MKX: resta la più vecchia del progetto.
        createdAt: "2026-01-01T09:00:00Z",
        withdrawnAt: null,
        answer: null,
      });
    };
    const seen = visiblePeopleFor(GIULIA);
    const hidden = PEOPLE.find((p) => !p.isClaude && !seen.has(p.id));
    expect(hidden, "una persona che Giulia non vede").toBeDefined();
    ask(hidden!.id);
    const blind = stalledProjectsFor(GIULIA, mkx.id)[0]!.oldest;
    expect(blind.taskCode).toBe(task.code);
    expect(blind.reason).toEqual({ kind: "decision" });
    expect(JSON.stringify(stalledProjectsFor(GIULIA))).not.toContain(hidden!.id);
    // Una persona che vede (Roberta): la persona c'è.
    state.decisions.pop();
    expect(seen.has(ROBERTA)).toBe(true);
    ask(ROBERTA);
    expect(stalledProjectsFor(GIULIA, mkx.id)[0]!.oldest.reason).toEqual({
      kind: "decision",
      personId: ROBERTA,
    });
  });

  it("la task che blocca c'è (le bloccanti si cercano solo fra le visibili)", () => {
    const mkx = state.projects.find((p) => p.code === "MKX")!;
    const [blocked, blocker] = state.tasks.filter(
      (t) => t.projectId === mkx.id && familyOf(t) !== "closed",
    );
    blocker!.links = [...blocker!.links, { kind: "blocks", taskId: blocked!.id }];
    blocked!.lastActivityAt = "2026-01-01T09:00:00Z";
    blocked!.manualStall = null;
    const oldest = stalledProjectsFor(GIULIA, mkx.id)[0]!.oldest;
    expect(oldest.taskCode).toBe(blocked!.code);
    expect(oldest.reason).toEqual({ kind: "blocked_by", taskId: blocker!.id });
  });
});

describe("spendThisMonthFor", () => {
  it("Roberta (`usage.view`): il totale e i primi 3 di Usage, col budget", async () => {
    setSessionPersonId(ROBERTA);
    const usage = await api.instance.getUsage({ range: { month: true }, groupBy: "project" });
    const view = spendThisMonthFor(ROBERTA);
    expect(view.scope).toBe("instance");
    if (view.scope !== "instance") return;
    expect(view.totalUsd).toBe(usage.totals.costUsd);
    expect(view.budgetUsd).toBe(state.instance.budget.monthlyUsd);
    const projects = usage.rows.filter((r) => r.key !== null);
    expect(view.top).toEqual(
      projects.slice(0, 3).map((r) => ({ projectId: r.key, code: r.code, usd: r.costUsd })),
    );
    expect(view.asOf).toBe(now());
  });

  it("Roberta: un progetto archiviato conta in «Other projects», che entra nei primi 3 se spende", () => {
    for (const code of ["AUD", "STW", "CBV"])
      state.projects.find((p) => p.code === code)!.archived = { at: now(), byId: ROBERTA };
    const view = spendThisMonthFor(ROBERTA);
    if (view.scope !== "instance") throw new Error(view.scope);
    expect(view.top[0]).toMatchObject({ projectId: null, code: null });
    expect(view.top.map((r) => r.code)).not.toContain("AUD");
  });

  it("senza budget: `budgetUsd` null", () => {
    state.instance.budget.monthlyUsd = null;
    const view = spendThisMonthFor(ROBERTA);
    expect(view.scope === "instance" && view.budgetUsd).toBeNull();
  });

  it("Laura: la somma di `getProjectUsage` dei suoi progetti, nessun «Other projects»", async () => {
    expect(can(viewerFor(LAURA), "usage.view")).toBe(false);
    setSessionPersonId(LAURA);
    const mine = (await api.listProjects()).filter((p) =>
      can(viewerFor(LAURA), "project.usage.view", p.id),
    );
    expect(mine.length).toBeGreaterThan(0);
    let total = 0;
    for (const p of mine) {
      const u = await api.projectSettings.getProjectUsage(p.id, {
        range: { month: true },
        groupBy: "day",
      });
      total += u!.totals.costUsd;
    }
    const view = spendThisMonthFor(LAURA);
    expect(view.scope).toBe("projects");
    if (view.scope !== "projects") return;
    expect(view.totalUsd).toBeCloseTo(total, 6);
    expect(view.projects.map((p) => p.code).sort()).toEqual(mine.map((p) => p.code).sort());
    expect(view.projects.every((p) => p.projectId !== null)).toBe(true);
    setSessionPersonId(ROBERTA);
    const instance = await api.instance.getUsage({ range: { month: true }, groupBy: "project" });
    expect(view.totalUsd).not.toBe(instance.totals.costUsd);
  });

  it("Sara: `none`", () => {
    expect(spendThisMonthFor(SARA)).toEqual({ scope: "none" });
  });

  it("il mese si misura su `now()`: al mese dopo la spesa riparte", () => {
    const before = spendThisMonthFor(ROBERTA);
    if (before.scope !== "instance") throw new Error(before.scope);
    expect(before.totalUsd).toBeGreaterThan(0);
    // «Fai passare il tempo» fino al mese dopo.
    const start = Date.parse(now());
    const next = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 2);
    advanceNow(next - start);
    const after = spendThisMonthFor(ROBERTA);
    if (after.scope !== "instance") throw new Error(after.scope);
    expect(after.totalUsd).toBe(0);
    expect(after.top).toEqual([]);
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    recordUsage({
      at: now(),
      operation: "chat",
      model: "claude-sonnet-4-5",
      projectId: acq.id,
      providerId: state.instance.providers[0]!.id,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      costUsd: 1.5,
      conversationId: null,
    });
    const again = spendThisMonthFor(ROBERTA);
    if (again.scope !== "instance") throw new Error(again.scope);
    expect(again.totalUsd).toBe(1.5);
    expect(again.top).toEqual([{ projectId: acq.id, code: "ACQ", usd: 1.5 }]);
  });
});
