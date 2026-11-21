import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID } from "./fakeServer";
import { forgetProductDocs, liveProductDocs as docs } from "./productDocs";
import { liveProductBacklog as backlog } from "./productBacklog";

// Dalla doc al backlog nella build app (area 11, F6; R11-6), sulle forme di
// 72 (a2e2bd051): le voci da proporre le dà il server
// (`backlogCandidates`), la scheda B la compone il renderer come il
// prototipo (`proposeBacklogFromPageAs`), una `createRequest` per voce con
// l'origine della pagina; «From this page» (`linkedRequests`). Dietro
// `product-claude-actions`, spento.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const REQ = "22222222-0000-4000-8000-000000000001";

beforeEach(() => {
  setAppClientForTests(null);
  forgetProductDocs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

async function readPage() {
  installFakeServer({
    "GET /api/product-pages/by-code/AUD-D5": {
      body: {
        id: PAGE,
        code: "AUD-D5",
        projectId: PROJECT_ID,
        parentId: null,
        order: 0,
        title: "Sign-in",
        blocks: [],
        seq: 1,
        createdById: null,
        createdAt: "2026-11-19T10:00:00.000Z",
        updatedById: null,
        updatedAt: "2026-11-19T10:00:00.000Z",
        breadcrumbs: [],
        decisions: {},
        following: false,
        permissions: { edit: true, delete: false },
      },
    },
  });
  await docs.getProductPage!("AUD-D5");
}

describe("dalla doc al backlog nella build app", () => {
  it("una proposta per voce, con l'origine della pagina e il perché; le già proposte in una nota", async () => {
    await readPage();
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/backlog-candidates`]: {
        body: {
          candidates: [
            {
              anchorId: "blk-3",
              title: "PDF bills",
              description: "Bills in PDF.",
              sentence: "Bills can be downloaded as PDF.",
            },
          ],
          alreadyProposed: { codes: ["AUD-R2"], hidden: 1 },
        },
      },
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        body: {
          projectId: PROJECT_ID,
          projectCode: "AUD",
          pages: [],
          pageCount: 1,
          recent: [],
          permissions: { edit: true },
          claudeHeld: null,
        },
      },
    });
    const out = await backlog.proposeBacklogFromPage!(PAGE);
    expect(out.actions).toEqual([
      {
        fn: "createRequest",
        args: {
          projectId: PROJECT_ID,
          title: "PDF bills",
          description: "Bills in PDF.",
          origin: { kind: "product_doc", pageId: PAGE, anchorId: "blk-3" },
        },
        summary: "Open a request in AUD: “PDF bills”",
        summaryText: {
          key: "claude.answers.request.summary",
          params: { code: "AUD", title: "PDF bills" },
        },
        why: {
          key: "claude.answers.productDocs.backlog.why",
          params: { sentence: "Bills can be downloaded as PDF." },
        },
      },
    ]);
    expect(out.notes).toEqual([{ kind: "already_proposed", codes: ["AUD-R2"], hidden: 1 }]);
  });

  it("dal titolo di una sezione: `fromAnchorId` al server; uno che non è un titolo: `invalid: anchor`", async () => {
    await readPage();
    const { seen } = installFakeServer({
      [`GET /api/product-pages/${PAGE}/backlog-candidates`]: {
        body: { candidates: [], alreadyProposed: { codes: [], hidden: 0 } },
      },
      [`GET /api/projects/${PROJECT_ID}/product`]: {
        body: {
          projectId: PROJECT_ID,
          projectCode: "AUD",
          pages: [],
          pageCount: 1,
          recent: [],
          permissions: { edit: true },
          claudeHeld: null,
        },
      },
    });
    expect(await backlog.proposeBacklogFromPage!(PAGE, "blk-h")).toEqual({
      actions: [],
      notes: [],
    });
    expect(seen[0]!.path).toContain("fromAnchorId=blk-h");
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/backlog-candidates`]: {
        status: 422,
        body: { code: "invalid_anchor", message: "x" },
      },
    });
    await expect(backlog.proposeBacklogFromPage!(PAGE, "blk-1")).rejects.toThrow("invalid: anchor");
  });

  it("«From this page»: le richieste nate dalla pagina che chi guarda vede; un 404: nessuna", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/requests`]: {
        body: [
          { id: REQ, code: "AUD-R2", title: "PDF bills", status: "new", taskCodes: ["AUD-12"] },
        ],
      },
    });
    expect(await backlog.listProductLinkedRequests!(PAGE)).toEqual([
      { id: REQ, code: "AUD-R2", title: "PDF bills", status: "new", taskCodes: ["AUD-12"] },
    ]);
    installFakeServer({});
    expect(await backlog.listProductLinkedRequests!(PAGE)).toEqual([]);
  });
});
