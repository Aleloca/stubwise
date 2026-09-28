import { UNKNOWN } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import {
  activeAutomationCount,
  backlogSummary,
  buttonDestination,
  monitorAlert,
  nowIsEmpty,
  othersRows,
  rowDestination,
  yourTurnCount,
  yourTurnRows,
} from "./project-hub";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-09-28T10:00:00.000Z");

function summary(overrides: Partial<Reader<ProjectPulseSummary>> = {}): Reader<ProjectPulseSummary> {
  return {
    projectId: PROJECT_ID,
    projectName: "Negozio online",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 0,
    idleDays: 0,
    stalled: [],
    waitingForMerge: [],
    lastReportDate: null,
    ...overrides,
  };
}

const QUESTION = {
  kind: "question" as const,
  ticketId: "22222222-2222-4222-8222-222222222227",
  ticketNumber: 27,
  title: "Checkout fallisce con carta salvata",
  notificationId: "44444444-4444-4444-8444-444444444444",
  priority: "urgent" as const,
};

const PLAN = {
  kind: "plan_approval" as const,
  ticketId: "22222222-2222-4222-8222-222222222241",
  ticketNumber: 41,
  title: "Export CSV degli ordini",
  notificationId: "55555555-5555-4555-8555-555555555555",
  priority: "high" as const,
};

/** La PR come la manda un server che NON conosce ancora il repository. */
const PR_SENZA_REPO = {
  ticketId: "22222222-2222-4222-8222-222222222238",
  ticketNumber: 38,
  title: "Aggiorna dipendenze del worker",
  prUrl: "https://example.com/pr/38",
  canMerge: true,
};

const PR = { ...PR_SENZA_REPO, repositoryId: REPO_ID, repositoryName: "web-app" };

describe("«Tocca a te»: le righe e i loro bottoni", () => {
  it("domande e piani di waitingForYou, poi le PR con canMerge — in quest'ordine", () => {
    const rows = yourTurnRows(summary({ waitingForYou: [QUESTION, PLAN], waitingForMerge: [PR] }));

    expect(rows.map((row) => row.ticketNumber)).toEqual([27, 41, 38]);
    expect(rows.map((row) => row.action)).toEqual(["answer", "approve", "merge"]);
  });

  it("una PR SENZA canMerge non è mai fra le tue: la regola la dice il server", () => {
    const rows = yourTurnRows(summary({ waitingForMerge: [{ ...PR, canMerge: false }] }));
    expect(rows).toEqual([]);
  });

  it("una PR con canMerge ma SENZA repositoryId (server più vecchio): la riga c'è, il bottone Mergia no", () => {
    const rows = yourTurnRows(summary({ waitingForMerge: [PR_SENZA_REPO] }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBeNull();
    expect(buttonDestination(rows[0]!)).toBeNull();
    // …e la riga resta premibile verso il ticket.
    expect(rowDestination(rows[0]!)).toEqual({ kind: "ticket", ticketId: PR.ticketId });
  });

  it("un tipo di attesa SCONOSCIUTO (server più nuovo) non inventa un bottone", () => {
    const rows = yourTurnRows(summary({ waitingForYou: [{ ...QUESTION, kind: UNKNOWN }] }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBeNull();
    expect(buttonDestination(rows[0]!)).toBeNull();
  });

  it("Rispondi porta alla card d'inbox della domanda", () => {
    const [row] = yourTurnRows(summary({ waitingForYou: [QUESTION] }));
    expect(buttonDestination(row!)).toEqual({ kind: "inboxCard", notificationId: QUESTION.notificationId });
  });

  it("Approva porta al TICKET, dove il piano si legge — non approva dalla riga", () => {
    const [row] = yourTurnRows(summary({ waitingForYou: [PLAN] }));
    expect(buttonDestination(row!)).toEqual({ kind: "ticket", ticketId: PLAN.ticketId });
  });

  it("Mergia apre la conferma, con tutto ciò che serve alla rotta", () => {
    const [row] = yourTurnRows(summary({ waitingForMerge: [PR] }));
    expect(buttonDestination(row!)).toEqual({
      kind: "confirmMerge",
      ticketId: PR.ticketId,
      ticketNumber: 38,
      title: PR.title,
      repositoryId: REPO_ID,
      repositoryName: "web-app",
      prUrl: PR.prUrl,
    });
  });

  it("il tap sulla riga, fuori dal bottone, porta sempre al ticket", () => {
    const rows = yourTurnRows(summary({ waitingForYou: [QUESTION, PLAN], waitingForMerge: [PR] }));
    expect(rows.map((row) => rowDestination(row))).toEqual([
      { kind: "ticket", ticketId: QUESTION.ticketId },
      { kind: "ticket", ticketId: PLAN.ticketId },
      { kind: "ticket", ticketId: PR.ticketId },
    ]);
  });

  it("due PR dello stesso ticket su due repository sono due righe distinte", () => {
    const rows = yourTurnRows(
      summary({
        waitingForMerge: [PR, { ...PR, prUrl: "https://example.com/pr/39", repositoryId: PROJECT_ID, repositoryName: "api" }],
      }),
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});

describe("il badge di Adesso", () => {
  it("conta domande, piani e le PR che PUOI mergiare", () => {
    expect(
      yourTurnCount(summary({ waitingForYou: [QUESTION, PLAN], waitingForMerge: [PR, { ...PR, prUrl: "x", canMerge: false }] })),
    ).toBe(3);
  });

  it("zero quando non c'è niente da fare", () => {
    expect(yourTurnCount(summary({ waitingForMerge: [{ ...PR, canMerge: false }] }))).toBe(0);
  });

  it("una PR senza repository conta lo stesso: tocca a te anche se da qui non la mergi", () => {
    expect(yourTurnCount(summary({ waitingForMerge: [PR_SENZA_REPO] }))).toBe(1);
  });
});

describe("«Aspetta altri · fermi»", () => {
  it("nell'ordine del §4: attese altrui, poi PR senza canMerge, poi i fermi", () => {
    const rows = othersRows(
      summary({
        waitingForOthers: [{ ...PLAN, ticketNumber: 33, who: { kind: "requester" } }],
        waitingForMerge: [{ ...PR, canMerge: false }],
        stalled: [
          {
            ticketId: "22222222-2222-4222-8222-222222222219",
            ticketNumber: 19,
            title: "Notifiche email duplicate",
            stalledSince: "2026-09-19T08:00:00.000Z",
            reason: "to_prepare",
          },
        ],
      }),
      NOW,
    );

    expect(rows.map((row) => row.ticketNumber)).toEqual([33, 38, 19]);
    expect(rows.map((row) => row.trailing)).toEqual([
      { kind: "who", who: "requester" },
      { kind: "merge" },
      { kind: "stalled", days: 9 },
    ]);
  });

  it("chi aspetta un maintainer lo dice; un ruolo SCONOSCIUTO ricade sul richiedente", () => {
    const rows = othersRows(
      summary({
        waitingForOthers: [
          { ...PLAN, who: { kind: "maintainer" } },
          { ...QUESTION, who: { kind: UNKNOWN } },
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => row.trailing)).toEqual([
      { kind: "who", who: "maintainer" },
      { kind: "who", who: "requester" },
    ]);
  });

  it("ogni riga porta al ticket", () => {
    const rows = othersRows(summary({ waitingForMerge: [{ ...PR, canMerge: false }] }), NOW);
    expect(rowDestination(rows[0]!)).toEqual({ kind: "ticket", ticketId: PR.ticketId });
  });
});

describe("Adesso vuoto", () => {
  it("vuoto solo quando non c'è niente in nessuno dei tre blocchi", () => {
    expect(nowIsEmpty(summary())).toBe(true);
    expect(nowIsEmpty(summary({ waitingForYou: [QUESTION] }))).toBe(false);
    expect(nowIsEmpty(summary({ running: [{ ...QUESTION, sinceMinutes: 3 }] }))).toBe(false);
    expect(nowIsEmpty(summary({ waitingForMerge: [{ ...PR, canMerge: false }] }))).toBe(false);
  });

  it("il backlog pronto NON riempie Adesso: sta nella tab Lavoro", () => {
    expect(nowIsEmpty(summary({ backlogReadyCount: 4 }))).toBe(true);
  });
});

describe("il monitor: un server giù", () => {
  const server = (overrides: { id?: string; name?: string; status?: string; checksDown?: number }) => ({
    id: overrides.id ?? "77777777-7777-4777-8777-777777777777",
    name: overrides.name ?? "prod-eu-1",
    status: overrides.status ?? "online",
    checksDown: overrides.checksDown ?? 0,
  });

  it("nessun allarme quando tutto è su, e nemmeno per un server mai connesso", () => {
    expect(monitorAlert([server({}), server({ status: "never_connected" })])).toBeNull();
    expect(monitorAlert([])).toBeNull();
  });

  it("un controllo giù è un allarme, col nome del server e il numero dei controlli", () => {
    expect(monitorAlert([server({ checksDown: 1 })])).toEqual({
      serverId: "77777777-7777-4777-8777-777777777777",
      serverName: "prod-eu-1",
      offline: false,
      checksDown: 1,
      brokenCount: 1,
      serverCount: 1,
    });
  });

  it("un server offline è un allarme anche senza controlli giù", () => {
    expect(monitorAlert([server({ status: "offline" })])?.offline).toBe(true);
  });

  it("con più server giù nomina il primo e li conta tutti", () => {
    const alert = monitorAlert([server({}), server({ id: "a", name: "db-1", status: "offline" }), server({ id: "b", name: "api-2", checksDown: 2 })]);
    expect(alert?.serverName).toBe("db-1");
    expect(alert?.brokenCount).toBe(2);
    expect(alert?.serverCount).toBe(3);
  });
});

describe("le automazioni accese", () => {
  const project = {
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    weeklyBriefEnabled: false,
  };

  it("zero se è tutto spento", () => {
    expect(activeAutomationCount(project)).toBe(0);
  });

  it("conta i cinque toggle quando sono accesi", () => {
    expect(
      activeAutomationCount({
        docAutoUpdate: true,
        dailyReportEnabled: true,
        backlogEnabled: true,
        pulseEnabled: true,
        weeklyBriefEnabled: true,
      }),
    ).toBe(5);
  });

  it("il pulse SENZA backlog non conta: non ha niente da proporre, e il poller non lo pesca", () => {
    expect(activeAutomationCount({ ...project, pulseEnabled: true })).toBe(0);
    expect(activeAutomationCount({ ...project, pulseEnabled: true, backlogEnabled: true })).toBe(2);
  });
});

describe("il riassunto del backlog", () => {
  it("pronte, da preparare e la frazione della barra", () => {
    expect(backlogSummary(11, 3)).toEqual({ total: 11, ready: 3, toPrepare: 8, readyFraction: 3 / 11 });
  });

  it("un backlog vuoto non divide per zero", () => {
    expect(backlogSummary(0, 0)).toEqual({ total: 0, ready: 0, toPrepare: 0, readyFraction: 0 });
  });

  it("due risposte che raccontano momenti diversi non danno un negativo né una barra oltre il pieno", () => {
    expect(backlogSummary(2, 3)).toEqual({ total: 2, ready: 2, toPrepare: 0, readyFraction: 1 });
  });
});
