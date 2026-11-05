import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { useConversation } from "../../data/queries";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { ViewerProvider } from "../../data/viewer";
import i18n, { setLanguage } from "../../i18n";
import { ExecutedRow } from "../../pages/claude/conversation/ExecutedRow";
import type { UndoView } from "../../data/types";
import { renderRoute } from "../../test/renderRoute";
import { renderWithData } from "../../test/renderWithData";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { THEME_STORAGE_KEY } from "../../theme/theme";
import { __forgetPageEventsForTest, undoPageEvent, usePageEventRunner } from "./pageActions";
import { resetPanelToggle } from "./panelEvents";

// Le azioni della pagina dal riquadro di Claude (area 10b, Task 9; shape
// `claude-scenarios.md` §3.10): il motore emette un `pageAction` `pending`,
// il riquadro di chi chiede lo esegue UNA volta (lingua, tema, il filtro
// della pagina sotto) e lo chiude `done`. «Undo» rimette il valore di prima
// solo se c'è ancora quello di Claude; il valore di prima sta solo in
// memoria. Nessun toast (decisione del maintainer).

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // storage assente: il tema resta `system`
  }
});
afterEach(async () => {
  if (i18n.language !== "en") await act(() => setLanguage("en"));
  vi.restoreAllMocks();
});

const panel = () => document.getElementById("claude-panel")!;
const box = () => within(panel()).getByRole("textbox", { name: "Message to Claude" });
const composer = () => within(panel()).getByRole("combobox");
const ctrlJ = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Control>}j{/Control}");
type PageEvent = Extract<ConversationEvent, { type: "pageAction" }>;
const pageEvents = (): PageEvent[] =>
  [...state.conversationEvents.values()]
    .flat()
    .filter((e): e is PageEvent => e.type === "pageAction");
const row = () => panel().querySelector<HTMLElement>("[data-page-action]");

async function ask(path: string, personId: string, text: string) {
  const user = userEvent.setup();
  const router = renderRoute(path, personId);
  await screen.findAllByRole("heading");
  await ctrlJ(user);
  await waitFor(() => expect(box()).toHaveFocus());
  await user.type(box(), `${text}{Enter}`);
  await waitFor(() => expect(pageEvents().at(-1)?.status).toBe("done"));
  await waitFor(() => expect(row()).not.toBeNull());
  return { user, router };
}

describe("la lingua", () => {
  it("un `language` `pending` cambia lingua una volta, anche dopo altri render, e chiude l'evento `done`", async () => {
    const change = vi.spyOn(i18n, "changeLanguage");
    const { user } = await ask("/p/ACQ/overview", "p-laura", "switch to Italian");
    expect(i18n.language).toBe("it");
    // La riga si scrive nella lingua nuova.
    await waitFor(() => expect(row()).toHaveTextContent("Interfaccia passata all'italiano"));
    // Altri render (si scrive nella casella): la lingua non si cambia di nuovo.
    await user.type(composer(), "ciao");
    await user.clear(composer());
    expect(change.mock.calls.filter(([lng]) => lng === "it")).toHaveLength(1);
    expect(pageEvents()).toHaveLength(1);
    // Nessun toast per un'azione A della pagina.
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  it("«Annulla l'azione» rimette la lingua; il fuoco resta sulla riga", async () => {
    const { user } = await ask("/p/ACQ/overview", "p-laura", "switch to Italian");
    await user.click(within(row()!).getByRole("button", { name: "Annulla l'azione" }));
    await waitFor(() => expect(i18n.language).toBe("en"));
    await waitFor(() => expect(row()).toHaveTextContent("Undone"));
    expect(pageEvents()[0]!.status).toBe("undone");
    expect(document.activeElement).not.toBe(document.body);
    expect(row()!.contains(document.activeElement)).toBe(true);
  });

  it("dopo un cambio a mano, «Undo» è `changed_after` e la lingua resta quella scelta", async () => {
    const { user } = await ask("/p/ACQ/overview", "p-laura", "switch to Italian");
    await act(() => setLanguage("en"));
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(row()).toHaveTextContent("You changed it afterwards · can't undo from here"),
    );
    expect(i18n.language).toBe("en");
    expect(pageEvents()[0]!.status).toBe("changed_after");
  });

  it("un doppio clic su «Undo» fa una scrittura sola", async () => {
    const settle = vi.spyOn(api, "settlePageEvent");
    const { user } = await ask("/p/ACQ/overview", "p-laura", "switch to Italian");
    const undo = within(row()!).getByRole("button", { name: "Annulla l'azione" });
    await user.dblClick(undo);
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("undone"));
    // Un solo «Undo» scritto: il secondo clic non trova più niente da annullare.
    expect(settle.mock.calls.filter(([, , status]) => status !== "done")).toEqual([
      [expect.any(String), expect.any(String), "undone"],
    ]);
    // Anche chiamato di nuovo (un clic arrivato prima del render): niente da rifare.
    expect(undoPageEvent(pageEvents()[0]!.id)).toBe("not_undoable");
    expect(i18n.language).toBe("en");
  });

  it("senza più il valore di prima (un ricaricamento): «Can't be undone anymore», niente bottone", async () => {
    await ask("/p/ACQ/overview", "p-laura", "switch to Italian");
    await act(() => setLanguage("en"));
    act(() => __forgetPageEventsForTest());
    await waitFor(() => expect(row()).toHaveTextContent("Can't be undone anymore"));
    expect(within(row()!).queryByRole("button")).toBeNull();
  });
});

describe("il tema", () => {
  it("«dark theme» mette il tema scuro, senza toast; «Undo» rimette quello di prima", async () => {
    const { user } = await ask("/p/ACQ/overview", "p-laura", "dark theme");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(row()).toHaveTextContent("Switched to the dark theme");
    expect(document.querySelector("[data-toast]")).toBeNull();
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row()).toHaveTextContent("Undone"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });
});

describe("il filtro della pagina sotto", () => {
  it("la pagina passa a Tasks di ACQ coi criteri; «Undo» torna all'indirizzo di prima", async () => {
    const { user, router } = await ask(
      "/p/ACQ/overview",
      "p-roberta",
      "show ACQ tasks assigned to Marco",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/tasks"));
    expect(router.state.location.search).toMatchObject({
      filters: { assigneeIds: ["p-marco"], families: ["todo", "active"] },
    });
    expect(row()).toHaveTextContent("Filtered ACQ tasks: assigned to Marco Bellini · open");
    // Chi chiede è ancora sulla pagina filtrata: «Show» non serve.
    expect(within(row()!).queryByRole("link", { name: "Show" })).toBeNull();
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/overview"));
    expect(pageEvents()[0]!.status).toBe("undone");
  });

  it("lasciata la pagina: «Show» la riporta, e «Undo» è `changed_after` (l'indirizzo non è più quello di Claude)", async () => {
    const { user, router } = await ask(
      "/p/ACQ/overview",
      "p-roberta",
      "show ACQ tasks assigned to Marco",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/tasks"));
    await act(() =>
      router.navigate({
        to: "/p/$code/$section",
        params: { code: "ACQ", section: "overview" },
      } as never),
    );
    const show = await within(row()!).findByRole("link", { name: "Show" });
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(row()).toHaveTextContent("You changed it afterwards · can't undo from here"),
    );
    expect(router.state.location.pathname).toBe("/p/ACQ/overview");
    await user.click(show);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/tasks"));
  });

  it("aprire una task dalla pagina filtrata (`?task=`) non conta: «Undo» torna indietro (I1)", async () => {
    const { user, router } = await ask(
      "/p/ACQ/overview",
      "p-roberta",
      "show ACQ tasks assigned to Marco",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/tasks"));
    await act(() =>
      router.navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, task: "ACQ-1" }),
      } as never),
    );
    expect(router.state.location.search).toMatchObject({ task: "ACQ-1" });
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("undone"));
    expect(router.state.location.pathname).toBe("/p/ACQ/overview");
  });

  it("un criterio cambiato davvero sulla stessa pagina: «Undo» è `changed_after`", async () => {
    const { user, router } = await ask(
      "/p/ACQ/overview",
      "p-roberta",
      "show ACQ tasks assigned to Marco",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/tasks"));
    await act(() =>
      router.navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          filters: { families: ["todo", "active"] },
        }),
      } as never),
    );
    await user.click(within(row()!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("changed_after"));
    expect(router.state.location.pathname).toBe("/p/ACQ/tasks");
  });
});

describe("la pagina intera della conversazione (I2)", () => {
  it("da `/claude/$id` l'azione parte come dal riquadro, e la riga c'è", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    const user = userEvent.setup();
    renderRoute(`/claude/${cid}`, "p-laura");
    const main = await screen.findByRole("combobox");
    await user.type(main, "switch to Italian{Enter}");
    await waitFor(() => expect(pageEvents()[0]?.status).toBe("done"));
    expect(i18n.language).toBe("it");
    await waitFor(() =>
      expect(document.querySelector('[data-page-action="language"]')).toHaveTextContent(
        "Interfaccia passata all'italiano",
      ),
    );
  });

  it("un `pending` vecchio (seguito da un altro messaggio) non parte in ritardo: si chiude `failed`, con la sua riga", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    await api.runScript(cid, [
      {
        step: "event",
        event: { type: "pageAction", action: { kind: "language", to: "it" }, status: "pending" },
      },
      {
        step: "event",
        event: {
          type: "user",
          authorId: "p-laura",
          text: "thanks",
          attachments: [],
          delivery: "delivered",
        },
      },
    ]);
    renderRoute(`/claude/${cid}`, "p-laura");
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("failed"));
    expect(i18n.language).toBe("en");
    await waitFor(() =>
      expect(document.querySelector("[data-page-failed]")).toHaveTextContent(
        "Didn't run: the page wasn't changed",
      ),
    );
  });

  it("due runner montati PRIMA del messaggio: la lingua cambia una volta, una sola chiusura (review finale, 6)", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    const settle = vi.spyOn(api, "settlePageEvent");
    const change = vi.spyOn(i18n, "changeLanguage");
    const a = mountHarness("p-laura", cid);
    const b = mountHarness("p-laura", cid);
    await waitFor(() => {
      expect(a.container.querySelector("[data-harness]")).not.toBeNull();
      expect(b.container.querySelector("[data-harness]")).not.toBeNull();
    });
    await api.sendMessage(cid, { text: "switch to Italian" });
    await waitFor(() => expect(pageEvents()[0]?.status).toBe("done"));
    await waitFor(() =>
      expect(b.container.querySelector("[data-harness]")).not.toHaveAttribute("data-harness", "0"),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settle).toHaveBeenCalledTimes(1);
    expect(change.mock.calls.filter(([lng]) => lng === "it")).toHaveLength(1);
    a.unmount();
    b.unmount();
  });

  it("due runner montati: chiuderne uno non spegne l'«Undo» dell'altro", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    await api.sendMessage(cid, { text: "switch to Italian" });
    const a = mountHarness("p-laura", cid);
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("done"));
    const b = mountHarness("p-laura", cid);
    // Il secondo runner montato davvero (la sua conversazione letta), poi smontato.
    await waitFor(() =>
      expect(b.container.querySelector("[data-harness]")).toHaveAttribute("data-harness", "2"),
    );
    b.unmount();
    expect(undoPageEvent(pageEvents()[0]!.id)).toBe("undone");
    expect(i18n.language).toBe("en");
    a.unmount();
  });
});

describe("una chiusura `done` che non riesce (M3)", () => {
  it("rimette il valore di prima e chiude `failed`: la pagina non cambia senza traccia", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    await api.sendMessage(cid, { text: "dark theme" });
    api.failNext("settlePageEvent");
    mountHarness("p-laura", cid);
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("failed"));
    expect(document.documentElement.dataset.theme).not.toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).not.toBe("dark");
  });
});

/** Il runner di chi guarda, su una conversazione; dice quando l'ha letta. */
function Harness({ conversationId }: { conversationId: string }) {
  usePageEventRunner(conversationId);
  const detail = useConversation(conversationId).data;
  return <span data-harness={detail ? detail.events.length : 0} />;
}
function mountHarness(personId: string, conversationId: string) {
  const root = createRootRoute({ component: () => <Harness conversationId={conversationId} /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
}

describe("il «vedi come»", () => {
  const mount = mountHarness;

  it("il riquadro esegue solo gli eventi di chi ha aperto la conversazione", async () => {
    setSessionPersonId("p-laura");
    const cid = (await api.createConversation()).id;
    await api.sendMessage(cid, { text: "switch to Italian" });
    await api.setVisibility(cid, "public", { confirmedProjectIds: [] });
    expect(pageEvents()[0]!.status).toBe("pending");
    // Roberta legge la pubblica di Laura: la vede, ma il suo riquadro non la esegue.
    const roberta = mount("p-roberta", cid);
    await waitFor(() =>
      expect(roberta.container.querySelector("[data-harness]")).toHaveAttribute(
        "data-harness",
        "2",
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(i18n.language).toBe("en");
    expect(pageEvents()[0]!.status).toBe("pending");
    roberta.unmount();
    // Lo stesso evento nel riquadro di chi l'ha aperta: si esegue.
    mount("p-laura", cid);
    await waitFor(() => expect(pageEvents()[0]!.status).toBe("done"));
    expect(i18n.language).toBe("it");
  });
});

describe("il filtro salvato nella riga eseguita", () => {
  const savedRow = (undo: UndoView | undefined, viewerId = "p-laura") => (
    <ExecutedRow
      conversationId="c-x"
      event={{
        id: "e-x",
        at: "2026-10-24T09:00:00Z",
        type: "executed",
        groupId: "g-x",
        status: "done",
        actions: [
          {
            fn: "saveFilter",
            args: { name: "Marco in ACQ", visibility: "private", criteria: {} },
            summary: "saveFilter",
          },
        ],
      }}
      undo={undo}
      viewerId={viewerId}
      ownerId="p-laura"
      viewerName="Laura Costa"
    />
  );

  it("chi l'ha chiesto legge «only you see it»; un altro lettore della pubblica «private»", async () => {
    const mine = renderWithData(savedRow({ state: "available", needsReauth: false }), {
      personId: "p-laura",
    });
    expect(mine.container).toHaveTextContent("Saved the filter “Marco in ACQ” · only you see it");
    mine.unmount();
    const other = renderWithData(savedRow({ state: "not_yours" }, "p-roberta"), {
      personId: "p-roberta",
    });
    expect(other.container).toHaveTextContent("Saved the filter “Marco in ACQ” · private");
    expect(other.container).not.toHaveTextContent("only you");
    other.unmount();
    // Senza lo stato di «Undo» chi è il proprietario lo dice `ownerId`, non si deduce (M4).
    const noUndo = renderWithData(savedRow(undefined, "p-roberta"), { personId: "p-roberta" });
    expect(noUndo.container).toHaveTextContent("· private");
    expect(noUndo.container).not.toHaveTextContent("only you");
  });
});
