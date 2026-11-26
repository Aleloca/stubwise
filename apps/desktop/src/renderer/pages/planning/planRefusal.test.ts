import { describe, expect, it } from "vitest";
import { planRefusalOf } from "./planRefusal";

// Un rifiuto del server (o del finto) a pianificare o a mettere in un giorno
// ha la sua frase e niente «Try again»; ogni altro errore (rete, 500) resta
// da riprovare.

const apiError = (status: number, code: string) => Object.assign(new Error("x"), { status, code });

describe("planRefusalOf", () => {
  it("i rifiuti del server, per codice", () => {
    expect(planRefusalOf(apiError(403, "forbidden"))).toBe("forbidden");
    expect(planRefusalOf(apiError(400, "invalid_assignee"))).toBe("invalid_assignee");
    expect(planRefusalOf(apiError(400, "past_week"))).toBe("past_week");
    expect(planRefusalOf(apiError(409, "not_in_week"))).toBe("not_in_week");
  });

  it("i rifiuti del finto, per messaggio", () => {
    expect(planRefusalOf(new Error("forbidden"))).toBe("forbidden");
    expect(planRefusalOf(new Error("invalid: assignee"))).toBe("invalid_assignee");
  });

  it("rete, 500 e un codice ignoto non sono rifiuti", () => {
    expect(planRefusalOf(new TypeError("Failed to fetch"))).toBeNull();
    expect(planRefusalOf(apiError(500, "internal"))).toBeNull();
    expect(planRefusalOf(apiError(400, "something_else"))).toBeNull();
    expect(planRefusalOf(new Error("Simulated failure"))).toBeNull();
    expect(planRefusalOf(undefined)).toBeNull();
  });
});
