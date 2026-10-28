import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, state, visibleProjectIds } from "../../data/store";
import type { SupportMessage } from "../../data/types";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearToasts } from "../../tasks-ui/Toast";
import { MAIL_TWO_UP_QUERY } from "../mail/MailPage";
import { PREVIEW_DOCKED_QUERY, SUPPORT_TWO_UP_QUERY } from "./format";
import { clearReplyStore, REPLY_UNDO_MS } from "./replyStore";

// La sezione Support (Task 9 del piano 8a, shape support.md): elenco per
// stato, dettaglio con la richiesta in testa, la casella con la bozza di
// Claude che non parte mai da sola, l'anteprima del cliente, «Scrivigli anche
// per email», «Apri la richiesta», il cambio di persona. I widget stanno in
// `Widgets.test.tsx`; Home e ⌘K in `EntryPoints.test.tsx`.

const conv = (code: string) => state.supportConversations.find((c) => c.code === code)!;
/** Una persona che non vede ACQ (né admin né membro). */
const outsider = () =>
  PEOPLE.find(
    (p) => !p.isClaude && p.presetRole !== "admin" && !visibleProjectIds(p.id).has("prj-acq"),
  )!;

beforeEach(() => {
  setLatency(0);
  resetApi();
  clearReplyStore();
  window.localStorage.clear();
  setMatchMedia(SUPPORT_TWO_UP_QUERY, true);
  setMatchMedia(PREVIEW_DOCKED_QUERY, true);
});
afterEach(() => {
  vi.useRealTimers();
  setStreamLatency(null);
  resetViewerGrants();
  clearToasts();
  clearReplyStore();
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

async function open(path: string, person = "p-matteo") {
  const router = renderRoute(path, person);
  await screen.findByRole("heading", { level: 1, name: "Support" });
  return router;
}
const detail = (code: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-support-detail="${code}"]`);
    if (!el) throw new Error("no detail");
    return el;
  });
const composer = () => screen.findByRole("form", { name: /^Reply to / });

async function switchPersona(name: RegExp, user = userEvent.setup()) {
  // Il menu può essere rimasto aperto dal cambio precedente.
  if (!screen.queryByRole("dialog", { name: "Profile and settings" }))
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

function fakeTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("Support — l'elenco", () => {
  it("raggruppato per stato, chi aspetta noi in cima col punto e l'attesa", async () => {
    await open("/p/ACQ/support");
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => g.textContent?.split(/\d/)[0])).toEqual([
      "Waiting on us",
      "In triage",
      "Not concluded",
      "Request open",
    ]);
    const s2 = within(groups[0]!).getByRole("option");
    expect(s2).toHaveAccessibleName(
      /^Waiting on you, ACQ-S2, Lucia Benedetti, Widget, Waiting on us, waiting 3 h/,
    );
    expect(s2).toHaveTextContent("waiting 3 h");
    // Il canale ha un nome, non è solo un glifo.
    expect(within(groups[3]!).getByRole("img", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("Sara (senza support.reply): nessun punto «ti aspetta»", async () => {
    await open("/p/ACQ/support", "p-sara");
    const s2 = await screen.findByRole("option", { name: /ACQ-S2/ });
    expect(s2).not.toHaveAccessibleName(/Waiting on you/);
  });

  it("ricerca e canale; vuoto filtrato con «Clear filters»; J/K e Invio aprono", async () => {
    const user = userEvent.setup();
    const router = await open("/p/ACQ/support");
    const search = await screen.findByRole("searchbox", { name: "Search conversations" });
    await user.type(search, "zzz");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.click(screen.getByRole("button", { name: "Channel" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Claude Code" }));
    const list = screen.getByRole("listbox", { name: "Conversations" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.dataset.supportRow),
    ).toEqual(["ACQ-S4"]);
    await user.click(screen.getByRole("button", { name: /^Channel/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Any" }));
    list.focus();
    await user.keyboard("j");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S2"));
    await user.keyboard("j");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S1"));
  });

  it("errore con «Retry»: riprova e l'elenco arriva", async () => {
    failNext("support.listSupportConversations");
    const user = userEvent.setup();
    await open("/p/ACQ/support");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the conversations.");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("listbox", { name: "Conversations" })).toBeInTheDocument();
  });

  it("vuoto: per widget.manage «Set up a widget», per gli altri da dove nascono", async () => {
    state.supportConversations = [];
    await open("/p/ACQ/support");
    expect(await screen.findByText("No customer conversations yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up a widget" })).toBeInTheDocument();
  });

  it("vuoto per chi non gestisce i widget: nessun bottone, la frase", async () => {
    state.supportConversations = [];
    await open("/p/ACQ/support", "p-sara");
    expect(await screen.findByText("No customer conversations yet")).toBeInTheDocument();
    expect(
      screen.getByText("Conversations start from the project's widget or from Claude Code."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set up a widget" })).toBeNull();
  });

  it("caricamento: lo scheletro finché i dati non arrivano", async () => {
    setLatency(200);
    renderRoute("/p/ACQ/support", "p-matteo");
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });
});

describe("Support — il dettaglio", () => {
  it("in testa la richiesta (codice, desiderio, cosa vede il cliente), poi la conversazione", async () => {
    await open("/p/ACQ/support/ACQ-S2");
    const d = await detail("ACQ-S2");
    const block = within(d).getByRole("region", { name: "Request" });
    expect(within(block).getByRole("link", { name: /ACQ-R\d+/ })).toBeInTheDocument();
    expect(block).toHaveTextContent("Pay the larger bills");
    expect(block).toHaveTextContent(/The customer sees: (Received|In evaluation)/);
    const messages = within(d).getByRole("list", { name: "Conversation" });
    expect(within(messages).getAllByText("Assistant (triage)").length).toBeGreaterThan(0);
    expect(within(messages).getByText("Sent to the customer in the widget")).toBeInTheDocument();
  });

  it("Review Focus 5: 200 messaggi — i primi 3, una fascia «187 earlier messages», gli ultimi 10", async () => {
    const c = conv("ACQ-S2");
    const extra: SupportMessage[] = Array.from({ length: 200 - c.messages.length }, (_, i) => ({
      id: `extra-${i}`,
      from: i % 2 ? "team" : "customer",
      authorId: i % 2 ? "p-laura" : null,
      body: `Message number ${i}`,
      at: c.messages[3]!.at,
    }));
    c.messages.splice(4, 0, ...extra);
    expect(c.messages).toHaveLength(200);
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    const d = await detail("ACQ-S2");
    const list = within(d).getByRole("list", { name: "Conversation" });
    expect(list.querySelectorAll("[data-support-message]")).toHaveLength(13);
    // La richiesta resta in testa.
    expect(within(d).getByRole("region", { name: "Request" })).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "187 earlier messages" }));
    expect(list.querySelectorAll("[data-support-message]")).toHaveLength(200);
  });

  it("Sara vede la conversazione e la richiesta, ma nessuna casella, nessuna bozza, nessuna email", async () => {
    await open("/p/ACQ/support/ACQ-S2", "p-sara");
    const d = await detail("ACQ-S2");
    expect(within(d).getByRole("region", { name: "Request" })).toBeInTheDocument();
    expect(
      within(d).getByText("Only people who can reply to customers write here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /^Reply to/ })).toBeNull();
    expect(screen.queryByText("Claude prepared a draft")).toBeNull();
    expect(screen.queryByText(conv("ACQ-S2").claudeDraft!)).toBeNull();
    expect(screen.queryByRole("button", { name: "Write to them by email" })).toBeNull();
    // R-K12: può seguirla.
    await userEvent.click(within(d).getByRole("button", { name: "Follow" }));
    await waitFor(() => expect(conv("ACQ-S2").followerIds).toContain("p-sara"));
  });

  it("R-K15: in triage nessuna casella, nemmeno per chi risponde; su una non conclusa sì", async () => {
    await open("/p/ACQ/support/ACQ-S1");
    const d = await detail("ACQ-S1");
    expect(within(d).getByText(/still asking the customer questions/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /^Reply to/ })).toBeNull();
    expect(
      within(d).getByText("No request yet · the assistant is still asking"),
    ).toBeInTheDocument();
  });

  it("una conversazione inesistente e una di un progetto invisibile danno la stessa pagina (R-G5)", async () => {
    const { unmount } = renderRouteAndWait("/p/ACQ/support/ACQ-S99", "p-matteo");
    const a = (await screen.findByRole("heading", { level: 1 })).textContent;
    unmount();
    renderRouteAndWait("/p/ACQ/support/ACQ-S2", outsider().id);
    const b = (await screen.findByRole("heading", { level: 1 })).textContent;
    expect(a).toBe("This conversation doesn't exist or you can't see it.");
    expect(b).toBe(a);
  });
});

function renderRouteAndWait(path: string, person: string) {
  renderRoute(path, person);
  return { unmount: () => document.body.replaceChildren() };
}

describe("Support — la bozza di Claude e l'invio", () => {
  it("la bozza pronta non riempie la casella: si rilegge, «Use draft», e non parte senza «Send»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    const body = within(form).getByRole("textbox", { name: "Message" });
    expect(body).toHaveValue("");
    await user.click(within(form).getByRole("button", { name: "Show" }));
    expect(within(form).getByText(conv("ACQ-S2").claudeDraft!)).toBeInTheDocument();
    const before = conv("ACQ-S2").messages.length;
    await user.click(within(form).getByRole("button", { name: "Use draft" }));
    expect(body).toHaveValue(conv("ACQ-S2").claudeDraft);
    expect(
      within(form).getByText(/Draft by Claude from the conversation and ACQ-R\d+/),
    ).toBeInTheDocument();
    // Nulla è partito.
    expect(conv("ACQ-S2").messages).toHaveLength(before);
    await user.type(body, " Thanks!");
    expect(within(form).getByText("Edited from Claude's draft")).toBeInTheDocument();
    expect(conv("ACQ-S2").messages).toHaveLength(before);
  });

  it("«Claude's draft» la scrive nel corpo a pezzi; con testo già scritto chiede Replace / Add below", async () => {
    const user = userEvent.setup();
    setStreamLatency(0);
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    const body = within(form).getByRole("textbox", { name: "Message" });
    await user.type(body, "Mine.");
    await user.click(within(form).getByRole("button", { name: "Claude's draft" }));
    await user.click(within(form).getByRole("button", { name: "Add below" }));
    await waitFor(() =>
      expect(
        (within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value,
      ).toMatch(/^Mine\.\n\nHi Lucia/),
    );
    expect(conv("ACQ-S2").messages.at(-1)!.from).toBe("customer");
  });

  it("«Claude's draft» fallito: il testo resta, «Try again»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Keep me");
    failNext("support.draftReply");
    await user.click(within(form).getByRole("button", { name: "Claude's draft" }));
    await user.click(within(form).getByRole("button", { name: "Replace" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("Claude couldn't write a draft. Your text is unchanged.");
    expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Keep me");
  });

  it("«Send to customer»: «Sending…» e «Sent to … · Undo» per 5 s; Undo non lascia traccia; poi parte", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    const send = within(form).getByRole("button", { name: "Send to customer" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Write a reply first");
    const body = within(form).getByRole("textbox", { name: "Message" });
    await user.type(body, "We'll call you tomorrow.");
    const before = conv("ACQ-S2").messages.length;
    await user.click(send);
    expect(body).toHaveValue("");
    expect(await screen.findByText("Sending…")).toBeInTheDocument();
    const toast = await screen.findByText("Sent to Lucia Benedetti");
    await user.click(
      within(toast.closest("[role=status], li, div")!.parentElement!).getByRole("button", {
        name: "Undo",
      }),
    );
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(body).toHaveValue("We'll call you tomorrow.");
    await advance(REPLY_UNDO_MS + 100);
    expect(conv("ACQ-S2").messages).toHaveLength(before);

    await user.click(within(form).getByRole("button", { name: "Send to customer" }));
    await advance(REPLY_UNDO_MS + 100);
    await waitFor(() => expect(conv("ACQ-S2").messages).toHaveLength(before + 1));
    expect(conv("ACQ-S2").messages.at(-1)).toMatchObject({
      from: "team",
      authorId: "p-matteo",
      body: "We'll call you tomorrow.",
    });
    // Chi risponde segue da sé [A 14]; nessuna email partita.
    expect(conv("ACQ-S2").followerIds).toContain("p-matteo");
    const d = await detail("ACQ-S2");
    await waitFor(() => expect(within(d).queryByText("Sending…")).toBeNull());
  });

  it("invio fallito: «Not sent · Retry · Edit», testo intatto, mai ritentato da solo", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Hello again.");
    const before = conv("ACQ-S2").messages.length;
    failNext("support.replyToCustomer");
    await user.click(within(form).getByRole("button", { name: "Send to customer" }));
    await advance(REPLY_UNDO_MS + 100);
    const d = await detail("ACQ-S2");
    const alert = await within(d).findByRole("alert");
    expect(alert).toHaveTextContent("Not sent");
    await advance(REPLY_UNDO_MS * 3);
    expect(conv("ACQ-S2").messages).toHaveLength(before);
    await user.click(within(alert).getByRole("button", { name: "Edit" }));
    expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Hello again.");
  });
});

describe("Support — anteprima del cliente", () => {
  it("solo lo stato in parole e i messaggi: nessun nome del team, nessuna bozza", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    await detail("ACQ-S2");
    const button = screen.getByRole("button", { name: "Customer preview" });
    await user.click(button);
    const panel = await screen.findByRole("complementary", { name: "What Lucia sees" });
    const ladder = within(panel).getByRole("list", { name: "Request status" });
    expect(within(ladder).getAllByRole("listitem")).toHaveLength(5);
    expect(ladder.querySelector('[aria-current="step"]')).not.toBeNull();
    const messages = await within(panel).findByRole("list", { name: "Messages" });
    expect(within(messages).getAllByRole("listitem")).toHaveLength(conv("ACQ-S2").messages.length);
    expect(panel).not.toHaveTextContent("Laura");
    expect(panel).not.toHaveTextContent("Assistant (triage)");
    expect(panel).not.toHaveTextContent(conv("ACQ-S2").claudeDraft!);
    expect(panel).toHaveTextContent("Customer portal help");
    expect(panel).toHaveTextContent(
      "Internal comments, names, estimates and drafts are never shown.",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "What Lucia sees" })).toBeNull(),
    );
    expect(button).toHaveFocus();
  });
});

describe("Support — «Scrivigli anche per email» (R-K14)", () => {
  it("apre il compositore della Posta con la bozza, senza toccare la nuova email non inviata", async () => {
    setMatchMedia(MAIL_TWO_UP_QUERY, true);
    state.mailDrafts.push({
      id: "md-p-matteo-new",
      personId: "p-matteo",
      threadId: null,
      mode: "new",
      replyToMessageId: null,
      to: [],
      cc: [],
      subject: "Unsent",
      body: "My unsent email.",
      attachments: [],
      updatedAt: "2026-10-28T09:00:00Z",
    });
    const mail = structuredClone(state.mailMessages);
    const user = userEvent.setup();
    const router = await open("/p/ACQ/support/ACQ-S2");
    await composer();
    await user.click(screen.getByRole("button", { name: "Write to them by email" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/mail"));
    expect(router.state.location.search).toMatchObject({ compose: "support-ACQ-S2" });
    const form = await screen.findByRole("form", { name: /New email/i });
    await waitFor(() =>
      expect(
        (within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value,
      ).toMatch(/^Hi Lucia/),
    );
    expect(form).toHaveTextContent("lucia.benedetti@example.com");
    expect(within(form).getByDisplayValue(/^About your request ACQ-R\d+$/)).toBeInTheDocument();
    expect(state.mailDrafts.find((d) => d.id === "md-p-matteo-new")!.body).toBe("My unsent email.");
    expect(state.mailMessages).toEqual(mail);
  });

  it("senza indirizzo la voce non c'è sotto la casella; nel «⋯» è disattivata col perché", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S3");
    await composer();
    expect(screen.queryByRole("button", { name: "Write to them by email" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const item = screen.getByRole("menuitem", { name: "Write to them by email" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("The customer didn't leave an email address")).toBeInTheDocument();
  });
});

describe("Support — «Apri la richiesta» su una non conclusa", () => {
  it("con backlog.create: dialogo, una richiesta sola, il blocco si riempie e il fuoco va al codice", async () => {
    const user = userEvent.setup();
    const requests = state.requests.length;
    await open("/p/ACQ/support/ACQ-S3");
    const d = await detail("ACQ-S3");
    expect(
      within(d).getByText("No request · the customer left before confirming"),
    ).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Open the request" }));
    const dialog = await screen.findByRole("dialog", { name: "Open the request" });
    expect(dialog).toHaveTextContent(
      "The conversation (2 messages) will be attached to the request.",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Logged out often");
    await user.click(within(dialog).getByRole("button", { name: "Create request" }));
    const code = await within(d).findByRole("link", { name: /ACQ-R\d+.*Logged out often/ });
    await waitFor(() => expect(code).toHaveFocus());
    expect(state.requests).toHaveLength(requests + 1);
    expect(state.requests.at(-1)!.origin).toEqual({
      kind: "support",
      conversationId: conv("ACQ-S3").id,
    });
  });

  it("senza backlog.create: nessun bottone, la frase", async () => {
    await open("/p/ACQ/support/ACQ-S3", "p-silvia");
    const d = await detail("ACQ-S3");
    expect(within(d).queryByRole("button", { name: "Open the request" })).toBeNull();
    expect(
      within(d).getByText("Someone with permission to create requests can open it."),
    ).toBeInTheDocument();
  });
});

describe("Support — cambio di persona con un dettaglio aperto", () => {
  it("la casella si chiude tenendo il testo di chi scriveva; Sara ha la riga; un esterno «not found»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Half a reply");
    await switchPersona(/Sara Montanari/, user);
    const d = await detail("ACQ-S2");
    expect(
      within(d).getByText("Only people who can reply to customers write here."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Half a reply")).toBeNull();
    await switchPersona(/Matteo Conti/, user);
    const again = await composer();
    expect(within(again).getByRole("textbox", { name: "Message" })).toHaveValue("Half a reply");
    await switchPersona(new RegExp(outsider().name), user);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This conversation doesn't exist or you can't see it.",
      }),
    ).toBeInTheDocument();
  });
});
