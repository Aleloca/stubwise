import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency, vault } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { setVaultClipboard } from "../../data/vault/index";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// La finestra dell'associazione (lotto 10, shape `vault.md` §3 [VA 8]): un
// dialogo con l'impronta grande e i tre passi (il secondo dice di SCRIVERE
// nel browser gli ultimi 4 caratteri, M3 della seconda revisione), «Waiting
// for the browser…», poi l'esito: riuscita (la cassaforte è già aperta,
// D-1b) o fallita in parola con «Try again». Il ritorno dal browser, nel
// prototipo, lo simula `finishPairing` (il riquadro «Prototype only»).

let clip = "";
beforeEach(async () => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
  // Laura senza questo Mac associato.
  setSessionPersonId("p-laura");
  await vault.forgetThisMac();
});
afterEach(() => act(() => setLanguage("en")));

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderRoute("/p/ACQ/credentials", "p-laura");
  await user.click(await screen.findByRole("button", { name: "Pair this Mac" }));
  return within(await screen.findByRole("dialog", { name: "Pair this Mac" }));
}

const fingerprintIn = (d: ReturnType<typeof within>) =>
  d.getByTestId("pairing-fingerprint").textContent ?? "";

describe("la finestra dell'associazione", () => {
  it("l'impronta grande, i tre passi col codice da scrivere nel browser, l'attesa", async () => {
    const user = userEvent.setup();
    const d = await openDialog(user);
    await waitFor(() => expect(fingerprintIn(d)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/));
    const last4 = fingerprintIn(d).replace(/\s/g, "").slice(-4);
    expect(d.getByText("The browser opens Stubwise.")).toBeInTheDocument();
    expect(
      d.getByText(`Type the last 4 characters of this key there (${last4}).`),
    ).toBeInTheDocument();
    expect(d.getByText(/Waiting for the browser…/)).toBeInTheDocument();
  });

  it("riuscita: «This Mac opens your vault.», e la barra è già aperta (D-1b)", async () => {
    const user = userEvent.setup();
    const d = await openDialog(user);
    await d.findByText(/Waiting for the browser…/);
    await act(async () => {
      await vault.finishPairing("ok");
    });
    expect(await d.findByText("This Mac opens your vault.")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Pair this Mac" })).toBeNull();
    expect(await screen.findByText(/locks after 15 minutes/)).toBeInTheDocument();
  });

  it("scaduta o che non corrisponde: la frase e Try again, con un'impronta nuova", async () => {
    const user = userEvent.setup();
    const d = await openDialog(user);
    await d.findByText(/Waiting for the browser…/);
    const first = fingerprintIn(d);
    await act(async () => {
      await vault.finishPairing("expired");
    });
    expect(await d.findByText("The pairing expired. Start again.")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Try again" }));
    await d.findByText(/Waiting for the browser…/);
    await waitFor(() => expect(fingerprintIn(d)).not.toBe(first));
    await act(async () => {
      await vault.finishPairing("mismatch");
    });
    expect(
      await d.findByText(
        "The browser's answer didn't match this Mac. Nothing was saved. Start again.",
      ),
    ).toBeInTheDocument();
  });

  it("Cancel chiude e dimentica la richiesta: un ritorno dopo non associa", async () => {
    const user = userEvent.setup();
    const d = await openDialog(user);
    await d.findByText(/Waiting for the browser…/);
    await user.click(d.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Pair this Mac" })).toBeNull();
    await act(async () => {
      expect(await vault.finishPairing("ok")).toEqual({ ok: false, code: "no_pending" });
    });
    expect(screen.getByRole("button", { name: "Pair this Mac" })).toBeInTheDocument();
  });

  // Review M6: chiudere mentre l'associazione si sta ancora chiedendo la
  // annulla lo stesso (il main può averla già aperta).
  it("M6: Cancel mentre si chiede l'associazione: un ritorno dopo non associa", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/credentials", "p-laura");
    const pair = await screen.findByRole("button", { name: "Pair this Mac" });
    // La richiesta dell'associazione è lenta: il dialogo resta in «starting».
    setLatency(300);
    await user.click(pair);
    const d = within(await screen.findByRole("dialog", { name: "Pair this Mac" }));
    expect(d.getByText("Asking Stubwise…")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Cancel" }));
    // La richiesta in volo ha già il suo ritardo; l'annullamento che segue no.
    setLatency(0);
    await new Promise((r) => setTimeout(r, 600));
    await act(async () => {
      expect(await vault.finishPairing("ok")).toEqual({ ok: false, code: "no_pending" });
    });
  });

  // Quarta revisione, punto 6: anche uno smontaggio (si cambia pagina col
  // dialogo aperto) annulla, non solo Cancel.
  it("smontato mentre si chiede l'associazione: un ritorno dopo non associa", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/credentials", "p-laura");
    const pair = await screen.findByRole("button", { name: "Pair this Mac" });
    setLatency(300);
    await user.click(pair);
    await screen.findByRole("dialog", { name: "Pair this Mac" });
    await act(async () => {
      await router.navigate({ to: "/home" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pair this Mac" })).toBeNull());
    setLatency(0);
    await new Promise((r) => setTimeout(r, 600));
    await act(async () => {
      expect(await vault.finishPairing("ok")).toEqual({ ok: false, code: "no_pending" });
    });
  });

  it("smontato durante l'attesa del browser: un ritorno dopo non associa", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/credentials", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Pair this Mac" }));
    const d = within(await screen.findByRole("dialog", { name: "Pair this Mac" }));
    await d.findByText(/Waiting for the browser…/);
    await act(async () => {
      await router.navigate({ to: "/home" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pair this Mac" })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    await act(async () => {
      expect(await vault.finishPairing("ok")).toEqual({ ok: false, code: "no_pending" });
    });
  });
});
