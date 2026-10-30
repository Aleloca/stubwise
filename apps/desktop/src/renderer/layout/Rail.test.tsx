import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chat as chatApi,
  listPinnedProjectIds,
  listWaitingOnMeProjectIds,
  resetApi,
  setLatency,
  setPinned,
} from "../data/api";
import { PROJECTS } from "../data/seed/projects";
import { setSessionPersonId } from "../data/session";
import { now, state } from "../data/store";
import { ViewerProvider } from "../data/viewer";
import { setLanguage } from "../i18n";
import { createAppRouter } from "../router";
import { splitPinned } from "./Rail";
import { ThemeProvider } from "../theme/ThemeProvider";

function renderAt(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** Lascia finire una navigazione eventualmente partita, prima di dire che non c'è stata. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function pinnedList() {
  return screen.findByRole("list", { name: "Pinned projects" });
}

async function tiles() {
  const list = await pinnedList();
  return waitFor(() => {
    const links = within(list).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    return links;
  });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

afterEach(() => {
  delete window.stubwise;
  act(() => setLanguage("en"));
});

describe("Rail", () => {
  it("mostra il logo e le destinazioni, con aria-current su quella attiva", async () => {
    renderAt("/chat");
    const rail = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(rail).getByRole("img", { name: "Stubwise" })).toBeInTheDocument();
    for (const [name, href] of [
      ["Home", "/home"],
      ["Chat", "/chat"],
      ["Mail", "/mail"],
      ["Calendar", "/calendar"],
      ["Claude", "/claude"],
      ["Automations", "/automations"],
      ["All projects", "/projects"],
    ] as const) {
      expect(within(rail).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    await waitFor(() =>
      expect(within(rail).getByRole("link", { name: "Chat" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(rail).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("una tessera per progetto fissato: codice visibile, nome nell'etichetta", async () => {
    renderAt("/home");
    const links = await tiles();
    expect(links).toHaveLength(14);
    const mkx = links[0]!;
    expect(mkx).toHaveTextContent("MKX");
    expect(mkx).toHaveAccessibleName(/Campagne primavera Mix Cucine/);
    expect(mkx).toHaveAttribute("href", "/p/MKX");
  });

  it("la tessera del progetto aperto è quella corrente", async () => {
    renderAt("/p/AUD/tasks");
    const links = await tiles();
    await waitFor(() => expect(links[1]).toHaveAttribute("aria-current", "page"));
    expect(links[0]).not.toHaveAttribute("aria-current");
  });

  it("gli indicatori «Waiting on you» e «Claude is working» hanno testo accessibile", async () => {
    renderAt("/home");
    const list = await pinnedList();
    const stw = await within(list).findByRole("link", { name: /Stubwise/ });
    expect(stw).toHaveAccessibleDescription(/Waiting on you/);
    expect(stw).toHaveAccessibleDescription(/Claude is working/);
    const aud = within(list).getByRole("link", { name: /Audin 2\.0/ });
    expect(aud).not.toHaveAccessibleDescription(/Waiting on you/);
    expect(aud).not.toHaveAccessibleDescription(/Claude is working/);
  });

  it("con 12 progetti fissati la zona tessere non scorre, campanella/⌘K/profilo restano fuori", async () => {
    await setPinned("prj-aqm", false);
    await setPinned("prj-frl", false);
    renderAt("/home");
    const links = await tiles();
    expect(links).toHaveLength(12);
    const zone = (await pinnedList()).parentElement!;
    expect(zone).toHaveAttribute("data-tiles-zone");
    expect(zone).toHaveClass("overflow-hidden");
    // Senza layout misurabile si vedono tutte, e nessuna sentinella.
    expect(zone.querySelector("[data-rail-overflow]")).toBeNull();
    for (const name of [/^Notifications/, "Search and commands", "Profile and settings"]) {
      const control = screen.getByRole("button", { name });
      expect(zone.contains(control)).toBe(false);
    }
  });

  it("Ctrl+2 (fuori da macOS) apre la seconda tessera; Ctrl+0 non fa nulla", async () => {
    const router = renderAt("/home");
    await tiles();
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    await settle();
    expect(router.state.location.pathname).toBe("/home");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/overview"));
  });

  it("su macOS la scorciatoia è ⌘2, non Ctrl+2", async () => {
    window.stubwise = { platform: "darwin" };
    const router = renderAt("/home");
    await tiles();
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await settle();
    expect(router.state.location.pathname).toBe("/home");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/overview"));
  });

  it("un numero oltre l'ultima tessera non fa nulla", async () => {
    resetApi();
    for (const code of ["mkx", "aud", "stw", "cbv", "olv", "lmr", "vdm", "sal", "btg", "cma"]) {
      await setPinned(`prj-${code}`, false);
    }
    const router = renderAt("/home");
    const links = await tiles();
    expect(links).toHaveLength(4);
    fireEvent.keyDown(window, { key: "9", ctrlKey: true });
    await settle();
    expect(router.state.location.pathname).toBe("/home");
  });

  it("Ctrl+Shift+H torna alla Home", async () => {
    const router = renderAt("/chat");
    await tiles();
    fireEvent.keyDown(window, { key: "H", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
  });

  it("⌘K (scorciatoia e bottone) apre la palette; la campanella le notifiche", async () => {
    renderAt("/home");
    await tiles();
    const palette = vi.fn();
    const notifications = vi.fn();
    window.addEventListener("stubwise:palette", palette);
    window.addEventListener("stubwise:notifications", notifications);
    try {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(palette).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "Search and commands" }));
      expect(palette).toHaveBeenCalledTimes(2);
      await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
      expect(notifications).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("stubwise:palette", palette);
      window.removeEventListener("stubwise:notifications", notifications);
    }
  });

  it("le etichette delle scorciatoie seguono la piattaforma", async () => {
    window.stubwise = { platform: "darwin" };
    renderAt("/home");
    await tiles();
    await userEvent.hover(screen.getByRole("button", { name: "Search and commands" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("⌘K");
  });

  it("su Windows il tooltip della palette dice Ctrl+K", async () => {
    window.stubwise = { platform: "win32" };
    renderAt("/home");
    await tiles();
    await userEvent.hover(screen.getByRole("button", { name: "Search and commands" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ctrl+K");
  });

  it("su mac la cima del binario è trascinabile e lascia lo spazio dei semafori; altrove no", async () => {
    window.stubwise = { platform: "darwin" };
    renderAt("/home");
    await tiles();
    expect(document.querySelector("[data-drag-region]")).not.toBeNull();
    expect(document.querySelector("[data-traffic-light-space]")).not.toBeNull();
    cleanup();
    window.stubwise = { platform: "win32" };
    renderAt("/home");
    await tiles();
    expect(document.querySelector("[data-drag-region]")).not.toBeNull();
    expect(document.querySelector("[data-traffic-light-space]")).toBeNull();
  });

  it("un nome progetto lungo nel tooltip non viene troncato", async () => {
    const name = "Portale soci Consorzio Agrario Valli Padane";
    // Solo chi vede il progetto lo può fissare: Roberta (full admin) li vede tutti.
    setSessionPersonId("p-roberta");
    await setPinned("prj-cvp", true);
    renderAt("/home", "p-roberta");
    const list = await pinnedList();
    const tile = await within(list).findByRole("link", { name: new RegExp(name) });
    await userEvent.hover(tile);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(name);
    for (const el of [tooltip, ...tooltip.querySelectorAll("*")]) {
      expect(el.className).not.toMatch(/truncate|ellipsis|nowrap|line-clamp/);
    }
  });

  describe("menu profilo", () => {
    async function openProfile() {
      await userEvent.click(await screen.findByRole("button", { name: "Profile and settings" }));
      return screen.findByRole("dialog", { name: "Profile and settings" });
    }

    it("«Administration» solo per chi amministra qualcosa; agli altri «People»", async () => {
      renderAt("/home", "p-marco");
      const menu = await openProfile();
      expect(within(menu).queryByRole("link", { name: "Administration" })).toBeNull();
      expect(within(menu).getByRole("link", { name: "People" })).toHaveAttribute("href", "/admin");
      expect(within(menu).getByRole("link", { name: "Preferences" })).toHaveAttribute(
        "href",
        "/preferences",
      );
    });

    it("il full admin vede «Administration»", async () => {
      renderAt("/home", "p-roberta");
      const menu = await openProfile();
      expect(within(menu).getByRole("link", { name: "Administration" })).toHaveAttribute(
        "href",
        "/admin",
      );
    });

    it("tema: sistema, chiaro, scuro", async () => {
      renderAt("/home");
      const menu = await openProfile();
      const group = within(menu).getByRole("radiogroup", { name: "Theme" });
      expect(within(group).getByRole("radio", { name: "System" })).toBeChecked();
      await userEvent.click(within(group).getByRole("radio", { name: "Dark" }));
      expect(document.documentElement.dataset.theme).toBe("dark");
      await userEvent.click(within(group).getByRole("radio", { name: "Light" }));
      expect(document.documentElement.dataset.theme).toBe("light");
    });

    it("lingua: passare all'italiano traduce il binario", async () => {
      renderAt("/home");
      const menu = await openProfile();
      const group = within(menu).getByRole("radiogroup", { name: "Language" });
      await userEvent.click(within(group).getByRole("radio", { name: "Italiano" }));
      expect(await screen.findByRole("link", { name: "Posta" })).toBeInTheDocument();
    });

    it("«View as» elenca le persone e cambia chi guarda", async () => {
      renderAt("/home");
      const menu = await openProfile();
      const group = within(menu).getByRole("radiogroup", { name: "View as" });
      const radios = within(group).getAllByRole("radio");
      expect(radios).toHaveLength(6);
      expect(within(group).getByRole("radio", { name: /Giulia Ferri/ })).toBeChecked();
      // Matteo possiede AUT-1: per vedere l'app come il proprietario di un'automazione.
      const matteo = within(group).getByRole("radio", {
        name: "Matteo Conti Sales · Project Lead, owns an automation",
      });
      await userEvent.click(matteo);
      expect(matteo).toBeChecked();
      await userEvent.click(within(group).getByRole("radio", { name: /Roberta Fontana/ }));
      expect(within(menu).getByRole("link", { name: "Administration" })).toBeInTheDocument();
    });

    it("«View as»: le descrizioni delle persone seguono la lingua", async () => {
      renderAt("/home");
      let menu = await openProfile();
      let group = within(menu).getByRole("radiogroup", { name: "View as" });
      expect(
        within(group).getByRole("radio", {
          name: "Giulia Ferri Marketing · Project Lead on some projects",
        }),
      ).toBeInTheDocument();
      expect(group).not.toHaveTextContent(/su alcuni progetti|amministratore/);
      await userEvent.click(
        within(within(menu).getByRole("radiogroup", { name: "Language" })).getByRole("radio", {
          name: "Italiano",
        }),
      );
      menu = await screen.findByRole("dialog", { name: "Profilo e impostazioni" });
      group = within(menu).getByRole("radiogroup", { name: "Vedi come" });
      expect(
        within(group).getByRole("radio", { name: /Giulia Ferri.*Project Lead su alcuni progetti/ }),
      ).toBeInTheDocument();
      expect(
        within(group).getByRole("radio", { name: /Roberta Fontana.*amministratore completo/ }),
      ).toBeInTheDocument();
      expect(
        within(group).getByRole("radio", {
          name: /Matteo Conti.*Vendite · Project Lead, ha un'automazione/,
        }),
      ).toBeInTheDocument();
    });

    it("Esc chiude il menu e riporta il fuoco sul bottone", async () => {
      renderAt("/home");
      await openProfile();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Profile and settings" })).toBeNull();
      expect(screen.getByRole("button", { name: "Profile and settings" })).toHaveFocus();
    });

    it("un clic fuori chiude il menu e riporta il fuoco sul bottone", async () => {
      renderAt("/home");
      await openProfile();
      await userEvent.click(await screen.findByRole("heading", { level: 1, name: "Home" }));
      expect(screen.queryByRole("dialog", { name: "Profile and settings" })).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Profile and settings" })).toHaveFocus(),
      );
    });

    it("un clic fuori su un altro controllo non gli ruba il fuoco", async () => {
      renderAt("/home");
      await openProfile();
      const bell = screen.getByRole("link", { name: "Mail" });
      await userEvent.click(bell);
      await settle();
      expect(bell).toHaveFocus();
    });
  });

  describe("punto della Posta", () => {
    it("acceso solo per le proposte che mi aspettano, detto a parole e nel tooltip", async () => {
      renderAt("/home", "p-giulia");
      const link = await screen.findByRole("link", { name: "Mail" });
      await waitFor(() => expect(link).toHaveAccessibleDescription("4 proposals to decide"));
      expect(link.querySelector("[data-signal]")).not.toBeNull();
      await userEvent.hover(link);
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Mail · 4 proposals to decide");
    });

    it("spento per chi ha solo proposte del calendario (e per la posta non letta)", async () => {
      renderAt("/home", "p-chiara");
      const link = await screen.findByRole("link", { name: "Mail" });
      await settle();
      expect(link.querySelector("[data-signal]")).toBeNull();
      expect(link).not.toHaveAccessibleDescription();
    });
  });

  describe("punto della Chat", () => {
    const chatLink = () => screen.findByRole("link", { name: "Chat" });
    const dotOf = (el: HTMLElement) => el.querySelector('[data-signal="chat"]');

    /** Tutto letto per la persona, fino ad «adesso». */
    function readEverything(personId: string) {
      for (const r of state.chatReads.values()) {
        if (r.personId !== personId) continue;
        r.lastReadAt = now();
        for (const root of Object.keys(r.threadReads)) r.threadReads[root] = now();
      }
    }

    it("acceso per le menzioni dirette del seme, detto a parole e nel tooltip", async () => {
      renderAt("/home", "p-giulia");
      const link = await chatLink();
      await waitFor(() => expect(dotOf(link)).not.toBeNull());
      expect(link).toHaveAccessibleDescription("Mentions or replies for you");
      await userEvent.hover(link);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Chat · Mentions or replies for you",
      );
    });

    it("spento per il traffico normale dei canali; si accende con una menzione, dal vivo", async () => {
      readEverything("p-giulia");
      setSessionPersonId("p-marco");
      await chatApi.sendMessage("ch-stw-desktop", { text: "Build is green" });
      renderAt("/home", "p-giulia");
      const link = await chatLink();
      await settle();
      expect(dotOf(link)).toBeNull();
      expect(link).not.toHaveAccessibleDescription();
      await act(async () => {
        setSessionPersonId("p-marco");
        await chatApi.sendMessage("ch-stw-desktop", { text: "@Giulia Ferri can you look?" });
        setSessionPersonId("p-giulia");
      });
      await waitFor(() => expect(dotOf(link)).not.toBeNull());
    });

    it("cambiare persona rilegge il punto per la persona nuova", async () => {
      readEverything("p-marco");
      renderAt("/home", "p-giulia");
      const link = await chatLink();
      await waitFor(() => expect(dotOf(link)).not.toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
      const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
      await userEvent.click(within(menu).getByRole("radio", { name: /Marco Bellini/ }));
      await waitFor(async () => expect(dotOf(await chatLink())).toBeNull());
    });
  });

  it("il tooltip della tessera dice anche gli stati", async () => {
    renderAt("/home");
    const list = await pinnedList();
    await userEvent.hover(await within(list).findByRole("link", { name: /Stubwise/ }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Stubwise · Waiting on you · Claude is working",
    );
  });

  describe("trabocco delle tessere", () => {
    /** Dà alla zona un'altezza (happy-dom non fa layout) e lo fa sapere. */
    async function fitZone(height: number) {
      const zone = (await pinnedList()).parentElement!;
      Object.defineProperty(zone, "clientHeight", { configurable: true, value: height });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      return zone;
    }

    async function pinnedInOrder() {
      const ids = await listPinnedProjectIds();
      return ids.map((id) => PROJECTS.find((p) => p.id === id)!);
    }

    it("solo tessere intere: l'ultimo posto è la sentinella «+N» verso /projects", async () => {
      renderAt("/home");
      const pinned = await pinnedInOrder();
      await tiles();
      // 4 posti da 48 px: 3 tessere + la sentinella.
      const zone = await fitZone(4 * 48 + 10);
      const list = await pinnedList();
      await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(3));
      const sentinel = zone.querySelector<HTMLElement>("[data-rail-overflow]")!;
      expect(sentinel).toHaveTextContent(`+${pinned.length - 3}`);
      expect(sentinel).toHaveAttribute("href", "/projects");
      expect(sentinel).toHaveAccessibleName(new RegExp(`^${pinned.length - 3} more projects`));
    });

    it("la sentinella somma i segnali delle tessere nascoste", async () => {
      renderAt("/home");
      const pinned = await pinnedInOrder();
      await tiles();
      const zone = await fitZone(3 * 48);
      await waitFor(() => expect(zone.querySelector("[data-rail-overflow]")).not.toBeNull());
      const hidden = pinned.slice(2);
      const waitingIds = new Set(await listWaitingOnMeProjectIds());
      const waiting = hidden.filter((p) => waitingIds.has(p.id)).length;
      const claude = hidden.some((p) => p.signals.claudeWorking);
      // Il seed deve esercitare entrambi i segnali fra le nascoste.
      expect(waiting).toBeGreaterThan(0);
      expect(claude).toBe(true);
      const sentinel = zone.querySelector<HTMLElement>("[data-rail-overflow]")!;
      expect(sentinel).toHaveAccessibleName(
        `${hidden.length} more projects · ${waiting} waiting on you · Claude is working`,
      );
      expect(sentinel.querySelector('[data-signal="waiting"]')).not.toBeNull();
      // Claude è neutro di tinta: lo distingue la forma (anello tratteggiato di 2 px).
      expect(sentinel.querySelector('[data-signal="claude"]')).toHaveClass(
        "border-dashed",
        "border-2",
        "border-claude",
      );
      expect(sentinel.querySelector('[data-signal="waiting"]')).toHaveClass(
        "rounded-full",
        "bg-ink",
      );
      await userEvent.hover(sentinel);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        `${hidden.length} more projects · ${waiting} waiting on you · Claude is working`,
      );
    });

    it("la sentinella mostra un segnale solo se una nascosta lo ha", async () => {
      renderAt("/home");
      const pinned = await pinnedInOrder();
      await tiles();
      // Posto per tutte tranne una: la sentinella prende il posto della penultima.
      const last = pinned.at(-1)!;
      const beforeLast = pinned.at(-2)!;
      const expectedHidden = [beforeLast, last];
      const zone = await fitZone((pinned.length - 1) * 48);
      await waitFor(() => expect(zone.querySelector("[data-rail-overflow]")).not.toBeNull());
      const sentinel = zone.querySelector<HTMLElement>("[data-rail-overflow]")!;
      const waitingIds = new Set(await listWaitingOnMeProjectIds());
      const anyWaiting = expectedHidden.some((p) => waitingIds.has(p.id));
      const anyClaude = expectedHidden.some((p) => p.signals.claudeWorking);
      expect(sentinel.querySelector('[data-signal="waiting"]') !== null).toBe(anyWaiting);
      expect(sentinel.querySelector('[data-signal="claude"]') !== null).toBe(anyClaude);
      expect(sentinel).toHaveTextContent("+2");
    });

    it("il progetto aperto resta visibile anche se sarebbe fra le nascoste", async () => {
      const ids = await listPinnedProjectIds();
      expect(ids.length).toBeGreaterThan(4);
      const far = PROJECTS.find((p) => p.id === ids.at(-1))!;
      renderAt(`/p/${far.code}/overview`);
      await tiles();
      await fitZone(4 * 48);
      const list = await pinnedList();
      await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(3));
      const shown = within(list).getAllByRole("link");
      expect(shown.at(-1)).toHaveAccessibleName(new RegExp(far.code));
      await waitFor(() => expect(shown.at(-1)).toHaveAttribute("aria-current", "page"));
    });

    it("un posto solo, in un progetto: la sua tessera resta e «+N» va su «All projects»", async () => {
      const ids = await listPinnedProjectIds();
      const far = PROJECTS.find((p) => p.id === ids.at(-1))!;
      renderAt(`/p/${far.code}/overview`);
      await tiles();
      const zone = await fitZone(48);
      const list = await pinnedList();
      await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(1));
      expect(within(list).getByRole("link")).toHaveAccessibleName(new RegExp(far.code));
      expect(zone.querySelector("[data-rail-overflow]")).toBeNull();
      const all = screen.getByRole("link", { name: "All projects" });
      const hidden = ids.length - 1;
      expect(all.querySelector("[data-rail-overflow-count]")).toHaveTextContent(`+${hidden}`);
      expect(all).toHaveAccessibleDescription(new RegExp(`^${hidden} more projects`));
    });
  });

  describe("splitPinned", () => {
    const mk = (code: string) => PROJECTS.find((p) => p.code === code)!;
    const five = ["STW", "AUD", "MKX", "CBV", "OLV"].map(mk);
    const codes = (r: ReturnType<typeof splitPinned>) => ({
      shown: r.shown.map((e) => `${e.project.code}@${e.index}`),
      hidden: r.hidden.map((p) => p.code),
    });

    it("senza misura o con posto per tutte, tutte e nessuna nascosta", () => {
      expect(codes(splitPinned(five, null)).hidden).toEqual([]);
      expect(codes(splitPinned(five, 5)).hidden).toEqual([]);
    });

    it("con meno posti, l'ultimo va alla sentinella", () => {
      expect(codes(splitPinned(five, 3))).toEqual({
        shown: ["STW@0", "AUD@1"],
        hidden: ["MKX", "CBV", "OLV"],
      });
    });

    it("il progetto aperto prende l'ultimo posto e tiene il suo indice", () => {
      expect(codes(splitPinned(five, 3, "OLV"))).toEqual({
        shown: ["STW@0", "OLV@4"],
        hidden: ["AUD", "MKX", "CBV"],
      });
    });

    it("con un solo posto c'è solo la sentinella", () => {
      expect(codes(splitPinned(five, 1))).toEqual({ shown: [], hidden: five.map((p) => p.code) });
      expect(splitPinned(five, 1).countOnGrid).toBe(false);
    });

    it("con un solo posto e un progetto aperto: il progetto resta, il «+N» va su «All projects»", () => {
      const split = splitPinned(five, 1, "AUD");
      expect(codes(split)).toEqual({ shown: ["AUD@1"], hidden: ["STW", "MKX", "CBV", "OLV"] });
      expect(split.countOnGrid).toBe(true);
      // Con più posti la sentinella resta nella zona delle tessere.
      expect(splitPinned(five, 3, "OLV").countOnGrid).toBe(false);
    });
  });
});
