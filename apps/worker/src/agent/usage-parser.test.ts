import { describe, expect, it } from "vitest";
import {
  parseUsage,
  parseUsageDeterministic,
  parseUsageWithLlm,
  type UsageSnapshot,
} from "./usage-parser.js";

/**
 * Output `/usage` REALE della TUI di claude (già ripulito dai codici ANSI dal
 * PTY). La percentuale è sulla STESSA riga della barra `█... N% used`; i reset
 * sono LABEL testuali (non ISO). Ci sono DUE "Current week": "all models" e
 * "Sonnet only" — il parser deve leggere SOLO "all models".
 */
const REAL_OUTPUT = `──────────────────────────────────────────────────────────────────
  Settings  Status   Config   Usage   Stats

  Session

  Total cost:            $0.2801
  Total duration (API):  57s
  Total duration (wall): 10m 25s
  Total code changes:    0 lines added, 0 lines removed
  Usage by model:
      claude-haiku-4-5:  529 input, 15 output, 0 cache read, 0 cache write ($0.0006)
       claude-opus-4-8:  3.1k input, 3.8k output, 37.3k cache read, 15.0k cache write ($0.2795)

  Current session
  █████████████                                      26% used
  Resets 2:39pm (Europe/Rome)

  Current week (all models)
  █████████████████▌                                 35% used
  Resets Jun 22 at 9:59am (Europe/Rome)

  Current week (Sonnet only)
                                                     0% used

  What's contributing to your limits usage
  Esc to cancel
`;

describe("parseUsageDeterministic", () => {
  it("estrae sessione e settimanale dal formato REALE (barra+percentuale stessa riga, reset label)", () => {
    const snap = parseUsageDeterministic(REAL_OUTPUT);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining).toEqual({
      percentUsed: 26,
      percentRemaining: 74,
      resetsLabel: "2:39pm (Europe/Rome)",
    });
    // "all models", NON "Sonnet only" (che è 0%).
    expect(snap?.weeklyRemaining).toEqual({
      percentUsed: 35,
      percentRemaining: 65,
      resetsLabel: "Jun 22 at 9:59am (Europe/Rome)",
    });
    // I reset sono label non-ISO: i campi ISO restano null.
    expect(snap?.sessionResetAt ?? null).toBeNull();
    expect(snap?.weeklyResetAt ?? null).toBeNull();
  });

  it("ritorna snapshot valido anche senza riga Resets (resetsLabel assente)", () => {
    const noResets = `
  Current session
  █████ 26% used

  Current week (all models)
  █████ 35% used
`;
    const snap = parseUsageDeterministic(noResets);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining.percentUsed).toBe(26);
    expect(snap?.sessionRemaining.resetsLabel ?? null).toBeNull();
    expect(snap?.weeklyRemaining.percentUsed).toBe(35);
  });

  it("ritorna null su un output che non combacia col formato atteso", () => {
    expect(parseUsageDeterministic("Welcome to Claude Code! Type /help.")).toBeNull();
    expect(parseUsageDeterministic("")).toBeNull();
    // Solo la sessione, niente weekly (all models) → null (servono entrambe).
    expect(parseUsageDeterministic("Current session\n26% used")).toBeNull();
  });

  it("non confonde 'Current week (Sonnet only)' con la weekly (all models)", () => {
    // Se manca "all models" non deve cadere su "Sonnet only".
    const onlySonnet = `
  Current session
  █████ 26% used
  Resets 2:39pm (Europe/Rome)

  Current week (Sonnet only)
  0% used
`;
    expect(parseUsageDeterministic(onlySonnet)).toBeNull();
  });

  // ── Cattura PTY REALE: la TUI usa il posizionamento del cursore (sequenze
  // ANSI), non '\n'. Dopo lo strip ANSI etichetta + barra + percentuale +
  // "Resets" finiscono CONCATENATE sulla stessa "riga" (blob). Il parser deve
  // restare robusto a questo formato oltre che a quello con newline.
  describe("blob concatenato (cattura PTY reale, niente newline)", () => {
    const BLOB = `──────── ? for shortcuts · ← for agents/usage ──────── Settings Status Config Usage StatsSessionTotal cost: $0.0000 Total duration (API): 0s Usage: 0 input, 0 output, 0 cache read, 0 cache writeCurrent session██████▌                         13% usedResets 5:40pm (UTC)Current week (all models)███████████████████               38% usedResets Jun 22, 8am (UTC) What's contributing to your limits usage? Esc to cancel`;

    it("estrae session 13% e weekly 38% con le resetsLabel dal blob con rumore", () => {
      const snap = parseUsageDeterministic(BLOB);
      expect(snap).not.toBeNull();
      expect(snap?.sessionRemaining).toEqual({
        percentUsed: 13,
        percentRemaining: 87,
        resetsLabel: "5:40pm (UTC)",
      });
      // "all models", NON "Sonnet only".
      expect(snap?.weeklyRemaining).toEqual({
        percentUsed: 38,
        percentRemaining: 62,
        resetsLabel: "Jun 22, 8am (UTC)",
      });
    });

    it("tollera 'N%used' senza spazio prima di used", () => {
      const blobNoSpace = `Current session██████▌13%usedResets 5:40pm (UTC)Current week (all models)███████████████████38%usedResets Jun 22, 8am (UTC) What's contributing to your limits usage?`;
      const snap = parseUsageDeterministic(blobNoSpace);
      expect(snap).not.toBeNull();
      expect(snap?.sessionRemaining.percentUsed).toBe(13);
      expect(snap?.weeklyRemaining.percentUsed).toBe(38);
    });

    it("blob senza 'all models' (solo Sonnet only) → null (servono entrambe)", () => {
      const blobSonnet = `Current session██████▌13% usedResets 5:40pm (UTC)Current week (Sonnet only)███████████████████0% used What's contributing to your limits usage?`;
      expect(parseUsageDeterministic(blobSonnet)).toBeNull();
    });

    it("blob con la sola sessione → null (manca la weekly all models)", () => {
      const blobSession = `Current session██████▌13% usedResets 5:40pm (UTC) What's contributing to your limits usage?`;
      expect(parseUsageDeterministic(blobSession)).toBeNull();
    });
  });
});

describe("parseUsageWithLlm", () => {
  const validJson = JSON.stringify({
    sessionRemaining: { percentUsed: 20, resetsLabel: "2:39pm (Europe/Rome)" },
    weeklyRemaining: { percentUsed: 60, resetsLabel: "Jun 22 at 9:59am (Europe/Rome)" },
  });

  it("ritorna lo snapshot quando runLlm restituisce JSON valido e plausibile", async () => {
    const runLlm = async (): Promise<string> => validJson;
    const snap = await parseUsageWithLlm("qualunque testo", runLlm);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining).toEqual({
      percentUsed: 20,
      percentRemaining: 80,
      resetsLabel: "2:39pm (Europe/Rome)",
    });
    expect(snap?.weeklyRemaining.percentUsed).toBe(60);
    expect(snap?.weeklyRemaining.percentRemaining).toBe(40);
  });

  it("ritorna lo snapshot anche senza resetsLabel (campo opzionale)", async () => {
    const runLlm = async (): Promise<string> =>
      JSON.stringify({
        sessionRemaining: { percentUsed: 20 },
        weeklyRemaining: { percentUsed: 60 },
      });
    const snap = await parseUsageWithLlm("x", runLlm);
    expect(snap).not.toBeNull();
    expect(snap?.sessionRemaining.resetsLabel ?? null).toBeNull();
  });

  it("ritorna null se i numeri sono implausibili (percentuale fuori 0–100)", async () => {
    const runLlm = async (): Promise<string> =>
      JSON.stringify({
        sessionRemaining: { percentUsed: 240 },
        weeklyRemaining: { percentUsed: 10 },
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
});

describe("parseUsage (combinatore)", () => {
  const okLlm = async (): Promise<string> =>
    JSON.stringify({
      sessionRemaining: { percentUsed: 1 },
      weeklyRemaining: { percentUsed: 2 },
    });

  it("deterministico ok → source deterministic, parseOk true, niente LLM", async () => {
    let llmCalled = false;
    const spyLlm = async (): Promise<string> => {
      llmCalled = true;
      return okLlm();
    };
    const res = await parseUsage(REAL_OUTPUT, spyLlm);
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
