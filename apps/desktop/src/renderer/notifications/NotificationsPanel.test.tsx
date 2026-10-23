import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, listNotifications, markNotification, resetApi, setLatency } from "../data/api";
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
    expect(button.querySelector("[data-unread-dot]")).not.toBeNull();
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
    await waitFor(() => expect(within(item).queryByRole("menuitem", { name: "Tomorrow" })).toBeNull());
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
