import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { drive, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";

// Registro, A11 r.1414, lotto 3 (Drive), nel prototipo: chi ha nascosto un
// file, se chi guarda non lo conosce, è `hidden-<n>`. Chi l'ha aggiunto
// anche (scelta A di 46): il filtro «aggiunto da» si fa con un id vero, e un
// segnaposto nel filtro è `invalid`.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("il Drive senza id di chi non si conosce (r.1414)", () => {
  it("chi ha nascosto un file: segnaposto", async () => {
    const visible = visibleProjectIds(LAURA);
    const file = state.driveFiles.find((f) => visible.has(f.projectId))!;
    expect(file).toBeDefined();
    const [who] = strangersTo(LAURA);
    file.hidden = true;
    state.driveHidden.set(file.id, { personId: who!, at: "2026-11-20T10:00:00Z" });
    setSessionPersonId(LAURA);
    const rows = await drive.listDriveFiles({
      projectId: file.projectId,
      hidden: true,
      sort: "name",
    } as never);
    const row = rows.find((r) => r.id === file.id)!;
    expect(row).toBeDefined();
    expect(row.hiddenBy!.personId).toBe("hidden-1");
    expect(JSON.stringify(rows)).not.toContain(who!);
  });

  it("chi ha aggiunto un file: segnaposto; il filtro con un segnaposto è invalid, con l'id vero no", async () => {
    const visible = visibleProjectIds(LAURA);
    const file = state.driveFiles.find((f) => visible.has(f.projectId) && !f.hidden)!;
    const [who] = strangersTo(LAURA);
    file.addedById = who!;
    setSessionPersonId(LAURA);
    const rows = await drive.listDriveFiles({ projectId: file.projectId, sort: "name" } as never);
    expect(rows.find((r) => r.id === file.id)!.addedById).toBe("hidden-1");
    expect(JSON.stringify(rows)).not.toContain(who!);
    const err = await drive
      .listDriveFiles({ projectId: file.projectId, sort: "name", addedById: "hidden-1" } as never)
      .then(
        () => null,
        (e: Error) => e.message,
      );
    expect(err).toBe("invalid: addedById");
    const mine = await drive.listDriveFiles({
      projectId: file.projectId,
      sort: "name",
      addedById: LAURA,
    } as never);
    expect(mine.every((r) => r.addedById === LAURA)).toBe(true);
  });
});
