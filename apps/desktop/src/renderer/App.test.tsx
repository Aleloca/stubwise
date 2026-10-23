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
  });
});
