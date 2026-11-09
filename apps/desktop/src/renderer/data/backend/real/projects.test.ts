import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, serverProject } from "./fakeServer";
import { listProjects } from "./projects";

// I progetti della build app con modello, moduli e cliente (fetta 4): le
// sezioni Docs, Releases, Support e Servers seguono i moduli del server.

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i progetti dal server", () => {
  it("modello, moduli e cliente come li dice il server; il tipo dal server", async () => {
    installFakeServer({
      "GET /api/projects": {
        body: [
          serverProject({
            memberIds: [ME_ID],
            template: "client",
            modules: ["docs"],
            clientName: "Acme",
            kind: "client",
          }),
        ],
      },
    });
    const [project] = await listProjects();
    expect(project).toMatchObject({ template: "client", modules: ["docs"], clientName: "Acme", kind: "client" });
  });

  it("da un server più vecchio: Software con i quattro moduli, interno (come i progetti esistenti)", async () => {
    installFakeServer({ "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] } });
    const [project] = await listProjects();
    expect(project).toMatchObject({
      template: "software",
      modules: ["docs", "releases", "support", "servers"],
      kind: "internal",
    });
    expect(project).not.toHaveProperty("clientName");
  });
});
