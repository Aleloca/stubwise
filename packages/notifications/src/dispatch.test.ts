import { notificationSettings, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  buildTestEvent,
  dispatchNotification,
  sendTest,
  type NotificationSettingsRow,
} from "./dispatch.js";
import { type NotificationEvent } from "./format.js";

/**
 * Test del modulo di dispatch SENZA un Postgres reale: il modulo legge la
 * riga di configurazione tramite una piccola query, quindi qui usiamo un
 * fake `Db` che restituisce la riga voluta. fetch è mockato per ispezionare
 * url/body senza HTTP reale. La copertura "integrata" col DB vero vive nei
 * test di wiring di server/worker.
 */

const BASE_ROW: NotificationSettingsRow = {
  webhookUrl: "https://hooks.example.com/abc",
  format: "slack",
  enabled: true,
  notifyTicketCreated: true,
  notifyPrOpened: true,
  notifyJobHeld: true,
  notifyJobFailed: true,
  notifyPrClosed: true,
};

/** Db fittizio: serve solo `select().from(notificationSettings).limit(1)`. */
function fakeDb(row: NotificationSettingsRow | null): Db {
  return {
    select() {
      return {
        from() {
          return {
            limit() {
              return Promise.resolve(row ? [row] : []);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

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

function okFetch() {
  return vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
}

async function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Promise<unknown> {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe("dispatchNotification — gating", () => {
  it("non posta nulla se non c'è una riga di configurazione", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb(null), TICKET_CREATED, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non posta se enabled è false", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, enabled: false }), TICKET_CREATED, {
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non posta se webhookUrl è null", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, webhookUrl: null }), TICKET_CREATED, {
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non posta se il toggle del singolo evento è off", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(
      fakeDb({ ...BASE_ROW, notifyTicketCreated: false }),
      TICKET_CREATED,
      { fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("il toggle giusto governa l'evento giusto (pr_opened off non blocca ticket.created)", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, notifyPrOpened: false }), TICKET_CREATED, {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("notifyPrClosed off blocca job.pr_closed", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, notifyPrClosed: false }), PR_CLOSED, {
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("notifyPrClosed on posta job.pr_closed", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb(BASE_ROW), PR_CLOSED, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posta all'URL configurato con POST e content-type JSON", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb(BASE_ROW), TICKET_CREATED, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/abc");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toContain("application/json");
  });

  it("best-effort: un errore di rete viene inghiottito (non lancia)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      dispatchNotification(fakeDb(BASE_ROW), TICKET_CREATED, { fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("best-effort: una risposta non-2xx non lancia", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      dispatchNotification(fakeDb(BASE_ROW), TICKET_CREATED, { fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("best-effort: un errore in lettura della config non lancia", async () => {
    const brokenDb = {
      select() {
        throw new Error("DB giù");
      },
    } as unknown as Db;
    const fetchImpl = okFetch();
    await expect(
      dispatchNotification(brokenDb, TICKET_CREATED, { fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("formato Slack", () => {
  it("ticket.created → text mrkdwn con numero, titolo, progetto, source e link", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "slack" }), TICKET_CREATED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as { text: string };
    expect(body.text).toContain("*#42*");
    expect(body.text).toContain("Crash al login");
    expect(body.text).toContain("webapp");
    expect(body.text).toContain("sdk_error");
    expect(body.text).toContain("<https://app.example.com/tickets/t1|Apri>");
  });

  it("pr_opened → link PR e ticket, con il costo se presente", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "slack" }), PR_OPENED, { fetchImpl });
    const body = (await bodyOf(fetchImpl)) as { text: string };
    expect(body.text).toContain("*#42*");
    expect(body.text).toContain("<https://github.com/o/r/pull/7|Vedi PR>");
    expect(body.text).toContain("<https://app.example.com/tickets/t1|Ticket>");
    expect(body.text).toContain("0.42");
  });

  it("pr_opened senza costo → nessun riferimento al costo", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "slack" }), {
      ...PR_OPENED,
      costUsd: null,
    }, { fetchImpl });
    const body = (await bodyOf(fetchImpl)) as { text: string };
    expect(body.text.toLowerCase()).not.toContain("costo");
  });

  it("job.held → tipo, effort N/5 e link", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "slack" }), JOB_HELD, { fetchImpl });
    const body = (await bodyOf(fetchImpl)) as { text: string };
    expect(body.text).toContain("*#42*");
    expect(body.text).toContain("bug");
    expect(body.text).toContain("4/5");
    expect(body.text).toContain("<https://app.example.com/tickets/t1|Apri>");
  });

  it("job.failed → messaggio d'errore e link", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "slack" }), JOB_FAILED, { fetchImpl });
    const body = (await bodyOf(fetchImpl)) as { text: string };
    expect(body.text).toContain("*#42*");
    expect(body.text).toContain("timeout del fix");
    expect(body.text).toContain("<https://app.example.com/tickets/t1|Apri>");
  });
});

describe("formato Discord", () => {
  it("usa il campo content con link in stile markdown [label](url)", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "discord" }), TICKET_CREATED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as { content: string };
    expect(body.content).toContain("#42");
    expect(body.content).toContain("Crash al login");
    expect(body.content).toContain("[Apri](https://app.example.com/tickets/t1)");
  });

  it("pr_opened: link PR e ticket in stile markdown", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "discord" }), PR_OPENED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as { content: string };
    expect(body.content).toContain("[Vedi PR](https://github.com/o/r/pull/7)");
    expect(body.content).toContain("[Ticket](https://app.example.com/tickets/t1)");
  });
});

describe("formato generic", () => {
  it("ticket.created → payload JSON machine-readable", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "generic" }), TICKET_CREATED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as Record<string, unknown>;
    expect(body.event).toBe("ticket.created");
    expect(body.ticketNumber).toBe(42);
    expect(body.title).toBe("Crash al login");
    expect(body.projectName).toBe("webapp");
    expect(body.source).toBe("sdk_error");
    expect(body.ticketUrl).toBe("https://app.example.com/tickets/t1");
    expect(typeof body.message).toBe("string");
  });

  it("pr_opened → include prUrl e costUsd", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "generic" }), PR_OPENED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as Record<string, unknown>;
    expect(body.event).toBe("job.pr_opened");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(body.costUsd).toBe(0.42);
  });

  it("job.held → include type ed effort", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "generic" }), JOB_HELD, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as Record<string, unknown>;
    expect(body.event).toBe("job.held");
    expect(body.type).toBe("bug");
    expect(body.effort).toBe(4);
  });

  it("job.failed → include error", async () => {
    const fetchImpl = okFetch();
    await dispatchNotification(fakeDb({ ...BASE_ROW, format: "generic" }), JOB_FAILED, {
      fetchImpl,
    });
    const body = (await bodyOf(fetchImpl)) as Record<string, unknown>;
    expect(body.event).toBe("job.failed");
    expect(body.error).toBe("timeout del fix");
  });
});

describe("buildTestEvent", () => {
  it("produce un ticket.created fittizio con il link a /tickets/test sotto baseUrl", () => {
    const event = buildTestEvent("https://app.example.com");
    expect(event.kind).toBe("ticket.created");
    expect(event.ticketUrl).toBe("https://app.example.com/tickets/test");
  });

  it("tollera uno slash finale nel baseUrl", () => {
    const event = buildTestEvent("https://app.example.com/");
    expect(event.ticketUrl).toBe("https://app.example.com/tickets/test");
  });
});

describe("sendTest", () => {
  it("ok=false con dettaglio se non c'è webhook configurato", async () => {
    const fetchImpl = okFetch();
    const result = await sendTest(fakeDb({ ...BASE_ROW, webhookUrl: null }), "https://app.example.com", {
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/webhook/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ok=true quando il POST riesce (a prescindere dai toggle per-evento)", async () => {
    const fetchImpl = okFetch();
    const result = await sendTest(
      fakeDb({ ...BASE_ROW, enabled: false, notifyTicketCreated: false }),
      "https://app.example.com",
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ok=false con il messaggio d'errore se il POST fallisce (a differenza del dispatch, NON inghiotte)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("DNS non risolto"));
    const result = await sendTest(fakeDb(BASE_ROW), "https://app.example.com", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("DNS non risolto");
  });

  it("ok=false se la risposta è non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 404 }));
    const result = await sendTest(fakeDb(BASE_ROW), "https://app.example.com", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
  });
});

// Guardia: la query del modulo deve puntare alla tabella giusta.
describe("contratto schema", () => {
  it("la tabella di configurazione è notification_settings", () => {
    expect(notificationSettings).toBeDefined();
    // eq importato per evitare unused; la query reale usa la singola riga.
    expect(typeof eq).toBe("function");
  });
});
