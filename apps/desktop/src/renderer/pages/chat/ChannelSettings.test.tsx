import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearChatColumnPrefs } from "./column";
import { clearDrafts } from "./drafts";

// Gestione dei canali (Task 6, shape chat-manage.md): creare con i permessi,
// le impostazioni a sezioni con i permessi, il privato visto da chi gestisce
// senza esserne membro (Review Focus 1), i DM altrui che non esistono, il
// nuovo messaggio diretto.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  clearChatColumnPrefs();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

const searchOf = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, string | undefined>;
const settings = () => screen.findByRole("region", { name: "Channel settings" });

describe("nuovo canale: dove si può crearlo", () => {
  it("Sara (Contributor ovunque) crea solo canali dell'azienda", async () => {
    const user = userEvent.setup();
    renderRoute("/chat/ch-announcements?newChannel=1", "p-sara");
    const dialog = await screen.findByRole("dialog", { name: "New channel" });
    const where = within(dialog).getByRole("button", { name: /^Where: / });
    expect(where).toHaveAccessibleName("Where: Company-wide");
    await user.click(where);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual([
      "Company-wide",
    ]);
  });

  it("Laura crea un privato in AUD con un membro del progetto, e ci arriva", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/AUD/chat/ch-aud-general?newChannel=AUD", "p-laura");
    const dialog = await screen.findByRole("dialog", { name: "New channel" });
    expect(within(dialog).getByRole("button", { name: /^Where: / })).toHaveAccessibleName(
      /^Where: AUD /,
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Price List");
    expect(within(dialog).getByText("AUD · price-list")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /^Private/ }));
    const picker = within(dialog).getByRole("list", { name: "Add members" });
    // Solo i membri del progetto: chi non è di AUD non compare.
    const aud = state.projectsById.get("prj-aud")!.memberIds;
    const offered = [...picker.querySelectorAll("[data-person-option]")].map((o) =>
      o.getAttribute("data-person-option"),
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((id) => aud.includes(id!))).toBe(true);
    expect(within(dialog).getByText("Only AUD members can be added.")).toBeInTheDocument();
    await user.click(picker.querySelector('[data-person-option="p-marco"]')!);
    await user.click(within(dialog).getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\/AUD\/chat\/ch-prj/));
    const created = state.channels.find((c) => c.name === "price-list")!;
    expect(created.visibility).toBe("private");
    expect(created.memberIds.sort()).toEqual(["p-laura", "p-marco"]);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "AUD · price-list",
    );
  });

  it("un nome già preso nell'ambito si dice in riga", async () => {
    const user = userEvent.setup();
    renderRoute("/chat/ch-aud-general?newChannel=AUD", "p-laura");
    const dialog = await screen.findByRole("dialog", { name: "New channel" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "releases");
    await user.click(within(dialog).getByRole("button", { name: "Create channel" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "AUD already has a channel with this name.",
    );
  });
});

describe("impostazioni del canale: con i permessi", () => {
  it("Marco (Developer, non creatore): argomento sì, nome no; niente Archivia né Elimina", async () => {
    renderRoute("/chat/ch-aud-releases?settings=1", "p-marco");
    const panel = await settings();
    await waitFor(() => expect(within(panel).getByText("About")).toBeInTheDocument());
    expect(within(panel).queryByRole("button", { name: /^Name: / })).toBeNull();
    expect(within(panel).getByRole("button", { name: /^Topic: / })).toBeInTheDocument();
    expect(
      within(panel).getByText(/Only the channel's creator or someone who manages channels in AUD/),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Archive channel" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Delete channel" })).toBeNull();
    // Eventi pubblicati in sola lettura: l'elenco degli attivi.
    expect(within(panel).queryByRole("checkbox")).toBeNull();
    expect(within(panel).getByText("PRs merged")).toBeInTheDocument();
  });

  it("Laura rinomina sul posto; archivia con l'Undo; elimina scrivendo il nome", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat/ch-aud-releases?settings=1", "p-laura");
    const panel = await settings();
    await user.click(await within(panel).findByRole("button", { name: /^Name: / }));
    const input = within(panel).getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "release notes{Enter}");
    await waitFor(() =>
      expect(state.channels.find((c) => c.id === "ch-aud-releases")!.name).toBe("release-notes"),
    );
    // La testata del canale segue.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("AUD · release-notes"),
    );

    await user.click(within(panel).getByRole("button", { name: "Archive channel" }));
    const archive = await screen.findByRole("dialog", { name: "Archive AUD · release-notes?" });
    await user.click(within(archive).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(state.channels.find((c) => c.id === "ch-aud-releases")!.archived).toBe(true),
    );
    expect(await screen.findByText(/This channel was archived by Laura Costa on/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(state.channels.find((c) => c.id === "ch-aud-releases")!.archived).toBe(false),
    );

    await user.click(within(await settings()).getByRole("button", { name: "Delete channel" }));
    const del = await screen.findByRole("dialog", { name: "Delete AUD · release-notes?" });
    const confirm = within(del).getByRole("button", { name: "Delete channel" });
    expect(confirm).toBeDisabled();
    await user.type(within(del).getByRole("textbox"), "release-notes");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(state.channels.some((c) => c.id === "ch-aud-releases")).toBe(false),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(searchOf(router).view).toBe("browse");
  });

  it("il general del progetto: membri del progetto, non si archivia né si elimina", async () => {
    renderRoute("/chat/ch-aud-general?settings=1", "p-laura");
    const panel = await settings();
    expect(await within(panel).findByText("Everyone in AUD is in this channel.")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Add people" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Archive channel" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Delete channel" })).toBeNull();
    expect(
      within(panel).getByText("The general channel of a project can't be archived or deleted."),
    ).toBeInTheDocument();
  });
});

describe("Review Focus 1: Roberta (full admin) e la privacy", () => {
  it("un privato di AUD: la pagina dell'esistenza, senza messaggi, conteggi né date dei messaggi", async () => {
    renderRoute("/chat/ch-aud-pricing", "p-roberta");
    const page = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-private-channel="ch-aud-pricing"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(page).getByRole("heading", { level: 1 })).toHaveTextContent("AUD · pricing");
    expect(within(page).getByText("You can't read this channel's messages.")).toBeInTheDocument();
    expect(within(page).getByText(/^Private · 3 members · Created by Matteo/)).toBeInTheDocument();
    await waitFor(() => expect(page.querySelectorAll("[data-member]")).toHaveLength(3));
    expect(within(page).getByRole("button", { name: "Archive channel" })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: "Delete channel" })).toBeInTheDocument();
    // Nessun flusso, nessuna casella, nessun testo dei messaggi, nessun «Add people».
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(within(page).queryByRole("button", { name: "Add people" })).toBeNull();
    const texts = state.chatMessages
      .filter((m) => m.channelId === "ch-aud-pricing" && m.text.length > 12)
      .map((m) => m.text.slice(0, 12));
    for (const text of texts) expect(page.textContent).not.toContain(text);
    expect(page.textContent).not.toMatch(/\d+ messages?/);
    // La colonna non lo elenca (non è membro).
    const nav = await screen.findByRole("navigation", { name: "Chat views" });
    expect(nav.querySelector('[data-channel-row="ch-aud-pricing"]')).toBeNull();
  });

  it("nelle impostazioni del privato non può aggiungere se stessa", async () => {
    const user = userEvent.setup();
    renderRoute("/chat/ch-aud-pricing?settings=1", "p-roberta");
    const panel = await settings();
    await user.click(await within(panel).findByRole("button", { name: "Add people" }));
    const self = await waitFor(() => {
      const el = panel.querySelector<HTMLElement>('[data-person-option="p-roberta"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(self).getByRole("checkbox")).toBeDisabled();
    expect(self).toHaveTextContent("Ask a member to add you");
  });

  it("i DM altrui: assenti dalla colonna e irraggiungibili dall'indirizzo", async () => {
    renderRoute("/chat/dm-launch-week", "p-roberta");
    expect(
      await screen.findByText("This channel doesn't exist or you can't see it."),
    ).toBeInTheDocument();
    const nav = await screen.findByRole("navigation", { name: "Chat views" });
    await waitFor(() => expect(nav.querySelector("[data-channel-row]")).not.toBeNull());
    expect(nav.querySelector('[data-channel-row="dm-launch-week"]')).toBeNull();
    expect(nav.querySelector('[data-channel-row="dm-davide-sara"]')).toBeNull();
    // Il suo DM con Giulia invece c'è.
    expect(nav.querySelector('[data-channel-row="dm-giulia-roberta"]')).not.toBeNull();
    // Nemmeno le impostazioni lo aprono.
    document.body.innerHTML = "";
    renderRoute("/chat/dm-launch-week?settings=1", "p-roberta");
    const panel = await settings();
    expect(
      await within(panel).findByText("This channel doesn't exist or you can't see it."),
    ).toBeInTheDocument();
  });
});

describe("nuovo messaggio diretto", () => {
  it("al più 8 persone compresa chi scrive; con le stesse persone riapre la conversazione", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat/ch-announcements?newMessage=1", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    const list = within(dialog).getByRole("list", { name: "To" });
    await waitFor(() => expect(list.querySelector("[data-person-option]")).not.toBeNull());
    await user.click(list.querySelector('[data-person-option="p-marco"]')!);
    expect(within(dialog).getByText("2 of 8 people")).toBeInTheDocument();
    // Esiste già il DM con Marco.
    const open = within(dialog).getByRole("button", { name: "Open conversation" });
    // Fino a 8: la nona persona non si aggiunge.
    const others = [...list.querySelectorAll<HTMLElement>("[data-person-option]")].filter(
      (o) => o.getAttribute("data-person-option") !== "p-marco",
    );
    for (const o of others.slice(0, 6)) await user.click(o);
    expect(within(dialog).getByText("8 of 8 people")).toBeInTheDocument();
    expect(within(others[6]!).getByRole("checkbox")).toBeDisabled();
    expect(
      within(dialog).getByText("A group message can have up to 8 people, you included."),
    ).toBeInTheDocument();
    for (const o of others.slice(0, 6)) await user.click(o);
    expect(open).toHaveTextContent("Open conversation");
    await user.click(within(dialog).getByRole("button", { name: "Open conversation" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/dm-giulia-marco"));
  });

  it("un gruppo nuovo con il primo messaggio: si crea, si apre, il messaggio c'è", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/chat/ch-announcements?newMessage=1", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New message" });
    const list = within(dialog).getByRole("list", { name: "To" });
    await waitFor(() => expect(list.querySelector("[data-person-option]")).not.toBeNull());
    await user.click(list.querySelector('[data-person-option="p-sara"]')!);
    await user.click(list.querySelector('[data-person-option="p-roberta"]')!);
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Hello both");
    await user.click(within(dialog).getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/chat\/dm/));
    const id = router.state.location.pathname.split("/").at(-1)!;
    const dm = state.channels.find((c) => c.id === id)!;
    expect(dm.memberIds.sort()).toEqual(["p-giulia", "p-roberta", "p-sara"]);
    setSessionPersonId("p-sara");
    const page = await api.chat.listMessages(id);
    setSessionPersonId("p-giulia");
    expect(page!.messages.map((m) => m.text)).toEqual(["Hello both"]);
  });
});
