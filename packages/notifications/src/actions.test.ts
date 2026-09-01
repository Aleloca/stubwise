import { describe, expect, it } from "vitest";
import { actionsFor, actorAllows, kindOffers, openUrl, type ActionActor } from "./actions.js";

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
    expect(
      actionsFor(
        { kind: "job.plan_review", requestedByUserId: null },
        "awaiting_plan_approval",
        maintainer,
      ),
    ).toEqual(["approve_plan", "reject_plan", "open", "snooze", "handled"]);
  });

  it("job.plan_review in attesa + member → nessuna decisione sul piano", () => {
    expect(
      actionsFor(
        { kind: "job.plan_review", requestedByUserId: null },
        "awaiting_plan_approval",
        operator,
      ),
    ).toEqual(["open", "snooze", "handled"]);
  });

  it("job.plan_review con job già in lavorazione → niente approve/reject nemmeno all'admin", () => {
    expect(
      actionsFor({ kind: "job.plan_review", requestedByUserId: null }, "fixing", maintainer),
    ).toEqual(["open", "snooze", "handled"]);
  });

  it("job.budget_held → relaunch solo all'admin", () => {
    expect(
      actionsFor({ kind: "job.budget_held", requestedByUserId: null }, "held", maintainer),
    ).toEqual(["relaunch", "open", "snooze", "handled"]);
    expect(
      actionsFor({ kind: "job.budget_held", requestedByUserId: null }, "held", operator),
    ).toEqual(["open", "snooze", "handled"]);
  });

  it("job.held → relaunch anche al member", () => {
    expect(actionsFor({ kind: "job.held", requestedByUserId: null }, "held", operator)).toEqual([
      "relaunch",
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.failed e job.pr_closed → relaunch a tutti", () => {
    expect(
      actionsFor({ kind: "job.failed", requestedByUserId: null }, "failed", operator),
    ).toContain("relaunch");
    expect(
      actionsFor({ kind: "job.pr_closed", requestedByUserId: null }, "pr_merged", operator),
    ).toContain("relaunch");
  });

  it("job.failed con l'ultimo job del ticket in volo → niente relaunch", () => {
    expect(
      actionsFor({ kind: "job.failed", requestedByUserId: null }, "queued", maintainer),
    ).toEqual(["open", "snooze", "handled"]);
  });

  it("job.failed con l'ultimo job fermo su una domanda → niente relaunch", () => {
    // `awaiting_input` è uno stato IN VOLO: il job non è finito, aspetta una
    // risposta e tiene viva la sessione CLI da riprendere. Rilanciarlo la
    // butterebbe via. Se sparisse da `IN_FLIGHT_JOB_STATUSES`, qui comparirebbe
    // un `relaunch` che non deve esistere.
    expect(
      actionsFor({ kind: "job.failed", requestedByUserId: null }, "awaiting_input", maintainer),
    ).toEqual(["open", "snooze", "handled"]);
  });

  it("job.awaiting_input: il RICHIEDENTE (anche member) può rispondere", () => {
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: operator.id },
        "awaiting_input",
        operator,
      ),
    ).toEqual(["answer", "open", "snooze"]);
  });

  it("job.awaiting_input: un ALTRO member non può rispondere (è identità, non ruolo)", () => {
    const estraneo: ActionActor = { id: "u-altro-member", role: "member" };
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: operator.id },
        "awaiting_input",
        estraneo,
      ),
    ).toEqual(["open", "snooze"]);
  });

  it("job.awaiting_input: l'admin può rispondere anche se non è il richiedente", () => {
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: operator.id },
        "awaiting_input",
        maintainer,
      ),
    ).toEqual(["answer", "open", "snooze"]);
  });

  it("job.awaiting_input di un run dell'automazione (nessun richiedente): solo l'admin risponde", () => {
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: null },
        "awaiting_input",
        maintainer,
      ),
    ).toEqual(["answer", "open", "snooze"]);
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: null },
        "awaiting_input",
        operator,
      ),
    ).toEqual(["open", "snooze"]);
  });

  it("job.awaiting_input con il job ripartito (non più in attesa) → niente answer", () => {
    expect(
      actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: operator.id },
        "fixing",
        operator,
      ),
    ).toEqual(["open", "snooze"]);
    expect(
      actionsFor({ kind: "job.awaiting_input", requestedByUserId: operator.id }, null, maintainer),
    ).toEqual(["open", "snooze"]);
  });

  it("job.awaiting_input NON offre `handled`: una domanda si chiude solo rispondendo", () => {
    for (const actor of [maintainer, operator]) {
      const actions = actionsFor(
        { kind: "job.awaiting_input", requestedByUserId: operator.id },
        "awaiting_input",
        actor,
      );
      expect(actions).not.toContain("handled");
      expect(actions).toContain("open");
      expect(actions).toContain("snooze");
    }
    // Il catalogo lo dice anche fuori da `actionsFor`: la rotta `handled` su
    // questo kind è una richiesta senza senso, non un permesso mancante.
    expect(kindOffers("job.awaiting_input", "handled")).toBe(false);
    expect(kindOffers("job.plan_review", "handled")).toBe(true);
  });

  it("project.pulse: il catalogo offre `answer` ed è ARCHIVIABILE (ignorare un suggerimento si può)", () => {
    // Il contrapposto della domanda dell'agente: là `handled` è negata perché
    // archiviarla lascerebbe un job fermo, qui non c'è nessun job dietro e non
    // dare seguito a una proposta è una risposta legittima.
    expect(kindOffers("project.pulse", "answer")).toBe(true);
    expect(kindOffers("project.pulse", "handled")).toBe(true);
    expect(kindOffers("project.pulse", "relaunch")).toBe(false);
    expect(kindOffers("project.pulse", "approve_plan")).toBe(false);
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
      expect(actionsFor({ kind, requestedByUserId: null }, null, maintainer)).toEqual([
        "open",
        "snooze",
        "handled",
      ]);
    }
  });
});

describe("actorAllows su answer", () => {
  it("richiedente o admin, chiunque altro no", () => {
    const domanda = { kind: "job.awaiting_input", requestedByUserId: operator.id } as const;
    expect(actorAllows(domanda, "answer", operator)).toBe(true);
    expect(actorAllows(domanda, "answer", maintainer)).toBe(true);
    expect(actorAllows(domanda, "answer", { id: "u-altro", role: "member" })).toBe(false);
  });

  it("`answer` non esiste sugli altri kind, nemmeno per l'admin", () => {
    expect(
      actorAllows(
        { kind: "job.plan_review", requestedByUserId: maintainer.id },
        "answer",
        maintainer,
      ),
    ).toBe(false);
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

  it("il pulse non ha ticket: `Apri` porta alla pagina backlog del progetto", () => {
    expect(
      openUrl({
        kind: "project.pulse",
        pulseId: "1c9e4f70-5555-4666-8777-888899990000",
        projectName: "webapp",
        projectUrl: "https://stubwise.test/projects/p1/backlog",
        idleDays: 3,
        question: "Da quale proposta partiamo?",
        options: [{ label: "Export CSV" }],
        recommendedIndex: 0,
        allowFreeText: false,
        proposals: [
          {
            backlogItemId: "aa11bb22-1111-4222-8333-444455556666",
            title: "Export CSV",
            urgency: "high",
            effort: 2,
            hasAnalysis: true,
          },
        ],
      }),
    ).toBe("https://stubwise.test/projects/p1/backlog");
  });
});
