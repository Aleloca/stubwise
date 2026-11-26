import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// Il riquadro «Prototype only» della cassaforte (lotto 10, shape `vault.md`
// §3): sotto la barra decide cosa succede al prossimo Touch ID e alla
// prossima apertura; l'esito del ritorno dal browser sta nel dialogo
// dell'associazione (modale: un riquadro fuori non si potrebbe toccare).
// Solo nel prototipo: niente si cifra davvero.

let clip = "";
beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});
afterEach(() => act(() => setLanguage("en")));

const box = async () =>
  within(await screen.findByRole("region", { name: "Prototype only: the vault" }));

describe("il riquadro Prototype only della cassaforte", () => {
  it("sotto la barra, con la frase; la scelta attiva è segnata", async () => {
    renderRoute("/p/ACQ/credentials", "p-laura");
    const b = await box();
    expect(
      b.getByText("This decides what happens next. Nothing is encrypted in the prototype."),
    ).toBeInTheDocument();
    const touch = b.getByRole("group", { name: "Next Touch ID:" });
    expect(within(touch).getByRole("button", { name: "Works" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Next Touch ID: «This Mac has no Touch ID» cambia la barra", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const b = await box();
    await user.click(
      within(b.getByRole("group", { name: "Next Touch ID:" })).getByRole("button", {
        name: "This Mac has no Touch ID",
      }),
    );
    expect(
      await screen.findByText(
        "Locked. This Mac has no Touch ID: open the vault in the browser with your passkey.",
      ),
    ).toBeInTheDocument();
  });

  it("Next opening: «Seal revoked», poi Open with Touch ID: la barra dice revocato", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const b = await box();
    await user.click(
      within(b.getByRole("group", { name: "Next opening:" })).getByRole("button", {
        name: "Seal revoked",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Open with Touch ID" }));
    expect(
      await screen.findByText("This Mac no longer opens the vault. You're still signed in."),
    ).toBeInTheDocument();
  });

  it("nel dialogo dell'associazione: «Return from the browser» chiude con la riuscita", async () => {
    const user = userEvent.setup();
    setSessionPersonId("p-laura");
    await vault.forgetThisMac();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Pair this Mac" }));
    const d = within(await screen.findByRole("dialog", { name: "Pair this Mac" }));
    await d.findByText(/Waiting for the browser…/);
    const proto = within(d.getByRole("region", { name: "Prototype only: pairing" }));
    await user.click(proto.getByRole("button", { name: "Return from the browser" }));
    expect(await d.findByText("This Mac opens your vault.")).toBeInTheDocument();
  });

  it("«Seal doesn't match» nel dialogo: la frase di quando non corrisponde", async () => {
    const user = userEvent.setup();
    setSessionPersonId("p-laura");
    await vault.forgetThisMac();
    renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Pair this Mac" }));
    const d = within(await screen.findByRole("dialog", { name: "Pair this Mac" }));
    await d.findByText(/Waiting for the browser…/);
    await user.click(
      within(d.getByRole("region", { name: "Prototype only: pairing" })).getByRole("button", {
        name: "Seal doesn't match",
      }),
    );
    await waitFor(() =>
      expect(
        d.getByText("The browser's answer didn't match this Mac. Nothing was saved. Start again."),
      ).toBeInTheDocument(),
    );
  });
});
