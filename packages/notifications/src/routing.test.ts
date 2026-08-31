import { notificationKind } from "@stubwise/db";
import { describe, expect, it } from "vitest";
import { sampleEvents, type NotificationEvent, type NotificationKind } from "./format.js";
import { isAdminOnlyKind, recipientsFor, type RoutingContext } from "./routing.js";

/**
 * Test del routing PURO: nessun DB, nessuna rete. `recipientsFor` riceve un
 * evento e il contesto già risolto (admin, follower, richiedente,
 * assegnatario, reporter) e decide chi deve vedere la notifica nell'inbox.
 */

const BASE_URL = "https://stubwise.example.com";

/** Evento d'esempio del kind richiesto, dal catalogo di `sampleEvents`. */
function eventOfKind(kind: NotificationKind): NotificationEvent {
  const event = sampleEvents(BASE_URL).find((candidate) => candidate.kind === kind);
  if (!event) throw new Error(`nessun evento d'esempio per il kind ${kind}`);
  return event;
}

const CTX: RoutingContext = {
  admins: ["admin-1", "admin-2"],
  followers: ["follower-1", "admin-2"],
  requestedBy: "member-requester",
  assignee: "member-assignee",
  reporter: "member-reporter",
};

describe("recipientsFor", () => {
  it("manda i kind decisionali ai soli admin", () => {
    for (const kind of ["job.plan_review", "job.held", "job.budget_held"] as const) {
      expect(recipientsFor(eventOfKind(kind), CTX)).toEqual(["admin-1", "admin-2"]);
    }
  });

  it("manda gli eventi senza ticket (docs/monitor) ai soli admin", () => {
    for (const kind of ["docs.limit_paused", "monitor.alert", "monitor.recovered"] as const) {
      expect(recipientsFor(eventOfKind(kind), CTX)).toEqual(["admin-1", "admin-2"]);
    }
  });

  it("manda gli eventi di avanzamento all'unione admin ∪ persone del ticket ∪ follower", () => {
    for (const kind of [
      "ticket.created",
      "job.pr_opened",
      "job.pr_closed",
      "job.failed",
      "review.completed",
    ] as const) {
      expect(recipientsFor(eventOfKind(kind), CTX)).toEqual([
        "admin-1",
        "admin-2",
        "member-requester",
        "member-assignee",
        "member-reporter",
        "follower-1",
      ]);
    }
  });

  it("manda la domanda dell'AI al richiedente e agli admin, MAI ai follower", () => {
    expect(recipientsFor(eventOfKind("job.awaiting_input"), CTX)).toEqual([
      "admin-1",
      "admin-2",
      "member-requester",
    ]);
  });

  it("senza richiedente (run dell'automazione) la domanda resta ai soli admin", () => {
    expect(
      recipientsFor(eventOfKind("job.awaiting_input"), {
        admins: ["admin-1"],
        followers: ["follower-1"],
        assignee: "member-assignee",
        reporter: "member-reporter",
      }),
    ).toEqual(["admin-1"]);
  });

  it("la domanda non raggiunge follower, assegnatario e reporter nemmeno col richiedente", () => {
    const recipients = recipientsFor(eventOfKind("job.awaiting_input"), {
      admins: [],
      followers: ["follower-1"],
      requestedBy: "member-requester",
      assignee: "member-assignee",
      reporter: "member-reporter",
    });
    expect(recipients).toEqual(["member-requester"]);
  });

  it("non duplica chi compare in più ruoli", () => {
    const recipients = recipientsFor(eventOfKind("job.pr_opened"), {
      admins: ["u1"],
      followers: ["u1", "u2"],
      requestedBy: "u1",
      assignee: "u2",
      reporter: "u1",
    });
    expect(recipients).toEqual(["u1", "u2"]);
  });

  it("ignora i ruoli non risolti (undefined) e i contesti vuoti", () => {
    expect(recipientsFor(eventOfKind("job.pr_opened"), { admins: [], followers: [] })).toEqual([]);
    expect(
      recipientsFor(eventOfKind("job.pr_opened"), {
        admins: [],
        followers: [],
        assignee: "member-assignee",
      }),
    ).toEqual(["member-assignee"]);
  });

  it("non usa follower e persone del ticket per i kind decisionali", () => {
    expect(
      recipientsFor(eventOfKind("job.plan_review"), {
        admins: [],
        followers: ["follower-1"],
        requestedBy: "member-requester",
        assignee: "member-assignee",
      }),
    ).toEqual([]);
  });
});

describe("isAdminOnlyKind", () => {
  it("distingue i kind ai soli admin da quelli di avanzamento", () => {
    expect(isAdminOnlyKind("job.plan_review")).toBe(true);
    expect(isAdminOnlyKind("job.held")).toBe(true);
    expect(isAdminOnlyKind("job.budget_held")).toBe(true);
    expect(isAdminOnlyKind("docs.limit_paused")).toBe(true);
    expect(isAdminOnlyKind("monitor.alert")).toBe(true);
    expect(isAdminOnlyKind("monitor.recovered")).toBe(true);
    expect(isAdminOnlyKind("ticket.created")).toBe(false);
    expect(isAdminOnlyKind("job.pr_opened")).toBe(false);
    expect(isAdminOnlyKind("job.pr_closed")).toBe(false);
    expect(isAdminOnlyKind("job.failed")).toBe(false);
    expect(isAdminOnlyKind("review.completed")).toBe(false);
    // `job.awaiting_input` ha un pubblico proprio (richiedente ∪ admin): non è
    // "solo admin", altrimenti `publish` salterebbe la risoluzione del job.
    expect(isAdminOnlyKind("job.awaiting_input")).toBe(false);
  });
});

/**
 * Parità dei kind tra il tipo applicativo (`NotificationEvent` in `format.ts`,
 * di cui `sampleEvents` copre un caso per kind) e l'enum Postgres
 * `notification_kind`. Un kind nuovo da una parte sola — evento aggiunto senza
 * migrazione, o viceversa — romperebbe l'insert nell'inbox a runtime: qui
 * fallisce nei test.
 */
describe("parità dei kind con l'enum del DB", () => {
  it("sampleEvents copre esattamente i valori di notification_kind", () => {
    const fromEvents = [...new Set(sampleEvents(BASE_URL).map((event) => event.kind))].sort();
    const fromEnum = [...notificationKind.enumValues].sort();
    expect(fromEvents).toEqual(fromEnum);
  });
});
