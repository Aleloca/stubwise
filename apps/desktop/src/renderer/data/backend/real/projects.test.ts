import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, serverProject } from "./fakeServer";
import { createProject, listProjects } from "./projects";
import { getSessionPerson } from "./session";
import { me } from "./fakeServer";

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

  it("Nuovo progetto: codice, modello, cliente e moduli al server; chi lo crea è membro", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "POST /api/projects": {
        status: 201,
        body: serverProject({ name: "Acme site", code: "ACME", template: "client", modules: ["docs"], clientName: "Acme" }),
      },
    });
    await getSessionPerson();
    const project = await createProject({ code: "ACME", name: " Acme site ", template: "client", clientName: "Acme" });
    expect(seen.at(-1)!.body).toEqual({ name: "Acme site", code: "ACME", template: "client", clientName: "Acme" });
    expect(project).toMatchObject({ code: "ACME", template: "client", modules: ["docs"], kind: "client", memberIds: [ME_ID] });
  });

  it("un codice già usato: il rifiuto del prototipo (code_taken), e niente creato", async () => {
    installFakeServer({
      "POST /api/projects": { status: 409, body: { code: "code_taken", message: "Another project already uses this code" } },
    });
    await expect(createProject({ code: "AUD", name: "Again", template: "empty" })).rejects.toThrow("code_taken");
  });
});
