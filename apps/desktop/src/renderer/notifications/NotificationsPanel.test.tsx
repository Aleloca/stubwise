import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chat,
  failNext,
  listNotifications,
  markNotification,
  resetApi,
  setLatency,
} from "../data/api";
import { setSessionPersonId } from "../data/session";
import { now, state } from "../data/store";
import { DEPARTMENTS } from "../data/seed/departments";
import { PROJECTS } from "../data/seed/projects";
import { ViewerProvider } from "../data/viewer";
import { setLanguage } from "../i18n";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";

function renderAt(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

afterEach(() => {
  setLanguage("en");
});

/** I nomi della legenda dei reparti, in ordine. */
const legendItems = (legend: HTMLElement) =>
  [...legend.querySelectorAll("[data-dept-legend-item]")].map((el) => el.textContent);

const bell = () => screen.findByRole("button", { name: /^Notifications/ });

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await bell());
  return screen.findByRole("dialog", { name: "Notifications" });
}

const byRecency = (list: Awaited<ReturnType<typeof listNotifications>>) =>
  [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

describe("campanella", () => {
  it("mostra un punto e dice quante sono le non lette", async () => {
    renderAt("/home");
    const unread = (await listNotifications()).filter((n) => !n.read).length;
    expect(unread).toBeGreaterThan(0);
    const button = await screen.findByRole("button", { name: `Notifications, ${unread} unread` });
    // Punto d'inchiostro: il blu di `--focus` è solo per gli anelli di fuoco.
    expect(button.querySelector("[data-unread-dot]")).toHaveClass("bg-ink");
  });

  it("senza non lette niente punto e nome semplice", async () => {
    for (const n of await listNotifications()) await markNotification(n.id, { read: true });
    renderAt("/home");
    const button = await screen.findByRole("button", { name: "Notifications" });
    expect(button.querySelector("[data-unread-dot]")).toBeNull();
  });

  it("l'etichetta segue la lingua", async () => {
    setLanguage("it");
    renderAt("/home");
    expect(await screen.findByRole("button", { name: /^Notifiche, \d+ da leggere$/ })).toBeTruthy();
  });
});

describe("pannello", () => {
  it("elenca le non archiviate per data, dalla più recente", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const all = byRecency(await listNotifications());
    const items = await within(panel).findAllByRole("listitem");
    expect(items).toHaveLength(all.length);
    expect(within(items[0]!).getByText(all[0]!.title)).toBeTruthy();
    expect(within(items.at(-1)!).getByText(all.at(-1)!.title)).toBeTruthy();
  });

  it("ogni riga parte dal codice del suo oggetto, col progetto accanto", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const all = byRecency(await listNotifications());
    const items = await within(panel).findAllByRole("listitem");
    expect(items).toHaveLength(all.length);
    items.forEach((item, i) => {
      const n = all[i]!;
      const code = item.querySelector<HTMLElement>("[data-object-code]")!;
      expect(code.textContent).toBe(n.objectCode);
      // Il codice è il primo testo visibile della riga.
      const button = within(item).getAllByRole("button")[0]!;
      const firstText = [...button.querySelectorAll("span")].find(
        (el) => el.children.length === 0 && el.textContent && !el.classList.contains("sr-only"),
      );
      expect(firstText).toBe(code);
      const project = PROJECTS.find((p) => p.id === n.projectId);
      if (project) expect(item).toHaveTextContent(project.name);
    });
  });

  it("anche gli eventi senza progetto hanno un codice e la loro provenienza", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const items = await within(panel).findAllByRole("listitem");
    const byCode = (code: string) =>
      items.find((i) => i.querySelector("[data-object-code]")?.textContent === code);
    expect(byCode("SEC-2")).toHaveTextContent("Account security");
    expect(byCode("SEC-1")).toHaveTextContent("Account security");
    for (const n of await listNotifications()) {
      if (n.projectId === null) expect(n.objectCode).toMatch(/^SEC-\d+$/);
    }
  });

  it("striscia di reparto (col nome accessibile) solo sulle notifiche di una task", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const all = byRecency(await listNotifications());
    const items = await within(panel).findAllByRole("listitem");
    expect(all.some((n) => n.departmentId)).toBe(true);
    expect(all.some((n) => !n.departmentId)).toBe(true);
    items.forEach((item, i) => {
      const n = all[i]!;
      const strip = item.querySelector("[data-dept-strip]");
      const button = within(item).getAllByRole("button")[0]!;
      if (n.departmentId) {
        const dept = DEPARTMENTS.find((d) => d.id === n.departmentId)!;
        expect(strip).toHaveAttribute("data-dept-strip", dept.id);
        expect(strip).toHaveAttribute("aria-hidden", "true");
        expect(button).toHaveAccessibleName(new RegExp("Department: " + dept.name));
        expect(button).toHaveAttribute("title", "Department: " + dept.name);
      } else {
        expect(strip).toBeNull();
        expect(button).not.toHaveAccessibleName(/Department:/);
        expect(button).not.toHaveAttribute("title");
      }
    });
  });

  it("righe compatte: le azioni non riservano spazio, il testo arriva a due righe", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const item = (await within(panel).findAllByRole("listitem"))[0]!;
    expect(item.querySelector("[data-notification-actions]")).toHaveClass("absolute");
    expect(within(item).getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(item.querySelector(".line-clamp-2")).not.toBeNull();
    expect(item.querySelector("[data-unread-dot]")).toHaveClass("bg-ink");
  });

  it("il piede ha la legenda dei soli reparti presenti nella scheda mostrata", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await within(panel).findAllByRole("listitem");
    const shown = (await listNotifications()).filter((x) => !x.archived);
    const expected = DEPARTMENTS.filter((d) => shown.some((x) => x.departmentId === d.id)).map(
      (d) => d.name,
    );
    const legend = within(panel).getByRole("group", { name: "Departments" });
    expect(legendItems(legend)).toEqual(expected);
    expect(legend).toHaveClass("text-xs");
    // Nessun nome tagliato: nei 400 px del pannello la legenda va a capo fra un reparto e l'altro.
    for (const el of legend.querySelectorAll("[data-dept-legend-item]")) {
      expect(el).toHaveClass("whitespace-nowrap");
    }
    // Archiviata una sola notifica di task, la scheda Archived ne mostra solo il reparto.
    const task = byRecency(shown).find((x) => x.departmentId)!;
    const row = within(panel)
      .getAllByRole("listitem")
      .find((li) => li.querySelector("[data-object-code]")?.textContent === task.objectCode)!;
    await user.click(within(row).getByRole("button", { name: "Archive" }));
    await user.click(within(panel).getByRole("tab", { name: /^Archived/ }));
    await waitFor(() =>
      expect(legendItems(within(panel).getByRole("group", { name: "Departments" }))).toEqual([
        DEPARTMENTS.find((d) => d.id === task.departmentId)!.name,
      ]),
    );
  });

  it("senza notifiche di task la legenda non c'è", async () => {
    for (const x of await listNotifications()) {
      if (x.departmentId) await markNotification(x.id, { archived: true });
    }
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    await within(panel).findAllByRole("listitem");
    expect(within(panel).queryByRole("group", { name: "Departments" })).toBeNull();
  });

  it("il titolo del pannello non è in maiuscoletto spaziato", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    const title = within(panel).getByRole("heading", { level: 2, name: "Notifications" });
    expect(title).not.toHaveClass("heading-group");
  });

  it("segna le non lette con un testo per i lettori di schermo", async () => {
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    expect((await within(panel).findAllByText("Unread")).length).toBeGreaterThan(0);
  });

  it("Archive sposta la notifica nella scheda Archived", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const total = (await listNotifications()).length;
    const item = (await within(panel).findAllByRole("listitem"))[0]!;
    await user.click(within(item).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(total - 1));
    await user.click(within(panel).getByRole("tab", { name: /^Archived/ }));
    expect(await within(panel).findAllByRole("listitem")).toHaveLength(1);
  });

  it("Snooze → Tomorrow la sposta in Snoozed, con la data", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const first = byRecency(await listNotifications())[0]!;
    const item = (await within(panel).findAllByRole("listitem"))[0]!;
    await user.click(within(item).getByRole("button", { name: "Snooze" }));
    await user.click(within(item).getByRole("menuitem", { name: "Tomorrow" }));
    await waitFor(async () =>
      expect((await listNotifications()).find((n) => n.id === first.id)!.snoozedUntil).toBe(
        "2026-10-24T09:00:00Z",
      ),
    );
    await user.click(within(panel).getByRole("tab", { name: /^Snoozed/ }));
    const snoozed = await within(panel).findAllByRole("listitem");
    expect(snoozed).toHaveLength(1);
    expect(snoozed[0]!.textContent).toMatch(/Until Oct 24/);
  });

  it("clic su una notifica naviga al suo link e la segna letta", async () => {
    const router = renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const sorted = byRecency(await listNotifications());
    const target = sorted.find((n) => !n.read && n.link.startsWith("#/p/"))!;
    const items = await within(panel).findAllByRole("listitem");
    const row = items[sorted.indexOf(target)]!;
    await user.click(within(row).getByRole("button", { name: new RegExp(target.title) }));
    await waitFor(() => expect(router.state.location.pathname).toContain(target.link.slice(1)));
    await waitFor(async () =>
      expect((await listNotifications()).find((n) => n.id === target.id)!.read).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());
  });

  it("Mark as read toglie il segno senza navigare", async () => {
    const router = renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const before = (await within(panel).findAllByText("Unread")).length;
    const item = within(panel).getAllByText("Unread")[0]!.closest("li")!;
    await user.click(within(item).getByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(within(panel).getAllByText("Unread")).toHaveLength(before - 1));
    expect(router.state.location.pathname).toBe("/home");
  });

  it("Esc chiude il pannello e il fuoco torna alla campanella", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    const button = await bell();
    button.focus();
    await user.click(button);
    await screen.findByRole("dialog", { name: "Notifications" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Notifications/ }));
  });

  it("Esc chiude il pannello anche con il fuoco fuori dal pannello", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    await openPanel(user);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.body).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());
  });

  it("Esc nel menu del rinvio chiude solo il menu, non il pannello", async () => {
    renderAt("/home");
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const item = (await within(panel).findAllByRole("listitem"))[0]!;
    await user.click(within(item).getByRole("button", { name: "Snooze" }));
    const menuItem = within(item).getByRole("menuitem", { name: "Tomorrow" });
    menuItem.focus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(within(item).queryByRole("menuitem", { name: "Tomorrow" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
  });

  it("stato vuoto: You're all caught up", async () => {
    for (const n of await listNotifications()) await markNotification(n.id, { archived: true });
    renderAt("/home");
    const panel = await openPanel(userEvent.setup());
    expect(await within(panel).findByText("You're all caught up")).toBeTruthy();
  });

  it("errore di caricamento con Try again che ricarica", async () => {
    renderAt("/home");
    await bell();
    failNext("listNotifications");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("stubwise:notifications"));
    });
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    const retry = await within(panel).findByRole("button", { name: "Try again" });
    await userEvent.setup().click(retry);
    expect(await within(panel).findAllByRole("listitem")).not.toHaveLength(0);
  });
});

// Task 8: una menzione diretta della Chat nelle notifiche. Si apre sul
// messaggio (nel thread, se è una risposta), dopo averlo riletto: se nel
// frattempo non c'è più, un avviso e nessun testo (R-G5).
describe("menzioni della Chat", () => {
  const TEXT = "@Giulia Ferri the desktop build is red";

  async function marcoMentionsGiulia(threadOf?: string) {
    setSessionPersonId("p-marco");
    const m = await chat.sendMessage("ch-stw-desktop", { text: TEXT, threadOf });
    setSessionPersonId("p-giulia");
    return m;
  }

  it("aprirla porta al messaggio nel canale", async () => {
    const m = await marcoMentionsGiulia();
    const user = userEvent.setup();
    const router = renderAt("/home");
    const panel = await openPanel(user);
    const item = await within(panel).findByText("Marco Bellini mentioned you in STW · desktop-app");
    expect(within(panel).getByText(TEXT)).toBeInTheDocument();
    await user.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-stw-desktop"));
    expect(router.state.location.search).toMatchObject({ message: m.id });
  });

  it("una risposta in un thread apre il thread sul messaggio", async () => {
    setSessionPersonId("p-giulia");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "Build status?" });
    const m = await marcoMentionsGiulia(root.id);
    const user = userEvent.setup();
    const router = renderAt("/home");
    const panel = await openPanel(user);
    await user.click(
      await within(panel).findByText("Marco Bellini mentioned you in STW · desktop-app"),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-stw-desktop"));
    expect(router.state.location.search).toMatchObject({ thread: root.id, message: m.id });
  });

  it("un messaggio sparito nel frattempo: avviso, si resta qui", async () => {
    const m = await marcoMentionsGiulia();
    const user = userEvent.setup();
    const router = renderAt("/home");
    const panel = await openPanel(user);
    const item = await within(panel).findByText("Marco Bellini mentioned you in STW · desktop-app");
    // Eliminato senza che la lista lo sappia ancora (una lettura vecchia).
    const stored = state.chatMessages.find((x) => x.id === m.id)!;
    stored.deletedAt = now();
    stored.deletedById = "p-marco";
    stored.text = "";
    await user.click(item);
    expect(await screen.findByText("This message is no longer available")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/home");
  });

  it("chi non legge il canale non la riceve", async () => {
    setSessionPersonId("p-laura");
    await chat.sendMessage("ch-aud-pricing", { text: "@Giulia Ferri do you agree on 15%?" });
    setSessionPersonId("p-giulia");
    const user = userEvent.setup();
    renderAt("/home");
    const panel = await openPanel(user);
    await within(panel).findAllByRole("listitem");
    expect(within(panel).queryByText(/15%/)).toBeNull();
    expect(within(panel).queryByText(/Laura Costa mentioned you/)).toBeNull();
  });
});
