import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { liveProductClaude } from "./productClaude";
import { installFakeServer, me, ME_ID, PROJECT_ID } from "./fakeServer";
import { forgetProductDocs, liveProductDocs as docs, productHomeOf } from "./productDocs";
import { getSessionPerson } from "./session";

// Lo spazio Product nella build app (area 11, F1 di 72; R11-1): le rotte di
// `client.productDocs` nelle forme del prototipo.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const REV = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_REV = "bbbbbbbb-0000-4000-8000-000000000002";

const ref = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: id === PAGE ? "AUD-D5" : "AUD-D6",
  projectId: PROJECT_ID,
  parentId: null,
  order: 0,
  title: id === PAGE ? "Sign-in" : "Billing",
  excerpt: "",
  updatedAt: "2026-11-20T10:00:00.000Z",
  updatedById: ME_ID,
  ...over,
});
const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  content: { text, marks: [] },
});
const pageView = (over: Record<string, unknown> = {}) => ({
  ...ref(PAGE),
  blocks: [
    para("blk-1", "Customers sign in with Google."),
    { id: "blk-2", type: "hologram", beams: 3 },
  ],
  seq: 7,
  createdById: ME_ID,
  createdAt: "2026-11-19T10:00:00.000Z",
  breadcrumbs: [],
  decisions: {},
  following: true,
  permissions: { edit: true, delete: false },
  ...over,
});
const revision = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  pageId: PAGE,
  sessionId: "s-other",
  seq: 8,
  lastSeq: 9,
  kind: "edit",
  actorId: null,
  actorName: null,
  changes: [
    { blockId: "blk-1", before: para("blk-1", "a"), after: para("blk-1", "b"), anchors: ["blk-1"] },
  ],
  title: null,
  parent: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:01:00.000Z",
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  forgetProductDocs();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("lo spazio Product dal server", () => {
  it("lo spazio: l'albero dalle pagine in fila (`buildProductTree`), i recenti e il permesso", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        body: {
          projectId: PROJECT_ID,
          projectCode: "AUD",
          pages: [ref(PAGE), ref(CHILD, { parentId: PAGE, updatedById: null })],
          pageCount: 2,
          recent: [ref(CHILD, { parentId: PAGE, updatedById: null })],
          permissions: { edit: false },
        },
      },
    });
    const space = (await docs.getProductSpace!(PROJECT_ID))!;
    expect(space.tree.map((n) => [n.page.code, n.children.map((c) => c.page.code)])).toEqual([
      ["AUD-D5", ["AUD-D6"]],
    ]);
    expect(space).toMatchObject({ projectCode: "AUD", pageCount: 2, permissions: { edit: false } });
    expect(space.recent[0]!.updatedById).toBeNull();
  });

  it("uno spazio che non si vede (404) è null; senza docs.view (403) `forbidden`", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await docs.getProductSpace!(PROJECT_ID)).toBeNull();
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    await expect(docs.getProductSpace!(PROJECT_ID)).rejects.toThrow("forbidden");
  });

  it("la pagina: i blocchi letti con lo schema, un tipo che il renderer non conosce saltato; «Delete» spento per le sottopagine", async () => {
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView({ deleteBlockedBy: "children" }) },
    });
    const page = (await docs.getProductPage!("AUD-D5"))!;
    expect(page.blocks).toEqual([para("blk-1", "Customers sign in with Google.")]);
    expect(page.permissions).toEqual({ edit: true, delete: false, deleteBlocked: "has_children" });
    // Il motivo lo dice il server (`deleteBlockedBy`, M1): il client non lo deduce dai permessi.
    for (const [by, blocked] of [
      [null, null],
      ["permission", null],
    ] as const) {
      forgetProductDocs();
      installFakeServer({
        "GET /api/product-pages/by-code/AUD-D5": { body: pageView({ deleteBlockedBy: by }) },
      });
      expect((await docs.getProductPage!("AUD-D5"))!.permissions.deleteBlocked).toBe(blocked);
    }
    expect(page).toMatchObject({ following: true, openComments: 0, code: "AUD-D5" });
    // I fili aperti li conta il server (72, 9979ecbcc).
    forgetProductDocs();
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView({ openComments: 3 }) },
    });
    expect((await docs.getProductPage!("AUD-D5"))!.openComments).toBe(3);
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D9": {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await docs.getProductPage!("AUD-D9")).toBeNull();
  });

  it("la scrittura parte dall'ultima revisione vista (`baseSeq`), e la successiva da quella salvata", async () => {
    let saves = 0;
    const { seen } = installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`POST /api/product-pages/${PAGE}/ops`]: () => ({
        body: { seq: 10 + saves++, revisionId: REV },
      }),
    });
    await docs.getProductPage!("AUD-D5");
    const ops = [{ op: "set" as const, block: para("blk-1", "Only Google.") as never }];
    const out = await docs.saveProductBlocks!(PAGE, ops, { sessionId: "s-me" });
    expect(out.revisionId).toBe(REV);
    await docs.saveProductBlocks!(PAGE, ops, { sessionId: "s-me", undoOf: REV });
    const bodies = seen.filter((r) => r.method === "POST").map((r) => r.body);
    expect(bodies).toEqual([
      { sessionId: "s-me", baseSeq: 7, ops },
      { sessionId: "s-me", baseSeq: 10, ops, undoOf: REV },
    ]);
  });

  it("409 `stale` su blocchi diversi: le revisioni di un altro si prendono come viste e si riprova una volta, da lì", async () => {
    let first = true;
    const { seen } = installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`POST /api/product-pages/${PAGE}/ops`]: () => {
        if (first) {
          first = false;
          return {
            status: 409,
            body: {
              code: "stale",
              message: "x",
              revisions: [revision(OTHER_REV, { lastSeq: 9 }), revision(REV, { lastSeq: 8 })],
            },
          };
        }
        return { body: { seq: 11, revisionId: REV } };
      },
    });
    await docs.getProductPage!("AUD-D5");
    // Le revisioni dell'altro toccano blk-1; questa scrittura blk-2.
    await docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-2" }], {
      sessionId: "s-me",
    });
    expect(
      seen.filter((r) => r.method === "POST").map((r) => (r.body as { baseSeq: number }).baseSeq),
    ).toEqual([7, 9]);
  });

  it("409 `stale` su un blocco che l'altro ha toccato: nessuna sovrascrittura, `invalid: stale` e nessun secondo invio", async () => {
    const stale = (revisions?: unknown) => ({
      status: 409,
      body: { code: "stale", message: "x", ...(revisions === undefined ? {} : { revisions }) },
    });
    const ops = (blockId: string) => [
      {
        op: "set" as const,
        block: { id: blockId, type: "paragraph" as const, content: { text: "mine", marks: [] } },
      },
    ];
    for (const [revisions, mine] of [
      [[revision(OTHER_REV, { lastSeq: 9 })], "blk-1"],
      // Un merge dell'altro che assorbe il blocco: tocca anche quello.
      [
        [
          revision(OTHER_REV, {
            lastSeq: 9,
            changes: [
              {
                blockId: "blk-3",
                before: null,
                after: null,
                anchors: [],
                mergedFrom: { anchorId: "blk-1", offset: 2 },
              },
            ],
          }),
        ],
        "blk-1",
      ],
      // Senza le revisioni nella risposta non si sa cosa è cambiato: non si riprova (M5).
      [undefined, "blk-2"],
    ] as const) {
      forgetProductDocs();
      const { seen } = installFakeServer({
        "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
        [`POST /api/product-pages/${PAGE}/ops`]: stale(revisions),
      });
      await docs.getProductPage!("AUD-D5");
      await expect(docs.saveProductBlocks!(PAGE, ops(mine), { sessionId: "s-me" })).rejects.toThrow(
        "invalid: stale",
      );
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);
    }
  });

  it("un altro errore della scrittura nella forma del prototipo: un id riusato è `invalid`", async () => {
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`POST /api/product-pages/${PAGE}/ops`]: {
        status: 422,
        body: { code: "block_id_taken", message: "x" },
      },
    });
    await docs.getProductPage!("AUD-D5");
    await expect(
      docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-1" }], { sessionId: "s" }),
    ).rejects.toThrow("invalid: block_id_taken");
  });

  it("crea, rinomina, sposta ed elimina sulle rotte; eliminare con sottopagine dice `has_children`", async () => {
    const { seen } = installFakeServer({
      [`POST /api/projects/${PROJECT_ID}/product/pages`]: { body: { id: PAGE, code: "AUD-D5" } },
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`PATCH /api/product-pages/${PAGE}`]: { status: 204 },
      [`DELETE /api/product-pages/${PAGE}`]: {
        status: 409,
        body: { code: "has_children", message: "x" },
      },
    });
    const page = await docs.createProductPage!(PROJECT_ID, {
      title: "Sign-in",
      parentId: null,
      index: 0,
    });
    expect(page.code).toBe("AUD-D5");
    await docs.renameProductPage!(PAGE, "Login");
    await docs.moveProductPage!(PAGE, { parentId: CHILD, index: 1 });
    await expect(docs.deleteProductPage!(PAGE)).rejects.toThrow("invalid: has_children");
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.body])).toEqual([
      ["POST", { title: "Sign-in", parentId: null, index: 0 }],
      ["PATCH", { title: "Login" }],
      ["PATCH", { move: { parentId: CHILD, index: 1 } }],
      ["DELETE", undefined],
    ]);
  });

  it("la cronologia: dalla più recente, coi cambi per ancora; chi chiede non vede chi ha scritto: «Someone»", async () => {
    installFakeServer({ [`GET /api/product-pages/${PAGE}/revisions`]: { body: [revision(REV)] } });
    const [row] = await docs.listProductRevisions!(PAGE);
    expect(row).toMatchObject({
      id: REV,
      kind: "edit",
      actorId: "",
      actorName: "Someone",
      at: "2026-11-20T10:01:00.000Z",
      changes: [{ blockId: "blk-1", anchors: ["blk-1"], after: para("blk-1", "b") }],
    });
  });

  it("una revisione di Claude dalla cronologia porta gli id dei suoi segni: l'«Undo» di un segno accettato va al segno", async () => {
    const MARK = "cccccccc-0000-4000-8000-000000000001";
    const { seen } = installFakeServer({
      [`GET /api/product-pages/${PAGE}/revisions`]: {
        body: [revision(REV, { kind: "claude", markIdByAnchor: { "blk-1": MARK } })],
      },
      [`POST /api/product-marks/${MARK}/undo`]: { body: { seq: 10, revisionId: null } },
    });
    await docs.listProductRevisions!(PAGE);
    await liveProductClaude.undoProductChange!(REV, "blk-1");
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/api/product-marks/${MARK}/undo`,
    ]);
  });

  it("F6: la pagina porta lo SVG di ogni variante pronta, per `<wireframeId>:<variant>` (come il prototipo)", async () => {
    const WF = "ffffffff-0000-4000-8000-000000000001";
    const SVG0 = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const SVG1 = '<svg viewBox="0 0 10 10"><circle r="5"/></svg>';
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": {
        body: pageView({
          blocks: [{ id: "blk-w", type: "wireframe", wireframeId: WF, variant: 1 }],
          wireframes: [
            { id: WF, status: "ready", variants: [{ svg: SVG0 }, { svg: SVG1 }], error: null },
          ],
        }),
      },
    });
    const page = await docs.getProductPage!("AUD-D5");
    expect(page!.wireframes).toEqual({ [`${WF}:0`]: SVG0, [`${WF}:1`]: SVG1 });
    expect(page!.blocks).toEqual([{ id: "blk-w", type: "wireframe", wireframeId: WF, variant: 1 }]);
  });

  it("F6: le bozze non pronte vanno in `wireframeStates` per id di blocco, col motivo; un motivo ignoto è `no_answer`", async () => {
    const W = (n: number) => `ffffffff-0000-4000-8000-00000000000${n}`;
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": {
        body: pageView({
          blocks: [
            { id: "blk-ready", type: "wireframe", wireframeId: W(1), variant: 0 },
            { id: "blk-drawing", type: "wireframe", wireframeId: W(2), variant: 0 },
            { id: "blk-budget", type: "wireframe", wireframeId: W(3), variant: 0 },
            { id: "blk-odd", type: "wireframe", wireframeId: W(4), variant: 0 },
          ],
          wireframes: [
            { id: W(1), status: "ready", variants: [{ svg: "<svg/>" }], error: null },
            { id: W(2), status: "drawing", variants: [], error: null },
            { id: W(3), status: "failed", variants: [{ svg: "<svg/>" }], error: "budget" },
            { id: W(4), status: "failed", variants: [], error: "something_new" },
          ],
        }),
      },
    });
    const page = await docs.getProductPage!("AUD-D5");
    expect(page!.wireframeStates).toEqual({
      "blk-drawing": { status: "drawing" },
      "blk-budget": { status: "failed", reason: "budget", drawn: true },
      "blk-odd": { status: "failed", reason: "no_answer", drawn: false },
    });
  });

  it("F6: la cronologia dice il gesto della bozza (`wireframe`), per conto di chi; un gesto ignoto o assente non c'è", async () => {
    const R = (n: number) => `eeeeeeee-0000-4000-8000-00000000000${n}`;
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/revisions`]: {
        body: [
          revision(R(1), { wireframe: "kept", undo: { enabled: true } }),
          revision(R(2), { wireframe: "redrew", via: "claude", onBehalfOfId: R(9), onBehalfOfName: "Laura" }),
          revision(R(3), { wireframe: "UNKNOWN" }),
          revision(R(4), { wireframe: null }),
        ],
      },
    });
    const rows = await docs.listProductRevisions!(PAGE);
    expect(rows[0]).toMatchObject({ wireframe: "kept", undo: { enabled: true } });
    expect(rows[1]).toMatchObject({ wireframe: "redrew", via: "claude", onBehalfOfId: R(9) });
    expect(rows[2]).not.toHaveProperty("wireframe");
    expect(rows[3]).not.toHaveProperty("wireframe");
  });

  it("Segui e smetti: PUT e DELETE", async () => {
    const { seen } = installFakeServer({
      [`PUT /api/product-pages/${PAGE}/follow`]: { status: 204 },
      [`DELETE /api/product-pages/${PAGE}/follow`]: { status: 204 },
    });
    await docs.followProductPage!(PAGE);
    await docs.unfollowProductPage!(PAGE);
    expect(seen.map((r) => r.method)).toEqual(["PUT", "DELETE"]);
  });
});

describe("la card Product della Home dei Docs", () => {
  it("dallo spazio: il numero di pagine, l'ultima modifica e chi scrive", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        body: {
          projectId: PROJECT_ID,
          projectCode: "AUD",
          pages: [ref(PAGE), ref(CHILD, { updatedAt: "2026-11-21T09:00:00.000Z" })],
          pageCount: 2,
          recent: [],
          permissions: { edit: true },
        },
      },
    });
    expect(await productHomeOf(PROJECT_ID)).toEqual({
      pageCount: 2,
      updatedAt: "2026-11-21T09:00:00.000Z",
      canEdit: true,
    });
  });

  it("vuoto: nessuna data; senza spazio (404) o senza `docs.view` (403) la card non c'è", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        body: {
          projectId: PROJECT_ID,
          projectCode: "AUD",
          pages: [],
          pageCount: 0,
          recent: [],
          permissions: { edit: false },
        },
      },
    });
    expect(await productHomeOf(PROJECT_ID)).toEqual({
      pageCount: 0,
      updatedAt: null,
      canEdit: false,
    });
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await productHomeOf(PROJECT_ID)).toBeNull();
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    expect(await productHomeOf(PROJECT_ID)).toBeNull();
  });

  it("un altro errore non si nasconde (I5): la lettura della Home lo dice", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        status: 500,
        body: { code: "internal", message: "boom" },
      },
    });
    await expect(productHomeOf(PROJECT_ID)).rejects.toThrow();
  });
});

describe("la cronologia a pagine e i rifiuti del server", () => {
  it("la cronologia a pagine di 100: la prima senza `before`, la seguente col `lastSeq` più vecchio già letto", async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      revision(`cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        seq: 300 - i * 2,
        lastSeq: 301 - i * 2,
      }),
    );
    const second = [
      revision(REV, { seq: 50, lastSeq: 51 }),
      revision(OTHER_REV, { seq: 40, lastSeq: 41 }),
    ];
    const { seen } = installFakeServer({
      [`GET /api/product-pages/${PAGE}/revisions`]: (req) => ({
        body: req.path.includes("before=") ? second : first,
      }),
    });
    expect(await docs.listProductRevisions!(PAGE)).toHaveLength(100);
    expect((await docs.listProductRevisions!(PAGE, { before: 103 })).map((r) => r.id)).toEqual([
      REV,
      OTHER_REV,
    ]);
    expect(seen.map((r) => r.path)).toEqual([
      `/api/product-pages/${PAGE}/revisions`,
      `/api/product-pages/${PAGE}/revisions?before=103`,
    ]);
  });

  it("un 409 dell'albero (troppo profondo, troppe pagine) è un rifiuto `invalid: …`, che non si riprova", async () => {
    installFakeServer({
      [`PATCH /api/product-pages/${PAGE}`]: {
        status: 409,
        body: { code: "too_deep", message: "x" },
      },
      [`POST /api/projects/${PROJECT_ID}/product/pages`]: {
        status: 409,
        body: { code: "too_many_pages", message: "x" },
      },
    });
    await expect(docs.moveProductPage!(PAGE, { parentId: CHILD, index: 0 })).rejects.toThrow(
      "invalid: too_deep",
    );
    await expect(docs.createProductPage!(PROJECT_ID, { title: "New" })).rejects.toThrow(
      "invalid: too_many_pages",
    );
  });
});

describe("le immagini dei blocchi", () => {
  const IMAGE = "dddddddd-0000-4000-8000-000000000001";

  it("salvare carica il file (multipart) e dà `product-image:<id>` per il blocco", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/images`]: {
        status: 201,
        body: { id: IMAGE, ref: `product-image:${IMAGE}` },
      },
    });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "flow.png", { type: "image/png" });
    expect(await docs.storeProductImage!(PAGE, file)).toBe(`product-image:${IMAGE}`);
    expect(seen[0]!.body).toBeInstanceOf(FormData);
  });

  it("i rifiuti del server: troppo grande (413), non un'immagine (422)", async () => {
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/images`]: {
        status: 413,
        body: { code: "file_too_large", message: "x" },
      },
    });
    await expect(docs.storeProductImage!(PAGE, file)).rejects.toThrow("invalid: file_too_large");
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/images`]: {
        status: 422,
        body: { code: "invalid_image", message: "x" },
      },
    });
    await expect(docs.storeProductImage!(PAGE, file)).rejects.toThrow("invalid: invalid_image");
  });

  it("sul web: la rotta dell'immagine così com'è, per `<img src>` (stessa origine, il cookie, la cache del browser)", async () => {
    installFakeServer({});
    expect(await docs.productImageSrc!(PAGE, `product-image:${IMAGE}`)).toBe(
      `/api/product-pages/${PAGE}/images/${IMAGE}`,
    );
  });

  it("sul desktop: i byte dalla rotta (dal main, col token) come data URL; 404 è null; un altro errore lancia (si riprova)", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const request = vi.fn(async (req: { path: string }) =>
      req.path.endsWith(IMAGE)
        ? { status: 200, headers: { "content-type": "image/png" }, body: png.buffer }
        : {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "not_found" }),
          },
    );
    vi.stubGlobal("stubwise", { api: { request } });
    expect(await docs.productImageSrc!(PAGE, `product-image:${IMAGE}`)).toBe(
      `data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
    );
    expect(request.mock.calls[0]![0]).toMatchObject({
      method: "GET",
      path: `/api/product-pages/${PAGE}/images/${IMAGE}`,
    });
    expect(
      await docs.productImageSrc!(PAGE, "product-image:dddddddd-0000-4000-8000-000000000009"),
    ).toBeNull();
    request.mockResolvedValueOnce({
      status: 500,
      headers: { "content-type": "application/json" },
      body: "{}",
    } as never);
    await expect(docs.productImageSrc!(PAGE, `product-image:${IMAGE}`)).rejects.toThrow(
      "image_failed",
    );
    // Un tipo che non è un'immagine permessa (SVG) non si mostra.
    request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "image/svg+xml" },
      body: png.buffer,
    } as never);
    await expect(docs.productImageSrc!(PAGE, `product-image:${IMAGE}`)).rejects.toThrow(
      "image_failed",
    );
    request.mockClear();
    expect(await docs.productImageSrc!(PAGE, "https://evil.example/x.png")).toBeNull();
    expect(await docs.productImageSrc!(PAGE, "data:image/png;base64,AAAA")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("una scrittura riuscita resta riuscita (I1 della revisione)", () => {
  it("il salvataggio è andato, la rilettura no: la pagina dall'ultima lettura con le stesse operazioni, nessun errore", async () => {
    let reads = 0;
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": () =>
        ++reads === 1
          ? { body: pageView() }
          : { status: 500, body: { code: "internal", message: "x" } },
      [`POST /api/product-pages/${PAGE}/ops`]: { body: { seq: 8, revisionId: REV } },
    });
    await docs.getProductPage!("AUD-D5");
    const saved = await docs.saveProductBlocks!(
      PAGE,
      [
        {
          op: "insert",
          afterId: "blk-1",
          block: { id: "blk-9", type: "paragraph", content: { text: "New line", marks: [] } },
        },
      ],
      { sessionId: "s-me" },
    );
    expect(saved.revisionId).toBe(REV);
    expect(saved.blocks.map((b) => b.id)).toEqual(["blk-1", "blk-9"]);
  });

  it("la pagina è creata, la rilettura no: la pagina nuova lo stesso (un Retry ne creerebbe una doppia)", async () => {
    installFakeServer({
      [`POST /api/projects/${PROJECT_ID}/product/pages`]: {
        status: 201,
        body: { id: CHILD, code: "AUD-D6" },
      },
      "GET /api/product-pages/by-code/AUD-D6": {
        status: 500,
        body: { code: "internal", message: "x" },
      },
    });
    const page = await docs.createProductPage!(PROJECT_ID, {
      title: "Billing",
      parentId: PAGE,
      index: 0,
    });
    expect(page).toMatchObject({
      id: CHILD,
      code: "AUD-D6",
      title: "Billing",
      parentId: PAGE,
      blocks: [],
    });
  });
});

describe("cambiata la persona, niente di quella di prima (M3 della revisione)", () => {
  it("il `baseSeq` letto dalla persona di prima non si usa: la scrittura parte da 0 e il server dice se è vecchia", async () => {
    const OTHER = "22222222-2222-4222-8222-000000000002";
    const who = { current: me() };
    const { seen } = installFakeServer({
      "GET /api/auth/me": () => ({ body: who.current }),
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`POST /api/product-pages/${PAGE}/ops`]: { body: { seq: 8, revisionId: REV } },
    });
    await getSessionPerson();
    await docs.getProductPage!("AUD-D5");
    who.current = me({ user: { ...me().user, id: OTHER } });
    await getSessionPerson();
    await docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-2" }], {
      sessionId: "s",
    }).catch(() => undefined);
    const posted = seen
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { baseSeq: number }).baseSeq);
    expect(posted).toEqual([0]);
  });

  it("eliminata la pagina, il suo codice se ne va con lei", async () => {
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
      [`DELETE /api/product-pages/${PAGE}`]: { status: 204 },
      [`PATCH /api/product-pages/${PAGE}`]: { body: {} },
    });
    await docs.getProductPage!("AUD-D5");
    await docs.deleteProductPage!(PAGE);
    await expect(docs.renameProductPage!(PAGE, "x")).rejects.toThrow("not_found");
  });
});

describe("i commenti dal server (area 11, F2; R11-2)", () => {
  const ROOT = "eeeeeeee-0000-4000-8000-000000000001";
  const REPLY = "eeeeeeee-0000-4000-8000-000000000002";
  const OTHER_PERSON = "33333333-3333-4333-8333-000000000003";
  const comment = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    pageId: PAGE,
    anchorId: "blk-1",
    quote: "Google account",
    authorId: ME_ID,
    authorName: "Laura Costa",
    body: "Do we keep a fallback?",
    createdAt: "2026-11-20T10:00:00.000Z",
    replyToId: null,
    resolved: null,
    mentionIds: [],
    ...over,
  });

  it("i fili nella forma del prototipo: chi non si vede è `null`, un autore eliminato non ha id", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/comments`]: {
        body: {
          open: [
            {
              root: comment(ROOT, { mentionIds: [OTHER_PERSON] }),
              replies: [
                comment(REPLY, { replyToId: ROOT, authorId: null, authorName: null, body: "No." }),
              ],
              anchorGone: false,
            },
          ],
          resolved: [
            {
              root: comment(OTHER_REV, {
                resolved: { byId: OTHER_PERSON, byName: null, at: "2026-11-20T11:00:00.000Z" },
              }),
              replies: [],
              anchorGone: true,
            },
          ],
        },
      },
    });
    const threads = await docs.listProductComments!(PAGE);
    expect(threads.open[0]!.root).toMatchObject({
      id: ROOT,
      authorName: "Laura Costa",
      mentionIds: [OTHER_PERSON],
    });
    expect(threads.open[0]!.replies[0]).toMatchObject({
      id: REPLY,
      authorId: "",
      authorName: null,
      replyToId: ROOT,
    });
    expect(threads.resolved[0]).toMatchObject({
      anchorGone: true,
      root: { resolved: { byId: OTHER_PERSON, byName: null } },
    });
  });

  it("una pagina che non c'è (404) non ha fili; senza `docs.view` è `forbidden`", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/comments`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await docs.listProductComments!(PAGE)).toEqual({ open: [], resolved: [] });
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/comments`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    await expect(docs.listProductComments!(PAGE)).rejects.toThrow("forbidden");
  });

  it("commentare manda ancora, frase e testo (le menzioni le trova il server); i rifiuti `invalid: …`", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/comments`]: { status: 201, body: comment(ROOT) },
    });
    const made = await docs.addProductComment!(PAGE, {
      anchorId: "blk-1",
      quote: "Google account",
      body: "Hi @Marco Bellini",
    });
    expect(made).toMatchObject({ id: ROOT, authorName: "Laura Costa" });
    expect(seen[0]!.body).toEqual({
      anchorId: "blk-1",
      quote: "Google account",
      body: "Hi @Marco Bellini",
    });
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/comments`]: {
        status: 422,
        body: { code: "invalid_anchor", message: "x" },
      },
    });
    await expect(
      docs.addProductComment!(PAGE, { anchorId: "gone", quote: "", body: "x" }),
    ).rejects.toThrow("invalid: invalid_anchor");
  });

  it("una risposta manda `replyToId`; «Resolve» e «Reopen» sulle rotte del commento", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/comments`]: {
        status: 201,
        body: comment(REPLY, { replyToId: ROOT }),
      },
      [`POST /api/product-comments/${ROOT}/resolve`]: { status: 204 },
      [`POST /api/product-comments/${ROOT}/reopen`]: { status: 204 },
    });
    await docs.addProductComment!(PAGE, {
      anchorId: "blk-1",
      quote: "",
      body: "No.",
      replyToId: ROOT,
    });
    expect(seen[0]!.body).toMatchObject({ replyToId: ROOT });
    await docs.resolveProductComment!(ROOT);
    await docs.reopenProductComment!(ROOT);
    expect(seen.slice(1).map((r) => r.path)).toEqual([
      `/api/product-comments/${ROOT}/resolve`,
      `/api/product-comments/${ROOT}/reopen`,
    ]);
  });

  it("chi si può menzionare: la ricerca col testo dato", async () => {
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/mention-candidates`]: {
        body: [{ id: OTHER_PERSON, name: "Marco Bellini" }],
      },
    });
    expect(await docs.productMentionCandidates!(PROJECT_ID, "ma")).toEqual([
      { id: OTHER_PERSON, name: "Marco Bellini" },
    ]);
    expect(seen[0]!.path).toBe(`/api/projects/${PROJECT_ID}/product/mention-candidates?q=ma`);
  });
});

describe("una sezione presa da un altro (F4, bozza del piano)", () => {
  it("409 `section_busy`: un rifiuto `section_busy` col nome di chi la tiene (o nessuno, se chi guarda non lo vede)", async () => {
    for (const [by, name] of [
      [{ id: "33333333-3333-4333-8333-000000000003", name: "Marco Bellini" }, "Marco Bellini"],
      [{ id: "33333333-3333-4333-8333-000000000003", name: null }, undefined],
    ] as const) {
      forgetProductDocs();
      installFakeServer({
        "GET /api/product-pages/by-code/AUD-D5": { body: pageView() },
        [`POST /api/product-pages/${PAGE}/ops`]: {
          status: 409,
          body: { code: "section_busy", message: "x", by, sectionId: "blk-1" },
        },
      });
      await docs.getProductPage!("AUD-D5");
      const error = await docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-1" }], {
        sessionId: "s",
      }).then(
        () => null,
        (e: unknown) => e as Error & { by?: string },
      );
      expect(error?.message).toBe("section_busy");
      expect(error?.by).toBe(name);
    }
  });
});

describe("la base della scrittura (revisione di R11-4, 2 e 3)", () => {
  it("la scrittura parte dal `seq` della SUA base, non dall'ultima lettura: una revisione altrui intanto dà `stale`", async () => {
    let first = true;
    const { seen } = installFakeServer({
      // La pagina riletta per la revisione di un altro: seq 9.
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView({ seq: 9 }) },
      [`POST /api/product-pages/${PAGE}/ops`]: () => {
        if (!first) return { body: { seq: 10, revisionId: REV } };
        first = false;
        return {
          status: 409,
          body: {
            code: "stale",
            message: "x",
            revisions: [revision(OTHER_REV, { lastSeq: 9, sessionId: "s-other" })],
          },
        };
      },
    });
    await docs.getProductPage!("AUD-D5");
    // La scrittura era stata calcolata sulla base al seq 7; tocca blk-1, che l'altro ha cambiato.
    await expect(
      docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-1" }], {
        sessionId: "s-me",
        baseSeq: 7,
      }),
    ).rejects.toThrow("invalid: stale");
    expect(
      seen.filter((r) => r.method === "POST").map((r) => (r.body as { baseSeq: number }).baseSeq),
    ).toEqual([7]);
  });

  it("le revisioni della STESSA sessione fra la base e l'invio non sono un conflitto: si riprova", async () => {
    let first = true;
    const { seen } = installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: pageView({ seq: 8 }) },
      [`POST /api/product-pages/${PAGE}/ops`]: () => {
        if (!first) return { body: { seq: 9, revisionId: REV } };
        first = false;
        return {
          status: 409,
          body: {
            code: "stale",
            message: "x",
            revisions: [revision(OTHER_REV, { lastSeq: 8, sessionId: "s-me" })],
          },
        };
      },
    });
    await docs.getProductPage!("AUD-D5");
    await docs.saveProductBlocks!(PAGE, [{ op: "delete", blockId: "blk-1" }], {
      sessionId: "s-me",
      baseSeq: 7,
    });
    expect(
      seen.filter((r) => r.method === "POST").map((r) => (r.body as { baseSeq: number }).baseSeq),
    ).toEqual([7, 8]);
  });

  it("una lettura partita prima di un salvataggio e arrivata dopo (seq più vecchio) non riporta indietro la pagina", async () => {
    let reads = 0;
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": () =>
        ++reads === 2
          ? { body: pageView({ seq: 8, blocks: [para("blk-1", "Mine, saved.")] }) }
          : { body: pageView({ seq: 7 }) },
      [`POST /api/product-pages/${PAGE}/ops`]: { body: { seq: 8, revisionId: REV } },
    });
    await docs.getProductPage!("AUD-D5");
    await docs.saveProductBlocks!(
      PAGE,
      [{ op: "set", block: para("blk-1", "Mine, saved.") as never }],
      { sessionId: "s-me" },
    );
    // La terza lettura risponde col seq 7 (era partita prima): resta la pagina al seq 8.
    const late = (await docs.getProductPage!("AUD-D5"))!;
    expect(late.seq).toBe(8);
    expect(late.blocks).toEqual([para("blk-1", "Mine, saved.")]);
  });
});

describe("Claude nei fili e nella cronologia (area 11, F5; bozza delle forme di 72)", () => {
  const email = {
    kind: "email",
    canOpen: false,
    id: null,
    title: null,
    code: null,
    ownerId: ME_ID,
    ownerName: "Laura Costa",
    at: "2026-11-18T09:00:00.000Z",
    gone: false,
    thread: null,
  };

  it("un commento di Claude porta la sua domanda, con la fonte vista composta qui; quello di una persona no", async () => {
    const ROOT = "eeeeeeee-0000-4000-8000-000000000001";
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/comments`]: {
        body: {
          open: [
            {
              root: {
                id: ROOT,
                pageId: PAGE,
                anchorId: "blk-1",
                quote: "Google account",
                authorId: "99999999-9999-4999-8999-999999999999",
                authorName: "Claude",
                body: "",
                createdAt: "2026-11-20T10:00:00.000Z",
                replyToId: null,
                resolved: null,
                mentionIds: [],
                question: {
                  reason: "vague",
                  forId: null,
                  forName: null,
                  taskCode: null,
                  source: email,
                  applyMode: "replace",
                  current: { text: "Google only", marks: [] },
                  apply: { text: "Google or email", marks: [] },
                  built: null,
                  request: null,
                  recommended: "keep",
                  options: ["keep", "apply"],
                  canAnswer: true,
                  applyBlocked: { byId: ME_ID, byName: "Laura Costa" },
                  answer: null,
                },
              },
              replies: [],
              anchorGone: false,
            },
          ],
          resolved: [],
        },
      },
    });
    const [thread] = (await docs.listProductComments!(PAGE)).open;
    expect(thread!.root.question).toMatchObject({
      reason: "vague",
      source: { label: { key: "productDocs.source.emailOf" } },
      applyMode: "replace",
      recommended: "keep",
      options: ["keep", "apply"],
      canAnswer: true,
      applyBlocked: { byId: ME_ID },
      answer: null,
    });
  });

  it("la revisione di Claude: «edit» via Claude, per conto di chi, la fonte vista e lo stato di «Undo»", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/revisions`]: {
        body: [
          revision(REV, {
            kind: "claude",
            via: "claude",
            onBehalfOfId: ME_ID,
            onBehalfOfName: "Laura Costa",
            source: email,
            undo: { enabled: true, reason: null, byId: null, byName: null },
            undoByAnchor: {
              "blk-1": {
                enabled: false,
                reason: "changed_after",
                byId: ME_ID,
                byName: "Laura Costa",
              },
            },
            undoneCount: { done: 1, count: 2 },
            undoneById: ME_ID,
            undoneByName: "Laura Costa",
          }),
          revision(OTHER_REV, { kind: "undo", undoOf: REV }),
        ],
      },
    });
    const [claudeRev, undo] = await docs.listProductRevisions!(PAGE);
    expect(claudeRev).toMatchObject({
      kind: "edit",
      via: "claude",
      onBehalfOfId: ME_ID,
      sourceView: { label: { key: "productDocs.source.emailOf" } },
      undo: { enabled: true },
      undoByAnchor: { "blk-1": { enabled: false, reason: "changed_after", byId: ME_ID } },
      undoneCount: { done: 1, count: 2 },
      undoneById: ME_ID,
    });
    expect(undo).toMatchObject({ kind: "undo" });
  });
});
