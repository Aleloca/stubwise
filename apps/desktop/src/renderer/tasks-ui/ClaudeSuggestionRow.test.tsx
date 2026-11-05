import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../data/api";
import { daysFromToday } from "../data/dates";
import { useAskDecision, useClaudeSuggestion, useUpdateTask } from "../data/queries";
import { getSessionPersonId, setSessionPersonId } from "../data/session";
import { useViewer, ViewerProvider } from "../data/viewer";
import {
  familyOf,
  notifyInstanceChange,
  setStreamLatency,
  state,
  visibleProjectIds,
} from "../data/store";
import { runScript } from "../data/stream";
import { draftText } from "../data/support/visibility";
import { setLanguage } from "../i18n";
import { resetPanelToggle } from "../layout/claudePanel/panelEvents";
import { PREVIEW_DOCKED_QUERY, SUPPORT_TWO_UP_QUERY } from "../pages/support/format";
import { clearReplyStore } from "../pages/support/replyStore";
import { renderRoute } from "../test/renderRoute";
import { setMatchMedia } from "../test/setup";
import { clearToasts } from "./Toast";

// La riga «Claude can help you…» nelle cinque pagine di partenza (area 10b,
// Task 12; shape `claude-suggestions.md`): c'è per chi può fare ciò che
// propone, senza «Who?»; il clic apre il riquadro con una conversazione
// NUOVA e la richiesta nella casella, non inviata (Invio la manda, S6 dalla
// riga); «Not now» la nasconde per quell'oggetto, anche dopo un
// ricaricamento, e senza archivio fino al cambio di pagina.

const DAVIDE = "p-davide";
const SARA = "p-sara";
const LAURA = "p-laura";
const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const KEY = "stubwise.claudeSuggestion.p-davide.support:sup-acq-2";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  // La bozza di Claude del seme su ACQ-S2 toglie la riga (maintainer, 5 nov
  // 2026): i casi della riga partono senza; quello con la bozza la rimette.
  state.supportConversations.find((c) => c.id === "sup-acq-2")!.claudeDraft = null;
  resetPanelToggle();
  clearReplyStore();
  window.localStorage.clear();
  setMatchMedia(SUPPORT_TWO_UP_QUERY, true);
  setMatchMedia(PREVIEW_DOCKED_QUERY, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setStreamLatency(null);
  clearToasts();
  clearReplyStore();
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

const panel = () => document.getElementById("claude-panel")!;
const panelOpen = () => !panel().hidden;
const panelBox = () => within(panel()).getByRole("textbox", { name: "Message to Claude" });
const row = () => document.querySelector<HTMLElement>("[data-claude-suggestion]");
const suggestionButton = (name: string | RegExp) => screen.findByRole("button", { name });
const conv = (code: string) => state.supportConversations.find((c) => c.code === code)!;

/** Rende ferma a mano una task aperta del progetto. */
function stallOne(code: string) {
  const projectId = state.projects.find((p) => p.code === code)!.id;
  const task = state.tasks.find((t) => t.projectId === projectId && familyOf(t) !== "closed")!;
  task.manualStall = {
    reason: "waiting for the supplier",
    note: "",
    since: daysFromToday(-9),
    byId: ROBERTA,
  };
}

/** Le cinque pagine con chi può fare ciò che la riga propone. */
const PLACES = [
  {
    name: "support",
    path: "/p/ACQ/support/ACQ-S2",
    who: DAVIDE,
    ready: () => screen.findByRole("form", { name: /^Reply to / }),
    line: "Claude can help you write the reply",
  },
  {
    name: "pr",
    path: "/p/ACQ/releases?pr=opr-acq-77",
    who: LAURA,
    ready: () => screen.findByRole("heading", { level: 3, name: "Claude's analysis" }),
    line: "Claude can help you write the release notes",
  },
  {
    name: "automations",
    path: "/p/ACQ/automations",
    who: LAURA,
    ready: () => screen.findByRole("heading", { level: 1, name: "Automations" }),
    line: "Claude can help you build an automation for ACQ",
  },
  {
    name: "overview",
    path: "/p/MKX/overview",
    who: GIULIA,
    ready: () => screen.findByRole("list", { name: "Stalled" }),
    line: "Claude can help you understand why MKX is stalled",
  },
  {
    name: "usage",
    path: "/admin/ai?tab=usage",
    who: ROBERTA,
    ready: () => screen.findByTestId("usage-panel"),
    line: "Claude can help you summarize this month's spend",
  },
] as const;

describe("Supporto con la bozza di Claude già pronta (maintainer, 5 nov 2026)", () => {
  it("ACQ-S2 col seme: «Claude prepared a draft · Use draft» e nessuna riga accanto", async () => {
    const c = state.supportConversations.find((x) => x.id === "sup-acq-2")!;
    c.claudeDraft = "Hi, thanks for writing…";
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("button", { name: "Use draft" });
    // Lasciato il tempo alla riga di arrivare: non arriva.
    await new Promise((r) => setTimeout(r, 50));
    expect(row()).toBeNull();
  });
});

describe("le cinque pagine: c'è col permesso, mai un «Who?»", () => {
  for (const p of PLACES) {
    it(`${p.name}: la riga sotto la testata, con la frase e la descrizione`, async () => {
      renderRoute(p.path, p.who);
      await p.ready();
      const button = await suggestionButton(p.line);
      expect(button).toHaveAccessibleDescription(
        "Opens Claude with the request written, not sent.",
      );
      expect(within(row()!).getByRole("button", { name: "Not now" })).toBeInTheDocument();
      // Mai un «Who?» nella riga.
      expect(row()!.textContent!.toLowerCase()).not.toMatch(/who\?/);
      expect(within(row()!).queryByRole("link")).toBeNull();
      // R-G5: nessun codice di un progetto che chi guarda non vede (in minuscolo).
      const text = row()!.textContent!.toLowerCase();
      const visible = visibleProjectIds(p.who);
      for (const project of state.projects.filter((x) => !visible.has(x.id))) {
        expect(text).not.toMatch(
          new RegExp(`(^|[^a-z0-9])${project.code.toLowerCase()}([^a-z0-9]|$)`),
        );
      }
      // Una sola riga per pagina.
      expect(document.querySelectorAll("[data-claude-suggestion]")).toHaveLength(1);
    });
  }

  it("senza il permesso non c'è: Sara su ACQ-S2, Sara sulla PR e sulle automazioni di ACQ, Laura su Consumi", async () => {
    renderRoute("/p/ACQ/support/ACQ-S2", SARA);
    await screen.findByText("Customer preview");
    await screen.findByText("Only people who can reply to customers write here.");
    expect(row()).toBeNull();
    cleanup();
    renderRoute("/p/ACQ/releases?pr=opr-acq-77", SARA);
    await screen.findByRole("heading", { level: 3, name: "Claude's analysis" });
    expect(row()).toBeNull();
    cleanup();
    renderRoute("/p/ACQ/automations", SARA);
    await screen.findByRole("heading", { level: 1, name: "Automations" });
    expect(row()).toBeNull();
    cleanup();
    renderRoute("/admin/ai?tab=usage", LAURA);
    await screen.findByRole("heading", { level: 1 });
    expect(row()).toBeNull();
  });

  it("in italiano: «Claude può aiutarti a …» e «Non ora»", async () => {
    act(() => setLanguage("it"));
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const button = await suggestionButton("Claude può aiutarti a scrivere la risposta");
    expect(button).toHaveAccessibleDescription(
      "Apre Claude con la richiesta scritta, non inviata.",
    );
    expect(within(row()!).getByRole("button", { name: "Non ora" })).toBeInTheDocument();
  });
});

describe("il «mai se» e il budget", () => {
  it("la PR con un piano in attesa sulla task non ha la riga", async () => {
    state.openPrs.find((p) => p.id === "opr-acq-77")!.taskId = state.tasks.find(
      (t) => t.code === "STW-13",
    )!.id;
    renderRoute("/p/ACQ/releases?pr=opr-acq-77", LAURA);
    await screen.findByRole("heading", { level: 3, name: "Claude's analysis" });
    await screen.findByRole("heading", { level: 3, name: /Release notes/i });
    expect(row()).toBeNull();
  });

  it("la PR riceve le note: la riga sparisce al prossimo aggiornamento, senza ricaricare", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/releases?pr=opr-acq-77", LAURA);
    await suggestionButton("Claude can help you write the release notes");
    const notes = await screen.findByRole("textbox", { name: "Release notes" });
    await user.type(notes, "- ACQ-7: Reminder");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(row()).toBeNull());
  });

  it("budget mensile esaurito: in ognuno dei cinque luoghi la riga che c'era se ne va, senza ricaricare (M3)", async () => {
    for (const p of PLACES) {
      state.instance.simulate.budgetReached = false;
      renderRoute(p.path, p.who);
      await p.ready();
      // La riga c'è: la lettura è viva su questa pagina.
      await suggestionButton(p.line);
      act(() => {
        state.instance.simulate.budgetReached = true;
        notifyInstanceChange();
      });
      // Con il budget esaurito la riga non c'è più: se la regola la lasciasse, questo fallisce.
      await waitFor(() => expect(row()).toBeNull());
      expect(screen.queryByRole("button", { name: p.line })).toBeNull();
      cleanup();
    }
  });

  it("il budget torna: la riga compare senza ricaricare", async () => {
    state.instance.simulate.budgetReached = true;
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("form", { name: /^Reply to / });
    expect(row()).toBeNull();
    act(() => {
      state.instance.simulate.budgetReached = false;
      notifyInstanceChange();
    });
    await suggestionButton("Claude can help you write the reply");
  });
});

describe("il clic: una conversazione nuova, la richiesta nella casella, non inviata", () => {
  it("ACQ-S2: riquadro aperto, «Write the reply to ACQ-S2» col cursore in fondo; Invio → la bozza nel campo", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    const form = await screen.findByRole("form", { name: /^Reply to / });
    const before = state.conversations.length;
    await user.click(await suggestionButton("Claude can help you write the reply"));
    expect(panelOpen()).toBe(true);
    await waitFor(() => expect(panelBox()).toHaveValue("Write the reply to ACQ-S2"));
    await waitFor(() => expect(panelBox()).toHaveFocus());
    const box = panelBox() as HTMLTextAreaElement;
    expect(box.selectionStart).toBe(box.value.length);
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "New conversation",
    );
    // Il chip dice la pagina.
    await waitFor(() =>
      expect(panel().querySelector("[data-context-chip]")).toHaveTextContent(
        "ACQ-S2·support conversation",
      ),
    );
    // Non inviata: nessuna conversazione nuova, nessun messaggio.
    expect(state.conversations).toHaveLength(before);
    // La riga resta (non è un «Not now»).
    expect(row()).not.toBeNull();

    await user.keyboard("{Enter}");
    const body = within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toBe(draftText(conv("ACQ-S2"))));
    expect(form.querySelector("[data-claude-draft-mark]")).toHaveTextContent("Claude's draft");
    expect(state.conversations).toHaveLength(before + 1);
  });

  it("il chip della pagina c'è anche se era stato tolto: la richiesta parla della PR", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/releases?pr=opr-acq-77", LAURA);
    await suggestionButton("Claude can help you write the release notes");
    await user.keyboard("{Control>}j{/Control}");
    await user.click(await within(panel()).findByRole("button", { name: "Don't use this page" }));
    await within(panel()).findByText("Not using this page");
    await user.click(await suggestionButton("Claude can help you write the release notes"));
    await waitFor(() => expect(panelBox()).toHaveValue("Write the release notes"));
    expect(within(panel()).getByText("You're looking at:")).toBeInTheDocument();
    expect(panel().querySelector("[data-context-chip]")).not.toBeNull();
  });

  it("un doppio clic non fa due conversazioni, né due richieste nella casella", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/automations", LAURA);
    const before = state.conversations.length;
    await user.dblClick(await suggestionButton("Claude can help you build an automation for ACQ"));
    await waitFor(() => expect(panelBox()).toHaveValue("Build an automation in ACQ: when "));
    expect(state.conversations).toHaveLength(before);
    // Il cursore dopo «when », dove la persona scrive l'evento ([SG 2]).
    const box = panelBox() as HTMLTextAreaElement;
    await waitFor(() => expect(box.selectionStart).toBe(box.value.length));
  });

  it("col riquadro aperto su un'altra conversazione: ne apre una nuova; il testo non inviato resta in quella di prima ([SG 6])", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("form", { name: /^Reply to / });
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelBox()).toHaveFocus());
    await user.type(panelBox(), "What should I do today?{Enter}");
    await within(panel()).findByText("What should I do today?");
    const first = state.conversations.at(-1)!.id;
    await user.type(await within(panel()).findByRole("combobox"), "not sent yet");

    await user.click(await suggestionButton("Claude can help you write the reply"));
    await waitFor(() => expect(panelBox()).toHaveValue("Write the reply to ACQ-S2"));
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "New conversation",
    );
    expect(within(panel()).queryByText("What should I do today?")).toBeNull();
    await waitFor(() => expect(panelBox()).toHaveFocus());

    // La conversazione di prima, aperta in Claude: il testo non inviato è lì.
    await act(() => router.navigate({ to: "/claude/$id", params: { id: first } }));
    const page = await screen.findByRole("main");
    await waitFor(() =>
      expect(
        within(page)
          .getAllByRole("combobox")
          .some((b) => (b as HTMLTextAreaElement).value === "not sent yet"),
      ).toBe(true),
    );
  });

  it("[SG 6] con una domanda aperta e «Other…» scritto: si tiene il testo della casella, non quello della risposta (I1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("form", { name: /^Reply to / });
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelBox()).toHaveFocus());
    await user.type(panelBox(), "What should I do today?{Enter}");
    await within(panel()).findByText("What should I do today?");
    const first = state.conversations.at(-1)!.id;
    // Una domanda aperta nel flusso, con «Other…»: la sua textarea sta PRIMA della casella.
    const seeded = [...state.conversationEvents.values()]
      .flat()
      .find((e) => e.type === "question" && e.answer === null)!;
    // Una domanda dell'agente (senza `resume`), come evento nuovo: id e ora li dà il flusso.
    const draft: Record<string, unknown> = { ...structuredClone(seeded), questionId: "q-test" };
    for (const k of ["id", "at", "resume"]) delete draft[k];
    await act(() => runScript(first, [{ step: "event", event: draft as never }]));
    await user.click(await within(panel()).findByRole("button", { name: "Other…" }));
    const other = panel().querySelectorAll("textarea")[0]!;
    await user.type(other, "my own answer");
    await user.type(await within(panel()).findByRole("combobox"), "not sent yet");

    await user.click(await suggestionButton("Claude can help you write the reply"));
    await waitFor(() => expect(panelBox()).toHaveValue("Write the reply to ACQ-S2"));

    await act(() => router.navigate({ to: "/claude/$id", params: { id: first } }));
    const page = await screen.findByRole("main");
    const boxes = () =>
      within(page)
        .getAllByRole("combobox")
        .map((b) => (b as HTMLTextAreaElement).value);
    await waitFor(() => expect(boxes()).toContain("not sent yet"));
    expect(boxes()).not.toContain("my own answer");
  });
});

describe("«Not now»", () => {
  it("su ACQ-S2: sparisce, il fuoco va avanti, lo annuncia; ricaricata resta nascosta; su un'altra conversazione che aspetta c'è", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await suggestionButton("Claude can help you write the reply");
    await user.click(within(row()!).getByRole("button", { name: "Not now" }));
    expect(
      screen.queryByRole("button", { name: "Claude can help you write the reply" }),
    ).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeNull();
    expect(screen.getByText("Suggestion hidden.")).toBeInTheDocument();
    await waitFor(() => expect(row()).toBeNull());
    // Richiusa la riga, il fuoco è ancora su un elemento della pagina, mai sul body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector("[data-support-detail]")!.contains(document.activeElement)).toBe(
      true,
    );
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    // Ricaricata la pagina: resta nascosta.
    cleanup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("form", { name: /^Reply to / });
    await new Promise((r) => setTimeout(r, 20));
    expect(row()).toBeNull();

    // Un'altra conversazione che aspetta il team: la riga c'è (la chiave è l'oggetto).
    cleanup();
    const c = conv("ACQ-S4");
    c.messages.push({
      ...c.messages.find((m) => m.from === "customer")!,
      id: "m-test",
      at: "2026-10-23T11:00:00Z",
    });
    renderRoute("/p/ACQ/support/ACQ-S4", DAVIDE);
    await suggestionButton("Claude can help you write the reply");
  });

  it("vale per la persona: Matteo su ACQ-S2 la vede ancora", async () => {
    window.localStorage.setItem(KEY, "1");
    renderRoute("/p/ACQ/support/ACQ-S2", "p-matteo");
    await suggestionButton("Claude can help you write the reply");
  });

  it("con localStorage che lancia: la pagina si disegna, la riga c'è e «Not now» la nasconde", async () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support/ACQ-S2", DAVIDE);
    await screen.findByRole("form", { name: /^Reply to / });
    await suggestionButton("Claude can help you write the reply");
    await user.click(within(row()!).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(row()).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("l'Overview di un progetto: nascosta su MKX, c'è su un altro progetto fermo", async () => {
    const user = userEvent.setup();
    renderRoute("/p/MKX/overview", GIULIA);
    await suggestionButton("Claude can help you understand why MKX is stalled");
    await user.click(within(row()!).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(row()).toBeNull());
    expect(
      window.localStorage.getItem("stubwise.claudeSuggestion.p-giulia.overview:prj-mkx"),
    ).not.toBeNull();
    cleanup();
    stallOne("OLV");
    renderRoute("/p/OLV/overview", GIULIA);
    await suggestionButton("Claude can help you understand why OLV is stalled");
  });
});

describe("le scritture che cambiano la riga la rileggono, senza ricaricare", () => {
  function hooks<T>(personId: string, use: () => T) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ViewerProvider initialPersonId={personId}>{children}</ViewerProvider>
      </QueryClientProvider>
    );
    return renderHook(use, { wrapper }).result;
  }

  it("«vedi come» sulla stessa pagina, da Matteo a Sara: la riga di Matteo non arriva mai a Sara, nemmeno mentre rilegge", async () => {
    // Ogni render: chi guarda e la riga che il hook gli dà.
    const seen: { me: string; id: string | null | undefined }[] = [];
    const result = hooks("p-matteo", () => {
      const viewer = useViewer();
      const row = useClaudeSuggestion({ kind: "support", conversationId: "sup-acq-2" });
      seen.push({ me: getSessionPersonId(), id: row.data?.id });
      return { viewer, row };
    });
    await waitFor(() => expect(result.current.row.data?.id).toBe("supportReply"));
    // Una lettura lenta: la finestra in cui la riga di prima potrebbe restare.
    api.setLatency(150);
    act(() => result.current.viewer.setPersona(SARA));
    await waitFor(() => expect(result.current.row.isFetching).toBe(false));
    expect(result.current.row.data).toBeNull();
    expect(seen.filter((s) => s.me === SARA && s.id)).toEqual([]);
  });

  it("una richiesta di decisione sulla task della PR toglie la riga della PR (area releases)", async () => {
    const result = hooks(LAURA, () => ({
      row: useClaudeSuggestion({ kind: "pr", prId: "opr-acq-77" }),
      ask: useAskDecision(),
    }));
    await waitFor(() => expect(result.current.row.data?.id).toBe("releaseNotes"));
    const task = state.tasks.find((t) => t.code === "ACQ-7")!;
    const askedOfId = state.projectsById.get("prj-acq")!.memberIds.find((id) => id !== LAURA)!;
    await act(() =>
      result.current.ask.mutateAsync({
        taskId: task.id,
        askedOfId,
        question: "Which channel first?",
        options: ["SMS", "Email"],
      }),
    );
    await waitFor(() => expect(result.current.row.data).toBeNull());
  });

  it("una task che diventa ferma, e poi non più, aggiorna la riga dell'Overview (area pulse)", async () => {
    const result = hooks(LAURA, () => ({
      row: useClaudeSuggestion({ kind: "overview", projectId: "prj-acq" }),
      update: useUpdateTask(),
    }));
    await waitFor(() => expect(result.current.row.isSuccess).toBe(true));
    expect(result.current.row.data).toBeNull();
    const task = state.tasks.find((t) => t.projectId === "prj-acq" && familyOf(t) !== "closed")!;
    await act(() =>
      result.current.update.mutateAsync({
        id: task.id,
        patch: {
          manualStall: {
            reason: "waiting for the supplier",
            note: "",
            since: daysFromToday(-9),
            byId: LAURA,
          },
        },
      }),
    );
    await waitFor(() => expect(result.current.row.data?.id).toBe("whyStalled"));
    await act(() =>
      result.current.update.mutateAsync({ id: task.id, patch: { manualStall: null } }),
    );
    await waitFor(() => expect(result.current.row.data).toBeNull());
  });
});
