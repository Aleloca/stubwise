import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { sourceViewFrom, type ServerSourceView } from "./productClaude";
import { liveProductFirstVersion as fv } from "./productFirstVersion";

// La prima versione nella build app (area 11, F6; R11-6), sulle forme di 72
// (a2e2bd051, rotte d1b9848f3): le fonti scelte, lo stato (riletto ogni 2 s
// mentre scrive: nessun evento), «Write the first version», «Undo the first
// version» col 409 della pagina toccata, «Accept this page». Dietro
// `product-claude-actions`, spento.

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP = "dddddddd-0000-4000-8000-000000000001";
const LAURA = "55555555-5555-4555-8555-555555555555";
const EMAIL = "cccccccc-0000-4000-8000-000000000001";

const view = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  groupId: GROUP,
  byId: LAURA,
  byName: "Laura Costa",
  status: "writing",
  pagesDone: 1,
  pagesTotal: 3,
  interrupted: false,
  sources: [
    {
      kind: "text",
      canOpen: false,
      id: null,
      title: null,
      code: null,
      ownerId: null,
      ownerName: null,
      at: null,
      gone: false,
      thread: null,
    },
  ],
  pages: [{ title: "Sign-in", depth: 0, pageId: PAGE, code: "AUD-D1", state: "written" }],
  acceptedPageIds: [],
  bannerPageIds: [PAGE],
  undo: { enabled: true },
  permissions: { edit: true, stop: true },
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la prima versione nella build app", () => {
  it("le fonti che chi guarda vede; un server senza la rotta (404): nessuna", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT}/product/first-version/sources`]: {
        body: {
          emails: [
            {
              id: EMAIL,
              fromName: "Laura Costa",
              subject: "Login",
              at: "2026-11-20T10:00:00.000Z",
            },
          ],
          meetings: [],
          files: [],
        },
      },
    });
    expect(await fv.listFirstVersionSources!(PROJECT)).toEqual({
      emails: [
        { id: EMAIL, fromName: "Laura Costa", subject: "Login", at: "2026-11-20T10:00:00.000Z" },
      ],
      meetings: [],
      files: [],
    });
    installFakeServer({});
    expect(await fv.listFirstVersionSources!(PROJECT)).toEqual({
      emails: [],
      meetings: [],
      files: [],
    });
  });

  it("lo stato: pagine, riga in cima, la fonte incollata «From pasted text», i permessi", async () => {
    installFakeServer({ [`GET /api/projects/${PROJECT}/product/first-version`]: { body: view() } });
    const v = await fv.getProductFirstVersion!(PROJECT);
    expect(v).toMatchObject({
      groupId: GROUP,
      byId: LAURA,
      byName: "Laura Costa",
      status: "writing",
      pagesDone: 1,
      pagesTotal: 3,
      pages: [{ title: "Sign-in", pageId: PAGE, code: "AUD-D1", state: "written" }],
      bannerPageIds: [PAGE],
      undo: { enabled: true },
      permissions: { edit: true },
    });
    expect(v!.sources[0]!.label).toEqual({ key: "productDocs.source.text" });
  });

  it("nessuna prima versione: null; il 404 anche", async () => {
    installFakeServer({ [`GET /api/projects/${PROJECT}/product/first-version`]: { body: null } });
    expect(await fv.getProductFirstVersion!(PROJECT)).toBeNull();
    installFakeServer({});
    expect(await fv.getProductFirstVersion!(PROJECT)).toBeNull();
  });

  it("«Undo» spento per una pagina toccata: chi, quale pagina e come", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT}/product/first-version`]: {
        body: view({
          status: "done",
          undo: {
            enabled: false,
            reason: "changed_after",
            byId: LAURA,
            pageId: PAGE,
            pageTitle: "Sign-in",
            touch: "comment",
          },
        }),
      },
    });
    expect((await fv.getProductFirstVersion!(PROJECT))!.undo).toEqual({
      enabled: false,
      reason: "changed_after",
      byId: LAURA,
      pageId: PAGE,
      pageTitle: "Sign-in",
      touch: "comment",
    });
  });

  it("«Write the first version»: le fonti al server, il gruppo; i rifiuti nelle parole del prototipo", async () => {
    const sources = [
      { kind: "email" as const, id: EMAIL },
      { kind: "text" as const, text: "notes" },
    ];
    const { seen } = installFakeServer({
      [`POST /api/projects/${PROJECT}/product/first-version`]: {
        status: 202,
        body: { groupId: GROUP },
      },
    });
    expect(await fv.startFirstVersion!(PROJECT, sources)).toEqual({ groupId: GROUP });
    expect(seen[0]!.body).toEqual({ sources });
    for (const [code, message] of [
      ["space_not_empty", "space_not_empty"],
      ["ai_blocked", "ai_blocked"],
      ["no_sources", "no_sources"],
      ["invalid_source", "invalid: source"],
    ] as const) {
      installFakeServer({
        [`POST /api/projects/${PROJECT}/product/first-version`]: {
          status: code.startsWith("invalid") || code === "no_sources" ? 422 : 409,
          body: { code, message: "x" },
        },
      });
      await expect(fv.startFirstVersion!(PROJECT, sources)).rejects.toThrow(message);
    }
  });

  it("«Undo the first version»: 409 changed_after porta chi, la pagina e come (`refused: …`)", async () => {
    installFakeServer({
      [`POST /api/projects/${PROJECT}/product/first-version/undo`]: {
        status: 409,
        body: {
          code: "changed_after",
          message: "x",
          byId: LAURA,
          byName: "Laura Costa",
          pageId: PAGE,
          pageTitle: "Sign-in",
          touch: "edit",
        },
      },
    });
    await expect(fv.undoFirstVersion!(PROJECT)).rejects.toMatchObject({
      message: "refused: changed_after",
      byId: LAURA,
      pageId: PAGE,
      pageTitle: "Sign-in",
      touch: "edit",
    });
  });

  it("«Accept this page»: POST; una pagina che non è di una prima versione: `invalid: page`", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/first-version/accept`]: { status: 204 },
    });
    await fv.acceptFirstVersionPage!(PAGE);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /api/product-pages/${PAGE}/first-version/accept`,
    ]);
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/first-version/accept`]: {
        status: 422,
        body: { code: "invalid_page", message: "x" },
      },
    });
    await expect(fv.acceptFirstVersionPage!(PAGE)).rejects.toThrow("invalid: page");
  });
});

describe("le fonti della prima versione (F6): file del Drive e testo incollato", () => {
  const drive = (over: Partial<ServerSourceView> = {}): ServerSourceView => ({
    kind: "drive",
    canOpen: true,
    id: "cccccccc-0000-4000-8000-000000000002",
    title: "Pricing.pdf",
    code: "AUD-F2",
    ownerId: null,
    ownerName: null,
    at: null,
    gone: false,
    ...over,
  });

  it("un file che si vede: «From the file “Pricing.pdf”», col codice; uno che non si vede: senza nome, col codice", () => {
    expect(sourceViewFrom(drive())).toMatchObject({
      kind: "drive",
      label: { key: "productDocs.source.drive", params: { name: "Pricing.pdf" } },
      code: "AUD-F2",
    });
    expect(sourceViewFrom(drive({ canOpen: false, title: null }))).toMatchObject({
      label: { key: "productDocs.source.driveHidden" },
      code: "AUD-F2",
    });
  });
});
