import { act, screen, waitFor, within } from "@testing-library/react";
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

async function typeBang() {
  const user = userEvent.setup();
  await user.click(textbox(LOGIN));
  await waitFor(() => expect(editing()).toHaveTextContent(LOGIN));
  act(() => placeCaret(editing(), LOGIN.length));
  act(() => {
    editing().dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "!",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
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

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
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
    expect(await leaveDialog(4000)).toBeInTheDocument();
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

  it("niente in sospeso: la persona cambia subito", async () => {
    await openSignIn();
    await viewAsMarco();
    await waitFor(() => expect(getSessionPersonId()).toBe(MARCO));
    expect(noLeaveDialog()).toBeNull();
  });
});
