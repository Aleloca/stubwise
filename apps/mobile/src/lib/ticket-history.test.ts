import { UNKNOWN } from "@stubwise/shared";
import type { Reader, TicketHistoryEvent } from "@stubwise/shared";
import i18n from "../i18n";
import { historyLineFor } from "./ticket-history";

/**
 * Il testo di una riga della storia (piano B3, D3 decisa dal maintainer): la
 * regola è PURA, prende `t` e un evento letto dal server. Le parole vengono
 * dai cataloghi veri: un test che stubbasse `t` non saprebbe dire se la
 * chiave esiste.
 */

function event(overrides: Partial<Reader<TicketHistoryEvent>> & Pick<Reader<TicketHistoryEvent>, "kind">) {
  const base: Reader<TicketHistoryEvent> = {
    id: `${overrides.kind}:1`,
    kind: overrides.kind,
    at: "2026-10-02T09:00:00.000Z",
    actor: null,
    prNumber: null,
    prUrl: null,
    round: null,
    detail: null,
    fromStatus: null,
  };
  return { ...base, ...overrides };
}

const it_ = i18n.getFixedT("it");
const en = i18n.getFixedT("en");

describe("historyLineFor — chiusura e cambi di stato (D3)", () => {
  test("ticket_closed si legge come chiusura, con lo stato fra parentesi", () => {
    expect(historyLineFor(event({ kind: "ticket_closed", detail: "done" }), it_).title).toBe(
      "Ticket chiuso (done)",
    );
    expect(historyLineFor(event({ kind: "ticket_closed", detail: "done" }), en).title).toBe(
      "Ticket closed (done)",
    );
  });

  test("in_review → triaged è un cambio di stato in parole, MAI «PR chiusa senza merge»", () => {
    const line = historyLineFor(
      event({ kind: "status_changed", fromStatus: "in_review", detail: "triaged" }),
      it_,
    );
    expect(line.title).toBe("Stato: in review → triage");
    expect(line.title).not.toMatch(/PR/);
    expect(
      historyLineFor(event({ kind: "status_changed", fromStatus: "in_review", detail: "triaged" }), en).title,
    ).toBe("Status: in review → triaged");
  });

  test("uno stato che questa build non conosce non esce grezzo", () => {
    const line = historyLineFor(event({ kind: "status_changed", fromStatus: "parked", detail: "triaged" }), it_);
    expect(line.title).toBe("Stato: sconosciuto → triage");
  });

  test("senza stato di partenza: solo l'arrivo", () => {
    expect(historyLineFor(event({ kind: "status_changed", detail: "in_progress" }), it_).title).toBe(
      "Stato → in corso",
    );
  });
});

describe("historyLineFor — chi", () => {
  test("actor null: nessun nome, e mai «automatico»", () => {
    const line = historyLineFor(event({ kind: "ticket_closed", detail: "done" }), it_);
    expect(line.who).toBeNull();
    expect(line.title).not.toMatch(/automatic/i);
  });

  test("una persona senza nome (utente eliminato) è «qualcuno»", () => {
    const line = historyLineFor(
      event({ kind: "changes_requested", actor: { type: "user", name: null }, prNumber: 4, round: 2 }),
      it_,
    );
    expect(line.who).toBe("qualcuno");
    expect(
      historyLineFor(event({ kind: "changes_requested", actor: { type: "user", name: null } }), en).who,
    ).toBe("someone");
  });

  test("utente con nome, piattaforma, agente", () => {
    expect(
      historyLineFor(event({ kind: "run_started", actor: { type: "user", name: "ale@x.test" } }), it_).who,
    ).toBe("ale@x.test");
    expect(
      historyLineFor(event({ kind: "changes_requested", actor: { type: "provider", name: "mario" } }), it_).who,
    ).toBe("mario (piattaforma)");
    expect(historyLineFor(event({ kind: "pr_opened", actor: { type: "ai", name: null } }), it_).who).toBe(
      "agente",
    );
  });

  test("un actor.type ignoto: il nome se c'è, altrimenti niente — nessun nome inventato", () => {
    expect(historyLineFor(event({ kind: "x", actor: { type: UNKNOWN, name: "r2" } }), it_).who).toBe("r2");
    expect(historyLineFor(event({ kind: "x", actor: { type: UNKNOWN, name: null } }), it_).who).toBeNull();
  });
});

describe("historyLineFor — PR e link", () => {
  test("«PR #4 · correzione 3» (D2) quando c'è il round", () => {
    const line = historyLineFor(
      event({ kind: "correction_pushed", prNumber: 4, round: 3, prUrl: "https://x.test/pull/4" }),
      it_,
    );
    expect(line.pr).toBe("PR #4 · correzione 3");
    expect(line.url).toBe("https://x.test/pull/4");
  });

  test("senza round: solo «PR #4»", () => {
    expect(historyLineFor(event({ kind: "pr_opened", prNumber: 4 }), en).pr).toBe("PR #4");
  });

  test("un URL non http/https non è apribile (safe-url di shared)", () => {
    const line = historyLineFor(
      event({ kind: "pr_opened", prNumber: 4, prUrl: "javascript:alert(1)" }),
      it_,
    );
    expect(line.url).toBeNull();
  });
});

describe("historyLineFor — kind", () => {
  test("un kind sconosciuto è una riga generica, non scartata", () => {
    expect(historyLineFor(event({ kind: "brand_new_thing" }), it_).title).toBe("Aggiornamento");
    expect(historyLineFor(event({ kind: "brand_new_thing" }), en).title).toBe("Update");
  });

  test("ogni kind del server ha un testo suo, in it ed en", () => {
    // Elenco scritto a mano: è la tabella dei `kind` nel docblock di
    // `buildTicketHistory` (`packages/notifications/src/ticket-history.ts`).
    // Chi aggiunge un kind lì lo aggiunge anche qui.
    const kinds = [
      "run_started",
      "question_asked",
      "question_answered",
      "plan_approved",
      "plan_rejected",
      "pr_opened",
      "review_completed",
      "changes_requested",
      "correction_pushed",
      "correction_failed",
      "ticket_closed",
      "status_changed",
    ];
    for (const t of [it_, en]) {
      const generic = historyLineFor(event({ kind: "zzz" }), t).title;
      for (const kind of kinds) {
        const title = historyLineFor(event({ kind, detail: "done" }), t).title;
        expect(title).not.toBe(generic);
        expect(title).not.toMatch(/mobile\.work/);
      }
    }
  });

  test("dettagli: pre-approvazione, verdetti, richiesta annullata", () => {
    expect(historyLineFor(event({ kind: "plan_approved", detail: "pre_approved" }), it_).title).toBe(
      "Piano approvato in anticipo",
    );
    expect(historyLineFor(event({ kind: "review_completed", detail: "approve" }), it_).title).toBe(
      "Review: approvata",
    );
    expect(historyLineFor(event({ kind: "review_completed", detail: "request_changes" }), it_).title).toBe(
      "Review: modifiche richieste",
    );
    expect(historyLineFor(event({ kind: "changes_requested", detail: "cancelled" }), it_).title).toBe(
      "Modifiche chieste (annullata)",
    );
  });
});

describe("historyLineFor — colore del pallino", () => {
  // La regola decisa dal maintainer il 5 ott 2026: verde traguardo, ambra
  // persona, azzurro lavoro dell'AI, rosso andato storto, grigio contesto.
  it.each([
    ["pr_opened", null, "ok"],
    ["plan_approved", null, "ok"],
    ["plan_approved", "pre_approved", "ok"],
    ["ticket_closed", "done", "ok"],
    ["review_completed", "approve", "ok"],
    ["review_completed", "request_changes", "signal"],
    ["review_completed", null, "faint"],
    ["changes_requested", null, "signal"],
    ["changes_requested", "cancelled", "faint"],
    ["question_asked", null, "signal"],
    ["question_answered", null, "signal"],
    ["run_started", null, "sky"],
    ["correction_pushed", null, "sky"],
    ["correction_failed", null, "danger"],
    ["plan_rejected", null, "danger"],
    ["status_changed", "in_review", "faint"],
    ["un_kind_che_non_esiste", null, "faint"],
  ] as const)("%s (%s) → %s", (kind, detail, tone) => {
    expect(historyLineFor(event({ kind, detail }), en).tone).toBe(tone);
  });
});
