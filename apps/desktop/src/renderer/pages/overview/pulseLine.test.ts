import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { ProjectPulse } from "../../data/types";
import { pulseLine } from "./pulseLine";

// La riga del polso (review della fetta 4, punto 3): oltre il tetto delle
// task aperte i numeri sono «almeno», e la riga non afferma numeri esatti.
const t = i18n.getFixedT("en");
const pulse = (over: Partial<ProjectPulse> = {}): ProjectPulse => ({
  projectId: "p",
  open: { todo: 0, active: 0 },
  stalled: 0,
  waitingOnMe: false,
  claudeWorking: false,
  nextMilestone: null,
  ...over,
});

describe("la riga del polso", () => {
  it("numeri esatti senza troncamento", () => {
    expect(pulseLine(pulse({ stalled: 3 }), t, "en")).toBe("3 stalled");
    expect(pulseLine(pulse(), t, "en")).toBe("Nothing waiting, nothing stalled");
  });

  it("troncata: «3+ stalled», e non dice «niente di fermo»", () => {
    expect(pulseLine(pulse({ stalled: 3, truncated: true }), t, "en")).toBe("3+ stalled");
    expect(pulseLine(pulse({ truncated: true }), t, "en")).toBe(
      "Nothing waiting · too many open tasks to count the stalled ones",
    );
  });
});
