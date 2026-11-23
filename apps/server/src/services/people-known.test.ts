import { describe, expect, it } from "vitest";
import { HiddenIds, maskPeople, maskPersonObjects } from "./people-known.js";

// Registro, A11 r.1414: i segnaposto di una risposta, senza DB.
const ME = "11111111-1111-4111-8111-111111111111";
const KNOWN = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";

describe("HiddenIds e il mascheramento", () => {
  it("numera nell'ordine di comparsa, stabile nella risposta; sé stesso e i conosciuti restano veri", () => {
    const h = new HiddenIds(new Set([KNOWN]), ME);
    expect([h.person(A), h.person(B), h.person(A), h.person(ME), h.person(KNOWN), h.person(null)]).toEqual(["hidden-1", "hidden-2", "hidden-1", ME, KNOWN, null]);
    expect([h.project(A, false), h.project(B, true), h.project(A, false)]).toEqual(["hidden-project-1", B, "hidden-project-1"]);
    expect(new HiddenIds("all", ME).person(A)).toBe(A);
  });

  it("le chiavi date, a ogni profondità; gli altri campi no", () => {
    const h = new HiddenIds(new Set(), ME);
    const out = maskPeople({ authorId: A, other: A, list: [{ byId: B, mentionIds: [A, ME] }] }, h, new Set(["authorId", "byId", "mentionIds"]));
    expect(out).toEqual({ authorId: "hidden-1", other: A, list: [{ byId: "hidden-2", mentionIds: ["hidden-1", ME] }] });
  });

  it("un oggetto persona `{ id, name }`: l'id è il segnaposto e il nome null; uno conosciuto resta com'è", () => {
    const h = new HiddenIds(new Set([KNOWN]), ME);
    const out = maskPersonObjects({ startedBy: { id: A, name: "Anna" }, approval: { by: { id: KNOWN, name: "Kim" } } }, h, new Set(["startedBy", "by"]));
    expect(out).toEqual({ startedBy: { id: "hidden-1", name: null }, approval: { by: { id: KNOWN, name: "Kim" } } });
  });
});
