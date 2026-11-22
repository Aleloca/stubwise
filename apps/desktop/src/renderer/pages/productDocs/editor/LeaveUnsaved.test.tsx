import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { getSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { ProductBlock } from "../../../data/types";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { LEAVE_WAIT_MS } from "./BlockEditor";
import { placeCaret } from "./domRange";

// «Some changes aren't saved yet» · Stay · Leave without saving (shape
// product-editor.md §3.12; costruito il 21 nov 2026 su richiesta del
// maintainer via orchestratrice): uscire dalla pagina, o cambiare persona,
// con qualcosa che non è salvato chiede prima. Non salvato = una scrittura
// ancora in fila o ferma su un errore, una bozza che non arriva in tempo, il
// riquadro di «Mostra le due versioni». All'uscita le bozze partono e si
// aspetta un poco la fila: se si svuota, si esce senza chiedere.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SIGNIN = "ACQ-D5";
const LOGIN_ID = "blk-acq-signin-4";
const LOGIN = "Login only with Google";

const signIn = () => state.productPages.find((p) => p.code === SIGNIN)!;
/** Il testo del paragrafo di Login com'è adesso nella pagina. */
const textOfLogin = () =>
  (signIn().blocks.find((b) => b.id === LOGIN_ID) as { content: { text: string } }).content.text;
const billsCode = () => state.productPages.find((p) => p.id === "pp-acq-bills")!.code;

function seedLogin() {
  const page = signIn();
  page.blocks = page.blocks.map((b) =>
    b.id === LOGIN_ID
      ? ({ id: LOGIN_ID, type: "paragraph", content: plain(LOGIN) } as ProductBlock)
      : b,
  );
}

let router: ReturnType<typeof renderRoute>;
async function openSignIn() {
  seedLogin();
  router = renderRoute(`/p/ACQ/docs/product/${SIGNIN}`, LAURA);
  await screen.findByRole("heading", { level: 1, name: "Sign-in" });
}
// Senza `act`: con il dialogo la navigazione resta in attesa della risposta.
const goToBills = () => {
  void router.navigate({ to: `/p/ACQ/docs/product/${billsCode()}` });
};

const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;
const ownBox = () => within(body()).queryByRole("group", { name: "Your version, not saved" });
const leaveDialog = (timeout?: number) =>
  screen.findByRole(
    "dialog",
    { name: "Some changes aren't saved yet" },
    timeout ? { timeout } : undefined,
  );
const noLeaveDialog = () => screen.queryByRole("dialog", { name: "Some changes aren't saved yet" });

/** Un carattere in fondo al blocco che ha il fuoco. */
function typeChar(data: string) {
  const el = editing();
  act(() => placeCaret(el, (el.textContent ?? "").length));
  act(() => {
    el.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data, bubbles: true, cancelable: true }),
    );
  });
}

async function typeBang(text = LOGIN, data = "!") {
  const user = userEvent.setup();
  await user.click(textbox(text));
  await waitFor(() => expect(editing()).toHaveTextContent(text));
  typeChar(data);
  return editing();
}

/** Laura scrive «!» e la scrittura è rifiutata con `error`. */
async function refused(error: Error) {
  await openSignIn();
  saves.mockRejectedValueOnce(error);
  const el = await typeBang();
  act(() => el.blur());
}

let saves: MockInstance<typeof api.productDocs.saveProductBlocks>;
let realSave: typeof api.productDocs.saveProductBlocks;
/** La scrittura vera, che arriva dopo `ms`. */
const slowSave =
  (ms: number) =>
  (...a: Parameters<typeof api.productDocs.saveProductBlocks>) =>
    new Promise<Awaited<ReturnType<typeof api.productDocs.saveProductBlocks>>>((done, fail) => {
      setTimeout(() => realSave(...a).then(done, fail), ms);
    });

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  realSave = api.productDocs.saveProductBlocks.bind(api.productDocs);
  saves = vi.spyOn(api.productDocs, "saveProductBlocks");
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("uscire dalla pagina", () => {
  it("col riquadro di «Mostra le due versioni»: il dialogo; «Stay» resta sulla pagina, col riquadro", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    goToBills();
    const dialog = await leaveDialog();
    expect(within(dialog).getByRole("button", { name: "Stay" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(noLeaveDialog()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Sign-in" })).toBeInTheDocument();
    expect(ownBox()).not.toBeNull();
  });

  it("«Leave without saving»: si va dove si andava, e la versione propria si perde", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    goToBills();
    const dialog = await leaveDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(noLeaveDialog()).toBeNull();
  });

  it("Esc è «Stay»", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    goToBills();
    await leaveDialog();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(noLeaveDialog()).toBeNull());
    expect(screen.getByRole("heading", { level: 1, name: "Sign-in" })).toBeInTheDocument();
  });

  it("una scrittura ferma su un errore («Couldn't save · Retry»): il dialogo", async () => {
    await refused(new Error("network"));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    goToBills();
    expect(await leaveDialog()).toBeInTheDocument();
  });

  it("una scrittura che non arriva in tempo: il dialogo", async () => {
    await openSignIn();
    saves.mockImplementationOnce(() => new Promise(() => {}));
    const el = await typeBang();
    act(() => el.blur());
    goToBills();
    expect(await leaveDialog(LEAVE_WAIT_MS + 2000)).toBeInTheDocument();
  });

  it("una bozza appena scritta (senza uscire dal blocco): parte, si salva, e si esce senza chiedere", async () => {
    await openSignIn();
    await typeBang();
    goToBills();
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(noLeaveDialog()).toBeNull();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(signIn().blocks.find((b) => b.id === LOGIN_ID)).toMatchObject({
      content: { text: `${LOGIN}!` },
    });
  });

  it("una bozza di un paragrafo che un altro ha tolto intanto: uscendo diventa la versione propria, e il dialogo", async () => {
    await openSignIn();
    await typeBang();
    act(() => {
      api.productDocs.writeProductBlocksAs(
        MARCO,
        signIn().id,
        [{ op: "delete", blockId: LOGIN_ID }],
        {
          sessionId: "script-marco",
        },
      );
    });
    goToBills();
    // La bozza parte (o diventa subito la versione propria, se la pagina è già riletta): il dialogo c'è comunque.
    expect(await leaveDialog()).toBeInTheDocument();
  });

  it("una scrittura che arriva dentro l'attesa (300 ms): si esce senza chiedere", async () => {
    await openSignIn();
    saves.mockImplementationOnce(slowSave(300));
    await typeBang();
    goToBills();
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(noLeaveDialog()).toBeNull();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(signIn().blocks.find((b) => b.id === LOGIN_ID)).toMatchObject({ content: { text: `${LOGIN}!` } });
  });

  it("revisione di R11-6, I1: il testo scritto durante l'attesa conta, e il dialogo lo dice", async () => {
    await openSignIn();
    saves.mockImplementationOnce(slowSave(300));
    await typeBang();
    goToBills();
    // Mentre la prima scrittura è in viaggio, Laura scrive ancora.
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    typeChar("?");
    expect(await leaveDialog(LEAVE_WAIT_MS + 2000)).toBeInTheDocument();
  });

  it("revisione di R11-6, I2: dopo «Leave without saving» la fila non manda più niente", async () => {
    await openSignIn();
    let release: () => void = () => undefined;
    saves.mockImplementationOnce(
      (...a) =>
        new Promise((done, fail) => {
          release = () => void realSave(...a).then(done, fail);
        }),
    );
    const el = await typeBang();
    act(() => el.blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    // Una seconda scrittura, in fila dietro quella in viaggio.
    const again = await typeBang(`${LOGIN}!`, "?");
    act(() => again.blur());
    goToBills();
    const dialog = await leaveDialog(LEAVE_WAIT_MS + 2000);
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it("revisione di R11-6, M7: il titolo scritto e non ancora uscito si salva uscendo", async () => {
    const rename = vi.spyOn(api.productDocs, "renameProductPage");
    await openSignIn();
    const h1 = screen.getByRole("heading", { level: 1, name: "Sign-in" });
    act(() => h1.focus());
    act(() => {
      h1.textContent = "Signing in";
      fireEvent.input(h1);
    });
    goToBills();
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(rename).toHaveBeenCalledWith(signIn().id, "Signing in");
  });

  it("revisione di R11-6, M1: la pagina tolta mentre chiede: si va dove si andava", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    goToBills();
    await leaveDialog();
    act(() => {
      api.productDocs.deleteProductPageAs(MARCO, signIn().id);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
  });

  it("revisione di R11-6, M6: un'immagine che sta caricando al posto di una bozza conta come non salvata", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(api.productDocs, "storeProductImage").mockImplementation(() => new Promise<string>(() => {}));
    const sketch = api.productDocs.drawWireframeAs(LAURA, signIn().id, { afterId: LOGIN_ID }).blockId;
    await openSignIn();
    await userEvent.click(
      within(body().querySelector<HTMLElement>(`[data-block-id="${sketch}"]`)!).getByRole("button", {
        name: "Replace with an image",
      }),
    );
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => {
      fireEvent.change(chooser, {
        target: { files: [new File([new Uint8Array(1024)], "s.png", { type: "image/png" })] },
      });
    });
    goToBills();
    expect(await leaveDialog(LEAVE_WAIT_MS + 2000)).toBeInTheDocument();
  });

  it("seconda revisione, I1: la pagina smontata senza passare dall'uscita (una rilettura in errore, la finestra chiusa): la bozza parte lo stesso", async () => {
    await openSignIn();
    await typeBang();
    // Smontare tutto: le pulizie vanno dal padre al figlio, come con PageError al posto della pagina.
    act(() => cleanup());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textOfLogin()).toBe(`${LOGIN}!`));
  });

  it("seconda revisione, I3: un'immagine che caricava non scrive dopo «Leave without saving»", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    let finish: () => void = () => undefined;
    vi.spyOn(api.productDocs, "storeProductImage").mockImplementation(
      () => new Promise<string>((done) => (finish = () => done("data:image/png;base64,c3RvcmVk"))),
    );
    const replace = vi.spyOn(api.productDocs, "replaceWireframeWithImage");
    const sketch = api.productDocs.drawWireframeAs(LAURA, signIn().id, { afterId: LOGIN_ID }).blockId;
    await openSignIn();
    await userEvent.click(
      within(body().querySelector<HTMLElement>(`[data-block-id="${sketch}"]`)!).getByRole("button", {
        name: "Replace with an image",
      }),
    );
    act(() => {
      fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
        target: { files: [new File([new Uint8Array(1024)], "s.png", { type: "image/png" })] },
      });
    });
    goToBills();
    const dialog = await leaveDialog(LEAVE_WAIT_MS + 2000);
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("niente in sospeso: si esce senza chiedere", async () => {
    await openSignIn();
    goToBills();
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(noLeaveDialog()).toBeNull();
  });

  it("restare sulla pagina (cambia solo la ricerca, un filo aperto) non chiede", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    void router.navigate({ to: ".", search: { comment: "nope" } as never });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ comment: "nope" }));
    expect(noLeaveDialog()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Sign-in" })).toBeInTheDocument();
  });

  it("in italiano: «Alcune modifiche non sono ancora salvate» · Resta · Esci senza salvare", async () => {
    act(() => setLanguage("it"));
    await refused(new Error("invalid: stale"));
    await waitFor(() =>
      expect(
        within(body()).queryByRole("group", { name: "La tua versione, non salvata" }),
      ).not.toBeNull(),
    );
    goToBills();
    const dialog = await screen.findByRole("dialog", {
      name: "Alcune modifiche non sono ancora salvate",
    });
    expect(within(dialog).getByRole("button", { name: "Resta" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Esci senza salvare" })).toBeInTheDocument();
  });
});

describe("cambiare persona («View as»)", () => {
  async function viewAsMarco() {
    await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    const group = within(menu).getByRole("radiogroup", { name: "View as" });
    await userEvent.click(within(group).getByRole("radio", { name: /Marco Bellini/ }));
  }

  it("col riquadro: il dialogo; «Stay» resta Laura, col riquadro", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    await viewAsMarco();
    const dialog = await leaveDialog();
    expect(getSessionPersonId()).toBe(LAURA);
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(getSessionPersonId()).toBe(LAURA);
    expect(ownBox()).not.toBeNull();
  });

  it("«Leave without saving»: la persona cambia", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    await viewAsMarco();
    await userEvent.click(
      within(await leaveDialog()).getByRole("button", { name: "Leave without saving" }),
    );
    await waitFor(() => expect(getSessionPersonId()).toBe(MARCO));
  });

  it("revisione di R11-6, M8: dalla palette, lo stesso dialogo; «Stay» resta Laura", async () => {
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search and commands" });
    // Nel Prodotto la ricerca è dello spazio: Tab la allarga a tutto.
    await user.keyboard("{Tab}");
    await user.type(within(palette).getByRole("combobox"), "view as");
    await within(palette).findByRole("option", { name: /View as…/, selected: true });
    await user.keyboard("{Enter}");
    await user.type(within(palette).getByRole("combobox"), "marco");
    await within(palette).findByRole("option", { name: /Marco/, selected: true });
    await user.keyboard("{Enter}");
    const dialog = await leaveDialog();
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(getSessionPersonId()).toBe(LAURA);
    expect(ownBox()).not.toBeNull();
  });

  it("revisione di R11-6, I2: dopo «Leave without saving» nessuna scrittura parte a nome di Marco", async () => {
    await openSignIn();
    let release: () => void = () => undefined;
    saves.mockImplementationOnce(
      (...a) =>
        new Promise((done, fail) => {
          release = () => void realSave(...a).then(done, fail);
        }),
    );
    const el = await typeBang();
    act(() => el.blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const again = await typeBang(`${LOGIN}!`, "?");
    act(() => again.blur());
    await viewAsMarco();
    await userEvent.click(
      within(await leaveDialog(LEAVE_WAIT_MS + 2000)).getByRole("button", { name: "Leave without saving" }),
    );
    await waitFor(() => expect(getSessionPersonId()).toBe(MARCO));
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it("niente in sospeso: la persona cambia subito", async () => {
    await openSignIn();
    await viewAsMarco();
    await waitFor(() => expect(getSessionPersonId()).toBe(MARCO));
    expect(noLeaveDialog()).toBeNull();
  });
});

describe("uscire dall'account (revisione di R11-6, M2)", () => {
  it("con il riquadro: «Sign out» chiede prima; «Stay» resta dentro", async () => {
    const logout = vi.spyOn(api.auth, "logout");
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    const dialog = await leaveDialog();
    expect(logout).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(logout).not.toHaveBeenCalled();
    expect(ownBox()).not.toBeNull();
  });

  it("seconda revisione, I2: «Leave without saving», poi l'uscita rifiutata: si scrive ancora, e si salva", async () => {
    vi.spyOn(api.auth, "logout").mockRejectedValue(new Error("network"));
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    await userEvent.click(within(await leaveDialog()).getByRole("button", { name: "Leave without saving" }));
    // Fuori non si è usciti: la pagina resta, e la sessione scrive.
    await waitFor(() => expect(ownBox()).toBeNull());
    await userEvent.keyboard("{Escape}");
    const el = await typeBang(textOfLogin(), "?");
    act(() => el.blur());
    await waitFor(() =>
      expect(textOfLogin()).toMatch(/\?$/),
    );
  });

  it("terza revisione, 1: «Leave», l'uscita rifiutata, una scrittura scartata ancora in viaggio: la nuova parte dopo, e resta", async () => {
    vi.spyOn(api.auth, "logout").mockRejectedValue(new Error("network"));
    await openSignIn();
    let release: () => void = () => undefined;
    saves.mockImplementationOnce(
      (...a) =>
        new Promise((done, fail) => {
          release = () => void realSave(...a).then(done, fail);
        }),
    );
    const el = await typeBang();
    act(() => el.blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    await userEvent.click(
      within(await leaveDialog(LEAVE_WAIT_MS + 2000)).getByRole("button", { name: "Leave without saving" }),
    );
    await userEvent.keyboard("{Escape}");
    const again = await typeBang(textOfLogin(), "?");
    act(() => again.blur());
    // La scrittura nuova aspetta quella in viaggio: non viaggiano insieme.
    await new Promise((r) => setTimeout(r, 50));
    expect(saves).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(textOfLogin()).toBe(`${LOGIN}?`));
  });

  it("«Leave without saving»: esce", async () => {
    const logout = vi.spyOn(api.auth, "logout");
    await refused(new Error("invalid: stale"));
    await waitFor(() => expect(ownBox()).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    await userEvent.click(within(await leaveDialog()).getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});
