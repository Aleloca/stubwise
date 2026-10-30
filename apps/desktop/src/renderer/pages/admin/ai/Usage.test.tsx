import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AI_OPERATIONS } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../../data/api";
import type { UsageRecord } from "../../../data/instance/state";
import { state } from "../../../data/store";
import { grantInstancePermission, type LocalInstancePermission } from "../../../data/viewer";
import i18n from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// La scheda Usage della voce AI (area 9b, Task 9, shape admin-ai.md «Usage»):
// periodo nell'indirizzo, totali, serie per giorno (leggibile senza colore:
// al passaggio e in tabella), tabella per dimensione con i figli, R-G5.
// `now()` è fermo al 23 ott 2026; i consumi sono un seme piccolo contato a
// mano (lo stesso di `data/instance/usage.test.ts`). Roberta è full admin;
// Sara è User (vede STW, non AUD né MKX) e le si dà `usage.view`.

const ROBERTA = "p-roberta";
const SARA = "p-sara";

let n = 0;
const rec = (over: Partial<UsageRecord> & Pick<UsageRecord, "at" | "costUsd">): UsageRecord => ({
  id: `u-${++n}`,
  operation: "fix_execute",
  model: "claude-sonnet-4-5",
  projectId: "prj-stw",
  providerId: "prv-team-max",
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 5000,
  conversationId: null,
  ...over,
});

/** 7gg: dal 17 ott; 30gg: dal 24 set; 90gg: dal 26 lug; il mese: dall'1 ott. */
const SMALL: UsageRecord[] = [
  rec({ at: "2026-10-23T09:00:00Z", costUsd: 1.5 }),
  rec({
    at: "2026-10-20T09:00:00Z",
    costUsd: 2.25,
    projectId: "prj-aud",
    operation: "fix_plan",
    model: "claude-opus-4-5",
    providerId: "prv-billing-key",
  }),
  rec({ at: "2026-10-10T09:00:00Z", costUsd: 0.5, operation: "chat", model: "claude-haiku-4-5" }),
  rec({ at: "2026-09-30T09:00:00Z", costUsd: 0.25, projectId: "prj-mkx" }),
  rec({ at: "2026-10-17T09:00:00Z", costUsd: 0.125, projectId: null, operation: "mail_classify" }),
  rec({ at: "2026-09-20T09:00:00Z", costUsd: 4, projectId: "prj-aud" }),
  rec({ at: "2026-08-10T09:00:00Z", costUsd: 8 }),
  rec({ at: "2026-07-01T09:00:00Z", costUsd: 16 }),
];

beforeEach(() => {
  setLatency(0);
  resetApi();
  state.instance.usage = SMALL.map((r) => ({ ...r }));
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  cleanup();
  resetApi();
  await i18n.changeLanguage("en");
});

const panel = () => screen.getByTestId("usage-panel");
/** Il valore di un totale, dalla sua etichetta. */
const total = (label: string) =>
  within(screen.getByRole("list", { name: "Totals" }))
    .getByText(label)
    .closest("li")!
    .querySelector("[data-total]")!.textContent;
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, unknown>;
async function ready() {
  await screen.findByRole("list", { name: "Totals" });
}

describe("il periodo", () => {
  it("di base 30 giorni; 7, 90, il mese e un intervallo libero stanno nell'indirizzo", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/ai?tab=usage", ROBERTA);
    await ready();
    const period = screen.getByRole("radiogroup", { name: "Period" });
    expect(within(period).getByRole("radio", { name: "Last 30 days" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(total("Cost")).toBe("$4.63");

    await user.click(within(period).getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(search(router)).toMatchObject({ range: "7d" }));
    await waitFor(() => expect(total("Cost")).toBe("$3.88"));

    await user.click(within(period).getByRole("radio", { name: "Last 90 days" }));
    await waitFor(() => expect(search(router)).toMatchObject({ range: "90d" }));
    await waitFor(() => expect(total("Cost")).toBe("$16.63"));

    await user.click(within(period).getByRole("radio", { name: "This month" }));
    await waitFor(() => expect(search(router)).toMatchObject({ range: "month" }));
    await waitFor(() => expect(total("Cost")).toBe("$4.38"));

    await user.click(within(period).getByRole("radio", { name: "Custom…" }));
    await waitFor(() =>
      expect(search(router)).toMatchObject({
        range: "custom",
        from: "2026-09-24",
        to: "2026-10-23",
      }),
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-10" } });
    await waitFor(() => expect(search(router)).toMatchObject({ from: "2026-10-10" }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-17" } });
    await waitFor(() => expect(search(router)).toMatchObject({ to: "2026-10-17" }));
    await waitFor(() => expect(total("Cost")).toBe("$0.63"));
  });

  it("un intervallo libero scritto nell'indirizzo si riapre com'era", async () => {
    renderRoute("/admin/ai?tab=usage&range=custom&from=2026-10-10&to=2026-10-17", ROBERTA);
    await ready();
    expect(screen.getByRole("radio", { name: "Custom…" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("From")).toHaveValue("2026-10-10");
    expect(screen.getByLabelText("To")).toHaveValue("2026-10-17");
    expect(total("Cost")).toBe("$0.63");
    expect(total("Runs")).toBe("2");
  });
});

describe("totali e serie per giorno", () => {
  it("cinque totali", async () => {
    renderRoute("/admin/ai?tab=usage&range=7d", ROBERTA);
    await ready();
    expect(total("Cost")).toBe("$3.88");
    expect(total("Runs")).toBe("3");
    expect(total("Input tokens")).toBe("3,000");
    expect(total("Output tokens")).toBe("300");
    expect(total("Cache read")).toBe("15,000");
  });

  it("la serie si legge senza colore: al passaggio, da tastiera e in tabella", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=usage&range=7d", ROBERTA);
    await ready();
    const chart = screen.getByRole("group", { name: "Cost per day" });
    // Al passaggio su una colonna: data, costo, corse.
    fireEvent.mouseEnter(chart.querySelector('[data-day="2026-10-20"]')!);
    expect(within(chart).getByText("Oct 20 · $2.25 · 1 run")).toBeVisible();
    // Da tastiera: col fuoco sul grafico, ←/→ e Home/End.
    chart.focus();
    await user.keyboard("{End}");
    expect(within(chart).getByText("Oct 23 · $1.50 · 1 run")).toBeVisible();
    await user.keyboard("{ArrowLeft}");
    expect(within(chart).getByText("Oct 22 · $0.00 · 0 runs")).toBeVisible();
    // In tabella: giorno · costo · corse.
    await user.click(screen.getByRole("button", { name: "Show as table" }));
    const table = screen.getByRole("table", { name: "Cost per day" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toContainEqual(["Oct 20", "$2.25", "1"]);
  });

  it("vuoto: la frase, i totali a zero, nessun grafico né tabella", async () => {
    renderRoute("/admin/ai?tab=usage&range=custom&from=2026-06-01&to=2026-06-10", ROBERTA);
    await ready();
    expect(screen.getByText("No AI usage in this period.")).toBeVisible();
    expect(total("Cost")).toBe("$0.00");
    expect(screen.queryByRole("group", { name: "Cost per day" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("errore: la frase e Retry", async () => {
    const user = userEvent.setup();
    failNext("instance.getUsage");
    renderRoute("/admin/ai?tab=usage", ROBERTA);
    expect(await screen.findByText("Couldn't load the usage.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /retry|try again/i }));
    await ready();
    expect(total("Cost")).toBe("$4.63");
  });
});

describe("la tabella per dimensione", () => {
  it("di base per progetto: codice e nome, «No project», ordine per costo", async () => {
    renderRoute("/admin/ai?tab=usage&range=90d", ROBERTA);
    await ready();
    const table = screen.getByRole("table", { name: "Usage by project" });
    const names = within(table)
      .getAllByRole("rowheader")
      .map((c) => c.textContent);
    expect(names).toEqual([
      "STW · Stubwise",
      "AUD · Audin 2.0",
      "MKX · Campagne primavera Mix Cucine",
      "No project",
    ]);
    const stw = within(table).getAllByRole("row")[1]!;
    expect(
      within(stw)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["$10.00", "3,300", "3"]);
  });

  it("due dimensioni: ▸ apre i figli in posto, e la scelta sta nell'indirizzo", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/ai?tab=usage&range=90d", ROBERTA);
    await ready();
    await user.selectOptions(screen.getByLabelText("Group by"), "model");
    await waitFor(() => expect(search(router)).toMatchObject({ group: "model" }));
    await user.selectOptions(screen.getByLabelText("then by"), "operation");
    await waitFor(() =>
      expect(search(router)).toMatchObject({ group: "model", then: "operation" }),
    );
    const table = await screen.findByRole("table", { name: "Usage by model, then by operation" });
    expect(within(table).queryByText("Chats with Claude")).toBeNull();
    const toggle = within(table).getByRole("button", { name: "Haiku 4.5" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(table).getByText("Chats with Claude")).toBeVisible();
    await user.click(within(table).getByRole("button", { name: "Sonnet 4.5" }));
    expect(within(table).getByText("Fix execution")).toBeVisible();
    // L'indirizzo con le due dimensioni riapre la stessa vista.
    cleanup();
    renderRoute("/admin/ai?tab=usage&range=90d&group=model&then=operation", ROBERTA);
    expect(
      await screen.findByRole("table", { name: "Usage by model, then by operation" }),
    ).toBeVisible();
  });
});

describe("R-G5: chi non vede tutto", () => {
  it("Sara con usage.view: «Other projects» in fondo, nessun codice d'altri nel DOM (RF 2)", async () => {
    const user = userEvent.setup();
    grantInstancePermission(SARA, "usage.view" as LocalInstancePermission);
    renderRoute("/admin/ai?tab=usage&range=90d", SARA);
    await ready();
    const table = screen.getByRole("table", { name: "Usage by project" });
    const names = within(table)
      .getAllByRole("rowheader")
      .map((c) => c.textContent);
    expect(names.at(-1)).toBe("Other projectsProjects you can't see, added together.");
    expect(names[0]).toBe("STW · Stubwise");
    const leak = () => {
      const html = document.body.innerHTML;
      for (const s of ["prj-aud", "prj-mkx", "Audin", "Campagne primavera"])
        expect(html, s).not.toContain(s);
      for (const code of ["AUD", "MKX"]) expect(panel().textContent, code).not.toContain(code);
    };
    leak();
    // Anche con le altre dimensioni e i figli aperti.
    await user.selectOptions(screen.getByLabelText("Group by"), "model");
    await user.selectOptions(screen.getByLabelText("then by"), "project");
    const byModel = await screen.findByRole("table", { name: "Usage by model, then by project" });
    for (const b of within(byModel).getAllByRole("button")) await user.click(b);
    expect(within(byModel).getAllByText("Other projects").length).toBeGreaterThan(0);
    leak();
  });
});

describe("i nomi delle operazioni", () => {
  it("ogni operazione ha il suo nome in en e it", () => {
    for (const lng of ["en", "it"]) {
      const names = new Set<string>();
      for (const op of AI_OPERATIONS) {
        const key = `usage.operations.${op}`;
        expect(i18n.exists(key, { lng }), `${lng}: ${op}`).toBe(true);
        names.add(i18n.t(key, { lng }));
      }
      expect(names.size, lng).toBe(AI_OPERATIONS.length);
    }
    // Anche le tecniche hanno un nome di persona (shape admin-ai.md).
    expect(i18n.t("usage.operations.plugin_smoke", { lng: "en" })).toBe("Plugin smoke tests");
    expect(i18n.t("usage.operations.plugin_smoke", { lng: "it" })).toBe("Smoke test dei plugin");
    expect(i18n.t("usage.operations.credential_test", { lng: "en" })).toBe("Account tests");
    expect(i18n.t("usage.operations.credential_test", { lng: "it" })).toBe("Prove degli account");
    expect(i18n.t("usage.operations.usage_probe", { lng: "en" })).toBe("Quota readings");
    expect(i18n.t("usage.operations.usage_probe", { lng: "it" })).toBe("Letture della quota");
  });

  it("in italiano la tabella per operazione usa i nomi italiani", async () => {
    await i18n.changeLanguage("it");
    renderRoute("/admin/ai?tab=usage&range=7d&group=operation", ROBERTA);
    const table = await screen.findByRole("table", { name: "Consumi per operazione" });
    expect(within(table).getByText("Piano della correzione")).toBeVisible();
    expect(within(table).getByText("Classificazione della posta")).toBeVisible();
  });
});
