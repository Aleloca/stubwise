import { describe, expect, it } from "vitest";
import type { SavedFilter, Viewer } from "../../data/types";
import { canManageFilter } from "./FilterPage";

// Chi modifica ed elimina un filtro: l'autore o un full admin. Sul server vero
// lo dice la vista (`canEdit`) e il client lo legge, non lo deduce.

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  personId: "p-ada",
  instancePermissions: [],
  projectPermissions: {},
  departmentPermissions: {},
  ...over,
});
const filter = (over: Partial<SavedFilter> = {}): SavedFilter => ({
  id: "f1",
  name: "Open",
  ownerId: "p-ada",
  visibility: "public",
  criteria: {},
  view: "list",
  groupBy: "none",
  ...over,
});

describe("canManageFilter", () => {
  it("nel prototipo: l'autore o un full admin", () => {
    expect(canManageFilter(filter(), viewer())).toBe(true);
    expect(canManageFilter(filter({ ownerId: "p-other" }), viewer())).toBe(false);
    expect(
      canManageFilter(filter({ ownerId: "p-other" }), viewer({ instancePermissions: ["instance.full_admin"] })),
    ).toBe(true);
  });

  it("sul server vero decide canEdit, anche contro la regola del client", () => {
    expect(canManageFilter(filter({ canEdit: false }), viewer())).toBe(false);
    expect(canManageFilter(filter({ ownerId: null, canEdit: true }), viewer())).toBe(true);
  });
});
