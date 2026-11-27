import * as shared from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import * as local from "./weeks.js";

/**
 * Le settimane ISO del pacchetto sono una COPIA di
 * `packages/shared/src/tasks/weeks.ts` (revisione finale della parità MCP,
 * C1: il pacchetto pubblicato non può importarle da lì). Qui si confrontano
 * con l'originale su un campione largo, così le due non divergono.
 */
const DATES: string[] = [];
for (let y = 2019; y <= 2032; y++) {
  for (const md of ["01-01", "01-03", "01-04", "01-05", "06-15", "12-24", "12-28", "12-29", "12-31"]) DATES.push(`${y}-${md}`);
}
const WEEKS = ["2026-W01", "2026-W49", "2026-W53", "2027-W53", "2020-W53", "2026-W00", "2026-W54", "2026-w01", "x", "", "2026-W1"];
const INSTANTS = ["2026-11-29T22:59:59Z", "2026-11-29T23:00:00Z", "2026-03-29T00:30:00Z", "2026-12-31T23:30:00Z", "2027-01-03T23:30:00Z"];

describe("le settimane del pacchetto coincidono con quelle di @stubwise/shared", () => {
  it("mondayToIsoWeek", () => {
    for (const d of DATES) expect(local.mondayToIsoWeek(d), d).toBe(shared.mondayToIsoWeek(d));
  });

  it("isIsoWeek", () => {
    const sample = [...WEEKS, ...DATES.map((d) => shared.mondayToIsoWeek(d)), 12, null, undefined];
    for (const w of sample) expect(local.isIsoWeek(w), String(w)).toBe(shared.isIsoWeek(w));
  });

  it("addWeeks", () => {
    const valid = DATES.map((d) => shared.mondayToIsoWeek(d));
    for (const w of valid) for (const n of [-60, -1, 0, 1, 2, 52, 53]) expect(local.addWeeks(w, n), `${w}+${n}`).toBe(shared.addWeeks(w, n));
  });

  it("currentIsoWeek, nel fuso di Roma", () => {
    for (const t of INSTANTS) expect(local.currentIsoWeek(new Date(t)), t).toBe(shared.currentIsoWeek(new Date(t)));
  });
});
