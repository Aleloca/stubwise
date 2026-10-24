import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { getSessionPersonId, setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants, revokeInstancePermission } from "../../data/viewer";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const column = () => screen.getByRole("navigation", { name: "Claude views" });
/** La riga di una conversazione nell'elenco (lancia finché non c'è: per `waitFor`). */
const rowOf = (id: string) => {
  const el = document.querySelector(`[data-conversation-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el as HTMLElement;
};
const rowIds = () =>
  [...document.querySelectorAll("[data-conversation-row]")].map((el) =>
    el.getAttribute("data-conversation-row"),
  );
/** Una lettura come un'altra persona, senza cambiare chi guarda nel test. */
async function as<R>(personId: string, call: () => Promise<R>): Promise<R> {
  const before = getSessionPersonId();
  setSessionPersonId(personId);
  try {
    return await call();
  } finally {
    setSessionPersonId(before);
  }
}

describe("destinazione Claude: colonna e atterraggio", () => {
  it("#/claude apre una conversazione nuova vuota, con i suggerimenti; la colonna conta ciò che vedo", async () => {
    renderRoute("/claude", "p-giulia");
    expect(
      await screen.findByRole("heading", { level: 1, name: "New conversation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question for Claude" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What should I do today?" })).toBeInTheDocument();
    const nav = column();
    expect(within(nav).getByRole("link", { name: /New conversation/ })).toBeInTheDocument();
    const live = await within(nav).findByRole("link", { name: /^Working now/ });
    const visibleLive = await as("p-giulia", () => api.listConversations({ scope: "live" }));
    await waitFor(() => expect(live).toHaveTextContent(String(visibleLive.length)));
    expect(within(nav).getByRole("link", { name: /^Mine/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /^Public/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /^Finished/ })).toBeInTheDocument();
    // «Recent»: le mie ultime conversazioni, non quelle degli altri.
    const recent = within(nav).getByRole("list", { name: "Recent" });
    await waitFor(() =>
      expect(within(recent).getByRole("link", { name: /Where do my projects stand/ })).toBeTruthy(),
    );
    expect(within(recent).queryByRole("link", { name: /CSV import/ })).toBeNull();
  });

  it("senza conversazioni proprie il gruppo «Recent» non c'è", async () => {
    renderRoute("/claude", "p-sara");
    await screen.findByRole("heading", { level: 1, name: "New conversation" });
    await within(column()).findByRole("link", { name: /^Mine/ });
    expect(within(column()).queryByText("Recent")).toBeNull();
  });

  it("senza `claude.public.view` la voce Public non c'è", async () => {
    revokeInstancePermission("p-sara", "claude.public.view");
    renderRoute("/claude", "p-sara");
    await screen.findByRole("heading", { level: 1, name: "New conversation" });
    expect(within(column()).queryByRole("link", { name: /^Public/ })).toBeNull();
  });

  it("la prima domanda crea la conversazione e ci porta dentro; finisce in Mine", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/claude", "p-giulia");
    const box = await screen.findByRole("textbox", { name: "Your question for Claude" });
    await user.type(box, "Explain MKX-7{Enter}");
    await waitFor(() => expect(path(router)).toMatch(/^\/claude\/cv-/));
    const id = path(router).split("/")[2]!;
    const created = state.conversations.find((c) => c.id === id)!;
    expect(created).toMatchObject({ kind: "free", ownerId: "p-giulia" });
    await waitFor(() => expect(created.title).toBe("Explain MKX-7"));
    expect(await screen.findByRole("heading", { level: 1, name: "Explain MKX-7" })).toBeTruthy();
    const mine = await as("p-giulia", () => api.listConversations({ scope: "mine" }));
    expect(mine.map((r) => r.id)).toContain(id);
  });

  it("un suggerimento si mette nella casella, non parte da solo", async () => {
    const user = userEvent.setup();
    const before = state.conversations.length;
    renderRoute("/claude", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "Where do my projects stand?" }));
    expect(screen.getByRole("textbox", { name: "Your question for Claude" })).toHaveValue(
      "Where do my projects stand?",
    );
    expect(state.conversations).toHaveLength(before);
  });
});

describe("destinazione Claude: il primo messaggio che non va", () => {
  it("atterraggio: se l'invio fallisce la domanda resta con «Resend», e la conversazione vuota non è fra le mie", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/claude", "p-giulia");
    const box = await screen.findByRole("textbox", { name: "Your question for Claude" });
    api.failNext("sendMessage");
    await user.type(box, "Explain MKX-7{Enter}");
    await waitFor(() => expect(path(router)).toMatch(/^\/claude\/cv-/));
    const id = path(router).split("/")[2]!;
    const failed = await screen.findByText(/it didn't go through/);
    const row = failed.closest("[data-user-message]") as HTMLElement;
    expect(row).toHaveTextContent("Explain MKX-7");
    const mine = async () =>
      (await as("p-giulia", () => api.listConversations({ scope: "mine" }))).map((r) => r.id);
    expect(await mine()).not.toContain(id);
    await waitFor(() =>
      expect(
        within(within(column()).getByRole("list", { name: "Recent" })).queryByRole("link", {
          name: /New conversation|Explain MKX-7/,
        }),
      ).toBeNull(),
    );
    await user.click(within(row).getByRole("button", { name: "Resend" }));
    await waitFor(() =>
      expect(
        (state.conversationEvents.get(id) ?? []).some(
          (e) => e.type === "user" && e.text === "Explain MKX-7",
        ),
      ).toBe(true),
    );
    expect(await mine()).toContain(id);
  });

  it("continuazione: se l'invio fallisce il testo resta con «Resend» nella nuova, che non è fra le mie", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/claude/cv-giulia-callbacks", "p-sara");
    const box = await screen.findByRole("combobox", { name: "Message to Claude" });
    api.failNext("sendMessage");
    await user.type(box, "Where do my projects stand?{Enter}");
    await waitFor(() => expect(path(router)).not.toBe("/claude/cv-giulia-callbacks"));
    const id = path(router).split("/")[2]!;
    expect(state.conversations.find((c) => c.id === id)).toMatchObject({
      ownerId: "p-sara",
      continuesFromId: "cv-giulia-callbacks",
    });
    const failed = await screen.findByText(/it didn't go through/);
    const row = failed.closest("[data-user-message]") as HTMLElement;
    expect(row).toHaveTextContent("Where do my projects stand?");
    const mine = async () =>
      (await as("p-sara", () => api.listConversations({ scope: "mine" }))).map((r) => r.id);
    expect(await mine()).not.toContain(id);
    await user.click(within(row).getByRole("button", { name: "Resend" }));
    await waitFor(async () => expect(await mine()).toContain(id));
  });
});

describe("destinazione Claude: palette", () => {
  it("«Ask Claude…» dalla palette mette la domanda nella casella, da rivedere", async () => {
    const before = state.conversations.length;
    const router = renderRoute("/claude?ask=Explain%20AUD-3", "p-marco");
    const box = await screen.findByRole("textbox", { name: "Your question for Claude" });
    expect(box).toHaveValue("Explain AUD-3");
    // La domanda non resta nell'indirizzo, e nulla parte da solo.
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(state.conversations).toHaveLength(before);
  });

  it("«ask claude» scritto per trovare il comando non diventa la domanda", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "ask claude");
    await user.click(await screen.findByRole("option", { name: /^Ask Claude…/ }));
    await waitFor(() => expect(path(router)).toBe("/claude"));
    expect(
      await screen.findByRole("textbox", { name: "Your question for Claude" }),
    ).toHaveValue("");
  });

  it("dalla palette: «Ask Claude: “…”» con il testo scritto", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "what slipped this week");
    await user.click(
      await screen.findByRole("option", { name: /Ask Claude: “what slipped this week”/ }),
    );
    await waitFor(() => expect(path(router)).toBe("/claude"));
    expect(
      await screen.findByRole("textbox", { name: "Your question for Claude" }),
    ).toHaveValue("what slipped this week");
  });
});

describe("destinazione Claude: elenchi per persona", () => {
  it("Sara vede la pubblica di Giulia fra le Public, e nessuna privata di Giulia fra le sue", async () => {
    const router = renderRoute("/claude?scope=public", "p-sara");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Public conversations" }),
    ).toBeInTheDocument();
    await waitFor(() => rowOf("cv-giulia-callbacks"));
    expect(rowIds()).not.toContain("cv-giulia-week");
    await userEvent.click(within(column()).getByRole("link", { name: /^Mine/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ scope: "mine" }));
    await screen.findByRole("heading", { level: 1, name: "My conversations" });
    expect(rowIds().some((id) => id?.startsWith("cv-giulia"))).toBe(false);
  });

  it("Working now: tipo, codice e titolo, progetto, attività in parole; chi aspetta me va in testa", async () => {
    renderRoute("/claude?scope=live", "p-marco");
    await waitFor(() => rowOf("cv-run-aud-3"));
    const row = rowOf("cv-run-aud-3");
    expect(row).toHaveTextContent("Task run");
    expect(row).toHaveTextContent("AUD-3");
    expect(row).toHaveTextContent("Asking a question");
    expect(row).toHaveTextContent("Waiting on you");
    // In testa: le sessioni che aspettano chi guarda.
    expect(rowIds()[0]).toBe("cv-run-aud-3");
  });

  it("la sessione della posta solo al titolare: in Finished e dal link diretto", async () => {
    renderRoute("/claude?scope=finished", "p-roberta");
    await screen.findByRole("heading", { level: 1, name: "Finished sessions" });
    await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    expect(rowIds()).not.toContain("cv-mail-giulia");
  });

  it("il link diretto alla posta di Giulia, per Roberta, è «doesn't exist»", async () => {
    renderRoute("/claude/cv-mail-giulia", "p-roberta");
    expect(
      await screen.findByText("This conversation doesn't exist or you can't see it."),
    ).toBeInTheDocument();
  });

  it("Giulia vede la sua sessione di posta fra le concluse", async () => {
    renderRoute("/claude?scope=finished", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Finished sessions" });
    await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
    await waitFor(() => rowOf("cv-mail-giulia"));
    expect(rowOf("cv-mail-giulia")).toHaveTextContent("Mail");
  });

  it("filtro per tipo; senza risultati «Nothing matches» e «Clear filters»", async () => {
    const user = userEvent.setup();
    renderRoute("/claude?scope=live", "p-laura");
    await waitFor(() => rowOf("cv-run-stw-3"));
    await user.click(screen.getByRole("button", { name: /^Type/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Docs" }));
    await screen.findByText("Nothing matches");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => rowOf("cv-run-stw-3"));
  });
});

describe("destinazione Claude: pubblica, privata, continuazione", () => {
  it("«Make public» elenca i progetti toccati e chiede la responsabilità; poi la testata lo dice", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-giulia-week", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "Make public" }));
    const dialog = await screen.findByRole("dialog", { name: "Make this conversation public?" });
    const touched = state.conversations.find((c) => c.id === "cv-giulia-week")!.touchedProjectIds;
    const projects = within(dialog).getByRole("list", { name: "Projects Claude read or changed" });
    expect(within(projects).getAllByRole("listitem")).toHaveLength(touched.length);
    expect(projects).toHaveTextContent("MKX");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Make public, I'm responsible" }));
    await waitFor(() =>
      expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.visibility).toBe(
        "public",
      ),
    );
    expect(await screen.findByText(/Public · made public by Giulia Ferri on/)).toBeTruthy();
    // E si torna privata.
    await user.click(screen.getByRole("button", { name: "Make private" }));
    await waitFor(() =>
      expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.visibility).toBe(
        "private",
      ),
    );
  });

  it("una pubblica che tocca un progetto nuovo: fascia per l'autore, dialogo col solo progetto nuovo (R-E6)", async () => {
    const user = userEvent.setup();
    await as("p-giulia", () => api.sendMessage("cv-giulia-callbacks", { text: "Explain MKX-7" }));
    const c = () => state.conversations.find((x) => x.id === "cv-giulia-callbacks")!;
    expect(c().privateFromIndex).not.toBeNull();
    renderRoute("/claude/cv-giulia-callbacks", "p-giulia");
    expect(
      await screen.findByText("New messages are private: Claude used MKX. Confirm to share them."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review and share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share the new messages?" });
    const list = await within(dialog).findByRole("list", { name: "New projects" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("MKX");
    await user.click(within(dialog).getByRole("button", { name: "Share, I'm responsible" }));
    await waitFor(() => expect(c().privateFromIndex).toBeNull());
    expect(c().publishedProjectIds).toContain("prj-mkx");
  });

  it("se l'elenco dei progetti non si legge, il dialogo lo dice e offre «Retry»", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-giulia-week", "p-giulia");
    const button = await screen.findByRole("button", { name: "Make public" });
    api.failNext("setVisibility");
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Make this conversation public?" });
    expect(await within(dialog).findByText("Couldn't check which projects Claude used.")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Make public, I'm responsible" }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    const list = await within(dialog).findByRole("list", { name: "Projects Claude read or changed" });
    expect(list).toHaveTextContent("MKX");
  });

  it("«Cancel» non cambia nulla", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-giulia-week", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "Make public" }));
    const dialog = await screen.findByRole("dialog", { name: "Make this conversation public?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.visibility).toBe(
      "private",
    );
  });

  it("Sara scrive nella pubblica di Giulia: nasce una sua conversazione privata, Giulia non la vede", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/claude/cv-giulia-callbacks", "p-sara");
    expect(
      await screen.findByText(
        "What you write starts your own private conversation. Claude will act as you.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    const box = screen.getByRole("combobox", { name: "Message to Claude" });
    expect(box).toHaveAttribute("placeholder", "Continue in your own conversation…");
    const original = structuredClone(
      state.conversations.find((c) => c.id === "cv-giulia-callbacks")!,
    );
    await user.type(box, "Where do my projects stand?{Enter}");
    await waitFor(() => expect(path(router)).not.toBe("/claude/cv-giulia-callbacks"));
    const id = path(router).split("/")[2]!;
    const mine = state.conversations.find((c) => c.id === id)!;
    expect(mine).toMatchObject({
      ownerId: "p-sara",
      visibility: "private",
      continuesFromId: "cv-giulia-callbacks",
    });
    const from = await screen.findByText(/Continues from/);
    expect(from.closest("p")).toHaveTextContent(
      "Continues from “Why did a callback reminder arrive an hour late?” · Giulia Ferri",
    );
    expect(within(from.closest("p")!).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("/claude/cv-giulia-callbacks"),
    );
    await waitFor(() =>
      expect(
        (state.conversationEvents.get(id) ?? []).some(
          (e) => e.type === "user" && e.text === "Where do my projects stand?",
        ),
      ).toBe(true),
    );
    // L'originale non cambia, e Giulia non vede la continuazione.
    expect(state.conversations.find((c) => c.id === "cv-giulia-callbacks")).toEqual(original);
    expect(await as("p-giulia", () => api.getConversation(id))).toBeNull();
    const giuliaLists = await as("p-giulia", async () => [
      ...(await api.listConversations({ scope: "mine" })),
      ...(await api.listConversations({ scope: "public" })),
    ]);
    expect(giuliaLists.map((r) => r.id)).not.toContain(id);
  });

  it("nella pubblica di Giulia i codici di AUD, che Sara non vede, non si aprono", async () => {
    renderRoute("/claude/cv-giulia-callbacks", "p-sara");
    const used = await screen.findByText("Used:");
    const line = used.parentElement!;
    await waitFor(() => expect(line.querySelector('[data-citation="hidden"]')).not.toBeNull());
    expect(within(line).getByText("AUD-9").tagName).toBe("SPAN");
    expect(document.querySelector('a[href*="AUD-9"]')).toBeNull();
    // Il progetto che non vede non compare nemmeno nella testata.
    expect(screen.getByRole("heading", { level: 1 }).parentElement!.textContent).not.toMatch(
      /Project: AUD/,
    );
  });
});

describe("destinazione Claude: rinomina, archivia, elimina", () => {
  it("rinomina sul posto: Invio salva, Esc annulla", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-giulia-week", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(field);
    await user.type(field, "Week of the fair{Escape}");
    expect(screen.getByRole("heading", { level: 1, name: "Where do my projects stand this week?" }));
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const again = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(again);
    await user.type(again, "Week of the fair{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Week of the fair" })).toBeTruthy();
    expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.title).toBe(
      "Week of the fair",
    );
  });

  it("archivia: esce da Mine e da Recent, «Archived · Undo» la riporta", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-giulia-week", "p-giulia");
    await screen.findByRole("navigation", { name: "Claude views" });
    const recent = await within(column()).findByRole("list", { name: "Recent" });
    await waitFor(() => within(recent).getByRole("link", { name: /Where do my projects stand/ }));
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(within(recent).queryByRole("link", { name: /Where do my projects stand/ })).toBeNull(),
    );
    expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.archived).toBe(true);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.archived).toBe(false),
    );
  });

  it("elimina con conferma, e si torna alle mie conversazioni", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/claude/cv-giulia-week", "p-giulia");
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete “Where do my projects stand this week?”?",
    });
    expect(dialog).toHaveTextContent("Public copies others continued stay theirs.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(state.conversations.some((c) => c.id === "cv-giulia-week")).toBe(false),
    );
    await waitFor(() => expect(path(router)).toBe("/claude"));
    expect(router.state.location.search).toMatchObject({ scope: "mine" });
  });

  it("una sessione di lavoro non ha «Make public» né elimina; a lato la task con «Open task»", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    renderRoute("/claude/cv-run-aud-3", "p-marco");
    expect(await screen.findByText(/Task run/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    const side = await screen.findByRole("complementary", { name: "The object of this session" });
    expect(within(side).getByText("AUD-3")).toBeInTheDocument();
    expect(within(side).getByRole("link", { name: "Open task" })).toBeInTheDocument();
  });

  it("sotto 1200 px il lato diventa un bottone in testata che apre il pannello", async () => {
    const user = userEvent.setup();
    renderRoute("/claude/cv-run-aud-3", "p-marco");
    const toggle = await screen.findByRole("button", { name: "Task AUD-3" });
    expect(screen.queryByRole("complementary", { name: "The object of this session" })).toBeNull();
    await user.click(toggle);
    const side = await screen.findByRole("complementary", { name: "The object of this session" });
    expect(within(side).getByRole("link", { name: "Open task" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "The object of this session" }),
      ).toBeNull(),
    );
  });
});
