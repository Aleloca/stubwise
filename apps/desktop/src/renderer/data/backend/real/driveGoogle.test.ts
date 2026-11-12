import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { driveGoogleFunctions } from "./driveGoogle";
import { installFakeServer, ME_ID, PROJECT_ID, type SeenRequest } from "./fakeServer";

// Google Drive nel Drive dei progetti (area 6, F5; il rimando dell'area 5):
// le rotte della BOZZA del piano (`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`),
// finché 72 non le fissa. `google` resta spento nella build app.

const FILE_ID = "44444444-4444-4444-8444-444444444444";
const LINK = "66666666-6666-4666-8666-666666666666";
const g = driveGoogleFunctions;

const googleRow = (over: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  code: "AUD-F7",
  projectId: PROJECT_ID,
  projectCode: "AUD",
  source: "google",
  name: "Brief cliente",
  mime: "application/vnd.google-apps.document",
  type: "doc",
  sizeBytes: null,
  addedById: ME_ID,
  addedAt: "2026-11-10T09:00:00.000Z",
  opens90d: 0,
  lastOpenedAt: null,
  summaryLine: null,
  permissions: { delete: false, remove: true, hide: false, retry: false },
  googleFileId: "g-1",
  googleOwner: "bob@acme.test",
  folderLinkId: null,
  hidden: false,
  unavailable: null,
  ...over,
});
const link = (over: Record<string, unknown> = {}) => ({
  id: LINK,
  projectId: PROJECT_ID,
  name: "Clienti",
  googleFolderId: "gf-1",
  linkedById: ME_ID,
  linkedAt: "2026-11-01T09:00:00.000Z",
  status: "ok",
  expiredAt: null,
  fileCount: 12,
  accessLost: false,
  ...over,
});
const writes = (seen: SeenRequest[]) =>
  seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body]);

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

describe("F5: i selettori (il mio Drive, con il mio account)", () => {
  it("«Aggiungi da Google Drive»: un elenco piatto con la ricerca, chi è già nel progetto segnato", async () => {
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/drive/google/files`]: {
        body: [
          {
            googleFileId: "g-1",
            name: "Brief cliente",
            type: "doc",
            owner: "bob@acme.test",
            modifiedAt: "2026-11-09T10:00:00.000Z",
            alreadyInProject: true,
          },
        ],
      },
    });
    const out = await g.listGoogleFiles!(PROJECT_ID, " brief ");
    expect(out).toEqual([
      {
        googleFileId: "g-1",
        name: "Brief cliente",
        type: "doc",
        owner: "bob@acme.test",
        modifiedAt: "2026-11-09T10:00:00.000Z",
        alreadyInProject: true,
      },
    ]);
    expect(new URLSearchParams(seen[0]!.path.split("?")[1]).get("q")).toBe("brief");
  });

  it("le cartelle da collegare e quelle già collegate al progetto", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/drive/google/folders`]: {
        body: [
          {
            googleFolderId: "gf-1",
            name: "Clienti",
            path: ["My Drive"],
            fileCount: 12,
            alreadyLinked: false,
          },
        ],
      },
      [`GET /api/projects/${PROJECT_ID}/drive/google/links`]: { body: [link()] },
    });
    expect(await g.listGoogleFolders!(PROJECT_ID)).toMatchObject([
      { googleFolderId: "gf-1", alreadyLinked: false },
    ]);
    expect(await g.listFolderLinks!(PROJECT_ID)).toMatchObject([
      { id: LINK, status: "ok", fileCount: 12, accessLost: false },
    ]);
  });

  it("senza `drive.readonly` (o la rotta assente, un server di prima): elenchi vuoti, non un errore", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/drive/google/files`]: {
        status: 409,
        body: {
          code: "google_scope_missing",
          message: "x",
          missing: ["https://www.googleapis.com/auth/drive.readonly"],
        },
      },
    });
    await expect(g.listGoogleFiles!(PROJECT_ID, "brief")).rejects.toThrow("google_scope_missing");
    installFakeServer({});
    expect(await g.listGoogleFolders!(PROJECT_ID)).toEqual([]);
    expect(await g.listFolderLinks!(PROJECT_ID)).toEqual([]);
  });
});

describe("F5: le scritture", () => {
  it("aggiungere un file: il riferimento nuovo, nella forma del prototipo", async () => {
    const { seen } = installFakeServer({
      [`POST /api/projects/${PROJECT_ID}/drive/google/files`]: { status: 201, body: googleRow() },
    });
    const row = await g.addGoogleFile!(PROJECT_ID, "g-1");
    expect(writes(seen)).toEqual([
      ["POST", `/api/projects/${PROJECT_ID}/drive/google/files`, { googleFileId: "g-1" }],
    ]);
    expect(row).toMatchObject({
      id: FILE_ID,
      source: "google",
      googleFileId: "g-1",
      googleOwner: "bob@acme.test",
      sizeBytes: null,
    });
  });

  it("già nel progetto: `already_in_project`", async () => {
    installFakeServer({
      [`POST /api/projects/${PROJECT_ID}/drive/google/files`]: {
        status: 409,
        body: { code: "already_in_project", message: "x" },
      },
    });
    await expect(g.addGoogleFile!(PROJECT_ID, "g-1")).rejects.toThrow("already_in_project");
  });

  it("collegare, sincronizzare e scollegare una cartella (drive.manage)", async () => {
    const { seen } = installFakeServer({
      [`POST /api/projects/${PROJECT_ID}/drive/google/folders`]: { status: 201, body: link() },
      [`POST /api/drive/google/folders/${LINK}/sync`]: { body: link({ fileCount: 13 }) },
      [`DELETE /api/drive/google/folders/${LINK}`]: { status: 204 },
    });
    expect(await g.linkFolder!(PROJECT_ID, "gf-1")).toMatchObject({ id: LINK });
    expect(await g.syncFolder!(LINK)).toMatchObject({ fileCount: 13 });
    await g.unlinkFolder!(LINK);
    expect(writes(seen).map((w) => `${w[0]} ${w[1]}`)).toEqual([
      `POST /api/projects/${PROJECT_ID}/drive/google/folders`,
      `POST /api/drive/google/folders/${LINK}/sync`,
      `DELETE /api/drive/google/folders/${LINK}`,
    ]);
    expect(writes(seen)[0]![2]).toEqual({ googleFolderId: "gf-1" });
  });

  it("«Togli» un riferimento; uno di una cartella si nasconde (`use_hide`); senza permesso `forbidden`", async () => {
    installFakeServer({ [`DELETE /api/drive/files/${FILE_ID}`]: { status: 204 } });
    await g.removeGoogleFile!(FILE_ID);
    installFakeServer({
      [`DELETE /api/drive/files/${FILE_ID}`]: {
        status: 409,
        body: { code: "use_hide", message: "x" },
      },
    });
    await expect(g.removeGoogleFile!(FILE_ID)).rejects.toThrow("invalid: use_hide");
    installFakeServer({
      [`DELETE /api/drive/files/${FILE_ID}`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    await expect(g.removeGoogleFile!(FILE_ID)).rejects.toThrow("forbidden");
  });

  it("«Nascondi» e «Mostra» un file di una cartella", async () => {
    const { seen } = installFakeServer({
      [`PUT /api/drive/files/${FILE_ID}/hidden`]: {
        body: googleRow({ hidden: true, folderLinkId: LINK }),
      },
    });
    expect(await g.setHidden!(FILE_ID, true)).toMatchObject({ hidden: true, folderLinkId: LINK });
    expect(writes(seen)).toEqual([["PUT", `/api/drive/files/${FILE_ID}/hidden`, { hidden: true }]]);
  });
});

describe("F5: la ricerca fuori dai progetti (solo il mio Drive)", () => {
  it("i file che vedo su Google e non sono in nessun progetto", async () => {
    const { seen } = installFakeServer({
      "GET /api/drive/google/outside": {
        body: [
          {
            googleFileId: "g-9",
            name: "Piano 2027",
            type: "doc",
            visibleToPersonIds: [ME_ID],
            text: "",
            summary: "",
          },
        ],
      },
    });
    expect(await g.listGoogleOutside!(" piano ")).toMatchObject([
      { googleFileId: "g-9", name: "Piano 2027" },
    ]);
    expect(new URLSearchParams(seen[0]!.path.split("?")[1]).get("q")).toBe("piano");
  });
});

describe("F5: le cartelle che ho collegato io (il cassetto, scollegando)", () => {
  it("in tutti i progetti, quelle di chi guarda: il cassetto dice quali smettono di aggiornarsi", async () => {
    installFakeServer({ "GET /api/drive/google/links": { body: [link()] } });
    expect(await g.listMyFolderLinks!()).toMatchObject([{ id: LINK, name: "Clienti" }]);
  });

  it("un server di prima (la rotta non c'è): nessuna cartella", async () => {
    installFakeServer({});
    expect(await g.listMyFolderLinks!()).toEqual([]);
  });
});
