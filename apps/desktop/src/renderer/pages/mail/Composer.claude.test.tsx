import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { mailDraftFor } from "../../data/claude/drafts";
import { MAIL_UNDO_MS } from "../../data/mail/compose";
import { MAIL_CASES, MAIL_MESSAGES } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { resetViewerGrants } from "../../data/viewer";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { setLanguage } from "../../i18n";
import { resetPanelToggle } from "../../layout/claudePanel/panelEvents";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";
import { MAIL_TWO_UP_QUERY } from "./MailPage";

// La bozza di Claude nel corpo di un'email (area 10b, Task 10, D1; shape
// `claude-drafts.md` §3.5): il campo `mailBody` lo dichiara la pagina — la
// conversazione aperta della propria casella, anche senza casella aperta
// (allora la bozza apre «Reply», [DR 6]) — o l'email nuova. Nulla parte
// senza «Send»; inviata, l'email non ha il segno né «on behalf of». Il segno
// è uno solo anche per «Ask Claude», e sparisce alla prima modifica. ⌘J è
// del riquadro anche dentro la casella [DR 14].

const GIULIA = "p-giulia";
const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
/** Nelle caselle di Giulia, Matteo e Laura. */
const BILLING = () => threadOf(MAIL_CASES.shared);
type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
const draftEvents = (): DraftEvent[] =>
  [...state.conversationEvents.values()].flat().filter((e): e is DraftEvent => e.type === "draft");
const SEEDED_SENDS = new Set(MAIL_MESSAGES.filter((m) => m.delivery).map((m) => m.id));
const mineSent = () => state.mailMessages.filter((m) => m.delivery && !SEEDED_SENDS.has(m.id));

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
  setMatchMedia(MAIL_TWO_UP_QUERY, true);
});
afterEach(() => {
  vi.useRealTimers();
  setStreamLatency(null);
  resetViewerGrants();
  closeGoogleAccount();
  act(() => setLanguage("en"));
  setSessionPersonId(GIULIA);
});

const panel = () => document.getElementById("claude-panel");
const panelOpen = () => panel() !== null && !panel()!.hidden;
const panelBox = () =>
  within(panel()!).getByRole("textbox", { name: /^(Message to Claude|Messaggio a Claude)$/ });
const pane = (threadId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-reading-pane="${threadId}"]`);
    if (!el) throw new Error("no pane");
    return el;
  });
const composer = (name: string | RegExp) => screen.findByRole("form", { name });
const body = (form: HTMLElement) =>
  within(form).getByRole("textbox", { name: /^(Message|Messaggio)$/ }) as HTMLTextAreaElement;
const mark = (form: HTMLElement) => form.querySelector("[data-claude-draft-mark]");
const draftRow = () => panel()?.querySelector<HTMLElement>("[data-draft-row]") ?? null;

async function askPanel(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!panelOpen()) await user.keyboard("{Control>}j{/Control}");
  await waitFor(() => expect(panelBox()).toHaveFocus());
  await user.type(panelBox(), `${text}{Enter}`);
}

describe("Posta dal riquadro (D1)", () => {
  it("la conversazione di Giulia senza casella aperta: la bozza apre «Reply» col testo e il segno; nulla parte", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoute(`/mail/${BILLING()}`, GIULIA);
    const p = await pane(BILLING());
    expect(p.querySelector("[data-composer]")).toBeNull();
    const messages = state.mailMessages.length;
    await askPanel(user, "write the reply");
    const expected = await mailDraftFor(GIULIA, BILLING(), "");
    if (!expected.ok) throw new Error(expected.reason);
    const form = await composer(/^Reply to /);
    await waitFor(() => expect(body(form).value).toBe(expected.text));
    expect(mark(form)).toHaveTextContent("Claude's draft");
    expect(mark(form)).toHaveTextContent("· edit it before sending");
    expect(body(form).getAttribute("aria-describedby")).toBe(mark(form)!.id);
    // Dal riquadro niente «Undo» né «Try again» nella casella [DR 7]: stanno nella riga.
    expect(within(form).queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("placed"));
    expect(draftRow()).toHaveTextContent("Put a draft in the reply to");
    // Il fuoco resta nel riquadro.
    expect(panel()!.contains(document.activeElement)).toBe(true);
    // Nulla parte da solo, anche aspettando.
    await act(() => vi.advanceTimersByTimeAsync(MAIL_UNDO_MS + 100));
    expect(state.mailMessages).toHaveLength(messages);
    expect(mineSent()).toEqual([]);

    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: /^Reply to / })).toBeNull());
    await act(() => vi.advanceTimersByTimeAsync(MAIL_UNDO_MS + 100));
    await waitFor(() => expect(mineSent()).toHaveLength(1));
    const sent = mineSent()[0]!;
    expect(sent.text).toBe(expected.text);
    expect(JSON.stringify(sent).toLowerCase()).not.toMatch(/claude's draft|on behalf of/);
    expect(document.querySelector("[data-claude-draft-mark]")).toBeNull();
  });

  it("l'email nuova aperta: «scrivi un'email … per dire che …» va nel corpo dell'email nuova", async () => {
    const user = userEvent.setup();
    renderRoute("/mail?compose=new", GIULIA);
    await composer("New email");
    act(() => setLanguage("it"));
    const form = await composer("Nuova email");
    await askPanel(user, "scrivi un'email a Sofia per dire che slitta a giovedì");
    await waitFor(() => expect(body(form).value).toContain("Slitta a giovedì."));
    expect(mark(form)).toHaveTextContent("Bozza di Claude");
    expect(mark(form)).toHaveTextContent("· modificala prima di inviare");
    await waitFor(() => expect(draftRow()).toHaveTextContent("Messa una bozza nella nuova email"));
    expect(mineSent()).toEqual([]);
  });

  it("una bozza chiesta da un'altra pagina non entra nel corpo dell'email aperta", async () => {
    const user = userEvent.setup();
    renderRoute("/mail?compose=new", GIULIA);
    const form = await composer("New email");
    await user.type(body(form), "Untouched.");
    // La risposta alla conversazione di Billing non è questo campo.
    await askPanel(user, "write the release notes");
    await new Promise((r) => setTimeout(r, 50));
    expect(body(form).value).toBe("Untouched.");
    expect(mark(form)).toBeNull();
  });
});

describe("Il segno unico nella Posta", () => {
  it("«Ask Claude»: il segno con «Undo» e «Try again»; dopo una modifica sparisce, senza «Edited from Claude's draft»", async () => {
    setStreamLatency(0);
    const user = userEvent.setup();
    renderRoute(`/mail/${BILLING()}`, GIULIA);
    const p = await pane(BILLING());
    await user.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await user.click(within(form).getByRole("button", { name: "Ask Claude" }));
    await user.type(
      within(form).getByRole("textbox", { name: "What should it say? (optional)" }),
      "tell them it lands on Monday{Enter}",
    );
    await waitFor(() => expect(mark(form)).not.toBeNull());
    expect(mark(form)).toHaveTextContent("Claude's draft");
    expect(within(form).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await user.type(body(form), "!");
    expect(mark(form)).toBeNull();
    expect(within(form).queryByText(/Edited from Claude's draft/)).toBeNull();
    expect(en.mail.compose).not.toHaveProperty("edited");
    expect(it_.mail.compose).not.toHaveProperty("edited");
  });

  it("⌘J con il fuoco nel corpo apre e chiude il riquadro, e non avvia una bozza né cambia il corpo", async () => {
    const user = userEvent.setup();
    renderRoute(`/mail/${BILLING()}`, GIULIA);
    const p = await pane(BILLING());
    await user.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await user.type(body(form), "Mine.");
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelOpen()).toBe(true));
    // Nessuna riga dell'indicazione di «Ask Claude».
    expect(within(form).queryByRole("textbox", { name: /What should it say/ })).toBeNull();
    body(form).focus();
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelOpen()).toBe(false));
    expect(body(form).value).toBe("Mine.");
    expect(within(form).queryByRole("textbox", { name: /What should it say/ })).toBeNull();
  });
});
