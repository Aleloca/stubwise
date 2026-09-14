import { describe, expect, it } from "vitest";
import { lastClosedWeek } from "./project-briefs.js";

/**
 * `lastClosedWeek` non aveva test propri: era coperta solo di rimbalzo, da
 * una data fissa nel seed di `projects.test.ts` che ha smesso di combaciare
 * il 14 settembre 2026 e ha fatto cadere tre test insieme. La regola è
 * abbastanza semplice da scriverla in una riga e abbastanza importante da
 * non lasciarla a un effetto collaterale: sette giorni di calendario che
 * finiscono IERI, in UTC, estremi inclusi.
 */
describe("lastClosedWeek", () => {
  it("sette giorni che finiscono ieri, estremi inclusi", () => {
    expect(lastClosedWeek(new Date("2026-09-14T09:00:00.000Z"))).toEqual({
      periodStart: "2026-09-07",
      periodEnd: "2026-09-13",
    });
  });

  it("non è allineata alla settimana di calendario: scorre di giorno in giorno", () => {
    // Il giorno dopo il caso qui sopra: la finestra si sposta di UNO, non
    // salta al lunedì. Chi un domani volesse allinearla al calendario
    // (lunedì-domenica) fa fallire questo test, ed è il punto: sarebbe un
    // cambio di comportamento, non un dettaglio.
    expect(lastClosedWeek(new Date("2026-09-15T09:00:00.000Z"))).toEqual({
      periodStart: "2026-09-08",
      periodEnd: "2026-09-14",
    });
  });

  it("l'ora del giorno non sposta la finestra", () => {
    const mattina = lastClosedWeek(new Date("2026-09-14T00:00:00.000Z"));
    const notte = lastClosedWeek(new Date("2026-09-14T23:59:59.999Z"));
    expect(mattina).toEqual(notte);
  });

  it("attraversa il confine del mese e dell'anno", () => {
    expect(lastClosedWeek(new Date("2026-03-03T12:00:00.000Z"))).toEqual({
      periodStart: "2026-02-24",
      periodEnd: "2026-03-02",
    });
    expect(lastClosedWeek(new Date("2026-01-04T12:00:00.000Z"))).toEqual({
      periodStart: "2025-12-28",
      periodEnd: "2026-01-03",
    });
  });
});
