import type { ProjectPulseSummary } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { stalledDays, stalledReasonKey } from "./stalled";

/** Gemello di `apps/mobile/src/lib/stalled.test.ts`, meno il caso `UNKNOWN`:
 * qui server e web si deployano insieme. */

describe("stalledDays", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");

  it("conta i giorni INTERI dall'ultimo movimento", () => {
    expect(stalledDays("2026-08-31T12:00:00.000Z", now)).toBe(21);
    expect(stalledDays("2026-09-20T13:00:00.000Z", now)).toBe(0);
  });

  it("una data nel futuro vale 0, non un numero negativo", () => {
    expect(stalledDays("2026-10-01T12:00:00.000Z", now)).toBe(0);
  });

  it("una data illeggibile vale 0, non NaN", () => {
    expect(stalledDays("non-una-data", now)).toBe(0);
  });
});

describe("stalledReasonKey", () => {
  it("dà una chiave diversa per ognuno dei quattro motivi", () => {
    const keys = (
      ["to_prepare", "worked_then_stopped", "interrupted", "declared_no_work"] as const
    ).map((reason) => stalledReasonKey(reason));
    expect(new Set(keys).size).toBe(4);
  });

  it("un motivo che questo bundle non conosce degrada al testo neutro", () => {
    const sconosciuto = "un_motivo_nuovo" as ProjectPulseSummary["stalled"][number]["reason"];
    expect(stalledReasonKey(sconosciuto)).toBe("projects:stalled.reason.unknown");
  });
});
