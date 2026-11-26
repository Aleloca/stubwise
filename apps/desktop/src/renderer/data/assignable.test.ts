import { planBlock } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { assignableIn, isAssignableIn } from "./assignable";
import type { Person } from "./types";

// Chi si assegna in un progetto (area 3, 3e.2): i membri, e Claude solo dove
// la sua riga di `/api/people` lo dice. La riga di Claude nel Planning c'è
// sempre; dove non si assegna non è un bersaglio (planBlock, `member`).

const person = (over: Partial<Person>): Person => ({
  id: "p",
  name: "P",
  initials: "P",
  departmentIds: [],
  isClaude: false,
  presetRole: "",
  ...over,
});
const ADA = person({ id: "ada", name: "Ada" });
const CLAUDE = person({ id: "claude", name: "Claude", isClaude: true, assignableProjectIds: ["here"] });
const HERE = { id: "here", memberIds: ["ada"] };
const ELSEWHERE = { id: "elsewhere", memberIds: ["ada"] };

describe("assignable", () => {
  it("Claude si assegna solo nei progetti della sua riga; una persona per appartenenza", () => {
    expect(isAssignableIn(CLAUDE, HERE)).toBe(true);
    expect(isAssignableIn(CLAUDE, ELSEWHERE)).toBe(false);
    expect(isAssignableIn(ADA, ELSEWHERE)).toBe(true);
    expect(isAssignableIn(person({ id: "bob" }), HERE)).toBe(false);
    // Una persona con assignableProjectIds non è Claude: non basta.
    expect(isAssignableIn(person({ id: "eve", assignableProjectIds: ["here"] }), HERE)).toBe(false);
    expect(assignableIn(HERE, [ADA, CLAUDE])).toEqual(["ada", "claude"]);
    expect(assignableIn(ELSEWHERE, [ADA, CLAUDE])).toEqual(["ada"]);
  });

  it("la riga di Claude dove non si assegna non è un bersaglio, anche per chi pianifica per gli altri", () => {
    const task = { assigneeId: null, closedAt: null };
    const rights = (project: typeof HERE) => ({ me: "ada", others: true, edit: true, members: assignableIn(project, [ADA, CLAUDE]) });
    expect(planBlock(task as never, "claude", rights(ELSEWHERE))).toBe("member");
    expect(planBlock(task as never, "claude", rights(HERE))).toBeNull();
  });
});
