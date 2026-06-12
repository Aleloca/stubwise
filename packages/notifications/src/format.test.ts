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

describe("formatNotification — contratto", () => {
  it("ogni formato dichiara content-type application/json", () => {
    for (const format of ["slack", "discord", "generic"] as NotificationFormat[]) {
      expect(formatNotification(TICKET_CREATED, format).contentType).toBe("application/json");
    }
  });
});

describe("formatNotification — slack", () => {
  it("ticket.created → text mrkdwn con numero, titolo, progetto, source e link", () => {
    const { body } = formatNotification(TICKET_CREATED, "slack");
    const text = (body as { text: string }).text;
    expect(text).toContain("*#42*");
    expect(text).toContain("Crash al login");
    expect(text).toContain("webapp");
    expect(text).toContain("sdk_error");
    expect(text).toContain("<https://app.example.com/tickets/t1|Apri>");
  });

  it("pr_opened → link PR e ticket, con il costo se presente", () => {
    const text = (formatNotification(PR_OPENED, "slack").body as { text: string }).text;
    expect(text).toContain("<https://github.com/o/r/pull/7|Vedi PR>");
    expect(text).toContain("<https://app.example.com/tickets/t1|Ticket>");
    expect(text).toContain("0.42");
  });

  it("pr_opened senza costo → nessun riferimento al costo", () => {
    const text = (
      formatNotification({ ...PR_OPENED, costUsd: null }, "slack").body as { text: string }
    ).text;
    expect(text.toLowerCase()).not.toContain("costo");
  });

  it("job.held → tipo, effort N/5 e link", () => {
    const text = (formatNotification(JOB_HELD, "slack").body as { text: string }).text;
    expect(text).toContain("bug");
    expect(text).toContain("4/5");
  });

  it("job.failed → messaggio d'errore", () => {
    const text = (formatNotification(JOB_FAILED, "slack").body as { text: string }).text;
    expect(text).toContain("timeout del fix");
  });
});

describe("formatNotification — discord", () => {
  it("usa content con link in stile markdown [label](url)", () => {
    const content = (formatNotification(TICKET_CREATED, "discord").body as { content: string })
      .content;
    expect(content).toContain("#42");
    expect(content).toContain("[Apri](https://app.example.com/tickets/t1)");
  });

  it("pr_opened: link PR e ticket in stile markdown", () => {
    const content = (formatNotification(PR_OPENED, "discord").body as { content: string }).content;
    expect(content).toContain("[Vedi PR](https://github.com/o/r/pull/7)");
    expect(content).toContain("[Ticket](https://app.example.com/tickets/t1)");
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
});

describe("sampleEvents", () => {
  it("produce un esempio per ciascuno dei 4 kind, con link sotto baseUrl", () => {
    const events = sampleEvents("https://app.example.com/");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["ticket.created", "job.pr_opened", "job.held", "job.failed"]);
    for (const event of events) {
      expect(event.ticketUrl.startsWith("https://app.example.com/tickets/")).toBe(true);
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
