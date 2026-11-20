import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID } from "./fakeServer";
import { forgetProductDocs, liveProductDocs as docs } from "./productDocs";

// La ricerca «In Product» e l'esportazione nella build app (area 11, F3 di
// 72; R11-3), scritte contro le forme del piano F3
// (`docs/plans/2026-11-20-integrazione-area11-f3-plan.md`) finché 72 non
// pubblica l'api-client: dietro i cancelli `product-search` e
// `product-export`, spenti.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const IMAGE = "dddddddd-0000-4000-8000-000000000001";

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
/** La ricerca globale senza risultati, coi gruppi di prima di F3. */
const emptySearch = {
  tickets: { items: [], hasMore: false },
  projects: { items: [], hasMore: false },
  repositories: { items: [], hasMore: false },
  docs: { items: [], hasMore: false },
};
const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  content: { text, marks: [] },
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

describe("la ricerca «In Product»", () => {
  it("nel progetto: la rotta dello spazio, `{ items, hasMore }`, una riga per pagina con la frase che ha corrisposto", async () => {
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/search`]: {
        body: {
          items: [
            {
              page: ref(PAGE, { updatedById: null }),
              projectCode: "AUD",
              passage: "Customers sign in with Google.",
            },
          ],
          hasMore: false,
        },
      },
    });
    const hits = await docs.searchProductPages!("google", { projectId: PROJECT_ID });
    expect(hits).toEqual([
      {
        page: expect.objectContaining({ id: PAGE, code: "AUD-D5", title: "Sign-in" }),
        projectCode: "AUD",
        passage: "Customers sign in with Google.",
      },
    ]);
    expect(seen[0]!.path).toBe(`/api/projects/${PROJECT_ID}/product/search?q=google`);
  });

  it("senza progetto: il gruppo `product` della ricerca globale; un testo vuoto non chiede niente (400 `empty_query`)", async () => {
    const { seen } = installFakeServer({
      "GET /api/search": {
        body: {
          ...emptySearch,
          product: {
            items: [{ page: ref(CHILD), projectCode: "AUD", passage: "Bills" }],
            hasMore: false,
          },
        },
      },
    });
    expect(await docs.searchProductPages!("  ")).toEqual([]);
    expect(seen).toHaveLength(0);
    expect((await docs.searchProductPages!("bills")).map((h) => h.page.id)).toEqual([CHILD]);
    expect(seen[0]!.path).toBe("/api/search?q=bills");
  });

  it("un server senza il gruppo `product` non ha righe; 404 nessuna riga", async () => {
    // Un server di prima: niente gruppo `product` (il default dello schema è vuoto).
    installFakeServer({ "GET /api/search": { body: emptySearch } });
    expect(await docs.searchProductPages!("bills")).toEqual([]);
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/search`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await docs.searchProductPages!("x", { projectId: PROJECT_ID })).toEqual([]);
  });
});

describe("l'esportazione", () => {
  const exported = (id: string, blocks: unknown[], over: Record<string, unknown> = {}) => ({
    page: {
      id,
      code: id === PAGE ? "AUD-D5" : "AUD-D6",
      title: id === PAGE ? "Sign-in" : "Billing",
      projectCode: "AUD",
      updatedAt: "2026-11-20T10:00:00.000Z",
    },
    blocks,
    decisions: {
      "d-1": { title: "Google only", decidedAt: "2026-11-01T10:00:00.000Z", decidedByName: null },
      "d-2": null,
    },
    files: { "f-1": { name: "brief.pdf" }, "f-2": null },
    ...over,
  });

  it("una pagina: la sua rotta; i blocchi letti con lo schema, le decisioni come le vede chi esporta", async () => {
    const { seen } = installFakeServer({
      [`GET /api/product-pages/${PAGE}/export`]: {
        body: exported(PAGE, [para("b-1", "Hello"), { id: "b-2", type: "hologram" }]),
      },
    });
    const view = (await docs.getProductExport!(PROJECT_ID, { pageId: PAGE }))!;
    expect(seen[0]!.path).toBe(`/api/product-pages/${PAGE}/export`);
    expect(view.projectCode).toBe("AUD");
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0]).toMatchObject({
      depth: 0,
      page: { id: PAGE, code: "AUD-D5", title: "Sign-in", projectId: PROJECT_ID },
    });
    expect(view.pages[0]!.page.blocks).toEqual([para("b-1", "Hello")]);
    expect(view.decisions).toEqual({ "d-1": { title: "Google only" }, "d-2": null });
    // I file del Drive come li vede chi esporta (72, 5c5d0323e): null se non li vede.
    expect(view.files).toEqual({ "f-1": { name: "brief.pdf" }, "f-2": null });
  });

  it("lo spazio: la rotta del progetto, in ordine d'albero con la profondità", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/export`]: {
        body: {
          projectCode: "AUD",
          pages: [
            { ...exported(PAGE, []), depth: 0 },
            { ...exported(CHILD, []), depth: 1 },
          ],
        },
      },
    });
    const view = (await docs.getProductExport!(PROJECT_ID))!;
    expect(view.pages.map((p) => [p.page.id, p.depth])).toEqual([
      [PAGE, 0],
      [CHILD, 1],
    ]);
  });

  it("un'immagine si legge dalla rotta dell'immagine come data URL (l'export non porta URL firmati)", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const request = vi.fn(async (req: { path: string }) =>
      req.path.endsWith("/export")
        ? {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              exported(PAGE, [
                {
                  id: "b-img",
                  type: "image",
                  src: `product-image:${IMAGE}`,
                  caption: "Flow",
                  alt: "flow",
                },
              ]),
            ),
          }
        : req.path === `/api/product-pages/${PAGE}/images/${IMAGE}`
          ? { status: 200, headers: { "content-type": "image/png" }, body: png.buffer }
          : { status: 404, headers: { "content-type": "application/json" }, body: "{}" },
    );
    vi.stubGlobal("stubwise", { api: { request } });
    const view = (await docs.getProductExport!(PROJECT_ID, { pageId: PAGE }))!;
    const image = view.pages[0]!.page.blocks[0] as { src: string };
    expect(image.src).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`);
  });

  it("404 è nessuna esportazione; 403 è `forbidden`; oltre il tetto (413 `too_many_pages`) un rifiuto `too_large` col numero", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/export`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await docs.getProductExport!(PROJECT_ID, { pageId: PAGE })).toBeNull();
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/export`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    await expect(docs.getProductExport!(PROJECT_ID)).rejects.toThrow("forbidden");
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/product/export`]: {
        status: 413,
        body: { code: "too_many_pages", message: "x", count: 240, max: 200 },
      },
    });
    await expect(docs.getProductExport!(PROJECT_ID)).rejects.toMatchObject({
      message: "too_large",
      pageCount: 240,
      max: 200,
    });
  });
});
