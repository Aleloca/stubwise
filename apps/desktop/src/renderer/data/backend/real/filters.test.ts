import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID } from "./fakeServer";
import {
  deleteFilter,
  getSavedFilter,
  listPinnedFilterIds,
  listSavedFilters,
  saveFilter,
  setFilterPinned,
  updateFilter,
} from "./filters";

// I filtri salvati della build app (integrazione area 2, fetta 3, Task L).

const FILTER = "88888888-8888-4888-8888-888888888888";
const AT = "2026-11-01T09:00:00.000Z";

const serverFilter = (over: Record<string, unknown> = {}) => ({
  id: FILTER,
  name: "Open",
  ownerId: null,
  visibility: "public",
  criteria: { families: ["todo", "active"] },
  view: "list",
  groupBy: "none",
  canEdit: false,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i filtri dal server", () => {
  it("i criteri si normalizzano: un criterio sconosciuto si scarta; canEdit e autore come li dice il server", async () => {
    installFakeServer({
      "GET /api/filters": {
        body: [serverFilter({ criteria: { families: ["todo"], __future__: 1, sizes: "nope" } })],
      },
    });
    expect(await listSavedFilters()).toEqual([
      {
        id: FILTER,
        name: "Open",
        ownerId: null,
        visibility: "public",
        criteria: { families: ["todo"] },
        view: "list",
        groupBy: "none",
        canEdit: false,
      },
    ]);
  });

  it("un filtro che non vedo (404) è null", async () => {
    installFakeServer({ [`GET /api/filters/${FILTER}`]: { status: 404, body: { code: "not_found", message: "x" } } });
    expect(await getSavedFilter(FILTER)).toBeNull();
  });

  it("salva, modifica, elimina", async () => {
    const { seen } = installFakeServer({
      "POST /api/filters": { body: serverFilter({ ownerId: ME_ID, visibility: "private", canEdit: true }) },
      [`PATCH /api/filters/${FILTER}`]: { body: serverFilter({ name: "Renamed", ownerId: ME_ID, canEdit: true }) },
      [`DELETE /api/filters/${FILTER}`]: { status: 204 },
    });
    const created = await saveFilter({
      name: "Open",
      visibility: "private",
      criteria: { projectIds: [PROJECT_ID] },
      view: "board",
      groupBy: "status",
    });
    expect(created).toMatchObject({ ownerId: ME_ID, canEdit: true });
    expect(seen[0]!.body).toEqual({
      name: "Open",
      visibility: "private",
      criteria: { projectIds: [PROJECT_ID] },
      view: "board",
      groupBy: "status",
    });
    expect((await updateFilter(FILTER, { name: "Renamed" })).name).toBe("Renamed");
    expect(seen[1]!.body).toEqual({ name: "Renamed" });
    await deleteFilter(FILTER);
    expect(seen.map((r) => r.method)).toEqual(["POST", "PATCH", "DELETE"]);
  });

  it("fissati nella colonna: elenco, fissa, togli", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/pinned-filters": { body: [FILTER] },
      [`PUT /api/me/pinned-filters/${FILTER}`]: { status: 204 },
      [`DELETE /api/me/pinned-filters/${FILTER}`]: { status: 204 },
    });
    expect(await listPinnedFilterIds()).toEqual([FILTER]);
    await setFilterPinned(FILTER, true);
    await setFilterPinned(FILTER, false);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/me/pinned-filters",
      `PUT /api/me/pinned-filters/${FILTER}`,
      `DELETE /api/me/pinned-filters/${FILTER}`,
    ]);
  });

  it("salvando i criteri, le chiavi che questa app non conosce restano", async () => {
    const { seen } = installFakeServer({
      [`GET /api/filters/${FILTER}`]: {
        body: serverFilter({ criteria: { families: ["todo"], __future__: { x: 1 }, sizes: "nope" }, canEdit: true }),
      },
      [`PATCH /api/filters/${FILTER}`]: { body: serverFilter({ canEdit: true }) },
    });
    await getSavedFilter(FILTER);
    await updateFilter(FILTER, { criteria: { families: ["active"] } });
    expect(seen.at(-1)!.body).toEqual({ criteria: { __future__: { x: 1 }, sizes: "nope", families: ["active"] } });
    // Un cambio che non tocca i criteri non li manda.
    await updateFilter(FILTER, { name: "Renamed" });
    expect(seen.at(-1)!.body).toEqual({ name: "Renamed" });
  });
});
