import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleIdOf } from "./data/access/index";
import { resetApi, setLatency } from "./data/api";
import * as auth from "./data/auth/index";
import i18n from "./i18n";
import { renderRoute } from "./test/renderRoute";

// L'istanza vuota, pagina per pagina (area 9a, Task 12). Dopo «Reset to
// empty instance» resta solo Claude; il primo avvio crea il primo full admin
// e lui entra dal login (`createFirstAdmin` non apre una sessione). Ogni
// rotta raggiungibile senza un progetto si deve aprire senza lanciare e
// mostrare il suo stato vuoto. Le rotte sono tutte quelle di `data/routes.ts`
// e `router.tsx` fuori da `/p/$code` (Docs e Requests vivono solo dentro un
// progetto: con l'istanza vuota non sono raggiungibili).

const t = (key: string) => i18n.t(key);

let adminId = "";

beforeEach(async () => {
  setLatency(0);
  resetApi();
  await auth.resetToEmptyInstance();
  const created = await auth.createFirstAdmin({
    name: "Ada Prima",
    email: "ada@example.com",
    password: "a-long-one",
  });
  if (!created.ok) throw new Error(`createFirstAdmin: ${created.error}`);
  adminId = created.personId;
  // Come la UI: dopo il primo avvio si entra dal login. Senza secondo
  // fattore il login porta dentro subito; `renderRoute(…, adminId)` è il
  // `setPersona` che il login fa nell'app.
  const signedIn = await auth.login({ email: "ada@example.com", password: "a-long-one" });
  if (!signedIn.ok || signedIn.stage !== "in") throw new Error("login non riuscito");
});

// Un errore di render (anche intercettato da un confine) passa da console.error.
let consoleErrors: unknown[][] = [];
beforeEach(() => {
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    consoleErrors.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Case = {
  /** L'indirizzo; `{admin}` e `{adminRole}` si risolvono dopo il primo avvio. */
  path: string;
  /** Dove finisce (un rinvio previsto); di default `path` senza ricerca. */
  lands?: string;
  /** Il testo dello stato vuoto: una chiave i18n o un'espressione. */
  empty: string | RegExp;
};

const CASES: Case[] = [
  { path: "/", lands: "/home", empty: "home.decide.empty" },
  { path: "/home", empty: "home.decide.empty" },
  { path: "/home?view=week", empty: "week.emptyThis" },
  { path: "/chat", empty: "chat.landing.emptyTitle" },
  { path: "/chat?view=threads", empty: "chat.views.threadsEmpty" },
  { path: "/chat?view=mentions", empty: "chat.views.mentionsEmpty" },
  { path: "/chat?view=browse", empty: "chat.browse.empty.all" },
  { path: "/chat?view=search", empty: "chat.search.emptyTitle" },
  { path: "/mail", empty: /Connect your Google account to read your mail here/ },
  { path: "/calendar", empty: "calendar.connect.title" },
  { path: "/calendar?view=week", empty: "calendar.connect.title" },
  { path: "/drive", empty: "drive.states.emptyAllTitle" },
  { path: "/claude", empty: "claude.destination.landing.send" },
  { path: "/claude?scope=finished", empty: "claude.destination.states.emptyFinished" },
  { path: "/automations", empty: "automations.templates.heading" },
  { path: "/automations?view=runs", empty: "automations.empty.runs" },
  { path: "/automations/sources", empty: /No sources connected yet/ },
  { path: "/projects", empty: "projects.states.emptyTitle" },
  { path: "/projects?view=pinned", empty: "projects.states.emptyTitle" },
  { path: "/projects?view=person", empty: /Nothing happened on/ },
  { path: "/filters", empty: "filter.mineEmpty" },
  { path: "/planning", empty: "planning.pool.emptyTitle" },
  { path: "/preferences", lands: "/preferences/notifications", empty: "alerts.noProjects" },
  { path: "/preferences/notifications", empty: "alerts.noProjects" },
  { path: "/preferences/account", empty: /You don't follow any project yet/ },
  { path: "/preferences/security", empty: "prefs.security.sessions.none" },
  { path: "/preferences/tokens", empty: "prefs.tokens.empty" },
  { path: "/preferences/claude-code", empty: "prefs.claudeCode.create" },
  { path: "/preferences/look", empty: "prefs.look.intro" },
  { path: "/admin", lands: "/admin/people", empty: "admin.people.onlyYou" },
  { path: "/admin/people", empty: "admin.people.onlyYou" },
  { path: "/admin/departments", empty: /No departments yet/ },
  { path: "/admin/roles", empty: "admin.roles.claudeNote" },
  { path: "/admin/changelog", empty: /set up the instance as its first full admin/ },
  { path: "/admin/who-can", empty: "whoCan.page.pickAction" },
  { path: "/admin/who-can?view=what", empty: "whoCan.page.pickPerson" },
  // Un'azione di progetto senza progetti: nessun menu vuoto da aprire.
  { path: "/admin/who-can?action=approvePlan", empty: "whoCan.page.noProjects" },
  { path: "/admin/people/{admin}", empty: "admin.person.you" },
  { path: "/admin/roles/{adminRole}", empty: "admin.role.presetNote" },
];

describe("l'istanza vuota, dopo il primo avvio", () => {
  it.each(CASES)("$path si apre e mostra il suo stato vuoto", async ({ path, lands, empty }) => {
    const resolved = path
      .replace("{admin}", adminId)
      .replace("{adminRole}", roleIdOf("admin"));
    const router = renderRoute(resolved, adminId);
    const main = await screen.findByRole("main");
    const text = typeof empty === "string" ? t(empty) : empty;
    expect(await within(main).findAllByText(text, { exact: false })).not.toHaveLength(0);
    expect(router.state.location.pathname).toBe(lands ?? resolved.split("?")[0]);
    // Né «non trovata» né un errore di caricamento.
    expect(within(main).queryByText(t("notFound.title"))).toBeNull();
    expect(within(main).queryByText(/^Couldn't/)).toBeNull();
    expect(consoleErrors).toEqual([]);
  });

  it("Who can? con un'azione di progetto: il menu dei progetti, vuoto, non si apre da solo", async () => {
    renderRoute("/admin/who-can?action=approvePlan", adminId);
    await screen.findByText(t("whoCan.page.noProjects"));
    expect(screen.queryByRole("listbox", { name: t("whoCan.page.projectMenu") })).toBeNull();
    expect(screen.queryByText(t("whoCan.page.noMatch"))).toBeNull();
  });
});
