import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject } from "./fakeServer";
import { listNotifications } from "./notifications";

// La menzione in un commento della doc di prodotto nell'inbox della build app
// (area 11, F2 di 72; R11-2): la card `product_doc.mention` coi valori che
// il server deriva a lettura (`item.productDoc`): il titolo di ADESSO della
// pagina, chi ha scritto (`null` se chi guarda non lo vede, R-G5), il filo da
// aprire (`threadRootId`, il `?comment=` del prototipo). Pagina o commento
// spariti, o Docs che chi guarda non legge più: `objectGone`, nessun link.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const COMMENT = "eeeeeeee-0000-4000-8000-000000000002";
const ROOT = "eeeeeeee-0000-4000-8000-000000000001";
const LAURA = "55555555-5555-4555-8555-555555555555";

const card = (over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "product_doc.mention",
  status: "open",
  text: "Laura Costa mentioned you in AUD-D5",
  actions: ["open"],
  projectId: PROJECT_ID,
  ticketId: null,
  jobId: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
  productDoc: {
    pageId: PAGE,
    pageCode: "AUD-D5",
    pageTitle: "Sign-in",
    projectCode: "AUD",
    commentId: COMMENT,
    threadRootId: ROOT,
    authorId: LAURA,
    authorName: "Laura Costa",
    excerpt: "@Ada can you check the fallback?",
  },
  ...over,
});

function inbox(items: unknown[]) {
  return installFakeServer({
    "GET /api/inbox": ({ path }) => ({
      body: { items: path.includes("status=open") ? items : [], nextCursor: null },
    }),
    "GET /api/projects": { body: [serverProject()] },
  });
}

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la menzione nella doc di prodotto nell'inbox", () => {
  it("apre la pagina sul filo, col codice della pagina, il titolo di adesso, chi ha scritto e il testo", async () => {
    inbox([card()]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({
      kind: "product_doc.mention",
      objectCode: "AUD-D5",
      productPageTitle: "Sign-in",
      actorName: "Laura Costa",
      link: `#/p/AUD/docs/product/AUD-D5?comment=${ROOT}`,
    });
  });

  it("chi ha scritto e chi guarda non vede: nessun nome (la card dice «Someone»)", async () => {
    inbox([
      card({
        text: "Someone mentioned you in AUD-D5",
        productDoc: { ...card().productDoc, authorId: null, authorName: null },
      }),
    ]);
    const [n] = await listNotifications();
    expect(n!.actorName).toBeNull();
    expect(JSON.stringify(n)).not.toContain("Laura");
  });

  it("senza filo (`threadRootId` null): la pagina", async () => {
    inbox([card({ productDoc: { ...card().productDoc, commentId: null, threadRootId: null } })]);
    const [n] = await listNotifications();
    expect(n!.link).toBe("#/p/AUD/docs/product/AUD-D5");
  });

  it("pagina o commento spariti: `objectGone`, nessun link né titolo della pagina", async () => {
    inbox([card({ objectGone: true, productDoc: null, text: "A comment you were mentioned in" })]);
    const [n] = await listNotifications();
    // Niente codice, come il prototipo (`presentProductMention`): né la pagina né il progetto.
    expect(n).toMatchObject({ objectGone: true, link: "", objectCode: "" });
    expect(n!.productPageTitle).toBeUndefined();
  });
});

describe("la card della menzione arriva da obbligatorio (review di R11-2, 1)", () => {
  it("`alertMandatory: mentioned`: il motivo c'è, e il pannello non offre «Don't alert me»", async () => {
    inbox([card({ alertMandatory: "mentioned" })]);
    const [n] = await listNotifications();
    expect(n!.mandatory).toEqual([{ personId: expect.any(String), reason: "mentioned" }]);
  });
});

describe("il testo della card della menzione (review di R11-2, 2)", () => {
  it("viene da `productDoc.excerpt` (72, 0dd87eaa0), mai da un `summary`; null (un server di prima) è vuoto", async () => {
    inbox([card({ summary: "a summary the server never sends" })]);
    expect((await listNotifications())[0]!.body).toBe("@Ada can you check the fallback?");
    inbox([card({ productDoc: { ...card().productDoc, excerpt: null } })]);
    expect((await listNotifications())[0]!.body).toBe("");
  });
});

// Area 11, F5 (Task 5 di 72): le card di Claude sulla doc, `updated` e
// `question`, coi valori che il server deriva a lettura (`productDoc.claude`).
describe("le card di Claude sulla doc nell'inbox (F5)", () => {
  const REVISION = "bbbbbbbb-0000-4000-8000-000000000001";
  const QUESTION = "eeeeeeee-0000-4000-8000-000000000009";
  const source = {
    kind: "task",
    canOpen: true,
    id: "cccccccc-0000-4000-8000-000000000001",
    title: "Bills in PDF",
    code: "AUD-12",
    ownerId: null,
    ownerName: null,
    at: null,
    gone: false,
    thread: null,
  };
  const claude = (over: Record<string, unknown> = {}) => ({
    revisionId: REVISION,
    sources: [source],
    changes: 3,
    onBehalfOfName: "Laura Costa",
    undoneByName: null,
    markAnchorId: "blk-7",
    waited: null,
    question: null,
    ...over,
  });
  const updated = (over: Record<string, unknown> = {}) =>
    card({
      kind: "product_doc.updated",
      text: "Claude updated AUD-D5",
      productDoc: {
        ...card().productDoc,
        commentId: null,
        threadRootId: null,
        authorId: null,
        authorName: null,
        excerpt: null,
        claude: claude(),
      },
      ...over,
    });

  it("«updated» porta al primo segno a vista (`?mark=`), con fonti, frasi, «per conto di»", async () => {
    inbox([updated()]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({
      kind: "product_doc.updated",
      objectCode: "AUD-D5",
      productPageTitle: "Sign-in",
      link: "#/p/AUD/docs/product/AUD-D5?mark=blk-7",
      undoneByName: null,
      productCard: { changes: 3, onBehalfOfName: "Laura Costa", waited: null },
    });
    expect(n!.productCard!.sources[0]).toMatchObject({ kind: "task", code: "AUD-12", gone: false });
    expect(n!.productCard!.question).toBeUndefined();
  });

  it("`waited` (72, b3ef7fa53): «budget» e «paused» nelle parole del prototipo; le card di prima restano null", async () => {
    const withWaited = (waited: string | null) =>
      updated({ productDoc: { ...updated().productDoc, claude: claude({ waited }) } });
    inbox([withWaited("budget"), withWaited("paused"), withWaited(null)]);
    expect((await listNotifications()).map((n) => n.productCard!.waited)).toEqual([
      "monthly_budget",
      "queue_paused",
      null,
    ]);
  });

  it("«updated» senza segni a vista porta alla cronologia della revisione; tutte annullate: chi", async () => {
    inbox([
      updated({
        productDoc: {
          ...updated().productDoc,
          claude: claude({ markAnchorId: null, undoneByName: "Marco Bellini" }),
        },
      }),
    ]);
    const [n] = await listNotifications();
    expect(n!.link).toBe(`#/p/AUD/docs/product/AUD-D5?history=${REVISION}`);
    expect(n!.undoneByName).toBe("Marco Bellini");
  });

  it("«question» apre la pagina sul filo della domanda, con la ragione e chi ha risposto", async () => {
    const question = {
      reason: "diverges",
      forName: "Laura Costa",
      taskCode: "AUD-12",
      answer: "keep",
      answeredByName: "Marco Bellini",
      canRequest: true,
    };
    inbox([
      card({
        kind: "product_doc.question",
        text: "Claude has a question in AUD-D5",
        productDoc: {
          ...card().productDoc,
          commentId: QUESTION,
          threadRootId: QUESTION,
          authorId: null,
          authorName: null,
          excerpt: null,
          claude: claude({
            revisionId: null,
            changes: 0,
            onBehalfOfName: null,
            markAnchorId: null,
            question,
          }),
        },
      }),
    ]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({
      kind: "product_doc.question",
      objectCode: "AUD-D5",
      link: `#/p/AUD/docs/product/AUD-D5?comment=${QUESTION}`,
      productCard: { changes: 0, question },
    });
  });
});
