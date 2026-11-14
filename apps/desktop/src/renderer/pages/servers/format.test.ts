import i18n from "i18next";
import { describe, expect, it } from "vitest";
import "../../i18n";
import type { EpisodeReason } from "../../data/model";
import { reasonSentence } from "./format";

// Review F4a, I3: un motivo senza valore (il worker di prima non lo scrive),
// senza soglia, o di un tipo che l'app non conosce non dice «NaN%» né lascia
// una riga vuota.

const t = i18n.getFixedT("en");
const say = (r: Record<string, unknown>) =>
  reasonSentence(r as unknown as EpisodeReason, [], t, "en", null);

describe("le frasi dei motivi", () => {
  it("col valore e la soglia, come prima", () => {
    expect(say({ kind: "cpu", valuePct: 97.4, thresholdPct: 95 })).toBe("CPU at 97%, above 95%");
  });

  it("senza valore: sopra la soglia, mai «NaN»", () => {
    expect(say({ kind: "cpu", thresholdPct: 95 })).toBe("CPU above the threshold");
    expect(say({ kind: "memory" })).toBe("Memory above the threshold");
  });

  it("senza soglia: il valore, senza «above …%»", () => {
    expect(say({ kind: "disk", valuePct: 91.6 })).toBe("Disk at 92%");
  });

  it("un tipo sconosciuto non ha frase", () => {
    expect(say({ kind: "gpu", valuePct: 50 })).toBeNull();
  });
});
