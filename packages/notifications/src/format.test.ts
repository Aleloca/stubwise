import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatNotification,
  sampleEvents,
  type NotificationEvent,
  type NotificationFormat,
} from "./format.js";

/**
 * Test della formattazione PURA (`./format.ts`): è la singola fonte di verità
 * su come un evento diventa il body del webhook. Non tocca il DB né la rete, e
 * non DEVE importarli — qui lo si verifica anche staticamente sul sorgente, così
 * il modulo resta importabile lato web senza trascinare `@stubwise/db`.
 */

const TICKET_CREATED: NotificationEvent = {
  kind: "ticket.created",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  source: "sdk_error",
  ticketUrl: "https://app.example.com/tickets/t1",
};

const PR_OPENED: NotificationEvent = {
  kind: "job.pr_opened",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  prUrl: "https://github.com/o/r/pull/7",
  ticketUrl: "https://app.example.com/tickets/t1",
  costUsd: 0.42,
};

const JOB_HELD: NotificationEvent = {
  kind: "job.held",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  type: "bug",
  effort: 4,
  ticketUrl: "https://app.example.com/tickets/t1",
};

const JOB_FAILED: NotificationEvent = {
  kind: "job.failed",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  error: "timeout del fix",
  ticketUrl: "https://app.example.com/tickets/t1",
};

const PR_CLOSED: NotificationEvent = {
  kind: "job.pr_closed",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  prUrl: "https://github.com/o/r/pull/7",
  ticketUrl: "https://app.example.com/tickets/t1",
};

const JOB_PLAN_REVIEW: NotificationEvent = {
  kind: "job.plan_review",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  ticketUrl: "https://app.example.com/tickets/42",
};

const BUDGET_HELD_TICKET: NotificationEvent = {
  kind: "job.budget_held",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  scope: "ticket",
  limitUsd: 2,
  spentUsd: 2.34,
  ticketUrl: "https://app.example.com/tickets/42",
};

const REVIEW_COMPLETED: NotificationEvent = {
  kind: "review.completed",
  ticketNumber: 42,
  ticketTitle: "Review PR #7 — fix checkout",
  projectName: "webapp",
  prUrl: "https://github.com/o/r/pull/7",
  ticketUrl: "https://app.example.com/tickets/42",
  verdict: "approve",
};

const DOCS_LIMIT_PAUSED: NotificationEvent = {
  kind: "docs.limit_paused",
  projectName: "webapp",
  repositoryName: "webapp-api",
  docsUrl: "https://app.example.com/docs/repo-1",
  reason: "limite di rate/usage del provider AI",
};

const BUDGET_HELD_MONTHLY: NotificationEvent = {
  kind: "job.budget_held",
  ticketNumber: 42,
  ticketTitle: "Crash al login",
  projectName: "webapp",
  scope: "monthly",
  limitUsd: 50,
  spentUsd: 51.7,
  ticketUrl: "https://app.example.com/tickets/42",
};

const MONITOR_ALERT: NotificationEvent = {
  kind: "monitor.alert",
  serverName: "web-prod-1",
  condition: "disk",
  detail: "disco al 93% (soglia 90%)",
  url: "https://app.example.com/monitor/servers/s1",
};

const MONITOR_RECOVERED: NotificationEvent = {
  kind: "monitor.recovered",
  serverName: "web-prod-1",
  condition: "disk",
  detail: "disco rientrato al 72%",
  url: "https://app.example.com/monitor/servers/s1",
};

const MONITOR_CHECK_DOWN: NotificationEvent = {
  kind: "monitor.alert",
  serverName: "web-prod-1",
  condition: "check_down",
  detail: "check api-health down: timeout",
  url: "https://app.example.com/monitor/servers/s1",
};

describe("formatNotification — contratto", () => {
  it("ogni formato dichiara content-type application/json", () => {
    for (const format of ["slack", "discord", "generic"] as NotificationFormat[]) {
      expect(formatNotification(TICKET_CREATED, format).contentType).toBe("application/json");
    }
  });
});

describe("formatNotification — slack (lingua default en)", () => {
  it("ticket.created → text mrkdwn con numero, titolo, progetto, source e link", () => {
    const { body } = formatNotification(TICKET_CREATED, "slack");
    const text = (body as { text: string }).text;
    expect(text).toContain("*#42*");
    expect(text).toContain("New ticket");
    expect(text).toContain("Crash al login");
    expect(text).toContain("webapp");
    expect(text).toContain("sdk_error");
    expect(text).toContain("<https://app.example.com/tickets/t1|Open>");
  });

  it("pr_opened → link PR e ticket, con il costo se presente", () => {
    const text = (formatNotification(PR_OPENED, "slack").body as { text: string }).text;
    expect(text).toContain("<https://github.com/o/r/pull/7|View PR>");
    expect(text).toContain("<https://app.example.com/tickets/t1|Ticket>");
    expect(text).toContain("0.42");
    expect(text).toContain("cost $0.42");
  });

  it("pr_opened senza costo → nessun riferimento al costo", () => {
    const text = (
      formatNotification({ ...PR_OPENED, costUsd: null }, "slack").body as { text: string }
    ).text;
    expect(text.toLowerCase()).not.toContain("cost");
  });

  it("job.held → tipo, effort N/5 e link", () => {
    const text = (formatNotification(JOB_HELD, "slack").body as { text: string }).text;
    expect(text).toContain("bug");
    expect(text).toContain("4/5");
    expect(text).toContain("<https://app.example.com/tickets/t1|Open>");
  });

  it("job.failed → messaggio d'errore", () => {
    const text = (formatNotification(JOB_FAILED, "slack").body as { text: string }).text;
    expect(text).toContain("timeout del fix");
  });

  it("pr_closed → PR closed without merging, link PR e ticket", () => {
    const text = (formatNotification(PR_CLOSED, "slack").body as { text: string }).text;
    expect(text).toContain("*#42*");
    expect(text).toContain("PR closed without merging");
    expect(text).toContain("<https://github.com/o/r/pull/7|View PR>");
    expect(text).toContain("<https://app.example.com/tickets/t1|Ticket>");
  });

  it("job.plan_review → plan awaiting approval, con link al ticket", () => {
    const text = (formatNotification(JOB_PLAN_REVIEW, "slack").body as { text: string }).text;
    expect(text).toContain("*#42*");
    expect(text).toContain("Plan awaiting approval");
    expect(text).toContain("<https://app.example.com/tickets/42|Review>");
  });

  it("job.budget_held (ticket) → budget exceeded, scope, importi a 2 decimali, link", () => {
    const text = (formatNotification(BUDGET_HELD_TICKET, "slack").body as { text: string }).text;
    expect(text).toContain("💸");
    expect(text).toContain("*#42*");
    expect(text).toContain("Budget exceeded (ticket)");
    expect(text).toContain("spent $2.34 of $2.00 limit");
    expect(text).toContain("<https://app.example.com/tickets/42|Open>");
  });

  it("job.budget_held (monthly) → scope monthly e importi a 2 decimali", () => {
    const text = (formatNotification(BUDGET_HELD_MONTHLY, "slack").body as { text: string }).text;
    expect(text).toContain("Budget exceeded (monthly)");
    expect(text).toContain("spent $51.70 of $50.00 limit");
  });

  it("review.completed (approve) → verdetto umano, link PR e ticket", () => {
    const text = (formatNotification(REVIEW_COMPLETED, "slack").body as { text: string }).text;
    expect(text).toContain("🔎");
    expect(text).toContain("*#42*");
    expect(text).toContain("PR review completed");
    expect(text).toContain("approval suggested");
    expect(text).toContain("<https://github.com/o/r/pull/7|View PR>");
    expect(text).toContain("<https://app.example.com/tickets/42|Ticket>");
  });

  it("review.completed (request_changes) → verdetto 'changes requested'", () => {
    const text = (
      formatNotification({ ...REVIEW_COMPLETED, verdict: "request_changes" }, "slack")
        .body as { text: string }
    ).text;
    expect(text).toContain("changes requested");
    expect(text).not.toContain("approval suggested");
  });

  it("docs.limit_paused → repository, progetto, link Docs; nessun riferimento #n", () => {
    const text = (formatNotification(DOCS_LIMIT_PAUSED, "slack").body as { text: string }).text;
    expect(text).toContain("⏸️");
    expect(text).toContain("Docs generation paused for webapp-api (webapp)");
    expect(text).toContain("provider usage limit reached");
    expect(text).toContain("It will resume automatically");
    expect(text).toContain("<https://app.example.com/docs/repo-1|Docs>");
    // Non c'è un ticket: nessun residuo di {ref} né riferimenti #n.
    expect(text).not.toContain("#");
    expect(text).not.toContain("{ref}");
  });

  it("monitor.alert → nome server, condizione, dettaglio e link; nessun riferimento #n", () => {
    const text = (formatNotification(MONITOR_ALERT, "slack").body as { text: string }).text;
    expect(text).toContain("🔴");
    expect(text).toContain("web-prod-1");
    expect(text).toContain("(disk)");
    expect(text).toContain("disco al 93% (soglia 90%)");
    expect(text).toContain("<https://app.example.com/monitor/servers/s1|Server>");
    // Non c'è un ticket: nessun residuo di {ref} né riferimenti #n.
    expect(text).not.toContain("#");
    expect(text).not.toContain("{ref}");
  });

  it("monitor.alert (check_down) → etichetta condizione 'check down'", () => {
    const text = (formatNotification(MONITOR_CHECK_DOWN, "slack").body as { text: string }).text;
    expect(text).toContain("(check down)");
    expect(text).toContain("check api-health down: timeout");
  });

  it("monitor.recovered → server rientrato, condizione, dettaglio e link", () => {
    const text = (formatNotification(MONITOR_RECOVERED, "slack").body as { text: string }).text;
    expect(text).toContain("🟢");
    expect(text).toContain("web-prod-1");
    expect(text).toContain("recovered");
    expect(text).toContain("(disk)");
    expect(text).toContain("disco rientrato al 72%");
    expect(text).toContain("<https://app.example.com/monitor/servers/s1|Server>");
  });
});

describe("formatNotification — slack (lingua it)", () => {
  it("ticket.created → testi italiani, link con label localizzata", () => {
    const text = (formatNotification(TICKET_CREATED, "slack", "it").body as { text: string }).text;
    expect(text).toContain("🐛 Nuovo ticket *#42* — Crash al login (webapp, sdk_error). ");
    expect(text).toContain("<https://app.example.com/tickets/t1|Apri>");
  });

  it("pr_opened → costo localizzato e label PR/Ticket", () => {
    const text = (formatNotification(PR_OPENED, "slack", "it").body as { text: string }).text;
    expect(text).toContain("PR aperta per *#42*");
    expect(text).toContain("(costo $0.42)");
    expect(text).toContain("<https://github.com/o/r/pull/7|Vedi PR>");
    expect(text).toContain("<https://app.example.com/tickets/t1|Ticket>");
  });

  it("pr_closed → PR chiusa senza merge", () => {
    const text = (formatNotification(PR_CLOSED, "slack", "it").body as { text: string }).text;
    expect(text).toContain("PR chiusa senza merge");
    expect(text).toContain("<https://github.com/o/r/pull/7|Vedi PR>");
  });

  it("job.plan_review → piano in attesa di approvazione, link Rivedi", () => {
    const text = (formatNotification(JOB_PLAN_REVIEW, "slack", "it").body as { text: string }).text;
    expect(text).toContain("Piano in attesa di approvazione — *#42*");
    expect(text).toContain("<https://app.example.com/tickets/42|Rivedi>");
  });

  it("job.budget_held (ticket) → testo italiano, scope localizzato, importi a 2 decimali", () => {
    const text = (formatNotification(BUDGET_HELD_TICKET, "slack", "it").body as { text: string })
      .text;
    expect(text).toContain("💸 Budget superato (ticket) — *#42*");
    expect(text).toContain("spesi $2.34 sul limite di $2.00");
    expect(text).toContain("<https://app.example.com/tickets/42|Apri>");
  });

  it("job.budget_held (monthly) → scope 'mensile' in italiano", () => {
    const text = (formatNotification(BUDGET_HELD_MONTHLY, "slack", "it").body as { text: string })
      .text;
    expect(text).toContain("Budget superato (mensile)");
    expect(text).toContain("spesi $51.70 sul limite di $50.00");
  });

  it("review.completed → testo e verdetto italiani, label PR/Ticket localizzate", () => {
    const text = (formatNotification(REVIEW_COMPLETED, "slack", "it").body as { text: string })
      .text;
    expect(text).toContain("Review della PR completata");
    expect(text).toContain("approvazione suggerita");
    expect(text).toContain("<https://github.com/o/r/pull/7|Vedi PR>");
    expect(text).toContain("<https://app.example.com/tickets/42|Ticket>");
  });

  it("review.completed (request_changes) it → 'modifiche richieste'", () => {
    const text = (
      formatNotification({ ...REVIEW_COMPLETED, verdict: "request_changes" }, "slack", "it")
        .body as { text: string }
    ).text;
    expect(text).toContain("modifiche richieste");
  });

  it("docs.limit_paused it → testo italiano e label Docs", () => {
    const text = (formatNotification(DOCS_LIMIT_PAUSED, "slack", "it").body as { text: string })
      .text;
    expect(text).toContain("Generazione Docs in pausa per webapp-api (webapp)");
    expect(text).toContain("limite di utilizzo del provider raggiunto");
    expect(text).toContain("Riprenderà da sola");
    expect(text).toContain("<https://app.example.com/docs/repo-1|Docs>");
  });
});

describe("formatNotification — discord", () => {
  it("usa content con link in stile markdown [label](url) (en)", () => {
    const content = (formatNotification(TICKET_CREATED, "discord").body as { content: string })
      .content;
    expect(content).toContain("**#42**");
    expect(content).toContain("New ticket");
    expect(content).toContain("[Open](https://app.example.com/tickets/t1)");
  });

  it("pr_opened: link PR e ticket in stile markdown (en)", () => {
    const content = (formatNotification(PR_OPENED, "discord").body as { content: string }).content;
    expect(content).toContain("[View PR](https://github.com/o/r/pull/7)");
    expect(content).toContain("[Ticket](https://app.example.com/tickets/t1)");
  });

  it("pr_closed: PR closed without merging, link in stile markdown (en)", () => {
    const content = (formatNotification(PR_CLOSED, "discord").body as { content: string }).content;
    expect(content).toContain("PR closed without merging");
    expect(content).toContain("[View PR](https://github.com/o/r/pull/7)");
    expect(content).toContain("[Ticket](https://app.example.com/tickets/t1)");
  });

  it("job.plan_review: plan awaiting approval, link in stile markdown (en)", () => {
    const content = (formatNotification(JOB_PLAN_REVIEW, "discord").body as { content: string })
      .content;
    expect(content).toContain("Plan awaiting approval");
    expect(content).toContain("[Review](https://app.example.com/tickets/42)");
  });

  it("it → testi italiani e label localizzate", () => {
    const content = (formatNotification(TICKET_CREATED, "discord", "it").body as { content: string })
      .content;
    expect(content).toContain("🐛 Nuovo ticket **#42** — Crash al login (webapp, sdk_error). ");
    expect(content).toContain("[Apri](https://app.example.com/tickets/t1)");
  });

  it("it pr_opened → costo e label PR/Ticket in italiano", () => {
    const content = (formatNotification(PR_OPENED, "discord", "it").body as { content: string })
      .content;
    expect(content).toContain("(costo $0.42)");
    expect(content).toContain("[Vedi PR](https://github.com/o/r/pull/7)");
    expect(content).toContain("[Ticket](https://app.example.com/tickets/t1)");
  });

  it("job.budget_held: budget exceeded, link in stile markdown (en)", () => {
    const content = (formatNotification(BUDGET_HELD_TICKET, "discord").body as { content: string })
      .content;
    expect(content).toContain("**#42**");
    expect(content).toContain("Budget exceeded (ticket)");
    expect(content).toContain("spent $2.34 of $2.00 limit");
    expect(content).toContain("[Open](https://app.example.com/tickets/42)");
  });

  it("job.budget_held it (monthly): scope 'mensile' e link Apri", () => {
    const content = (
      formatNotification(BUDGET_HELD_MONTHLY, "discord", "it").body as { content: string }
    ).content;
    expect(content).toContain("Budget superato (mensile)");
    expect(content).toContain("[Apri](https://app.example.com/tickets/42)");
  });

  it("review.completed: verdetto nel testo e link PR in stile markdown (en)", () => {
    const content = (formatNotification(REVIEW_COMPLETED, "discord").body as { content: string })
      .content;
    expect(content).toContain("PR review completed");
    expect(content).toContain("approval suggested");
    expect(content).toContain("[View PR](https://github.com/o/r/pull/7)");
    expect(content).toContain("[Ticket](https://app.example.com/tickets/42)");
  });

  it("docs.limit_paused: link Docs in stile markdown, nessun riferimento #n (en)", () => {
    const content = (formatNotification(DOCS_LIMIT_PAUSED, "discord").body as { content: string })
      .content;
    expect(content).toContain("Docs generation paused for webapp-api (webapp)");
    expect(content).toContain("[Docs](https://app.example.com/docs/repo-1)");
    expect(content).not.toContain("#");
  });

  it("monitor.alert: link Server in stile markdown, nessun riferimento #n (en)", () => {
    const content = (formatNotification(MONITOR_ALERT, "discord").body as { content: string })
      .content;
    expect(content).toContain("🔴");
    expect(content).toContain("web-prod-1");
    expect(content).toContain("(disk)");
    expect(content).toContain("[Server](https://app.example.com/monitor/servers/s1)");
    expect(content).not.toContain("#");
  });

  it("monitor.recovered: server rientrato, link Server in stile markdown (en)", () => {
    const content = (formatNotification(MONITOR_RECOVERED, "discord").body as { content: string })
      .content;
    expect(content).toContain("recovered");
    expect(content).toContain("[Server](https://app.example.com/monitor/servers/s1)");
  });
});

describe("formatNotification — generic", () => {
  it("ticket.created → payload piatto con source", () => {
    const body = formatNotification(TICKET_CREATED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("ticket.created");
    expect(body.ticketNumber).toBe(42);
    expect(body.title).toBe("Crash al login");
    expect(body.projectName).toBe("webapp");
    expect(body.source).toBe("sdk_error");
    expect(body.ticketUrl).toBe("https://app.example.com/tickets/t1");
    expect(typeof body.message).toBe("string");
  });

  it("pr_opened → include prUrl e costUsd", () => {
    const body = formatNotification(PR_OPENED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.pr_opened");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(body.costUsd).toBe(0.42);
  });

  it("pr_opened senza costo → costUsd null", () => {
    const body = formatNotification({ ...PR_OPENED, costUsd: null }, "generic").body as Record<
      string,
      unknown
    >;
    expect(body.costUsd).toBeNull();
  });

  it("job.held → include type ed effort", () => {
    const body = formatNotification(JOB_HELD, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.held");
    expect(body.type).toBe("bug");
    expect(body.effort).toBe(4);
  });

  it("job.failed → include error", () => {
    const body = formatNotification(JOB_FAILED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.failed");
    expect(body.error).toBe("timeout del fix");
  });

  it("pr_closed → include prUrl", () => {
    const body = formatNotification(PR_CLOSED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.pr_closed");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(typeof body.message).toBe("string");
    expect(body.message as string).toContain("PR closed without merging");
  });

  it("job.plan_review → payload piatto con messaggio di piano in attesa (en)", () => {
    const body = formatNotification(JOB_PLAN_REVIEW, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.plan_review");
    expect(body.ticketNumber).toBe(42);
    expect(body.title).toBe("Crash al login");
    expect(body.projectName).toBe("webapp");
    expect(body.ticketUrl).toBe("https://app.example.com/tickets/42");
    expect(body.message as string).toContain("Plan awaiting approval");
  });

  it("job.budget_held → payload piatto con scope e importi numerici (en)", () => {
    const body = formatNotification(BUDGET_HELD_TICKET, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("job.budget_held");
    expect(body.ticketNumber).toBe(42);
    expect(body.scope).toBe("ticket");
    expect(body.limitUsd).toBe(2);
    expect(body.spentUsd).toBe(2.34);
    expect(body.message as string).toContain("Budget exceeded (ticket)");
    expect(body.message as string).toContain("spent $2.34 of $2.00 limit");
  });

  it("job.budget_held (monthly) → scope mensile e message italiano senza markup", () => {
    const body = formatNotification(BUDGET_HELD_MONTHLY, "generic", "it").body as Record<
      string,
      unknown
    >;
    expect(body.scope).toBe("monthly");
    const message = body.message as string;
    expect(message).toContain("Budget superato (mensile)");
    expect(message).toContain("spesi $51.70 sul limite di $50.00");
    expect(message).not.toContain("💸");
    expect(message).not.toContain("[");
    expect(message.endsWith(".")).toBe(true);
  });

  it("review.completed → payload piatto con prUrl e verdict machine-readable", () => {
    const body = formatNotification(REVIEW_COMPLETED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("review.completed");
    expect(body.ticketNumber).toBe(42);
    expect(body.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(body.verdict).toBe("approve");
    expect(body.ticketUrl).toBe("https://app.example.com/tickets/42");
    expect(body.message as string).toContain("PR review completed");
    expect(body.message as string).toContain("approval suggested");
    expect(body.message as string).not.toContain("✅");
    expect(body.message as string).not.toContain("🔎");
  });

  it("review.completed (request_changes) → verdict grezzo nel payload", () => {
    const body = formatNotification(
      { ...REVIEW_COMPLETED, verdict: "request_changes" },
      "generic",
    ).body as Record<string, unknown>;
    expect(body.verdict).toBe("request_changes");
    expect(body.message as string).toContain("changes requested");
  });

  it("docs.limit_paused → payload piatto con repositoryName/docsUrl/reason, senza campi ticket", () => {
    const body = formatNotification(DOCS_LIMIT_PAUSED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("docs.limit_paused");
    expect(body.projectName).toBe("webapp");
    expect(body.repositoryName).toBe("webapp-api");
    expect(body.docsUrl).toBe("https://app.example.com/docs/repo-1");
    expect(body.reason).toBe("limite di rate/usage del provider AI");
    // Nessun campo di ticket: è il primo evento della union senza ticket.
    expect(body).not.toHaveProperty("ticketNumber");
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("ticketUrl");
    const message = body.message as string;
    expect(message).toBe(
      "Docs generation paused for webapp-api (webapp): provider usage limit reached. It will resume automatically.",
    );
  });

  it("docs.limit_paused it → message italiano senza markup", () => {
    const body = formatNotification(DOCS_LIMIT_PAUSED, "generic", "it").body as Record<
      string,
      unknown
    >;
    expect(body.message as string).toBe(
      "Generazione Docs in pausa per webapp-api (webapp): limite di utilizzo del provider raggiunto. Riprenderà da sola.",
    );
  });

  it("monitor.alert → payload piatto con serverName/condition/detail/url, senza campi ticket", () => {
    const body = formatNotification(MONITOR_ALERT, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("monitor.alert");
    expect(body.serverName).toBe("web-prod-1");
    // La condizione grezza (machine-readable) resta l'enum, non l'etichetta.
    expect(body.condition).toBe("disk");
    expect(body.detail).toBe("disco al 93% (soglia 90%)");
    expect(body.url).toBe("https://app.example.com/monitor/servers/s1");
    expect(body).not.toHaveProperty("ticketNumber");
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("ticketUrl");
    const message = body.message as string;
    expect(message).toContain("web-prod-1");
    expect(message).toContain("(disk)");
    expect(message).toContain("disco al 93% (soglia 90%)");
    // Payload machine-readable: niente emoji né markup.
    expect(message).not.toContain("🔴");
    expect(message).not.toContain("[");
  });

  it("monitor.recovered → event grezzo e message di ripristino", () => {
    const body = formatNotification(MONITOR_RECOVERED, "generic").body as Record<string, unknown>;
    expect(body.event).toBe("monitor.recovered");
    expect(body.condition).toBe("disk");
    expect(body.message as string).toContain("recovered");
  });

  it("message → frase senza markup né link, niente emoji né spazio finale (en)", () => {
    const body = formatNotification(TICKET_CREATED, "generic").body as Record<string, unknown>;
    const message = body.message as string;
    expect(message).toBe(
      "New ticket #42 — Crash al login (webapp, sdk_error).",
    );
    // niente residui di emoji/markup/link
    expect(message).not.toContain("🐛");
    expect(message).not.toContain("*");
    expect(message).not.toContain("<");
    expect(message).not.toContain("[");
  });

  it("message → frase italiana quando lang='it'", () => {
    const body = formatNotification(TICKET_CREATED, "generic", "it").body as Record<
      string,
      unknown
    >;
    expect(body.message as string).toBe(
      "Nuovo ticket #42 — Crash al login (webapp, sdk_error).",
    );
  });

  it("pr_opened it → message col suffisso costo italiano", () => {
    const body = formatNotification(PR_OPENED, "generic", "it").body as Record<string, unknown>;
    expect(body.message as string).toBe(
      "PR aperta per #42 — Crash al login (costo $0.42).",
    );
  });
});

describe("sampleEvents", () => {
  it("produce un esempio per ciascun kind, con link sotto baseUrl", () => {
    const events = sampleEvents("https://app.example.com/");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "ticket.created",
      "job.pr_opened",
      "job.pr_closed",
      "job.held",
      "job.plan_review",
      "job.budget_held",
      "job.failed",
      "review.completed",
      "docs.limit_paused",
      "monitor.alert",
      "monitor.recovered",
    ]);
    for (const event of events) {
      // Eventi senza ticket: il link non è un ticketUrl ma la superficie propria.
      if (event.kind === "docs.limit_paused") {
        expect(event.docsUrl.startsWith("https://app.example.com/docs/")).toBe(true);
      } else if (event.kind === "monitor.alert" || event.kind === "monitor.recovered") {
        expect(event.url.startsWith("https://app.example.com/monitor/")).toBe(true);
      } else {
        expect(event.ticketUrl.startsWith("https://app.example.com/tickets/")).toBe(true);
      }
    }
  });

  it("ogni esempio si formatta in tutti i formati senza errori", () => {
    for (const event of sampleEvents("https://app.example.com")) {
      for (const format of ["slack", "discord", "generic"] as NotificationFormat[]) {
        expect(() => formatNotification(event, format)).not.toThrow();
      }
    }
  });
});

describe("indipendenza dal DB", () => {
  it("il sorgente di format.ts non importa @stubwise/db né drizzle-orm", () => {
    const src = readFileSync(fileURLToPath(new URL("./format.ts", import.meta.url)), "utf8");
    // Solo le righe di import: i commenti possono citare i nomi a parole.
    const imports = src.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports.join("\n")).not.toMatch(/@stubwise\/db/);
    expect(imports.join("\n")).not.toMatch(/drizzle-orm/);
  });
});
