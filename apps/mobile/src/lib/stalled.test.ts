import { UNKNOWN } from "@stubwise/shared";
import { stalledDays, stalledReasonKey } from "./stalled";

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

  it("un motivo SCONOSCIUTO (server più nuovo) degrada al testo neutro", () => {
    // È esattamente ciò che `readerSchema` consegna a un'app che quel motivo
    // non lo conosce: il valore sentinella, non la stringa del server.
    expect(stalledReasonKey(UNKNOWN)).toBe("mobile.projects.detail.stalledReason.unknown");
  });
});
