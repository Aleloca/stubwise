import { describe, expect, it } from "vitest";
import { prDraftRoute } from "./DraftRow";

// «Put it in the field» e «Show» di una bozza delle note portano alla PR. Nella
// build app l'id della PR è `<repository>#<numero>` (area 10, F6): senza
// codifica il `#` diventerebbe l'ancora dell'indirizzo e la PR non si aprirebbe.
describe("l'indirizzo della PR di una bozza", () => {
  it("l'id della PR codificato nella query", () => {
    expect(prDraftRoute("AUD", "11111111-1111-4111-8111-111111111111#246")).toBe(
      "/p/AUD/releases?pr=11111111-1111-4111-8111-111111111111%23246",
    );
    // Gli id del prototipo restano come sono.
    expect(prDraftRoute("ACQ", "opr-acq-77")).toBe("/p/ACQ/releases?pr=opr-acq-77");
  });
});
