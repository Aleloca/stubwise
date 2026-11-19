import { describe, expect, it } from "vitest";
import { stalledProjects } from "../../src/claude-chat/bridge.js";
import { STALLED_PROJECT_ID, STALLED_TASKS } from "./fixtures-area10.js";

describe("le fixture dei golden dell'area 10 passano dal ponte vero", () => {
  it("chat-s2-stalled: il ponte vede le due task ferme di AUD, la più vecchia prima (il primo giro era vuoto: mancava projectId)", () => {
    expect(stalledProjects(STALLED_TASKS)).toEqual([
      { projectId: STALLED_PROJECT_ID, stalled: [expect.objectContaining({ code: "AUD-7", reason: "idle" }), expect.objectContaining({ code: "AUD-9", reason: "unassigned" })] },
    ]);
  });
});
