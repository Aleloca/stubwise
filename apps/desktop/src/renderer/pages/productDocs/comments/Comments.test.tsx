import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { listNotifications, productDocs, resetApi, setLatency } from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { ProductBlock, RichText } from "../../../data/types";
import { plain, toggleMark } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { placeCaret } from "../editor/domRange";
import { commentsPrefKey } from "../SideColumn";

// Commenti, @menzioni e «Segui» nelle pagine di prodotto (area 11a, Task 10;
// shape product-comments-history.md). Laura (Project Lead di ACQ) scrive e
// commenta, Marco (Developer) è menzionato, Sara (Contributor) legge
// soltanto. Sign-in ha un filo aperto (Laura, con la risposta di Marco),
// Bills un filo risolto, Phases un filo su un passo tolto da Matteo.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const SIGNIN = "ACQ-D5";
const SIGNIN_ROOT = "pc-acq-signin-1";
const LOGIN_ID = "blk-acq-signin-4";
const LOGIN = "Login only with Google";

const pageByTitle = (title: string) => state.productPages.find((p) => p.title === title)!;
const signIn = () => pageByTitle("Sign-in");

function seedBlock(id: string, content: RichText | string) {
  const page = signIn();
  page.blocks = page.blocks.map((b) =>
    b.id === id
      ? ({ id, type: "paragraph", content: typeof content === "string" ? plain(content) : content } as ProductBlock)
      : b,
  );
}

async function open(code: string, person = LAURA, search = "") {
  const router = renderRoute(`/p/ACQ/docs/product/${code}${search}`, person);
  const title = state.productPages.find((p) => p.code === code)!.title;
  await screen.findByRole("heading", { level: 1, name: title });
  return router;
}

const bar = () =>
  screen.getByRole("navigation", { name: /^(Product pages of|Pagine di prodotto di) ACQ$/ });
const column = () => screen.findByRole("region", { name: /^(Comments|Commenti)$/ });
const queryColumn = () => screen.queryByRole("region", { name: /^(Comments|Commenti)$/ });
const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;

async function enter(text: string, at: number, to = at) {
  const user = userEvent.setup();
  await user.click(textbox(text));
  await waitFor(() => expect(editing()).toHaveTextContent(text));
  act(() => placeCaret(editing(), at, to));
  return editing();
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("commentare una frase", () => {
  it("Laura sceglie «only with Google» (in grassetto) → Comment → «@Mar» → Marco Bellini: il filo nella colonna con la frase senza segni; Marco ha la menzione", async () => {
    seedBlock(LOGIN_ID, toggleMark(plain(LOGIN), 6, 22, "bold"));
    await open(SIGNIN);
    const col = await column();
    await enter(LOGIN, 6, 22);
    const toolbar = await screen.findByRole("toolbar", { name: "Format the selection" });
    const user = userEvent.setup();
    await user.click(within(toolbar).getByRole("button", { name: "Comment" }));

    const box = await within(col).findByRole("combobox", { name: "Add a comment… Type @ to mention someone" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    // La frase citata, senza segni: nessun <strong> dentro.
    const quote = within(col).getByText("“only with Google”");
    expect(quote.querySelector("strong")).toBeNull();
    // Vuota, «Comment» è spento con la sua frase.
    const send = within(col).getByRole("button", { name: "Comment" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Write something first");

    await user.type(box, "@Mar");
    const menu = await screen.findByRole("listbox");
    expect(within(menu).getByText("People who can read ACQ's docs")).toBeInTheDocument();
    await user.click(within(menu).getByRole("option", { name: /Marco Bellini/ }));
    expect(box).toHaveValue("@Marco Bellini ");
    await user.type(box, "is this right?");
    expect(within(col).getByText("Marco Bellini will be notified.")).toBeInTheDocument();

    // Un doppio clic non scrive due volte: il secondo clic arriva prima del
    // nuovo disegno, e la casella lo ignora (in volo, e poi spenta).
    const add = vi.spyOn(api.productDocs, "addProductComment");
    const send2 = within(col).getByRole("button", { name: "Comment" });
    act(() => {
      fireEvent.click(send2);
      fireEvent.click(send2);
    });
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0]![1]).toEqual({ anchorId: LOGIN_ID, quote: "only with Google", body: "@Marco Bellini is this right?" });

    const thread = await within(col).findByRole("article", {
      name: "Comment by Laura Costa on “only with Google”",
    });
    await waitFor(() => expect(document.activeElement).toBe(thread));
    expect(within(thread).queryByText("Sentence deleted")).toBeNull();
    const made = state.productComments.find((c) => c.body === "@Marco Bellini is this right?")!;
    expect(made.quote).toBe("only with Google");
    // Il blocco ha il suo segno.
    expect(
      within(body().querySelector<HTMLElement>(`[data-block-id="${LOGIN_ID}"]`)!).getByRole("button", {
        name: "1 comment on this paragraph",
      }),
    ).toBeInTheDocument();

    setSessionPersonId(MARCO);
    const mentions = (await listNotifications()).filter(
      (n) => n.kind === "product_doc.mention" && n.link.endsWith(`?comment=${made.id}`),
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.link).toBe(`#/p/ACQ/docs/product/${SIGNIN}?comment=${made.id}`);
  });

  it("da tastiera: «⋮⋮» del blocco → Comment, con la frase intera", async () => {
    seedBlock(LOGIN_ID, LOGIN);
    await open(SIGNIN);
    const col = await column();
    const user = userEvent.setup();
    const shell = body().querySelector<HTMLElement>(`[data-block-id="${LOGIN_ID}"]`)!;
    await user.click(within(shell).getByRole("button", { name: /^Block menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Comment" }));
    await within(col).findByRole("combobox", { name: /Add a comment/ });
    expect(within(col).getByText(`“${LOGIN}”`)).toBeInTheDocument();
  });

  it("in una cella di tabella: «Comment» sulla selezione, ancora = la cella", async () => {
    const meter = pageByTitle("Meter reading");
    const table = meter.blocks.find((b) => b.type === "table") as Extract<ProductBlock, { type: "table" }>;
    const cell = table.rows[2]!.cells[0]!;
    await open(meter.code);
    const user = userEvent.setup();
    const cellBox = within(body()).getByRole("textbox", { name: "Table cell, row 3, column 1" });
    await user.click(cellBox);
    await waitFor(() => expect(editing()).toHaveTextContent("Business"));
    act(() => placeCaret(editing(), 0, 8));
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.keyUp(editing(), { key: "Shift" });
    const toolbar = await screen.findByRole("toolbar", { name: "Format the selection" });
    await user.click(within(toolbar).getByRole("button", { name: "Comment" }));
    const col = await column();
    const box = await within(col).findByRole("combobox", { name: /Add a comment/ });
    await user.type(box, "Also offices?");
    await user.click(within(col).getByRole("button", { name: "Comment" }));
    await within(col).findByRole("article", { name: "Comment by Laura Costa on “Business”" });
    expect(state.productComments.find((c) => c.body === "Also offices?")!.anchorId).toBe(cell.id);
  });

  it("il clic di Marco sulla notifica apre la pagina con la colonna aperta e il fuoco sul filo", async () => {
    renderRoute("/home", MARCO);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(await within(panel).findByText(`Laura Costa mentioned you in ${SIGNIN} · Sign-in`));
    const col = await column();
    const thread = await within(col).findByRole("article", {
      name: "Comment by Laura Costa on “Google account”",
    });
    await waitFor(() => expect(document.activeElement).toBe(thread));
  });
});

describe("la colonna", () => {
  it("Phases: «Sentence deleted» con la frase, e si risponde ancora", async () => {
    await open(pageByTitle("Phases").code);
    const col = await column();
    const thread = await within(col).findByRole("article", {
      name: "Comment by Laura Costa on “Phase 3: paper bills by post”",
    });
    expect(within(thread).getByText("Sentence deleted")).toBeInTheDocument();
    expect(within(thread).getByText("“Phase 3: paper bills by post”")).toBeInTheDocument();
    const user = userEvent.setup();
    const reply = within(thread).getByRole("combobox", { name: "Reply…" });
    await user.type(reply, "Out of scope, yes.");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(await within(col).findByText("Out of scope, yes.")).toBeInTheDocument();
    expect(state.productComments.find((c) => c.body === "Out of scope, yes.")!.replyToId).toBe("pc-acq-phases-1");
  });

  it("in italiano: «Frase eliminata»", async () => {
    act(() => setLanguage("it"));
    await open(pageByTitle("Phases").code);
    const col = await column();
    expect(await within(col).findByText("Frase eliminata")).toBeInTheDocument();
    expect(within(col).queryByText("Sentence deleted")).toBeNull();
  });

  it("unione nella UI (Q3): Backspace in testa a «with Google», che ha un filo: un blocco solo, il filo accanto, nessun «Sentence deleted»; dopo ⌘Z il filo resta sul primo blocco", async () => {
    seedBlock("blk-acq-signin-3", "Login only ");
    seedBlock(LOGIN_ID, "with Google");
    productDocs.addProductCommentAs(LAURA, signIn().id, { anchorId: LOGIN_ID, quote: "with Google", body: "Why only Google?" });
    await open(SIGNIN);
    const col = await column();
    const el = await enter("with Google", 0);
    act(() => {
      fireEvent.keyDown(el, { key: "Backspace" });
    });
    await waitFor(() => expect(signIn().blocks.some((b) => b.id === LOGIN_ID)).toBe(false));
    const thread = await within(col).findByRole("article", { name: "Comment by Laura Costa on “with Google”" });
    expect(within(col).queryByText("Sentence deleted")).toBeNull();
    expect(state.productComments.find((c) => c.body === "Why only Google?")!.anchorId).toBe("blk-acq-signin-3");
    expect(thread).toBeInTheDocument();
    expect(
      within(body().querySelector<HTMLElement>('[data-block-id="blk-acq-signin-3"]')!).getByRole("button", {
        name: "1 comment on this paragraph",
      }),
    ).toBeInTheDocument();

    // ⌘Z dell'unione: «with Google» torna col suo id; il filo resta sul
    // blocco unito (scelta del Task 10: l'ancora è il blocco, la frase
    // citata ricorda cosa si guardava), e non diventa «Sentence deleted».
    act(() => {
      fireEvent.keyDown(editing(), { key: "z", metaKey: true });
    });
    await waitFor(() => expect(signIn().blocks.some((b) => b.id === LOGIN_ID)).toBe(true));
    expect(state.productComments.find((c) => c.body === "Why only Google?")!.anchorId).toBe("blk-acq-signin-3");
    await waitFor(() => expect(within(col).queryByText("Sentence deleted")).toBeNull());
  });

  it("«Resolve» chiude il filo in «1 resolved» (il fuoco lì); «Reopen» lo riporta, col fuoco sul suo «Resolve»", async () => {
    await open(SIGNIN);
    const col = await column();
    const thread = await within(col).findByRole("article", { name: /Comment by Laura Costa on “Google account”/ });
    const user = userEvent.setup();
    await user.click(within(thread).getByRole("button", { name: "Resolve" }));
    const resolved = await within(col).findByRole("button", { name: "1 resolved" });
    await waitFor(() => expect(document.activeElement).toBe(resolved));
    expect(resolved).toHaveAttribute("aria-expanded", "false");
    expect(within(col).queryByRole("article", { name: /Google account/ })).toBeNull();
    // La barra conta solo gli aperti: «Comments» senza numero.
    await waitFor(() => expect(within(bar()).getByRole("button", { name: "Comments" })).toBeInTheDocument());

    await user.click(resolved);
    const closed = await within(col).findByRole("article", { name: /Google account/ });
    await user.click(within(closed).getByRole("button", { name: "Reopen" }));
    const again = await within(col).findByRole("article", { name: /Google account/ });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(again).getByRole("button", { name: "Resolve" })),
    );
    expect(state.productComments.find((c) => c.id === SIGNIN_ROOT)!.resolved).toBeNull();
  });

  it("× della colonna: il fuoco torna a «Comments» nella barra", async () => {
    await open(SIGNIN);
    const col = await column();
    const user = userEvent.setup();
    await user.click(within(col).getByRole("button", { name: "Close comments" }));
    expect(queryColumn()).toBeNull();
    expect(document.activeElement).toBe(within(bar()).getByRole("button", { name: /^Comments/ }));
  });

  it("Sara legge i fili: nessuna casella, nessun «Resolve», nessun «Comment»; la riga della sola lettura con «Who?»", async () => {
    await open(SIGNIN, SARA);
    const col = await column();
    const thread = await within(col).findByRole("article", { name: /Comment by Laura Costa on “Google account”/ });
    expect(within(thread).getByText("Yes: any Google account works, Workspace included.")).toBeInTheDocument();
    expect(within(col).queryByRole("combobox")).toBeNull();
    expect(within(col).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(
      within(col).getByText(/You can read the comments\. Commenting is for people with Edit docs in ACQ/),
    ).toBeInTheDocument();
    expect(within(col).getByRole("button", { name: /who can/i })).toHaveTextContent("Who?");
    expect(col.querySelector('[data-who-can="editDocs"]')).not.toBeNull();
    // Il filo risolto di Bills: niente «Reopen».
    cleanup();
    await open(pageByTitle("Bills").code, SARA);
    const user = userEvent.setup();
    await user.click(within(bar()).getByRole("button", { name: /^Comments/ }));
    const bills = await column();
    await user.click(await within(bills).findByRole("button", { name: "1 resolved" }));
    await within(bills).findByRole("article", { name: /stored in UTC/ });
    expect(within(bills).queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("`?comment=<id>`: colonna aperta e fuoco sul filo, anche con la colonna chiusa a mano", async () => {
    window.localStorage.setItem(commentsPrefKey(LAURA), "closed");
    await open(SIGNIN, LAURA, `?comment=${SIGNIN_ROOT}`);
    const col = await column();
    const thread = await within(col).findByRole("article", { name: /Comment by Laura Costa on “Google account”/ });
    await waitFor(() => expect(document.activeElement).toBe(thread));
  });

  it("`?comment=` di un filo risolto apre i risolti su di lui; di un filo che non c'è più lo dice", async () => {
    await open(pageByTitle("Bills").code, LAURA, "?comment=pc-acq-bills-1");
    const col = await column();
    const thread = await within(col).findByRole("article", { name: /stored in UTC/ });
    await waitFor(() => expect(document.activeElement).toBe(thread));
    expect(within(col).getByRole("button", { name: "1 resolved" })).toHaveAttribute("aria-expanded", "true");
    cleanup();
    await open(SIGNIN, LAURA, "?comment=pc-gone");
    expect(await within(await column()).findByText("This comment is no longer here")).toBeInTheDocument();
  });
});

describe("la colonna si apre da sola (PC 14)", () => {
  it("Sign-in (fili aperti) sì, Overview no; chiusa a mano su Sign-in resta chiusa anche su Bills; aperta a mano su Overview resta aperta", async () => {
    await open(SIGNIN);
    expect(await column()).toBeInTheDocument();
    cleanup();
    await open(pageByTitle("Overview").code);
    expect(queryColumn()).toBeNull();
    expect(within(bar()).getByRole("button", { name: "Comments" })).toHaveAttribute("aria-pressed", "false");
    cleanup();

    await open(SIGNIN);
    const user = userEvent.setup();
    await user.click(within(await column()).getByRole("button", { name: "Close comments" }));
    expect(window.localStorage.getItem(commentsPrefKey(LAURA))).toBe("closed");
    cleanup();
    await open(pageByTitle("Bills").code);
    expect(queryColumn()).toBeNull();
    cleanup();
    await open(SIGNIN);
    expect(queryColumn()).toBeNull();

    // Aperta a mano (su Overview, senza fili): si ricorda anche lì.
    cleanup();
    await open(pageByTitle("Overview").code);
    await user.click(within(bar()).getByRole("button", { name: "Comments" }));
    expect(await column()).toBeInTheDocument();
    expect(window.localStorage.getItem(commentsPrefKey(LAURA))).toBe("open");
    cleanup();
    await open(pageByTitle("Bills").code);
    expect(await column()).toBeInTheDocument();
  });

  it("per persona: chiusa da Laura, come Marco Sign-in si apre da sola", async () => {
    window.localStorage.setItem(commentsPrefKey(LAURA), "closed");
    await open(SIGNIN, MARCO);
    expect(await column()).toBeInTheDocument();
  });

  it("con `localStorage` che lancia, la pagina si disegna con la regola automatica", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await open(SIGNIN);
    const col = await column();
    const user = userEvent.setup();
    await user.click(within(col).getByRole("button", { name: "Close comments" }));
    expect(queryColumn()).toBeNull();
    cleanup();
    await open(pageByTitle("Overview").code);
    expect(queryColumn()).toBeNull();
  });
});

describe("una colonna alla volta, e a 1024 (PE 19, PE 22)", () => {
  it("History chiude i commenti, Comments chiude la cronologia", async () => {
    await open(SIGNIN);
    await column();
    const user = userEvent.setup();
    await user.click(within(bar()).getByRole("button", { name: "History" }));
    expect(await screen.findByRole("region", { name: "History" })).toBeInTheDocument();
    expect(queryColumn()).toBeNull();
    await user.click(within(bar()).getByRole("button", { name: /^Comments/ }));
    expect(await column()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("a 1440 il pannello della task prende il posto della colonna, che torna alla chiusura", async () => {
    const router = await open(SIGNIN);
    await column();
    await act(() =>
      router.navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, task: "ACQ-1" }) } as never),
    );
    await waitFor(() => expect(queryColumn()).toBeNull());
    await act(() =>
      router.navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, task: undefined }) } as never),
    );
    expect(await column()).toBeInTheDocument();
  });

  it("a 1024 la colonna è sovrapposta 360; col pannello della task vince l'ultimo aperto", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const router = await open(SIGNIN);
    const col = await column();
    const frame = col.closest<HTMLElement>("[data-product-side]")!;
    expect(frame).toHaveAttribute("data-product-side", "overlay");
    expect(frame.className).toContain("w-[360px]");
    expect(frame).toHaveAttribute("data-front", "true");
    await act(() =>
      router.navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, task: "ACQ-1" }) } as never),
    );
    await waitFor(() => expect(frame).toHaveAttribute("data-front", "false"));
    // Resta montata dietro; «Comments» la riporta davanti (non la chiude).
    expect(queryColumn()).not.toBeNull();
    const user = userEvent.setup();
    await user.click(within(bar()).getByRole("button", { name: /^Comments/ }));
    await waitFor(() => expect(frame).toHaveAttribute("data-front", "true"));
    expect(queryColumn()).not.toBeNull();
  });
});

describe("«Follow»", () => {
  it("Sara su Bills: «Follow» → «Following», premuto; ricaricata la pagina resta; il title dice chi segue (P33)", async () => {
    const bills = pageByTitle("Bills");
    await open(bills.code, SARA);
    const follow = within(bar()).getByRole("button", { name: /^Follow\b/ });
    expect(follow).toHaveAttribute("aria-pressed", "false");
    expect(follow.getAttribute("title")).toContain("Follow this page to hear when it changes");
    expect(follow.getAttribute("title")).toContain("Followed by 1 person: Laura Costa");
    expect(follow.getAttribute("aria-label")).toContain("Followed by 1 person: Laura Costa");
    const user = userEvent.setup();
    await user.click(follow);
    const on = within(bar()).getByRole("button", { name: /^Following\b/ });
    expect(on).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(on.getAttribute("title")).toContain("Followed by 2 people"));
    expect(on.getAttribute("title")).toContain("You're following this page. Click to stop.");
    expect(state.productFollows.some((f) => f.pageId === bills.id && f.personId === SARA)).toBe(true);
    cleanup();
    await open(bills.code, SARA);
    expect(within(bar()).getByRole("button", { name: /^Following\b/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("un errore rimette lo stato e lo dice, con Retry", async () => {
    vi.spyOn(api.productDocs, "followProductPage").mockRejectedValueOnce(new Error("offline"));
    await open(pageByTitle("Bills").code, SARA);
    const user = userEvent.setup();
    await user.click(within(bar()).getByRole("button", { name: /^Follow\b/ }));
    expect(await screen.findByText("Couldn't follow this page")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: /^Follow\b/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("chi segue e non è visibile a chi guarda non è nominato (R-G5)", async () => {
    const bills = pageByTitle("Bills");
    // Un nome che nessuno di ACQ vede: un seguace finto fuori da PEOPLE.
    state.productFollows.push({ pageId: bills.id, personId: "p-nobody-visible", since: bills.createdAt });
    await open(bills.code, SARA);
    const follow = within(bar()).getByRole("button", { name: /^Follow\b/ });
    expect(follow.getAttribute("title")!.toLowerCase()).not.toContain("p-nobody-visible");
    expect(follow.getAttribute("title")).toContain("Followed by 1 person: Laura Costa");
  });
});
