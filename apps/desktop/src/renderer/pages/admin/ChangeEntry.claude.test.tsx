import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import type { ChangeEntry as StoredChange, ChangeEntryView } from "../../data/changelog/types";
import { daysFromToday } from "../../data/dates";
import { CLAUDE_SEED_TIMES } from "../../data/seed/claudeActions";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n, { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { ChangeEntry } from "./ChangeEntry";

// «Claude on behalf of» nel registro (area 10a, Task 11; shape claude-trace.md).
// La voce scritta da Claude per una persona è la frase di sempre, col solo
// nome di chi agisce sostituito dal prefisso; la voce di un «Annulla» è
// l'inversa col prefisso più la riga «Undid: … · data» ([CT 4]); il filtro
// «Made with Claude» c'è solo per chi legge almeno una voce col segno.
//
// Seme (Task 7): Giulia spegne con Claude il brief di MKX (chg-seed-claude-1),
// poi annulla (chg-seed-claude-2, `undoOf`), poi Roberta lo rispegne a mano
// (chg-seed-claude-3). Roberta è full admin; Laura (Project Lead in ACQ) non
// legge le voci di MKX.

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const GIULIA = "p-giulia";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const entryById = (id: string) =>
  document.querySelector<HTMLElement>(`[data-change-id="${id}"]`);
/** Le righe di una voce (frase, prima/dopo, «Undid:»), separate da « | ». */
const linesOf = (el: HTMLElement) =>
  [...el.querySelectorAll("p")].map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ");

/** «Nov 1, 09:42»: giorno e ora come li scrive il registro (UTC, l'orologio del prototipo). */
const dayTime = (iso: string, language: string) =>
  new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));

async function openAdminLog(personId: string, query = "") {
  const router = renderRoute(`/admin/changelog${query}`, personId);
  await screen.findByRole("heading", { level: 1, name: "Change log" });
  return router;
}

describe("la voce del seme", () => {
  it("si legge «Claude on behalf of Giulia Ferri …» col prima e dopo, in en e in it", async () => {
    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entryById("chg-seed-claude-1")).not.toBeNull());
    const first = entryById("chg-seed-claude-1")!;
    expect(linesOf(first)).toBe(
      "Claude on behalf of Giulia Ferri turned off the weekly brief in MKX. | Weekly brief: On → Off",
    );
    // L'anello fermo sotto l'ora, col suo nome per chi non vede ([CT 3]).
    expect(within(first).getByRole("img", { name: "Made with Claude" })).toBeInTheDocument();

    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(linesOf(entryById("chg-seed-claude-1")!)).toBe(
        "Claude per conto di Giulia Ferri ha spento il brief settimanale in MKX. | Brief settimanale: Acceso → Spento",
      ),
    );
    expect(
      within(entryById("chg-seed-claude-1")!).getByRole("img", { name: "Fatta con Claude" }),
    ).toBeInTheDocument();
  });

  it("l'inversa ha il suo prima e dopo e sotto «Undid: …» con la data della voce annullata", async () => {
    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entryById("chg-seed-claude-2")).not.toBeNull());
    const when = dayTime(CLAUDE_SEED_TIMES.brief.run, "en");
    expect(linesOf(entryById("chg-seed-claude-2")!)).toBe(
      "Claude on behalf of Giulia Ferri turned on the weekly brief in MKX. | Weekly brief: Off → On | " +
        `Undid: Claude on behalf of Giulia Ferri turned off the weekly brief in MKX · ${when}`,
    );

    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(linesOf(entryById("chg-seed-claude-2")!)).toBe(
        "Claude per conto di Giulia Ferri ha acceso il brief settimanale in MKX. | Brief settimanale: Spento → Acceso | " +
          `Ha annullato: Claude per conto di Giulia Ferri ha spento il brief settimanale in MKX · ${dayTime(CLAUDE_SEED_TIMES.brief.run, "it")}`,
      ),
    );
  });

  it("la data di «Undid:» porta alla voce annullata e la evidenzia", async () => {
    const user = userEvent.setup();
    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entryById("chg-seed-claude-2")).not.toBeNull());
    const link = within(entryById("chg-seed-claude-2")!).getByRole("button", {
      name: dayTime(CLAUDE_SEED_TIMES.brief.run, "en"),
    });
    await user.click(link);
    await waitFor(() =>
      expect(entryById("chg-seed-claude-1")).toHaveAttribute("data-highlighted", "true"),
    );
    expect(entryById("chg-seed-claude-1")).toHaveFocus();
  });

  it("fuori dai filtri attivi la data li toglie prima, e lo dice", async () => {
    // Una voce annullata dieci giorni fa, l'inversa oggi: «Last 7 days» la nasconde.
    const old = `${daysFromToday(-10)}T08:00:00Z`;
    state.changelog.push(
      change("chg-old", old, "on", "off"),
      { ...change("chg-new", `${daysFromToday(0)}T08:30:00Z`, "off", "on"), undoOf: "chg-old" },
    );
    const user = userEvent.setup();
    const router = await openAdminLog(ROBERTA, "?period=7d");
    await waitFor(() => expect(entryById("chg-new")).not.toBeNull());
    expect(entryById("chg-old")).toBeNull();
    await user.click(
      within(entryById("chg-new")!).getByRole("button", { name: dayTime(old, "en") }),
    );
    expect(await screen.findByText("Filters cleared to show the change.")).toBeInTheDocument();
    await waitFor(() => expect(entryById("chg-old")).toHaveAttribute("data-highlighted", "true"));
    expect(router.state.location.search).not.toHaveProperty("period");
  });
});

/** Una voce dell'interruttore del brief di ACQ scritta da Claude per Laura. */
function change(id: string, at: string, before: string, after: string): StoredChange {
  return {
    id,
    kind: "project.switch_changed",
    at,
    actorId: LAURA,
    projectId: "prj-acq",
    object: { type: "project", id: "prj-acq", label: "ACQ" },
    before,
    after,
    params: { switch: "weeklyBrief" },
    via: "claude",
  };
}

describe("il filtro «Made with Claude»", () => {
  it("«Person» = Giulia trova le voci col segno; «Made with Claude» isola solo quelle, nell'indirizzo", async () => {
    // Una voce di Giulia a mano: col filtro di Claude sparisce.
    state.changelog.push({
      id: "chg-giulia-hand",
      kind: "project.switch_changed",
      at: `${daysFromToday(0)}T08:00:00Z`,
      actorId: GIULIA,
      projectId: "prj-mkx",
      object: { type: "project", id: "prj-mkx", label: "MKX" },
      before: "off",
      after: "on",
      params: { switch: "pulse" },
    });
    const user = userEvent.setup();
    const router = await openAdminLog(ROBERTA, `?actor=${GIULIA}`);
    await waitFor(() => expect(entryById("chg-giulia-hand")).not.toBeNull());
    expect(entryById("chg-seed-claude-1")).not.toBeNull();
    expect(entryById("chg-seed-claude-2")).not.toBeNull();

    const toggle = screen.getByRole("button", { name: "Made with Claude" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Dopo Type e prima di Period ([CT 5]).
    const bar = screen.getByRole("group", { name: "Change log filters" });
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    expect(names.findIndex((n) => n.startsWith("Made with Claude"))).toBe(
      names.findIndex((n) => n.startsWith("Type")) + 1,
    );
    await user.click(toggle);
    await waitFor(() => expect(entryById("chg-giulia-hand")).toBeNull());
    expect(entryById("chg-seed-claude-1")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Made with Claude" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(router.state.location.search).toMatchObject({ via: "claude", actor: GIULIA });
    // Ogni voce rimasta ha il segno.
    for (const el of document.querySelectorAll<HTMLElement>("[data-change-entry]"))
      expect(linesOf(el)).toMatch(/^Claude on behalf of /);

    // «Clear filters» lo toglie.
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("via"));
  });

  it("chi non legge nessuna voce col segno non vede il filtro, e ?via=claude si ignora", async () => {
    await openAdminLog(LAURA, "?via=claude");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-change-entry]").length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", { name: "Made with Claude" })).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/claude on behalf/i);
  });

  it("nel Change log del progetto c'è anche, per chi ne gestisce le impostazioni", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/MKX/settings/changelog", GIULIA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    await waitFor(() => expect(entryById("chg-seed-claude-3")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Made with Claude" }));
    await waitFor(() => expect(entryById("chg-seed-claude-3")).toBeNull());
    expect(entryById("chg-seed-claude-1")).not.toBeNull();
    expect(router.state.location.search).toMatchObject({ via: "claude" });
  });
});

describe("R-G5 e righe di prima", () => {
  it("un'inversa letta da chi non legge la voce annullata: la frase col prefisso, senza «Undid:»", async () => {
    // L'azione annullata sta in MKX (Laura non la legge), l'inversa in ACQ.
    state.changelog.push(
      {
        id: "chg-hidden",
        kind: "project.switch_changed",
        at: `${daysFromToday(0)}T08:00:00Z`,
        actorId: GIULIA,
        projectId: "prj-mkx",
        object: { type: "project", id: "prj-mkx", label: "MKX" },
        before: "on",
        after: "off",
        params: { switch: "pulse" },
        via: "claude",
      },
      { ...change("chg-inverse", `${daysFromToday(0)}T08:30:00Z`, "off", "on"), undoOf: "chg-hidden" },
    );
    await openAdminLog(LAURA);
    await waitFor(() => expect(entryById("chg-inverse")).not.toBeNull());
    expect(linesOf(entryById("chg-inverse")!)).toBe(
      "Claude on behalf of Laura Costa turned on the weekly brief in ACQ. | Weekly brief: Off → On",
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/undid/i);
    expect(text).not.toMatch(/mkx/i);
    expect(text).not.toMatch(/giulia/i);
  });

  it("una voce nata prima del 10a (senza i campi nuovi) non ha segno né «Undid:»", () => {
    // Apposta SENZA `via`, `undoOf` e `undoneEntry`: la forma delle righe di prima.
    const before = {
      id: "chg-legacy",
      kind: "project.switch_changed",
      at: "2026-10-20T10:00:00Z",
      actorId: ROBERTA,
      projectId: "prj-acq",
      object: { type: "project", id: "prj-acq", label: "ACQ" },
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
      templateKey: "changelog.kinds.project.switch_changed",
      scope: "project",
      group: "project",
      actorName: "Roberta Fontana",
      projectCode: "ACQ",
      objectDeleted: false,
      objectLink: null,
      diff: {
        kind: "setting",
        before: { type: "switch", on: true },
        after: { type: "switch", on: false },
      },
    } as unknown as ChangeEntryView;
    render(<ChangeEntry entry={before} />);
    const el = document.querySelector<HTMLElement>("[data-change-entry]")!;
    expect(linesOf(el)).toBe(
      "Roberta Fontana turned off the weekly brief in ACQ. | Weekly brief: On → Off",
    );
    expect(screen.queryByRole("img", { name: "Made with Claude" })).toBeNull();
    expect(el.textContent).not.toMatch(/claude|undid/i);
  });
});

describe("gruppo Tasks", () => {
  it("task.deleted con il segno si legge col prefisso", async () => {
    setSessionPersonId(ROBERTA);
    state.changelog.push({
      id: "chg-task-deleted",
      kind: "task.deleted",
      at: `${daysFromToday(0)}T09:00:00Z`,
      actorId: GIULIA,
      projectId: "prj-mkx",
      object: { type: "task", id: "t-gone", label: "MKX-31" },
      before: null,
      after: null,
      params: { title: "Prova" },
      via: "claude",
    });
    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entryById("chg-task-deleted")).not.toBeNull());
    expect(linesOf(entryById("chg-task-deleted")!)).toBe(
      "Claude on behalf of Giulia Ferri deleted the task MKX-31 “Prova”.",
    );
  });
});
