import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import type { DriveFilters } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { closePreview } from "./FilePreview";

// La rilettura del Drive mentre un file è in lettura (review del renderer
// della F3): una sola query si rilegge, la più stretta della vista — l'elenco
// del progetto aperto (o quello globale), oppure il dettaglio aperto — mai
// la colonna né la seconda query della pagina. Si contano le chiamate vere.

const calls = vi.hoisted(() => ({ list: [] as unknown[], detail: [] as unknown[] }));
vi.mock("@backend/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../data/api")>();
  return {
    ...real,
    drive: {
      ...real.drive,
      listDriveFiles: (filters: DriveFilters) => {
        calls.list.push(filters);
        return real.drive.listDriveFiles(filters);
      },
      getDriveFile: (ref: string) => {
        calls.detail.push(ref);
        return real.drive.getDriveFile(ref);
      },
    },
  };
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  // Un file che resta in lettura: il lavoro finto del prototipo non lo fa avanzare.
  const file = state.driveFiles.find((f) => f.id === "drv-aud-3")!;
  Object.defineProperty(file, "content", { get: () => "processing", set: () => undefined, configurable: true });
  calls.list.length = 0;
  calls.detail.length = 0;
});
afterEach(() => closePreview());

async function settle(url: string) {
  renderRoute(url, "p-laura");
  await screen.findByRole("heading", { level: 1, name: "Drive" });
  await pause(200);
  const list = calls.list.length;
  const detail = calls.detail.length;
  // Nel prototipo si rilegge ogni secondo: in 2,5 s due giri.
  await pause(2_500);
  return { list: calls.list.length - list, detail: calls.detail.length - detail, since: list };
}

describe("Drive — una sola rilettura per vista", () => {
  it("il Drive coi filtri si rilegge; la colonna e la seconda query della pagina no", async () => {
    // La colonna (tutti i file, per nome), la pagina (i filtri) e la sua seconda query (senza filtri).
    const { list, detail, since } = await settle("/drive?prj=AUD&type=image");
    expect(list).toBeGreaterThanOrEqual(2);
    expect(list).toBeLessThanOrEqual(3);
    expect(calls.list.slice(since)).toEqual(Array(list).fill(expect.objectContaining({ projectId: "prj-aud", type: "image" })));
    expect(detail).toBe(0);
  }, 10_000);

  it("nel Drive del progetto si rilegge il suo elenco", async () => {
    const { list, detail } = await settle("/p/AUD/drive");
    expect(list).toBeGreaterThanOrEqual(2);
    expect(list).toBeLessThanOrEqual(3);
    expect(detail).toBe(0);
  }, 10_000);

  it("col dettaglio aperto si rilegge il dettaglio, non l'elenco", async () => {
    const { list, detail } = await settle("/p/AUD/drive?file=AUD-F3");
    expect(list).toBe(0);
    expect(detail).toBeGreaterThanOrEqual(2);
    expect(detail).toBeLessThanOrEqual(3);
  }, 10_000);
});
