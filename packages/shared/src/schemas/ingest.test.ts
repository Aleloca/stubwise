import { describe, it, expect } from "vitest";
import { errorEventSchema, ingestBatchSchema, ingestEventSchema } from "./ingest.js";

describe("errorEventSchema", () => {
  it("accetta un evento errore valido", () => {
    const ev = {
      kind: "error",
      message: "Cannot read properties of undefined",
      errorType: "TypeError",
      stack: "TypeError: ...\n  at fn (app.js:10:5)",
      url: "https://shop.example.com/cart",
      release: "1.4.2",
      environment: "production",
      breadcrumbs: [{ type: "click", message: "button#buy", timestamp: "2026-06-10T10:00:00Z" }],
      timestamp: "2026-06-10T10:00:01Z",
    };
    expect(errorEventSchema.parse(ev)).toMatchObject({ kind: "error" });
  });
  it("rifiuta un evento senza message", () => {
    expect(() => errorEventSchema.parse({ kind: "error" })).toThrow();
  });
  it("accetta timestamp con offset di fuso orario", () => {
    const ev = {
      kind: "error",
      message: "boom",
      breadcrumbs: [
        { type: "click", message: "button#buy", timestamp: "2026-06-10T10:00:00+02:00" },
      ],
      timestamp: "2026-06-10T10:00:01+02:00",
    };
    expect(errorEventSchema.parse(ev)).toMatchObject({
      timestamp: "2026-06-10T10:00:01+02:00",
    });
  });
  it("rifiuta più di 30 breadcrumbs", () => {
    const breadcrumbs = Array.from({ length: 31 }, (_, i) => ({
      type: "log" as const,
      message: `log ${i}`,
      timestamp: "2026-06-10T10:00:00Z",
    }));
    expect(() =>
      errorEventSchema.parse({
        kind: "error",
        message: "boom",
        breadcrumbs,
        timestamp: "2026-06-10T10:00:01Z",
      }),
    ).toThrow();
  });
});

describe("ingestEventSchema", () => {
  it("smista per kind: parse di un evento feedback", () => {
    const parsed = ingestEventSchema.parse({
      kind: "feedback",
      message: "Il carrello non si svuota",
      email: "user@example.com",
    });
    expect(parsed).toMatchObject({ kind: "feedback" });
  });
  it("smista per kind: parse di un evento ticket", () => {
    const parsed = ingestEventSchema.parse({
      kind: "ticket",
      title: "Checkout rotto su Safari",
      type: "bug",
      priority: "high",
    });
    expect(parsed).toMatchObject({ kind: "ticket" });
  });
  it("rifiuta un kind sconosciuto", () => {
    expect(() => ingestEventSchema.parse({ kind: "metric", message: "x" })).toThrow();
  });
});

describe("ingestBatchSchema", () => {
  it("rifiuta un batch con più di 100 eventi", () => {
    const events = Array.from({ length: 101 }, () => ({
      kind: "feedback" as const,
      message: "feedback",
    }));
    expect(() => ingestBatchSchema.parse({ events })).toThrow();
  });
});
