import { describe, expect, it } from "vitest";
import { actionsFor, openUrl, type ActionActor } from "./actions.js";

/**
 * Test PURI del catalogo delle azioni: nessun DB, nessun container.
 *
 * Provenienza: questi casi stavano in `apps/server/src/services/inbox.test.ts`
 * (che gira su un Postgres reale via testcontainers). Con `actionsFor` spostata
 * qui — la usa anche il worker per i bottoni del DM Slack — sono stati SPOSTATI
 * (non duplicati): il servizio inbox continua a ri-esportare la funzione, ma i
 * suoi test coprono ciò che ha davvero bisogno del DB (executeAction, listInbox).
 */

const maintainer: ActionActor = { id: "u-admin", role: "admin" };
const operator: ActionActor = { id: "u-member", role: "member" };

describe("actionsFor", () => {
  it("job.plan_review in attesa + admin → approva, rifiuta, apri, snooze, gestita", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "awaiting_plan_approval", maintainer)).toEqual([
      "approve_plan",
      "reject_plan",
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.plan_review in attesa + member → nessuna decisione sul piano", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "awaiting_plan_approval", operator)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.plan_review con job già in lavorazione → niente approve/reject nemmeno all'admin", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "fixing", maintainer)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.budget_held → relaunch solo all'admin", () => {
    expect(actionsFor({ kind: "job.budget_held" }, "held", maintainer)).toEqual([
      "relaunch",
      "open",
      "snooze",
      "handled",
    ]);
    expect(actionsFor({ kind: "job.budget_held" }, "held", operator)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.held → relaunch anche al member", () => {
    expect(actionsFor({ kind: "job.held" }, "held", operator)).toEqual([
      "relaunch",
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.failed e job.pr_closed → relaunch a tutti", () => {
    expect(actionsFor({ kind: "job.failed" }, "failed", operator)).toContain("relaunch");
    expect(actionsFor({ kind: "job.pr_closed" }, "pr_merged", operator)).toContain("relaunch");
  });

  it("job.failed con l'ultimo job del ticket in volo → niente relaunch", () => {
    expect(actionsFor({ kind: "job.failed" }, "queued", maintainer)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("kind informativi → solo apri, snooze, gestita", () => {
    for (const kind of [
      "job.pr_opened",
      "review.completed",
      "ticket.created",
      "docs.limit_paused",
      "monitor.alert",
      "monitor.recovered",
    ] as const) {
      expect(actionsFor({ kind }, null, maintainer)).toEqual(["open", "snooze", "handled"]);
    }
  });
});

describe("openUrl", () => {
  it("gli eventi il cui soggetto è la PR portano alla PR, gli altri al ticket", () => {
    expect(
      openUrl({
        kind: "job.pr_opened",
        ticketNumber: 1,
        ticketTitle: "t",
        projectName: "p",
        prUrl: "https://git.test/pr/1",
        ticketUrl: "https://stubwise.test/tickets/1",
      }),
    ).toBe("https://git.test/pr/1");
    expect(
      openUrl({
        kind: "job.pr_closed",
        ticketNumber: 1,
        ticketTitle: "t",
        projectName: "p",
        prUrl: "https://git.test/pr/1",
        ticketUrl: "https://stubwise.test/tickets/1",
      }),
    ).toBe("https://stubwise.test/tickets/1");
  });
});
