import { describe, expect, it } from "vitest";
import { PRODUCT_QUOTE_MAX, cleanQuote } from "./comments.js";

describe("cleanQuote (area 11, F2)", () => {
  it("toglie gli spazi ai lati e fa di più righe una riga sola", () => {
    expect(cleanQuote("  Prima riga\n\n  seconda\triga  ")).toBe("Prima riga seconda riga");
  });

  it("taglia a 200 caratteri con «…», e lascia com'è una frase corta", () => {
    const long = "a".repeat(250);
    const out = cleanQuote(long);
    expect(out).toHaveLength(PRODUCT_QUOTE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanQuote("a".repeat(200))).toBe("a".repeat(200));
  });
});

describe("productCommentViewSchema (area 11, F2) — additivo", () => {
  it("un commento senza `mentionIds` (un server più vecchio) si legge con []", async () => {
    const { productCommentViewSchema } = await import("../schemas/product-docs.js");
    const { readerSchema } = await import("../reader.js");
    const parsed = readerSchema(productCommentViewSchema).parse({
      id: "1c9e4f70-5555-4666-8777-888899990021",
      pageId: "1c9e4f70-5555-4666-8777-888899990022",
      anchorId: "blk-1",
      quote: "Frase",
      authorId: null,
      authorName: null,
      body: "Testo",
      createdAt: "2026-11-20T08:14:00.000Z",
      replyToId: null,
      resolved: null,
    });
    expect(parsed.mentionIds).toEqual([]);
  });

  it("F5: senza `question` si legge null; una domanda con un motivo e un segno che il client non conosce si legge lo stesso", async () => {
    const { productCommentViewSchema } = await import("../schemas/product-docs.js");
    const { readerSchema, UNKNOWN } = await import("../reader.js");
    const base = {
      id: "1c9e4f70-5555-4666-8777-888899990031",
      pageId: "1c9e4f70-5555-4666-8777-888899990032",
      anchorId: "blk-1",
      quote: "Frase",
      authorId: null,
      authorName: null,
      body: "",
      createdAt: "2026-11-20T08:14:00.000Z",
      replyToId: null,
      resolved: null,
    };
    expect(readerSchema(productCommentViewSchema).parse(base).question).toBeNull();
    const source = { kind: "email", canOpen: false, id: null, title: null, code: null, ownerId: null, ownerName: null, at: null, gone: false };
    const parsed = readerSchema(productCommentViewSchema).parse({
      ...base,
      question: {
        reason: "brand_new_reason",
        forId: null,
        forName: null,
        taskCode: null,
        source,
        applyMode: "replace",
        current: { text: "a uno", marks: [{ kind: "sparkle", from: 0, to: 1 }] },
        apply: { text: "a UNO", marks: [] },
        built: null,
        request: null,
        recommended: "apply",
        options: ["apply", "keep"],
        canAnswer: true,
        applyBlocked: null,
        answer: null,
      },
    });
    expect(parsed.question).toMatchObject({ reason: UNKNOWN, current: { text: "a uno" }, source: { thread: null } });
  });
});
