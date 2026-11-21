import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import type { ProductBlock, ProductBlockOp, RichText } from "../../../data/types";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { placeCaret } from "./domRange";

// «Mostra le due versioni» (21 nov 2026, maintainer via orchestratrice;
// shape product-editor.md, emendamento omonimo): una scrittura rifiutata
// perché la pagina è cambiata (`invalid: …`, `stale`) o perché la sezione la
// tiene un altro (`section_busy`) non si perde in silenzio. Sotto il blocco,
// la versione propria non salvata, con «Use mine» e «Discard». Laura scrive
// in Sign-in di ACQ, Marco scrive da un copione.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SIGNIN = "ACQ-D5";
const LOGIN_ID = "blk-acq-signin-4";
const BEFORE_LOGIN = "blk-acq-signin-3";
const LOGIN = "Login only with Google";

const signIn = () => state.productPages.find((p) => p.code === SIGNIN)!;
const loginBlock = () =>
  signIn().blocks.find((b) => b.id === LOGIN_ID) as Extract<ProductBlock, { content: RichText }>;

function seedLogin() {
  const page = signIn();
  page.blocks = page.blocks.map((b) =>
    b.id === LOGIN_ID
      ? ({ id: LOGIN_ID, type: "paragraph", content: plain(LOGIN) } as ProductBlock)
      : b,
  );
}

async function openSignIn() {
  renderRoute(`/p/ACQ/docs/product/${SIGNIN}`, LAURA);
  await screen.findByRole("heading", { level: 1, name: "Sign-in" });
}

const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const shellOf = (id: string) => body().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;
const announced = () => document.querySelector("[data-marks-announce]")?.textContent ?? "";
const bar = () => screen.findByRole("alert");
const ownBox = () =>
  within(body()).queryByRole("group", {
    name: /^(Your version, not saved|La tua versione, non salvata)$/,
  });

async function enter(text: string, at: number) {
  const user = userEvent.setup();
  await user.click(textbox(text));
  await waitFor(() => expect(editing()).toHaveTextContent(text));
  act(() => placeCaret(editing(), at));
  return editing();
}
function input(el: HTMLElement, inputType: string, data: string | null = null) {
  act(() => {
    el.dispatchEvent(
      new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }),
    );
  });
}
const leave = (el: HTMLElement) => act(() => el.blur());
const busy = (name: string) => Object.assign(new Error("section_busy"), { by: name });

let saves: MockInstance<typeof api.productDocs.saveProductBlocks>;
const savedOps = () => saves.mock.calls.map((c) => c[1] as ProductBlockOp[]);

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

/** Laura aggiunge «!» in fondo al paragrafo, e la scrittura è rifiutata con `error`. */
async function refusedEdit(error: Error) {
  seedLogin();
  await openSignIn();
  saves.mockRejectedValueOnce(error);
  const el = await enter(LOGIN, LOGIN.length);
  input(el, "insertText", "!");
  leave(el);
  await waitFor(() => expect(ownBox()).not.toBeNull());
}

describe("la pagina era cambiata", () => {
  it("sotto il paragrafo (com'è nella pagina) la versione propria; la barra dice dove guardare, senza Retry", async () => {
    await refusedEdit(new Error("invalid: stale"));
    const alert = await bar();
    expect(alert).toHaveTextContent(
      "Couldn't save a change: the page had changed. Your version is under the paragraph.",
    );
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
    const box = ownBox()!;
    expect(shellOf(LOGIN_ID)).toContainElement(box);
    expect(box).toHaveTextContent("Your version, not saved");
    expect(box).toHaveTextContent(`${LOGIN}!`);
    expect(within(box).getByRole("button", { name: "Use mine" })).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(textbox(LOGIN)).toBeTruthy();
  });

  it("«Use mine»: una scrittura nuova col testo proprio (stesso blocco), il riquadro se ne va, il fuoco nel paragrafo", async () => {
    await refusedEdit(new Error("invalid: stale"));
    const user = userEvent.setup();
    await user.click(within(ownBox()!).getByRole("button", { name: "Use mine" }));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(savedOps()[1]).toEqual([
      { op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain(`${LOGIN}!`) } },
    ]);
    await waitFor(() => expect(loginBlock().content.text).toBe(`${LOGIN}!`));
    expect(ownBox()).toBeNull();
    expect(announced()).toBe("Your version is back in the paragraph");
    await waitFor(() => expect(editing()).toHaveTextContent(`${LOGIN}!`));
  });

  it("«Discard»: il riquadro se ne va e niente si scrive; il fuoco va al paragrafo", async () => {
    await refusedEdit(new Error("invalid: stale"));
    const user = userEvent.setup();
    await user.click(within(ownBox()!).getByRole("button", { name: "Discard" }));
    expect(ownBox()).toBeNull();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(loginBlock().content.text).toBe(LOGIN);
    expect(announced()).toBe("Discarded your version");
    expect(shellOf(LOGIN_ID).contains(document.activeElement)).toBe(true);
  });

  it("resta uscendo dal blocco e scrivendo altrove", async () => {
    await refusedEdit(new Error("invalid: op"));
    const other = signIn().blocks.find((b) => b.id === BEFORE_LOGIN) as Extract<
      ProductBlock,
      { content: RichText }
    >;
    const el = await enter(other.content.text, 0);
    input(el, "insertText", "A ");
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(ownBox()).toHaveTextContent(`${LOGIN}!`);
  });

  it("se la pagina ha già lo stesso testo (l'altro ha scritto lo stesso) non c'è niente da mostrare", async () => {
    seedLogin();
    await openSignIn();
    saves.mockImplementationOnce(async () => {
      api.productDocs.writeProductBlocksAs(
        MARCO,
        signIn().id,
        [{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain(`${LOGIN}!`) } }],
        { sessionId: "script-marco" },
      );
      throw new Error("invalid: stale");
    });
    const el = await enter(LOGIN, LOGIN.length);
    input(el, "insertText", "!");
    leave(el);
    await bar();
    await waitFor(() => expect(textbox(`${LOGIN}!`)).toBeTruthy());
    expect(ownBox()).toBeNull();
  });

  it("una scrittura solo di struttura (dividere il paragrafo) non ha una versione da mostrare: la sola frase", async () => {
    seedLogin();
    await openSignIn();
    saves.mockRejectedValueOnce(new Error("invalid: stale"));
    const el = await enter(LOGIN, 5);
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    const alert = await bar();
    expect(alert).toHaveTextContent("Couldn't save a change: the page had changed");
    expect(alert).not.toHaveTextContent("Your version");
    expect(ownBox()).toBeNull();
  });
});

describe("la sezione la tiene un altro", () => {
  it("la frase col nome e la versione propria; «Use mine» rifiutato di nuovo: il riquadro torna, con la stessa versione", async () => {
    await refusedEdit(busy("Marco Bellini"));
    expect(await bar()).toHaveTextContent(
      "Couldn't save a change: Marco Bellini is writing in this section. Your version is under the paragraph.",
    );
    saves.mockRejectedValueOnce(busy("Marco Bellini"));
    const user = userEvent.setup();
    await user.click(within(ownBox()!).getByRole("button", { name: "Use mine" }));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ownBox()).toHaveTextContent(`${LOGIN}!`));
    expect(loginBlock().content.text).toBe(LOGIN);
  });
});

describe("il paragrafo tolto da un altro mentre lo si scriveva", () => {
  it("la bozza non sparisce più: il riquadro dove il paragrafo era; «Use mine» lo rimette, con un id nuovo", async () => {
    seedLogin();
    await openSignIn();
    const el = await enter(LOGIN, LOGIN.length);
    input(el, "insertText", "!");
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
    leave(el);
    await waitFor(() => expect(ownBox()).not.toBeNull(), { timeout: 3000 });
    const box = ownBox()!;
    expect(box).toHaveTextContent("Your version, not saved · the paragraph was deleted");
    expect(box).toHaveTextContent(`${LOGIN}!`);
    expect(shellOf(BEFORE_LOGIN)).toContainElement(box);
    expect(await bar()).toHaveTextContent("Your version is under the paragraph.");
    const user = userEvent.setup();
    await user.click(within(box).getByRole("button", { name: "Use mine" }));
    await waitFor(() => expect(saves).toHaveBeenCalled());
    const ops = savedOps().at(-1)!;
    expect(ops).toHaveLength(1);
    const op = ops[0] as Extract<ProductBlockOp, { op: "insert" }>;
    expect(op).toMatchObject({
      op: "insert",
      afterId: BEFORE_LOGIN,
      block: { type: "paragraph", content: plain(`${LOGIN}!`) },
    });
    expect(op.block.id).not.toBe(LOGIN_ID);
    await waitFor(() =>
      expect(signIn().blocks.some((b) => "content" in b && b.content.text === `${LOGIN}!`)).toBe(
        true,
      ),
    );
    expect(ownBox()).toBeNull();
  });
});

describe("la bozza di un paragrafo già sparito dall'editor", () => {
  it("il salvataggio non parte nemmeno: la bozza resta da riprendere, dove il paragrafo era", async () => {
    seedLogin();
    await openSignIn();
    const el = await enter(LOGIN, LOGIN.length);
    input(el, "insertText", "!");
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
    // L'editor rilegge la pagina: il paragrafo se ne va prima che la bozza si salvi.
    await waitFor(() => expect(shellOf(LOGIN_ID)).toBeNull());
    await waitFor(() => expect(ownBox()).not.toBeNull(), { timeout: 3000 });
    expect(saves).not.toHaveBeenCalled();
    expect(ownBox()).toHaveTextContent(`${LOGIN}!`);
    expect(shellOf(BEFORE_LOGIN)).toContainElement(ownBox()!);
    expect(await bar()).toHaveTextContent(
      "Couldn't save a change: the page had changed. Your version is under the paragraph.",
    );
  });
});

describe("in italiano", () => {
  it("«La tua versione, non salvata», «Usa la mia», «Scarta» e la frase della barra", async () => {
    act(() => setLanguage("it"));
    await refusedEdit(new Error("invalid: stale"));
    expect(await bar()).toHaveTextContent(
      "Modifica non salvata: la pagina era cambiata. La tua versione è sotto il paragrafo.",
    );
    const box = ownBox()!;
    expect(box).toHaveTextContent("La tua versione, non salvata");
    expect(within(box).getByRole("button", { name: "Usa la mia" })).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Scarta" })).toBeInTheDocument();
  });
});
