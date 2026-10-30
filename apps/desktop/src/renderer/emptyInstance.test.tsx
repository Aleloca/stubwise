import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleIdOf } from "./data/access/index";
import { resetApi, setLatency } from "./data/api";
import * as auth from "./data/auth/index";
import { PEOPLE } from "./data/seed/people";
import { PROJECTS } from "./data/seed/projects";
import i18n from "./i18n";
import { renderRoute } from "./test/renderRoute";

// L'istanza vuota, pagina per pagina (area 9a, Task 12). Dopo «Reset to
// empty instance» resta solo Claude; il primo avvio crea il primo full admin
// e lui entra dal login (`createFirstAdmin` non apre una sessione). Ogni
// rotta raggiungibile senza un progetto si deve aprire senza lanciare e
// mostrare il suo stato vuoto. Le rotte sono tutte quelle di `data/routes.ts`
// e `router.tsx` fuori da `/p/$code` (Docs e Requests vivono solo dentro un
// progetto: con l'istanza vuota non sono raggiungibili), più gli indirizzi
// con un id che non esiste, che danno la loro pagina «non trovato».
//
// Ogni caso ha due prove: la sua (un testo di vuoto vero, o l'assenza di una
// riga riconoscibile del seme) e quella generale (nessun nome di persona o di
// progetto del seme, fuori da Claude e dal primo admin). Il controllo in fondo
// rende le stesse rotte col seme pieno e pretende che entrambe cadano: un
// testo che c'è anche col seme non prova un vuoto.

const t = (key: string) => i18n.t(key);

// Fotografati all'import, prima di ogni reset: il seme li svuota.
const SEED_PEOPLE = PEOPLE.filter((p) => !p.isClaude).map((p) => p.name);
// «Stubwise» è anche il nome del prodotto (il riquadro di Mail, le sessioni):
// del progetto STW resta il codice.
const SEED_PROJECTS = PROJECTS.map((p) => ({
  code: p.code,
  name: p.name === "Stubwise" ? null : p.name,
}));

/** I testi della finestra, nodo per nodo: `textContent` incolla «STW» al vicino e il confine di parola sparisce. */
function textNodes(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n.textContent ?? "");
  return out;
}

/** I nomi del seme che si leggono nella finestra; `path` scusa il codice che l'indirizzo stesso nomina. */
function seedNamesShown(path: string): string[] {
  const nodes = textNodes();
  const some = (test: (node: string) => boolean) => nodes.some(test);
  const people = SEED_PEOPLE.filter((name) => some((n) => n.includes(name)));
  const projects = SEED_PROJECTS.flatMap(({ code, name }) => {
    const re = new RegExp(`\\b${code}\\b`);
    return [
      ...(some((n) => re.test(n)) && !path.includes(`/${code}`) ? [code] : []),
      ...(name && some((n) => n.includes(name)) ? [name] : []),
    ];
  });
  return [...people, ...projects];
}

type Text = string | RegExp;

type Case = {
  /** L'indirizzo; `{admin}` e `{adminRole}` si risolvono dopo il primo avvio. */
  path: string;
  /** Dove finisce (un rinvio previsto); di default `path` senza ricerca. */
  lands?: string;
  /**
   * La prova del caso: un testo di vuoto (chiave i18n o espressione) e/o
   * righe del seme che non devono esserci. `proof: "general"` = la pagina
   * non mostra dati suoi (Language & theme, Claude Code): resta la prova
   * generale. `proof: "notFound"` = un id inesistente, la sua pagina.
   */
  empty?: Text;
  absent?: Text[];
  /** Quante righe di un tipo ci sono (`[selettore, n]`): il registro ha la sola voce del primo avvio. */
  count?: [string, number];
  proof?: "general" | "notFound";
  /** Prima di guardare: aprire un menu. */
  steps?: () => Promise<void>;
  /** Chi guarda nel controllo col seme pieno (di default Roberta, full admin). */
  seedAs?: string;
};

const openProjectMenu = async () => {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${t("whoCan.page.projectMenu")}:`) }),
  );
};
const openPersonMenu = async () => {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${t("whoCan.page.personMenu")}:`) }),
  );
};

const CASES: Case[] = [
  { path: "/", lands: "/home", empty: "home.decide.empty", seedAs: "p-laura" },
  { path: "/home", empty: "home.decide.empty", seedAs: "p-laura" },
  { path: "/home?view=week", empty: "week.emptyThis", seedAs: "p-giulia" },
  { path: "/chat", empty: "chat.landing.emptyTitle" },
  { path: "/chat?view=threads", empty: "chat.views.threadsEmpty", seedAs: "p-giulia" },
  { path: "/chat?view=mentions", empty: "chat.views.mentionsEmpty", seedAs: "p-giulia" },
  { path: "/chat?view=browse", empty: "chat.browse.empty.all" },
  { path: "/chat?view=search", empty: "chat.search.emptyTitle", proof: "general" },
  { path: "/mail", empty: /Connect your Google account to read your mail here/, seedAs: "p-giulia" },
  { path: "/calendar", empty: "calendar.connect.title", seedAs: "p-giulia" },
  { path: "/calendar?view=day", empty: "calendar.connect.title", seedAs: "p-giulia" },
  { path: "/calendar?view=week", empty: "calendar.connect.title", seedAs: "p-giulia" },
  { path: "/calendar?view=month", empty: "calendar.connect.title", seedAs: "p-giulia" },
  { path: "/drive", empty: "drive.states.emptyAllTitle" },
  // La landing ha sempre «Start conversation»: il vuoto è la colonna senza sessioni.
  { path: "/claude", absent: [/waiting on you/] },
  { path: "/claude?scope=finished", empty: "claude.destination.states.emptyFinished", seedAs: "p-marco" },
  { path: "/automations", empty: "automations.empty.intro" },
  { path: "/automations?view=runs", empty: "automations.empty.runs" },
  { path: "/automations?view=attention", empty: "automations.empty.attention" },
  { path: "/automations/sources", empty: /No sources connected yet/ },
  { path: "/projects", empty: "projects.states.emptyTitle" },
  { path: "/projects?view=pinned", empty: "projects.states.emptyTitle" },
  { path: "/projects?view=person", empty: /Nothing happened on/ },
  { path: "/filters", empty: "filter.mineEmpty", seedAs: "p-giulia" },
  { path: "/planning", empty: "planning.pool.emptyTitle" },
  { path: "/preferences", lands: "/preferences/notifications", empty: "alerts.noProjects" },
  { path: "/preferences/notifications", empty: "alerts.noProjects" },
  { path: "/preferences/account", empty: /You don't follow any project yet/ },
  { path: "/preferences/security", empty: "prefs.security.sessions.none" },
  { path: "/preferences/tokens", empty: "prefs.tokens.empty", seedAs: "p-marco" },
  { path: "/preferences/claude-code", proof: "general" },
  { path: "/preferences/look", proof: "general" },
  { path: "/admin", lands: "/admin/people", empty: "admin.people.onlyYou" },
  { path: "/admin/people", empty: "admin.people.onlyYou" },
  // Il primo avvio crea un reparto solo, «General» (I1): nessuno del seme.
  {
    path: "/admin/departments",
    absent: ["Marketing", "Sales", "Support", "Development", "Administration"],
  },
  // I due ruoli fatti a mano nel seme non ci sono più: restano i preset.
  { path: "/admin/roles", absent: ["Auditor", "Release manager"] },
  // Il seme ha anche lui la voce del primo avvio: il vuoto è che ci siano
  // solo quella e il reparto «General» nato con lei.
  {
    path: "/admin/changelog",
    empty: /set up the instance as its first full admin/,
    count: ["[data-change-entry]", 2],
  },
  // Il menu dei progetti, aperto: non c'è niente da scegliere.
  { path: "/admin/who-can", steps: openProjectMenu, empty: "whoCan.page.noProjects" },
  // Il menu delle persone, aperto: nessuna persona del seme (prova generale) né Laura.
  { path: "/admin/who-can?view=what", steps: openPersonMenu, absent: ["Laura Costa"] },
  { path: "/admin/who-can?action=approvePlan", empty: "whoCan.page.noProjects" },
  { path: "/admin/people/{admin}", empty: "admin.person.you", proof: "general" },
  { path: "/admin/roles/{adminRole}", empty: /0 memberships|1 person/, proof: "general" },
  // Id che non esistono: la pagina «non trovato» di ciascuno.
  { path: "/p/ACQ", lands: "/p/ACQ/overview", empty: "project.notFound", proof: "notFound" },
  { path: "/p/ACQ/tasks", empty: "project.notFound", proof: "notFound" },
  { path: "/filters/flt-open", empty: "filter.notFound", proof: "notFound" },
  { path: "/claude/x", empty: "claude.conversation.states.notFound", proof: "notFound" },
  { path: "/chat/x", empty: "chat.channel.notFoundTitle", proof: "notFound" },
  // Senza casella collegata la Posta chiede di collegarla, anche con un id.
  // Senza un account Google la Posta non ha conversazioni da cercare: l'id
  // inesistente mostra l'invito a collegarlo, non una pagina «non trovato».
  {
    path: "/mail/x",
    empty: /Connect your Google account to read your mail here/,
    seedAs: "p-giulia",
  },
  { path: "/automations/ACQ-A1", empty: "automations.notVisible.automation", proof: "notFound" },
  { path: "/automations/ACQ-A1/runs/1", empty: "automations.notVisible.run", proof: "notFound" },
  { path: "/admin/people/p-marco", empty: "notFound.title", proof: "notFound" },
  { path: "/admin/people/invites/x", empty: "notFound.title", proof: "notFound" },
  { path: "/admin/roles/x", empty: "notFound.title", proof: "notFound" },
];

const asText = (text: Text) => (typeof text === "string" ? t(text) : text);

/** La prova del caso: il testo di vuoto c'è e le righe del seme no. */
function caseProofHolds(c: Case): boolean {
  const text = document.body.textContent ?? "";
  const has = (x: Text) => {
    const v = asText(x);
    return typeof v === "string" ? text.includes(v) : v.test(text);
  };
  const counted = !c.count || document.querySelectorAll(c.count[0]).length === c.count[1];
  return (c.empty === undefined || has(c.empty)) && !(c.absent ?? []).some(has) && counted;
}

// Un errore di render (anche intercettato da un confine) passa da console.error.
let consoleErrors: unknown[][] = [];
beforeEach(() => {
  setLatency(0);
  resetApi();
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    consoleErrors.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("l'istanza vuota, dopo il primo avvio", () => {
  let adminId = "";
  beforeEach(async () => {
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

  it.each(CASES)("$path si apre e mostra il suo stato vuoto", async (c) => {
    const resolved = c.path.replace("{admin}", adminId).replace("{adminRole}", roleIdOf("admin"));
    const router = renderRoute(resolved, adminId);
    const main = await screen.findByRole("main");
    if (c.steps) await c.steps();
    if (c.empty !== undefined) {
      expect(await screen.findAllByText(asText(c.empty), { exact: false })).not.toHaveLength(0);
    } else {
      await within(main).findAllByRole("heading", { level: 1 });
    }
    for (const row of c.absent ?? []) {
      expect(screen.queryAllByText(asText(row), { exact: false })).toHaveLength(0);
    }
    expect(caseProofHolds(c)).toBe(true);
    expect(seedNamesShown(resolved)).toEqual([]);
    expect(router.state.location.pathname).toBe(c.lands ?? resolved.split("?")[0]);
    if (c.proof !== "notFound") {
      expect(within(main).queryByText(t("notFound.title"))).toBeNull();
    }
    expect(within(main).queryByText(/^Couldn't/)).toBeNull();
    expect(consoleErrors).toEqual([]);
  });

  it("Who can? con un'azione di progetto: il menu dei progetti, vuoto, non si apre da solo", async () => {
    renderRoute("/admin/who-can?action=approvePlan", adminId);
    await screen.findByText(t("whoCan.page.noProjects"));
    expect(screen.queryByRole("listbox", { name: t("whoCan.page.projectMenu") })).toBeNull();
  });

  it("Who can?: il menu dei progetti aperto a mano dice che non ce ne sono, non «Nothing matches»", async () => {
    renderRoute("/admin/who-can", adminId);
    await openProjectMenu();
    const list = await screen.findByRole("listbox", { name: t("whoCan.page.projectMenu") });
    expect(within(list).getByText(t("whoCan.page.noProjects"))).toBeInTheDocument();
    expect(screen.queryByText(t("whoCan.page.noMatch"))).toBeNull();
  });
});

// Il controllo: le stesse rotte col seme pieno. Ogni prova deve cadere,
// altrimenti non distingue un'istanza vuota da una piena.
describe("col seme pieno le stesse prove cadono", () => {
  it.each(CASES.filter((c) => !c.path.includes("{")))("$path", async (c) => {
    renderRoute(c.path, c.seedAs ?? "p-roberta");
    await screen.findByRole("main");
    // La pagina col seme ha i suoi dati: si aspetta che arrivino (un nome del seme).
    await vi.waitFor(() => expect(seedNamesShown(c.path)).not.toEqual([]), { timeout: 5000 });
    if (c.proof === undefined) {
      await new Promise((r) => setTimeout(r, 150));
      if (c.steps) await c.steps();
      await vi.waitFor(() => expect(caseProofHolds(c)).toBe(false), { timeout: 3000 });
    }
  });
});
