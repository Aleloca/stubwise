import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../test/renderRoute";

// Le aree non integrate nella build app (integrazione area 2, fetta 1): restano
// nella navigazione con «Coming soon» e non leggono niente. Nei test il livello
// dati è il finto anche con `VITE_STUBWISE_BUILD=app`: qui si registra ogni
// chiamata ai namespace delle aree future, che devono restare a zero.
const { FUTURE_NAMESPACES, calls, truncated, intake, refusal } = vi.hoisted(() => ({
  // L'intake del server può fondere una richiesta nuova in una esistente: qui la si finge.
  intake: { mergeInto: null as string | null, pending: false },
  // Un rifiuto del server per codice (`{ code }` come un ApiError): la funzione indicata rifiuta così.
  refusal: { fn: null as string | null, code: "" },
  calls: [] as string[],
  // Il finto non tronca mai: qui si finge la risposta del server oltre le 2000 righe.
  truncated: { value: false, onlyFiltered: false },
  FUTURE_NAMESPACES: [
    "auth",
    "admin",
    "me",
    "projectSettings",
  "chat",
  "docs",
  "productDocs",
  "drive",
  "mail",
  "calendar",
  "automations",
  "alerts",
  "releases",
  "support",
  "servers",
  "changelog",
  "access",
  "claude",
  "instance",
  ] as const,
}));

vi.mock("@backend/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const record = (name: string, fn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push(name);
      if (refusal.fn === name) {
        refusal.fn = null;
        return Promise.reject(Object.assign(new Error("Refused by the server"), { code: refusal.code }));
      }
      return fn(...args);
    };
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (name === "createRequest") {
      const create = value as (input: { projectId: string }) => Promise<unknown>;
      const list = mod.listRequests as (projectId: string) => Promise<{ code: string }[]>;
      wrapped[name] = record(name, async (...args: unknown[]) => {
        const input = args[0] as { projectId: string };
        // Accodata dal server ma senza esito ancora (`intake_pending`, review della fetta 4).
        if (intake.pending) throw new Error("intake_pending");
        if (!intake.mergeInto) return create(input);
        const target = (await list(input.projectId)).find((r) => r.code === intake.mergeInto);
        return { ...target, landedByMerge: true };
      });
    } else if (name === "tasksTruncated") {
      // `onlyFiltered`: troncata solo una lettura con criteri (la vasca del Planning), non quella intera.
      wrapped[name] = record(name, (criteria?: unknown) =>
        truncated.onlyFiltered ? criteria !== undefined : truncated.value,
      );
    } else if (typeof value === "function") {
      wrapped[name] = record(name, value as (...a: unknown[]) => unknown);
    } else if (value && typeof value === "object" && FUTURE_NAMESPACES.includes(name as never)) {
      wrapped[name] = new Proxy(value as Record<string, unknown>, {
        get(t, key) {
          const v = t[key as string];
          if (typeof key !== "string" || typeof v !== "function") return v;
          return record(`${name}.${key}`, v as (...a: unknown[]) => unknown);
        },
      });
    } else wrapped[name] = value;
  }
  return wrapped;
});

const { failNext, resetApi, setLatency } = await import("../data/api");
const { setSessionPersonId } = await import("../data/session");

/** Nella build app la persona è quella della sessione (il finto), non quella di `renderRoute`. */
function signedInAs(personId: string) {
  setSessionPersonId(personId);
}

beforeEach(() => {
  setLatency(0);
  calls.length = 0;
  truncated.value = false;
  truncated.onlyFiltered = false;
  intake.mergeInto = null;
  intake.pending = false;
  refusal.fn = null;
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

/**
 * Ciò che la build app può chiamare: le esportazioni che i Task 16–17
 * dell'integrazione implementano sul server vero (ossatura e Tasks). Ogni
 * altra chiamata, nella build app vera, sarebbe uno stub «non integrato».
 */
const INTEGRATED_CALLS = new Set([
  // Task 16: sessione, persone, progetti, notifiche, ricerca, reparti.
  "getViewer",
  "getSessionPerson",
  "auth.readEntry",
  "auth.login",
  "auth.logout",
  "listPeople",
  "listDepartments",
  "listProjects",
  "getProjectByCode",
  "listPinnedProjectIds",
  "setPinned",
  "listWaitingOnMeProjectIds",
  "listNotifications",
  "markNotification",
  "search",
  "admin.listDepartments",
  "admin.createDepartment",
  "admin.updateDepartment",
  "admin.saveDepartment",
  "admin.deleteDepartment",
  // Task 17: Tasks, dettaglio, nuova task, stati.
  "listTasks",
  "listStalled",
  "getTaskByCode",
  "listActivity",
  "listDecisionRequests",
  "getTaskWork",
  "getTaskWorkSummary",
  "listProjectStatuses",
  "listMilestones",
  "getRequest",
  // Fetta 2: settimana, Planning, La mia settimana, Timeline.
  "listDayArrangements",
  "planTask",
  "setDay",
  "tasksTruncated",
  // Fetta 3: Home a blocchi, ruoli di reparto, filtri salvati, richieste da trasformare.
  "listDepartmentHomes",
  "getPersonalHome",
  "setPersonalHome",
  "resetPersonalHome",
  "setDepartmentHome",
  "markDepartmentHomeSeen",
  "listDepartmentRoles",
  "listSavedFilters",
  "getSavedFilter",
  "listPinnedFilterIds",
  "saveFilter",
  "updateFilter",
  "deleteFilter",
  "setFilterPinned",
  "listRequestsToConvert",
  // Fetta 4: Requests, Overview, traguardi, Tutti i progetti, Nuovo progetto.
  "listRequests",
  "getRequestByCode",
  "createRequest",
  "updateRequest",
  "mergeRequest",
  "archiveRequest",
  "reopenRequest",
  "restoreRequest",
  "convertRequest",
  "createMilestone",
  "updateMilestone",
  "deleteMilestone",
  "listDecisionLog",
  "decisionLogTruncated",
  // Area 3, fetta 3a: le sessioni di lavoro in lettura e lo stream dal vivo.
  "listConversations",
  "getConversation",
  "subscribe",
  "mergeStreamEvent",
  "reconnectDelay",
  "onConversationChange",
  // Area 3, fetta 3b: le azioni e «Da decidere» di Claude.
  "startRun",
  "relaunchWithInstructions",
  "resumeCorrection",
  "requestChanges",
  "cancelRun",
  "decidePlan",
  "preApprovePlan",
  "revokePlanApproval",
  "answerQuestion",
  "sendMessage",
  "stop",
  "stopAndSend",
  "listClaudeDecisions",
  // Area 3, fetta 3d: «By person» di Activity.
  "listPeopleActivity",
  // Area 3, fetta 3c: il refinement delle richieste.
  "getRefineOf",
  "startRefineConversation",
  "closeRefine",
  "listDailyReports",
  "generateDailyReport",
  "recordDecision",
  "setDecisionSuperseded",
  "getLatestBrief",
  "listTimelinePage",
  "listPortfolioActivityPage",
  "projectPulse",
  "listProjectPulses",
  "createProject",
  // Chat, fette 1–2 (F1.x, F2.1a): i codici e le citazioni risolti nei
  // messaggi, e il blocco dell'istanza (budget) che spegne la casella.
  "resolveCodes",
  "resolveCitations",
  "instance.getAiBlock",
  // F3.0 della chat: «Delete task…» (l'anteprima si legge all'apertura del menu).
  "getTaskDeletion",
  "deleteTask",
  // Area 4, fetta 1: la Chat fra persone (DM, ricerca, domande, @Claude ed eventi restano fuori).
  "chat.listChannels",
  "chat.getChannel",
  "chat.listChannelMembers",
  "chat.listMessages",
  "chat.getMessage",
  "chat.listThread",
  "chat.listThreadsWithNews",
  "chat.hasNews",
  "chat.listMentions",
  "chat.sendMessage",
  "chat.editMessage",
  "chat.deleteMessage",
  "chat.toggleReaction",
  "chat.markRead",
  "chat.markThreadRead",
  "chat.setThreadFollow",
  "chat.setNotifyLevel",
  "chat.joinChannel",
  "chat.leaveChannel",
  "chat.createChannel",
  "chat.updateChannel",
  "chat.archiveChannel",
  "chat.deleteChannel",
  "chat.channelStream",
  "chat.threadStream",
  "chat.subscribeChat",
  "chat.onChatChange",
]);

const outside = () => [...new Set(calls)].filter((c) => !INTEGRATED_CALLS.has(c));

afterEach(() => {
  vi.unstubAllEnvs();
  resetApi();
});

const MORE = "More actions for AUD-9";
const DELETE = "Delete task\u2026";

/** Lascia partire le letture della shell. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("aree non integrate nella build app", () => {
  // Dall'area 4 (fetta 1) la Chat è integrata: si legge, e solo con la fetta 1.
  it("aprire la Chat la legge, senza le funzioni delle fette dopo", async () => {
    renderRoute("/chat");
    await waitFor(() => expect(calls).toContain("chat.listChannels"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("aprire un progetto atterra sull'Overview", async () => {
    const router = renderRoute("/p/AUD");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/overview"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("le Tasks leggono solo ciò che è integrato", async () => {
    renderRoute("/p/AUD/tasks");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await settle();
    // Niente riga di Claude, niente blocchi dell'istanza.
    expect(outside()).toEqual([]);
  });

  it("il binario non legge i segnali delle aree future (Posta, Automations); la Chat sì, dalla fetta 1", async () => {
    renderRoute("/projects");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("una sezione di progetto non integrata mostra «Coming soon»", async () => {
    renderRoute("/p/AUD/docs");
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  // Dal Task 17 la sezione Claude dice lo stato vero (e «Open in web» nel web vecchio).
  // Da F3.0 della chat «Delete task…» c'è nel menu «⋯» (Marco può eliminare).
  it("nel dettaglio della task la sezione Claude c'è intera; a lavoro finito nessuna azione, e «Delete» nel menu", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-9");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-9" });
    const claudeRegion = () => within(panel).getByRole("region", { name: "Claude" });
    // Dalla 3a la sezione legge il lavoro intero (`getTaskWork`), non più il riassunto della fetta 1.
    await waitFor(() => expect(claudeRegion()).toHaveTextContent("Claude finished its work."));
    expect(within(claudeRegion()).queryByText("Coming soon")).toBeNull();
    expect(within(claudeRegion()).queryByText("Open in web")).toBeNull();
    expect(
      within(claudeRegion()).queryByRole("button", {
        name: /Assign to Claude|^Start|Relaunch|Resume the correction|Request changes/,
      }),
    ).toBeNull();
    await user.click(within(panel).getByRole("button", { name: MORE }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByText(DELETE)).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("getTaskWork");
  });

  it("nel prototipo la Chat resta la Chat", async () => {
    vi.unstubAllEnvs();
    renderRoute("/chat");
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });
});

describe("le superfici della fetta 2 nella build app", () => {
  it("/planning senza planning.others torna alla Home", async () => {
    signedInAs("p-marco");
    const router = renderRoute("/planning");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
  });

  // Area 3, fetta 3e: Claude è assegnabile (`claude-assign`). Nel finto lo è
  // dove è membro (sul server dove lo dice `claudeAssignableProjectIds`); la
  // sua riga c'è sempre, in sola lettura dove chi guarda non può assegnarlo.
  it("il Planning trasversale c'è per chi ha planning.others, con la riga di Claude", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(await screen.findByRole("rowheader", { name: /Claude/ })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("in un progetto dove Claude non si assegna, la sua riga c'è in sola lettura col motivo", async () => {
    signedInAs("p-laura");
    // Qui Claude non è membro di AUD: non si assegna (nel finto l'assegnabilità è l'appartenenza).
    const { state } = await import("../data/store");
    const aud = state.projectsById.get("prj-aud")!;
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-claude");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    const head = await screen.findByRole("rowheader", { name: /Claude/ });
    expect(head).toHaveAttribute("data-readonly", "true");
    expect(head).toHaveAttribute("title", "Only someone who can start Claude's work plans for Claude");
  });

  it("il menu «Plan» propone Claude dove si assegna", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-pool] [data-chip]")).not.toBeNull());
    const chip = document.querySelector<HTMLElement>("[data-pool] [data-chip]")!;
    chip.focus();
    await userEvent.keyboard("p");
    const menu = await screen.findByRole("menu", { name: /^Plan / });
    const names = within(menu).getAllByRole("menuitemradio").map((i) => i.textContent ?? "");
    expect(names.length).toBeGreaterThan(0);
    // AUD (software): Claude ne è membro, quindi si assegna, ed è l'ultima voce.
    expect(names.at(-1)).toMatch(/Claude/);
  });

  it("il Planning di progetto è disponibile", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("troncato: l'avviso compare nel Planning e in La mia settimana", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.queryByText("Some tasks are missing from the load.")).toBeNull();
    cleanup();
    truncated.value = true;
    renderRoute("/planning");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
    cleanup();
    renderRoute("/home?view=week");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
  });

  it("troncato: l'avviso compare anche quando è troncata solo la vasca del Planning", async () => {
    signedInAs("p-laura");
    truncated.onlyFiltered = true;
    renderRoute("/p/AUD/planning");
    // Una frase sua: il carico è intero, mancano task da «To plan».
    expect(await screen.findByText("Some tasks are missing from To plan.")).toBeInTheDocument();
    expect(screen.queryByText("Some tasks are missing from the load.")).toBeNull();
  });

  it("la Timeline è disponibile", async () => {
    renderRoute("/p/AUD/tasks?view=timeline");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });
});

/** I blocchi delle aree non integrate (posta e calendario, automazioni, rilasci, assistenza). */
const FUTURE_BLOCKS = /^(Upcoming(?! milestones)|Important email|Automations|Releases|Customers waiting)/;

describe("le superfici della fetta 3 nella build app", () => {
  it("dopo il login si atterra sulla Home a blocchi", async () => {
    const router = renderRoute("/login");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /^Decide/ })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("l'indirizzo vuoto atterra sulla Home", async () => {
    const router = renderRoute("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
  });

  it("i blocchi delle aree non integrate non si mostrano e non leggono nulla, nemmeno l'extra «Releases»", async () => {
    // Laura può rilasciare e non ha personalizzato la Home: nel prototipo vede «Releases».
    signedInAs("p-laura");
    renderRoute("/home");
    expect(await screen.findByRole("region", { name: /^My week/ })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /^My tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: FUTURE_BLOCKS })).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("un blocco di un'area non integrata salvato nella Home personale non si mostra e non chiama nulla", async () => {
    signedInAs("p-marco");
    const { setPersonalHome } = await import("../data/api");
    await setPersonalHome([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "releases" },
      { kind: "automations" },
      { kind: "importantMail" },
      { kind: "myTasks" },
    ]);
    calls.length = 0;
    renderRoute("/home");
    expect(await screen.findByRole("region", { name: /^My tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: FUTURE_BLOCKS })).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("il catalogo dei blocchi non propone le aree non integrate", async () => {
    signedInAs("p-marco");
    renderRoute("/home");
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    const names = within(menu)
      .queryAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
    expect(names.some((n) => FUTURE_BLOCKS.test(n))).toBe(false);
    await settle();
    expect(outside()).toEqual([]);
  });

  it("«Da decidere» legge Claude (dalla 3b) ma non chat, posta né automazioni, e non resta in caricamento", async () => {
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    await waitFor(() => expect(decide.querySelector("[data-skeleton], [aria-busy='true']")).toBeNull());
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("listClaudeDecisions");
  });

  it("i filtri salvati: tutti i filtri e la pagina di un filtro", async () => {
    renderRoute("/filters");
    expect(await screen.findByRole("heading", { level: 1, name: "All filters" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    cleanup();
    renderRoute("/filters/flt-unassigned");
    expect(await screen.findByRole("heading", { level: 1, name: /Unassigned/ })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("La mia settimana resta raggiungibile da /home?view=week", async () => {
    renderRoute("/home?view=week");
    expect(await screen.findByRole("heading", { level: 1, name: "My week" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });
});

describe("le superfici della fetta 4 nella build app", () => {
  it("l'Overview è disponibile e legge solo ciò che è integrato", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("Requests: l'elenco e il dettaglio, senza letture di aree non integrate", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/requests");
    expect(await screen.findByRole("heading", { level: 1, name: "Requests" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    cleanup();
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    // Dalla fetta 3c (area 3) il refine con Claude è acceso.
    expect(await within(panel).findByRole("button", { name: "Refine with Claude" })).toBeEnabled();
    cleanup();
    // `?refine=1` apre la vista del refinement (fetta 3c), che legge la sessione della richiesta.
    renderRoute("/p/STW/requests?request=req-stw-1&refine=1");
    await waitFor(() => expect(calls).toContain("getRefineOf"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("Tutti i progetti è disponibile", async () => {
    signedInAs("p-laura");
    renderRoute("/projects");
    expect(await screen.findByRole("heading", { level: 1, name: "All projects" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("una richiesta fusa dall'intake: «Unita a R4», e si apre quella", async () => {
    signedInAs("p-laura");
    intake.mergeInto = "STW-R4";
    const router = renderRoute("/p/STW/requests?newRequest=STW");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    await userEvent.type(within(dialog).getByLabelText("What do you need?"), "Mute notifications at night");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      await screen.findByText("Merged into STW-R4: someone had already asked for this, and now you follow it."),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ request: "req-stw-4" }));
  });

  it("una richiesta accodata senza esito: «la stiamo registrando», il dialogo si chiude e niente «Riprova»", async () => {
    signedInAs("p-laura");
    intake.pending = true;
    renderRoute("/p/STW/requests?newRequest=STW");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    await userEvent.type(within(dialog).getByLabelText("What do you need?"), "Mute notifications at night");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      await screen.findByText("Received: we're still registering it. You'll find it in Requests."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New request" })).not.toBeInTheDocument());
    expect(screen.queryByText("Couldn't send the request. Nothing was sent; try again.")).not.toBeInTheDocument();
    expect(calls.filter((c) => c === "createRequest")).toHaveLength(1);
  });

  it("«Fondi in…»: l'attesa della riscrittura, e un errore con «Try again» che non ha cambiato nulla", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Merge into…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge into another request" });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /Quiet hours for notifications/ }));
    failNext("mergeRequest");
    setLatency(300);
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect(
      await within(dialog).findByText("Merging into STW-R4: Claude is rewriting it. This can take a moment."),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText("Couldn't merge the requests. Nothing changed.", {}, { timeout: 2000 })).toBeInTheDocument();
    setLatency(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Merge into another request" })).toBeNull());
  });

  it("oltre i 200 filtri il salvataggio lo dice con la sua frase", async () => {
    renderRoute("/p/AUD/tasks");
    await userEvent.click(await screen.findByRole("button", { name: "Save as filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as filter" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "One more");
    refusal.fn = "saveFilter";
    refusal.code = "too_many_filters";
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    expect(
      await within(dialog).findByText("You already have 200 saved filters. Delete one to save another."),
    ).toBeInTheDocument();
  });

  it("modifiche salvate ma suggerimenti non chiusi: il messaggio dice cosa è stato salvato", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    const box = await within(panel).findByRole("region", { name: "Suggested by the intake" });
    refusal.fn = "updateRequest";
    refusal.code = "suggestions_kept";
    await userEvent.click(within(box).getByRole("button", { name: "Dismiss" }));
    expect(
      await screen.findByText("Your changes were saved, but the suggestions are still open. Dismiss them again."),
    ).toBeInTheDocument();
  });

  it("trasformare una richiesta già trasformata o archiviata lo dice con la sua frase", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "Turn into task" }));
    const dialog = await screen.findByRole("dialog", { name: /New task/ });
    refusal.fn = "convertRequest";
    refusal.code = "request_not_convertible";
    await userEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(
      await within(dialog).findByText("This request has already been converted or archived."),
    ).toBeInTheDocument();
  });

  it("trasformare una richiesta che non vedi più lo dice con la sua frase", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "Turn into task" }));
    const dialog = await screen.findByRole("dialog", { name: /New task/ });
    refusal.fn = "convertRequest";
    refusal.code = "request_not_found";
    await userEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(
      await within(dialog).findByText("This request is no longer available: it may have been converted, archived or hidden."),
    ).toBeInTheDocument();
  });
});

describe("le superfici della fetta 3a nella build app (area 3)", () => {
  // Dalle fette 1–2 della chat la chat libera è integrata: /claude atterra su
  // «New conversation», con «Mine» nella colonna; le pubbliche restano «in arrivo».
  it("/claude atterra su «New conversation», con «Mine» e le sessioni dal vivo nella colonna", async () => {
    signedInAs("p-laura");
    renderRoute("/claude");
    expect(await screen.findByRole("heading", { level: 1, name: "New conversation" })).toBeInTheDocument();
    const column = screen.getByRole("navigation", { name: "Claude views" });
    expect(within(column).getByText("New conversation")).toBeInTheDocument();
    expect(within(column).getByText("Mine")).toBeInTheDocument();
    expect(within(column).getByText("Finished")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).not.toContain("getClaudeSuggestion");
  });

  // Dalla fetta 5 anche le pubbliche sono integrate: «Public» si legge.
  it("le pubbliche e le proprie si leggono, nessuna è «in arrivo»", async () => {
    signedInAs("p-laura");
    renderRoute("/claude?scope=public");
    await waitFor(() => expect(calls).toContain("listConversations"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
    cleanup();
    renderRoute("/claude?scope=mine");
    await waitFor(() => expect(calls).toContain("listConversations"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("una sessione di lavoro si apre e si legge dal vivo", async () => {
    signedInAs("p-marco");
    renderRoute("/claude/cv-run-aud-3");
    expect(await screen.findByText(/Task run/)).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("getConversation");
    expect(calls).toContain("subscribe");
  });
});

