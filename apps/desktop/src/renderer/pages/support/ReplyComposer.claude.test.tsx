import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { draftText } from "../../data/support/visibility";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { setLanguage } from "../../i18n";
import { resetPanelToggle } from "../../layout/claudePanel/panelEvents";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearToasts } from "../../tasks-ui/Toast";
import { PREVIEW_DOCKED_QUERY, SUPPORT_TWO_UP_QUERY } from "./format";
import { clearReplyStore, REPLY_UNDO_MS } from "./replyStore";

// La bozza di Claude nella risposta al cliente (area 10b, Task 10; shape
// `claude-drafts.md` §3.4, S6): il riquadro la mette nel campo dichiarato
// dalla pagina col segno unico «Claude's draft»; il segno sparisce alla
// prima modifica e all'invio, e non entra mai nel messaggio. Con testo già
// scritto la riga chiede «Replace or add below?». Da un'altra pagina la
// bozza aspetta («Put it in the field»). «Ask Claude» è il bottone della
// barra; ⌘J è del riquadro anche dentro la casella.

const DAVIDE = "p-davide";
const conv = (code: string) => state.supportConversations.find((c) => c.code === code)!;
type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
const draftEvents = (): DraftEvent[] =>
  [...state.conversationEvents.values()].flat().filter((e): e is DraftEvent => e.type === "draft");

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
  clearReplyStore();
  window.localStorage.clear();
  setMatchMedia(SUPPORT_TWO_UP_QUERY, true);
  setMatchMedia(PREVIEW_DOCKED_QUERY, true);
});
afterEach(() => {
  vi.useRealTimers();
  setStreamLatency(null);
  clearToasts();
  clearReplyStore();
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

const panel = () => document.getElementById("claude-panel");
const panelOpen = () => panel() !== null && !panel()!.hidden;
const panelBox = () => within(panel()!).getByRole("textbox", { name: "Message to Claude" });
const composer = () => screen.findByRole("form", { name: /^Reply to / });
const body = (form: HTMLElement) =>
  within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const mark = (form: HTMLElement) => form.querySelector("[data-claude-draft-mark]");
const draftRow = () => panel()?.querySelector<HTMLElement>("[data-draft-row]") ?? null;

async function askPanel(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!panelOpen()) await user.keyboard("{Control>}j{/Control}");
  await waitFor(() => expect(panelBox()).toHaveFocus());
  await user.type(panelBox(), `${text}{Enter}`);
}

describe("S6: la bozza dal riquadro nella risposta", () => {
  it("nel campo col segno; un tasto e il segno sparisce; inviato, il messaggio è della persona", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    const before = conv("ACQ-S2").messages.length;
    await askPanel(user, "write the reply");
    await waitFor(() => expect(body(form).value).toBe(draftText(conv("ACQ-S2"))));
    expect(mark(form)).toHaveTextContent("Claude's draft");
    expect(mark(form)).toHaveTextContent("edit it before sending");
    // Il campo dice dove sta il segno, e lo screen reader lo legge.
    expect(body(form).getAttribute("aria-describedby")).toBe(mark(form)!.id);
    expect(mark(form)).toHaveTextContent("Claude's draft, not edited yet");
    await waitFor(() => expect(draftRow()).toHaveTextContent("Put a draft in the reply to ACQ-S2"));
    expect(draftEvents().at(-1)!.status).toBe("placed");
    // Il fuoco resta nel riquadro: mettere la bozza non lo sposta.
    expect(panel()!.contains(document.activeElement)).toBe(true);
    // Nulla è partito, nessun toast.
    expect(conv("ACQ-S2").messages).toHaveLength(before);
    expect(document.querySelector("[data-toast]")).toBeNull();

    await user.type(body(form), "!");
    expect(mark(form)).toBeNull();
    expect(within(form).queryByText(/Edited from Claude's draft/)).toBeNull();
    // Il testo non è più quello di Claude: «Undo» non cancella le modifiche.
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("changed_after"));
    await waitFor(() =>
      expect(draftRow()).toHaveTextContent("The field changed afterwards · can't undo from here"),
    );
  });

  it("inviata senza modifiche: il messaggio non ha il segno né «on behalf of», e il segno non c'è più", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    await askPanel(user, "write the reply");
    await waitFor(() => expect(mark(form)).not.toBeNull());
    await user.click(within(form).getByRole("button", { name: "Send to customer" }));
    expect(mark(form)).toBeNull();
    const before = conv("ACQ-S2").messages.length;
    await act(() => vi.advanceTimersByTimeAsync(REPLY_UNDO_MS + 100));
    await waitFor(() => expect(conv("ACQ-S2").messages).toHaveLength(before + 1));
    const sent = conv("ACQ-S2").messages.at(-1)!;
    expect(sent).toMatchObject({ from: "team", authorId: DAVIDE });
    expect(sent.body).toBe(draftText(conv("ACQ-S2")));
    expect(JSON.stringify(sent).toLowerCase()).not.toMatch(/claude's draft|on behalf of/);
  });

  it("con testo già scritto la riga chiede; «Add below» tiene il testo sopra; «Undo» rimette solo quello", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    await user.type(body(form), "Ciao Mario,");
    await askPanel(user, "write the reply");
    const ask = await waitFor(() => {
      const row = draftRow();
      if (!row) throw new Error("no row");
      return within(row).getByRole("group", {
        name: "The reply already has text. Replace it, or add the draft below?",
      });
    });
    // Il campo non cambia finché non si sceglie.
    expect(body(form).value).toBe("Ciao Mario,");
    expect(draftEvents().at(-1)!.status).toBe("pending");
    await user.click(within(ask).getByRole("button", { name: "Add below" }));
    await waitFor(() =>
      expect(body(form).value).toBe(`Ciao Mario,\n\n${draftText(conv("ACQ-S2"))}`),
    );
    expect(mark(form)).not.toBeNull();
    const undo = await within(draftRow()!).findByRole("button", { name: "Undo" });
    await user.dblClick(undo);
    await waitFor(() => expect(body(form).value).toBe("Ciao Mario,"));
    expect(mark(form)).toBeNull();
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("undone"));
    expect(draftRow()).toHaveTextContent("Undone · the reply is as it was");
    // Il fuoco non finisce sul body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("chiesta da Tasks: `waiting` con «Put it in the field»; il clic porta alla conversazione e la mette, una volta", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/tasks", DAVIDE);
    await screen.findAllByRole("heading");
    await askPanel(user, "write the reply to ACQ-S2");
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("waiting"));
    const row = await waitFor(() => {
      const r = draftRow();
      if (!r) throw new Error("no row");
      return r;
    });
    expect(row).toHaveTextContent("The draft for the reply to ACQ-S2 is ready");
    // Il testo si legge senza cambiare pagina.
    expect(row).toHaveTextContent(draftText(conv("ACQ-S2")).slice(0, 30));
    const put = vi.spyOn(api, "settlePageEvent");
    await user.dblClick(within(row).getByRole("button", { name: "Put it in the field" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S2"));
    const form = await composer();
    await waitFor(() => expect(body(form).value).toBe(draftText(conv("ACQ-S2"))));
    expect(mark(form)).not.toBeNull();
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("placed"));
    expect(put.mock.calls.filter(([, , s]) => s === "placed")).toHaveLength(1);
  });
});

describe("Il segno unico nel Supporto (P12, DR 5)", () => {
  it("«Use draft» mette la bozza col segno; una modifica lo toglie, senza «Edited from Claude's draft»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    await user.click(within(form).getByRole("button", { name: "Use draft" }));
    expect(body(form).value).toBe(conv("ACQ-S2").claudeDraft);
    expect(mark(form)).toHaveTextContent("Claude's draft");
    expect(mark(form)).toHaveTextContent(/Used: ACQ-R\d+/);
    await user.type(body(form), " Thanks!");
    expect(mark(form)).toBeNull();
    expect(within(form).queryByText(/Edited from/)).toBeNull();
    // [DR 2]: riportato il testo a com'era, il segno non torna.
    await user.type(body(form), "{Backspace>8/}");
    expect(body(form).value).toBe(conv("ACQ-S2").claudeDraft);
    expect(mark(form)).toBeNull();
    expect(en.support.reply).not.toHaveProperty("editedFrom");
    expect(it_.support.reply).not.toHaveProperty("editedFrom");
  });

  it("il bottone della barra si chiama «Ask Claude» / «Chiedi a Claude», senza ⌘J nel `title`", async () => {
    const user = userEvent.setup();
    setStreamLatency(0);
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    const ask = within(form).getByRole("button", { name: "Ask Claude" });
    expect(ask.getAttribute("title") ?? "").not.toMatch(/J/);
    expect(within(form).queryByRole("button", { name: "Claude's draft" })).toBeNull();
    // Fa ciò che faceva: la bozza a pezzi nel corpo, col segno.
    await user.click(ask);
    await waitFor(() => expect(body(form).value).toMatch(/^Hi Lucia/));
    await waitFor(() => expect(mark(form)).not.toBeNull());
    act(() => setLanguage("it"));
    const itForm = await screen.findByRole("form", { name: /^Rispondi a / });
    expect(within(itForm).getByRole("button", { name: "Chiedi a Claude" })).toBeInTheDocument();
    expect(mark(itForm)).toHaveTextContent("Bozza di Claude");
  });

  it("⌘J con il fuoco nella casella apre e chiude il riquadro, e non avvia una bozza", async () => {
    const user = userEvent.setup();
    const draft = vi.spyOn(api.support, "draftReply");
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await composer();
    await user.type(body(form), "Mine.");
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelOpen()).toBe(true));
    expect(body(form).value).toBe("Mine.");
    expect(within(form).queryByRole("group")).toBeNull();
    body(form).focus();
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelOpen()).toBe(false));
    expect(draft).not.toHaveBeenCalled();
    expect(body(form).value).toBe("Mine.");
  });
});
