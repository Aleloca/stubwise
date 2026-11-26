import { describe, expect, it } from "vitest";
import { passesStartFilter } from "./runRules.js";
import type { AutomationFlow, DataField } from "./types.js";
import { writtenTrialEvent } from "./writtenExample.js";

const flow = (filter?: AutomationFlow["trigger"] extends infer T ? (T extends { kind: "stubwise"; filter?: infer F } ? F : never) : never) =>
  ({ trigger: { kind: "stubwise", event: "request_created", ...(filter ? { filter } : {}) }, steps: [], titleTemplate: "x" }) as unknown as AutomationFlow;
const fields: DataField[] = [
  { key: "richiesta.titolo", label: "Titolo", type: "text" },
  { key: "richiesta.urgenza", label: "Urgenza", type: "text" },
  { key: "richiesta.progetto", label: "Progetto", type: "text" },
  { key: "richiesta.autore", label: "Autore", type: "person" },
  { key: "richiesta.data", label: "Data", type: "date" },
  { key: "richiesta.urgente", label: "Urgente", type: "boolean" },
] as DataField[];
const ctx = { viewerId: "u-1", projectCode: "ACQ", today: "2026-11-24" };

describe("writtenTrialEvent (lotto 6, voce 5): l'esempio della prova, deterministico, mai un modello", () => {
  it("i valori neutri per campo, poi i confronti `is`/`contains` del filtro soddisfatti", () => {
    const f = flow({ all: [{ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } }, { left: { ref: "richiesta.titolo" }, op: "contains", right: { value: "export" } }] });
    const event = writtenTrialEvent(f, fields, ctx, true)!;
    expect(event).toEqual({ richiesta: { titolo: "export", urgenza: "high", progetto: "ACQ", autore: "u-1", data: "2026-11-24", urgente: false } });
    expect(passesStartFilter(f.trigger, event)).toBe(true);
  });

  it("«non passa»: il primo confronto rotto (un altro valore dell'elenco chiuso), e la verifica col filtro vero", () => {
    const f = flow({ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } });
    const event = writtenTrialEvent(f, fields, ctx, false)!;
    expect((event.richiesta as { urgenza: string }).urgenza).toBe("low");
    expect(passesStartFilter(f.trigger, event)).toBe(false);
  });

  it("dalla parte sbagliata è null: nessun filtro per «non passa», un confronto che non sa rompere (`gt`)", () => {
    expect(writtenTrialEvent(flow(), fields, ctx, false)).toBeNull();
    expect(writtenTrialEvent(flow({ left: { ref: "richiesta.urgenza" }, op: "gt", right: { value: 3 } }), fields, ctx, true)).toBeNull();
  });

  it("deterministico: lo stesso flusso dà lo stesso esempio", () => {
    const f = flow({ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "medium" } });
    expect(writtenTrialEvent(f, fields, ctx, true)).toEqual(writtenTrialEvent(f, fields, ctx, true));
  });
});
