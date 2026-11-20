import { describe, expect, it } from "vitest";
import { isAllowedProductLiveStreamPath, parseProductLiveFrame, productLiveStreamPath } from "./live.js";

const ID = "1c9e4f70-5555-4666-8777-888899990051";
const data = (v: unknown) => `data: ${JSON.stringify(v)}`;

describe("lo stream dal vivo di una pagina (area 11, F4)", () => {
  it("legge i frame noti, nell'ordine; scarta il ping, il JSON rotto e un tipo che non conosce", () => {
    const raw = [
      ": ping",
      data({ type: "state", seq: 3, presence: [{ userId: ID, name: "Ada", cursor: { blockId: "blk-1", offset: 2 }, sectionId: "top" }], holds: [] }),
      "data: {rotto",
      data({ type: "futuro", x: 1 }),
      data({ type: "revision", seq: 4, kind: "edit", actorId: ID, sessionId: "s", ops: [{ op: "delete", blockId: "blk-1" }] }),
      data({ type: "hold", hold: { sectionId: "blk-h", by: { id: ID, name: null }, expiresAt: "2026-11-20T10:00:00.000Z" } }),
      data({ type: "release", sectionId: "blk-h" }),
      data({ type: "gone" }),
    ].join("\n");
    const frames = parseProductLiveFrame(raw);
    expect(frames.map((f) => f.type)).toEqual(["state", "revision", "hold", "release", "gone"]);
    expect(frames[1]).toMatchObject({ seq: 4, title: null, parentId: null, ops: [{ op: "delete", blockId: "blk-1" }] });
  });

  it("un frame malformato non costa gli altri", () => {
    const frames = parseProductLiveFrame([data({ type: "cursor", userId: "non-un-uuid", cursor: null }), data({ type: "presence", presence: [] })].join("\n"));
    expect(frames.map((f) => f.type)).toEqual(["presence"]);
  });

  it("il percorso e l'allowlist: solo lo stream di una pagina, senza parametri", () => {
    expect(productLiveStreamPath(ID)).toBe(`/api/product-pages/${ID}/live`);
    expect(isAllowedProductLiveStreamPath(`/api/product-pages/${ID}/live`)).toBe(true);
    expect(isAllowedProductLiveStreamPath(`/api/product-pages/${ID}/live?x=1`)).toBe(false);
    expect(isAllowedProductLiveStreamPath(`/api/product-pages/${ID}/revisions`)).toBe(false);
    expect(isAllowedProductLiveStreamPath(`/api/product-pages/../live`)).toBe(false);
  });
});
