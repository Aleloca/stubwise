import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summaryOf } from "./claudeChatActions";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID } from "./fakeServer";
import { forgetProductDocs, liveProductDocs as docs } from "./productDocs";

// Le voci di Claude sulla doc nella build app (area 11, F6, Task 4 di 72,
// b869a902c): la frase della scheda e della riga dagli argomenti, con le
// parole del catalogo del prototipo (`catalogProduct.ts`, le frasi di
// `domain/claude/intents/productDocs.ts`). La pagina si dice col codice
// (dal server, `codes` del gruppo) e col titolo, se chi guarda l'ha letta.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const REV = "bbbbbbbb-0000-4000-8000-000000000001";

const pageView = {
  id: PAGE,
  code: "AUD-D5",
  projectId: PROJECT_ID,
  parentId: null,
  order: 0,
  title: "Sign-in",
  excerpt: "",
  updatedAt: "2026-11-20T10:00:00.000Z",
  updatedById: ME_ID,
  blocks: [],
  seq: 7,
  createdById: ME_ID,
  createdAt: "2026-11-19T10:00:00.000Z",
  breadcrumbs: [],
  decisions: {},
  following: true,
  permissions: { edit: true, delete: false },
};

async function readSignIn() {
  installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/product-pages/by-code/AUD-D5": { body: pageView },
  });
  await docs.getProductPage!("AUD-D5");
}

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

const said = (fn: string, args: Record<string, unknown>, code: string | null) =>
  summaryOf(fn, args, code).summary;

describe("le frasi delle voci della doc", () => {
  it("la prima versione e il suo inverso: il progetto per codice", () => {
    expect(said("writeFirstVersion", { projectId: PROJECT_ID, sources: [] }, "AUD")).toBe(
      "Write the first version of AUD's docs",
    );
    expect(said("undoFirstVersion", { projectId: PROJECT_ID }, "AUD")).toBe(
      "Undo the first version of AUD's docs",
    );
  });

  it("una pagina letta: codice e titolo, come il prototipo", async () => {
    await readSignIn();
    expect(
      said("updateProductPage", { pageId: PAGE, source: { kind: "email", id: "m1" } }, null),
    ).toBe("Update AUD-D5 Sign-in from the email");
    expect(
      said("updateProductPage", { pageId: PAGE, source: { kind: "meeting", id: "n1" } }, "AUD-D5"),
    ).toBe("Update AUD-D5 Sign-in from the meeting");
    expect(said("drawWireframe", { pageId: PAGE, afterId: null }, null)).toBe(
      "Draw a screen sketch in AUD-D5 Sign-in",
    );
    expect(said("deleteWireframe", { pageId: PAGE, blockId: "blk-w", revisionId: REV }, null)).toBe(
      "Remove the screen sketch from AUD-D5 Sign-in",
    );
  });

  it("una pagina mai letta: il codice del server; senza nemmeno quello, «a page»", () => {
    expect(said("drawWireframe", { pageId: PAGE, afterId: null }, "AUD-D5")).toBe(
      "Draw a screen sketch in AUD-D5",
    );
    expect(said("drawWireframe", { pageId: PAGE, afterId: null }, null)).toBe(
      "Draw a screen sketch in a page",
    );
  });

  it("«undo» di un aggiornamento: per revisione, la pagina se il server la dice", () => {
    expect(said("undoProductUpdate", { revisionId: REV }, "AUD-D5")).toBe(
      "Undo Claude's update of AUD-D5",
    );
    expect(said("undoProductUpdate", { revisionId: REV }, null)).toBe(
      "Undo Claude's update of a page",
    );
  });

  it("in italiano", async () => {
    const { default: i18n } = await import("../../../i18n");
    await i18n.changeLanguage("it");
    try {
      await readSignIn();
      expect(said("drawWireframe", { pageId: PAGE, afterId: null }, null)).toBe(
        "Disegnare una bozza di schermata in AUD-D5 Sign-in",
      );
      expect(said("writeFirstVersion", { projectId: PROJECT_ID, sources: [] }, "AUD")).toBe(
        "Scrivere la prima versione della doc di AUD",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
