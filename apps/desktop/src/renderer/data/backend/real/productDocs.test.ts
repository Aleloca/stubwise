import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
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
    installFakeServer({ "GET /api/product-pages/by-code/AUD-D5": { body: pageView() } });
    const page = (await docs.getProductPage!("AUD-D5"))!;
    expect(page.blocks).toEqual([para("blk-1", "Customers sign in with Google.")]);
    expect(page.permissions).toEqual({ edit: true, delete: false, deleteBlocked: "has_children" });
    expect(page).toMatchObject({ following: true, openComments: 0, code: "AUD-D5" });
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
