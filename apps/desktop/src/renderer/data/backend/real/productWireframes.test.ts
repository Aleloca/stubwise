import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { forgetProductDocs } from "./productDocs";
import { liveProductWireframes as wf } from "./productWireframes";

// Le bozze di schermata nella build app (area 11, F6; R11-6), sulle forme di
// 72 (a2e2bd051, rotte 7388dc0cf): lo SVG già ripulito dal server nella mappa
// `wireframes` della pagina (`<wireframeId>:<variant>`, come il prototipo), e
// i gesti draw, redraw, pick, keep, replace-image. Dietro
// `product-claude-actions`, spento.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const WF = "ffffffff-0000-4000-8000-000000000001";

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

describe("le bozze di schermata nella build app", () => {
  it("«Draw this screen» e «/» → «Screen sketch»: il blocco; i rifiuti nelle parole del prototipo", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/wireframes`]: {
        status: 202,
        body: { blockId: "blk-w", wireframeId: WF },
      },
    });
    expect(await wf.drawWireframe!(PAGE, { afterId: "blk-1" })).toEqual({ blockId: "blk-w" });
    expect(seen[0]!.body).toEqual({ afterId: "blk-1" });
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/wireframes`]: {
        status: 409,
        body: { code: "ai_blocked", message: "x" },
      },
    });
    await expect(wf.drawWireframe!(PAGE, { afterId: null })).rejects.toThrow("ai_blocked");
    installFakeServer({
      [`POST /api/product-pages/${PAGE}/wireframes`]: {
        status: 422,
        body: { code: "invalid_replace", message: "x" },
      },
    });
    await expect(wf.drawWireframe!(PAGE, { replaceId: "blk-2" })).rejects.toThrow(
      "invalid: replace",
    );
  });

  it("«Redraw» con la variante vista, «Keep» e «Replace with an image»: le rotte e le revisioni", async () => {
    const REV = "bbbbbbbb-0000-4000-8000-000000000001";
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/wireframes/blk-w/redraw`]: {
        status: 202,
        body: { blockId: "blk-w" },
      },
      [`POST /api/product-pages/${PAGE}/wireframes/blk-w/keep`]: { body: { revisionId: REV } },
      [`POST /api/product-pages/${PAGE}/wireframes/blk-w/replace-image`]: {
        body: { revisionId: null },
      },
    });
    expect(await wf.redrawWireframe!(PAGE, "blk-w", 0)).toEqual({ blockId: "blk-w" });
    expect(await wf.keepWireframe!(PAGE, "blk-w")).toEqual({ revisionId: REV });
    expect(
      await wf.replaceWireframeWithImage!(PAGE, "blk-w", {
        src: "product-image:abc",
        alt: "Sketch",
      }),
    ).toEqual({ revisionId: null });
    expect(seen.map((r) => [r.path.split("/").pop(), r.body])).toEqual([
      ["redraw", { fromVariant: 0 }],
      ["keep", undefined],
      ["replace-image", { src: "product-image:abc", alt: "Sketch" }],
    ]);
  });
});
