import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { ProductAnswerChoice } from "../../data/types";
import { answerLabel } from "./claudeText";

// Area 11, F5 (revisione di R11-5, 10): una risposta con un'opzione che il
// renderer non conosce (UNKNOWN, un server più nuovo) ha un'etichetta neutra,
// mai la chiave grezza.
describe("answerLabel", () => {
  const t = i18n.t.bind(i18n);

  it("le tre opzioni hanno il loro nome", () => {
    expect(answerLabel(t, "apply")).toBe("Update it");
    expect(answerLabel(t, "request")).toBe("Open a request");
  });

  it("un'opzione ignota: «another answer», non la chiave", () => {
    expect(answerLabel(t, "__unknown__" as ProductAnswerChoice)).toBe("another answer");
  });
});
