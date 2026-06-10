import { describe, it, expect } from "vitest";
import { errorEventSchema } from "./ingest.js";

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
});
