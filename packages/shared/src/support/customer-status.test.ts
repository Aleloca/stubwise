import { describe, expect, it } from "vitest";
import { customerStatus, type CustomerRequestInput, type CustomerTaskInput } from "./customer-status.js";

// Area 8, F3: lo stato della richiesta come lo vede il CLIENTE (era
// `domain/releases/customerStatus.ts` del prototipo, coi suoi casi), con un
// ingresso neutro.

const request = (over: Partial<CustomerRequestInput> = {}): CustomerRequestInput => ({ status: "new", merged: false, ...over });
const task = (over: Partial<CustomerTaskInput> = {}): CustomerTaskInput => ({ closed: false, claudeActive: false, ...over });
const converted = request({ status: "converted" });

describe("customerStatus", () => {
  it("nessuna richiesta ancora → received", () => {
    expect(customerStatus(null, [], [])).toBe("received");
  });
  it("nuova → received; in refine → evaluating; pronta → planned", () => {
    expect(customerStatus(request(), [], [])).toBe("received");
    expect(customerStatus(request({ status: "refining" }), [], [])).toBe("evaluating");
    expect(customerStatus(request({ status: "ready" }), [], [])).toBe("planned");
  });
  it("archiviata → not_proceeding; fusa in un'altra non lo è", () => {
    expect(customerStatus(request({ status: "archived" }), [], [])).toBe("not_proceeding");
    expect(customerStatus(request({ status: "archived", merged: true }), [], [])).toBe("evaluating");
  });
  it("trasformata, task non ancora avviata → planned", () => {
    expect(customerStatus(converted, [task()], [])).toBe("planned");
    expect(customerStatus(converted, [], [])).toBe("planned");
  });
  it("trasformata, Claude al lavoro → in_progress", () => {
    expect(customerStatus(converted, [task({ claudeActive: true })], [])).toBe("in_progress");
  });
  it("mergiata ma non ancora rilasciata → in_progress (anche senza pipeline né server: Stubwise non lo sa)", () => {
    for (const kind of ["running", "failed", "not_in_production", "unavailable", "unknown"] as const) {
      expect(customerStatus(converted, [task()], [kind])).toBe("in_progress");
    }
  });
  it("rilascio riuscito o in produzione → released", () => {
    expect(customerStatus(converted, [task()], ["succeeded"])).toBe("released");
    expect(customerStatus(converted, [task()], ["failed", "in_production"])).toBe("released");
  });
  it("task tutte chiuse senza rilascio → not_proceeding; chiusa con un rilascio in corso → in_progress", () => {
    expect(customerStatus(converted, [task({ closed: true })], [])).toBe("not_proceeding");
    expect(customerStatus(converted, [task({ closed: true })], ["running"])).toBe("in_progress");
  });
  it("un esito che è un TICKET del widget (nessuna richiesta): lo stato dalla task", () => {
    expect(customerStatus(null, [task()], [])).toBe("planned");
    expect(customerStatus(null, [task({ claudeActive: true })], [])).toBe("in_progress");
    expect(customerStatus(null, [task({ closed: true })], [])).toBe("not_proceeding");
    expect(customerStatus(null, [task()], ["succeeded"])).toBe("released");
  });
});
