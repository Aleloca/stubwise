import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import uPlot from "uplot";
import { UPlotChart } from "./uplot-chart";

/**
 * Il wrapper non deve distruggere/ricreare l'istanza uPlot quando arrivano
 * SOLO nuovi dati (refetch: nuovo campione) — altrimenti il canvas svuotato per
 * un frame appare come uno sfarfallio. I dati si applicano con `setData`; la
 * ricreazione avviene solo a un cambio strutturale (serie/scala/range/altezza).
 */

// uPlot non gira in happy-dom: costruttore mockato con i metodi usati dal
// wrapper. Le spie sono hoisted così sono visibili dentro il factory di vi.mock.
const { setData, destroy, setSize } = vi.hoisted(() => ({
  setData: vi.fn(),
  destroy: vi.fn(),
  setSize: vi.fn(),
}));

vi.mock("uplot", () => ({
  default: vi.fn(() => ({ setData, destroy, setSize })),
}));

const line = (label: string, stroke: string): uPlot.Series => ({ label, stroke });

beforeEach(() => {
  vi.mocked(uPlot).mockClear();
  setData.mockClear();
  destroy.mockClear();
});

describe("UPlotChart", () => {
  it("nuovi dati con stessa struttura → setData, NON ricrea l'istanza", () => {
    const { rerender } = render(
      <UPlotChart data={[[1, 2], [10, 20]]} series={[{}, line("cpu", "#fff")]} />,
    );
    expect(uPlot).toHaveBeenCalledTimes(1);

    // Refetch: nuovo `data` e nuova REFERENCE di `series` ma struttura identica.
    rerender(
      <UPlotChart data={[[1, 2, 3], [10, 20, 30]]} series={[{}, line("cpu", "#fff")]} />,
    );

    // Nessuna ricreazione (niente flicker); dati applicati in-place.
    expect(uPlot).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(setData).toHaveBeenCalledWith([[1, 2, 3], [10, 20, 30]]);
  });

  it("cambio strutturale (serie diversa) → ricrea l'istanza", () => {
    const { rerender } = render(
      <UPlotChart data={[[1, 2], [10, 20]]} series={[{}, line("cpu", "#fff")]} />,
    );
    expect(uPlot).toHaveBeenCalledTimes(1);

    rerender(
      <UPlotChart data={[[1, 2], [10, 20]]} series={[{}, line("mem", "#000")]} />,
    );

    expect(uPlot).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
