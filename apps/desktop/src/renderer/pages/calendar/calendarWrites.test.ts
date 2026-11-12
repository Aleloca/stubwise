import { describe, expect, it } from "vitest";

import { sameInstant, sameSpan } from "./calendarWrites";

// Review F4, 2: il server scrive gli istanti a modo suo (senza millisecondi,
// con un fuso esplicito); confrontarli come stringhe vedeva uno spostamento
// dove non c'era, e mandava una move inutile (con un etag che poi cambia).
describe("sameInstant / sameSpan: gli orari si confrontano come istanti, non come stringhe", () => {
  it("lo stesso istante scritto in tre modi è lo stesso", () => {
    expect(sameInstant("2026-11-13T09:00:00Z", "2026-11-13T09:00:00.000Z")).toBe(true);
    expect(sameInstant("2026-11-13T10:00:00+01:00", "2026-11-13T09:00:00.000Z")).toBe(true);
  });

  it("due istanti diversi restano diversi", () => {
    expect(sameInstant("2026-11-13T09:00:00Z", "2026-11-13T09:30:00.000Z")).toBe(false);
  });

  it("un intervallo è lo stesso solo se lo sono inizio E fine", () => {
    const ev = { startsAt: "2026-11-13T09:00:00Z", endsAt: "2026-11-13T10:00:00Z" };
    expect(
      sameSpan({ startsAt: "2026-11-13T09:00:00.000Z", endsAt: "2026-11-13T10:00:00.000Z" }, ev),
    ).toBe(true);
    expect(
      sameSpan({ startsAt: "2026-11-13T09:00:00.000Z", endsAt: "2026-11-13T11:00:00.000Z" }, ev),
    ).toBe(false);
  });
});
