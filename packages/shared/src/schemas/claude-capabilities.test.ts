import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import { agentSessionEventSchema } from "./agent-session.js";
import { CLAUDE_CAPABILITY_IDS, claudeCapabilitiesSchema, claudeSuggestionSchema } from "./claude-capabilities.js";

describe("area 10, F7: le capacità e i suggerimenti", () => {
  it("gli id del prototipo, nel suo ordine; dall'area 11, F6, anche le cinque `product*`", () => {
    expect([...CLAUDE_CAPABILITY_IDS]).toEqual([
      "automation", "stalled", "spend", "archive", "addMember", "releaseNotes", "mailBody", "taskDescription",
      "productFirstVersion", "productUpdate", "productBacklog", "productWireframe", "productChanges",
    ]);
  });

  it("un id che il client non conosce (una capacità futura) arriva UNKNOWN, e gli altri restano", () => {
    expect(readerSchema(claudeCapabilitiesSchema).parse({ items: ["stalled", "unaCapacitaFutura", "spend"] })).toEqual({ items: ["stalled", UNKNOWN, "spend"] });
  });

  it("un evento `capabilities` si legge; un tipo d'evento ignoto arriva UNKNOWN senza perdere la pagina", () => {
    const read = readerSchema(agentSessionEventSchema.array()).parse([
      { id: "1", type: "capabilities", segmentId: "s", at: "2026-11-20T10:00:00.000Z", data: { items: ["stalled"] } },
      { id: "2", type: "un_tipo_futuro", segmentId: "s", at: "2026-11-20T10:00:01.000Z", data: {} },
    ]);
    expect(read.map((e) => e.type)).toEqual(["capabilities", UNKNOWN]);
  });

  it("un suggerimento è null o una riga col solo codice dell'oggetto", () => {
    expect(claudeSuggestionSchema.parse(null)).toBeNull();
    expect(claudeSuggestionSchema.parse({ suggestionId: "whyStalled:p", kind: "whyStalled", page: "overview", objectId: "p", params: { code: "AUD" } })).toMatchObject({ kind: "whyStalled", params: { code: "AUD" } });
  });
});
