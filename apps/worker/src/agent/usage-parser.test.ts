import { describe, expect, it } from "vitest";
import {
  parseUsage,
  parseUsageDeterministic,
  parseUsageWithLlm,
  type UsageSnapshot,
} from "./usage-parser.js";

/**
 * Output `/usage` plausibile e REALISTICO della TUI di claude (già ripulito
 * dai codici ANSI). Mostra due finestre: la sessione 5h e il limite
 * settimanale, ciascuna con "N% used" e una riga "Resets ...".
 */
const REALISTIC_OUTPUT = `
Usage

Current session
████████░░░░░░░░░░░░ 42% used
Resets 3:00pm (in 2h 15m)

Weekly limit (all models)
██████░░░░░░░░░░░░░░ 31% used
Resets Thu, Jun 19 at 12:00am
`;

/** Variante con "left"/"remaining" invece di "used" e percentuali diverse. */
const REALISTIC_OUTPUT_REMAINING = `
Current session: 90% remaining
Resets in 4h

Weekly (all models): 5% remaining
Resets in 6 days
`;

describe("parseUsageDeterministic", () => {
  it("estrae sessione e settimanale da un output 'N% used'", () => {
    const snap = parseUsageDeterministic(REALISTIC_OUTPUT);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining).toEqual({ percentUsed: 42, percentRemaining: 58 });
    expect(snap?.weeklyRemaining).toEqual({ percentUsed: 31, percentRemaining: 69 });
  });

  it("estrae sessione e settimanale da un output 'N% remaining'", () => {
    const snap = parseUsageDeterministic(REALISTIC_OUTPUT_REMAINING);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining).toEqual({ percentUsed: 10, percentRemaining: 90 });
    expect(snap?.weeklyRemaining).toEqual({ percentUsed: 95, percentRemaining: 5 });
  });

  it("ritorna null su un output che non combacia col formato atteso", () => {
    expect(parseUsageDeterministic("Welcome to Claude Code! Type /help.")).toBeNull();
    expect(parseUsageDeterministic("")).toBeNull();
    // Solo una delle due finestre → non combacia (servono entrambe).
    expect(parseUsageDeterministic("Current session\n42% used")).toBeNull();
  });
});

describe("parseUsageWithLlm", () => {
  const validJson = JSON.stringify({
    sessionRemaining: { percentUsed: 20, percentRemaining: 80 },
    weeklyRemaining: { percentUsed: 60, percentRemaining: 40 },
    sessionResetAt: "2026-06-19T15:00:00.000Z",
    weeklyResetAt: "2026-06-24T00:00:00.000Z",
  });

  it("ritorna lo snapshot quando runLlm restituisce JSON valido e plausibile", async () => {
    const runLlm = async (): Promise<string> => validJson;
    const snap = await parseUsageWithLlm("qualunque testo", runLlm);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining).toEqual({ percentUsed: 20, percentRemaining: 80 });
    expect(snap?.sessionResetAt).toBe("2026-06-19T15:00:00.000Z");
  });

  it("ritorna null se i numeri sono implausibili (percentuale fuori 0–100)", async () => {
    const runLlm = async (): Promise<string> =>
      JSON.stringify({
        sessionRemaining: { percentUsed: 240, percentRemaining: -140 },
        weeklyRemaining: { percentUsed: 10, percentRemaining: 90 },
      });
    expect(await parseUsageWithLlm("x", runLlm)).toBeNull();
  });

  it("ritorna null se il JSON è malformato", async () => {
    const runLlm = async (): Promise<string> => "non sono json {{{";
    expect(await parseUsageWithLlm("x", runLlm)).toBeNull();
  });

  it("ritorna null se runLlm lancia (best-effort, mai propagare)", async () => {
    const runLlm = async (): Promise<string> => {
      throw new Error("claude haiku non raggiungibile");
    };
    expect(await parseUsageWithLlm("x", runLlm)).toBeNull();
  });

  it("ritorna null se i reset non sono date ISO valide", async () => {
    const runLlm = async (): Promise<string> =>
      JSON.stringify({
        sessionRemaining: { percentUsed: 20, percentRemaining: 80 },
        weeklyRemaining: { percentUsed: 60, percentRemaining: 40 },
        sessionResetAt: "domani pomeriggio",
      });
    expect(await parseUsageWithLlm("x", runLlm)).toBeNull();
  });
});

describe("parseUsage (combinatore)", () => {
  const okLlm = async (): Promise<string> =>
    JSON.stringify({
      sessionRemaining: { percentUsed: 1, percentRemaining: 99 },
      weeklyRemaining: { percentUsed: 2, percentRemaining: 98 },
    });

  it("deterministico ok → source deterministic, parseOk true, niente LLM", async () => {
    let llmCalled = false;
    const spyLlm = async (): Promise<string> => {
      llmCalled = true;
      return okLlm();
    };
    const res = await parseUsage(REALISTIC_OUTPUT, spyLlm);
    expect(res.source).toBe("deterministic");
    expect(res.parseOk).toBe(true);
    expect(res.snapshot).not.toBeNull();
    expect(llmCalled).toBe(false);
  });

  it("deterministico null + LLM ok → source llm_fallback, parseOk false", async () => {
    const res = await parseUsage("output illeggibile per il regex", okLlm);
    expect(res.source).toBe("llm_fallback");
    expect(res.parseOk).toBe(false);
    expect(res.snapshot).not.toBeNull();
  });

  it("entrambi null → snapshot null, parseOk false, source llm_fallback", async () => {
    const badLlm = async (): Promise<string> => "{{{";
    const res = await parseUsage("output illeggibile", badLlm);
    expect(res.snapshot).toBeNull();
    expect(res.parseOk).toBe(false);
    expect(res.source).toBe("llm_fallback");
  });
});

// Type-only sanity: lo snapshot è una forma esportata e utilizzabile.
const _typeCheck: UsageSnapshot = {
  sessionRemaining: { percentUsed: 0, percentRemaining: 100 },
  weeklyRemaining: { percentUsed: 0, percentRemaining: 100 },
};
void _typeCheck;
