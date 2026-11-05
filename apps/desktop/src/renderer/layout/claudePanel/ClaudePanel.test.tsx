import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { getSessionPersonId, setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { runScript } from "../../data/stream";
import i18n from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { resetPanelToggle } from "./panelEvents";

// Il riquadro di Claude (area 10a, Task 8, shape claude-panel.md): si apre
// da ogni pagina (⌘J, il binario, ⌘K), sa cosa si sta guardando, e chiuso
// resta montato — conversazione e testo non inviato non si perdono.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
});
afterEach(async () => {
  if (i18n.language !== "en") await i18n.changeLanguage("en");
});

const panel = () => document.getElementById("claude-panel")!;
const isOpen = () => !panel().hidden;
const box = () => within(panel()).getByRole("textbox", { name: "Message to Claude" });
const ctrlJ = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Control>}j{/Control}");
const chip = () => panel().querySelector("[data-context-chip]");

/** Una scrittura come un'altra persona, senza cambiare chi guarda nel test. */
async function as<R>(personId: string, call: () => Promise<R>): Promise<R> {
  const before = getSessionPersonId();
  setSessionPersonId(personId);
  try {
    return await call();
  } finally {
    setSessionPersonId(before);
  }
}

/** Laura sulle task di ACQ, con ACQ-3 aperta nel pannello. */
async function lauraOnAcq3(user: ReturnType<typeof userEvent.setup>) {
  const router = renderRoute("/p/ACQ/tasks?task=ACQ-3", "p-laura");
  const filter = await screen.findByRole("searchbox", { name: "Search tasks" });
  await user.click(filter);
  return { router, filter };
}

describe("aprire e chiudere", () => {
  it("⌘J da Tasks di ACQ col pannello della task: chip «ACQ-3 · task», fuoco nella casella; Esc chiude e il fuoco torna; riaperto, testo e conversazione sono lì", async () => {
    const user = userEvent.setup();
    const { router, filter } = await lauraOnAcq3(user);
    expect(isOpen()).toBe(false);
    expect(panel()).toHaveAttribute("inert");

    await ctrlJ(user);
    expect(isOpen()).toBe(true);
    expect(panel()).not.toHaveAttribute("inert");
    await waitFor(() => expect(chip()).toHaveTextContent("ACQ-3·task"));
    expect(within(panel()).getByText("You're looking at:")).toBeInTheDocument();
    await waitFor(() => expect(box()).toHaveFocus());

    // Un messaggio: la conversazione nasce dal riquadro.
    await user.type(box(), "What should I do today?{Enter}");
    // Sotto il messaggio, il contesto con cui è partito [CP 4].
    await waitFor(() =>
      expect(panel().querySelector("[data-message-context]")).toHaveTextContent("on ACQ-3"),
    );
    expect(within(panel()).getByText("What should I do today?")).toBeInTheDocument();
    // E un testo non inviato.
    await user.type(await within(panel()).findByRole("combobox"), "not sent yet");

    await user.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(panel()).toHaveAttribute("inert");
    // Il riquadro ha preso Esc: il pannello della task resta aperto.
    expect(router.state.location.search).toMatchObject({ task: "ACQ-3" });
    await waitFor(() => expect(filter).toHaveFocus());

    await ctrlJ(user);
    expect(isOpen()).toBe(true);
    expect(within(panel()).getByText("What should I do today?")).toBeInTheDocument();
    expect(within(panel()).getByRole("combobox")).toHaveValue("not sent yet");
  });

  it("il bottone del binario: aria-expanded, aria-controls, e alterna", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    const button = await screen.findByRole("button", { name: "Ask Claude" });
    expect(button).toHaveAttribute("aria-controls", "claude-panel");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(isOpen()).toBe(true);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.click(button);
    expect(isOpen()).toBe(false);
    // Chiuso dal bottone, il fuoco resta lì (mai sul body).
    expect(document.activeElement).not.toBe(document.body);
  });

  it("⌘K «Ask Claude: “riassumi ACQ”»: il testo nella casella, nessun messaggio inviato", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/tasks", "p-laura");
    await screen.findByRole("searchbox", { name: "Search tasks" });
    const before = state.conversations.length;
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "riassumi ACQ");
    await user.click(await screen.findByRole("option", { name: /Ask Claude: “riassumi ACQ”/ }));
    await waitFor(() => expect(isOpen()).toBe(true));
    await waitFor(() => expect(box()).toHaveValue("riassumi ACQ"));
    await waitFor(() => expect(box()).toHaveFocus());
    expect(state.conversations).toHaveLength(before);
    // Non naviga: la pagina resta quella di prima.
    expect(router.state.location.pathname).toBe("/p/ACQ/tasks");
  });

  it("la pagina sotto resta viva: col riquadro aperto si scrive nel filtro di Tasks", async () => {
    const user = userEvent.setup();
    const { filter } = await lauraOnAcq3(user);
    await ctrlJ(user);
    expect(isOpen()).toBe(true);
    await user.click(filter);
    await user.type(filter, "export");
    expect(filter).toHaveValue("export");
    expect(isOpen()).toBe(true);
  });
});

describe("la conversazione del riquadro", () => {
  it("nasce privata, fra le mie della destinazione; «Open in Claude» la apre a pagina intera e chiude il riquadro", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    // Prima del primo messaggio «Open in Claude» è spento, con la sua frase.
    const openIn = within(panel()).getByRole("button", { name: "Open in Claude" });
    expect(openIn).toHaveAttribute("aria-disabled", "true");
    expect(openIn).toHaveAccessibleDescription("Start the conversation first");
    await user.type(box(), "Where do my projects stand?{Enter}");
    await within(panel()).findByText("Where do my projects stand?");
    const mine = await as("p-laura", () => api.listConversations({ scope: "mine" }));
    const created = mine.find((c) => c.title.startsWith("Where do my projects"));
    expect(created).toBeDefined();
    expect(created!.visibility).toBe("private");
    await waitFor(() => expect(openIn).not.toHaveAttribute("aria-disabled"));
    await user.click(openIn);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/claude/${created!.id}`));
    expect(isOpen()).toBe(false);
  });

  it("l'ultima conversazione archiviata dalla destinazione: compositore vuoto, con la riga che lo dice", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await user.type(box(), "What should I do today?{Enter}");
    await waitFor(() => expect(panel().querySelector("[data-user-message]")).not.toBeNull());
    // Nata la conversazione, il fuoco è nella sua casella (mai sul body): Esc chiude.
    await waitFor(() => expect(within(panel()).getByRole("combobox")).toHaveFocus());
    const id = state.conversations.at(-1)!.id;
    await user.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    await as("p-laura", () => api.archiveConversation(id));
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(isOpen()).toBe(true);
    expect(
      await within(panel()).findByText("Your last conversation was archived."),
    ).toBeInTheDocument();
    expect(panel().querySelector("[data-user-message]")).toBeNull();
    expect(within(panel()).getByRole("heading", { name: "Ask Claude" })).toBeInTheDocument();
  });

  it("«New» apre il compositore vuoto; la conversazione di prima resta fra le mie", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await user.type(box(), "What should I do today?{Enter}");
    await waitFor(() => expect(panel().querySelector("[data-user-message]")).not.toBeNull());
    await user.click(within(panel()).getByRole("button", { name: "New" }));
    expect(panel().querySelector("[data-user-message]")).toBeNull();
    expect(within(panel()).getByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: "Ask Claude" })).toBeInTheDocument();
    const mine = await as("p-laura", () => api.listConversations({ scope: "mine" }));
    expect(mine.some((c) => c.title.startsWith("What should I do today"))).toBe(true);
  });

  it("le righe PROVA scrivono nella casella senza inviare, scelte dal contesto", async () => {
    const user = userEvent.setup();
    await lauraOnAcq3(user);
    await ctrlJ(user);
    const before = state.conversations.length;
    await user.click(await within(panel()).findByRole("button", { name: "Summarize ACQ-3" }));
    await waitFor(() => expect(box()).toHaveValue("Summarize ACQ-3"));
    expect(state.conversations).toHaveLength(before);
  });

  it("«vedi come» da Laura a Sara col riquadro aperto: niente di Laura nel DOM, e la riga che lo dice", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await user.type(box(), "Laura's private question{Enter}");
    await within(panel()).findByText("Laura's private question");
    await user.type(await within(panel()).findByRole("combobox"), "Laura's unsent draft");
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Sara Montanari/ }));
    await waitFor(() =>
      expect(
        within(panel()).getByText("Now showing Sara Montanari's conversations."),
      ).toBeInTheDocument(),
    );
    expect(isOpen()).toBe(true);
    const text = document.body.textContent!.toLowerCase();
    expect(text).not.toContain("laura's private question");
    expect(document.body.innerHTML.toLowerCase()).not.toContain("laura's unsent draft");
    expect(box()).toHaveValue("");
  });
});

describe("il contesto", () => {
  it("una task diventata invisibile perde il chip, e Claude risponde «Can't find» come per un codice inesistente", async () => {
    const user = userEvent.setup();
    renderRoute("/home?task=ACQ-3", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await waitFor(() => expect(chip()).toHaveTextContent("ACQ-3"));
    await user.keyboard("{Escape}");
    // Laura esce da ACQ.
    const acq = state.projectsById.get("prj-acq")!;
    acq.memberIds = acq.memberIds.filter((id) => id !== "p-laura");
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    await waitFor(() => expect(chip()).toBeNull());
    expect(within(panel()).queryByText("You're looking at:")).toBeNull();
    await user.type(box(), "Summarize ACQ-3{Enter}");
    expect(await within(panel()).findByText(/can't find ACQ-3/i)).toBeInTheDocument();
    expect(panel().querySelector("[data-message-context]")).toBeNull();
  });

  it("la × toglie il contesto per i messaggi successivi; «Use it» lo rimette", async () => {
    const user = userEvent.setup();
    await lauraOnAcq3(user);
    await ctrlJ(user);
    await waitFor(() => expect(chip()).not.toBeNull());
    await user.click(within(panel()).getByRole("button", { name: "Don't use this page" }));
    expect(chip()).toBeNull();
    expect(within(panel()).getByText("Not using this page")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Use it" }));
    expect(chip()).not.toBeNull();
  });

  it("un turno col chip su ACQ conta un consumo `chat` su ACQ; senza contesto, senza progetto", async () => {
    const user = userEvent.setup();
    await lauraOnAcq3(user);
    await ctrlJ(user);
    await waitFor(() => expect(chip()).not.toBeNull());
    const before = state.instance.usage.length;
    await user.type(box(), "Where does ACQ stand?{Enter}");
    await waitFor(() => expect(state.instance.usage.length).toBe(before + 1));
    expect(state.instance.usage.at(-1)).toMatchObject({ operation: "chat", projectId: "prj-acq" });

    await user.click(within(panel()).getByRole("button", { name: "Don't use this page" }));
    await user.click(within(panel()).getByRole("button", { name: "New" }));
    await user.type(box(), "What should I do today?{Enter}");
    await waitFor(() => expect(state.instance.usage.length).toBe(before + 2));
    expect(state.instance.usage.at(-1)).toMatchObject({ operation: "chat", projectId: null });
  });
});

describe("stati", () => {
  const BUDGET_EN =
    "The monthly AI budget is used up: Claude can't answer until it's raised or the month ends.";
  const band = () => panel().querySelector<HTMLElement>("[data-budget-band]");
  const budget = (on: boolean) =>
    act(() => as("p-roberta", () => api.instance.simulateBudgetReached(on)));

  it("budget esaurito, conversazione vuota: la fascia al posto della casella, con «Who?»; il testo scritto resta in sola lettura e torna col budget", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await user.type(box(), "Hello Claude");
    const before = state.conversations.length;
    await budget(true);
    await waitFor(() => expect(band()).not.toBeNull());
    expect(band()).toHaveTextContent(BUDGET_EN);
    expect(band()!.querySelector("[data-who-can]")).toHaveTextContent("Who?");
    // Nessuna casella né Send: niente invita a scrivere ciò che non partirebbe.
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Send" })).toBeNull();
    expect(band()).toHaveTextContent("Hello Claude");
    expect(state.conversations).toHaveLength(before);
    await budget(false);
    await waitFor(() => expect(box()).toHaveValue("Hello Claude"));
    expect(band()).toBeNull();
  });

  it("budget esaurito in una conversazione del riquadro: la stessa fascia, in italiano", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Ask Claude" }));
    await user.type(box(), "What should I do today?{Enter}");
    await waitFor(() => expect(panel().querySelector("[data-user-message]")).not.toBeNull());
    await user.type(within(panel()).getByRole("combobox"), "a draft");
    await act(() => i18n.changeLanguage("it"));
    await budget(true);
    await waitFor(() => expect(band()).not.toBeNull());
    expect(band()).toHaveTextContent(
      "Il budget mensile per l'AI è esaurito: Claude non può rispondere finché non viene alzato o non finisce il mese.",
    );
    expect(band()).toHaveTextContent("a draft");
    expect(within(panel()).queryByRole("combobox")).toBeNull();
    await budget(false);
    await waitFor(() => expect(within(panel()).getByRole("combobox")).toHaveValue("a draft"));
  });

  it("[CP 9] l'atterraggio e la conversazione vuota non promettono più «nothing without your confirmation», in nessuna lingua", async () => {
    const user = userEvent.setup();
    renderRoute("/claude", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "New conversation" });
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    const sentence =
      "Ask about what you're looking at, or ask Claude to do it for you. What only touches you happens right away and can be undone; anything that touches others asks you first.";
    expect(screen.getAllByText(sentence)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/changes nothing without your confirmation/i);
    await i18n.changeLanguage("it");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Ciò che tocca solo te parte subito e si annulla",
      ),
    );
    expect(document.body.textContent).not.toMatch(/non cambia nulla senza la tua conferma/i);
  });
});

describe("a 1024 col pannello della task sovrapposto", () => {
  it("il riquadro sta a sinistra del pannello, non sopra", async () => {
    setMatchMedia("(min-width: 1200px)", false);
    const user = userEvent.setup();
    await lauraOnAcq3(user);
    await ctrlJ(user);
    expect(isOpen()).toBe(true);
    // 360 sotto i 1440 px; il bordo destro segue la larghezza del pannello (qui 0 in happy-dom).
    expect(panel().style.width).toBe("360px");
    expect(panel().style.right).toMatch(/px$/);
  });
});

describe("il fuoco va nella CASELLA, non nella prima textarea (review finale, 2)", () => {
  it("con una domanda aperta e «Other…» nel flusso: riaperto il riquadro, il fuoco è nella casella", async () => {
    const user = userEvent.setup();
    await lauraOnAcq3(user);
    await ctrlJ(user);
    await waitFor(() => expect(box()).toHaveFocus());
    await user.type(box(), "What should I do today?{Enter}");
    await within(panel()).findByText("What should I do today?");
    const id = state.conversations.at(-1)!.id;
    // Una domanda aperta nel flusso, con «Other…»: la sua textarea sta PRIMA della casella.
    const seeded = [...state.conversationEvents.values()]
      .flat()
      .find((e) => e.type === "question" && e.answer === null)!;
    const draft: Record<string, unknown> = { ...structuredClone(seeded), questionId: "q-focus" };
    for (const k of ["id", "at", "resume"]) delete draft[k];
    await act(() => runScript(id, [{ step: "event", event: draft as never }]));
    await user.click(await within(panel()).findByRole("button", { name: "Other…" }));
    expect(panel().querySelectorAll("textarea")[0]).not.toHaveAttribute("data-claude-box");

    await user.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    await ctrlJ(user);
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-claude-box"));
  });
});
