import { describe, expect, it } from "vitest";
import type { ProjectRequest } from "../data/types";
import {
  OPEN_REQUEST_STATUSES,
  findSimilarRequest,
  isRequestOpen,
  relatedRequests,
  titleWords,
} from "./requests";

function req(id: string, title: string, patch: Partial<ProjectRequest> = {}): ProjectRequest {
  return {
    id,
    code: `ABC-R${id}`,
    projectId: "prj-a",
    title,
    description: "",
    requesterIds: ["p-x"],
    status: "new",
    urgency: "medium",
    similarToId: null,
    mergedIntoId: null,
    taskIds: [],
    createdAt: "2026-10-20T11:00:00Z",
    ...patch,
  };
}

describe("titleWords", () => {
  it("tiene le parole che contano, in minuscolo, senza parole vuote né doppioni", () => {
    expect([...titleWords("The Event page for the showroom, the PAGE")].sort()).toEqual([
      "event",
      "page",
      "showroom",
    ]);
  });

  it("vale anche in italiano", () => {
    expect([...titleWords("Una pagina per l'evento dello showroom")].sort()).toEqual([
      "evento",
      "pagina",
      "showroom",
    ]);
  });
});

describe("findSimilarRequest", () => {
  const landing = req("r1", "Landing page for the showroom event");
  it("trova la richiesta aperta dello stesso progetto con più parole in comune", () => {
    const other = req("r2", "Short video for the kitchens line");
    expect(findSimilarRequest("Event page for the showroom", "prj-a", [other, landing])?.id).toBe(
      "r1",
    );
  });

  it("una parola in comune non basta", () => {
    expect(findSimilarRequest("A page for the fair", "prj-a", [landing])).toBeNull();
  });

  it("ignora gli altri progetti, le archiviate e le fuse", () => {
    const elsewhere = { ...landing, projectId: "prj-b" };
    const archived = { ...landing, status: "archived" as const };
    const merged = { ...landing, mergedIntoId: "r9" };
    for (const candidate of [elsewhere, archived, merged]) {
      expect(findSimilarRequest("Event page for the showroom", "prj-a", [candidate])).toBeNull();
    }
  });

  it("a parità vince la più recente; esclude la richiesta stessa", () => {
    const older = req("r3", "Showroom event page", { createdAt: "2026-10-01T11:00:00Z" });
    const newer = req("r4", "Showroom event page", { createdAt: "2026-10-21T11:00:00Z" });
    expect(findSimilarRequest("Showroom event page", "prj-a", [older, newer])?.id).toBe("r4");
    expect(findSimilarRequest("Showroom event page", "prj-a", [newer], "r4")).toBeNull();
  });
});

describe("relatedRequests", () => {
  it("raccoglie le simili nei due versi e le fuse in questa, senza la richiesta stessa", () => {
    const main = req("m", "Main", { similarToId: "s1" });
    const s1 = req("s1", "S1");
    const s2 = req("s2", "S2", { similarToId: "m" });
    const merged = req("x", "X", { status: "archived", mergedIntoId: "m", similarToId: "m" });
    const unrelated = req("u", "U");
    expect(relatedRequests(main, [main, s1, s2, merged, unrelated]).map((r) => r.id)).toEqual([
      "s1",
      "s2",
      "x",
    ]);
  });
});

describe("isRequestOpen", () => {
  it("aperte = nuova, in rifinitura, pronta", () => {
    expect(OPEN_REQUEST_STATUSES).toEqual(["new", "refining", "ready"]);
    expect(isRequestOpen(req("a", "A"))).toBe(true);
    expect(isRequestOpen(req("a", "A", { status: "converted" }))).toBe(false);
  });
});
