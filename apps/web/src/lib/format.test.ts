import { describe, expect, it } from "vitest";
import { deriveFullName, formatRelativeTimeVerbose } from "./format";

describe("formatRelativeTimeVerbose", () => {
  // Riferimento: mercoledì 2026-06-24, 12:00:00 locale.
  const now = new Date(2026, 5, 24, 12, 0, 0).getTime();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('< 60s → "adesso"', () => {
    expect(formatRelativeTimeVerbose(at(30 * SECOND), now)).toBe("adesso");
  });

  it("minuti con singolare/plurale", () => {
    expect(formatRelativeTimeVerbose(at(MINUTE), now)).toBe("1 minuto fa");
    expect(formatRelativeTimeVerbose(at(5 * MINUTE), now)).toBe("5 minuti fa");
  });

  it("ore con singolare/plurale", () => {
    expect(formatRelativeTimeVerbose(at(HOUR), now)).toBe("1 ora fa");
    expect(formatRelativeTimeVerbose(at(3 * HOUR), now)).toBe("3 ore fa");
  });

  it('giorno di calendario precedente → "ieri"', () => {
    // Martedì 23 alle 09:00 (ieri rispetto a mercoledì 24).
    const ieri = new Date(2026, 5, 23, 9, 0, 0).toISOString();
    expect(formatRelativeTimeVerbose(ieri, now)).toBe("ieri");
  });

  it("oltre ieri → data assoluta", () => {
    const old = new Date(2026, 5, 20, 9, 0, 0);
    expect(formatRelativeTimeVerbose(old.toISOString(), now)).toBe("20/06/2026");
    // Anche un valore a cavallo di più giorni (≥48h) cade nella data.
    expect(formatRelativeTimeVerbose(at(3 * DAY), now)).toBe("21/06/2026");
  });
});

describe("deriveFullName", () => {
  it("ricava owner/repo da un URL https", () => {
    expect(deriveFullName("https://github.com/acme/demo")).toBe("acme/demo");
  });

  it("toglie il suffisso .git e lo slash finale", () => {
    expect(deriveFullName("https://github.com/acme/demo.git")).toBe("acme/demo");
    expect(deriveFullName("https://github.com/acme/demo/")).toBe("acme/demo");
    expect(deriveFullName("https://github.com/acme/demo.git/")).toBe("acme/demo");
  });

  it("usa gli ultimi due segmenti per host con path più profondi", () => {
    expect(deriveFullName("https://bitbucket.org/team/acme/demo")).toBe("acme/demo");
  });

  it("ritorna null su URL non parsabili o con un solo segmento", () => {
    expect(deriveFullName("non-un-url")).toBeNull();
    expect(deriveFullName("https://github.com/acme")).toBeNull();
    expect(deriveFullName("")).toBeNull();
    expect(deriveFullName("   ")).toBeNull();
  });
});
