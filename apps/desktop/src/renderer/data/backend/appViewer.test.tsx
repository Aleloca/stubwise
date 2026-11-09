import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithData } from "../../test/renderWithData";
import { resetApi } from "../api";
import { useViewer } from "../viewer";

function Who() {
  const { viewer } = useViewer();
  return <p>viewer:{viewer.personId}</p>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetApi();
});

describe("ViewerProvider nella build app", () => {
  it("monta i figli solo quando il livello dati ha dato persona e permessi", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const { client } = renderWithData(<Who />);
    expect(screen.queryByText(/viewer:/)).toBeNull();
    // Sul finto (alias dei test) la sessione è la persona di default.
    expect(await screen.findByText("viewer:p-giulia")).toBeInTheDocument();
    expect(client.getQueryData(["viewer", "p-giulia"])).toBeDefined();
  });

  it("nel prototipo i figli rendono subito, senza query", () => {
    const { client } = renderWithData(<Who />, { personId: "p-laura" });
    expect(screen.getByText("viewer:p-laura")).toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
