import { describe, expect, it } from "vitest";
import {
  BACKGROUND_THRESHOLD_PAUSE_REASON,
  docsPauseReasonOf,
  LEGACY_THRESHOLD_PAUSE_REASONS,
  PROVIDER_LIMIT_PAUSE_REASON,
} from "./docs-pause-reason.js";

describe("docsPauseReasonOf", () => {
  it("i due codici stabili restano sé stessi", () => {
    expect(docsPauseReasonOf(BACKGROUND_THRESHOLD_PAUSE_REASON)).toBe("background_threshold");
    expect(docsPauseReasonOf(PROVIDER_LIMIT_PAUSE_REASON)).toBe("provider_limit");
  });

  it("le frasi della soglia scritte da versioni precedenti valgono la SOGLIA", () => {
    // Le due frasi letterali che il worker ha davvero scritto (git log -p di
    // docs/nodes.ts e recursive/node-dispatch.ts): copiate qui a mano, non
    // dalla costante, così un ritocco dell'elenco che ne perde una fa rosso.
    expect(
      docsPauseReasonOf(
        "soglia del limite settimanale (lavoro di sfondo) superata su tutti gli account AI: riprende al reset settimanale",
      ),
    ).toBe("background_threshold");
    expect(
      docsPauseReasonOf(
        "soglia del limite settimanale (lavoro di sfondo) superata su tutti gli account AI: riprende al reset settimanale o, dopo DOCS_BACKGROUND_PAUSE_MAX_HOURS, come lavoro interattivo",
      ),
    ).toBe("background_threshold");
    expect(LEGACY_THRESHOLD_PAUSE_REASONS).toHaveLength(2);
  });

  it("la frase storica del limite, un testo ignoto o un valore assente valgono il LIMITE", () => {
    expect(docsPauseReasonOf("limite di rate/usage del provider AI")).toBe("provider_limit");
    expect(docsPauseReasonOf("qualcos'altro")).toBe("provider_limit");
    expect(docsPauseReasonOf(undefined)).toBe("provider_limit");
    expect(docsPauseReasonOf(null)).toBe("provider_limit");
    expect(docsPauseReasonOf(42)).toBe("provider_limit");
  });

  it("un codice stabile non nomina variabili d'ambiente", () => {
    for (const code of [BACKGROUND_THRESHOLD_PAUSE_REASON, PROVIDER_LIMIT_PAUSE_REASON]) {
      expect(code).toMatch(/^[a-z_]+$/);
    }
  });
});
