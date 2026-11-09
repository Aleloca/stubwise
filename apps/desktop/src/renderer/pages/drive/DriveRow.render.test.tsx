import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { UPLOAD_PACE } from "./UploadZone";

// Quante volte si disegnano le righe: la riga vera, avvolta in un `memo`
// con lo stesso confronto (superficiale), conta i suoi render. Se un passo
// dell'avanzamento di un caricamento ridisegnasse l'elenco, il conto salirebbe.
const renders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./DriveRow", async (original) => {
  const real = await original<typeof import("./DriveRow")>();
  const Counted = memo(function Counted(props: ComponentProps<typeof real.DriveRow>) {
    renders.count += 1;
    return <real.DriveRow {...props} />;
  });
  return { ...real, DriveRow: Counted };
});

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  UPLOAD_PACE.ms = 1600;
});
afterEach(() => {
  UPLOAD_PACE.ms = 0;
});

const progress = () =>
  Number(screen.getByRole("progressbar").getAttribute("aria-valuenow") ?? "0");

describe("Drive — le righe non si ridisegnano mentre un caricamento avanza", () => {
  it("i passi dell'avanzamento (80 ms) non toccano le righe", async () => {
    renderRoute("/p/AUD/drive", "p-laura");
    await screen.findByRole("grid");
    const input = document.querySelector<HTMLInputElement>("[data-drive-file-input]")!;
    const file = new File(["x"], "lento.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 });
    await userEvent.upload(input, [file]);
    await screen.findByRole("progressbar");
    // Dal primo passo in poi, il conto delle righe resta fermo.
    await waitFor(() => expect(progress()).toBeGreaterThan(0));
    const before = renders.count;
    const at = progress();
    await waitFor(() => expect(progress()).toBeGreaterThan(at + 10));
    expect(renders.count).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
});
