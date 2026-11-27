import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// Amministrazione → una persona, la parte «Vault» (lotto 10, D-6, shape
// `vault.md` §3): solo per un full admin, i Mac della persona che aprono la
// cassaforte (senza impronta) e «Remove…» per riga, con un dialogo che dice
// le conseguenze, una per riga, poi la riconferma.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(() => act(() => setLanguage("en")));

const part = async () => within(await screen.findByRole("region", { name: "Vault" }));

describe("la parte Vault nella pagina di una persona", () => {
  it("full admin: i Mac della persona, senza impronta", async () => {
    renderRoute("/admin/people/p-laura", "p-roberta");
    const p = await part();
    expect(p.getByText("Laura Costa's Macs that open the vault")).toBeInTheDocument();
    expect(p.getByText("MacBook Pro di Laura")).toBeInTheDocument();
    expect(p.getByText("iMac in ufficio")).toBeInTheDocument();
    expect(p.queryByText("91be 4c07 2a3f d6e5")).toBeNull();
  });

  it("Remove…: il dialogo con le conseguenze, Remove, la riconferma, poi il toast", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-laura", "p-roberta");
    const p = await part();
    await user.click(p.getByRole("button", { name: "Remove iMac in ufficio…" }));
    const d = within(
      await screen.findByRole("dialog", {
        name: "Remove Laura Costa's iMac in ufficio from the vault?",
      }),
    );
    expect(d.getByText("That Mac stops opening the vault.")).toBeInTheDocument();
    expect(d.getByText("Laura Costa stays signed in on it.")).toBeInTheDocument();
    expect(
      d.getByText("Laura Costa gets a security alert, and it's recorded in the change log."),
    ).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Remove" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Code"), "123456");
    expect(await screen.findByText("Removed. Laura Costa was told.")).toBeInTheDocument();
    await waitFor(() => expect(p.queryByText("iMac in ufficio")).toBeNull());
  });

  it("chi non è full admin non vede la parte", async () => {
    renderRoute("/admin/people/p-laura", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Laura Costa" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Vault" })).toBeNull();
  });

  // Nell'app la lista dei Mac di un'altra persona è del browser [VA 9]: la
  // parte c'è (al full admin) con una riga che apre lì la pagina della
  // persona, senza chiedere niente alla cassaforte.
  it("nell'app desktop: «Manage … Macs in the browser» apre la pagina della persona nella NUOVA app", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const openWeb = vi.fn(async () => ({ ok: true }));
    // Il ponte del preload (`api`): è l'app desktop, col PAT.
    vi.stubGlobal("stubwise", { openWeb, api: {} });
    const spy = vi.spyOn(vault, "listMacsOf");
    // Nella build «app» chi guarda è la persona della sessione del livello dati.
    setSessionPersonId("p-roberta");
    try {
      const user = userEvent.setup();
      renderRoute("/admin/people/p-laura", "p-roberta");
      const p = await part();
      await user.click(p.getByRole("button", { name: "Manage Laura Costa's Macs in the browser" }));
      // Ritiro del web vecchio (inventario 1.2): il web vecchio quella pagina non ce l'ha.
      expect(openWeb).toHaveBeenCalledWith("/app/#/admin/people/p-laura");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("nella nuova app nel browser (senza ponte): la lista dei Mac si legge qui, come nel prototipo", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const spy = vi.spyOn(vault, "listMacsOf");
    setSessionPersonId("p-roberta");
    try {
      renderRoute("/admin/people/p-laura", "p-roberta");
      await part();
      await waitFor(() => expect(spy).toHaveBeenCalledWith("p-laura"));
      expect(screen.queryByRole("button", { name: "Manage Laura Costa's Macs in the browser" })).toBeNull();
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
