import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { resetApi, setLatency } from "./data/api";

describe("App", () => {
  beforeEach(() => {
    setLatency(0);
    resetApi();
  });

  it("monta l'app sulla Home, con le tre zone", async () => {
    const { container } = render(<App history={createMemoryHistory({ initialEntries: ["/"] })} />);
    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    for (const zone of ["rail", "column", "work"]) {
      expect(container.querySelector(`[data-zone="${zone}"]`)).not.toBeNull();
    }
    // La riga della griglia limita l'altezza del binario: senza, la zona in
    // fondo (campanella, ⌘K, profilo) può uscire dalla finestra.
    const grid = container.querySelector('[data-zone="rail"]')!.parentElement!;
    expect(grid.classList).toContain("grid-rows-[minmax(0,1fr)]");
    expect(grid.classList).toContain("bg-ground");
  });
});
