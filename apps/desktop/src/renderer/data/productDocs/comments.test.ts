import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitBlock } from "../../domain/productDocs/blocks";
import { plain } from "../../domain/productDocs/richText";
import { listNotifications, productDocs, resetApi, setLatency } from "../api";
import { docsAccess } from "../docs/reads";
import type { ProductBlock, ProductPage } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { revokeProjectPermission } from "../viewer";

// I commenti ancorati e le menzioni nel livello dati (area 11a, Task 4).
// Persone del seme: Laura (Project Lead in ACQ, `docs.edit`), Marco
// (Developer in ACQ, `docs.edit`), Matteo (in ACQ, `docs.edit`), Sara
// (Contributor in ACQ: `docs.view` senza `docs.edit`), Giulia (non è in ACQ).
// Il seme (Task 3 + questo task) ha un filo aperto con menzione su Sign-in,
// uno risolto su Bills e uno su un blocco tolto da Matteo in Phases.

const LAURA = "p-laura";
const MARCO = "p-marco";
const MATTEO = "p-matteo";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const para = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
});
const page = (title: string): ProductPage =>
  state.productPages.find((p) => p.projectId === ACQ && p.title === title)!;
const block = (title: string, id: string) => page(title).blocks.find((b) => b.id === id)!;

const SIGN_IN_PARA = "blk-acq-signin-2";

const snapshot = () =>
  JSON.stringify({
    comments: state.productComments,
    notifications: state.notifications,
    follows: state.productFollows,
  });

async function rejects(p: Promise<unknown>, message: string): Promise<void> {
  const before = snapshot();
  await expect(p).rejects.toThrow(message);
  expect(snapshot()).toBe(before);
}

const mentionsOf = (personId: string) =>
  state.notifications.filter(
    (n) => n.kind === "product_doc.mention" && n.recipientIds.includes(personId),
  );

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("il seme dei commenti", () => {
  it("Sign-in ha un filo aperto di Laura che menziona Marco, con la risposta di Marco", async () => {
    as(LAURA);
    const { open } = await productDocs.listProductComments(page("Sign-in").id);
    expect(open).toHaveLength(1);
    const [thread] = open;
    expect(thread!.root.authorId).toBe(LAURA);
    expect(thread!.root.body).toContain("@Marco Bellini");
    expect(thread!.root.mentionIds).toEqual([MARCO]);
    expect(thread!.replies.map((r) => r.authorId)).toEqual([MARCO]);
    expect(thread!.anchorGone).toBe(false);
    expect(thread!.root.authorName).toBe("Laura Costa");
  });

  it("Bills ha un filo risolto da Laura; Phases un filo su un blocco che Matteo ha tolto", async () => {
    as(LAURA);
    const bills = await productDocs.listProductComments(page("Bills").id);
    expect(bills.open).toEqual([]);
    expect(bills.resolved).toHaveLength(1);
    expect(bills.resolved[0]!.root.resolved?.byId).toBe(LAURA);

    const phases = await productDocs.listProductComments(page("Phases").id);
    expect(phases.open).toHaveLength(1);
    const [gone] = phases.open;
    expect(gone!.anchorGone).toBe(true);
    expect(gone!.root.quote.length).toBeGreaterThan(0);
    // Il blocco l'ha tolto una revisione di Matteo, ed era un id dato.
    const removal = state.productRevisions.find(
      (r) =>
        r.pageId === page("Phases").id &&
        r.changes.some((c) => c.blockId === gone!.root.anchorId && c.after === null),
    );
    expect(removal?.actorId).toBe(MATTEO);
    expect(state.productBlockIds.has(gone!.root.anchorId)).toBe(true);
  });

  it("Marco ha la notifica della menzione del seme", async () => {
    as(MARCO);
    const signIn = page("Sign-in");
    const cards = (await listNotifications()).filter((n) => n.kind === "product_doc.mention");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.objectCode).toBe(signIn.code);
    expect(cards[0]!.productPageTitle).toBe("Sign-in");
    expect(cards[0]!.objectGone).toBeUndefined();
  });

  it("i `seq` dei commenti del seme vengono prima del primo `nextSeq()`", async () => {
    const max = Math.max(...state.productComments.map((c) => c.seq));
    as(LAURA);
    const c = await productDocs.addProductComment(page("Bills").id, {
      anchorId: block("Bills", "blk-acq-bills-6").id,
      quote: "UTC",
      body: "Fine.",
    });
    expect(c.seq).toBeGreaterThan(max);
  });
});

describe("commentare, rispondere, «Risolto»", () => {
  it("Laura commenta Sign-in, Marco risponde; Sara non può fare nulla, e lo stato non cambia", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    const root = await productDocs.addProductComment(signIn.id, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      body: "Do we keep a fallback?",
    });
    expect(root).toMatchObject({
      pageId: signIn.id,
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      authorId: LAURA,
      replyToId: null,
      resolved: null,
      mentionIds: [],
    });
    as(MARCO);
    const reply = await productDocs.addProductComment(signIn.id, {
      anchorId: SIGN_IN_PARA,
      quote: "",
      body: "No, Google only.",
      replyToId: root.id,
    });
    expect(reply.replyToId).toBe(root.id);
    expect(reply.seq).toBeGreaterThan(root.seq);
    // La risposta sta sull'ancora e sulla frase della sua radice.
    expect(reply.anchorId).toBe(SIGN_IN_PARA);
    expect(reply.quote).toBe("Google account");

    as(SARA);
    await rejects(
      productDocs.addProductComment(signIn.id, {
        anchorId: SIGN_IN_PARA,
        quote: "Google account",
        body: "Me too",
      }),
      "forbidden",
    );
    await rejects(
      productDocs.addProductComment(signIn.id, {
        anchorId: SIGN_IN_PARA,
        quote: "",
        body: "Me too",
        replyToId: root.id,
      }),
      "forbidden",
    );
    await rejects(productDocs.resolveProductComment(root.id), "forbidden");
    // Sara legge i fili.
    const { open } = await productDocs.listProductComments(signIn.id);
    expect(open.some((t) => t.root.id === root.id)).toBe(true);
  });

  it("un testo vuoto, un'ancora che non c'è, una risposta a una risposta: rifiutati senza scrivere", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    await rejects(
      productDocs.addProductComment(signIn.id, { anchorId: SIGN_IN_PARA, quote: "x", body: "   " }),
      "invalid: body",
    );
    await rejects(
      productDocs.addProductComment(signIn.id, { anchorId: "blk-nope", quote: "x", body: "Hm" }),
      "invalid: anchor",
    );
    // Un'ancora di un'altra pagina non è un'ancora di questa.
    await rejects(
      productDocs.addProductComment(signIn.id, {
        anchorId: "blk-acq-bills-6",
        quote: "x",
        body: "Hm",
      }),
      "invalid: anchor",
    );
    const [thread] = (await productDocs.listProductComments(signIn.id)).open;
    const replyId = thread!.replies[0]!.id;
    await rejects(
      productDocs.addProductComment(signIn.id, {
        anchorId: SIGN_IN_PARA,
        quote: "",
        body: "Nested",
        replyToId: replyId,
      }),
      "invalid: reply",
    );
    await rejects(productDocs.resolveProductComment(replyId), "invalid: reply");
  });

  it("la risposta a un filo con l'ancora sparita (Phases) si scrive", async () => {
    const phases = page("Phases");
    as(LAURA);
    const [gone] = (await productDocs.listProductComments(phases.id)).open;
    const reply = await productDocs.addProductComment(phases.id, {
      anchorId: gone!.root.anchorId,
      quote: "",
      body: "We dropped it on purpose.",
      replyToId: gone!.root.id,
    });
    expect(reply.replyToId).toBe(gone!.root.id);
    const [after] = (await productDocs.listProductComments(phases.id)).open;
    expect(after!.anchorGone).toBe(true);
    expect(after!.replies.map((r) => r.id)).toContain(reply.id);
  });

  it("«Risolto» porta il filo di Sign-in fra i risolti, «Riapri» lo riporta; la barra li conta", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    const [thread] = (await productDocs.listProductComments(signIn.id)).open;
    expect((await productDocs.getProductPage(signIn.code))!.openComments).toBe(1);

    await productDocs.resolveProductComment(thread!.root.id);
    const resolved = await productDocs.listProductComments(signIn.id);
    expect(resolved.open).toEqual([]);
    expect(resolved.resolved.map((t) => t.root.id)).toEqual([thread!.root.id]);
    expect(resolved.resolved[0]!.root.resolved?.byId).toBe(LAURA);
    expect((await productDocs.getProductPage(signIn.code))!.openComments).toBe(0);

    await productDocs.reopenProductComment(thread!.root.id);
    const reopened = await productDocs.listProductComments(signIn.id);
    expect(reopened.open.map((t) => t.root.id)).toEqual([thread!.root.id]);
    expect(reopened.open[0]!.root.resolved).toBeNull();
    expect(reopened.resolved).toEqual([]);
  });

  it("un doppio clic su «Commenta» scrive un commento solo", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    setLatency(5);
    const before = state.productComments.length;
    const input = { anchorId: SIGN_IN_PARA, quote: "Google account", body: "Twice?" };
    const [a, b] = await Promise.all([
      productDocs.addProductComment(signIn.id, input),
      productDocs.addProductComment(signIn.id, input),
    ]);
    expect(a.id).toBe(b.id);
    expect(state.productComments).toHaveLength(before + 1);
    // Finita la prima, lo stesso testo di nuovo è un commento nuovo.
    const c = await productDocs.addProductComment(signIn.id, input);
    expect(c.id).not.toBe(a.id);
    expect(state.productComments).toHaveLength(before + 2);
  });

  it("i fili aperti seguono l'ordine delle ancore; quelli senza ancora vanno in fondo", async () => {
    const phases = page("Phases");
    const [, second, third] = phases.blocks;
    as(LAURA);
    const late = await productDocs.addProductComment(phases.id, {
      anchorId: third!.id,
      quote: "late",
      body: "Third block",
    });
    const early = await productDocs.addProductComment(phases.id, {
      anchorId: second!.id,
      quote: "early",
      body: "Second block",
    });
    const { open } = await productDocs.listProductComments(phases.id);
    expect(open.map((t) => t.root.id).slice(0, 2)).toEqual([early.id, late.id]);
    expect(open.at(-1)!.anchorGone).toBe(true);
  });
});

describe("le ancore quando il corpo cambia", () => {
  it("dividere il blocco commentato: il filo resta sulla prima parte", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    const [head, tail] = splitBlock(block("Sign-in", SIGN_IN_PARA), 10, "blk-test-split");
    await productDocs.saveProductBlocks(
      signIn.id,
      [
        { op: "set", block: head },
        { op: "insert", afterId: SIGN_IN_PARA, block: tail },
      ],
      { sessionId: "s-split" },
    );
    const [thread] = (await productDocs.listProductComments(signIn.id)).open;
    expect(thread!.root.anchorId).toBe(SIGN_IN_PARA);
    expect(thread!.anchorGone).toBe(false);
  });

  it("un filo su una cella di Meter reading: tolta la sua riga, «Frase eliminata»", async () => {
    const meter = page("Meter reading");
    as(LAURA);
    const c = await productDocs.addProductComment(meter.id, {
      anchorId: "blk-acq-meter-cell-2a",
      quote: "Household",
      body: "Also condominiums?",
    });
    let thread = (await productDocs.listProductComments(meter.id)).open.find(
      (t) => t.root.id === c.id,
    );
    expect(thread!.anchorGone).toBe(false);

    const table = block("Meter reading", "blk-acq-meter-table");
    if (table.type !== "table") throw new Error("not a table");
    await productDocs.saveProductBlocks(
      meter.id,
      [
        {
          op: "set",
          block: { ...table, rows: table.rows.filter((r) => r.id !== "blk-acq-meter-row-2") },
        },
      ],
      { sessionId: "s-row" },
    );
    thread = (await productDocs.listProductComments(meter.id)).open.find((t) => t.root.id === c.id);
    expect(thread!.anchorGone).toBe(true);
    expect(thread!.root.quote).toBe("Household");
  });

  it("unire (Q3): i fili del blocco assorbito passano al blocco unito, con le risposte e la loro frase", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    const FIRST = "blk-test-login";
    const SECOND = "blk-test-google";
    await productDocs.saveProductBlocks(
      signIn.id,
      [
        { op: "insert", afterId: "blk-acq-signin-4", block: para(FIRST, "Login only ") },
        { op: "insert", afterId: FIRST, block: para(SECOND, "with Google") },
      ],
      { sessionId: "s-merge-1" },
    );
    const onFirst = await productDocs.addProductComment(signIn.id, {
      anchorId: FIRST,
      quote: "Login only",
      body: "Only?",
    });
    const onSecond = await productDocs.addProductComment(signIn.id, {
      anchorId: SECOND,
      quote: "with Google",
      body: "Which Google?",
    });
    as(MARCO);
    const reply = await productDocs.addProductComment(signIn.id, {
      anchorId: SECOND,
      quote: "",
      body: "Workspace too.",
      replyToId: onSecond.id,
    });
    // La condizione che il test prova: due ancore diverse prima dell'unione.
    expect(onSecond.anchorId).not.toBe(onFirst.anchorId);

    as(LAURA);
    await productDocs.saveProductBlocks(
      signIn.id,
      [{ op: "merge", firstId: FIRST, secondId: SECOND }],
      {
        sessionId: "s-merge-2",
      },
    );
    const { open } = await productDocs.listProductComments(signIn.id);
    const first = open.find((t) => t.root.id === onFirst.id)!;
    const second = open.find((t) => t.root.id === onSecond.id)!;
    expect(first.root.anchorId).toBe(FIRST);
    expect(second.root.anchorId).toBe(FIRST);
    expect(first.anchorGone).toBe(false);
    expect(second.anchorGone).toBe(false);
    expect(second.replies.map((r) => [r.id, r.anchorId])).toEqual([[reply.id, FIRST]]);
    expect(second.root.quote).toBe("with Google");
    expect(open.filter((t) => t.anchorGone).map((t) => t.root.pageId)).not.toContain(signIn.id);
  });

  it("cancellare un blocco a mano (delete) non è un'unione: il filo diventa «Frase eliminata»", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    const c = await productDocs.addProductComment(signIn.id, {
      anchorId: "blk-acq-signin-4",
      quote: "email address",
      body: "And the phone?",
    });
    await productDocs.saveProductBlocks(
      signIn.id,
      [{ op: "delete", blockId: "blk-acq-signin-4" }],
      {
        sessionId: "s-del",
      },
    );
    const thread = (await productDocs.listProductComments(signIn.id)).open.find(
      (t) => t.root.id === c.id,
    );
    expect(thread!.root.anchorId).toBe("blk-acq-signin-4");
    expect(thread!.anchorGone).toBe(true);
  });
});

describe("chi si può menzionare", () => {
  it("«ma» in ACQ: Marco Bellini e Matteo Conti, solo chi legge i Docs di ACQ, mai Claude né chi scrive", async () => {
    as(LAURA);
    const found = await productDocs.productMentionCandidates(ACQ, "ma");
    const names = found.map((p) => p.name);
    expect(names).toContain("Marco Bellini");
    expect(names).toContain("Matteo Conti");
    for (const p of found) expect(docsAccess(p.id, ACQ), p.name).toBe("read");
    // Chi corrisponde a «ma» ma non legge i Docs di ACQ resta fuori.
    expect(names).not.toContain("Tommaso Riva");
    expect(found.map((p) => p.id)).not.toContain(CLAUDE_ID);
    expect(found.map((p) => p.id)).not.toContain(GIULIA);
    // Senza distinzione di maiuscole, e chi scrive non c'è.
    expect((await productDocs.productMentionCandidates(ACQ, "MARCO")).map((p) => p.id)).toEqual([
      MARCO,
    ]);
    expect(await productDocs.productMentionCandidates(ACQ, "laura")).toEqual([]);
    expect(await productDocs.productMentionCandidates(ACQ, "claude")).toEqual([]);
  });

  it("chi non ha più `docs.view` non si menziona", async () => {
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    as(LAURA);
    expect(await productDocs.productMentionCandidates(ACQ, "sara")).toEqual([]);
  });

  it("chi non legge i Docs del progetto non riceve candidati", async () => {
    as(GIULIA);
    expect(await productDocs.productMentionCandidates(ACQ, "ma")).toEqual([]);
  });
});

describe("le menzioni (Q1)", () => {
  it("«@Marco Bellini» due volte: una notifica a Marco; nessuna a chi scrive né a chi non legge ACQ", async () => {
    const signIn = page("Sign-in");
    const marcoBefore = mentionsOf(MARCO).length;
    as(LAURA);
    const c = await productDocs.addProductComment(signIn.id, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      // Due volte lo stesso nome: `directMentionIds` dà già ogni persona una
      // volta sola (filtra `PEOPLE`), quindi questo caso è garantito per
      // costruzione (ruling P31); il test vero è la riga sotto, chi scrive
      // e chi non legge ACQ.
      body: "@Marco Bellini please check. @Marco Bellini, again. cc @Laura Costa @Giulia Ferri",
    });
    expect(c.mentionIds).toEqual([MARCO]);
    expect(mentionsOf(MARCO)).toHaveLength(marcoBefore + 1);
    expect(mentionsOf(LAURA)).toEqual([]);
    expect(mentionsOf(GIULIA)).toEqual([]);
    const n = mentionsOf(MARCO).at(-1)!;
    expect(n).toMatchObject({
      projectId: ACQ,
      objectCode: signIn.code,
      actorId: LAURA,
      link: `#/p/ACQ/docs/product/${signIn.code}?comment=${c.id}`,
      productComment: { pageId: signIn.id, rootId: c.id },
      title: `Laura Costa mentioned you in ${signIn.code} · Sign-in`,
    });
  });

  it("una menzione in una risposta porta al filo della radice", async () => {
    const signIn = page("Sign-in");
    as(MARCO);
    const [thread] = (await productDocs.listProductComments(signIn.id)).open;
    const reply = await productDocs.addProductComment(signIn.id, {
      anchorId: SIGN_IN_PARA,
      quote: "",
      body: "@Matteo Conti what does the client say?",
      replyToId: thread!.root.id,
    });
    const n = mentionsOf(MATTEO).at(-1)!;
    expect(reply.mentionIds).toEqual([MATTEO]);
    expect(n.productComment).toEqual({ pageId: signIn.id, rootId: thread!.root.id });
    expect(n.link).toBe(`#/p/ACQ/docs/product/${signIn.code}?comment=${thread!.root.id}`);
  });

  it("chi non legge i Docs di ACQ non si menziona (Sara senza `docs.view`)", async () => {
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    as(LAURA);
    const c = await productDocs.addProductComment(page("Bills").id, {
      anchorId: "blk-acq-bills-6",
      quote: "UTC",
      body: "@Sara Montanari can you confirm?",
    });
    expect(c.mentionIds).toEqual([]);
    expect(mentionsOf(SARA)).toEqual([]);
  });

  it("nessun seguire implicito: Matteo commenta Bills e menziona Sara; chi segue Bills non cambia", async () => {
    const bills = page("Bills");
    const before = productDocs.followersOf(bills.id);
    as(MATTEO);
    await productDocs.addProductComment(bills.id, {
      anchorId: "blk-acq-bills-6",
      quote: "UTC",
      body: "@Sara Montanari is this what the client sees?",
    });
    expect(mentionsOf(SARA)).toHaveLength(1);
    expect(productDocs.followersOf(bills.id)).toEqual(before);
    expect(before).not.toContain(MATTEO);
    expect(before).not.toContain(SARA);
  });

  it("a lettura: la pagina rinominata dà il titolo nuovo; eliminata, la notifica resta e non apre niente", async () => {
    const signIn = page("Sign-in");
    as(LAURA);
    await productDocs.addProductComment(signIn.id, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      body: "@Marco Bellini look",
    });
    await productDocs.renameProductPage(signIn.id, "Signing in");
    as(MARCO);
    let cards = (await listNotifications()).filter((n) => n.kind === "product_doc.mention");
    expect(cards.every((n) => n.productPageTitle === "Signing in")).toBe(true);
    expect(cards.every((n) => n.mentionNames?.includes("Marco Bellini"))).toBe(true);

    as(LAURA);
    await productDocs.deleteProductPage(signIn.id);
    expect(state.productComments.filter((c) => c.pageId === signIn.id)).toEqual([]);
    as(MARCO);
    cards = (await listNotifications()).filter((n) => n.kind === "product_doc.mention");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const n of cards) {
      expect(n.objectGone).toBe(true);
      // Niente codice, titolo, nome né link di una pagina che non c'è (R-G5).
      expect(n.productPageTitle).toBeUndefined();
      expect(n.mentionNames).toBeUndefined();
      expect(n.link).toBe("");
      const text = JSON.stringify(n).toLowerCase();
      expect(text).not.toContain("sign");
      expect(text).not.toContain(signIn.code.toLowerCase());
    }
  });

  it("chi riceve e non legge più i Docs: `objectGone`, senza titolo né codice della pagina", async () => {
    const signIn = page("Sign-in");
    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    as(MARCO);
    const cards = (await listNotifications()).filter((n) => n.kind === "product_doc.mention");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.objectGone).toBe(true);
    const text = JSON.stringify(cards[0]).toLowerCase();
    expect(text).not.toContain("sign-in");
    expect(text).not.toContain(signIn.code.toLowerCase());
  });
});
