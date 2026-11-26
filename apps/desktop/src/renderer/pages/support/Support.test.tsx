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
  it("raggruppato per stato (area 8, F3): le non concluse in cima col punto, le chiuse sotto", async () => {
    await open("/p/ACQ/support");
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => g.textContent?.split(/\d/)[0])).toEqual([
      "Not concluded",
      "In triage",
      "Request open",
      // La risposta del widget è bastata, in fondo.
      "Answered",
    ]);
    // Aspetta te: una non conclusa da cui puoi aprire la richiesta.
    const waiting = within(groups[0]!).getAllByRole("option");
    expect(waiting.map((o) => o.dataset.supportRow)).toEqual(["ACQ-S3"]);
    expect(waiting[0]!).toHaveAccessibleName(
      /^Waiting on you, ACQ-S3, Visitor, Widget, Not concluded$/,
    );
    // Una conversazione con l'esito è chiusa: niente punto, niente attesa.
    const s2 = within(list).getByRole("option", { name: /ACQ-S2/ });
    expect(s2).toHaveAccessibleName(/^ACQ-S2, Lucia Benedetti, Widget, Request open$/);
    // Il canale ha un nome, non è solo un glifo.
    expect(within(groups[2]!).getByRole("img", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("Sara (senza support.manage): nessun punto «ti aspetta»", async () => {
    await open("/p/ACQ/support", "p-sara");
    const s3 = await screen.findByRole("option", { name: /ACQ-S3/ });
    expect(s3).not.toHaveAccessibleName(/Waiting on you/);
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
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S3"));
    await user.keyboard("j");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S1"));
    await user.keyboard("j");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S9"));
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
    // Il desiderio l'ha confermato il cliente nel triage: quando (brief §3).
    expect(block).toHaveTextContent(/Confirmed by the customer, .*10:09/);
    const messages = within(d).getByRole("list", { name: "Conversation" });
    expect(within(messages).getAllByText("Assistant (triage)").length).toBeGreaterThan(0);
    // Al cliente del widget il team non scrive (area 8, F3): nessun messaggio del team.
    expect(within(messages).queryByText(/^Sent to the/)).toBeNull();
    // Chiusa con l'esito: il cliente ha riscritto in ACQ-S9.
    expect(within(d).getByRole("link", { name: "ACQ-S9" })).toBeInTheDocument();
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

  it("API per i siti (S6): nella riga del dettaglio, cliente verificato o dichiarato dal sito; sul canale mcp nessuno dei due", async () => {
    await open("/p/ACQ/support/ACQ-S5");
    const verified = await detail("ACQ-S5");
    expect(within(verified).getByText(/Verified customer/)).toBeInTheDocument();
    expect(within(verified).queryByText(/Declared by the site/)).toBeNull();
    document.body.replaceChildren();
    await open("/p/ACQ/support/ACQ-S1");
    const declared = await detail("ACQ-S1");
    expect(within(declared).getByText(/Declared by the site/)).toBeInTheDocument();
    expect(within(declared).queryByText(/Verified customer/)).toBeNull();
    document.body.replaceChildren();
    await open("/p/ACQ/support/ACQ-S4");
    const mcp = await detail("ACQ-S4");
    expect(within(mcp).queryByText(/Verified customer|Declared by the site/)).toBeNull();
  });

  it("Sara vede la conversazione e la richiesta; sul canale mcp la riga «solo chi gestisce», nessuna casella", async () => {
    await open("/p/ACQ/support/ACQ-S4", "p-sara");
    const mcp = await detail("ACQ-S4");
    expect(
      within(mcp).getByText("Only people who can manage Support conversations reply here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /^Reply to/ })).toBeNull();
    document.body.replaceChildren();
    await open("/p/ACQ/support/ACQ-S2", "p-sara");
    const d = await detail("ACQ-S2");
    expect(within(d).getByRole("region", { name: "Request" })).toBeInTheDocument();
    // Del widget: nessuna riga sulla risposta, perché al cliente non scrive nessuno.
    expect(within(d).queryByText(/reply here/)).toBeNull();
    expect(screen.queryByRole("form", { name: /^Reply to/ })).toBeNull();
    expect(screen.queryByText("Claude prepared a draft")).toBeNull();
    expect(screen.queryByRole("button", { name: "Write to them by email" })).toBeNull();
    // «Segui» non c'è più (area 8, F3).
    expect(within(d).queryByRole("button", { name: /^Follow/ })).toBeNull();
  });

  it("al cliente del widget il team non scrive mai (area 8, F3): nessuna casella in nessuno stato, nemmeno con support.manage", async () => {
    for (const code of ["ACQ-S1", "ACQ-S2", "ACQ-S3", "ACQ-S8"]) {
      await open(`/p/ACQ/support/${code}`);
      await detail(code);
      expect(screen.queryByRole("form", { name: /^Reply to/ }), code).toBeNull();
      document.body.replaceChildren();
    }
    await open("/p/ACQ/support/ACQ-S1");
    expect(
      within(await detail("ACQ-S1")).getByText("No request yet · the assistant is still asking"),
    ).toBeInTheDocument();
    document.body.replaceChildren();
    // Il collaboratore del canale mcp sì.
    await open("/p/ACQ/support/ACQ-S4");
    expect(await composer()).toHaveAccessibleName("Reply to Technical office, Comune di Valfonda");
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

describe("Support — la risposta al collaboratore (canale mcp)", () => {
  it("«Send»: «Sending…» e «Sent to … · Undo» per 5 s; Undo non lascia traccia; poi parte", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    const send = within(form).getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Write a reply first");
    const body = within(form).getByRole("textbox", { name: "Message" });
    await user.type(body, "We'll call you tomorrow.");
    const before = conv("ACQ-S4").messages.length;
    await user.click(send);
    expect(body).toHaveValue("");
    expect(await screen.findByText("Sending…")).toBeInTheDocument();
    const toast = await screen.findByText("Sent to Technical office, Comune di Valfonda");
    await user.click(
      within(toast.closest("[role=status], li, div")!.parentElement!).getByRole("button", {
        name: "Undo",
      }),
    );
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(body).toHaveValue("We'll call you tomorrow.");
    await advance(REPLY_UNDO_MS + 100);
    expect(conv("ACQ-S4").messages).toHaveLength(before);

    await user.click(within(form).getByRole("button", { name: "Send" }));
    await advance(REPLY_UNDO_MS + 100);
    await waitFor(() => expect(conv("ACQ-S4").messages).toHaveLength(before + 1));
    expect(conv("ACQ-S4").messages.at(-1)).toMatchObject({
      from: "team",
      authorId: "p-matteo",
      body: "We'll call you tomorrow.",
    });
    const d = await detail("ACQ-S4");
    await waitFor(() => expect(within(d).queryByText("Sending…")).toBeNull());
  });

  it("n1: lo stesso testo dell'ultimo messaggio mio: «Sending…» si vede lo stesso", async () => {
    const user = fakeTime();
    conv("ACQ-S4").messages.push({
      id: "sup-m-same",
      from: "team",
      authorId: "p-matteo",
      body: "Same.",
      at: "2026-10-28T08:30:00Z",
    });
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Same.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sending…")).toBeInTheDocument();
    await advance(REPLY_UNDO_MS + 100);
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(screen.getAllByText("Same.")).toHaveLength(2);
  });

  it("I1: un invio alla volta — col primo nella finestra «Send» è fermo col perché; nessun invio si perde", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    const body = within(form).getByRole("textbox", { name: "Message" });
    const send = within(form).getByRole("button", { name: "Send" });
    const before = conv("ACQ-S4").messages.length;
    await user.type(body, "First reply.");
    await user.click(send);
    await user.type(body, "Second reply.");
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Wait: your previous reply is still in its Undo window");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await advance(REPLY_UNDO_MS + 100);
    await waitFor(() => expect(conv("ACQ-S4").messages).toHaveLength(before + 1));
    expect(conv("ACQ-S4").messages.at(-1)!.body).toBe("First reply.");
    // Il secondo testo è ancora nella casella, e ora parte.
    expect(body).toHaveValue("Second reply.");
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await advance(REPLY_UNDO_MS + 100);
    await waitFor(() => expect(conv("ACQ-S4").messages).toHaveLength(before + 2));
    expect(
      conv("ACQ-S4")
        .messages.slice(-2)
        .map((m) => m.body),
    ).toEqual(["First reply.", "Second reply."]);
  });

  it("invio non riuscito: «Not sent», il testo torna nella casella (sotto il nuovo), mai ritentato da solo", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    const body = within(form).getByRole("textbox", { name: "Message" });
    await user.type(body, "Hello again.");
    const before = conv("ACQ-S4").messages.length;
    failNext("support.replyToCollaborator");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    // Nella finestra si scrive già altro: il testo fallito torna SOTTO, non al suo posto.
    await user.type(body, "Also:");
    await advance(REPLY_UNDO_MS + 100);
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("Not sent. Your reply is back in the box");
    expect(body).toHaveValue("Also:\n\nHello again.");
    expect(screen.queryByText("Sending…")).toBeNull();
    await advance(REPLY_UNDO_MS * 3);
    expect(conv("ACQ-S4").messages).toHaveLength(before);
  });

  it("dopo l'invio il fuoco va al messaggio inviato", async () => {
    const user = fakeTime();
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Done.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await advance(REPLY_UNDO_MS + 100);
    const d = await detail("ACQ-S4");
    await waitFor(() =>
      expect(document.activeElement).toBe([...d.querySelectorAll("[data-support-message]")].at(-1)),
    );
    expect(document.activeElement).toHaveTextContent("Done.");
  });
});

describe("Support — R-K18 e errori di caricamento", () => {
  it("m4: un dettaglio che non si carica dice l'errore con «Retry», non «not found»", async () => {
    failNext("support.getSupportConversation");
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", "p-matteo");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the conversation.");
    expect(screen.queryByText("This conversation doesn't exist or you can't see it.")).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await detail("ACQ-S2")).toBeInTheDocument();
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

describe("Support — la bozza di Claude non c'è più (area 8, F3)", () => {
  it("niente «Ask Claude», niente bozza pronta, niente riga del suggerimento", async () => {
    await open("/p/ACQ/support/ACQ-S2");
    const d = await detail("ACQ-S2");
    expect(within(d).queryByRole("button", { name: /Ask Claude/ })).toBeNull();
    expect(within(d).queryByText("Claude prepared a draft")).toBeNull();
    expect(within(d).queryByRole("button", { name: "Use draft" })).toBeNull();
    expect(within(d).queryByText(/^Claude can help you/)).toBeNull();
  });
});

describe("Support — «Scrivigli per email» non c'è più (area 8, F3)", () => {
  it("né sotto la conversazione né nel «⋯», nemmeno per chi ha una casella e il cliente un indirizzo", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S2");
    await detail("ACQ-S2");
    expect(screen.queryByRole("button", { name: "Write to them by email" })).toBeNull();
    expect(screen.queryByText("Connect your Google account to write from Stubwise")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Write to them by email" })).toBeNull();
  });
});

describe("Support — «Apri la richiesta» su una non conclusa", () => {
  it("con backlog.create: dialogo, una richiesta sola, il blocco si riempie e il fuoco va al codice", async () => {
    const user = userEvent.setup();
    const requests = state.requests.length;
    await open("/p/ACQ/support/ACQ-S3");
    const d = await detail("ACQ-S3");
    // Area 8, F3: la non conclusa la decide il controllo dopo il silenzio, non «se n'è andato».
    expect(
      within(d).getByText("No request · the customer still needs something"),
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
      conversationCode: "ACQ-S3",
    });
  });

  it("m3: col desiderio riscritto, titolo e descrizione partono precompilati", async () => {
    conv("ACQ-S3").rewrittenWish = "Stay logged in on the portal for a week. Even on a phone.";
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S3");
    const d = await detail("ACQ-S3");
    await user.click(within(d).getByRole("button", { name: "Open the request" }));
    const dialog = await screen.findByRole("dialog", { name: "Open the request" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue(
      "Stay logged in on the portal for a week",
    );
    expect(within(dialog).getByRole("textbox", { name: "Description" })).toHaveValue(
      "Stay logged in on the portal for a week. Even on a phone.",
    );
  });

  it("senza support.manage o backlog.create: nessun bottone, la frase col «Who?»", async () => {
    for (const person of ["p-silvia", "p-sara"]) {
      await open("/p/ACQ/support/ACQ-S3", person);
      const d = await detail("ACQ-S3");
      expect(within(d).queryByRole("button", { name: "Open the request" })).toBeNull();
      const block = within(d).getByRole("region", { name: "Request" });
      expect(block).toHaveTextContent(
        "Someone who can manage Support conversations and create requests can open it.",
      );
      expect(
        within(block).getByRole("button", { name: "Who can manage Support conversations?" }),
      ).toBeInTheDocument();
      document.body.replaceChildren();
    }
  });
});

describe("Support — cambio di persona con un dettaglio aperto", () => {
  it("la casella si chiude tenendo il testo di chi scriveva; Sara ha la riga; un esterno «not found»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S4");
    const form = await composer();
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "Half a reply");
    await switchPersona(/Sara Montanari/, user);
    const d = await detail("ACQ-S4");
    expect(
      within(d).getByText("Only people who can manage Support conversations reply here."),
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

describe("Support — «Not concluded» su una answered (area 8, F3)", () => {
  it("dice che la risposta del widget è bastata, e dopo quanto silenzio; con support.manage la rimette fra quelle da fare", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support/ACQ-S8");
    const d = await detail("ACQ-S8");
    const block = within(d).getByRole("region", { name: "Request" });
    expect(block).toHaveTextContent("No request · the widget's answer was enough");
    expect(block).toHaveTextContent("No reply from the customer for 15 minutes");
    expect(block).toHaveTextContent("If it isn't settled, mark it not concluded");
    expect(within(block).queryByRole("button", { name: "Open the request" })).toBeNull();
    await user.click(within(block).getByRole("button", { name: "Not concluded" }));
    expect(await within(d).findByRole("button", { name: "Open the request" })).toBeInTheDocument();
    expect(conv("ACQ-S8").triage).toMatchObject({ outcome: "not_concluded", byUserId: "p-matteo" });
  });

  it("senza support.manage nessun bottone", async () => {
    await open("/p/ACQ/support/ACQ-S8", "p-sara");
    const d = await detail("ACQ-S8");
    expect(within(d).getByRole("region", { name: "Request" })).toHaveTextContent(
      "No request · the widget's answer was enough",
    );
    expect(within(d).queryByRole("button", { name: "Not concluded" })).toBeNull();
    // Senza il bottone, nemmeno la frase che invita a premerlo.
    expect(within(d).getByRole("region", { name: "Request" })).not.toHaveTextContent(
      "mark it not concluded",
    );
  });
});
