import { describe, expect, it } from "vitest";
import { supersedeCandidates, wouldCycle } from "./decision-log.js";

/** Il «superata da» del registro decisioni: una catena, mai un giro (spostato dal prototipo, fetta 4). */
const log = [
  { id: "a", projectId: "p", supersededById: "b" },
  { id: "b", projectId: "p", supersededById: "c" },
  { id: "c", projectId: "p", supersededById: null },
  { id: "d", projectId: "p", supersededById: null },
  { id: "x", projectId: "q", supersededById: null },
];

describe("wouldCycle", () => {
  it("vero se il nuovo legame chiude un giro o punta a sé stessa", () => {
    expect(wouldCycle(log, "c", "a")).toBe(true);
    expect(wouldCycle(log, "b", "a")).toBe(true);
    expect(wouldCycle(log, "a", "a")).toBe(true);
  });
  it("falso su una catena che resta catena", () => {
    expect(wouldCycle(log, "c", "d")).toBe(false);
    expect(wouldCycle(log, "d", "a")).toBe(false);
  });
});

describe("supersedeCandidates", () => {
  it("le voci dello stesso progetto, non sé stessa, non quelle che chiuderebbero un giro", () => {
    expect(supersedeCandidates(log, "c").map((d) => d.id)).toEqual(["d"]);
    expect(supersedeCandidates(log, "zzz")).toEqual([]);
  });
});
