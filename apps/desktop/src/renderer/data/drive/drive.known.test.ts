import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { drive, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";

// Registro, A11 r.1414, lotto 3 (Drive), nel prototipo: chi ha nascosto un
// file, se chi guarda non lo conosce, è `hidden-<n>`. (Chi l'ha aggiunto è
// a parte: la pagina ne fa un filtro che la lettura esegue, scelta chiesta
// a 46 insieme ai filtri salvati.)

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
});
