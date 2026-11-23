import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi } from "../api";
import { PEOPLE } from "../seed/people";
import { isFullAdmin } from "./index";
import { personMasker } from "./hidden";
import { knownPeopleFor } from "./whoCan";

// Il segnaposto (registro, A11 r.1414; forma in docs/invariants/permissions.md):
// l'id di una persona che chi guarda non conosce diventa `hidden-<n>`, stabile
// dentro la stessa risposta (lo stesso masker), mai fra due.

const LAURA = "p-laura";

beforeEach(() => resetApi());
afterEach(() => resetApi());

const strangersOf = (viewer: string) =>
  PEOPLE.filter((p) => p.id !== "p-claude" && p.id !== viewer && !knownPeopleFor(viewer).has(p.id));
/** Chi guarda e due persone che non conosce (dal seme, senza nomi scritti a mano). */
const viewerWithTwo = () => {
  const viewer = PEOPLE.find((p) => !isFullAdmin(p.id) && strangersOf(p.id).length >= 2)!;
  expect(viewer).toBeDefined();
  const [a, b] = strangersOf(viewer.id);
  return { viewer: viewer.id, a: a!, b: b! };
};

describe("personMasker", () => {
  it("chi si conosce, chi guarda e Claude restano col loro id", () => {
    const mask = personMasker(LAURA);
    expect(mask(LAURA)).toBe(LAURA);
    expect(mask("p-claude")).toBe("p-claude");
    const known = [...knownPeopleFor(LAURA)].find((id) => id !== LAURA)!;
    expect(mask(known)).toBe(known);
  });

  it("uno sconosciuto diventa hidden-<n>, lo stesso per tutta la risposta", () => {
    const { viewer, a, b } = viewerWithTwo();
    const mask = personMasker(viewer);
    expect(mask(a.id)).toBe("hidden-1");
    expect(mask(b.id)).toBe("hidden-2");
    expect(mask(a.id)).toBe("hidden-1");
  });

  it("una risposta nuova ricomincia: il segnaposto non è un id", () => {
    const { viewer, a, b } = viewerWithTwo();
    const first = personMasker(viewer);
    first(a.id);
    const second = personMasker(viewer);
    expect(second(b.id)).toBe("hidden-1");
  });

  it("null e un id che non è una persona passano com'erano", () => {
    const mask = personMasker(LAURA);
    expect(mask(null)).toBeNull();
    expect(mask("system")).toBe("system");
  });
});
