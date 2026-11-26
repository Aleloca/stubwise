import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../data/api";
import type { ChangeEntry as StoredChange } from "../data/changelog/types";
import { MOVE_TASK } from "../data/seed/claudeActions";
import { state } from "../data/store";
import type { ActivityEntry, DecisionLogEntry } from "../data/types";
import i18n, { setLanguage } from "../i18n";
import { renderRoute } from "../test/renderRoute";
import { renderWithData } from "../test/renderWithData";
import { ActivityFeed } from "./task/ActivityFeed";

// «via Claude Code» (D4 della parità MCP, revisione finale I2): una persona
// che agisce da Claude Code col suo PAT resta l'autore, e accanto al suo nome
// si legge «via Claude Code» — nell'attività della task, nel registro delle
// modifiche e nel registro decisioni. Non è «Claude on behalf of»: quello è
// il Claude dell'app, che agisce PER la persona.

const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("l'attività della task", () => {
  it("commento, cambio di campo e decisione: «Giulia Ferri via Claude Code», in en e in it", async () => {
    const base = { taskId: MOVE_TASK.id, authorId: GIULIA, viaClaudeCode: true } as const;
    state.activity.push(
      {
        ...base,
        id: "act-cc-comment",
        kind: "comment",
        at: "2026-11-26T10:00:00Z",
        body: "Done from the editor.",
      } as ActivityEntry,
      {
        ...base,
        id: "act-cc-field",
        kind: "field_change",
        at: "2026-11-26T10:01:00Z",
        field: "priority",
        from: "low",
        to: "high",
      } as ActivityEntry,
      {
        ...base,
        id: "act-cc-decision",
        kind: "decision",
        at: "2026-11-26T10:02:00Z",
      } as ActivityEntry,
    );
    renderWithData(<ActivityFeed task={state.tasksById.get(MOVE_TASK.id)!} canComment />, {
      personId: ROBERTA,
    });
    const comment = await waitFor(() => {
      const el = [...document.querySelectorAll('[data-activity="comment"]')].find((e) =>
        /from the editor/.test(e.textContent ?? ""),
      );
      expect(el).toBeDefined();
      return el!;
    });
    expect(text(comment)).toContain("Giulia Ferri via Claude Code");
    const field = [...document.querySelectorAll('[data-activity="field_change"]')]
      .map(text)
      .find((r) => /priority/i.test(r));
    expect(field).toMatch(/^Giulia Ferri via Claude Code · /);
    const decision = [...document.querySelectorAll('[data-activity="decision"]')]
      .map(text)
      .find((r) => /via Claude Code/.test(r));
    expect(decision).toContain("Giulia Ferri via Claude Code decided");
    // Non è il segno del Claude dell'app.
    expect(text(comment)).not.toMatch(/on behalf of/);

    act(() => setLanguage("it"));
    await waitFor(() => expect(text(comment)).toContain("Giulia Ferri via Claude Code"));
  });

  it("senza il campo (le voci di prima, un server più vecchio) il nome è da solo", async () => {
    state.activity.push({
      id: "act-plain",
      taskId: MOVE_TASK.id,
      kind: "comment",
      authorId: GIULIA,
      at: "2026-11-26T10:00:00Z",
      body: "Plain comment.",
    } as ActivityEntry);
    renderWithData(<ActivityFeed task={state.tasksById.get(MOVE_TASK.id)!} canComment />, {
      personId: ROBERTA,
    });
    const el = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-activity="comment"]')].find((e) =>
        /Plain comment/.test(e.textContent ?? ""),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(text(el)).not.toContain("via Claude Code");
  });
});

describe("il registro delle modifiche", () => {
  it("la frase dice «Roberta Conti via Claude Code …»", async () => {
    const entry: StoredChange = {
      id: "chg-cc-1",
      kind: "project.switch_changed",
      at: new Date(Date.parse(state.changelog.at(-1)!.at) + 60_000).toISOString(),
      actorId: ROBERTA,
      projectId: "prj-mkx",
      object: { type: "project", id: "prj-mkx", label: "MKX" },
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
      viaClaudeCode: true,
    };
    state.changelog.push(entry);
    renderRoute("/admin/changelog", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    const el = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-id="chg-cc-1"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(text(el.querySelector("p"))).toMatch(
      /^Roberta \S+ via Claude Code turned off the weekly brief in MKX\./,
    );
    expect(within(el).queryByRole("img", { name: "Made with Claude" })).toBeNull();
  });
});

describe("il registro decisioni", () => {
  it("chi ha deciso, con «via Claude Code» accanto", async () => {
    const decision: DecisionLogEntry = {
      id: "dl-cc-1",
      projectId: "prj-mkx",
      source: "manual",
      taskId: null,
      title: "Decided from the editor",
      context: null,
      decision: "Keep Postgres.",
      decidedById: GIULIA,
      decidedAt: "2026-11-26T10:00:00Z",
      supersededById: null,
      viaClaudeCode: true,
    };
    state.decisionLog.push(decision);
    renderRoute("/p/MKX/overview", ROBERTA);
    const list = await screen.findByRole("list", { name: "Decision log" });
    const row = await waitFor(() => {
      const found = [...list.querySelectorAll("li")].find((li) =>
        /Decided from the editor/.test(li.textContent ?? ""),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(text(row)).toContain("Giulia Ferri via Claude Code");
  });
});
