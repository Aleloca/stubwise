import { describe, expect, it } from "vitest";
import { historyLineSpec, historyTitleFor, historyToneFor, historyWhoFor } from "./ticket-history-line.js";
import type { HistoryEventInput } from "./ticket-history-line.js";

/**
 * La regola di presentazione della «Storia del lavoro», condivisa da web e
 * app. Qui si fissa la regola; le PAROLE le verificano i test dei due client
 * contro i loro cataloghi veri.
 */

function event(overrides: Partial<HistoryEventInput> & Pick<HistoryEventInput, "kind">): HistoryEventInput {
  return {
    detail: null,
    fromStatus: null,
    actor: null,
    prNumber: null,
    prUrl: null,
    round: null,
    ...overrides,
  };
}

describe("historyToneFor — il colore del pallino, per significato", () => {
  it.each([
    ["pr_opened", null, "ok"],
    ["plan_approved", null, "ok"],
    ["plan_approved", "pre_approved", "ok"],
    ["ticket_closed", "done", "ok"],
    ["review_completed", "approve", "ok"],
    ["review_completed", "request_changes", "signal"],
    ["review_completed", "comment", "faint"],
    ["changes_requested", null, "signal"],
    ["changes_requested", "cancelled", "faint"],
    ["question_asked", null, "signal"],
    ["question_answered", null, "signal"],
    ["run_started", null, "sky"],
    ["correction_pushed", null, "sky"],
    ["correction_failed", null, "danger"],
    ["plan_rejected", null, "danger"],
    ["status_changed", "triaged", "faint"],
    ["brand_new_kind", null, "faint"],
  ] as const)("%s (%s) → %s", (kind, detail, tone) => {
    expect(historyToneFor({ kind, detail })).toBe(tone);
  });
});

describe("historyTitleFor — D3", () => {
  it("ticket_closed porta lo stato del server", () => {
    expect(historyTitleFor(event({ kind: "ticket_closed", detail: "done" }))).toEqual({
      key: "ticket_closed",
      status: "done",
    });
  });

  it("in_review → triaged è un cambio di stato, mai una «PR chiusa»", () => {
    expect(
      historyTitleFor(event({ kind: "status_changed", fromStatus: "in_review", detail: "triaged" })),
    ).toEqual({ key: "status_changed", from: "in_review", to: "triaged" });
  });

  it("senza stato di partenza: solo l'arrivo; senza arrivo: riga generica", () => {
    expect(historyTitleFor(event({ kind: "status_changed", detail: "done" }))).toEqual({
      key: "status_changed_to",
      to: "done",
    });
    expect(historyTitleFor(event({ kind: "status_changed" }))).toEqual({ key: "unknown" });
  });

  it("verdetto, pre-approvazione, richiesta annullata", () => {
    expect(historyTitleFor(event({ kind: "review_completed", detail: "request_changes" }))).toEqual({
      key: "review_completed",
      verdict: "requestChanges",
    });
    expect(historyTitleFor(event({ kind: "review_completed", detail: "comment" }))).toEqual({
      key: "review_completed",
      verdict: "other",
    });
    expect(historyTitleFor(event({ kind: "plan_approved", detail: "pre_approved" }))).toEqual({
      key: "plan_pre_approved",
    });
    expect(historyTitleFor(event({ kind: "changes_requested", detail: "cancelled" }))).toEqual({
      key: "changes_requested_cancelled",
    });
  });

  it("un kind sconosciuto è una riga generica, mai scartata", () => {
    expect(historyTitleFor(event({ kind: "brand_new_kind" }))).toEqual({ key: "unknown" });
  });
});

describe("historyWhoFor", () => {
  it("actor null: nessuno, mai «automatico»", () => {
    expect(historyWhoFor(null)).toBeNull();
  });

  it("persona senza nome = qualcuno; agente; piattaforma", () => {
    expect(historyWhoFor({ type: "user", name: null })).toEqual({ key: "someone" });
    expect(historyWhoFor({ type: "user", name: "ada@x.it" })).toEqual({ key: "name", name: "ada@x.it" });
    expect(historyWhoFor({ type: "ai", name: null })).toEqual({ key: "agent" });
    expect(historyWhoFor({ type: "provider", name: "octo" })).toEqual({ key: "provider", name: "octo" });
    expect(historyWhoFor({ type: "provider", name: null })).toEqual({ key: "someone" });
  });

  it("system e un tipo ignoto: il nome com'è, o nessuno", () => {
    expect(historyWhoFor({ type: "system", name: null })).toBeNull();
    expect(historyWhoFor({ type: "__unknown__", name: "x" })).toEqual({ key: "name", name: "x" });
  });
});

describe("historyLineSpec — PR e URL", () => {
  it("PR con correzione e URL https apribile", () => {
    const spec = historyLineSpec(
      event({ kind: "correction_pushed", prNumber: 4, round: 2, prUrl: "https://github.com/a/b/pull/4" }),
    );
    expect(spec.pr).toEqual({ number: 4, round: 2 });
    expect(spec.url).toBe("https://github.com/a/b/pull/4");
    expect(spec.tone).toBe("sky");
  });

  it("un URL non http/https non si apre", () => {
    expect(historyLineSpec(event({ kind: "pr_opened", prNumber: 1, prUrl: "javascript:alert(1)" })).url).toBeNull();
  });

  it("fuori da una PR: niente PR", () => {
    expect(historyLineSpec(event({ kind: "run_started" })).pr).toBeNull();
  });
});
