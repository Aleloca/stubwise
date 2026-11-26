import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// Preferenze → Security, «Macs that open the vault» (lotto 10, shape
// `vault.md` §3): i propri Mac con l'impronta INTERA (M7), «this Mac» sul
// corrente; «Forget this Mac» a due tempi; «Remove» di un altro proprio Mac
// da qui (VA-Q4) con la riconferma E la cassaforte aperta [VA 9]; vuoto con
// «Pair this Mac».

let clip = "";
beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});
afterEach(() => act(() => setLanguage("en")));

const part = async () =>
  within(await screen.findByRole("region", { name: "Macs that open the vault" }));
const rowOf = (p: ReturnType<typeof within>, name: string) =>
  within(p.getAllByRole("listitem").find((li: HTMLElement) => li.textContent?.includes(name))!);

describe("i Mac che aprono la cassaforte, in Security", () => {
  it("le righe con l'impronta intera e «this Mac» sul corrente", async () => {
    renderRoute("/preferences/security", "p-laura");
    const p = await part();
    expect(
      p.getByText("These Macs open your vault with Touch ID. Removing one doesn't sign it out."),
    ).toBeInTheDocument();
    const mbp = rowOf(p, "MacBook Pro di Laura");
    expect(mbp.getByText("this Mac")).toBeInTheDocument();
    expect(mbp.getByText("91be 4c07 2a3f d6e5")).toBeInTheDocument();
    const imac = rowOf(p, "iMac in ufficio");
    expect(imac.queryByText("this Mac")).toBeNull();
    expect(imac.getByText("0c6d b28e 73a1 5f94")).toBeInTheDocument();
  });

  it("Forget this Mac a due tempi: la riga sparisce", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", "p-laura");
    const p = await part();
    await user.click(
      rowOf(p, "MacBook Pro di Laura").getByRole("button", { name: "Forget this Mac" }),
    );
    expect(
      p.getByText("This Mac stops opening the vault. You stay signed in."),
    ).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(p.queryByText("MacBook Pro di Laura")).toBeNull());
  });

  it("Remove di un altro Mac: a due tempi, la riconferma, poi tolto con l'avviso", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", "p-laura");
    const p = await part();
    await user.click(rowOf(p, "iMac in ufficio").getByRole("button", { name: "Remove" }));
    expect(
      p.getByText("That Mac stops opening the vault. It stays signed in."),
    ).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Remove iMac in ufficio" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(dialog).getByLabelText("Code"), "123456");
    expect(await screen.findByText("Removed. You'll get a security alert.")).toBeInTheDocument();
    await waitFor(() => expect(p.queryByText("iMac in ufficio")).toBeNull());
  });

  it("senza Mac: «No Mac opens your vault yet.» e Pair this Mac apre l'associazione", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", "p-sara");
    const p = await part();
    expect(p.getByText("No Mac opens your vault yet.")).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Pair this Mac" }));
    expect(await screen.findByRole("dialog", { name: "Pair this Mac" })).toBeInTheDocument();
  });
});
