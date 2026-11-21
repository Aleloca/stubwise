import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../api";
import type { ProductBlock, RichText } from "../model";
import { PRODUCT_WIREFRAMES } from "../seed/productDocs/wireframes";
import { setSessionPersonId } from "../session";
import { setStreamLatency, state } from "../store";
import { undoProductChangeAs } from "./markGestures";
import { listProductMarksAs } from "./marks";
import { subscribeProductPage } from "./events";
import {
  drawWireframeAs,
  failNextSketch,
  holdSketches,
  keepWireframeAs,
  pickWireframe,
  redrawWireframeAs,
  replaceWireframeWithImageAs,
  whenSketchesIdle,
} from "./wireframes";
import { writeProductBlocksAs } from "./writes";

// Le bozze di schermata di Claude (11b, Task 7; shape product-claude-backlog.md
// §3.5–3.7): un blocco `wireframe` col disegno del seme (`PRODUCT_WIREFRAMES`,
// SVG in bianco e nero). Claude disegna e rifà per conto di chi chiede
// (`via: "claude"`), scegliendo il disegno dalle parole della pagina; «Tieni»
// toglie l'etichetta «Bozza di Claude» (maintainer, 6 nov 2026), con una
// revisione della persona che si annulla dalla cronologia; «Rifai» la rimette.
// Pagine: Bills e Sign-in di ACQ (seme 11a). Laura (Project Lead) e Marco
// (Developer) scrivono i Docs di ACQ; Sara (Contributor) legge soltanto.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const BILLS = "pp-acq-bills";
const SIGN_IN = "pp-acq-sign-in";

type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

const plain = (text: string): RichText => ({ text, marks: [] });
const page = (id: string) => state.productPages.find((p) => p.id === id)!;
const blockOf = (pageId: string, id: string) => page(pageId).blocks.find((b) => b.id === id);
const sketch = (pageId: string, id: string) => blockOf(pageId, id) as Wireframe;
const revisionsOf = (pageId: string) =>
  state.productRevisions.filter((r) => r.pageId === pageId).sort((a, b) => a.lastSeq - b.lastSeq);
const last = (pageId: string) => revisionsOf(pageId).at(-1)!;

beforeEach(() => {
  resetApi();
  setLatency(0);
  setSessionPersonId(LAURA);
});
afterEach(() => resetApi());

describe("PRODUCT_WIREFRAMES (seme)", () => {
  it("ogni disegno ha parole chiave e almeno due varianti, SVG in bianco e nero: solo `currentColor`", () => {
    const entries = Object.entries(PRODUCT_WIREFRAMES);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [id, w] of entries) {
      expect(w.keywords.length, id).toBeGreaterThan(0);
      expect(w.variants.length, id).toBeGreaterThanOrEqual(2);
      for (const svg of w.variants) {
        expect(svg.startsWith("<svg"), id).toBe(true);
        expect(svg).toContain('stroke="currentColor"');
        // Nessun colore letterale, nessuna immagine o fotografia.
        expect(svg, id).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|<image|<text/i);
        for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g))
          expect(["none", "currentColor"], `${id}: ${m[0]}`).toContain(m[1]);
      }
    }
  });

  it("la scelta legge le parole: il blocco vicino prima, poi la pagina; senza parole, lo schizzo generico", () => {
    const near: ProductBlock = { id: "n", type: "paragraph", content: plain("Booking screen: the user picks a class, a time and pays.") };
    const bills: ProductBlock = { id: "b", type: "paragraph", content: plain("Customers download their bills as PDF.") };
    expect(pickWireframe([bills, near], "n", "Bills")).toBe("booking");
    expect(pickWireframe([bills, near], "b", "Bills")).toBe("bills");
    expect(pickWireframe([bills], null, "Anything")).toBe("bills");
    expect(pickWireframe([{ id: "x", type: "paragraph", content: plain("Hello") }], "x", "Notes")).toBe("screen");
  });
});

describe("disegnare", () => {
  it("«Disegna questa schermata» dopo un blocco: per conto di Laura, variante 0, senza etichetta tenuta e senza segno (P16)", () => {
    const after = page(BILLS).blocks[0]!.id;
    const marks = state.productMarks.length;
    const { blockId } = drawWireframeAs(LAURA, BILLS, { afterId: after });
    const blocks = page(BILLS).blocks;
    expect(blocks[1]).toEqual({ id: blockId, type: "wireframe", wireframeId: "bills", variant: 0 });
    expect(last(BILLS)).toMatchObject({ actorId: LAURA, via: "claude", kind: "edit" });
    expect(last(BILLS).changes.map((c) => [c.blockId, c.before, c.anchors])).toEqual([[blockId, null, [blockId]]]);
    // La bozza ha la sua etichetta, non il segno a margine (P16).
    expect(state.productMarks).toHaveLength(marks);
    expect(listProductMarksAs(LAURA, BILLS).some((m) => m.blockId === blockId)).toBe(false);
  });

  it("P16: nemmeno una modifica di Claude CON fonte che porta una bozza lascia un segno (la riga non nasce, e il segno non si vede)", () => {
    const task = state.tasks.find((t) => t.projectId === "prj-acq")!;
    const marks = state.productMarks.length;
    const block: ProductBlock = { id: "blk-t7-sourced", type: "wireframe", wireframeId: "bills", variant: 0 };
    const out = writeProductBlocksAs(LAURA, BILLS, [{ op: "insert", afterId: null, block }], {
      via: "claude",
      source: { kind: "task", id: task.id },
    });
    expect(out.revisionId).not.toBeNull();
    expect(state.productMarks).toHaveLength(marks);
    expect(listProductMarksAs(LAURA, BILLS).map((m) => m.blockId)).not.toContain("blk-t7-sourced");
  });

  it("dal «/»: al posto del paragrafo vuoto (stesso id); un paragrafo con del testo non si sostituisce", () => {
    const empty: ProductBlock = { id: "blk-t7-empty", type: "paragraph", content: plain("/sketch") };
    writeProductBlocksAs(LAURA, SIGN_IN, [{ op: "insert", afterId: page(SIGN_IN).blocks[0]!.id, block: empty }], {});
    const { blockId } = drawWireframeAs(LAURA, SIGN_IN, { replaceId: "blk-t7-empty" });
    expect(blockId).toBe("blk-t7-empty");
    expect(sketch(SIGN_IN, blockId)).toMatchObject({ type: "wireframe", wireframeId: "sign-in", variant: 0 });
    const full = page(SIGN_IN).blocks.find((b) => b.type === "paragraph" && b.content.text.trim() !== "" && !b.content.text.startsWith("/"))!;
    const before = revisionsOf(SIGN_IN).length;
    expect(() => drawWireframeAs(LAURA, SIGN_IN, { replaceId: full.id })).toThrow("invalid: replace");
    expect(revisionsOf(SIGN_IN)).toHaveLength(before);
  });

  it("`afterId: null` la mette in cima, come un `insert` (in fondo: chi chiama passa l'ultimo blocco)", () => {
    const { blockId } = drawWireframeAs(LAURA, BILLS, { afterId: null });
    expect(page(BILLS).blocks[0]!.id).toBe(blockId);
  });

  it("Sara (legge soltanto): `forbidden`; col budget del mese finito: `ai_blocked`; niente scritto", () => {
    const before = JSON.stringify(page(BILLS).blocks);
    expect(() => drawWireframeAs(SARA, BILLS, { afterId: null })).toThrow("forbidden");
    state.instance.simulate.budgetReached = true;
    expect(() => drawWireframeAs(LAURA, BILLS, { afterId: null })).toThrow("ai_blocked");
    expect(JSON.stringify(page(BILLS).blocks)).toBe(before);
  });

  it("dal cancello: `productDocs.drawWireframe` come chi è in sessione", async () => {
    const { blockId } = await productDocs.drawWireframe(BILLS, { afterId: null });
    expect(sketch(BILLS, blockId).type).toBe("wireframe");
  });
});

describe("«Rifai», «Tieni» e la cronologia", () => {
  /** Una bozza disegnata e pronta (F6: il disegno finisce dopo la pausa). */
  const drawn = async () => {
    const { blockId } = drawWireframeAs(LAURA, BILLS, { afterId: page(BILLS).blocks[0]!.id });
    await whenSketchesIdle();
    return blockId;
  };

  it("«Rifai» dà la variante seguente (e poi ricomincia), sul posto, con una revisione di Claude per conto di chi chiede", async () => {
    const id = await drawn();
    const variants = PRODUCT_WIREFRAMES.bills!.variants.length;
    const count = revisionsOf(BILLS).length;
    redrawWireframeAs(MARCO, BILLS, id);
    await whenSketchesIdle();
    expect(sketch(BILLS, id).variant).toBe(1);
    expect(revisionsOf(BILLS)).toHaveLength(count + 1);
    expect(last(BILLS)).toMatchObject({ actorId: MARCO, via: "claude", kind: "edit" });
    expect(last(BILLS).changes[0]!.anchors).toEqual([id]);
    for (let i = 1; i < variants; i++) {
      redrawWireframeAs(MARCO, BILLS, id);
      await whenSketchesIdle();
    }
    expect(sketch(BILLS, id).variant).toBe(0);
  });

  it("«Tieni»: toglie l'etichetta (`kept: true`) con una revisione della persona; il secondo clic non scrive", async () => {
    const id = await drawn();
    const { revisionId } = keepWireframeAs(LAURA, BILLS, id);
    expect(sketch(BILLS, id).kept).toBe(true);
    const r = state.productRevisions.find((x) => x.id === revisionId)!;
    expect(r).toMatchObject({ actorId: LAURA, kind: "edit" });
    expect(r.via).toBeUndefined();
    const count = revisionsOf(BILLS).length;
    expect(keepWireframeAs(LAURA, BILLS, id)).toEqual({ revisionId: null });
    expect(revisionsOf(BILLS)).toHaveLength(count);
  });

  it("«Tieni» di Sara: `forbidden`, l'etichetta resta", async () => {
    const id = await drawn();
    expect(() => keepWireframeAs(SARA, BILLS, id)).toThrow("forbidden");
    expect(sketch(BILLS, id).kept).toBeUndefined();
  });

  it("«Tieni» o «Rifai» su un blocco che non è una bozza: `invalid: wireframe`; su uno che non c'è: `not_found`", async () => {
    const text = page(BILLS).blocks[0]!.id;
    expect(() => keepWireframeAs(LAURA, BILLS, text)).toThrow("invalid: wireframe");
    expect(() => redrawWireframeAs(LAURA, BILLS, text)).toThrow("invalid: wireframe");
    expect(() => keepWireframeAs(LAURA, BILLS, "blk-nope")).toThrow("not_found");
  });

  it("«Rifai» dopo «Tieni» rimette l'etichetta (`kept` assente)", async () => {
    const id = await drawn();
    keepWireframeAs(LAURA, BILLS, id);
    redrawWireframeAs(LAURA, BILLS, id);
    await whenSketchesIdle();
    expect(sketch(BILLS, id)).not.toHaveProperty("kept");
    expect(sketch(BILLS, id).variant).toBe(1);
  });

  it("la cronologia dice «ha disegnato», «ha rifatto», «ha tenuto»; «Tieni» si annulla da lì e l'etichetta torna", async () => {
    const id = await drawn();
    redrawWireframeAs(LAURA, BILLS, id);
    await whenSketchesIdle();
    const { revisionId } = keepWireframeAs(LAURA, BILLS, id);
    const rows = await productDocs.listProductRevisions(BILLS);
    expect(rows.slice(0, 3).map((r) => r.wireframe)).toEqual(["kept", "redrew", "drew"]);
    expect(rows[0]).not.toHaveProperty("onBehalfOfId");
    expect(rows[1]).toMatchObject({ onBehalfOfId: LAURA });
    expect(rows[0]!.undo).toEqual({ enabled: true });

    undoProductChangeAs(LAURA, revisionId!);
    expect(sketch(BILLS, id)).not.toHaveProperty("kept");
    expect(sketch(BILLS, id).variant).toBe(1);
    const after = await productDocs.listProductRevisions(BILLS);
    expect(after[0]).toMatchObject({ kind: "undo", undoOf: revisionId });
    expect(after[0]).not.toHaveProperty("wireframe");
    expect(after[1]!.undo).toMatchObject({ enabled: false, reason: "already_undone" });
  });

  it("«Annulla» di «Tieni» è spento col nome di chi ha rifatto lo schizzo dopo", async () => {
    const id = await drawn();
    const { revisionId } = keepWireframeAs(LAURA, BILLS, id);
    redrawWireframeAs(MARCO, BILLS, id);
    await whenSketchesIdle();
    const rows = await productDocs.listProductRevisions(BILLS);
    const kept = rows.find((r) => r.id === revisionId)!;
    expect(kept.undo).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
    expect(() => undoProductChangeAs(LAURA, revisionId!)).toThrow("refused: changed_after");
  });

  it("«Annulla» del disegno dalla cronologia toglie il blocco", async () => {
    const id = await drawn();
    const drew = last(BILLS);
    undoProductChangeAs(LAURA, drew.id);
    expect(blockOf(BILLS, id)).toBeUndefined();
  });

  it("dal cancello: `productDocs.redrawWireframe` e `productDocs.keepWireframe`", async () => {
    const id = await drawn();
    await productDocs.redrawWireframe(BILLS, id);
    await whenSketchesIdle();
    await productDocs.keepWireframe(BILLS, id);
    expect(sketch(BILLS, id)).toMatchObject({ variant: 1, kept: true });
  });
});

describe("la validazione del blocco (`writeProductBlocksAs`)", () => {
  const insert = (block: ProductBlock) =>
    writeProductBlocksAs(LAURA, BILLS, [{ op: "insert", afterId: null, block }], {});

  it("un `wireframeId` sconosciuto, una variante fuori dai disegni o un `kept` non booleano: `invalid: wireframe`", () => {
    const before = revisionsOf(BILLS).length;
    expect(() => insert({ id: "blk-t7-w1", type: "wireframe", wireframeId: "nope", variant: 0 })).toThrow("invalid: wireframe");
    expect(() => insert({ id: "blk-t7-w2", type: "wireframe", wireframeId: "bills", variant: 99 })).toThrow("invalid: wireframe");
    expect(() => insert({ id: "blk-t7-w3", type: "wireframe", wireframeId: "bills", variant: 0.5 })).toThrow("invalid: wireframe");
    expect(() =>
      insert({ id: "blk-t7-w4", type: "wireframe", wireframeId: "bills", variant: 0, kept: "yes" as unknown as boolean }),
    ).toThrow("invalid: wireframe");
    expect(revisionsOf(BILLS)).toHaveLength(before);
    insert({ id: "blk-t7-w5", type: "wireframe", wireframeId: "bills", variant: 1, kept: true });
    expect(sketch(BILLS, "blk-t7-w5").kept).toBe(true);
  });
});

describe("in lettura", () => {
  it("la pagina porta l'SVG di ogni bozza che contiene (le pagine non leggono il seme); un disegno sconosciuto è `null`", async () => {
    const { blockId } = drawWireframeAs(LAURA, BILLS, { afterId: null });
    const view = (await productDocs.getProductPage(page(BILLS).code))!;
    expect(view.wireframes).toEqual({ "bills:0": PRODUCT_WIREFRAMES.bills!.variants[0] });
    // Dati vecchi: un disegno tolto dal seme.
    sketch(BILLS, blockId).wireframeId = "gone";
    const stale = (await productDocs.getProductPage(page(BILLS).code))!;
    expect(stale.wireframes).toEqual({ "gone:0": null });
    const plainPage = (await productDocs.getProductPage(page(SIGN_IN).code))!;
    expect(plainPage.wireframes).toEqual({});
  });
});

/** Un PNG di un pixel, come lo dà «/image». */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("«Sostituisci con un'immagine» (fix round 1)", () => {
  const drawn = () => drawWireframeAs(LAURA, BILLS, { afterId: page(BILLS).blocks[0]!.id }).blockId;

  it("l'immagine prende il posto della bozza (stesso id e punto), con una revisione della persona e la didascalia vuota", () => {
    const id = drawn();
    const at = page(BILLS).blocks.findIndex((b) => b.id === id);
    const { revisionId } = replaceWireframeWithImageAs(LAURA, BILLS, id, { src: PNG, alt: "The bills screen" });
    expect(page(BILLS).blocks[at]).toEqual({ id, type: "image", src: PNG, caption: "", alt: "The bills screen" });
    const r = state.productRevisions.find((x) => x.id === revisionId)!;
    expect(r).toMatchObject({ actorId: LAURA, kind: "edit" });
    expect(r.via).toBeUndefined();
  });

  it("si annulla dalla cronologia («ha sostituito la bozza»): la bozza torna, com'era", async () => {
    const id = drawn();
    keepWireframeAs(LAURA, BILLS, id);
    const before = structuredClone(sketch(BILLS, id));
    const { revisionId } = replaceWireframeWithImageAs(LAURA, BILLS, id, { src: PNG, alt: "" });
    const rows = await productDocs.listProductRevisions(BILLS);
    expect(rows[0]).toMatchObject({ id: revisionId, wireframe: "replaced", undo: { enabled: true } });
    undoProductChangeAs(MARCO, revisionId!);
    expect(blockOf(BILLS, id)).toEqual(before);
  });

  it("Sara: `forbidden`, la bozza resta; un'immagine non valida: `invalid: image`; il doppio clic fa una sola scrittura", () => {
    const id = drawn();
    expect(() => replaceWireframeWithImageAs(SARA, BILLS, id, { src: PNG, alt: "" })).toThrow("forbidden");
    expect(() => replaceWireframeWithImageAs(LAURA, BILLS, id, { src: "https://example.com/x.png", alt: "" })).toThrow(
      "invalid: image",
    );
    expect(sketch(BILLS, id).type).toBe("wireframe");
    const count = revisionsOf(BILLS).length;
    expect(replaceWireframeWithImageAs(LAURA, BILLS, id, { src: PNG, alt: "" }).revisionId).not.toBeNull();
    expect(replaceWireframeWithImageAs(LAURA, BILLS, id, { src: PNG, alt: "" })).toEqual({ revisionId: null });
    expect(revisionsOf(BILLS)).toHaveLength(count + 1);
    // Un'immagine diversa sul blocco che ormai è un'immagine non è più una sostituzione della bozza.
    expect(() => replaceWireframeWithImageAs(LAURA, BILLS, id, { src: `${PNG}`, alt: "other" })).toThrow("invalid: wireframe");
  });

  it("dal cancello: `productDocs.replaceWireframeWithImage`", async () => {
    const id = drawn();
    await productDocs.replaceWireframeWithImage(BILLS, id, { src: PNG, alt: "" });
    expect(blockOf(BILLS, id)!.type).toBe("image");
  });
});

describe("i minori del fix round 1", () => {
  const drawn = () => drawWireframeAs(LAURA, BILLS, { afterId: page(BILLS).blocks[0]!.id }).blockId;

  it("«Rifai» con la variante vista (`fromVariant`): il doppio clic avanza di una sola variante", async () => {
    const id = drawn();
    await whenSketchesIdle();
    const count = revisionsOf(BILLS).length;
    redrawWireframeAs(LAURA, BILLS, id, 0);
    await whenSketchesIdle();
    redrawWireframeAs(LAURA, BILLS, id, 0);
    await whenSketchesIdle();
    expect(sketch(BILLS, id).variant).toBe(1);
    expect(revisionsOf(BILLS)).toHaveLength(count + 1);
  });

  it("«Tieni» su un disegno che il seme non ha più: si tiene lo stesso (la scrittura non rivalida ciò che non cambia)", () => {
    const id = drawn();
    sketch(BILLS, id).wireframeId = "gone";
    const { revisionId } = keepWireframeAs(LAURA, BILLS, id);
    expect(revisionId).not.toBeNull();
    expect(sketch(BILLS, id)).toMatchObject({ wireframeId: "gone", kept: true });
    // Ma un disegno sconosciuto NUOVO resta rifiutato.
    expect(() =>
      writeProductBlocksAs(LAURA, BILLS, [{ op: "set", block: { ...sketch(BILLS, id), wireframeId: "other-gone" } }], {}),
    ).toThrow("invalid: wireframe");
  });

  it("una scrittura di una persona che cambia insieme `kept` e la variante non è un «Tieni»", async () => {
    const id = drawn();
    writeProductBlocksAs(LAURA, BILLS, [{ op: "set", block: { ...sketch(BILLS, id), variant: 1, kept: true } }], {});
    const rows = await productDocs.listProductRevisions(BILLS);
    expect(rows[0]).not.toHaveProperty("wireframe");
    expect(rows[0]).not.toHaveProperty("undo");
  });
});

// F6 (21 nov 2026, maintainer via orchestratrice; shape
// product-claude-backlog.md, «Emendamento F6»): il disegno è asincrono come
// sul server. Il blocco nasce subito, lo schizzo arriva dopo una pausa
// finta, o non arriva: lo stato è del blocco (`wireframeStates`).
describe("il disegno asincrono (F6)", () => {
  // Una pausa vera (8 × 5 ms): con latenza 0 il disegno finirebbe prima della lettura.
  beforeEach(() => setStreamLatency(5));
  afterEach(() => setStreamLatency(null));
  const view = async () => (await productDocs.getProductPage(page(BILLS).code))!;
  const drawn = () => drawWireframeAs(LAURA, BILLS, { afterId: page(BILLS).blocks[0]!.id }).blockId;

  it("«Disegna»: il blocco c'è da subito, `drawing`; finito, lo stato se ne va e la pagina lo sa", async () => {
    const id = drawn();
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "drawing" } });
    const events: string[] = [];
    const off = subscribeProductPage(BILLS, (e) => events.push(e));
    await whenSketchesIdle();
    off();
    expect((await view()).wireframeStates).toEqual({});
    expect(events).toContain("blocks");
  });

  it("«Rifai»: la variante resta finché disegna, la revisione nasce alla fine; un secondo «Rifai» intanto non fa nulla", async () => {
    const id = drawn();
    await whenSketchesIdle();
    const count = revisionsOf(BILLS).length;
    redrawWireframeAs(MARCO, BILLS, id);
    expect(sketch(BILLS, id).variant).toBe(0);
    expect(revisionsOf(BILLS)).toHaveLength(count);
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "drawing" } });
    // Il secondo clic (qui di Laura) non riparte: la variante resta di Marco.
    redrawWireframeAs(LAURA, BILLS, id);
    await whenSketchesIdle();
    expect(sketch(BILLS, id).variant).toBe(1);
    expect(revisionsOf(BILLS)).toHaveLength(count + 1);
    expect(last(BILLS)).toMatchObject({ actorId: MARCO, via: "claude", kind: "edit" });
  });

  it("un disegno che non riesce lo dice col motivo; «Rifai» dopo ci riprova e lo stato torna pronto", async () => {
    failNextSketch("invalid_svg");
    const id = drawn();
    await whenSketchesIdle();
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "failed", reason: "invalid_svg", drawn: false } });
    redrawWireframeAs(LAURA, BILLS, id);
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "drawing" } });
    await whenSketchesIdle();
    expect((await view()).wireframeStates).toEqual({});
    // Il primo schizzo che arriva è la variante 0, come sul server: prima non ce n'era nessuno.
    expect(sketch(BILLS, id).variant).toBe(0);
    expect((await view()).wireframes).toEqual({ "bills:0": PRODUCT_WIREFRAMES.bills!.variants[0] });
  });

  it("una bozza mai disegnata (in disegno o non riuscita) non ha schizzo, come sul server; le altre col suo disegno sì", async () => {
    const ready = drawn();
    await whenSketchesIdle();
    failNextSketch("no_answer");
    const failed = drawn();
    expect(sketch(BILLS, failed).wireframeId).toBe(sketch(BILLS, ready).wireframeId);
    expect((await view()).wireframes).toEqual({ "bills:0": PRODUCT_WIREFRAMES.bills!.variants[0] });
    sketch(BILLS, ready).variant = 1;
    expect((await view()).wireframes).toEqual({ "bills:1": PRODUCT_WIREFRAMES.bills!.variants[1] });
    await whenSketchesIdle();
    expect((await view()).wireframeStates).toEqual({ [failed]: { status: "failed", reason: "no_answer", drawn: false } });
    expect((await view()).wireframes).toEqual({ "bills:1": PRODUCT_WIREFRAMES.bills!.variants[1] });
    // Un «Rifai» che non riesce su una bozza mai disegnata: ancora nessuno schizzo.
    failNextSketch("limit");
    redrawWireframeAs(LAURA, BILLS, failed);
    await whenSketchesIdle();
    expect((await view()).wireframeStates?.[failed]).toEqual({ status: "failed", reason: "limit", drawn: false });
    expect((await view()).wireframes).toEqual({ "bills:1": PRODUCT_WIREFRAMES.bills!.variants[1] });
  });

  it("un «Rifai» che non riesce non scrive: la variante di prima resta", async () => {
    const id = drawn();
    await whenSketchesIdle();
    const count = revisionsOf(BILLS).length;
    failNextSketch("no_answer");
    redrawWireframeAs(LAURA, BILLS, id);
    await whenSketchesIdle();
    expect(sketch(BILLS, id).variant).toBe(0);
    expect(revisionsOf(BILLS)).toHaveLength(count);
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "failed", reason: "no_answer", drawn: true } });
  });

  it("`holdSketches` (test): il disegno resta in corso oltre la pausa, finché non si rilascia", async () => {
    const release = holdSketches();
    const id = drawn();
    await new Promise((r) => setTimeout(r, 120));
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "drawing" } });
    release();
    await whenSketchesIdle();
    expect((await view()).wireframeStates).toEqual({});
  });

  it("l'esportazione non porta lo schizzo di una bozza mai disegnata (esce come uno schizzo che non c'è)", async () => {
    failNextSketch("invalid_svg");
    drawn();
    await whenSketchesIdle();
    const read = (await productDocs.getProductExport(page(BILLS).projectId, { pageId: BILLS }))!;
    expect(read.wireframes).toEqual({});
  });

  it("il budget del mese finito mentre disegna: `failed` con `budget`", async () => {
    const id = drawn();
    state.instance.simulate.budgetReached = true;
    await whenSketchesIdle();
    expect((await view()).wireframeStates).toEqual({ [id]: { status: "failed", reason: "budget", drawn: false } });
  });

  it("sostituita con un'immagine o annullata mentre disegna: il disegno in arrivo non scrive nulla", async () => {
    const replaced = drawn();
    replaceWireframeWithImageAs(LAURA, BILLS, replaced, { src: PNG, alt: "" });
    const redrawn = drawn();
    await whenSketchesIdle();
    redrawWireframeAs(LAURA, BILLS, redrawn);
    replaceWireframeWithImageAs(LAURA, BILLS, redrawn, { src: PNG, alt: "" });
    const undone = drawn();
    undoProductChangeAs(LAURA, last(BILLS).id);
    const count = revisionsOf(BILLS).length;
    await whenSketchesIdle();
    expect(blockOf(BILLS, replaced)?.type).toBe("image");
    expect(blockOf(BILLS, redrawn)?.type).toBe("image");
    expect(blockOf(BILLS, undone)).toBeUndefined();
    expect(revisionsOf(BILLS)).toHaveLength(count);
    expect((await view()).wireframeStates).toEqual({});
  });
});
