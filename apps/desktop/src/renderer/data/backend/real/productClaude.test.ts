import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import {
  forgetProductClaude,
  liveProductClaude as claude,
  sourceViewFrom,
  type ServerSourceView,
} from "./productClaude";

// Claude sulla doc di prodotto nella build app (area 11, F5; R11-5), sulle
// forme di 72 in bozza (Task 4 e 5): la fonte vista a pezzi (la frase la
// compone il renderer), i segni, «Looks good», «Undo», «Undo all», la
// risposta alle domande. Dietro `product-docs`, spento.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const REV = "bbbbbbbb-0000-4000-8000-000000000001";
const MARK = "cccccccc-0000-4000-8000-000000000001";
const COMMENT = "eeeeeeee-0000-4000-8000-000000000001";
const LAURA = "55555555-5555-4555-8555-555555555555";
const CLAUDE = "99999999-9999-4999-8999-999999999999";

const source = (over: Record<string, unknown> = {}): ServerSourceView =>
  ({
    kind: "email",
    canOpen: true,
    id: "dddddddd-0000-4000-8000-000000000001",
    title: "Sign-in with Google only",
    code: null,
    ownerId: LAURA,
    ownerName: "Laura Costa",
    at: "2026-11-18T09:00:00.000Z",
    gone: false,
    thread: { threadId: "18c2f", accountId: "aaaaaaaa-1111-4111-8111-000000000001" },
    ...over,
  }) as ServerSourceView;

const mark = (over: Record<string, unknown> = {}) => ({
  id: MARK,
  anchorId: "blk-1",
  blockId: "blk-1",
  cell: null,
  revisionId: REV,
  groupAnchors: 2,
  actorId: CLAUDE,
  onBehalfOfId: LAURA,
  onBehalfOfName: "Laura Costa",
  at: "2026-11-20T10:00:00.000Z",
  source: source(),
  canAccept: true,
  undo: { enabled: true, reason: null, byId: null, byName: null },
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  forgetProductClaude();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

describe("la fonte vista, composta dai pezzi del server (N-2 = a)", () => {
  it("un'email che chi guarda apre: «From the email “…”», col titolare e la data", () => {
    expect(sourceViewFrom(source())).toEqual({
      kind: "email",
      label: { key: "productDocs.source.email", params: { subject: "Sign-in with Google only" } },
      code: null,
      // La conversazione della Posta dell'app (72: `thread`, solo a chi la apre).
      link: "#/mail/aaaaaaaa-1111-4111-8111-000000000001_18c2f",
      ownerId: LAURA,
      at: "2026-11-18T09:00:00.000Z",
      gone: false,
    });
  });

  it("un'email di un altro (anche per un admin): solo «da un'email di <titolare> · <data>», mai oggetto né id", () => {
    const view = sourceViewFrom(source({ canOpen: false, id: null, title: null, thread: null }));
    expect(view.label).toEqual({
      key: "productDocs.source.emailOf",
      params: { owner: "Laura Costa", date: Date.parse("2026-11-18T09:00:00.000Z") },
    });
    expect(JSON.stringify(view)).not.toContain("Sign-in with Google only");
    expect(view.link).toBeNull();
  });

  it("riunione, decisione, task e rilascio: visibili col titolo, altrimenti la frase senza (il codice resta)", () => {
    expect(sourceViewFrom(source({ kind: "meeting", title: "Kick-off" })).label).toEqual({
      key: "productDocs.source.meeting",
      params: { title: "Kick-off" },
    });
    expect(sourceViewFrom(source({ kind: "decision", title: null, canOpen: false })).label).toEqual(
      {
        key: "productDocs.source.decisionHidden",
      },
    );
    const task = sourceViewFrom(
      source({ kind: "task", title: null, canOpen: false, code: "ACQ-12" }),
    );
    expect(task).toMatchObject({ label: { key: "productDocs.source.taskHidden" }, code: "ACQ-12" });
    expect(sourceViewFrom(source({ kind: "release", title: "1.4" })).label).toEqual({
      key: "productDocs.source.release",
      params: { title: "1.4" },
    });
    expect(sourceViewFrom(source({ kind: "first_version" })).label).toEqual({
      key: "productDocs.source.firstVersion",
    });
  });

  it("un titolare che chi guarda non vede: «Someone»; una fonte sparita: «Source no longer available»", () => {
    expect(
      sourceViewFrom(source({ canOpen: false, title: null, id: null, ownerName: null })).label
        .params?.owner,
    ).toBe("Someone");
    expect(sourceViewFrom(source({ gone: true }))).toMatchObject({
      label: { key: "productDocs.source.gone" },
      gone: true,
    });
  });
});

describe("i segni di Claude", () => {
  it("i segni aperti della pagina nella forma del prototipo", async () => {
    installFakeServer({ [`GET /api/product-pages/${PAGE}/marks`]: { body: [mark()] } });
    const [m] = await claude.listProductMarks!(PAGE);
    expect(m).toMatchObject({
      anchorId: "blk-1",
      blockId: "blk-1",
      revisionId: REV,
      groupId: REV,
      groupAnchors: 2,
      onBehalfOfId: LAURA,
      canAccept: true,
      undo: { enabled: true },
      source: { label: { key: "productDocs.source.email" } },
    });
    expect(m).not.toHaveProperty("cell");
  });

  it("«Looks good» e «Undo» di un'ancora vanno al segno letto; senza ancora «Undo all» va alla revisione", async () => {
    const { seen } = installFakeServer({
      [`GET /api/product-pages/${PAGE}/marks`]: { body: [mark()] },
      [`POST /api/product-marks/${MARK}/looks-good`]: { status: 204 },
      [`POST /api/product-marks/${MARK}/undo`]: {
        body: { seq: 9, revisionId: "bbbbbbbb-0000-4000-8000-000000000009" },
      },
      [`POST /api/product-revisions/${REV}/undo-all`]: {
        body: { seq: 10, revisionId: "bbbbbbbb-0000-4000-8000-000000000010" },
      },
    });
    await claude.listProductMarks!(PAGE);
    await claude.acceptProductMark!(PAGE, "blk-1");
    expect(await claude.undoProductChange!(REV, "blk-1")).toEqual({
      revisionId: "bbbbbbbb-0000-4000-8000-000000000009",
    });
    expect(await claude.undoProductChange!(REV)).toEqual({
      revisionId: "bbbbbbbb-0000-4000-8000-000000000010",
    });
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/api/product-marks/${MARK}/looks-good`,
      `/api/product-marks/${MARK}/undo`,
      `/api/product-revisions/${REV}/undo-all`,
    ]);
  });

  it("«Undo» rifiutato: `changed_after` (con chi), `already_undone`, `section_busy` nelle parole del prototipo", async () => {
    installFakeServer({
      [`GET /api/product-pages/${PAGE}/marks`]: { body: [mark()] },
      [`POST /api/product-marks/${MARK}/undo`]: {
        status: 409,
        body: { code: "changed_after", message: "x", byId: LAURA, byName: "Laura Costa" },
      },
    });
    await claude.listProductMarks!(PAGE);
    await expect(claude.undoProductChange!(REV, "blk-1")).rejects.toMatchObject({
      message: "changed_after",
      byId: LAURA,
    });
  });

  it("un'ancora che non ha un segno letto: «not_found», senza chiamare", async () => {
    const { seen } = installFakeServer({});
    await expect(claude.acceptProductMark!(PAGE, "blk-9")).rejects.toThrow("not_found");
    expect(seen).toHaveLength(0);
  });
});

describe("la risposta a una domanda di Claude", () => {
  it("«Update it» / «Leave it as is»: la risposta con la revisione scritta", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-comments/${COMMENT}/answer`]: {
        body: {
          answer: {
            byId: ME_ID,
            byName: "Ada",
            option: "apply",
            at: "2026-11-20T10:00:00.000Z",
            revisionId: REV,
            requestId: null,
            requestCode: null,
          },
        },
      },
    });
    expect(await claude.answerProductQuestion!(COMMENT, "apply")).toEqual({ revisionId: REV });
    expect(seen[0]!.body).toEqual({ option: "apply" });
  });

  it("già risposta da un altro: `already_answered` con chi e cosa; una frase cambiata: `changed_after`", async () => {
    installFakeServer({
      [`POST /api/product-comments/${COMMENT}/answer`]: {
        status: 409,
        body: {
          code: "already_answered",
          message: "x",
          byId: LAURA,
          byName: "Laura Costa",
          option: "keep",
        },
      },
    });
    await expect(claude.answerProductQuestion!(COMMENT, "apply")).rejects.toMatchObject({
      message: "already_answered",
      byId: LAURA,
    });
    installFakeServer({
      [`POST /api/product-comments/${COMMENT}/answer`]: {
        status: 409,
        body: { code: "changed_after", message: "x", byId: null, byName: null },
      },
    });
    await expect(claude.answerProductQuestion!(COMMENT, "apply")).rejects.toThrow("changed_after");
  });
});
