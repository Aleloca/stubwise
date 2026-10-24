import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import type { ProjectPulse } from "../../data/types";
import { resetViewerGrants } from "../../data/viewer";
import { renderRoute } from "../../test/renderRoute";
import { pulseLine } from "./pulseLine";

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;
const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;

async function overview(code: string, personId: string) {
  const router = renderRoute(`/p/${code}/overview`, personId);
  expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
  // Le sezioni arrivano con i loro dati: si aspetta l'ultima, il registro.
  await screen.findByRole("heading", { level: 2, name: "Decision log" });
  return router;
}

/** Le righe della sezione «Stalled», nell'ordine in cui si vedono. */
async function stalledRows() {
  const list = await screen.findByRole("list", { name: "Stalled" });
  return [...list.querySelectorAll<HTMLElement>("[data-task-row]")];
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetViewerGrants());

describe("OverviewPage — Stalled", () => {
  it("un progetto senza ferme non mostra la sezione, né una frase al suo posto", async () => {
    await overview("GLT", "p-giulia");
    await screen.findByRole("heading", { level: 2, name: "What's open" });
    expect(screen.queryByRole("heading", { name: "Stalled" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Stalled" })).toBeNull();
  });

  it("con ferme: in cima, dalla più vecchia, con i giorni e il motivo vero", async () => {
    await overview("MKX", "p-giulia");
    const rows = await stalledRows();
    expect(rows.map((r) => r.getAttribute("data-task-row"))).toEqual([
      "MKX-5",
      "MKX-7",
      "MKX-8",
      "MKX-3",
      "MKX-9",
    ]);
    const row = (code: string) => rows.find((r) => r.getAttribute("data-task-row") === code)!;
    // Manuale: il motivo di chi l'ha segnata, con la nota.
    expect(row("MKX-5")).toHaveTextContent("6d");
    expect(row("MKX-5")).toHaveTextContent("Waiting on the client");
    expect(row("MKX-5")).toHaveTextContent("“Mix Cucine has to confirm");
    expect(row("MKX-7")).toHaveTextContent("Blocked by MKX-6");
    expect(row("MKX-8")).toHaveTextContent("Nobody assigned");
    expect(row("MKX-3")).toHaveTextContent("Waiting for Giulia's decision");
    // La sezione sta prima di «Where it stands».
    const stalled = screen.getByRole("heading", { level: 2, name: "Stalled" });
    const where = screen.getByRole("heading", { level: 2, name: "Where it stands" });
    expect(stalled.compareDocumentPosition(where) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dice «Claude asked a question» e «Nobody has touched it for N days» con la soglia del progetto", async () => {
    await overview("AUD", "p-roberta");
    const rows = await stalledRows();
    const row = (code: string) => rows.find((r) => r.getAttribute("data-task-row") === code)!;
    expect(row("AUD-6")).toHaveTextContent("Nobody has touched it for 13 days");
    expect(row("AUD-3")).toHaveTextContent("Claude asked a question");
    expect(rows[0]!.getAttribute("data-task-row")).toBe("AUD-6");
  });

  it("clic su una ferma apre la task nel pannello", async () => {
    const router = await overview("MKX", "p-giulia");
    const rows = await stalledRows();
    await userEvent.click(within(rows[0]!).getByRole("button"));
    await waitFor(() => expect(search(router).task).toBe("MKX-5"));
  });
});

describe("OverviewPage — ogni numero apre le Tasks filtrate", () => {
  it("con meno di sei ferme, il conteggio di «Stalled» apre le Tasks sulle ferme", async () => {
    const router = await overview("AUD", "p-giulia");
    expect(await stalledRows()).toHaveLength(4);
    expect(screen.queryByRole("link", { name: /^Show all/ })).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "4 stalled tasks: open the list" }));
    await waitFor(() => expect(path(router)).toBe("/p/AUD/tasks"));
    expect(search(router).filters).toEqual({ stalled: true });
  });

  it("«N stalled» nella riga di polso apre le Tasks sulle ferme", async () => {
    const router = await overview("MKX", "p-giulia");
    const pulse = document.querySelector<HTMLElement>("[data-pulse-line]")!;
    await userEvent.click(within(pulse).getByRole("link", { name: "5 stalled" }));
    await waitFor(() => expect(path(router)).toBe("/p/MKX/tasks"));
    expect(search(router).filters).toEqual({ stalled: true });
  });

  it("il totale di «What's open» apre le aperte", async () => {
    const router = await overview("AUD", "p-giulia");
    await userEvent.click(await screen.findByRole("link", { name: "9 open tasks: open the list" }));
    await waitFor(() => expect(path(router)).toBe("/p/AUD/tasks"));
    expect(search(router).filters).toEqual({ families: ["todo", "active"] });
  });

  it("la nota di una ferma manuale è nel nome accessibile della riga", async () => {
    await overview("MKX", "p-giulia");
    const rows = await stalledRows();
    const row = rows.find((r) => r.getAttribute("data-task-row") === "MKX-5")!;
    expect(within(row).getByRole("button")).toHaveAccessibleName(
      /Waiting on the client · 6 days · “Mix Cucine has to confirm/,
    );
  });
});

describe("OverviewPage — Where it stands", () => {
  it("l'avanzamento di un traguardo con task senza stima lo dichiara", async () => {
    await overview("AUD", "p-giulia");
    const list = await screen.findByRole("list", { name: "Open milestones" });
    const launch = list.querySelector<HTMLElement>('[data-milestone-row="ms-aud-2"]')!;
    expect(launch).toHaveTextContent("Public launch");
    expect(launch).toHaveTextContent("1 without estimate");
    expect(within(launch).getByRole("img")).toHaveAccessibleName(
      /^Public launch: \d+% of the estimated work closed$/,
    );
    // Il peso non compare mai come numero a schermo.
    expect(launch.textContent).not.toMatch(/%/);
  });

  it("il brief è etichettato «Generated text»; senza brief lo dice", async () => {
    await overview("AUD", "p-giulia");
    const card = document.querySelector<HTMLElement>("[data-brief-card]")!;
    await waitFor(() => expect(card).toHaveTextContent("Generated text"));
    expect(card).toHaveTextContent("Public launch is four weeks out");
  });

  it("senza brief: «No brief yet · The first one arrives on Monday»", async () => {
    await overview("GLT", "p-giulia");
    const card = document.querySelector<HTMLElement>("[data-brief-card]")!;
    await waitFor(() =>
      expect(card).toHaveTextContent("No brief yet · The first one arrives on Monday"),
    );
    expect(card).not.toHaveTextContent("Generated text");
  });

  it("«Read the brief» apre il pannello di lettura, con «Generated text» in testa", async () => {
    const router = await overview("STW", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: "Read the brief" }));
    await waitFor(() => expect(search(router).brief).toBe("brief-stw-2026-10-19"));
    const panel = await screen
      .findByRole("region", { name: "Weekly brief" })
      .catch(() => screen.findByRole("dialog", { name: "Weekly brief" }));
    expect(await within(panel).findByText("What's blocking")).toBeInTheDocument();
    expect(within(panel).getByText("Generated text")).toBeInTheDocument();
  });

  it("«Copy as text» copia il brief senza markdown, col periodo e «Generated text»", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => (writes.push(s), Promise.resolve()) },
    });
    try {
      await overview("AUD", "p-giulia");
      const card = document.querySelector<HTMLElement>("[data-brief-card]")!;
      await userEvent.click(await within(card).findByRole("button", { name: "Copy as text" }));
      await waitFor(() => expect(writes).toHaveLength(1));
      const text = writes[0]!;
      expect(text.startsWith("Weekly brief · Week of")).toBe(true);
      expect(text).toContain("Generated text");
      expect(text).toContain("Public launch is four weeks out");
      expect(text).not.toMatch(/^#/m);
      expect(text).not.toContain("**");
      expect(await screen.findByText("Brief copied as text.")).toBeInTheDocument();
      // Il segno «Generated text» resta sulla carta.
      expect(card).toHaveTextContent("Generated text");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("«Copy as text» c'è anche nel pannello di lettura; se gli appunti mancano lo dice", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    try {
      await overview("STW", "p-giulia");
      await userEvent.click(await screen.findByRole("button", { name: "Read the brief" }));
      const panel = await screen
        .findByRole("region", { name: "Weekly brief" })
        .catch(() => screen.findByRole("dialog", { name: "Weekly brief" }));
      await within(panel).findByText("What's blocking");
      await userEvent.click(within(panel).getByRole("button", { name: "Copy as text" }));
      expect(
        await screen.findByText(
          "Couldn't copy the brief. Open it and select the text to copy it by hand.",
        ),
      ).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("solo traguardi chiusi: «No open milestones»", async () => {
    for (const m of state.milestones) if (m.projectId === "prj-mkx") m.closed = true;
    await overview("MKX", "p-giulia");
    expect(await screen.findByText("No open milestones")).toBeInTheDocument();
    expect(screen.queryByText("No milestones")).toBeNull();
  });

  it("«Manage milestones» solo con tickets.edit", async () => {
    await overview("AUD", "p-giulia");
    await screen.findByRole("list", { name: "Open milestones" });
    expect(screen.queryByRole("button", { name: "Manage milestones" })).toBeNull();
  });

  it("chiudere un traguardo da «Manage milestones» lo toglie dagli aperti", async () => {
    await overview("MKX", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: "Manage milestones" }));
    const dialog = await screen.findByRole("dialog", { name: "Milestones" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Actions for Showroom event" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Close milestone" }));
    await waitFor(() =>
      expect(state.milestones.find((m) => m.id === "ms-mkx-2")!.closed).toBe(true),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const list = await screen.findByRole("list", { name: "Open milestones" });
    await waitFor(() => expect(list).not.toHaveTextContent("Showroom event"));
  });
});

describe("OverviewPage — What's open", () => {
  it("clic su «N in progress» apre le Tasks filtrate sulla famiglia active", async () => {
    const router = await overview("AUD", "p-giulia");
    // La riga ha il suo nome; il riassunto accanto al titolo un altro, distinto.
    expect(
      await screen.findByRole("link", { name: "4 in progress: open the list" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "4 in progress" }));
    await waitFor(() => expect(path(router)).toBe("/p/AUD/tasks"));
    expect(search(router).filters).toEqual({ families: ["active"] });
  });

  it("per persona: il numero apre le aperte di quella persona", async () => {
    const router = await overview("MKX", "p-giulia");
    await userEvent.click(
      await screen.findByRole("link", { name: /^Paolo Gatti: \d+ open tasks?$/ }),
    );
    await waitFor(() => expect(path(router)).toBe("/p/MKX/tasks"));
    expect(search(router).filters).toEqual({
      assigneeIds: ["p-paolo"],
      families: ["todo", "active"],
    });
  });
});

describe("OverviewPage — Timeline e registro decisioni", () => {
  it("il filtro per tipo lascia solo le pull request", async () => {
    await overview("STW", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: /^Type:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Pull requests" }));
    const events = [...document.querySelectorAll("[data-timeline-event]")].map((e) =>
      e.getAttribute("data-timeline-event"),
    );
    expect(events.length).toBeGreaterThan(0);
    for (const k of events) expect(k).toMatch(/^pr_/);
  });

  it("«Record a decision» non c'è senza decisions.record", async () => {
    await overview("AUD", "p-giulia");
    await screen.findByRole("list", { name: "Decision log" });
    expect(screen.queryByRole("button", { name: "Record a decision" })).toBeNull();
  });

  it("con il permesso: la decisione registrata entra nel registro, a nome di chi scrive", async () => {
    await overview("MKX", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: "Record a decision" }));
    const dialog = await screen.findByRole("dialog", { name: "Record a decision" });
    await userEvent.type(within(dialog).getByLabelText("Title"), "No print ads in May");
    await userEvent.type(
      within(dialog).getByLabelText("Decision"),
      "The May budget goes to social.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    const list = await screen.findByRole("list", { name: "Decision log" });
    await waitFor(() => expect(list).toHaveTextContent("No print ads in May"));
    const first = list.querySelector<HTMLElement>("[data-decision]")!;
    expect(first).toHaveTextContent("Giulia Ferri");
    expect(first).toHaveTextContent("Recorded by hand");
    expect(first).not.toHaveTextContent("Generated text");
  });

  it("una voce superata lo dice, con il titolo di quella che l'ha cambiata", async () => {
    await overview("MKX", "p-giulia");
    const list = await screen.findByRole("list", { name: "Decision log" });
    const old = list.querySelector<HTMLElement>('[data-decision="dl-mkx-1"]');
    // Oltre le prime cinque: si espande.
    if (!old)
      await userEvent.click(within(list.parentElement!).getByRole("button", { name: /^Show/ }));
    const row = document.querySelector<HTMLElement>('[data-decision="dl-mkx-1"]')!;
    expect(row).toHaveTextContent("Superseded by “Kitchens and living get separate creatives”");
  });

  it("«Superseded by» si cambia dal menu della voce; «None» la rende di nuovo valida", async () => {
    await overview("MKX", "p-giulia");
    const list = await screen.findByRole("list", { name: "Decision log" });
    const row = await waitFor(() => list.querySelector<HTMLElement>('[data-decision="dl-mkx-2"]')!);
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for “Print stays in the media plan”" }),
    );
    const menu = await screen.findByRole("menu", {
      name: "Actions for “Print stays in the media plan”",
    });
    expect(within(menu).getByRole("menuitemradio", { name: "None, still valid" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Sé stessa non c'è.
    expect(
      within(menu).queryByRole("menuitemradio", { name: "Print stays in the media plan" }),
    ).toBeNull();
    await userEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Restart from the showroom newsletter" }),
    );
    await waitFor(() =>
      expect(row).toHaveTextContent("Superseded by “Restart from the showroom newsletter”"),
    );
    expect(state.decisionLog.find((d) => d.id === "dl-mkx-2")!.supersededById).toBe("dl-mkx-4");

    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for “Print stays in the media plan”" }),
    );
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "None, still valid" }));
    await waitFor(() => expect(row).not.toHaveTextContent("Superseded"));
  });

  it("il menu della voce non offre le voci che chiuderebbero un giro", async () => {
    await overview("MKX", "p-giulia");
    const list = await screen.findByRole("list", { name: "Decision log" });
    const row = await waitFor(() => list.querySelector<HTMLElement>('[data-decision="dl-mkx-3"]')!);
    await userEvent.click(
      within(row).getByRole("button", { name: /^Actions for “Kitchens and living/ }),
    );
    const menu = await screen.findByRole("menu", { name: /^Actions for “Kitchens and living/ });
    // dl-mkx-1 è superata da dl-mkx-3: non può a sua volta superarla.
    expect(
      within(menu).queryByRole("menuitemradio", { name: "One campaign line for kitchens and living" }),
    ).toBeNull();
  });

  it("senza decisions.record nessun menu sulle voci", async () => {
    await overview("AUD", "p-giulia");
    const list = await screen.findByRole("list", { name: "Decision log" });
    await waitFor(() => expect(list.querySelector("[data-decision]")).not.toBeNull());
    expect(within(list).queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("un cambio non riuscito lo dice e lascia il registro com'era", async () => {
    await overview("MKX", "p-giulia");
    failNext("setDecisionSuperseded");
    const list = await screen.findByRole("list", { name: "Decision log" });
    const row = await waitFor(() => list.querySelector<HTMLElement>('[data-decision="dl-mkx-2"]')!);
    await userEvent.click(within(row).getByRole("button", { name: /^Actions for/ }));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "Restart from the showroom newsletter" }),
    );
    expect(
      await screen.findByText("Couldn't change it. The decision log is as it was."),
    ).toBeInTheDocument();
    expect(state.decisionLog.find((d) => d.id === "dl-mkx-2")!.supersededById).toBeNull();
  });

  it("un errore del registro resta nel registro: le ferme ci sono comunque", async () => {
    failNext("listDecisionLog");
    renderRoute("/p/MKX/overview", "p-giulia");
    expect(await screen.findByText("Couldn't load Decision log.")).toBeInTheDocument();
    expect(await stalledRows()).toHaveLength(5);
  });
});

describe("pulseLine", () => {
  const base: ProjectPulse = {
    projectId: "prj-x",
    open: { todo: 1, active: 1 },
    stalled: 0,
    waitingOnMe: false,
    claudeWorking: false,
    nextMilestone: null,
  };
  const t = i18n.getFixedT("en");

  it("mette in fila aspetta-te, Claude, ferme, prossimo traguardo", () => {
    expect(
      pulseLine(
        {
          ...base,
          waitingOnMe: true,
          claudeWorking: true,
          stalled: 3,
          nextMilestone: {
            id: "m",
            projectId: "prj-x",
            name: "Launch",
            description: "",
            dueDate: "2026-11-14",
            closed: false,
          },
        },
        t,
        "en",
      ),
    ).toBe("Waiting on you · Claude working · 3 stalled · next: Launch · Nov 14");
  });

  it("un progetto quieto ha una frase sola", () => {
    expect(pulseLine(base, t, "en")).toBe("Nothing waiting, nothing stalled");
  });
});
