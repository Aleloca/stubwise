import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import en from "../i18n/locales/en.json";
import it_ from "../i18n/locales/it.json";
import type { TicketHistoryEventView, TicketHistoryView } from "../lib/api";
import { HISTORY_PREVIEW, historyLineFor, TicketHistory } from "./ticket-history";

/**
 * La «Storia del lavoro» sul web: le stesse righe dell'app, con la regola di
 * `historyLineSpec` di shared e le parole del catalogo web.
 *
 * ⚠️ Le fixture qui sotto NON hanno i campi opzionali (actor, prNumber,
 * prUrl, round, detail, fromStatus) se non dove servono, e una risposta senza
 * `total`: è la prova che il componente li difende con `??`, perché il web non
 * passa sempre dal `.default()` dello schema. Non completarle.
 */

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function ev(id: string, overrides: Partial<TicketHistoryEventView> & { kind: string }): TicketHistoryEventView {
  return { id, at: minutesAgo(5), ...overrides };
}

const en_ = i18n.getFixedT("en");
const itT = i18n.getFixedT("it");

describe("historyLineFor — titoli, chi, PR, colore", () => {
  it("una fixture SENZA i campi opzionali non rompe la riga", () => {
    const line = historyLineFor({ id: "run_started:1", kind: "run_started", at: minutesAgo(1) }, en_);
    expect(line).toEqual({ title: "Run started", who: null, pr: null, url: null, tone: "sky" });
  });

  it("ticket_closed e cambio di stato nelle parole del web (D3)", () => {
    expect(historyLineFor(ev("a", { kind: "ticket_closed", detail: "done" }), itT).title).toBe(
      "Ticket chiuso (done)",
    );
    const changed = historyLineFor(ev("b", { kind: "status_changed", fromStatus: "in_review", detail: "triaged" }), en_);
    expect(changed.title).toBe("Status: In review → Triaged");
    expect(changed.title).not.toMatch(/PR/);
    expect(historyLineFor(ev("c", { kind: "status_changed", fromStatus: "parked", detail: "done" }), itT).title).toBe(
      "Stato: sconosciuto → Fatto",
    );
  });

  it("chi: agente, qualcuno, piattaforma; null resta senza nome", () => {
    expect(historyLineFor(ev("a", { kind: "run_started", actor: { type: "ai", name: null } }), itT).who).toBe("agente");
    expect(historyLineFor(ev("b", { kind: "changes_requested", actor: { type: "user", name: null } }), en_).who).toBe(
      "someone",
    );
    expect(
      historyLineFor(ev("c", { kind: "changes_requested", actor: { type: "provider", name: "octo" } }), en_).who,
    ).toBe("octo (platform)");
    expect(historyLineFor(ev("d", { kind: "ticket_closed", detail: "done", actor: null }), en_).who).toBeNull();
  });

  it("PR #N e PR #N · correction K", () => {
    expect(historyLineFor(ev("a", { kind: "pr_opened", prNumber: 4 }), en_).pr).toBe("PR #4");
    expect(historyLineFor(ev("b", { kind: "correction_pushed", prNumber: 4, round: 3 }), itT).pr).toBe(
      "PR #4 · correzione 3",
    );
  });

  it("un kind sconosciuto è «Update», mai scartato", () => {
    expect(historyLineFor(ev("x", { kind: "brand_new_kind" }), en_)).toMatchObject({ title: "Update", tone: "faint" });
  });
});

describe("<TicketHistory />", () => {
  it("righe col pallino del colore giusto, chi e PR", async () => {
    const history: TicketHistoryView = {
      events: [
        ev("review_completed:1", { kind: "review_completed", detail: "approve", prNumber: 7 }),
        ev("changes_requested:1", { kind: "changes_requested", actor: { type: "user", name: "ada@x.it" }, prNumber: 7, round: 1 }),
        ev("correction_failed:1", { kind: "correction_failed" }),
        ev("run_started:1", { kind: "run_started" }),
        ev("status_changed:1", { kind: "status_changed", fromStatus: "open", detail: "triaged" }),
      ],
      total: 5,
    };
    render(<TicketHistory history={history} status="success" />);

    expect(screen.getByText("Review: approved")).toBeInTheDocument();
    expect(screen.getByText("ada@x.it · PR #7 · correction 1")).toBeInTheDocument();
    const toneOf = (id: string) => screen.getByTestId(`ticket-history-dot-${id}`);
    expect(toneOf("review_completed:1")).toHaveClass("bg-ok");
    expect(toneOf("changes_requested:1")).toHaveClass("bg-signal");
    expect(toneOf("correction_failed:1")).toHaveClass("bg-danger");
    expect(toneOf("run_started:1")).toHaveClass("bg-sky-400");
    expect(toneOf("status_changed:1")).toHaveClass("bg-fg-faint");
    // Nessun «Show all» sotto la soglia.
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("una riga con PR http/https la apre in una scheda nuova; un URL non sicuro no", () => {
    const history: TicketHistoryView = {
      events: [
        ev("pr_opened:1", { kind: "pr_opened", prNumber: 12, prUrl: "https://github.com/acme/shop/pull/12" }),
        ev("pr_opened:2", { kind: "pr_opened", prNumber: 13, prUrl: "javascript:alert(1)" }),
      ],
    };
    render(<TicketHistory history={history} status="success" />);

    const link = within(screen.getByTestId("ticket-history-row-pr_opened:1")).getByRole("link");
    expect(link).toHaveAttribute("href", "https://github.com/acme/shop/pull/12");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(within(screen.getByTestId("ticket-history-row-pr_opened:2")).queryByRole("link")).toBeNull();
  });

  it("primi 8, poi «Show all (N)» con N dal server, che espande sul posto", async () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(`run_started:${i}`, { kind: "run_started", at: minutesAgo(i) }));
    render(<TicketHistory history={{ events, total: 230 }} status="success" />);

    expect(screen.getAllByTestId(/^ticket-history-row-/)).toHaveLength(HISTORY_PREVIEW);
    await userEvent.click(screen.getByRole("button", { name: "Show all (230)" }));
    expect(screen.getAllByTestId(/^ticket-history-row-/)).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-history-capped")).toHaveTextContent("Latest 12 of 230");
  });

  it("senza `total` dal server conta gli eventi", () => {
    const events = Array.from({ length: 9 }, (_, i) => ev(`run_started:${i}`, { kind: "run_started" }));
    render(<TicketHistory history={{ events }} status="success" />);
    expect(screen.getByRole("button", { name: "Show all (9)" })).toBeInTheDocument();
  });

  it("errore o server vecchio (404): «Story not available»", () => {
    render(<TicketHistory history={undefined} status="error" />);
    expect(screen.getByTestId("ticket-history-unavailable")).toHaveTextContent("Story not available.");
  });

  it("vuota, anche senza `events`", () => {
    render(<TicketHistory history={{}} status="success" />);
    expect(screen.getByTestId("ticket-history-empty")).toHaveTextContent("Nothing has happened yet.");
  });

  it("in caricamento non dice né vuota né non disponibile", () => {
    render(<TicketHistory history={undefined} status="pending" />);
    expect(screen.queryByTestId("ticket-history-unavailable")).toBeNull();
    expect(screen.queryByTestId("ticket-history-empty")).toBeNull();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

/**
 * Le PAROLE della storia sono le stesse dell'app: i testi stanno in due
 * cataloghi (web e app), quindi una parità li tiene insieme. La regola è
 * condivisa (`historyLineSpec`), le parole no: è il punto in cui potrebbero
 * divergere.
 */
describe("parità dei testi con l'app", () => {
  type Tree = { [k: string]: string | Tree };
  const mobileDir = path.join(import.meta.dirname, "../../../mobile/src/i18n");
  const load = (lang: string) =>
    ((JSON.parse(readFileSync(path.join(mobileDir, `${lang}.json`), "utf-8")) as { mobile: { work: { history: Tree } } })
      .mobile.work.history);

  it.each([
    ["en", en],
    ["it", it_],
  ] as const)("%s: tickets:history = mobile.work.history (più statusUnknown)", (lang, web) => {
    const { statusUnknown, ...rest } = (web as unknown as { tickets: { history: Tree } }).tickets.history;
    expect(typeof statusUnknown).toBe("string");
    expect(rest).toEqual(load(lang));
  });
});
