import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releases as releasesApi, resetApi, setLatency } from "../../data/api";
import { FAILED_LOG_LINES } from "../../data/seed/releases/releases";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { grantProjectRole, resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { expectNoDeploy } from "../../test/noDeploy";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { LOG_TAIL } from "./RunLog";

// Il dettaglio di un rilascio (Task 8, shape releases.md §6): «Now» col
// punto in cui è fallito, «Fai sistemare a Claude» (una sola task), il log
// lungo, lo stato non disponibile, i «Simula» e R-G5.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

const release = (code: string) => state.releases.find((r) => r.code === code)!;

async function openRelease(code: string, person = "p-laura") {
  const router = renderRoute(`/p/${code.split("-")[0]}/releases/${code}`, person);
  await screen.findByRole("region", { name: "Now" });
  return router;
}

describe("Release detail — fallito", () => {
  it("la frase prima del log: dove è fallito, le due azioni e la riga-confine", async () => {
    await openRelease("AUD-V3");
    const now = screen.getByRole("region", { name: "Now" });
    expect(
      within(now).getByText("Failed at “Run migrations” in “Deploy to production”"),
    ).toBeInTheDocument();
    expect(within(now).getByRole("button", { name: "Fix it with Claude" })).toBeInTheDocument();
    expect(within(now).getByRole("button", { name: "Ask Claude to explain" })).toBeInTheDocument();
    expect(
      within(now).getByText(
        "Stubwise doesn't re-run pipelines. Fix the cause, merge the fix: it becomes a new release.",
      ),
    ).toBeInTheDocument();
    // «Now» viene prima del log nel documento.
    const log = screen.getByRole("region", { name: /^Log of Deploy to production/ });
    expect(now.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectNoDeploy();
    act(() => setLanguage("it"));
    await screen.findByRole("region", { name: "Adesso" });
    expectNoDeploy();
  });

  it("log da 5000 righe: si apre con le ultime 40; «Show all» disegna solo una finestra, in fondo", async () => {
    await openRelease("AUD-V3");
    const log = screen.getByRole("region", { name: /^Log of Deploy to production, 5,012 lines/ });
    expect(within(log).getByText("Last 40 of 5,012 lines")).toBeInTheDocument();
    expect(log.querySelectorAll("[data-log-line]")).toHaveLength(LOG_TAIL);
    expect(log.querySelector(`[data-log-line="${FAILED_LOG_LINES}"]`)).not.toBeNull();

    const started = performance.now();
    await userEvent.click(within(log).getByRole("button", { name: "Show all" }));
    // Non blocca: si disegnano pochi blocchi, non 5000 righe; l'ultima c'è.
    const drawn = log.querySelectorAll("[data-log-line]").length;
    expect(drawn).toBeGreaterThan(LOG_TAIL);
    expect(drawn).toBeLessThanOrEqual(400);
    expect(log.querySelector(`[data-log-line="${FAILED_LOG_LINES}"]`)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);

    // «Find in log»: le corrispondenze in tutto il log, non solo nella finestra.
    await userEvent.click(within(log).getByRole("button", { name: "Find in log" }));
    await userEvent.type(within(log).getByRole("searchbox", { name: "Find in log" }), "chunk 1:");
    expect(within(log).getByText("1 of 1")).toBeInTheDocument();
    await waitFor(() => expect(log.querySelector("[data-log-line='53']")).not.toBeNull());
    expect(log.querySelector("[data-log-match]")).not.toBeNull();

    await userEvent.click(within(log).getByRole("button", { name: "Show less" }));
    expect(log.querySelectorAll("[data-log-line]")).toHaveLength(LOG_TAIL);
  });

  it("senza repos.view il log non c'è, il passo fallito resta", async () => {
    grantProjectRole("p-elena", "prj-aud", "contributor");
    await openRelease("AUD-V3", "p-elena");
    expect(screen.getByText("Run migrations")).toBeInTheDocument();
    expect(
      screen.getByText("The log is visible to people who can see AUD's code."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Log of/ })).toBeNull();
  });

  it("«Fai sistemare» due volte apre la stessa task", async () => {
    await openRelease("AUD-V3");
    await userEvent.click(screen.getByRole("button", { name: "Fix it with Claude" }));
    const dialog = await screen.findByRole("dialog", { name: "Fix AUD-V3 with Claude" });
    expect(
      within(dialog).getByText("Fix release AUD-V3: Invoices with the VAT number"),
    ).toBeInTheDocument();
    // Nel frattempo qualcun altro (o un altro clic) l'ha già chiesto.
    setSessionPersonId("p-laura");
    const first = await releasesApi.fixRelease("AUD-V3");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Anything Claude should know?" }),
      "Backfill first",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create task and start Claude" }),
    );
    // Non «created»: era già in riparazione, e la nota diventa un commento della task.
    expect(
      await screen.findByText(
        `Already being fixed in ${first.code}: your note was added as a comment`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(`${first.code} created`)).toBeNull();
    expect(
      state.tasks.filter((t) => t.releaseRef?.releaseId === release("AUD-V3").id),
    ).toHaveLength(1);
    expect(
      state.activity.some(
        (a) => a.taskId === first.id && a.kind === "comment" && a.body === "Backfill first",
      ),
    ).toBe(true);
    const now = screen.getByRole("region", { name: "Now" });
    expect(
      await within(now).findByText(`Claude is fixing it in ${first.code}`),
    ).toBeInTheDocument();
    expect(within(now).queryByRole("button", { name: "Fix it with Claude" })).toBeNull();
  });

  it("Marco (runs.start, senza plans.approve) legge il gate del piano; la nota entra nella task", async () => {
    await openRelease("AUD-V3", "p-marco");
    await userEvent.click(screen.getByRole("button", { name: "Fix it with Claude" }));
    const dialog = await screen.findByRole("dialog", { name: "Fix AUD-V3 with Claude" });
    expect(within(dialog).getByText(/Claude will write a plan first/)).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Anything Claude should know?" }),
      "Backfill first",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create task and start Claude" }),
    );
    await waitFor(() => expect(release("AUD-V3").fixTaskId).not.toBeNull());
    expect(state.tasksById.get(release("AUD-V3").fixTaskId!)!.description).toContain(
      "Backfill first",
    );
  });
});

describe("Release detail — stato non disponibile", () => {
  function unavailable() {
    const r = release("AUD-V3");
    r.runs = [];
    state.environments.find((e) => e.id === "env-aud-prod")!.serverCode = null;
  }

  it("con environments.manage: il link agli ambienti", async () => {
    unavailable();
    await openRelease("AUD-V3");
    const now = screen.getByRole("region", { name: "Now" });
    expect(
      within(now).getByText("The production environment has no server linked"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(now).getByRole("link", { name: "Set up environments" })).toBeInTheDocument(),
    );
  });

  it("senza environments.manage: la frase, nessun link", async () => {
    unavailable();
    await openRelease("AUD-V3", "p-elena");
    const now = screen.getByRole("region", { name: "Now" });
    await within(now).findByText(/Someone who manages AUD's environments/);
    expect(within(now).queryByRole("link", { name: "Set up environments" })).toBeNull();
  });
});

describe("Release detail — prototipo e R-G5", () => {
  it("ogni «Simula» sta nel riquadro «Prototype only», e simula un esito, non un avvio", async () => {
    renderRoute("/p/STW/releases/STW-V2", "p-laura");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(within(now).getByText("Not in production yet")).toBeInTheDocument();
    const box = await screen.findByRole("region", { name: "Prototype only" });
    expect(within(box).getByText(/They don't start anything\./)).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /^Simulate/ })) {
      expect(b.closest("[data-prototype-only]")).not.toBeNull();
    }
    await userEvent.click(
      within(box).getByRole("button", { name: "Simulate the commit appearing on SRV-2" }),
    );
    expect(await within(now).findByText(/^In production since/)).toBeInTheDocument();
  });

  it("AUD-V99 e un rilascio che non si vede dicono la stessa cosa", async () => {
    renderRoute("/p/AUD/releases/AUD-V99", "p-laura");
    expect(
      await screen.findByRole("heading", {
        name: "This release doesn't exist or you can't see it.",
      }),
    ).toBeInTheDocument();
    document.body.innerHTML = "";
    renderRoute("/p/AUD/releases/AUD-V3", "p-sara");
    expect(
      await screen.findByRole("heading", {
        name: "This release doesn't exist or you can't see it.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invoices with the VAT number")).toBeNull();
  });
});
