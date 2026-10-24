import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { INITIAL_PINNED_CODES } from "../../data/seed/projects";
import type { ChatMessage } from "../../data/types";
import { renderRoute } from "../../test/renderRoute";
import { chatColumnModel, clearChatColumnPrefs, hasNews, rememberLastChannel } from "./column";
import { clearDrafts } from "./drafts";

// La destinazione Chat (Task 6): la colonna per persona, l'atterraggio, la
// sezione Chat del progetto con gli stessi canali e gli stessi non letti,
// la tastiera, le viste Threads, Mentions e Browse.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  clearChatColumnPrefs();
});

const column = () => document.querySelector<HTMLElement>('[data-zone="column"]')!;
async function chatNav() {
  await waitFor(() => expect(column()).not.toBeNull());
  return within(column()).findByRole("navigation", { name: "Chat views" });
}
const searchOf = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, string | undefined>;

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

async function modelOf(personId: string) {
  setSessionPersonId(personId);
  const [rows, projects, pinned] = await Promise.all([
    api.chat.listChannels(),
    api.listProjects(),
    api.listPinnedProjectIds(),
  ]);
  setSessionPersonId("p-giulia");
  return chatColumnModel(rows, projects, pinned);
}

describe("colonna della Chat: per persona", () => {
  it("prima i progetti fissati nel loro ordine, poi gli altri per codice; azienda; diretti", async () => {
    for (const personId of ["p-giulia", "p-laura"]) {
      const model = await modelOf(personId);
      const codes = model.projects.map((g) => g.project.code);
      const pins = INITIAL_PINNED_CODES[personId]!.filter((c) => codes.includes(c));
      // I fissati in testa, nell'ordine del binario.
      expect(codes.slice(0, pins.length), personId).toEqual(pins);
      const rest = codes.slice(pins.length);
      expect(rest, personId).toEqual([...rest].sort());
      // Ogni canale della colonna è suo, non archiviato; il «general» per primo.
      for (const g of model.projects) {
        expect(g.channels.every((c) => c.isMember && !c.archived)).toBe(true);
        expect(g.channels[0]!.isGeneral).toBe(true);
      }
      expect(model.company.every((c) => c.kind === "general")).toBe(true);
      expect(model.dms.every((c) => c.kind === "dm" && c.memberIds.includes(personId))).toBe(true);
    }
    // Due persone, due colonne: il privato di AUD c'è per Laura (membro), non per Giulia.
    const laura = await modelOf("p-laura");
    const giulia = await modelOf("p-giulia");
    const ids = (m: typeof laura) => m.projects.flatMap((g) => g.channels.map((c) => c.id));
    expect(ids(laura)).toContain("ch-aud-pricing");
    expect(ids(giulia)).not.toContain("ch-aud-pricing");
    // L'archiviato non sta in colonna, nemmeno per chi ne era membro.
    expect(ids(giulia)).not.toContain("ch-mkx-autumn");
  });

  it("i gruppi senza nulla di nuovo sono chiusi; aperto o chiuso si ricorda per persona", async () => {
    const user = userEvent.setup();
    renderRoute("/chat/ch-announcements", "p-laura");
    const nav = await chatNav();
    const groups = await waitFor(() => {
      const list = nav.querySelectorAll<HTMLElement>("[data-project-group]");
      expect(list.length).toBeGreaterThan(2);
      return [...list];
    });
    const quiet = await (async () => {
      setSessionPersonId("p-laura");
      const rows = await api.chat.listChannels();
      setSessionPersonId("p-giulia");
      return groups.find((g) => {
        const code = g.getAttribute("data-project-group");
        return rows
          .filter((r) => r.isMember && r.kind === "project")
          .filter((r) => state.projectsById.get(r.projectId!)?.code === code)
          .every((r) => r.unread === 0 && r.mentions === 0);
      })!;
    })();
    expect(quiet).toBeDefined();
    const toggle = within(quiet).getAllByRole("button")[0]!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(quiet).getAllByRole("link").length).toBeGreaterThan(0);
    // Rimontata, la colonna se lo ricorda.
    const code = quiet.getAttribute("data-project-group");
    cleanup();
    renderRoute("/chat/ch-announcements", "p-laura");
    const again = await chatNav();
    await waitFor(() =>
      expect(
        within(again.querySelector<HTMLElement>(`[data-project-group="${code}"]`)!)
          .getAllByRole("button")[0],
      ).toHaveAttribute("aria-expanded", "true"),
    );
  });

  it("la riga dice in parole non letti e menzioni; la menzione è una pastiglia", async () => {
    put({
      id: "m-new-mention",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-24T09:30:00Z",
      authorId: "p-chiara",
      text: "@Giulia Ferri can you check the cover?",
    });
    renderRoute("/chat/ch-announcements", "p-giulia");
    const nav = await chatNav();
    const row = await waitFor(() => {
      const el = nav.querySelector<HTMLElement>('[data-channel-row="ch-mkx-grafica"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.getAttribute("aria-label")).toMatch(/^grafica, \d+ unread, \d+ mentions?/);
    expect(row.querySelector("[data-mention-pill]")).not.toBeNull();
    expect(row).toHaveClass("font-semibold");
  });
});

describe("atterraggio di #/chat", () => {
  it("la prima volta: il «general» del primo progetto fissato in cui si è", async () => {
    const router = renderRoute("/chat", "p-giulia");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-mkx-general"));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("MKX · general");
  });

  it("poi l'ultimo canale aperto (per persona)", async () => {
    rememberLastChannel("p-giulia", "ch-mkx-grafica");
    const router = renderRoute("/chat", "p-giulia");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-mkx-grafica"));
  });
});

describe("sezione Chat del progetto", () => {
  it("atterra sul general; gli stessi canali e gli stessi non letti della Chat", async () => {
    put({
      id: "m-unread-aud",
      // In un altro canale di AUD: il «general» si apre (e si legge) atterrando.
      channelId: "ch-aud-pricing",
      createdAt: "2026-10-24T09:40:00Z",
      authorId: "p-matteo",
      text: "@Laura Costa the price list is in",
    });
    const router = renderRoute("/p/AUD/chat", "p-laura");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/chat/ch-aud-general"));
    await waitFor(() => expect(column()).not.toBeNull());
    const projectList = await within(column()).findByRole("list", { name: "AUD channels" });
    const inProject = await waitFor(() => {
      const el = projectList.querySelector<HTMLElement>('[data-channel-row="ch-aud-general"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(inProject.getAttribute("href")).toMatch(/\/p\/AUD\/chat\/ch-aud-general$/);
    const projectLabels = [...projectList.querySelectorAll("[data-channel-row]")].map((r) =>
      r.getAttribute("aria-label"),
    );
    // La sezione «Chat» porta le menzioni del progetto.
    await waitFor(() =>
      expect(within(column()).getByRole("link", { name: /^Chat/ }).textContent).toMatch(
        /\d+ mentions?/,
      ),
    );

    // Nella Chat: le stesse righe del progetto, con gli stessi conteggi.
    await act(() => router.navigate({ to: "/chat/$channelId", params: { channelId: "ch-aud-general" } }));
    const nav = await chatNav();
    const group = await waitFor(() => {
      const el = nav.querySelector<HTMLElement>('[data-project-group="AUD"]');
      expect(el?.querySelector('[data-channel-row="ch-aud-general"]')).not.toBeNull();
      return el!;
    });
    const globalLabels = [...group.querySelectorAll("[data-channel-row]")].map((r) =>
      r.getAttribute("aria-label"),
    );
    expect(globalLabels).toEqual(projectLabels);
  });

  it("un canale di un altro ambito aperto dal progetto si riapre nella Chat", async () => {
    const router = renderRoute("/p/AUD/chat/ch-announcements", "p-laura");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-announcements"));
  });
});

describe("tastiera della Chat: mai mentre si scrive", () => {
  it("nella casella ⌥↓ e Maiusc+Esc non fanno nulla; ⌘N apre «New message» anche fuori dalla Chat", async () => {
    const router = renderRoute("/chat/ch-mkx-general", "p-giulia");
    const nav = await chatNav();
    await waitFor(() =>
      expect(nav.querySelectorAll("[data-channel-row][data-unread]").length).toBeGreaterThan(0),
    );
    const unreadElsewhere = async () => {
      setSessionPersonId("p-giulia");
      const rows = await api.chat.listChannels();
      return rows.filter((r) => r.isMember && r.unread > 0 && r.id !== "ch-mkx-general").length;
    };
    const before = await unreadElsewhere();
    expect(before).toBeGreaterThan(0);
    const composer = await screen.findByRole("combobox", { name: "Message MKX · general" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(composer, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(composer, { key: "Escape", shiftKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/chat/ch-mkx-general");
    expect(await unreadElsewhere()).toBe(before);

    cleanup();
    const home = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(searchOf(home).newMessage).toBe("1"));
    expect(home.state.location.pathname).toBe("/home");
  });
});

describe("⌘N globale: solo dove non è già di qualcun altro", () => {
  it("su #/claude resta «New conversation»; con un dialogo aperto o scrivendo non fa nulla", async () => {
    const claude = renderRoute("/claude?scope=mine", "p-giulia");
    await screen.findByRole("heading", { level: 1 });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(searchOf(claude).scope).toBeUndefined());
    expect(claude.state.location.pathname).toBe("/claude");
    expect(searchOf(claude).newMessage).toBeUndefined();
    expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull();

    cleanup();
    const dialog = renderRoute("/chat/ch-mkx-general?newChannel=1", "p-giulia");
    await screen.findByRole("dialog", { name: "New channel" });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(searchOf(dialog).newMessage).toBeUndefined();

    cleanup();
    const typingAt = renderRoute("/chat/ch-mkx-general", "p-giulia");
    const composer = await screen.findByRole("combobox", { name: "Message MKX · general" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "n", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(searchOf(typingAt).newMessage).toBeUndefined();
  });
});

describe("gruppi per persona e «New channel» nel gruppo", () => {
  it("cambiando «vedi come» un gruppo non eredita la scelta di chi guardava prima", async () => {
    const user = userEvent.setup();
    // STW: Laura e Giulia ne sono entrambe membri. Laura lo vuole aperto,
    // Giulia chiuso; tornando a Laura (dati già in cache, nessun
    // caricamento che rimonti la colonna) il gruppo è di nuovo aperto.
    renderRoute("/chat/ch-announcements", "p-laura");
    const toggle = async () => {
      const nav = await chatNav();
      return waitFor(() => {
        const g = nav.querySelector<HTMLElement>('[data-project-group="STW"]');
        expect(g).not.toBeNull();
        return within(g!).getAllByRole("button")[0]!;
      });
    };
    const setOpen = async (open: boolean) => {
      const button = await toggle();
      if ((button.getAttribute("aria-expanded") === "true") !== open) await user.click(button);
      expect(button).toHaveAttribute("aria-expanded", String(open));
    };
    const viewAs = async (name: RegExp) => {
      await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
      await user.click(await screen.findByRole("radio", { name }));
      await user.keyboard("{Escape}");
    };
    await setOpen(true);
    await viewAs(/Giulia/);
    await setOpen(false);
    await viewAs(/Laura/);
    await waitFor(async () => expect(await toggle()).toHaveAttribute("aria-expanded", "true"));
    await viewAs(/Giulia/);
    await waitFor(async () => expect(await toggle()).toHaveAttribute("aria-expanded", "false"));
  });

  it("il «+» del gruppo apre «New channel» con il progetto già scelto (solo con il permesso)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat/ch-announcements", "p-laura");
    const nav = await chatNav();
    await user.click(await within(nav).findByRole("button", { name: "New channel in AUD" }));
    await waitFor(() => expect(searchOf(router).newChannel).toBe("AUD"));
    expect(await screen.findByRole("dialog", { name: "New channel" })).toBeInTheDocument();
    cleanup();
    renderRoute("/chat/ch-announcements", "p-sara");
    const sara = await chatNav();
    await waitFor(() => expect(sara.querySelector("[data-project-group]")).not.toBeNull());
    expect(within(sara).queryByRole("button", { name: /^New channel in / })).toBeNull();
  });

  it("un silenziato non chiede attenzione (hasNews)", () => {
    const row = { notifyLevel: "muted", unread: 0, mentions: 2 } as Parameters<typeof hasNews>[0];
    expect(hasNews(row)).toBe(false);
    expect(hasNews({ ...row, notifyLevel: "all" })).toBe(true);
  });
});

describe("tastiera della Chat", () => {
  it("⌥↓/⌥↑ tra i canali, ⌘N apre «New message», Maiusc+Esc segna tutto letto", async () => {
    const router = renderRoute("/chat/ch-mkx-general", "p-giulia");
    const nav = await chatNav();
    await waitFor(() =>
      expect(nav.querySelector('[data-channel-row="ch-mkx-general"]')).not.toBeNull(),
    );
    const order = [...nav.querySelectorAll("[data-channel-row]")].map((r) =>
      r.getAttribute("data-channel-row"),
    );
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(router.state.location.pathname).not.toBe("/chat/ch-mkx-general"),
    );
    // Il canale dopo nell'ordine della colonna (i gruppi chiusi contano: l'ordine è dei dati).
    expect(router.state.location.pathname.startsWith("/chat/")).toBe(true);
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-mkx-general"));
    expect(order[0]).toBe("ch-mkx-general");

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(searchOf(router).newMessage).toBe("1"));
    expect(await screen.findByRole("dialog", { name: "New message" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() =>
      expect(nav.querySelectorAll("[data-channel-row][data-unread]").length).toBeGreaterThan(0),
    );
    fireEvent.keyDown(window, { key: "Escape", shiftKey: true });
    await waitFor(async () => {
      setSessionPersonId("p-giulia");
      const rows = await api.chat.listChannels();
      expect(rows.filter((r) => r.isMember && r.unread > 0)).toEqual([]);
    });
  });
});

describe("viste Threads, Mentions, Browse", () => {
  it("Mentions: i messaggi che nominano chi guarda, con il canale; il clic porta al messaggio", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat?view=mentions", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "Mentions" })).toBeInTheDocument();
    const rows = await waitFor(() => {
      const list = document.querySelectorAll<HTMLElement>("[data-mention-row]");
      expect(list.length).toBeGreaterThan(0);
      return list;
    });
    const id = rows[0]!.getAttribute("data-mention-row")!;
    await user.click(rows[0]!);
    await waitFor(() => expect(searchOf(router).message).toBe(id));
  });

  it("Threads: i thread seguiti con risposte nuove, che aprono il pannello", async () => {
    setSessionPersonId("p-giulia");
    const threads = await api.chat.listThreadsWithNews();
    renderRoute("/chat?view=threads", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "Threads" })).toBeInTheDocument();
    if (threads.length === 0) {
      expect(await screen.findByText("No new replies")).toBeInTheDocument();
      return;
    }
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-thread-row="${threads[0]!.root.id}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.getAttribute("href")).toMatch(
      new RegExp(`/chat/${threads[0]!.channelId}\\?thread=${threads[0]!.root.id}$`),
    );
  });

  it("Browse: aperti in cui non si è con «Join», archiviati sotto il loro filtro", async () => {
    const user = userEvent.setup();
    renderRoute("/chat?view=browse", "p-giulia");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Browse channels" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-browse-row]")).not.toBeNull());
    // Nessun DM, nessun archiviato in «All».
    expect(document.querySelector('[data-browse-row^="dm-"]')).toBeNull();
    expect(document.querySelector('[data-browse-row="ch-mkx-autumn"]')).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Archived" }));
    expect(document.querySelector('[data-browse-row="ch-mkx-autumn"]')).not.toBeNull();
  });
});
