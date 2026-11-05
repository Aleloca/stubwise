import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionOf, sectionRange } from "../../domain/productDocs/sections";
import { plain } from "../../domain/productDocs/richText";
import { productDocs, resetApi, setLatency, setStreamLatency } from "../api";
import type { ProductBlock, ProductPageEvent } from "../model";
import { METER_IDS } from "../seed/productDocs/acq";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { revokeProjectPermission } from "../viewer";

// La presenza e i copioni dal vivo (area 11a, Task 5). Il copione di Meter
// reading (seme, Task 3): Matteo entra senza ancora; Marco entra su «Rules»,
// inserisce un paragrafo dopo l'ultimo di «Rules» e ci scrive in 8 pezzi
// «Readings sent after the 25th count for the next bill.», poi esce.
// Persone: Laura e Marco con `docs.edit` in ACQ, Sara con il solo
// `docs.view`, Giulia fuori da ACQ, Simone che Laura non vede (R-G5).
//
// «A metà copione» si ferma con i timer finti e `setStreamLatency(10)`
// (ruling P16): ogni passo aspetta 10 ms, quindi dopo 50 ms sono fatti i
// primi cinque (enter, enter, insert, type, type). Con `setLatency(0)` il
// copione arriva in fondo nei microtask.

const LAURA = "p-laura";
const MARCO = "p-marco";
const MATTEO = "p-matteo";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const SIMONE = "p-simone";
const ACQ = "prj-acq";
const METER = METER_IDS.pageId;
const SCRIPTED = METER_IDS.scripted;
/** Un paragrafo di «Rules» (H2) e un punto di «Edge cases» (H3 dentro Rules). */
const RULES_PARA = "blk-acq-meter-3";
const EDGE_ITEM = "blk-acq-meter-6";
const FULL = "Readings sent after the 25th count for the next bill.";
const SESSION = `script:${METER}:${MARCO}`;

const as = (personId: string) => setSessionPersonId(personId);
const meter = () => state.productPages.find((p) => p.id === METER)!;
const scripted = (): ProductBlock | undefined => meter()?.blocks.find((b) => b.id === SCRIPTED);
const textOf = (b: ProductBlock | undefined) => (b && "content" in b ? b.content.text : null);
const presenceOn = (pageId: string) => state.productPresence.filter((p) => p.pageId === pageId);
const scriptRevisions = () =>
  state.productRevisions.filter(
    (r) => r.pageId === METER && r.actorId === MARCO && r.sessionId === SESSION,
  );

/** Fino a metà copione: dopo «enter», «enter», «insert» e due «type». */
async function halfway(): Promise<void> {
  vi.useFakeTimers();
  setStreamLatency(10);
  as(LAURA);
  await productDocs.joinProductPage(METER);
  await vi.advanceTimersByTimeAsync(50);
}

async function finish(): Promise<void> {
  await vi.runAllTimersAsync();
  await productDocs.whenProductIdle();
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(async () => {
  // Nessun copione resta a scrivere nello stato del test dopo.
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  vi.useRealTimers();
  resetApi();
  await productDocs.whenProductIdle();
});

describe("il copione di Meter reading", () => {
  it("arriva in fondo: il paragrafo di Marco, una revisione, e Marco non c'è più", async () => {
    expect(state.productBlockIds.has(SCRIPTED)).toBe(false);
    as(LAURA);
    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();

    const blocks = meter().blocks;
    const at = blocks.findIndex((b) => b.id === METER_IDS.afterRules);
    expect(blocks[at + 1]).toMatchObject({
      id: SCRIPTED,
      type: "paragraph",
      content: { text: FULL },
    });
    expect(state.productBlockIds.has(SCRIPTED)).toBe(true);
    expect(scriptRevisions()).toHaveLength(1);
    expect(
      presenceOn(METER)
        .map((p) => p.personId)
        .sort(),
    ).toEqual([LAURA, MATTEO]);
  });

  it("un secondo join nella stessa generazione non lo rifà; dopo resetStore sì", async () => {
    as(LAURA);
    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();
    const blocks = JSON.stringify(meter().blocks);
    const revisions = state.productRevisions.length;
    const presence = JSON.stringify(presenceOn(METER));

    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();
    expect(JSON.stringify(meter().blocks)).toBe(blocks);
    expect(state.productRevisions).toHaveLength(revisions);
    // Nemmeno i passi che non scrivono blocchi: Matteo non «rientra».
    expect(JSON.stringify(presenceOn(METER))).toBe(presence);

    resetApi();
    setLatency(0);
    expect(scripted()).toBeUndefined();
    as(LAURA);
    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();
    expect(textOf(scripted())).toBe(FULL);
    expect(scriptRevisions()).toHaveLength(1);
  });

  it("a metà: Marco scrive in Rules, Matteo c'è senza scrivere; writersNear per sezione", async () => {
    await halfway();
    expect(textOf(scripted())).toBe("Readings sent ");

    const others = await productDocs.getProductPresence(METER);
    expect(others.map((p) => p.personId)).toEqual([MATTEO, MARCO]);
    const [matteo, marco] = others;
    expect(matteo).toMatchObject({ name: "Matteo Conti", initials: "MC", anchorId: null });
    expect(marco).toMatchObject({
      name: "Marco Bellini",
      initials: "MB",
      anchorId: SCRIPTED,
      offset: "Readings sent ".length,
    });
    const rules = sectionRange(meter().blocks, sectionOf(meter().blocks, RULES_PARA));
    expect(rules).toContain(marco!.anchorId);

    expect(productDocs.writersNear(METER, RULES_PARA)).toEqual([MARCO]);
    expect(productDocs.writersNear(METER, EDGE_ITEM)).toEqual([]);

    // Chi guarda conta per il segnale (decisione dello shape), ma non fra gli avatar.
    await productDocs.setProductPresence(METER, { anchorId: EDGE_ITEM, offset: 0 });
    expect(productDocs.writersNear(METER, EDGE_ITEM)).toEqual([LAURA]);
    expect(productDocs.writersNear(METER, RULES_PARA).sort()).toEqual([LAURA, MARCO]);
    expect((await productDocs.getProductPresence(METER)).map((p) => p.personId)).not.toContain(
      LAURA,
    );
    await finish();
  });

  it("i colori della presenza: 1–6, stabili per persona, diversi fra Marco e Matteo", async () => {
    await halfway();
    const colors = async () =>
      Object.fromEntries(
        (await productDocs.getProductPresence(METER)).map((p) => [p.personId, p.color]),
      );
    const first = await colors();
    expect(first[MARCO]).not.toBe(first[MATTEO]);
    for (const c of Object.values(first)) expect([1, 2, 3, 4, 5, 6]).toContain(c);
    expect(await colors()).toEqual(first);
    await finish();
    resetApi();
    await halfway();
    expect(await colors()).toEqual(first);
    await finish();
  });

  it("la pagina eliminata a metà: il copione si ferma, gli iscritti ricevono gone, nessuna presenza", async () => {
    await halfway();
    const events: ProductPageEvent[] = [];
    productDocs.subscribeProductPage(METER, (e) => events.push(e));

    await productDocs.deleteProductPage(METER);
    expect(events).toContain("gone");
    expect(presenceOn(METER)).toEqual([]);
    await finish();
    expect(state.productPages.some((p) => p.id === METER)).toBe(false);
    expect(presenceOn(METER)).toEqual([]);
  });

  it("Marco che non legge più i Docs: il copione si ferma, la sua presenza si toglie", async () => {
    await halfway();
    const events: ProductPageEvent[] = [];
    productDocs.subscribeProductPage(METER, (e) => events.push(e));

    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    await finish();
    expect(textOf(scripted())).toBe("Readings sent ");
    expect(
      presenceOn(METER)
        .map((p) => p.personId)
        .sort(),
    ).toEqual([LAURA, MATTEO]);
    expect(events).toContain("presence");
  });

  it("Matteo che non legge più i Docs esce al passo dopo; il copione di Marco continua", async () => {
    await halfway();
    revokeProjectPermission(MATTEO, ACQ, "docs.view" as never);
    await finish();
    expect(textOf(scripted())).toBe(FULL);
    expect(presenceOn(METER).map((p) => p.personId)).toEqual([LAURA]);
  });

  it("un ripristino a metà: il copione non scrive nello stato nuovo", async () => {
    // Fermo dopo i due «enter»: il passo dopo, «insert», nello stato nuovo
    // riuscirebbe (la pagina c'è, l'id è libero), quindi solo la generazione
    // lo ferma.
    vi.useFakeTimers();
    setStreamLatency(10);
    as(LAURA);
    await productDocs.joinProductPage(METER);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      presenceOn(METER)
        .map((p) => p.personId)
        .sort(),
    ).toEqual([LAURA, MARCO, MATTEO]);
    resetApi();
    setStreamLatency(10);
    await finish();
    expect(scripted()).toBeUndefined();
    expect(state.productPresence).toEqual([]);
    expect(state.productRevisions.some((r) => r.sessionId === SESSION)).toBe(false);
  });

  it("Laura scrive nel blocco di Marco: vale il suo testo, la cronologia ha tutt'e due", async () => {
    await halfway();
    await productDocs.saveProductBlocks(
      METER,
      [
        {
          op: "set",
          block: { id: SCRIPTED, type: "paragraph", content: plain("Laura wrote this.") },
        },
      ],
      { sessionId: "editor-laura" },
    );
    expect(textOf(scripted())).toBe("Laura wrote this.");
    const authors = (await productDocs.listProductRevisions(METER)).map((r) => [
      r.actorId,
      r.sessionId,
    ]);
    expect(authors).toContainEqual([MARCO, SESSION]);
    expect(authors).toContainEqual([LAURA, "editor-laura"]);

    // P40: il resto del copione si aggiunge in fondo a ciò che c'è ADESSO.
    await finish();
    expect(textOf(scripted())).toBe("Laura wrote this.after the 25th count for the next bill.");
    const after = state.productRevisions.filter((r) => r.pageId === METER).map((r) => r.actorId);
    expect(after).toContain(LAURA);
    expect(after.filter((a) => a === MARCO).length).toBeGreaterThanOrEqual(2);
  });

  it("l'ancora tolta sotto il copione: il copione si ferma senza errori", async () => {
    await halfway();
    await productDocs.saveProductBlocks(METER, [{ op: "delete", blockId: SCRIPTED }], {
      sessionId: "editor-laura",
    });
    await finish();
    expect(scripted()).toBeUndefined();
    expect(presenceOn(METER).map((p) => p.personId)).not.toContain(MARCO);
  });
});

describe("subscribeProductPage", () => {
  it("un commento dà comments, una scrittura blocks, una presenza presence; dopo la disiscrizione niente", async () => {
    as(LAURA);
    const events: ProductPageEvent[] = [];
    const stop = productDocs.subscribeProductPage(METER, (e) => events.push(e));

    const root = await productDocs.addProductComment(METER, {
      anchorId: RULES_PARA,
      quote: "",
      body: "Why the 25th?",
    });
    expect(events).toEqual(["comments"]);
    await productDocs.resolveProductComment(root.id);
    expect(events).toEqual(["comments", "comments"]);
    await productDocs.saveProductBlocks(
      METER,
      [
        {
          op: "set",
          block: {
            id: RULES_PARA,
            type: "paragraph",
            content: plain("Readings close on the 26th."),
          },
        },
      ],
      { sessionId: "editor-laura" },
    );
    expect(events).toEqual(["comments", "comments", "blocks"]);
    await productDocs.setProductPresence(METER, { anchorId: RULES_PARA, offset: 3 });
    expect(events).toEqual(["comments", "comments", "blocks", "presence"]);

    stop();
    await productDocs.saveProductBlocks(
      METER,
      [
        {
          op: "set",
          block: { id: RULES_PARA, type: "paragraph", content: plain("Back to the 25th.") },
        },
      ],
      { sessionId: "editor-laura" },
    );
    await productDocs.addProductComment(METER, { anchorId: RULES_PARA, quote: "", body: "Ok." });
    await productDocs.setProductPresence(METER, null);
    expect(events).toHaveLength(4);
  });

  it("onProductPresence si sveglia a ogni presenza cambiata, con l'id della pagina", async () => {
    as(LAURA);
    const woke: string[] = [];
    const stop = productDocs.onProductPresence((pageId) => woke.push(pageId));
    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();
    stop();
    expect(woke.length).toBeGreaterThan(0);
    expect(new Set(woke)).toEqual(new Set([METER]));
    const count = woke.length;
    await productDocs.leaveProductPage(METER);
    expect(woke).toHaveLength(count);
  });
});

describe("la presenza di chi guarda", () => {
  it("join e leave: la riga di chi guarda arriva e se ne va", async () => {
    as(SARA);
    await productDocs.joinProductPage(METER);
    expect(presenceOn(METER).find((p) => p.personId === SARA)).toMatchObject({
      anchorId: null,
      selection: null,
    });
    await productDocs.leaveProductPage(METER);
    expect(presenceOn(METER).some((p) => p.personId === SARA)).toBe(false);
  });

  it("ogni cambio prende un seq nuovo (nextSeq), mai l'orologio", async () => {
    as(LAURA);
    await productDocs.setProductPresence(METER, { anchorId: RULES_PARA, offset: 0 });
    const first = presenceOn(METER).find((p) => p.personId === LAURA)!.seq;
    await productDocs.setProductPresence(METER, {
      anchorId: RULES_PARA,
      offset: 2,
      selection: [0, 2],
    });
    const row = presenceOn(METER).find((p) => p.personId === LAURA)!;
    expect(row.seq).toBeGreaterThan(first);
    expect(row).toMatchObject({ anchorId: RULES_PARA, offset: 2, selection: [0, 2] });
  });

  it("scrivere chiede docs.edit; un'ancora o un offset che non ci sono sono invalidi", async () => {
    as(SARA);
    await expect(
      productDocs.setProductPresence(METER, { anchorId: RULES_PARA, offset: 0 }),
    ).rejects.toThrow("forbidden");
    await expect(productDocs.setProductPresence(METER, null)).resolves.toBeUndefined();
    as(LAURA);
    await expect(
      productDocs.setProductPresence(METER, { anchorId: "blk-nope", offset: 0 }),
    ).rejects.toThrow("invalid: anchor");
    await expect(
      productDocs.setProductPresence(METER, { anchorId: RULES_PARA, offset: 999 }),
    ).rejects.toThrow("invalid: offset");
    await expect(
      productDocs.setProductPresence(METER, { anchorId: RULES_PARA, offset: 1, selection: [3, 1] }),
    ).rejects.toThrow("invalid: selection");
  });

  it("chi non legge i Docs di ACQ: la pagina non c'è, né per entrare né per guardare", async () => {
    as(GIULIA);
    await expect(productDocs.joinProductPage(METER)).rejects.toThrow("not_found");
    await expect(productDocs.setProductPresence(METER, null)).rejects.toThrow("not_found");
    expect(await productDocs.getProductPresence(METER)).toEqual([]);
    // Nessun copione è partito per chi non vede la pagina.
    await productDocs.whenProductIdle();
    expect(scripted()).toBeUndefined();
  });

  it("R-G5: nessuna presenza di chi chi guarda non vede, o di chi non legge più i Docs", async () => {
    as(LAURA);
    await productDocs.joinProductPage(METER);
    await productDocs.whenProductIdle();
    for (const personId of [SIMONE, GIULIA])
      state.productPresence.push({
        pageId: METER,
        personId,
        anchorId: RULES_PARA,
        offset: 0,
        selection: null,
        seq: 1,
      });

    const seen = await productDocs.getProductPresence(METER);
    expect(seen.map((p) => p.personId)).toEqual([MATTEO]);
    const text = JSON.stringify(seen).toLowerCase();
    for (const word of ["simone", "rossetti", "giulia", "ferri", SIMONE, GIULIA])
      expect(text).not.toContain(word);
  });
});
