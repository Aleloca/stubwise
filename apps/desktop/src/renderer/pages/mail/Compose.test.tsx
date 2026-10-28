import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failNext, mail, resetApi, setLatency } from "../../data/api";
import { MAIL_UNDO_MS } from "../../data/mail/compose";
import { MAIL_CASES, MAIL_MESSAGES } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";
import { takeCompose } from "./composeRequest";
import { MAIL_TWO_UP_QUERY } from "./MailPage";

// Scrivere dalla Posta (Task 8, shape mail-compose.md): rispondere in fondo
// alla conversazione, la bozza salvata e ritrovata, l'invio con «Annulla»
// che non lascia traccia, l'invio fallito con «Riprova», il cambio di
// persona nei 5 s (Review Focus 4), la bozza di Claude che non parte mai da
// sola, il Drive che offre solo i file che si vedono, la nuova email.

const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
/** Le note della chiamata: da Matteo a Giulia, Laura in copia. */
const CALL_NOTES = () => threadOf(MAIL_CASES.audLow);
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, string | undefined>;

async function openMail(url: string, personId = "p-giulia") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Mail" });
  return router;
}

const pane = (threadId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-reading-pane="${threadId}"]`);
    if (!el) throw new Error("no pane");
    return el;
  });
const composer = (name: string | RegExp) => screen.findByRole("form", { name });
const body = (form: HTMLElement) => within(form).getByRole("textbox", { name: "Message" });

async function switchPersona(name: RegExp, user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

/** I timer finti che scorrono anche da soli: i 5 s si saltano con `advance`. */
function fakeTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Apre «Reply» sulle note della chiamata e scrive il corpo. */
async function replyWith(text: string, user = userEvent.setup()) {
  const p = await pane(CALL_NOTES());
  await user.click(within(p).getByRole("button", { name: "Reply" }));
  const form = await composer("Reply to Matteo Conti");
  await user.type(body(form), text);
  return { p, form };
}

/** Gli invii fatti nel test (non le email mandate dalle automazioni del seme, area 7). */
const SEEDED_SENDS = new Set(MAIL_MESSAGES.filter((m) => m.delivery).map((m) => m.id));
const mineSent = () => state.mailMessages.filter((m) => m.delivery && !SEEDED_SENDS.has(m.id));

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(MAIL_TWO_UP_QUERY, true);
});
afterEach(() => {
  vi.useRealTimers();
  setStreamLatency(null);
  resetViewerGrants();
  closeGoogleAccount();
  setSessionPersonId("p-giulia");
});

describe("Rispondere in fondo alla conversazione", () => {
  it("«Reply»: la casella in fondo con destinatario e oggetto, il fuoco nel corpo, il bottone segnato", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const p = await pane(CALL_NOTES());
    const reply = within(p).getByRole("button", { name: "Reply" });
    expect(reply).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(reply);
    const form = await composer("Reply to Matteo Conti");
    await waitFor(() => expect(body(form)).toHaveFocus());
    expect(reply).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("textbox", { name: "Subject" })).toHaveValue(
      "Re: Notes from today's client call are in the AUD folder",
    );
    expect(within(form).getByRole("list", { name: "To" })).toHaveTextContent("Matteo Conti");
    // Cc nascosto: la risposta non ne ha.
    expect(within(form).queryByRole("combobox", { name: "Cc" })).toBeNull();
    // La conversazione resta sopra.
    expect(p.querySelector("article[data-message]")).not.toBeNull();
  });

  it("la bozza si salva da sé, l'elenco la segna, e riaprendo la conversazione la casella è già lì (senza fuoco)", async () => {
    const router = await openMail(`/mail/${CALL_NOTES()}`);
    const { form } = await replyWith("Thanks Matteo, reading them tonight.");
    expect(await within(form).findByText("Saved", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(state.mailDrafts.map((d) => [d.personId, d.threadId, d.body])).toEqual([
      ["p-giulia", CALL_NOTES(), "Thanks Matteo, reading them tonight."],
    ]);
    const row = within(screen.getByRole("listbox", { name: "Conversations" })).getByRole("option", {
      name: /Notes from today's client call/,
    });
    await waitFor(() => expect(row).toHaveAccessibleName(/Draft/));

    // Esc chiude la casella e tiene la bozza; il fuoco torna a «Reply», che l'aveva aperta.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    const p = await pane(CALL_NOTES());
    await waitFor(() => expect(within(p).getByRole("button", { name: "Reply" })).toHaveFocus());
    expect(within(p).getByRole("button", { name: "Reply" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Un'altra conversazione e ritorno: la casella è aperta con il testo, il fuoco no.
    await router.navigate({
      to: "/mail/$threadId",
      params: { threadId: threadOf(MAIL_CASES.stwHigh) },
    });
    await pane(threadOf(MAIL_CASES.stwHigh));
    await router.navigate({ to: "/mail/$threadId", params: { threadId: CALL_NOTES() } });
    const again = await composer("Reply to Matteo Conti");
    await waitFor(() => expect(body(again)).toHaveValue("Thanks Matteo, reading them tonight."));
    expect(body(again)).not.toHaveFocus();
  });

  it("passare a «Forward» tiene il corpo e cambia destinatari e oggetto [A 1]", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Body stays.");
    await userEvent.click(within(p).getByRole("button", { name: "Forward" }));
    const fwd = await composer("Forward");
    expect(fwd).toBe(form);
    await waitFor(() =>
      expect(within(fwd).getByRole("textbox", { name: "Subject" })).toHaveValue(
        "Fwd: Notes from today's client call are in the AUD folder",
      ),
    );
    expect(body(fwd)).toHaveValue("Body stays.");
    expect(within(fwd).queryByRole("list", { name: "To" })).toBeNull();
    expect(within(p).getByRole("button", { name: "Forward" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("R / A / F dal pannello (fuori dai campi) aprono la casella; nei campi sono lettere", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const p = await pane(CALL_NOTES());
    p.focus();
    await userEvent.keyboard("a");
    const form = await composer("Reply to all (2)");
    await waitFor(() => expect(body(form)).toHaveFocus());
    await userEvent.keyboard("f");
    expect(body(form)).toHaveValue("f");
    expect(within(form).getByRole("list", { name: "Cc" })).toHaveTextContent("Laura Costa");
  });

  it("destinatari: suggerimenti del team, un indirizzo scritto diventa gettone, uno sbagliato ferma «Send»", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const { form } = await replyWith("Hello");
    const to = within(form).getByRole("combobox", { name: "To" });
    await userEvent.type(to, "chia");
    const options = await screen.findByRole("listbox", { name: "Suggestions" });
    expect(within(options).getByText("Team")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(within(form).getByRole("list", { name: "To" })).toHaveTextContent("Chiara Lombardi");
    await userEvent.type(to, "nope,");
    expect(within(form).getByRole("list", { name: "To" })).toHaveTextContent("nope");
    expect(within(form).getByText("Not a valid address")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Send" })).toBeDisabled();
    // Backspace su campo vuoto: il primo seleziona, il secondo toglie.
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(within(form).getByRole("list", { name: "To" })).not.toHaveTextContent("nope");
    expect(within(form).getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("Invio con «Annulla» (Review Focus 4)", () => {
  it("«Send»: «Sending…» in fondo solo per chi scrive; «Undo» entro 5 s non lascia traccia e riapre tutto com'era", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const before = (await mail.getMailThread(CALL_NOTES())).messages.map((m) => m.id);
    const { p, form } = await replyWith("Undo me please.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(await within(p).findByText("Sending…")).toBeInTheDocument();
    const toast = await screen.findByText("Sending to Matteo Conti");
    await advance(MAIL_UNDO_MS - 1000);
    await user.click(within(toast.closest("[data-toast]")!).getByRole("button", { name: "Undo" }));

    const form2 = await composer("Reply to Matteo Conti");
    await waitFor(() => expect(body(form2)).toHaveValue("Undo me please."));
    await waitFor(() => expect(body(form2)).toHaveFocus());
    expect(within(p).queryByText("Sending…")).toBeNull();
    // Nessuna traccia nella conversazione: il testo è solo nella casella.
    const articles = [...p.querySelectorAll("article[data-message]")];
    expect(articles.some((a) => a.textContent?.includes("Undo me please."))).toBe(false);
    expect(articles.map((a) => a.getAttribute("data-message"))).toEqual(before);
    await advance(MAIL_UNDO_MS * 3);
    expect((await mail.getMailThread(CALL_NOTES())).messages.map((m) => m.id)).toEqual(before);
    expect(mineSent()).toEqual([]);
  });

  it("⌘Z mentre l'avviso è visibile annulla l'invio", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Cmd Z.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(p).findByText("Sending…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await composer("Reply to Matteo Conti");
    expect(mineSent()).toEqual([]);
  });

  it("dopo 5 s parte: «Sent» sotto il messaggio, poi un messaggio normale", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("On its way.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    await advance(MAIL_UNDO_MS + 100);
    expect(await within(p).findByText("Sent")).toBeInTheDocument();
    expect(mineSent()[0]!.delivery!.state).toBe("sent");
    await advance(3100);
    await waitFor(() => expect(within(p).queryByText("Sent")).toBeNull());
    expect(within(p).getByText("On its way.")).toBeInTheDocument();
  });

  it("fallito: «Not sent» col perché, testo intatto, mai ritentato da solo; «Retry», «Edit», «Delete»", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("To a bad address.", user);
    await user.type(
      within(form).getByRole("combobox", { name: "To" }),
      "luca@bounce.example{Enter}",
    );
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    await advance(MAIL_UNDO_MS + 100);
    const alert = await within(p).findByRole("alert");
    expect(alert).toHaveTextContent("Not sent: address not found (luca@bounce.example)");
    expect(within(p).getByText("To a bad address.")).toBeInTheDocument();
    await advance(60_000);
    expect(mineSent()).toHaveLength(1);
    expect(mineSent()[0]!.delivery!.state).toBe("failed");

    // «Retry»: di nuovo nei 5 s, poi di nuovo fallito; sempre una riga sola.
    await user.click(within(p).getByRole("button", { name: "Retry" }));
    await within(p).findByText("Sending…");
    await advance(MAIL_UNDO_MS + 100);
    await within(p).findByRole("alert");
    expect(mineSent()).toHaveLength(1);

    // «Edit»: la casella si riapre col testo intatto, il tentativo esce.
    await user.click(within(p).getByRole("button", { name: "Edit" }));
    const again = await composer("Reply to Matteo Conti");
    await waitFor(() => expect(body(again)).toHaveValue("To a bad address."));
    expect(mineSent()).toEqual([]);
  });

  it("«Delete» toglie il tentativo fallito e la bozza resta", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Keep me as draft.", user);
    await user.type(
      within(form).getByRole("combobox", { name: "To" }),
      "luca@bounce.example{Enter}",
    );
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await advance(MAIL_UNDO_MS + 100);
    await within(p).findByRole("alert");
    await user.click(within(p).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(p).queryByRole("alert")).toBeNull());
    expect(mineSent()).toEqual([]);
    expect(state.mailDrafts.map((d) => d.body)).toEqual(["Keep me as draft."]);
  });

  it("cambio di persona nei 5 s: l'avviso sparisce, nulla si vede né si annulla, l'invio resta di chi l'ha fatto", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const p = await pane(CALL_NOTES());
    // «Reply all»: Matteo in A, Laura in Cc.
    await user.click(within(p).getByRole("button", { name: "Reply all" }));
    const form = await composer("Reply to all (2)");
    await user.type(body(form), "For Matteo and Laura.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    await screen.findByText("Sending to Matteo Conti and Laura Costa");

    // Laura, destinataria in copia: nei 5 s non vede né l'invio né l'avviso.
    await switchPersona(/Laura Costa/, user);
    await pane(CALL_NOTES());
    await waitFor(() => expect(screen.queryByText(/^Sending to/)).toBeNull());
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.queryByText("For Matteo and Laura.")).toBeNull();
    // Il ⌘Z della persona nuova non annulla l'invio della persona di prima.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await advance(MAIL_UNDO_MS + 100);
    const sent = mineSent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.delivery).toMatchObject({ state: "sent", sentById: "p-giulia" });
    expect(sent[0]!.from.personId).toBe("p-giulia");
    // Dopo i 5 s la vede come arrivata da Giulia, senza «Sending…».
    expect(
      await within(await pane(CALL_NOTES())).findByText("For Matteo and Laura."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("cambio di persona nei 5 s verso chi non è destinatario: non vede mai nulla", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    // Giulia risponde solo a Matteo: Laura (in copia del messaggio di prima) non è destinataria.
    const { p, form } = await replyWith("Only Matteo should get this.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    await switchPersona(/Laura Costa/, user);
    await pane(CALL_NOTES());
    await advance(MAIL_UNDO_MS + 100);
    expect(mineSent()[0]!.delivery).toMatchObject({ state: "sent", sentById: "p-giulia" });
    await advance(1000);
    expect(screen.queryByText("Only Matteo should get this.")).toBeNull();
  });

  it("cambio di persona con la casella aperta: la bozza resta della persona di prima, l'altra non la vede", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    await replyWith("Half-written by Giulia");
    await switchPersona(/Laura Costa/);
    await pane(CALL_NOTES());
    await waitFor(() =>
      expect(state.mailDrafts.map((d) => [d.personId, d.body])).toEqual([
        ["p-giulia", "Half-written by Giulia"],
      ]),
    );
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByDisplayValue("Half-written by Giulia")).toBeNull();
  });
});

describe("La bozza di Claude", () => {
  it("scrive nel corpo in streaming, dice da dove viene e non parte mai da sola", async () => {
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const p = await pane(threadOf(MAIL_CASES.shared));
    const sentBefore = state.mailMessages.length;
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await userEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    const hint = within(form).getByRole("textbox", { name: "What should it say? (optional)" });
    await waitFor(() => expect(hint).toHaveFocus());
    await userEvent.type(hint, "tell them it lands on Monday{Enter}");
    await waitFor(() =>
      expect((body(form) as HTMLTextAreaElement).value).toContain("It lands on Monday."),
    );
    expect(
      await within(form).findByText(/Draft by Claude from this conversation and AUD/),
    ).toBeInTheDocument();
    expect(within(form).getByText(/Used:/)).toBeInTheDocument();
    // Nulla parte: né un messaggio né un invio, anche aspettando.
    await new Promise((r) => setTimeout(r, 50));
    expect(state.mailMessages).toHaveLength(sentBefore);
    expect(mineSent()).toEqual([]);
    // «Undo» rimette il corpo com'era (vuoto).
    await userEvent.click(within(form).getByRole("button", { name: "Undo" }));
    expect(body(form)).toHaveValue("");
  });

  it("con testo già scritto chiede «Replace» o «Add below»; non sovrascrive in silenzio [A 10]", async () => {
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const p = await pane(threadOf(MAIL_CASES.shared));
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await userEvent.type(body(form), "My own line.");
    await userEvent.keyboard("{Control>}j{/Control}");
    await userEvent.type(
      within(form).getByRole("textbox", { name: "What should it say? (optional)" }),
      "{Enter}",
    );
    expect(
      within(form).getByText("Replace your text or add Claude's draft below it?"),
    ).toBeInTheDocument();
    expect(body(form)).toHaveValue("My own line.");
    await userEvent.click(within(form).getByRole("button", { name: "Add below" }));
    await within(form).findByText(/Draft by Claude/);
    expect((body(form) as HTMLTextAreaElement).value.startsWith("My own line.\n\n")).toBe(true);
    // Una modifica: la riga diventa «Edited from Claude's draft».
    await userEvent.type(body(form), "!");
    expect(within(form).getByText("Edited from Claude's draft")).toBeInTheDocument();
  });
});

describe("Allegati dal Drive", () => {
  it("solo i file del Drive che vedo: niente nascosti, niente progetti altrui; la riga dice cosa riceve il destinatario", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const { form } = await replyWith("See attached.");
    await userEvent.click(within(form).getByRole("button", { name: "Attach" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "From the AUD Drive" }));
    const dialog = await screen.findByRole("dialog", { name: "From the AUD Drive" });
    const options = await within(dialog).findAllByRole("option");
    const names = options.map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("Contratto quadro Audin 2025"))).toBe(true);
    // Il nascosto non c'è; ogni file è di AUD.
    expect(names.some((n) => n.includes("bozza superata"))).toBe(false);
    for (const n of names) expect(n).toMatch(/AUD-F\d+/);
    await userEvent.click(options.find((o) => o.textContent?.includes("Contratto quadro"))!);
    expect(
      within(dialog).getByText("Recipients need access on Google to open it."),
    ).toBeInTheDocument();
    await userEvent.click(options.find((o) => o.textContent?.includes("Kickoff Audin 2.0"))!);
    expect(
      within(dialog).getByText(
        "Recipients get a copy of the file. Stubwise doesn't share the Drive with them.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach 2 files" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(form).getByText(/Contratto quadro Audin 2025/)).toBeInTheDocument();
    // «Saved» può essere ancora quello del testo (sotto carico salvato prima
    // degli allegati): si aspetta la bozza con gli allegati, non la scritta.
    await waitFor(() =>
      expect(state.mailDrafts[0]?.attachments.map((a) => a.as).sort()).toEqual(["copy", "link"]),
    );
    expect(await within(form).findByText("Saved")).toBeInTheDocument();
  });
});

describe("Nuova email", () => {
  it("⌘N in Mail apre la nuova email nel pannello (non il «New message» della Chat), con la riga «Draft» in elenco", async () => {
    const router = await openMail("/mail");
    await screen.findByRole("listbox", { name: "Conversations" });
    document.body.focus();
    await userEvent.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(search(router).compose).toBe("new"));
    expect(search(router).newMessage).toBeUndefined();
    expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull();
    expect(await screen.findByRole("heading", { level: 2, name: "New email" })).toBeInTheDocument();
    const form = await composer("New email");
    await waitFor(() => expect(within(form).getByRole("combobox", { name: "To" })).toHaveFocus());
    await userEvent.type(within(form).getByRole("textbox", { name: "Subject" }), "Kick-off");
    expect(
      await screen.findByRole("button", { name: "Draft · Kick-off" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    // «Close» la lascia lì; la riga la riapre.
    await userEvent.click(
      within(form.closest("[data-new-email]")! as HTMLElement).getByRole("button", {
        name: "Close",
      }),
    );
    await waitFor(() => expect(search(router).compose).toBeUndefined());
    // Il fuoco torna a «New email».
    await waitFor(() => expect(screen.getByRole("button", { name: "New email" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Draft · Kick-off" }));
    const again = await composer("New email");
    await waitFor(() =>
      expect(within(again).getByRole("textbox", { name: "Subject" })).toHaveValue("Kick-off"),
    );
  });

  it("«New email» in testa all'elenco; inviata, diventa una conversazione che si apre", async () => {
    const user = fakeTime();
    const router = await openMail("/mail");
    await user.click(await screen.findByRole("button", { name: "New email" }));
    const form = await composer("New email");
    await user.type(
      within(form).getByRole("combobox", { name: "To" }),
      "marco.bellini@example.com{Enter}",
    );
    await user.type(within(form).getByRole("textbox", { name: "Subject" }), "Kick-off");
    await user.type(body(form), "See you Monday.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/mail\/th-/));
    expect(search(router).compose).toBeUndefined();
    expect(await screen.findByText("Sending…")).toBeInTheDocument();
  });

  it("senza oggetto: al primo «Send» la riga «Send without a subject?»", async () => {
    await openMail("/mail?compose=new");
    const form = await composer("New email");
    await userEvent.type(
      within(form).getByRole("combobox", { name: "To" }),
      "marco.bellini@example.com{Enter}",
    );
    await userEvent.type(body(form), "Hi");
    await userEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(within(form).getByText("Send without a subject?")).toBeInTheDocument();
    expect(mineSent()).toEqual([]);
    await userEvent.click(within(form).getByRole("button", { name: "Add subject" }));
    expect(within(form).getByRole("textbox", { name: "Subject" })).toHaveFocus();
  });
});

describe("Fix round 1", () => {
  it("⌘Z si spegne quando l'avviso se ne va (×)", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Keep sending.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    const toast = (await screen.findByText("Sending to Matteo Conti")).closest("[data-toast]")!;
    await user.click(within(toast as HTMLElement).getByRole("button", { name: "Dismiss" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await advance(100);
    expect(mineSent()).toHaveLength(1);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("⌘Z con un menu aperto è del menu; chiuso il menu, annulla", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Menu first.", user);
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await within(p).findByText("Sending…");
    await user.click(within(p).getByRole("button", { name: "More actions" }));
    const item = (await screen.findAllByRole("menuitem"))[0]!;
    await waitFor(() => expect(item).toHaveFocus());
    fireEvent.keyDown(item, { key: "z", ctrlKey: true });
    await advance(100);
    expect(mineSent()).toHaveLength(1);
    await user.keyboard("{Escape}");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await composer("Reply to Matteo Conti");
    expect(mineSent()).toEqual([]);
  });

  it("«Undo» di una nuova email eliminata la riapre (compose=new) e non lascia richieste in attesa", async () => {
    const router = await openMail("/mail?compose=new");
    const form = await composer("New email");
    await userEvent.type(within(form).getByRole("textbox", { name: "Subject" }), "Kept");
    await within(form).findByText("Saved", {}, { timeout: 3000 });
    await userEvent.click(within(form).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(search(router).compose).toBeUndefined());
    expect(state.mailDrafts).toEqual([]);
    const toast = (await screen.findByText("Draft discarded")).closest("[data-toast]")!;
    await userEvent.click(within(toast as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(search(router).compose).toBe("new"));
    const again = await composer("New email");
    await waitFor(() =>
      expect(within(again).getByRole("textbox", { name: "Subject" })).toHaveValue("Kept"),
    );
    await waitFor(() => expect(body(again)).toHaveFocus());
    expect(takeCompose(null)).toBeNull();
  });

  it("«Stop» (⌘.) tiene il testo fin lì, rende il campo modificabile e cita solo le task già scritte", async () => {
    setStreamLatency(40);
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const p = await pane(threadOf(MAIL_CASES.shared));
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await userEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    await userEvent.type(
      within(form).getByRole("textbox", { name: "What should it say? (optional)" }),
      "tell them it lands on Monday{Enter}",
    );
    // Mentre scrive: sola lettura, «Send» spento, «Stop» al posto di «Ask Claude».
    const writing = await within(form).findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(writing).toHaveAttribute("aria-busy", "true"));
    await waitFor(() => expect(writing.textContent?.length ?? 0).toBeGreaterThan(0));
    expect(within(form).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await userEvent.keyboard("{Control>}.{/Control}");
    await within(form).findByText(/Draft by Claude/);
    const text = (body(form) as HTMLTextAreaElement).value;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("Giulia Ferri");
    expect(body(form)).not.toHaveAttribute("aria-readonly");
    await waitFor(() => expect(body(form)).toHaveFocus());
    const used = within(form).queryByText(/Used:/);
    for (const code of used?.textContent?.match(/[A-Z]{2,4}-\d+/g) ?? []) {
      const title = state.tasks.find((task) => task.code === code)!.title;
      expect(text).toContain(title);
    }
    expect(mineSent()).toEqual([]);
  });

  it("i limiti di Gmail: oltre 10 file la riga lo dice; oltre 25 MB il gettone e «Send» lo dicono", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const { form } = await replyWith("Files.");
    const input = form.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = Array.from({ length: 11 }, (_, i) => new File(["x"], `f${i}.txt`));
    await userEvent.upload(input, files);
    expect(within(form).getByText("You can attach up to 10 files")).toBeInTheDocument();
    expect(within(form).getAllByRole("button", { name: /^Remove f\d+\.txt$/ })).toHaveLength(10);
    // Tolto un file, ne entra uno da 26 MB: sfora.
    await userEvent.click(within(form).getByRole("button", { name: "Remove f0.txt" }));
    const big = new File(["x"], "big.zip");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(
      within(form).getByText("Too large: Gmail accepts up to 25 MB per email"),
    ).toBeInTheDocument();
    const send = within(form).getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Too large: Gmail accepts up to 25 MB per email");
    expect(form.querySelector('[data-attachment="big.zip"]')).toHaveAttribute(
      "title",
      "Too large: Gmail accepts up to 25 MB per email",
    );
  });

  it("«Delete» che non riesce lo dice, e il tentativo fallito resta col suo testo", async () => {
    const user = fakeTime();
    await openMail(`/mail/${CALL_NOTES()}`);
    const { p, form } = await replyWith("Bounce me.", user);
    await user.type(
      within(form).getByRole("combobox", { name: "To" }),
      "luca@bounce.example{Enter}",
    );
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await advance(MAIL_UNDO_MS + 100);
    await within(p).findByRole("alert");
    failNext("mail.deleteFailedSend");
    await user.click(within(p).getByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText("That didn't work. Your text is unchanged; try again."),
    ).toBeInTheDocument();
    expect(mineSent()).toHaveLength(1);
    expect(mineSent()[0]!.delivery!.state).toBe("failed");
    expect(within(p).getByText("Bounce me.")).toBeInTheDocument();
  });

  describe("file del Drive sparito dopo un invio fallito", () => {
    const KICKOFF = () => state.driveFiles.find((f) => f.name.includes("Kickoff Audin 2.0"))!;

    /** Una risposta con un file del Drive di AUD, a un indirizzo che rifiuta; poi il file sparisce. */
    async function failedWithFile() {
      const user = fakeTime();
      await openMail(`/mail/${CALL_NOTES()}`);
      const { p, form } = await replyWith("With the kickoff deck.", user);
      await user.click(within(form).getByRole("button", { name: "Attach" }));
      await user.click(await screen.findByRole("menuitem", { name: "From the AUD Drive" }));
      const dialog = await screen.findByRole("dialog", { name: "From the AUD Drive" });
      const options = await within(dialog).findAllByRole("option");
      await user.click(options.find((o) => o.textContent?.includes("Kickoff Audin 2.0"))!);
      await user.click(within(dialog).getByRole("button", { name: "Attach 1 file" }));
      await user.type(
        within(form).getByRole("combobox", { name: "To" }),
        "luca@bounce.example{Enter}",
      );
      await user.click(within(form).getByRole("button", { name: "Send" }));
      await advance(MAIL_UNDO_MS + 100);
      await within(p).findByRole("alert");
      KICKOFF().unavailable = "deleted";
      return { p, user };
    }

    it("«Edit»: la casella torna col testo, senza il file, e lo dice", async () => {
      const { p, user } = await failedWithFile();
      await user.click(within(p).getByRole("button", { name: "Edit" }));
      const again = await composer("Reply to Matteo Conti");
      await waitFor(() => expect(body(again)).toHaveValue("With the kickoff deck."));
      expect(await screen.findByText(/1 attachment didn't fit back in the draft: .*Kickoff Audin 2\.0/)).toBeInTheDocument();
      expect(within(again).queryByText(/Kickoff Audin 2\.0/)).toBeNull();
      expect(mineSent()).toEqual([]);
    });

    it("«Delete»: la bozza resta senza il file, e lo dice", async () => {
      const { p, user } = await failedWithFile();
      await user.click(within(p).getByRole("button", { name: "Delete" }));
      expect(await screen.findByText(/1 attachment didn't fit back in the draft: .*Kickoff Audin 2\.0/)).toBeInTheDocument();
      expect(mineSent()).toEqual([]);
      expect(state.mailDrafts.map((d) => [d.body, d.attachments.length])).toEqual([
        ["With the kickoff deck.", 0],
      ]);
    });
  });

  it("la bozza di Claude finita non ruba il fuoco a un altro campo della casella", async () => {
    setStreamLatency(40);
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const p = await pane(threadOf(MAIL_CASES.shared));
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await userEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    await userEvent.type(
      within(form).getByRole("textbox", { name: "What should it say? (optional)" }),
      "tell them it lands on Monday{Enter}",
    );
    const writing = await within(form).findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(writing.textContent?.length ?? 0).toBeGreaterThan(0));
    // Mentre Claude scrive, chi scrive passa ai destinatari.
    const to = within(form).getByRole("combobox", { name: "To" });
    to.focus();
    await within(form).findByText(/Draft by Claude/, {}, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(to).toHaveFocus();
  });

  it("«Stop» col clic: il fuoco torna nel corpo modificabile, non resta su «Ask Claude»", async () => {
    setStreamLatency(40);
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const p = await pane(threadOf(MAIL_CASES.shared));
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer(/^Reply to /);
    await userEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    await userEvent.type(
      within(form).getByRole("textbox", { name: "What should it say? (optional)" }),
      "tell them it lands on Monday{Enter}",
    );
    const writing = await within(form).findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(writing.textContent?.length ?? 0).toBeGreaterThan(0));
    await userEvent.click(within(form).getByRole("button", { name: "Stop" }));
    await within(form).findByText(/Draft by Claude/);
    await waitFor(() => expect(body(form)).toHaveFocus());
    expect(within(form).getByRole("button", { name: "Ask Claude" })).not.toHaveFocus();
  });
});

describe("«Salvato» solo a bozza salvata (area 8)", () => {
  // Senza userEvent.type: ogni lettera è un passo che può sforare il debounce
  // (DRAFT_SAVE_MS) sotto carico. fireEvent.change è un passo solo, e le
  // attese sono sullo stato vero della bozza, non sull'orologio.
  const write = (form: HTMLElement, text: string) =>
    fireEvent.change(body(form), { target: { value: text } });
  const savedBody = (text: string) => state.mailDrafts[0]?.body === text;

  it("modifica dopo un salvataggio: niente «Salvato» finché il nuovo salvataggio non finisce", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const p = await pane(CALL_NOTES());
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer("Reply to Matteo Conti");
    write(form, "First.");
    expect(await within(form).findByText("Saved")).toBeInTheDocument();
    write(form, "First and second.");
    // Subito dopo la modifica la scritta non c'è più: la bozza non è salvata.
    expect(within(form).queryByText("Saved")).toBeNull();
    await waitFor(() => expect(savedBody("First and second.")).toBe(true));
    expect(await within(form).findByText("Saved")).toBeInTheDocument();
  });

  it("modifica durante un salvataggio: niente «Salvato» al suo termine", async () => {
    await openMail(`/mail/${CALL_NOTES()}`);
    const p = await pane(CALL_NOTES());
    await userEvent.click(within(p).getByRole("button", { name: "Reply" }));
    const form = await composer("Reply to Matteo Conti");
    setLatency(400);
    write(form, "First.");
    // Il salvataggio è in volo: lo dice la scritta «Saving…».
    await within(form).findByText("Saving…");
    write(form, "First and second.");
    // Da qui al salvataggio dell'ultimo testo «Saved» non deve mai comparire.
    let early = false;
    const watch = new MutationObserver(() => {
      if (within(form).queryByText("Saved") && !savedBody("First and second.")) early = true;    });
    watch.observe(form, { childList: true, subtree: true, characterData: true });
    try {
      await waitFor(() => expect(savedBody("First and second.")).toBe(true));
      expect(early).toBe(false);
      expect(await within(form).findByText("Saved")).toBeInTheDocument();
    } finally {
      watch.disconnect();
    }
  });
});
