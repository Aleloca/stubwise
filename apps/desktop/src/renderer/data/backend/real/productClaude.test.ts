import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import {
  forgetProductClaude,
  liveProductClaude as claude,
  productQuestionDecisions,
  rememberRevisionMarks,
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

  it("«Undo» dalla cronologia di un segno accettato: l'id viene dalla revisione (`markIdByAnchor`), non dai segni aperti", async () => {
    const { seen } = installFakeServer({
      [`POST /api/product-marks/${MARK}/undo`]: { body: { seq: 9, revisionId: null } },
    });
    rememberRevisionMarks(REV, { "blk-1": MARK });
    // Il server non ha scritto una revisione d'annullamento: nessuna da restituire.
    expect(await claude.undoProductChange!(REV, "blk-1")).toEqual({ revisionId: null });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /api/product-marks/${MARK}/undo`,
    ]);
  });

  it("i segni riletti senza un'ancora la tolgono dalla cache; una revisione riletta sostituisce le sue", async () => {
    installFakeServer({ [`GET /api/product-pages/${PAGE}/marks`]: { body: [mark()] } });
    await claude.listProductMarks!(PAGE);
    installFakeServer({ [`GET /api/product-pages/${PAGE}/marks`]: { body: [] } });
    await claude.listProductMarks!(PAGE);
    await expect(claude.acceptProductMark!(PAGE, "blk-1")).rejects.toThrow("not_found");
    rememberRevisionMarks(REV, { "blk-1": MARK });
    rememberRevisionMarks(REV, {});
    await expect(claude.undoProductChange!(REV, "blk-1")).rejects.toThrow("not_found");
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
      // L'api-client di 72 (4b): `{ revisionId, seq, requestId }`.
      [`POST /api/product-comments/${COMMENT}/answer`]: {
        body: { revisionId: REV, seq: 9, requestId: null },
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

describe("la riga «riprende quando…» dello spazio (claudeHeld, F5)", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const space = (claudeHeld: unknown) => ({
    projectId: PROJECT,
    projectCode: "AUD",
    pages: [],
    pageCount: 0,
    recent: [],
    permissions: { edit: true },
    claudeHeld,
  });

  it("il conteggio e il motivo più grave dello spazio; senza attese nessuna riga", async () => {
    for (const reason of ["budget", "paused", "limit", "section_busy"] as const) {
      installFakeServer({
        [`GET /api/projects/${PROJECT}/product`]: { body: space({ reason, count: 3 }) },
      });
      expect(await claude.productUpdatesWaiting!(PROJECT)).toEqual({ count: 3, reason });
    }
    installFakeServer({ [`GET /api/projects/${PROJECT}/product`]: { body: space(null) } });
    expect(await claude.productUpdatesWaiting!(PROJECT)).toBeNull();
  });

  it("uno spazio che non c'è o non si legge: nessuna riga", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT}/product`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await claude.productUpdatesWaiting!(PROJECT)).toBeNull();
  });
});

describe("le domande aperte (72, 4b: `openQuestions`)", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const open = (over: Record<string, unknown> = {}) => ({
    commentId: COMMENT,
    pageId: PAGE,
    pageCode: "AUD-D5",
    pageTitle: "Sign-in",
    projectId: PROJECT,
    projectCode: "AUD",
    anchorId: "blk-1",
    createdAt: "2026-11-20T10:00:00.000Z",
    question: {
      reason: "vague",
      forId: null,
      forName: null,
      taskCode: null,
      source: source({ canOpen: false, id: null, title: null, thread: null }),
      applyMode: "replace",
      current: { text: "Google only", marks: [] },
      apply: { text: "Google or email", marks: [] },
      built: null,
      request: null,
      recommended: "keep",
      options: ["keep", "apply"],
      canAnswer: true,
      applyBlocked: null,
      answer: null,
    },
    ...over,
  });

  it("il riquadro di uno spazio: quelle del progetto, con la frase citata", async () => {
    installFakeServer({
      "GET /api/me/product-questions": {
        body: [
          open(),
          open({
            commentId: "eeeeeeee-0000-4000-8000-000000000002",
            projectId: "22222222-2222-4222-8222-222222222222",
          }),
        ],
      },
    });
    expect(await claude.listOpenProductQuestions!(PROJECT)).toEqual({
      count: 1,
      items: [
        {
          commentId: COMMENT,
          pageId: PAGE,
          pageCode: "AUD-D5",
          pageTitle: "Sign-in",
          quote: "Google only",
        },
      ],
    });
  });

  it("«Decide» della Home: una voce per domanda, `product:<commento>`, col filo da aprire e la fonte vista", async () => {
    installFakeServer({ "GET /api/me/product-questions": { body: [open()] } });
    const [d] = await productQuestionDecisions();
    expect(d).toMatchObject({
      kind: "productQuestion",
      id: `product:${COMMENT}`,
      commentId: COMMENT,
      pageCode: "AUD-D5",
      projectCode: "AUD",
      quote: "Google only",
      link: `#/p/AUD/docs/product/AUD-D5?comment=${COMMENT}`,
      reason: "vague",
      recommended: "keep",
      options: ["keep", "apply"],
      applyBlocked: null,
      source: { label: { key: "productDocs.source.emailOf" } },
    });
  });

  it("un server senza la rotta (404): nessuna voce", async () => {
    installFakeServer({});
    expect(await productQuestionDecisions()).toEqual([]);
  });
});

describe("«Decide» con `product-docs` acceso (F5)", () => {
  it("un errore delle domande della doc (non 404) non svuota «Decide»: le voci delle conversazioni restano", async () => {
    const { listClaudeDecisions } = await import("./claudeActions");
    installFakeServer({
      "GET /api/me/claude-decisions": { body: [] },
      "GET /api/me/product-questions": { status: 500, body: { code: "internal", message: "x" } },
    });
    await expect(listClaudeDecisions()).resolves.toEqual([]);
  });

  it("le domande della doc entrano in «Decide» insieme a quelle delle conversazioni", async () => {
    const { listClaudeDecisions } = await import("./claudeActions");
    const { seen } = installFakeServer({
      "GET /api/me/claude-decisions": { body: [] },
      "GET /api/me/product-questions": { body: [] },
    });
    await listClaudeDecisions();
    expect(seen.some((r) => r.path.startsWith("/api/me/product-questions"))).toBe(true);
  });
});

describe("«Open a request» nella build app (la scheda B nel filo, decisione del maintainer)", () => {
  it("la scelta «request» c'è, anche come consiglio", async () => {
    const { questionViewFrom } = await import("./productClaude");
    const view = questionViewFrom({
      reason: "diverges",
      forId: null,
      forName: null,
      taskCode: "ACQ-12",
      source: source(),
      applyMode: "insert",
      current: null,
      apply: { text: "x", marks: [] },
      built: "Built without the PDF",
      request: { title: "PDF bills", description: "…" },
      recommended: "request",
      options: ["request", "keep", "apply"],
      canAnswer: true,
      applyBlocked: null,
      answer: null,
    } as never);
    expect(view.options).toEqual(["request", "keep", "apply"]);
    expect(view.recommended).toBe("request");
  });
});

describe("una domanda con valori che il renderer non conosce (UNKNOWN)", () => {
  it("un motivo ignoto si legge «vague» (la frase neutra); una risposta ignota resta una risposta", async () => {
    const { questionViewFrom } = await import("./productClaude");
    const view = questionViewFrom({
      reason: "__unknown__",
      forId: null,
      forName: null,
      taskCode: null,
      source: source(),
      applyMode: "insert",
      current: null,
      apply: { text: "x", marks: [] },
      built: null,
      request: null,
      recommended: null,
      options: [],
      canAnswer: false,
      applyBlocked: null,
      answer: {
        byId: LAURA,
        byName: "Laura Costa",
        option: "__unknown__",
        revisionId: null,
        requestCode: null,
      },
    } as never);
    expect(view.reason).toBe("vague");
    expect(view.answer).toMatchObject({ byName: "Laura Costa" });
  });
});

describe("una fonte senza data (revisione di R11-5, 13)", () => {
  it("l'email e la riunione che chi guarda non apre: il titolare, senza «Jan 1»", () => {
    expect(
      sourceViewFrom(
        source({ kind: "email", canOpen: false, title: null, ownerName: "Laura Costa", at: null }),
      ).label,
    ).toEqual({
      key: "productDocs.source.emailOfNoDate",
      params: { owner: "Laura Costa" },
    });
    expect(
      sourceViewFrom(
        source({ kind: "meeting", canOpen: false, title: null, ownerName: null, at: null }),
      ).label,
    ).toMatchObject({
      key: "productDocs.source.meetingOfNoDate",
    });
  });
});
