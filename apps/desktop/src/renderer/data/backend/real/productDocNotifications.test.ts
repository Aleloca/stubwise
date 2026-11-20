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
