import { notificationKind } from "@stubwise/db";
import { describe, expect, it } from "vitest";
import { sampleEvents, type NotificationEvent, type NotificationKind } from "./format.js";
import { deciderPermissionsFor, recipientsFor, type RoutingContext } from "./routing.js";

/**
 * Test del routing PURO: nessun DB, nessuna rete. `recipientsFor` riceve un
 * evento e il contesto già risolto (deciders, membri, follower, richiedente,
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
  members: null,
  deciders: ["admin-1", "admin-2"],
  followers: ["follower-1", "admin-2"],
  requestedBy: "member-requester",
  assignee: "member-assignee",
  reporter: "member-reporter",
};

describe("recipientsFor", () => {
  it("manda i kind decisionali ai soli deciders", () => {
    for (const kind of ["job.plan_review", "job.held", "job.budget_held"] as const) {
      expect(recipientsFor(eventOfKind(kind), CTX)).toEqual(["admin-1", "admin-2"]);
    }
  });

  it("manda gli eventi senza ticket (docs/monitor) ai soli deciders", () => {
    for (const kind of ["docs.limit_paused", "monitor.alert", "monitor.recovered"] as const) {
      expect(recipientsFor(eventOfKind(kind), CTX)).toEqual(["admin-1", "admin-2"]);
    }
  });

  it("docs.nightly_attention va ai soli deciders", () => {
    const event: NotificationEvent = {
      kind: "docs.nightly_attention",
      reason: "item_failing",
      repositoryId: "r1",
      repositoryName: "api",
      projectId: "p1",
      projectName: "Apollo",
      night: "2026-10-16",
      docsUrl: `${BASE_URL}/docs/r1`,
    };
    expect(recipientsFor(event, CTX)).toEqual(["admin-1", "admin-2"]);
  });

  it("request.created va ai soli deciders, member esclusi", () => {
    const event: NotificationEvent = {
      kind: "request.created",
      requestKind: "bug",
      projectId: "p1",
      projectName: "Apollo",
      title: "Crash",
      requesterEmail: "m@example.com",
      merged: false,
      url: `${BASE_URL}/tickets/t1`,
    };
    expect(recipientsFor(event, CTX)).toEqual(["admin-1", "admin-2"]);
  });

  it("manda gli eventi di avanzamento all'unione deciders ∪ persone del ticket ∪ follower", () => {
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

  it("manda la domanda dell'AI al richiedente e ai deciders, MAI ai follower", () => {
    expect(recipientsFor(eventOfKind("job.awaiting_input"), CTX)).toEqual([
      "admin-1",
      "admin-2",
      "member-requester",
    ]);
  });

  it("senza richiedente (run dell'automazione) la domanda resta ai soli deciders", () => {
    expect(
      recipientsFor(eventOfKind("job.awaiting_input"), {
        members: null,
        deciders: ["admin-1"],
        followers: ["follower-1"],
        assignee: "member-assignee",
        reporter: "member-reporter",
      }),
    ).toEqual(["admin-1"]);
  });

  it("la domanda non raggiunge follower, assegnatario e reporter nemmeno col richiedente", () => {
    const recipients = recipientsFor(eventOfKind("job.awaiting_input"), {
      members: null,
      deciders: [],
      followers: ["follower-1"],
      requestedBy: "member-requester",
      assignee: "member-assignee",
      reporter: "member-reporter",
    });
    expect(recipients).toEqual(["member-requester"]);
  });

  it("manda il pulse del progetto ad deciders ∪ follower (broadcast SENZA ticket)", () => {
    // Il pulse è ancorato al PROGETTO: non c'è ticket, quindi `publish` non
    // risolve né assegnatario né richiedente e il contesto arriva così. È il
    // caso nuovo del broadcast: gli altri kind broadcast un ticket ce l'hanno.
    expect(
      recipientsFor(eventOfKind("project.pulse"), {
        members: null,
        deciders: ["admin-1", "admin-2"],
        followers: ["follower-1", "admin-2"],
      }),
    ).toEqual(["admin-1", "admin-2", "follower-1"]);
  });

  it("manda il brief settimanale ad deciders ∪ follower (broadcast SENZA ticket, come il pulse)", () => {
    expect(
      recipientsFor(eventOfKind("project.brief"), {
        members: null,
        deciders: ["admin-1", "admin-2"],
        followers: ["follower-1", "admin-2"],
      }),
    ).toEqual(["admin-1", "admin-2", "follower-1"]);
  });

  it("il pulse non è una domanda al richiedente: raggiunge anche chi segue il progetto", () => {
    // Contrapposto esplicito a `job.awaiting_input`, che ha la stessa forma di
    // payload ma pubblico `requester`: qui i follower ci sono, là no.
    expect(recipientsFor(eventOfKind("project.pulse"), CTX)).toContain("follower-1");
    expect(recipientsFor(eventOfKind("job.awaiting_input"), CTX)).not.toContain("follower-1");
  });

  it("non duplica chi compare in più ruoli", () => {
    const recipients = recipientsFor(eventOfKind("job.pr_opened"), {
      members: null,
      deciders: ["u1"],
      followers: ["u1", "u2"],
      requestedBy: "u1",
      assignee: "u2",
      reporter: "u1",
    });
    expect(recipients).toEqual(["u1", "u2"]);
  });

  it("ignora i ruoli non risolti (undefined) e i contesti vuoti", () => {
    expect(recipientsFor(eventOfKind("job.pr_opened"), { deciders: [], members: null, followers: [] })).toEqual([]);
    expect(
      recipientsFor(eventOfKind("job.pr_opened"), {
        members: null,
        deciders: [],
        followers: [],
        assignee: "member-assignee",
      }),
    ).toEqual(["member-assignee"]);
  });

  it("manda la proposta dalla posta al SOLO proprietario della casella", () => {
    // ⚠️ Nemmeno gli admin: è l'invariante di privacy della fase 6, e questo è
    // l'unico kind che NON li include. Il contesto qui ne ha due, più i
    // follower e tutte le persone del ticket: nessuno di loro deve comparire.
    expect(
      recipientsFor(eventOfKind("google.proposal"), { ...CTX, mailboxOwner: "member-owner" }),
    ).toEqual(["member-owner"]);
  });

  it("senza proprietario risolto la proposta non ha destinatari", () => {
    // Il degrado giusto: meglio nessuna notifica che una notifica a chi non
    // possiede quella casella. Chi pubblica passa `mailboxOwnerUserId`.
    expect(recipientsFor(eventOfKind("google.proposal"), CTX)).toEqual([]);
  });

  it("tiene fuori chi non vede il progetto: follower, persone del ticket, deciders", () => {
    // Un follower uscito dal progetto, un assegnatario rimosso: il follow e
    // l'assegnazione restano in tabella, ma non producono più nulla.
    const ctx: RoutingContext = {
      ...CTX,
      members: ["admin-1", "admin-2", "member-assignee"],
    };
    expect(recipientsFor(eventOfKind("ticket.created"), ctx)).toEqual([
      "admin-1",
      "admin-2",
      "member-assignee",
    ]);
  });

  it("il richiedente rimosso non riceve la domanda, i deciders sì: non resta orfana", () => {
    const ctx: RoutingContext = { ...CTX, members: ["admin-1", "admin-2"] };
    expect(recipientsFor(eventOfKind("job.awaiting_input"), ctx)).toEqual(["admin-1", "admin-2"]);
  });

  it("la proposta dalla posta non passa dal filtro dei membri", () => {
    const ctx: RoutingContext = { ...CTX, members: [], mailboxOwner: "member-owner" };
    expect(recipientsFor(eventOfKind("google.proposal"), ctx)).toEqual(["member-owner"]);
  });

  it("l'avviso di sicurezza va al solo titolare dell'account: né deciders, né follower, né il proprietario di una casella", () => {
    const ctx: RoutingContext = { ...CTX, members: null, mailboxOwner: "member-owner", accountOwner: "member-x" };
    expect(recipientsFor(eventOfKind("security.alert"), ctx)).toEqual(["member-x"]);
    // Senza titolare, nessuno: mai un ripiego sugli admin.
    expect(recipientsFor(eventOfKind("security.alert"), { ...CTX, members: null })).toEqual([]);
  });

  it("la proposta PASSATA va ai decisori fra i membri, mai al proprietario né ai follower", () => {
    // Fase permessi: card nuova con un'audience di progetto. Il proprietario
    // ha già la sua card (e la passa perché non può decidere): anche se fosse
    // fra i decisori, qui non compare. Follower e persone del ticket no.
    const ctx: RoutingContext = {
      ...CTX,
      deciders: ["admin-1", "lead-1", "member-owner", "ex-member"],
      members: ["admin-1", "lead-1", "member-owner", "follower-1"],
      mailboxOwner: "member-owner",
    };
    expect(recipientsFor(eventOfKind("google.proposal_handed"), ctx)).toEqual(["admin-1", "lead-1"]);
  });

  it("i decisori della proposta passata dipendono dalle sue azioni", () => {
    const handed = eventOfKind("google.proposal_handed");
    // L'esempio crea una voce di backlog: `backlog.edit`.
    expect(deciderPermissionsFor(handed)).toEqual(["backlog.edit"]);
    if (handed.kind !== "google.proposal_handed") throw new Error("kind inatteso");
    expect(
      deciderPermissionsFor({
        ...handed,
        actions: [
          { type: "comment_ticket", ticketId: "t1", body: "x" },
          { type: "update_ticket", ticketId: "t1", status: "done" },
          { type: "create_milestone", projectId: "p1", name: "M" },
          { type: "ignore" },
        ],
      }),
    ).toEqual(["tickets.comment", "tickets.edit"]);
    // Solo «Non fare nulla»: nessun permesso pertinente, i soli full admin.
    expect(deciderPermissionsFor({ ...handed, actions: [{ type: "ignore" }] })).toEqual([null]);
    // Ogni altro kind: il permesso del kind, invariato.
    expect(deciderPermissionsFor(eventOfKind("job.plan_review"))).toEqual(["plans.approve"]);
  });

  it("non usa follower e persone del ticket per i kind decisionali", () => {
    expect(
      recipientsFor(eventOfKind("job.plan_review"), {
        members: null,
        deciders: [],
        followers: ["follower-1"],
        requestedBy: "member-requester",
        assignee: "member-assignee",
      }),
    ).toEqual([]);
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
