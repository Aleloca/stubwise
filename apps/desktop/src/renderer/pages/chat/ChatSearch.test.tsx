import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { state } from "../../data/store";
import type { ChatMessage } from "../../data/types";
import { renderRoute } from "../../test/renderRoute";
import { clearChatColumnPrefs, recentSearchesOf } from "./column";
import { clearDrafts } from "./drafts";
import { forgetResults } from "./search";

// La ricerca della Chat (Task 7): pagina dei risultati, filtri, salto con
// evidenza (anche nel thread), ritorno ai risultati, gruppo «Messages» di ⌘K.
// Review Focus 1 (privati e DM altrui) e 3 (eliminati) sono verificati sulla
// superficie, non solo sul livello dati.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  clearChatColumnPrefs();
  forgetResults();
});

/** Un messaggio scritto a mano nello stato, come il seme. */
function put(m: Partial<ChatMessage> & Pick<ChatMessage, "id" | "channelId" | "createdAt">) {
  state.chatMessages.push({
    threadOf: null,
    authorId: "p-marco",
    kind: "person",
    text: "",
    attachments: [],
    citations: [],
    reactions: [],
    asksReplyOf: [],
    linkedCodes: [],
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...m,
  });
}

const searchOf = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, string | undefined>;
const pageField = () => document.querySelector<HTMLInputElement>('[data-chat-search="page"]')!;
const results = () => document.querySelector<HTMLElement>("[data-search-results]");
const resultIds = () =>
  [...document.querySelectorAll<HTMLElement>("[data-result]")].map((el) =>
    el.getAttribute("data-result"),
  );
const groupIds = () =>
  [...document.querySelectorAll<HTMLElement>("[data-result-group]")].map((el) =>
    el.getAttribute("data-result-group"),
  );
async function loaded() {
  await waitFor(() => expect(results()).not.toBeNull());
  return results()!;
}

describe("ricerca: Review Focus 1 — solo ciò che chi cerca legge", () => {
  it("Roberta: niente dal privato di cui non è membro né dal DM altrui, nemmeno nei conteggi", async () => {
    put({
      id: "z-open",
      channelId: "ch-aud-general",
      createdAt: "2026-10-20T10:00:00Z",
      text: "zebraword in general",
    });
    put({
      id: "z-private",
      channelId: "ch-aud-pricing",
      authorId: "p-laura",
      createdAt: "2026-10-21T10:00:00Z",
      text: "zebraword in pricing",
    });
    put({
      id: "z-dm",
      channelId: "dm-launch-week",
      authorId: "p-laura",
      createdAt: "2026-10-22T10:00:00Z",
      text: "zebraword in a dm",
    });

    renderRoute("/chat?view=search&q=zebraword", "p-roberta");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["z-open"]));
    expect(groupIds()).toEqual(["ch-aud-general"]);
    expect(screen.getByText("1 message in 1 channel")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("zebraword in pricing");
    expect(document.body.textContent).not.toContain("zebraword in a dm");
  });

  it("«In» non offre il privato non letto, e lo filtra come un canale che non esiste", async () => {
    const user = userEvent.setup();
    renderRoute("/chat?view=search&q=the", "p-roberta");
    await loaded();
    await user.click(screen.getByRole("button", { name: "In" }));
    const menu = await screen.findByRole("menu", { name: "In" });
    expect(within(menu).queryByText("pricing")).not.toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitemradio").length).toBeGreaterThan(2);
    await user.keyboard("{Escape}");

    const shown = async (path: string) => {
      const router = renderRoute(path, "p-roberta");
      await screen.findByText("No messages match “annual”");
      const chip = screen.getByRole("button", { name: /^In:/ });
      const text = chip.textContent;
      act(() => router.history.push("/home"));
      return text;
    };
    const hidden = await shown("/chat?view=search&q=annual&in=ch-aud-pricing");
    document.body.innerHTML = "";
    const unknown = await shown("/chat?view=search&q=annual&in=ch-nowhere");
    expect(hidden).toBe(unknown);
    expect(hidden).toContain("Unknown channel");
  });
});

describe("ricerca: Review Focus 3 — un eliminato non si trova né fa da contesto", () => {
  it("il testo eliminato non compare fra i risultati né nella riga di contesto", async () => {
    put({
      id: "k-before",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "alive context line",
    });
    put({
      id: "k-gone",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:01:00Z",
      text: "",
      deletedAt: "2026-10-23T08:05:00Z",
      deletedById: "p-marco",
    });
    put({
      id: "k-hit",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:02:00Z",
      text: "kiwiquery right after",
    });
    renderRoute("/chat?view=search&q=kiwiquery", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["k-hit"]));
    const row = document.querySelector<HTMLElement>('[data-result="k-hit"]')!;
    expect(row.querySelector("[data-result-context]")).toHaveTextContent(
      "Marco Bellini: alive context line",
    );
    expect(document.body.textContent).not.toContain("k-gone");
  });

  it("eliminato dopo i risultati: il clic dice che non c'è più e si resta sulla pagina", async () => {
    put({
      id: "x-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "xylophone notes",
    });
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=xylophone", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["x-1"]));
    state.chatMessages.find((m) => m.id === "x-1")!.deletedAt = "2026-10-23T09:00:00Z";
    state.chatMessages.find((m) => m.id === "x-1")!.text = "";
    await user.click(document.querySelector<HTMLElement>('[data-result="x-1"]')!);
    expect(await screen.findByText("This message is no longer available")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/chat");
    expect(searchOf(router).q).toBe("xylophone");
  });
});

describe("ricerca: risultati e filtri", () => {
  it("raggruppati per canale, le parole trovate in <mark>, senza accenti né maiuscole", async () => {
    put({
      id: "c-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-22T08:00:00Z",
      text: "Il **Caffè** è pronto",
    });
    put({
      id: "c-2",
      channelId: "ch-mkx-general",
      createdAt: "2026-10-23T08:00:00Z",
      text: "caffe in sala",
    });
    renderRoute("/chat?view=search&q=caffe", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["c-2", "c-1"]));
    expect(groupIds()).toEqual(["ch-mkx-general", "ch-mkx-grafica"]);
    const marks = [...document.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["caffe", "Caffè"]);
    // Il nome del canale non è in maiuscolo spaziato: è un dato.
    const heading = document.querySelector('[data-result-group="ch-mkx-grafica"] h2')!;
    expect(heading).not.toHaveClass("heading-group");
    expect(heading).toHaveTextContent("MKX · grafica");
  });

  it("i filtri stanno nell'indirizzo e restringono: allegati, persona, togli i filtri", async () => {
    put({
      id: "f-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-22T08:00:00Z",
      text: "ferretword plain",
    });
    put({
      id: "f-2",
      channelId: "ch-mkx-grafica",
      authorId: "p-giulia",
      createdAt: "2026-10-23T08:00:00Z",
      text: "ferretword with a file",
      attachments: [{ id: "a-1", name: "ferret.pdf", sizeBytes: 2000, kind: "file" }],
    });
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=ferretword", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["f-2", "f-1"]));

    await user.click(screen.getByRole("button", { name: "With attachments", pressed: false }));
    await waitFor(() => expect(searchOf(router).att).toBe("1"));
    await waitFor(() => expect(resultIds()).toEqual(["f-2"]));
    expect(screen.getByRole("button", { name: "With attachments" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(resultIds()).toEqual(["f-2", "f-1"]));

    await user.click(screen.getByRole("button", { name: "From" }));
    const menu = await screen.findByRole("menu", { name: "From" });
    await user.type(within(menu).getByRole("textbox", { name: "Find a person" }), "marco");
    await user.click(within(menu).getByRole("menuitemradio", { name: /Marco Bellini/ }));
    await waitFor(() => expect(searchOf(router).by).toBe("p-marco"));
    await waitFor(() => expect(resultIds()).toEqual(["f-1"]));
  });

  it("sotto i 2 caratteri non cerca; senza risultati lo dice", async () => {
    const user = userEvent.setup();
    renderRoute("/chat?view=search&q=z", "p-giulia");
    expect(await screen.findByText("Type at least 2 characters")).toBeInTheDocument();
    const field = pageField();
    await user.clear(field);
    await user.type(field, "price lsit");
    expect(await screen.findByText("No messages match “price lsit”")).toBeInTheDocument();
    expect(screen.getByText("Try fewer words or another spelling.")).toBeInTheDocument();
  });
});

describe("ricerca: il salto, l'evidenza e il ritorno", () => {
  it("clic → canale con il messaggio evidenziato; «Back to results» e ⌘[ tornano alla ricerca", async () => {
    put({
      id: "j-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "jackalword here",
    });
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=jackalword&ppl=1", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["j-1"]));
    await user.click(document.querySelector<HTMLElement>('[data-result="j-1"]')!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-mkx-grafica"));
    expect(searchOf(router).message).toBe("j-1");
    await waitFor(() =>
      expect(document.querySelector("#message-j-1")).toHaveAttribute("data-found"),
    );
    // Ricordata fra le ricerche recenti, solo per lei.
    expect(recentSearchesOf("p-giulia")).toEqual(["jackalword"]);

    const back = await screen.findByRole("button", { name: /Back to results/ });
    expect(back).toBeInTheDocument();
    await user.keyboard("{Control>}[[{/Control}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(searchOf(router)).toMatchObject({ view: "search", q: "jackalword", ppl: "1" });
    // Il risultato da cui si era partiti è di nuovo selezionato.
    await waitFor(() =>
      expect(document.querySelector('[data-result="j-1"]')).toHaveAttribute("data-selected"),
    );
  });

  it("una risposta in un thread: si apre il pannello e l'evidenza è lì", async () => {
    put({
      id: "t-root",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "root about export",
    });
    put({
      id: "t-reply",
      channelId: "ch-mkx-grafica",
      threadOf: "t-root",
      createdAt: "2026-10-23T08:05:00Z",
      text: "otterword in the thread",
    });
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=otterword", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["t-reply"]));
    const row = document.querySelector<HTMLElement>('[data-result="t-reply"]')!;
    expect(row).toHaveTextContent("in a thread: root about export");
    await user.click(row);
    await waitFor(() =>
      expect(searchOf(router)).toMatchObject({ thread: "t-root", message: "t-reply" }),
    );
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-thread="t-root"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() =>
      expect(panel.querySelector('[data-message="t-reply"]')).toHaveAttribute("data-found"),
    );
  });

  it("un risultato è un link: nome «chi, dove, quando: testo» e le parole trovate esposte come <mark>", async () => {
    put({
      id: "l-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "lynxword in the brief",
    });
    renderRoute("/chat?view=search&q=lynxword", "p-giulia");
    await loaded();
    const link = await screen.findByRole("link", {
      name: "Marco Bellini in MKX · grafica, Oct 23 lynxword in the brief",
    });
    expect(link).toHaveAttribute("data-result", "l-1");
    // Un link non rende presentazionali i figli: il <mark> arriva ai lettori di schermo.
    expect(link.querySelector("mark")).toHaveTextContent("lynxword");
  });

  it("?message= di una risposta che sta solo nel thread: apre il thread, non sfoglia il canale", async () => {
    put({
      id: "r-root",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "root",
    });
    put({
      id: "r-reply",
      channelId: "ch-mkx-grafica",
      threadOf: "r-root",
      createdAt: "2026-10-23T08:05:00Z",
      text: "reply only in the thread",
    });
    const router = renderRoute("/chat/ch-mkx-grafica?message=r-reply", "p-giulia");
    await waitFor(() =>
      expect(searchOf(router)).toMatchObject({ thread: "r-root", message: "r-reply" }),
    );
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-thread="r-root"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() =>
      expect(panel.querySelector('[data-message="r-reply"]')).toHaveAttribute("data-found"),
    );
  });

  it("J/K muovono fra i risultati, Enter apre; ↓ dal campo entra nei risultati", async () => {
    put({
      id: "n-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "newtword one",
    });
    put({
      id: "n-2",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T09:00:00Z",
      text: "newtword two",
    });
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=newtword", "p-giulia");
    await loaded();
    await waitFor(() => expect(resultIds()).toEqual(["n-2", "n-1"]));
    expect(document.querySelector('[data-result="n-2"]')).toHaveAttribute("data-selected");
    pageField().focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(document.querySelector('[data-result="n-2"]'));
    await user.keyboard("j");
    expect(document.activeElement).toBe(document.querySelector('[data-result="n-1"]'));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(searchOf(router).message).toBe("n-1"));
  });
});

describe("ricerca: ingresso dalla colonna e persona", () => {
  it("il campo della colonna apre la pagina; ⌘F mette il fuoco nel campo", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat/ch-mkx-grafica", "p-giulia");
    const field = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('[data-chat-search="column"]');
      expect(el).not.toBeNull();
      return el!;
    });
    document.body.focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(field);
    await user.type(field, "price list{Enter}");
    await waitFor(() =>
      expect(searchOf(router)).toMatchObject({ view: "search", q: "price list" }),
    );
  });

  it("cambiare persona svuota la pagina, query e filtri compresi, e le ricerche recenti", async () => {
    put({
      id: "s-1",
      channelId: "ch-announcements",
      createdAt: "2026-10-23T08:00:00Z",
      text: "swanword hello",
      attachments: [{ id: "a-s", name: "swan.png", sizeBytes: 10, kind: "image" }],
    });
    window.localStorage.setItem(
      "stubwise.chat.recentSearches",
      JSON.stringify({ personId: "p-giulia", items: ["listino"] }),
    );
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=search&q=swanword&att=1", "p-giulia");
    await loaded();
    // Dal cambio di persona in poi, nessun risultato (la query vecchia non si cerca).
    let leaked = false;
    let switched = false;
    const watch = new MutationObserver(() => {
      if (switched && document.querySelector("[data-result]")) leaked = true;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "view as");
    await within(dialog).findByRole("option", { name: /View as…/, selected: true });
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByRole("combobox"), "marco");
    await within(dialog).findByRole("option", { name: /Marco/, selected: true });
    // Da qui nessuna ricerca deve partire: la prima che parte consuma il
    // guasto armato, e allora la chiamata di prova qui sotto non lo trova.
    await new Promise((r) => setTimeout(r, 200));
    api.failNext("chat.search");
    switched = true;
    await user.keyboard("{Enter}");
    await waitFor(() => expect(searchOf(router).q).toBeUndefined());
    await new Promise((r) => setTimeout(r, 50));
    watch.disconnect();
    expect(leaked).toBe(false);
    await expect(api.chat.searchChat("probe")).rejects.toThrow("Simulated failure");
    expect(searchOf(router)).toMatchObject({ view: "search" });
    expect(searchOf(router).att).toBeUndefined();
    expect(pageField()).toHaveValue("");
    expect(await screen.findByText("Search the whole Chat")).toBeInTheDocument();
    expect(recentSearchesOf("p-giulia")).toEqual([]);
  });

  it("le ricerche recenti restano solo della persona che le ha fatte", async () => {
    window.localStorage.setItem(
      "stubwise.chat.recentSearches",
      JSON.stringify({ personId: "p-giulia", items: ["listino", "AUD-88"] }),
    );
    renderRoute("/chat?view=search", "p-giulia");
    expect(await screen.findByRole("button", { name: "listino" })).toBeInTheDocument();
    document.body.innerHTML = "";
    renderRoute("/chat?view=search", "p-marco");
    expect(await screen.findByText("Search the whole Chat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "listino" })).not.toBeInTheDocument();
  });
});

describe("⌘K: Channels e Messages", () => {
  it("dopo gli oggetti, i canali e al più 5 messaggi; mai il privato non letto", async () => {
    for (let i = 0; i < 7; i++) {
      put({
        id: `p-${i}`,
        channelId: "ch-aud-general",
        createdAt: `2026-10-2${i % 3}T08:0${i}:00Z`,
        text: `pelicanword number ${i}`,
      });
    }
    put({
      id: "p-private",
      channelId: "ch-aud-pricing",
      authorId: "p-laura",
      createdAt: "2026-10-23T10:00:00Z",
      text: "pelicanword private",
    });
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-roberta");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("pelicanword");
    const group = await within(dialog).findByRole("group", { name: "Messages" });
    await waitFor(() => expect(group.querySelectorAll("[data-palette-message]")).toHaveLength(5));
    expect(group.textContent).not.toContain("private");
    // Le righe che citano il testo stanno in fondo, sotto i messaggi trovati.
    const more = within(dialog).getByRole("group", { name: "More" });
    const all = within(more).getByRole("option", {
      name: "Search all messages for “pelicanword”",
    });
    expect(
      within(more).getByRole("option", { name: /Ask Claude: “pelicanword”/ }),
    ).toBeInTheDocument();
    const headings = [...dialog.querySelectorAll(".heading-group")].map((h) => h.textContent);
    expect(headings.at(-1)).toBe("More");
    expect(
      headings.indexOf("Channels") < headings.indexOf("Messages") || !headings.includes("Channels"),
    ).toBe(true);
    // Selezionato di default: un messaggio trovato, non «Search all messages».
    expect(within(dialog).getAllByRole("option", { selected: true })[0]).toHaveAttribute(
      "data-palette-message",
    );
    await user.click(all);
    await waitFor(() =>
      expect(searchOf(router)).toMatchObject({ view: "search", q: "pelicanword" }),
    );
  });

  it("il nome di un comando, con messaggi che lo citano: Enter esegue il comando", async () => {
    put({
      id: "cmd-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "let's go to all projects and check",
    });
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("go to all projects");
    // Oltre l'attesa della ricerca (120 ms): i messaggi sono arrivati.
    await within(dialog).findByRole("group", { name: "Messages" });
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("group", { name: "Messages" })
          .querySelector("[data-palette-message]"),
      ).not.toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(within(dialog).getByRole("option", { selected: true })).toHaveTextContent(
      "Go to all projects",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
  });

  it("un messaggio dalla palette salta al canale con l'evidenza; un canale per nome si apre", async () => {
    put({
      id: "g-1",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      text: "gecko palette jump",
    });
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("gecko");
    const group = await within(dialog).findByRole("group", { name: "Messages" });
    const option = await waitFor(() => {
      const el = group.querySelector<HTMLElement>("[data-palette-message]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(option.querySelector("mark")).toHaveTextContent("gecko");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-mkx-grafica"));
    expect(searchOf(router).message).toBe("g-1");
    await waitFor(() =>
      expect(document.querySelector("#message-g-1")).toHaveAttribute("data-found"),
    );

    await user.keyboard("{Control>}k{/Control}");
    const again = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("grafica");
    const channels = await within(again).findByRole("group", { name: "Channels" });
    expect(within(channels).getByRole("option", { name: /grafica/ })).toBeInTheDocument();
  });
});
