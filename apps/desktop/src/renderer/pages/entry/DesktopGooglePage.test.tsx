import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { renderRoute } from "../../test/renderRoute";

// Lotto 4, §6: la pagina dell'istanza su cui il callback di Google porta il
// browser quando il collegamento è partito dal desktop
// (`/#/desktop-google?outcome&state`). Dice l'esito con i testi del
// dialogo e riapre l'app con `stubwise://google?outcome=…&state=…`: SOLO quei
// due parametri, e solo se validi. Nessuna sessione richiesta.

const STATE = "rs-0123456789abcdef";
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApi();
  setLatency(0);
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => vi.restoreAllMocks());

describe("/desktop-google", () => {
  it("un esito negativo: lo dice, e riapre l'app con esito e state soltanto", async () => {
    renderRoute(`/desktop-google?outcome=domain_mismatch&state=${STATE}&code=secret`);
    expect(
      await screen.findByRole("heading", { name: "The mailbox wasn't connected" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not on a domain of the chosen Workspace/)).toBeInTheDocument();
    expect(assign).toHaveBeenCalledWith(`stubwise://google?outcome=domain_mismatch&state=${STATE}`);
  });

  // Revisione del lotto 4, M-2: un link con `outcome=ok` lo può forgiare
  // chiunque; la pagina non afferma «collegata», rimanda all'app, che lo
  // conferma rileggendo le caselle.
  it("`ok`: un testo neutro, non «collegata», e riapre l'app", async () => {
    renderRoute(`/desktop-google?outcome=ok&state=${STATE}`);
    expect(
      await screen.findByRole("heading", { name: "Go back to the app to see the result" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).toBeNull();
    expect(assign).toHaveBeenCalledWith(`stubwise://google?outcome=ok&state=${STATE}`);
  });

  it("un esito fuori elenco, anche con lo state buono: nessun ritorno all'app", async () => {
    renderRoute(`/desktop-google?outcome=granted&state=${STATE}`);
    expect(
      await screen.findByRole("heading", { name: "This link isn't valid" }),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("uno state non valido: nessun ritorno all'app", async () => {
    renderRoute("/desktop-google?outcome=ok&state=x");
    expect(
      await screen.findByRole("heading", { name: "This link isn't valid" }),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
