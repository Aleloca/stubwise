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
  it("accetta e conserva lo userAgent opzionale", () => {
    const parsed = errorEventSchema.parse({
      kind: "error",
      message: "boom",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
      breadcrumbs: [],
      timestamp: "2026-06-10T10:00:01Z",
    });
    expect(parsed.userAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    );
  });
  it("resta valido senza userAgent", () => {
    const parsed = errorEventSchema.parse({
      kind: "error",
      message: "boom",
      breadcrumbs: [],
      timestamp: "2026-06-10T10:00:01Z",
    });
    expect(parsed.userAgent).toBeUndefined();
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
  it("accetta un feedback con screenshot dataURL", () => {
    const parsed = ingestEventSchema.parse({
      kind: "feedback",
      message: "Bottone rotto",
      screenshot: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    });
    expect(parsed).toMatchObject({
      kind: "feedback",
      screenshot: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    });
  });
  it("rifiuta uno screenshot che non è un dataURL immagine", () => {
    expect(() =>
      ingestEventSchema.parse({
        kind: "feedback",
        message: "x",
        screenshot: "https://evil.example.com/img.png",
      }),
    ).toThrow();
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
