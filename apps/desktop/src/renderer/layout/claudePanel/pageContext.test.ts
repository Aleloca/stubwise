import { describe, expect, it } from "vitest";
import { pageContextOf, pageObjectOf, type PageLookup } from "./pageContext";

// Il contesto ricavato dall'indirizzo (area 10a, Task 8): un riferimento per
// ogni forma di `ContextRef`, e `page` per una rotta senza oggetto.

const PROJECTS: Record<string, string> = { ACQ: "prj-acq", AUD: "prj-aud" };
const OBJECTS: Record<string, string> = {
  "task:ACQ-3": "t-acq-3",
  "release:AUD-V2": "rel8-aud-2",
  "support:ACQ-S2": "sup-acq-2",
  "automation:AUD-A1": "aut-aud-client-data",
};
const lookup: PageLookup = {
  projectIdOf: (code) => PROJECTS[code] ?? null,
  objectIdOf: (kind, code) => OBJECTS[`${kind}:${code}`] ?? null,
};
const at = (pathname: string, search: Record<string, unknown> = {}) =>
  pageContextOf({ pathname, search }, lookup);

describe("pageContextOf", () => {
  it("una task aperta nel pannello, su qualunque pagina", () => {
    expect(at("/p/ACQ/tasks", { task: "ACQ-3" })).toEqual({ kind: "task", taskId: "t-acq-3" });
    expect(at("/home", { task: "ACQ-3" })).toEqual({ kind: "task", taskId: "t-acq-3" });
  });

  it("richiesta, PR, rilascio, conversazione di supporto, automazione", () => {
    expect(at("/p/ACQ/requests", { request: "req-acq-1" })).toEqual({
      kind: "request",
      requestId: "req-acq-1",
    });
    expect(at("/p/AUD/releases", { pr: "opr-aud-244" })).toEqual({
      kind: "pr",
      prId: "opr-aud-244",
    });
    expect(at("/p/AUD/releases/AUD-V2")).toEqual({ kind: "release", releaseId: "rel8-aud-2" });
    expect(at("/p/ACQ/support/ACQ-S2")).toEqual({
      kind: "support",
      conversationId: "sup-acq-2",
    });
    expect(at("/automations/AUD-A1")).toEqual({
      kind: "automation",
      automationId: "aut-aud-client-data",
    });
    expect(at("/automations/AUD-A1/runs/2")).toEqual({
      kind: "automation",
      automationId: "aut-aud-client-data",
    });
  });

  it("impostazioni di progetto e d'istanza", () => {
    expect(at("/p/ACQ/settings/ai")).toEqual({
      kind: "settings",
      projectId: "prj-acq",
      section: "ai",
    });
    expect(at("/p/ACQ/settings")).toEqual({
      kind: "settings",
      projectId: "prj-acq",
      section: "general",
    });
    expect(at("/admin/ai", { tab: "models" })).toEqual({
      kind: "settings",
      projectId: null,
      section: "ai.models",
    });
    expect(at("/admin/people/p-marco")).toEqual({
      kind: "settings",
      projectId: null,
      section: "people",
    });
  });

  it("una rotta senza oggetto: la pagina, col progetto se c'è", () => {
    expect(at("/p/ACQ/tasks")).toEqual({ kind: "page", route: "tasks", projectId: "prj-acq" });
    expect(at("/p/ACQ")).toEqual({ kind: "page", route: "overview", projectId: "prj-acq" });
    expect(at("/p/ACQ/docs/repo-1/some-page")).toEqual({
      kind: "page",
      route: "docs",
      projectId: "prj-acq",
    });
    expect(at("/home")).toEqual({ kind: "page", route: "home", projectId: null });
    expect(at("/")).toEqual({ kind: "page", route: "home", projectId: null });
    expect(at("/mail")).toEqual({ kind: "page", route: "mail", projectId: null });
  });

  it("la Posta (area 10b, D1): una conversazione aperta e l'email nuova", () => {
    expect(at("/mail/thread-1")).toEqual({ kind: "mail", threadId: "thread-1" });
    expect(at("/mail", { compose: "new" })).toEqual({ kind: "mail", threadId: null });
    // Lo slot di «Scrivigli anche per email» del Supporto non è l'email nuova.
    expect(at("/mail", { compose: "support-ACQ-S2" })).toEqual({
      kind: "page",
      route: "mail",
      projectId: null,
    });
  });

  it("R-G5: un oggetto o un progetto che chi guarda non vede non dà contesto", () => {
    expect(at("/p/ACQ/tasks", { task: "ACQ-99" })).toBeNull();
    expect(at("/p/RNC/tasks")).toBeNull();
    expect(at("/automations/RNC-A1")).toBeNull();
    // Senza chi risolve i codici, gli oggetti per codice restano senza contesto.
    expect(
      pageContextOf(
        { pathname: "/p/ACQ/tasks", search: { task: "ACQ-3" } },
        { projectIdOf: lookup.projectIdOf },
      ),
    ).toBeNull();
  });

  it("pageObjectOf: quale codice va risolto in id", () => {
    expect(pageObjectOf({ pathname: "/p/ACQ/tasks", search: { task: "ACQ-3" } })).toEqual({
      kind: "task",
      code: "ACQ-3",
    });
    expect(pageObjectOf({ pathname: "/p/AUD/releases/AUD-V2", search: {} })).toEqual({
      kind: "release",
      code: "AUD-V2",
    });
    expect(pageObjectOf({ pathname: "/automations/sources", search: {} })).toBeNull();
    expect(pageObjectOf({ pathname: "/p/ACQ/tasks", search: {} })).toBeNull();
  });
});
