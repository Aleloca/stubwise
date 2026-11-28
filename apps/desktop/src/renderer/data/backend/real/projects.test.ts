import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, serverProject } from "./fakeServer";
import { createProject, listProjects } from "./projects";
import { getSessionPerson } from "./session";
import { me } from "./fakeServer";
import { snippetOf } from "../../projectSettings/integrationText";

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

  it("M4: senza `memberIds` sull'elenco, i membri si chiedono con le persone di workspace (`?include=workspace`)", async () => {
    const p = serverProject();
    delete (p as { memberIds?: unknown }).memberIds;
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [p] },
      [`GET /api/projects/${p.id}/members?include=workspace`]: {
        body: [{ userId: ME_ID, email: "me@x.test", roleId: "r", roleName: "Viewer", explicit: false, workspaceId: "w" }],
      },
    });
    const [project] = await listProjects();
    expect(seen.some((r) => r.path === `/api/projects/${p.id}/members?include=workspace`)).toBe(true);
    expect(project!.memberIds).toEqual([ME_ID]);
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
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ name: "Acme site", code: "ACME", template: "client", clientName: "Acme" });
    expect(project).toMatchObject({ code: "ACME", template: "client", modules: ["docs"], kind: "client", memberIds: [ME_ID] });
  });

  it("F5: la chiave d'ingestione intera solo nella risposta di creazione; il DSN dalla base dell'integrazione", async () => {
    const id = serverProject({ code: "ACME" }).id;
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "POST /api/projects": { status: 201, body: { ...serverProject({ code: "ACME" }), ingestionKey: "sk_full_key_9f3a" } },
      [`GET /api/projects/${id}/integration`]: {
        body: {
          ingestion: { last4: "9f3a", dsnBase: "https://stubwise.example/p/acme" },
          inbound: { url: "https://stubwise.example/inbound" },
        },
      },
    });
    await getSessionPerson();
    const project = await createProject({ code: "ACME", name: "Acme", template: "empty" });
    expect(project.ingestion).toEqual({
      key: "sk_full_key_9f3a",
      dsn: "https://sk_full_key_9f3a@stubwise.example/p/acme",
      snippet: snippetOf("https://sk_full_key_9f3a@stubwise.example/p/acme"),
    });
  });

  it("F5: una risposta senza la chiave (null) non ha niente da mostrare", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "POST /api/projects": { status: 201, body: serverProject({ code: "ACME", ingestionKey: null }) },
    });
    await getSessionPerson();
    expect((await createProject({ code: "ACME", name: "Acme", template: "empty" })).ingestion).toBeNull();
  });

  it("F5: l'integrazione che non si legge non toglie la chiave (il DSN resta vuoto)", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "POST /api/projects": { status: 201, body: { ...serverProject({ code: "ACME" }), ingestionKey: "sk_k" } },
    });
    await getSessionPerson();
    const project = await createProject({ code: "ACME", name: "Acme", template: "empty" });
    expect(project.ingestion).toEqual({ key: "sk_k", dsn: "", snippet: snippetOf("") });
  });

  it("un codice già usato: il rifiuto del prototipo (code_taken), e niente creato", async () => {
    installFakeServer({
      "POST /api/projects": { status: 409, body: { code: "code_taken", message: "Another project already uses this code" } },
    });
    await expect(createProject({ code: "AUD", name: "Again", template: "empty" })).rejects.toThrow("code_taken");
  });
});
