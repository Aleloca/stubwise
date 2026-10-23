import { describe, expect, it } from "vitest";
import { search, setLatency } from "./api";
import { isAppRoute } from "./routes";
import { NOTIFICATIONS } from "./seed/notifications";
import { PROJECTS } from "./seed/projects";

const codes = new Set(PROJECTS.map((p) => p.code));
const codeOf = (r: string) => /^#\/p\/([A-Z]+)/.exec(r)?.[1];

describe("route grammar", () => {
  it("accetta e rifiuta le route giuste", () => {
    expect(isAppRoute("#/home")).toBe(true);
    expect(isAppRoute("#/p/CBV")).toBe(true);
    expect(isAppRoute("#/p/CBV/tasks")).toBe(true);
    expect(isAppRoute("#/inbox")).toBe(false);
    expect(isAppRoute("#/p/CBV/tasks/CBV-1")).toBe(false);
    expect(isAppRoute("#/people/x")).toBe(false);
  });

  it("i link delle notifiche sono nella grammatica", () => {
    for (const n of NOTIFICATIONS) {
      expect(isAppRoute(n.link), n.link).toBe(true);
      const c = codeOf(n.link);
      if (c) expect(codes.has(c)).toBe(true);
    }
  });

  it("le route della ricerca sono nella grammatica", async () => {
    setLatency(0);
    for (const q of ["cbv", "giulia", "audin"]) {
      const results = await search(q);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(isAppRoute(r.route), r.route).toBe(true);
        const c = codeOf(r.route);
        if (c) expect(codes.has(c)).toBe(true);
      }
    }
  });
});
