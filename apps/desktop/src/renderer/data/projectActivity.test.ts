import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "./api";
import { INACTIVE_DAYS, lastActivityOf } from "./projectActivity";
import { CLOCK_START } from "./seed/dates";
import { nextSeq, now, state } from "./store";
import type { ActivityEntry, ProjectRequest, Task } from "./types";

// `lastActivityOf` (area 10b, Task 1): il massimo dei segnali dichiarati.
// I test costruiscono i segnali uno per volta su un progetto vuoto.

const FAR = "2020-01-01T00:00:00Z";
const EMPTY = "prj-empty-10b";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const task = (over: Partial<Task>): Task => ({
  ...structuredClone(state.tasks[0]!),
  id: "t-empty-1",
  projectId: EMPTY,
  createdAt: FAR,
  ...over,
});
const request = (over: Partial<ProjectRequest>): ProjectRequest => ({
  ...structuredClone(state.requests[0]!),
  id: "req-empty-1",
  projectId: EMPTY,
  createdAt: FAR,
  ...over,
});

describe("lastActivityOf", () => {
  it("senza segnali è null", () => {
    expect(lastActivityOf(EMPTY)).toBeNull();
  });

  it("è il massimo dei segnali: creazione delle task, voci d'attività, richieste, registro, supporto, PR, rilasci", () => {
    state.tasks.push(task({ createdAt: "2026-03-01T08:00:00Z" }));
    expect(lastActivityOf(EMPTY)).toBe("2026-03-01T08:00:00Z");

    const entry: ActivityEntry = {
      id: "act-empty-1",
      taskId: "t-empty-1",
      kind: "comment",
      authorId: null,
      at: "2026-04-01T08:00:00Z",
      body: "x",
    };
    state.activity.push(entry);
    expect(lastActivityOf(EMPTY)).toBe("2026-04-01T08:00:00Z");

    state.requests.push(request({ createdAt: "2026-05-01T08:00:00Z" }));
    expect(lastActivityOf(EMPTY)).toBe("2026-05-01T08:00:00Z");

    state.decisionLog.push({
      ...structuredClone(state.decisionLog[0]!),
      id: "dec-empty-1",
      projectId: EMPTY,
      decidedAt: "2026-06-01T08:00:00Z",
    });
    expect(lastActivityOf(EMPTY)).toBe("2026-06-01T08:00:00Z");

    state.supportConversations.push({
      ...structuredClone(state.supportConversations[0]!),
      id: "sup-empty-1",
      projectId: EMPTY,
      messages: [
        { id: "m1", from: "customer", authorId: null, body: "x", at: "2026-07-01T08:00:00Z" },
      ],
    });
    expect(lastActivityOf(EMPTY)).toBe("2026-07-01T08:00:00Z");

    state.openPrs.push({
      ...structuredClone(state.openPrs[0]!),
      id: "opr-empty-1",
      projectId: EMPTY,
      openedAt: "2026-08-01T08:00:00Z",
    });
    expect(lastActivityOf(EMPTY)).toBe("2026-08-01T08:00:00Z");

    state.releases.push({
      ...structuredClone(state.releases[0]!),
      id: "rel-empty-1",
      projectId: EMPTY,
      mergedAt: "2026-09-01T08:00:00Z",
    });
    expect(lastActivityOf(EMPTY)).toBe("2026-09-01T08:00:00Z");
  });

  it("una scrittura su una richiesta vale «adesso»: non porta una data", () => {
    state.requests.push(request({}));
    expect(lastActivityOf(EMPTY)).toBe(FAR);
    state.objectWrites.push({
      kind: "request",
      id: "req-empty-1",
      seq: nextSeq(),
      byId: "p-giulia",
    });
    expect(lastActivityOf(EMPTY)).toBe(now());
  });

  it("una sessione viva di Claude non sposta l'ultima attività (il caso BSC)", () => {
    const live = state.conversations.find((c) => c.id === "cv-run-bsc-1")!;
    expect(live.state).toBe("working");
    const before = lastActivityOf("prj-bsc")!;
    expect(before < live.updatedAt).toBe(true);
    // Ancora più viva: l'ultima attività resta quella di prima.
    live.updatedAt = `${CLOCK_START.slice(0, 10)}T23:59:59Z`;
    expect(lastActivityOf("prj-bsc")).toBe(before);
  });

  it("i quattro progetti inattivi del seme stanno oltre INACTIVE_DAYS, tutti gli altri aperti no", () => {
    const limit = new Date(Date.parse(now()) - INACTIVE_DAYS * 86_400_000).toISOString();
    const quiet = state.projects
      .filter((p) => !p.archived && (lastActivityOf(p.id) ?? "") < limit)
      .map((p) => p.code)
      .sort();
    expect(quiet).toEqual(["BSC", "LNT", "ORT", "SPZ"]);
  });
});
