import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plain } from "../../domain/productDocs/richText";
import { docs, productDocs, projectSettings, resetApi, setLatency } from "../api";
import type { ProductBlock } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { setSessionPersonId } from "../session";
import { advanceNow, emptyStore, state, visibleProjectIds } from "../store";
import { revokeProjectPermission } from "../viewer";

// Lo spazio Prodotto nel livello dati (area 11a, Task 2): letture, scritture
// delle pagine, chi segue, l'interruttore del modulo Docs e il nome
// riservato. Persone del seme: Laura (Project Lead in ACQ: `docs.edit` e
// `project.settings.manage`), Sara (Contributor in ACQ: `docs.view` senza
// `docs.edit`), Marco (Developer in ACQ: `docs.edit`, non gestisce il
// progetto), Giulia (Project Lead di MKX, che nasce senza il modulo Docs).
// Il seme del Prodotto (Task 3) ha le nove pagine di ACQ: i test che contano
// le pagine di ACQ partono da `seedCount()`.

const LAURA = "p-laura";
const SARA = "p-sara";
const MARCO = "p-marco";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";
const MKX = "prj-mkx";
/** Un progetto in cui Sara non è membro. */
const AUD = "prj-aud";

const as = (personId: string) => setSessionPersonId(personId);
const para = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
});
const snapshot = () =>
  JSON.stringify({
    pages: state.productPages,
    revisions: state.productRevisions,
    follows: state.productFollows,
    ids: [...state.productBlockIds],
    modules: state.projectsById.get(ACQ)!.modules,
  });

/** Le pagine di Prodotto che ACQ ha dal seme. */
const seedCount = (): number => state.productPages.filter((p) => p.projectId === ACQ).length;

async function rejects(p: Promise<unknown>, message: string): Promise<void> {
  const before = snapshot();
  await expect(p).rejects.toThrow(message);
  expect(snapshot()).toBe(before);
}

/** «Features» e, sotto, «Payments», create da Laura in ACQ. */
async function featuresAndPayments() {
  as(LAURA);
  const features = await productDocs.createProductPage(ACQ, { title: "Features" });
  const payments = await productDocs.createProductPage(ACQ, {
    title: "Payments",
    parentId: features.id,
  });
  return { features, payments };
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("creare una pagina", () => {
  it("Laura crea «Payments» sotto «Features»: codice della serie dei Docs, la segue, revisione create senza via né source", async () => {
    const n = state.docCodeSeq.get(ACQ) ?? 0;
    const { features, payments } = await featuresAndPayments();
    expect(features.code).toBe(`ACQ-D${n + 1}`);
    expect(payments.code).toBe(`ACQ-D${n + 2}`);
    expect(state.docCodeSeq.get(ACQ)).toBe(n + 2);
    expect(payments).toMatchObject({
      projectId: ACQ,
      parentId: features.id,
      title: "Payments",
      createdById: LAURA,
      updatedById: LAURA,
    });
    // Un paragrafo vuoto come primo blocco, e il suo id è ricordato.
    expect(payments.blocks).toHaveLength(1);
    expect(payments.blocks[0]).toMatchObject({ type: "paragraph", content: { text: "", marks: [] } });
    expect(state.productBlockIds.has(payments.blocks[0]!.id)).toBe(true);
    expect(state.productFollows).toContainEqual(
      expect.objectContaining({ pageId: payments.id, personId: LAURA }),
    );
    const revisions = await productDocs.listProductRevisions(payments.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "create", actorId: LAURA, actorName: "Laura Costa" });
    expect(revisions[0]).not.toHaveProperty("via");
    expect(revisions[0]).not.toHaveProperty("source");
    const page = (await productDocs.getProductPage(payments.code))!;
    expect(page.following).toBe(true);
    expect(page.breadcrumbs.map((b) => b.title)).toEqual(["Features"]);
  });

  it("un titolo vuoto è invalid: title; un genitore di un altro progetto è not_found", async () => {
    as(LAURA);
    await rejects(productDocs.createProductPage(ACQ, { title: "   " }), "invalid: title");
    const other = await productDocs.createProductPage(AUD, { title: "Elsewhere" });
    await rejects(
      productDocs.createProductPage(ACQ, { title: "X", parentId: other.id }),
      "not_found",
    );
  });

  it("l'indice sceglie il posto fra i fratelli", async () => {
    as(LAURA);
    const roots = state.productPages
      .filter((p) => p.projectId === ACQ && p.parentId === null)
      .sort((x, y) => x.order - y.order)
      .map((p) => p.id);
    const a = await productDocs.createProductPage(ACQ, { title: "A" });
    const b = await productDocs.createProductPage(ACQ, { title: "B" });
    const first = await productDocs.createProductPage(ACQ, { title: "First", index: 0 });
    const space = (await productDocs.getProductSpace(ACQ))!;
    expect(space.tree.map((n) => n.page.id)).toEqual([first.id, ...roots, a.id, b.id]);
  });
});

describe("chi legge senza scrivere", () => {
  it("Sara (Contributor): edit falso, ogni scrittura forbidden e stato invariato; seguire riesce", async () => {
    const base = seedCount();
    const { features, payments } = await featuresAndPayments();
    as(SARA);
    const space = (await productDocs.getProductSpace(ACQ))!;
    expect(space.permissions.edit).toBe(false);
    expect(space.pageCount).toBe(base + 2);
    const page = (await productDocs.getProductPage(payments.code))!;
    expect(page.permissions).toEqual({ edit: false, delete: false, deleteBlocked: null });
    // Con sottopagine: senza docs.edit il bottone è spento per il permesso, non per la regola.
    expect((await productDocs.getProductPage(features.code))!.permissions).toEqual({
      edit: false,
      delete: false,
      deleteBlocked: null,
    });
    const blockId = payments.blocks[0]!.id;

    await rejects(productDocs.createProductPage(ACQ, { title: "Mine" }), "forbidden");
    await rejects(productDocs.renameProductPage(payments.id, "Other"), "forbidden");
    await rejects(
      productDocs.moveProductPage(payments.id, { parentId: null, index: 0 }),
      "forbidden",
    );
    await rejects(productDocs.deleteProductPage(payments.id), "forbidden");
    await rejects(
      productDocs.saveProductBlocks(payments.id, [{ op: "set", block: para(blockId, "x") }], {
        sessionId: "s-sara",
      }),
      "forbidden",
    );
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({
      ok: false,
      error: "forbidden",
    });

    await productDocs.followProductPage(features.id);
    expect((await productDocs.getProductPage(features.code))!.following).toBe(true);
    await productDocs.unfollowProductPage(features.id);
    expect((await productDocs.getProductPage(features.code))!.following).toBe(false);
  });
});

describe("nascosto e inesistente sono identici (R-G5)", () => {
  it("invisibile, inesistente o col modulo spento: null e not_found; visibile senza docs.view: forbidden", async () => {
    as(LAURA);
    const hidden = await productDocs.createProductPage(AUD, { title: "Secret roadmap" });
    as(GIULIA);
    // MKX nasce senza il modulo Docs.
    expect(state.projectsById.get(MKX)!.modules).not.toContain("docs");
    as(SARA);
    for (const projectId of [AUD, "prj-nope"]) {
      expect(await productDocs.getProductSpace(projectId)).toBeNull();
      await rejects(productDocs.createProductPage(projectId, { title: "X" }), "not_found");
    }
    expect(await productDocs.getProductPage(hidden.code)).toBeNull();
    expect(await productDocs.getProductPage("AUD-D999")).toBeNull();
    expect(await productDocs.listProductRevisions(hidden.id)).toEqual([]);
    await rejects(productDocs.followProductPage(hidden.id), "not_found");
    await rejects(productDocs.followProductPage("pdoc-nope"), "not_found");
    await rejects(productDocs.renameProductPage(hidden.id, "X"), "not_found");
    expect(productDocs.readableProductPages(SARA).map((p) => p.code)).not.toContain(hidden.code);

    as(GIULIA);
    expect(await productDocs.getProductSpace(MKX)).toBeNull();
    await rejects(productDocs.createProductPage(MKX, { title: "X" }), "not_found");

    // Visibile senza docs.view.
    as(LAURA);
    const acq = await productDocs.createProductPage(ACQ, { title: "Visible" });
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    as(SARA);
    await expect(productDocs.getProductSpace(ACQ)).rejects.toThrow("forbidden");
    await expect(productDocs.getProductPage(acq.code)).rejects.toThrow("forbidden");
    // Un codice che non c'è in quel progetto dice lo stesso: nessuna prova d'esistenza.
    await expect(productDocs.getProductPage("ACQ-D999")).rejects.toThrow("forbidden");
    await rejects(productDocs.followProductPage(acq.id), "forbidden");
    expect(productDocs.readableProductPages(SARA)).toEqual([]);
  });

  it("le decisioni citate di un progetto che chi legge non vede sono null", async () => {
    const { payments } = await featuresAndPayments();
    const mine = state.decisionLog.find((d) => d.projectId === ACQ) ?? state.decisionLog[0]!;
    const hidden = state.decisionLog.find((d) => d.projectId === AUD)!;
    await productDocs.saveProductBlocks(
      payments.id,
      [
        { op: "insert", afterId: payments.blocks[0]!.id, block: { id: "b-dec-1", type: "decision", decisionId: hidden.id } },
        { op: "insert", afterId: "b-dec-1", block: { id: "b-dec-2", type: "decision", decisionId: mine.id } },
      ],
      { sessionId: "s-laura" },
    );
    as(SARA);
    const page = (await productDocs.getProductPage(payments.code))!;
    expect(page.decisions[hidden.id]).toBeNull();
    expect(JSON.stringify(page).toLowerCase()).not.toContain(hidden.title.toLowerCase());
    as(LAURA);
    const forLaura = (await productDocs.getProductPage(payments.code))!;
    expect(forLaura.decisions[hidden.id]).toMatchObject({ title: hidden.title, decidedAt: hidden.decidedAt });
    expect(page.openComments).toBe(0);
  });
});

describe("i blocchi", () => {
  it("un insert con l'id di un blocco eliminato, anche di un'altra pagina, è block_id_taken", async () => {
    const { features, payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: first, block: para("b-gone", "Soon deleted") }],
      { sessionId: "s1" },
    );
    await productDocs.saveProductBlocks(payments.id, [{ op: "delete", blockId: "b-gone" }], {
      sessionId: "s1",
    });
    await rejects(
      productDocs.saveProductBlocks(
        payments.id,
        [{ op: "insert", afterId: first, block: para("b-gone", "Back") }],
        { sessionId: "s1" },
      ),
      "invalid: block_id_taken",
    );
    await rejects(
      productDocs.saveProductBlocks(
        features.id,
        [{ op: "insert", afterId: null, block: para("b-gone", "Elsewhere") }],
        { sessionId: "s1" },
      ),
      "invalid: block_id_taken",
    );
    // Il primo paragrafo di un'altra pagina, mai passato da una scrittura di blocchi.
    await rejects(
      productDocs.saveProductBlocks(
        features.id,
        [{ op: "insert", afterId: null, block: para(first, "Copy") }],
        { sessionId: "s1" },
      ),
      "invalid: block_id_taken",
    );
    // Una cella nuova con un id già dato.
    await rejects(
      productDocs.saveProductBlocks(
        features.id,
        [
          {
            op: "insert",
            afterId: null,
            block: {
              id: "b-table",
              type: "table",
              rows: [{ id: "r-1", cells: [{ id: "b-gone", content: plain("cell") }] }],
            },
          },
        ],
        { sessionId: "s1" },
      ),
      "invalid: block_id_taken",
    );
  });

  // Ruling del controller (5 nov 2026): ⌘Z di un'eliminazione nella stessa
  // sessione dell'editor rimette il blocco con lo STESSO id, così i suoi
  // commenti tornano. È un'eccezione stretta: solo con `undoOf`, solo la
  // sessione (e la persona) che ha tolto quell'id, solo su quella pagina.
  it("⌘Z: lo stesso id torna solo con undoOf, dalla sessione e dalla persona che l'ha tolto", async () => {
    const { features, payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: first, block: para("b-undo", "Soon deleted") }],
      { sessionId: "s-laura" },
    );
    const written = await productDocs.saveProductBlocks(payments.id, [{ op: "delete", blockId: "b-undo" }], {
      sessionId: "s-laura",
    });
    // Inserito e tolto nella stessa sessione: l'unione torna com'era e la
    // revisione sparisce, ma la scrittura ne dice comunque l'id.
    expect(written.revisionId).toEqual(expect.any(String));
    const back = [{ op: "insert" as const, afterId: first, block: para("b-undo", "Soon deleted") }];
    // Senza undoOf, da un'altra sessione, da un'altra persona, su un'altra pagina: no.
    await rejects(productDocs.saveProductBlocks(payments.id, back, { sessionId: "s-laura" }), "invalid: block_id_taken");
    await rejects(
      productDocs.saveProductBlocks(payments.id, back, { sessionId: "s-other", undoOf: written.revisionId! }),
      "invalid: block_id_taken",
    );
    await rejects(
      productDocs.saveProductBlocks(
        features.id,
        [{ op: "insert", afterId: null, block: para("b-undo", "Elsewhere") }],
        { sessionId: "s-laura", undoOf: written.revisionId! },
      ),
      "invalid: block_id_taken",
    );
    as(MARCO);
    await rejects(
      productDocs.saveProductBlocks(payments.id, back, { sessionId: "s-laura", undoOf: written.revisionId! }),
      "invalid: block_id_taken",
    );
    as(LAURA);
    const restored = await productDocs.saveProductBlocks(payments.id, back, {
      sessionId: "s-laura",
      undoOf: written.revisionId!,
    });
    expect(restored.blocks.map((b) => b.id)).toContain("b-undo");
    // Una scrittura con undoOf lascia la sua revisione (non si unisce).
    const revisions = await productDocs.listProductRevisions(payments.id);
    expect(revisions[0]!.undoOf).toBe(written.revisionId);
    expect(revisions[0]!.sessionId).toBe("s-laura");
  });

  it("⌘Z di un merge: il blocco assorbito torna col suo id (anche la memoria vale per il merge)", async () => {
    const { payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: first, block: para("b-second", "two") }],
      { sessionId: "s-m" },
    );
    const before = (await productDocs.getProductPage(payments.code))!.blocks.find((b) => b.id === first)!;
    const merged = await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "merge", firstId: first, secondId: "b-second" }],
      { sessionId: "s-m" },
    );
    const back = await productDocs.saveProductBlocks(
      payments.id,
      [
        { op: "set", block: before },
        { op: "insert", afterId: first, block: para("b-second", "two") },
      ],
      { sessionId: "s-m", undoOf: merged.revisionId! },
    );
    expect(back.blocks.map((b) => b.id).slice(0, 2)).toEqual([first, "b-second"]);
  });

  it("un link javascript: o un segno oltre la fine del testo: invalid: marks, pagina invariata", async () => {
    const { payments } = await featuresAndPayments();
    const id = payments.blocks[0]!.id;
    const bad: ProductBlock[] = [
      {
        id,
        type: "paragraph",
        content: { text: "Click", marks: [{ type: "link", start: 0, end: 5, href: "javascript:alert(1)" }] },
      },
      {
        id,
        type: "paragraph",
        content: { text: "Click", marks: [{ type: "link", start: 0, end: 5, href: "/relative" }] },
      },
      { id, type: "paragraph", content: { text: "Bold", marks: [{ type: "bold", start: 0, end: 9 }] } },
      { id, type: "paragraph", content: { text: "Bold", marks: [{ type: "bold", start: 2, end: 2 }] } },
    ];
    for (const block of bad)
      await rejects(
        productDocs.saveProductBlocks(payments.id, [{ op: "set", block }], { sessionId: "s1" }),
        "invalid: marks",
      );
    // Anche in una cella di tabella, e per la forma sincrona.
    expect(() =>
      productDocs.writeProductBlocksAs(LAURA, payments.id, [
        {
          op: "insert",
          afterId: id,
          block: {
            id: "b-t",
            type: "table",
            rows: [
              {
                id: "r-t",
                cells: [
                  {
                    id: "c-t",
                    content: { text: "x", marks: [{ type: "link", start: 0, end: 1, href: "file:///etc/passwd" }] },
                  },
                ],
              },
            ],
          },
        },
      ], {}),
    ).toThrow("invalid: marks");
    // Un https è un link valido.
    await productDocs.saveProductBlocks(
      payments.id,
      [
        {
          op: "set",
          block: {
            id,
            type: "paragraph",
            content: { text: "Docs", marks: [{ type: "link", start: 0, end: 4, href: "https://stubwise.dev" }] },
          },
        },
      ],
      { sessionId: "s1" },
    );
  });

  it("un'immagine è solo un data:image PNG, JPEG, GIF o WebP fino a 5 MB: altrimenti invalid: image (Task 9)", async () => {
    const { payments } = await featuresAndPayments();
    const id = payments.blocks[0]!.id;
    const image = (src: string): ProductBlock => ({ id: "b-img", type: "image", src, caption: "", alt: "" });
    const bad = [
      "https://example.com/a.png",
      "file:///tmp/a.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:text/html;base64,PGgxPg==",
      `data:image/png;base64,${"A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8)}`,
    ];
    for (const src of bad)
      expect(() =>
        productDocs.writeProductBlocksAs(LAURA, payments.id, [{ op: "insert", afterId: id, block: image(src) }], {}),
      ).toThrow("invalid: image");
    const page = productDocs.writeProductBlocksAs(
      LAURA,
      payments.id,
      [{ op: "insert", afterId: id, block: image("data:image/png;base64,iVBORw0KGgo=") }],
      {},
    );
    expect(page.blocks.some((b) => b.id === "b-img")).toBe(true);
  });

  // Revisione finale F4: i riferimenti si validano nel livello dati, non nel
  // selettore della UI (nel 11b scrive anche Claude con writeProductBlocksAs).
  it("un file del Drive col codice sbagliato, inesistente o di un progetto che chi scrive non vede: invalid: drive", async () => {
    const { payments } = await featuresAndPayments();
    const id = payments.blocks[0]!.id;
    const drive = (fileId: string, code: string): ProductBlock => ({ id: "b-drv", type: "drive", fileId, code });
    await rejects(
      productDocs.saveProductBlocks(payments.id, [{ op: "insert", afterId: id, block: drive("drv-acq-1", "ACQ-F99") }], {
        sessionId: "s1",
      }),
      "invalid: drive",
    );
    await rejects(
      productDocs.saveProductBlocks(payments.id, [{ op: "insert", afterId: id, block: drive("drv-nope", "ACQ-F1") }], {
        sessionId: "s1",
      }),
      "invalid: drive",
    );
    // Marco scrive in ACQ ma non vede MKX.
    as(MARCO);
    await rejects(
      productDocs.saveProductBlocks(payments.id, [{ op: "insert", afterId: id, block: drive("drv-mkx-1", "MKX-F1") }], {
        sessionId: "s-marco",
      }),
      "invalid: drive",
    );
    // Il file vero, col suo codice: sì.
    const ok = await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: id, block: drive("drv-acq-1", "ACQ-F1") }],
      { sessionId: "s-marco" },
    );
    expect(ok.blocks.some((b) => b.id === "b-drv")).toBe(true);
  });

  it("una decisione inesistente o di un progetto che chi scrive non vede: invalid: decision", async () => {
    const { payments } = await featuresAndPayments();
    const id = payments.blocks[0]!.id;
    const decision = (decisionId: string): ProductBlock => ({ id: "b-dec", type: "decision", decisionId });
    await rejects(
      productDocs.saveProductBlocks(payments.id, [{ op: "insert", afterId: id, block: decision("dl-nope") }], {
        sessionId: "s1",
      }),
      "invalid: decision",
    );
    // Marco scrive in ACQ; una decisione di un progetto che non vede.
    const unseen = state.decisionLog.find((d) => !visibleProjectIds(MARCO).has(d.projectId))!;
    expect(unseen).toBeDefined();
    expect(() =>
      productDocs.writeProductBlocksAs(MARCO, payments.id, [{ op: "insert", afterId: id, block: decision(unseen.id) }], {}),
    ).toThrow("invalid: decision");
  });

  it("un blocco invariato con un file poi nascosto non blocca la modifica di un paragrafo", async () => {
    const { payments } = await featuresAndPayments();
    const id = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: id, block: { id: "b-drv", type: "drive", fileId: "drv-acq-1", code: "ACQ-F1" } }],
      { sessionId: "s1" },
    );
    state.driveFiles.find((f) => f.id === "drv-acq-1")!.hidden = true;
    as(MARCO);
    const page = await productDocs.saveProductBlocks(payments.id, [{ op: "set", block: para(id, "Edited") }], {
      sessionId: "s-marco",
    });
    expect(page.blocks.some((b) => b.id === "b-drv")).toBe(true);
  });

  it("un merge chiama gli spostamenti d'ancora registrati, dentro la stessa scrittura", async () => {
    const { payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [
        { op: "set", block: para(first, "Hello ") },
        { op: "insert", afterId: first, block: para("b-second", "world") },
      ],
      { sessionId: "s1" },
    );
    const seen: unknown[] = [];
    const stop = productDocs.onAnchorsMerged((pageId, from, to, offset) => {
      // Dentro la scrittura: il blocco unito c'è già.
      const page = state.productPages.find((p) => p.id === pageId)!;
      seen.push({ pageId, from, to, offset, blocks: page.blocks.length });
    });
    productDocs.writeProductBlocksAs(LAURA, payments.id, [
      { op: "merge", firstId: first, secondId: "b-second" },
    ], { sessionId: "s1" });
    stop();
    expect(seen).toEqual([{ pageId: payments.id, from: "b-second", to: first, offset: 6, blocks: 1 }]);
    // Un delete + set scritti a mano non sono un'unione.
    const again: unknown[] = [];
    const stop2 = productDocs.onAnchorsMerged((...args) => again.push(args));
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: first, block: para("b-third", "!") }],
      { sessionId: "s1" },
    );
    await productDocs.saveProductBlocks(
      payments.id,
      [
        { op: "delete", blockId: "b-third" },
        { op: "set", block: para(first, "Hello world!") },
      ],
      { sessionId: "s1" },
    );
    stop2();
    expect(again).toEqual([]);
  });
});

describe("chi tiene ancore e lancia", () => {
  it("un ascoltatore che lancia non fa fallire una scrittura già fatta; gli altri lo sentono", async () => {
    const { payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [
        { op: "set", block: para(first, "Hello ") },
        { op: "insert", afterId: first, block: para("b-second", "world") },
      ],
      { sessionId: "s1" },
    );
    const heard: string[] = [];
    const stopBad = productDocs.onAnchorsMerged(() => {
      throw new Error("listener broke");
    });
    const stopGood = productDocs.onAnchorsMerged((_p, from) => heard.push(from));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const page = await productDocs.saveProductBlocks(
        payments.id,
        [{ op: "merge", firstId: first, secondId: "b-second" }],
        { sessionId: "s1" },
      );
      expect(page.blocks).toEqual([para(first, "Hello world")]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      stopBad();
      stopGood();
      logged.mockRestore();
    }
    expect(heard).toEqual(["b-second"]);
    expect(state.productPages.find((p) => p.id === payments.id)!.blocks).toHaveLength(1);
  });
});

describe("rinominare, spostare, eliminare", () => {
  it("rinominare scrive una revisione rename; un titolo vuoto è invalid: title", async () => {
    const { payments } = await featuresAndPayments();
    const renamed = await productDocs.renameProductPage(payments.id, "  Payments & refunds ");
    expect(renamed.title).toBe("Payments & refunds");
    const [last] = await productDocs.listProductRevisions(payments.id);
    expect(last).toMatchObject({
      kind: "rename",
      actorId: LAURA,
      title: { before: "Payments", after: "Payments & refunds" },
    });
    await rejects(productDocs.renameProductPage(payments.id, " "), "invalid: title");
  });

  it("sotto un proprio discendente: invalid: cycle; con sottopagine non si elimina, e la vista lo dice", async () => {
    const { features, payments } = await featuresAndPayments();
    await rejects(
      productDocs.moveProductPage(features.id, { parentId: payments.id, index: 0 }),
      "invalid: cycle",
    );
    await rejects(
      productDocs.moveProductPage(features.id, { parentId: features.id, index: 0 }),
      "invalid: cycle",
    );
    await rejects(productDocs.deleteProductPage(features.id), "invalid: has_children");
    const view = (await productDocs.getProductPage(features.code))!;
    expect(view.permissions).toEqual({ edit: true, delete: false, deleteBlocked: "has_children" });
    expect((await productDocs.getProductPage(payments.code))!.permissions).toEqual({
      edit: true,
      delete: true,
      deleteBlocked: null,
    });
  });

  it("spostare sotto un altro genitore scrive move; riordinare fra fratelli no", async () => {
    const { features, payments } = await featuresAndPayments();
    const other = await productDocs.createProductPage(ACQ, { title: "Other" });
    const sibling = await productDocs.createProductPage(ACQ, {
      title: "Refunds",
      parentId: features.id,
    });
    const count = () => state.productRevisions.length;
    const before = count();
    await productDocs.moveProductPage(sibling.id, { parentId: features.id, index: 0 });
    expect(count()).toBe(before);
    const space = (await productDocs.getProductSpace(ACQ))!;
    const featuresNode = space.tree.find((n) => n.page.id === features.id)!;
    expect(featuresNode.children.map((c) => c.page.id)).toEqual([sibling.id, payments.id]);

    const moved = await productDocs.moveProductPage(payments.id, { parentId: other.id, index: 0 });
    expect(moved.parentId).toBe(other.id);
    const [last] = await productDocs.listProductRevisions(payments.id);
    expect(last).toMatchObject({
      kind: "move",
      parent: { beforeId: features.id, afterId: other.id },
    });
    // Un genitore di un altro progetto non esiste per chi sposta.
    const aud = await productDocs.createProductPage(AUD, { title: "AUD page" });
    await rejects(
      productDocs.moveProductPage(payments.id, { parentId: aud.id, index: 0 }),
      "not_found",
    );
  });

  it("eliminare toglie pagina, revisioni e chi segue; il codice non si riusa", async () => {
    const { payments } = await featuresAndPayments();
    as(SARA);
    await productDocs.followProductPage(payments.id);
    as(LAURA);
    await productDocs.deleteProductPage(payments.id);
    expect(state.productPages.some((p) => p.id === payments.id)).toBe(false);
    expect(state.productRevisions.some((r) => r.pageId === payments.id)).toBe(false);
    expect(state.productFollows.some((f) => f.pageId === payments.id)).toBe(false);
    expect(await productDocs.getProductPage(payments.code)).toBeNull();
    const next = await productDocs.createProductPage(ACQ, { title: "Next" });
    expect(next.code).not.toBe(payments.code);
    // Gli id dei blocchi della pagina tolta restano dati.
    expect(state.productBlockIds.has(payments.blocks[0]!.id)).toBe(true);
  });
});

describe("chi segue", () => {
  it("followersOf: chi ha perso docs.view non c'è più, senza scrivere righe", async () => {
    const { payments } = await featuresAndPayments();
    as(SARA);
    await productDocs.followProductPage(payments.id);
    expect(productDocs.followersOf(payments.id).sort()).toEqual([LAURA, SARA].sort());
    const rows = JSON.stringify(state.productFollows);
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    expect(productDocs.followersOf(payments.id)).toEqual([LAURA]);
    expect(JSON.stringify(state.productFollows)).toBe(rows);
  });

  it("productDocRecipients: chi segue; senza seguaci chi ha docs.edit in ACQ, mai Claude", async () => {
    const { payments } = await featuresAndPayments();
    expect(productDocs.productDocRecipients(payments.id)).toEqual([LAURA]);
    await productDocs.unfollowProductPage(payments.id);
    expect(productDocs.followersOf(payments.id)).toEqual([]);
    const recipients = productDocs.productDocRecipients(payments.id);
    // Chi legge i Docs di ACQ e li scrive: i membri con docs.edit e Roberta
    // (full admin, membro implicito). Sara (Contributor) e Claude no.
    expect([...recipients].sort()).toEqual(
      ["p-davide", "p-federico", LAURA, MARCO, "p-matteo", "p-roberta"].sort(),
    );
    expect(recipients).not.toContain(SARA);
    expect(recipients).not.toContain(CLAUDE_ID);
  });

  it("commentare o essere menzionati non fa seguire: segue solo chi crea e chi preme Follow", async () => {
    const { payments } = await featuresAndPayments();
    as(MARCO);
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "set", block: para(payments.blocks[0]!.id, "Marco was here") }],
      { sessionId: "s-marco" },
    );
    expect(productDocs.followersOf(payments.id)).toEqual([LAURA]);
  });
});

describe("il modulo Docs", () => {
  it("Giulia lo accende in MKX: lo spazio Prodotto risponde vuoto, con una voce del registro", async () => {
    as(GIULIA);
    expect(await projectSettings.setDocsModule(MKX, true)).toEqual({ ok: true });
    expect(state.projectsById.get(MKX)!.modules).toContain("docs");
    const space = (await productDocs.getProductSpace(MKX))!;
    expect(space).toMatchObject({ projectId: MKX, projectCode: "MKX", tree: [], pageCount: 0, recent: [] });
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "project.docs_toggled",
      actorId: GIULIA,
      projectId: MKX,
      before: "off",
      after: "on",
    });
    expect((await projectSettings.getProjectSettings(MKX))!.docsModule).toBe(true);
    // Già acceso: nessuna voce nuova.
    const entries = state.changelog.length;
    expect(await projectSettings.setDocsModule(MKX, true)).toEqual({ ok: true });
    expect(state.changelog.length).toBe(entries);
  });

  it("Marco in ACQ: forbidden; spento e riacceso da Laura, le pagine ci sono", async () => {
    const base = seedCount();
    const { payments } = await featuresAndPayments();
    as(MARCO);
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({
      ok: false,
      error: "forbidden",
    });
    as(LAURA);
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({ ok: true });
    expect(await productDocs.getProductSpace(ACQ)).toBeNull();
    expect(await productDocs.getProductPage(payments.code)).toBeNull();
    expect(await docs.getProjectDocsHome(ACQ)).toBeNull();
    expect(productDocs.followersOf(payments.id)).toEqual([]);
    expect(seedCount()).toBe(base + 2);
    expect(await projectSettings.setDocsModule(ACQ, true)).toEqual({ ok: true });
    expect((await productDocs.getProductSpace(ACQ))!.pageCount).toBe(base + 2);
    expect(state.projectsById.get(ACQ)!.modules).toEqual(["docs", "releases", "support", "servers"]);
  });
});

describe("la pagina iniziale dei Docs", () => {
  it("ACQ: product con pageCount, updatedAt e canEdit", async () => {
    const base = seedCount();
    await featuresAndPayments();
    const home = (await docs.getProjectDocsHome(ACQ))!;
    expect(home.product).toEqual({
      pageCount: base + 2,
      // «Payments» è l'ultima scritta: la più recente.
      updatedAt: state.productPages.at(-1)!.updatedAt,
      canEdit: true,
    });
    as(SARA);
    expect((await docs.getProjectDocsHome(ACQ))!.product).toMatchObject({ canEdit: false });
  });

  // Revisione finale F5: «Updated … by …» di recenti, indice e Docs dice
  // l'ultima revisione, come la meta della pagina; uno spostamento di soli
  // blocchi non è una revisione.
  it("uno spostamento di soli blocchi non cambia l'ultimo autore né la data; una modifica vera sì", async () => {
    const { payments } = await featuresAndPayments();
    const first = payments.blocks[0]!.id;
    await productDocs.saveProductBlocks(
      payments.id,
      [{ op: "insert", afterId: first, block: para("b-two", "Two") }],
      { sessionId: "s-laura" },
    );
    const recentOf = async () =>
      (await productDocs.getProductSpace(ACQ))!.recent.find((r) => r.id === payments.id)!;
    const before = await recentOf();
    const homeBefore = (await docs.getProjectDocsHome(ACQ))!.product!.updatedAt;
    expect(before.updatedById).toBe(LAURA);
    advanceNow(60_000);
    as(MARCO);
    await productDocs.saveProductBlocks(payments.id, [{ op: "move", blockId: "b-two", afterId: null }], {
      sessionId: "s-marco",
    });
    expect(await recentOf()).toMatchObject({ updatedById: LAURA, updatedAt: before.updatedAt });
    expect((await docs.getProjectDocsHome(ACQ))!.product!.updatedAt).toBe(homeBefore);
    // L'indice (l'albero) dice lo stesso.
    const flat = JSON.stringify((await productDocs.getProductSpace(ACQ))!.tree);
    expect(flat).toContain(`"code":"${payments.code}","projectId":"${ACQ}","parentId":"${payments.parentId}"`);
    const node = flat.slice(flat.indexOf(`"id":"${payments.id}"`));
    expect(node.slice(0, node.indexOf("}"))).toContain(`"updatedById":"${LAURA}"`);
    // Una modifica vera di Marco: sì.
    await productDocs.saveProductBlocks(payments.id, [{ op: "set", block: para("b-two", "Two, edited") }], {
      sessionId: "s-marco",
    });
    const after = await recentOf();
    expect(after.updatedById).toBe(MARCO);
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect((await docs.getProjectDocsHome(ACQ))!.product!.updatedAt).toBe(after.updatedAt);
  });
});

describe("il nome riservato", () => {
  it("un repository chiamato «product» o «Product»: invalid: name_reserved", async () => {
    as(LAURA);
    await projectSettings.checkRepositoryAccess({
      projectId: ACQ,
      gitAccountId: "git-bitbucket-audin",
      fullName: "audin/fatture-api",
      branch: "main",
    });
    for (const name of ["product", "Product"])
      expect(
        await projectSettings.createRepository(ACQ, {
          gitAccountId: "git-bitbucket-audin",
          fullName: "audin/fatture-api",
          name,
          branch: "main",
          installCommand: null,
          testCommand: null,
        }),
      ).toEqual({ ok: false, error: "invalid", reason: "name_reserved" });
    expect(await projectSettings.updateRepository("repo-acq", { name: "PRODUCT" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "name_reserved",
    });
  });
});

describe("l'istanza vuota", () => {
  it("emptyStore(): nessuna pagina, revisione, seguace, id ricordato", async () => {
    await featuresAndPayments();
    emptyStore();
    expect(state.productPages).toEqual([]);
    expect(state.productRevisions).toEqual([]);
    expect(state.productFollows).toEqual([]);
    expect(state.productBlockIds.size).toBe(0);
  });
});
