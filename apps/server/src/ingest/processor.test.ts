import type { ErrorEvent, FeedbackEvent, TicketCreateEvent } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, attachments, backlogJobs, errorGroups, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { PublishOpts } from "@stubwise/notifications";
import type { ObjectStorage } from "../storage/index.js";
import { processEvents } from "./processor.js";

/** Storage fake in-memory: registra ogni putObject per le asserzioni. */
function fakeStorage(): ObjectStorage & { puts: Array<{ key: string; size: number; type: string }> } {
  const puts: Array<{ key: string; size: number; type: string }> = [];
  return {
    puts,
    putObject: async (key, body, contentType) => {
      puts.push({ key, size: body.length, type: contentType });
    },
    getSignedDownloadUrl: async () => "https://example.com/signed",
    deleteObject: async () => undefined,
  };
}

/** dataURL minimale ma valido (1x1 PNG) per i test dello screenshot. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/**
 * Ogni test lavora su un progetto fresco: isolamento senza truncate.
 * Dalla Fase 3 processEvents risolve un PROGETTO: qui passiamo il projectId
 * come `{ id }`.
 */
async function createProject(): Promise<{ id: string }> {
  const { projectId } = await seedRepository(testDb.db);
  return { id: projectId };
}

function errorEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    kind: "error",
    message: "x is undefined",
    errorType: "TypeError",
    stack:
      "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)",
    url: "https://app.example.com/checkout",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    release: "1.2.3",
    environment: "production",
    breadcrumbs: [
      { type: "click", message: "click su #buy", timestamp: "2026-06-10T10:00:00Z" },
    ],
    timestamp: "2026-06-10T10:00:01Z",
    ...overrides,
  };
}

async function projectTickets(projectId: string) {
  return testDb.db.select().from(tickets).where(eq(tickets.projectId, projectId));
}

async function projectGroups(projectId: string) {
  return testDb.db.select().from(errorGroups).where(eq(errorGroups.projectId, projectId));
}

async function ticketJobs(ticketId: string) {
  return testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
}

describe("processEvents — eventi errore", () => {
  it("il primo evento errore crea ErrorGroup, ticket sdk_error/bug e aiJob queued", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [errorEvent()]);
    expect(result).toEqual({ created: 1, deduped: 0 });

    const rows = await projectTickets(project.id);
    expect(rows).toHaveLength(1);
    const ticket = rows[0]!;
    expect(ticket.source).toBe("sdk_error");
    expect(ticket.type).toBe("bug");
    expect(ticket.title).toBe("TypeError: x is undefined");
    expect(ticket.occurrences).toBe(1);
    expect(ticket.technicalPayload).toMatchObject({
      message: "x is undefined",
      stack: "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)",
      url: "https://app.example.com/checkout",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
      release: "1.2.3",
      environment: "production",
      breadcrumbs: [
        { type: "click", message: "click su #buy", timestamp: "2026-06-10T10:00:00Z" },
      ],
      timestamp: "2026-06-10T10:00:01Z",
    });

    const groups = await projectGroups(project.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ticketId).toBe(ticket.id);

    const jobs = await ticketJobs(ticket.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("il ticket auto-generato e l'errorGroup sono scopati al PROGETTO (Fase 3)", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [errorEvent()]);

    const rows = await projectTickets(project.id);
    expect(rows).toHaveLength(1);
    const ticket = rows[0]!;
    // Il ticket appartiene solo al progetto: niente repository bersaglio.
    expect(ticket.projectId).toBe(project.id);
    expect(ticket).not.toHaveProperty("repositoryId");

    // L'errorGroup è del progetto (Fase 3: ingestion di prodotto).
    const groups = await projectGroups(project.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectId).toBe(project.id);
    expect(groups[0]!.ticketId).toBe(ticket.id);
  });

  it("il secondo evento identico non crea ticket: incrementa occurrences e aggiorna lastSeenAt", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [errorEvent()]);
    const [before] = await projectTickets(project.id);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await processEvents(testDb.db, project, [errorEvent()]);
    expect(result).toEqual({ created: 0, deduped: 1 });

    const rows = await projectTickets(project.id);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    expect(after.occurrences).toBe(2);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());

    // Nessun nuovo job AI per i duplicati.
    expect(await ticketJobs(after.id)).toHaveLength(1);
  });

  it("lo stesso errore da una release diversa (hash di build diverso) viene dedupato", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [errorEvent()]);
    const result = await processEvents(testDb.db, project, [
      errorEvent({
        stack:
          "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-d4e5f6.js:99:1)",
        release: "1.2.4",
      }),
    ]);
    expect(result).toEqual({ created: 0, deduped: 1 });
    expect(await projectTickets(project.id)).toHaveLength(1);
  });

  it("un errore diverso crea un secondo gruppo e un secondo ticket", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [errorEvent()]);
    const result = await processEvents(testDb.db, project, [
      errorEvent({
        errorType: "RangeError",
        message: "invalid array length",
        stack: "RangeError: invalid array length\n  at grow (https://cdn.app/assets/arr.js:3:2)",
      }),
    ]);
    expect(result).toEqual({ created: 1, deduped: 0 });
    expect(await projectTickets(project.id)).toHaveLength(2);
    expect(await projectGroups(project.id)).toHaveLength(2);
  });

  it("lo stesso fingerprint su PROGETTI diversi crea gruppi e ticket distinti (dedup per progetto)", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const resA = await processEvents(testDb.db, projectA, [errorEvent()]);
    const resB = await processEvents(testDb.db, projectB, [errorEvent()]);
    // Stesso errore, ma progetti diversi → due ticket nuovi (nessun dedup
    // cross-progetto).
    expect(resA).toEqual({ created: 1, deduped: 0 });
    expect(resB).toEqual({ created: 1, deduped: 0 });

    const groupsA = await projectGroups(projectA.id);
    const groupsB = await projectGroups(projectB.id);
    expect(groupsA).toHaveLength(1);
    expect(groupsB).toHaveLength(1);
    // Gruppi distinti, ognuno legato al ticket del proprio progetto.
    expect(groupsA[0]!.ticketId).not.toBe(groupsB[0]!.ticketId);
  });

  it("senza errorType il titolo usa il fallback Error", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [
      errorEvent({ errorType: undefined, message: "boom", stack: undefined }),
    ]);
    const [ticket] = await projectTickets(project.id);
    expect(ticket!.title).toBe("Error: boom");
  });

  it("il titolo viene troncato a 300 caratteri, ellissi inclusa", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [
      errorEvent({ message: "x".repeat(500), stack: undefined }),
    ]);
    const [ticket] = await projectTickets(project.id);
    expect(ticket!.title).toHaveLength(300);
    expect(ticket!.title.endsWith("…")).toBe(true);
    expect(ticket!.title.startsWith("TypeError: x")).toBe(true);
  });

  it("race sul vincolo unique: il perdente non lascia ticket orfani e incrementa il vincitore", async () => {
    const project = await createProject();
    const event = errorEvent();
    // Il hook scatta tra la SELECT (gruppo assente) e la creazione del
    // ticket: simuliamo deterministicamente un concorrente che vince la
    // corsa creando gruppo+ticket nel frattempo. La transazione "perdente"
    // deve accorgersi del conflitto sull'unique, fare rollback e ritentare
    // come update (dedup).
    let fired = 0;
    const result = await processEvents(testDb.db, project, [event], {
      beforeTicketCreate: async () => {
        fired += 1;
        await processEvents(testDb.db, project, [event]);
      },
    });
    expect(fired).toBe(1);
    expect(result).toEqual({ created: 0, deduped: 1 });

    const rows = await projectTickets(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(await projectGroups(project.id)).toHaveLength(1);
    expect(await ticketJobs(rows[0]!.id)).toHaveLength(1);
  });

  it("ingestion concorrenti dello stesso errore: un solo ticket, occurrences corretto", async () => {
    const project = await createProject();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => processEvents(testDb.db, project, [errorEvent()])),
    );
    const created = results.reduce((sum, r) => sum + r.created, 0);
    const deduped = results.reduce((sum, r) => sum + r.deduped, 0);
    expect(created).toBe(1);
    expect(deduped).toBe(5);

    const rows = await projectTickets(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(6);
    expect(await ticketJobs(rows[0]!.id)).toHaveLength(1);
  });
});

describe("processEvents — eventi feedback", () => {
  const feedback: FeedbackEvent = {
    kind: "feedback",
    message: "Il bottone di acquisto non risponde",
    email: "cliente@example.com",
    url: "https://app.example.com/checkout",
  };

  it("crea sempre un ticket sdk_feedback/feedback con email e url nel body, più aiJob", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [feedback]);
    expect(result).toEqual({ created: 1, deduped: 0 });

    const [ticket] = await projectTickets(project.id);
    expect(ticket!.source).toBe("sdk_feedback");
    expect(ticket!.type).toBe("feedback");
    expect(ticket!.title).toBe("Il bottone di acquisto non risponde");
    expect(ticket!.body).toContain("cliente@example.com");
    expect(ticket!.body).toContain("https://app.example.com/checkout");

    const jobs = await ticketJobs(ticket!.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("due feedback identici creano due ticket: il feedback non si dedupa", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [feedback, feedback]);
    expect(result).toEqual({ created: 2, deduped: 0 });
    expect(await projectTickets(project.id)).toHaveLength(2);
  });
});

async function ticketAttachments(ticketId: string) {
  return testDb.db.select().from(attachments).where(eq(attachments.ticketId, ticketId));
}

describe("processEvents — screenshot del feedback come allegato", () => {
  it("con screenshot valido e storage attivo: crea ticket + 1 attachment collegato", async () => {
    const project = await createProject();
    const storage = fakeStorage();
    const result = await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "bug visivo", screenshot: PNG_DATA_URL }],
      { storage: async () => storage },
    );
    expect(result).toEqual({ created: 1, deduped: 0 });

    const [ticket] = await projectTickets(project.id);
    const rows = await ticketAttachments(ticket!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mimeType).toBe("image/png");
    expect(rows[0]!.commentId).toBeNull();
    expect(rows[0]!.uploaderId).toBeNull();
    expect(rows[0]!.filename).toBe("feedback-screenshot.png");
    expect(rows[0]!.storageKey).toContain(`tickets/${ticket!.id}/`);
    expect(rows[0]!.sizeBytes).toBeGreaterThan(0);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]!.type).toBe("image/png");
    expect(storage.puts[0]!.size).toBe(rows[0]!.sizeBytes);
  });

  it("senza storage attivo: ticket creato, 0 attachments, nessun errore", async () => {
    const project = await createProject();
    const result = await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "bug visivo", screenshot: PNG_DATA_URL }],
      { storage: async () => null },
    );
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(await ticketAttachments(ticket!.id)).toHaveLength(0);
  });

  it("nessuna resolver storage: ticket creato, 0 attachments (retro-compatibile)", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [
      { kind: "feedback", message: "bug visivo", screenshot: PNG_DATA_URL },
    ]);
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(await ticketAttachments(ticket!.id)).toHaveLength(0);
  });

  it("screenshot oltre il limite di dimensione: ticket creato, 0 attachments", async () => {
    const project = await createProject();
    const storage = fakeStorage();
    // ~11 MB di base64 → oltre MAX_ATTACHMENT_BYTES (10 MB) una volta decodificato.
    const big = `data:image/png;base64,${"A".repeat(15 * 1024 * 1024)}`;
    const result = await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "troppo grande", screenshot: big }],
      { storage: async () => storage },
    );
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(await ticketAttachments(ticket!.id)).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
  });

  it("un putObject che lancia non rompe l'ingestion: ticket creato, 0 attachments", async () => {
    const project = await createProject();
    const storage: ObjectStorage = {
      putObject: async () => {
        throw new Error("S3 down");
      },
      getSignedDownloadUrl: async () => "",
      deleteObject: async () => undefined,
    };
    const result = await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "bug", screenshot: PNG_DATA_URL }],
      { storage: async () => storage },
    );
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(await ticketAttachments(ticket!.id)).toHaveLength(0);
  });

  it("screenshot con MIME immagine non in allowlist (svg+xml): ticket creato, 0 attachments", async () => {
    const project = await createProject();
    const storage = fakeStorage();
    // image/svg+xml supera lo startsWith("data:image/") dello schema shared
    // ma non è nell'allowlist immagini del processor (png/jpeg/gif/webp).
    const svg = `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ).toString("base64")}`;
    const result = await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "anteprima svg", screenshot: svg }],
      { storage: async () => storage },
    );
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(await ticketAttachments(ticket!.id)).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
  });

  it("feedback senza screenshot: nessun accesso allo storage", async () => {
    const project = await createProject();
    const storage = fakeStorage();
    await processEvents(testDb.db, project, [{ kind: "feedback", message: "solo testo" }], {
      storage: async () => storage,
    });
    expect(storage.puts).toHaveLength(0);
  });
});

describe("processEvents — eventi ticket", () => {
  const ticketEvent: TicketCreateEvent = {
    kind: "ticket",
    title: "Aggiungere export CSV",
    body: "Richiesto dal team vendite",
    type: "feature",
    priority: "high",
  };

  it("crea un ticket source api con type e priority dati, più aiJob", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [ticketEvent]);
    expect(result).toEqual({ created: 1, deduped: 0 });

    const [ticket] = await projectTickets(project.id);
    expect(ticket!.source).toBe("api");
    expect(ticket!.type).toBe("feature");
    expect(ticket!.priority).toBe("high");
    expect(ticket!.title).toBe("Aggiungere export CSV");
    expect(ticket!.body).toBe("Richiesto dal team vendite");
    expect(await ticketJobs(ticket!.id)).toHaveLength(1);
  });
});

describe("processEvents — deviazione intake al backlog (backlogEnabled)", () => {
  async function createBacklogProject(): Promise<{ id: string }> {
    const project = await createProject();
    await testDb.db
      .update(projects)
      .set({ backlogEnabled: true })
      .where(eq(projects.id, project.id));
    return project;
  }

  async function projectBacklogJobs(projectId: string) {
    return testDb.db.select().from(backlogJobs).where(eq(backlogJobs.projectId, projectId));
  }

  it("feedback su progetto abilitato: job intake in backlog_jobs, NESSUN aiJob", async () => {
    const project = await createBacklogProject();
    const result = await processEvents(testDb.db, project, [
      { kind: "feedback", message: "Vorrei l'export in CSV" },
    ]);
    expect(result).toEqual({ created: 1, deduped: 0 });

    const [ticket] = await projectTickets(project.id);
    expect(ticket!.type).toBe("feedback");
    expect(await ticketJobs(ticket!.id)).toHaveLength(0);

    const jobs = await projectBacklogJobs(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("intake");
    expect(jobs[0]!.status).toBe("queued");
    expect(jobs[0]!.payload).toEqual({ ticketId: ticket!.id });
  });

  it("evento ticket type feature su progetto abilitato: deviato al backlog", async () => {
    const project = await createBacklogProject();
    await processEvents(testDb.db, project, [
      { kind: "ticket", title: "Dark mode", type: "feature", priority: "low" },
    ]);

    const [ticket] = await projectTickets(project.id);
    expect(await ticketJobs(ticket!.id)).toHaveLength(0);
    const jobs = await projectBacklogJobs(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ ticketId: ticket!.id });
  });

  it("progetto DISABILITATO: il feedback accoda l'aiJob come oggi, niente backlog", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [{ kind: "feedback", message: "Manca la ricerca" }]);

    const [ticket] = await projectTickets(project.id);
    expect(await ticketJobs(ticket!.id)).toHaveLength(1);
    expect(await projectBacklogJobs(project.id)).toHaveLength(0);
  });

  it("evento errore (type bug) su progetto abilitato: pipeline fix invariata", async () => {
    const project = await createBacklogProject();
    await processEvents(testDb.db, project, [errorEvent()]);

    const [ticket] = await projectTickets(project.id);
    expect(ticket!.type).toBe("bug");
    expect(await ticketJobs(ticket!.id)).toHaveLength(1);
    expect(await projectBacklogJobs(project.id)).toHaveLength(0);
  });
});

describe("processEvents — batch misti", () => {
  it("conta created e deduped sull'intero batch", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [
      errorEvent(),
      errorEvent(), // duplicato del precedente
      {
        kind: "feedback",
        message: "Non riesco a salvare",
      },
      {
        kind: "ticket",
        title: "Refactor login",
        type: "task",
        priority: "low",
      },
    ]);
    expect(result).toEqual({ created: 3, deduped: 1 });
    expect(await projectTickets(project.id)).toHaveLength(3);
  });
});

describe("processEvents — notifica ticket.created", () => {
  interface DispatchedEvent {
    kind: string;
    ticketNumber: number;
    ticketTitle: string;
    projectName: string;
    source?: string;
    ticketUrl: string;
  }

  it("pubblica ticket.created per un errore SDK nuovo, con URL, nome progetto e riferimenti", async () => {
    const project = await createProject();
    const calls: { event: DispatchedEvent; opts: PublishOpts }[] = [];
    const result = await processEvents(testDb.db, project, [errorEvent()], {
      publicUrl: "https://stubwise.example.com",
      projectName: "Acme",
      publish: async (_db, event, opts) => {
        calls.push({ event: event as unknown as DispatchedEvent, opts: opts ?? {} });
        return { published: 1 };
      },
    });
    expect(result).toEqual({ created: 1, deduped: 0 });
    const [ticket] = await projectTickets(project.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event.kind).toBe("ticket.created");
    expect(calls[0]!.event.source).toBe("sdk_error");
    expect(calls[0]!.event.projectName).toBe("Acme");
    expect(calls[0]!.event.ticketNumber).toBe(ticket!.number);
    expect(calls[0]!.event.ticketUrl).toBe(`https://stubwise.example.com/tickets/${ticket!.id}`);
    // Riferimenti: progetto e ticket appena creato (nessun job: quello
    // dell'ingestion non ha un richiedente umano).
    expect(calls[0]!.opts).toEqual({ projectId: project.id, ticketId: ticket!.id });
  });

  it("pubblica ticket.created per un feedback SDK nuovo (source sdk_feedback)", async () => {
    const project = await createProject();
    const calls: { event: DispatchedEvent; opts: PublishOpts }[] = [];
    await processEvents(
      testDb.db,
      project,
      [{ kind: "feedback", message: "non va" }],
      {
        publicUrl: "https://stubwise.example.com",
        projectName: "Acme",
        publish: async (_db, event, opts) => {
          calls.push({ event: event as unknown as DispatchedEvent, opts: opts ?? {} });
          return { published: 1 };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event.source).toBe("sdk_feedback");
  });

  it("NON pubblica sul dedup di un errore (solo sui ticket genuinamente nuovi)", async () => {
    const project = await createProject();
    await processEvents(testDb.db, project, [errorEvent()]);
    const calls: { event: DispatchedEvent; opts: PublishOpts }[] = [];
    const result = await processEvents(testDb.db, project, [errorEvent()], {
      publicUrl: "https://stubwise.example.com",
      projectName: "Acme",
      publish: async (_db, event, opts) => {
        calls.push({ event: event as unknown as DispatchedEvent, opts: opts ?? {} });
        return { published: 1 };
      },
    });
    expect(result).toEqual({ created: 0, deduped: 1 });
    expect(calls).toHaveLength(0);
  });

  it("NON pubblica per i ticket api (solo sorgenti SDK)", async () => {
    const project = await createProject();
    const calls: { event: DispatchedEvent; opts: PublishOpts }[] = [];
    await processEvents(
      testDb.db,
      project,
      [{ kind: "ticket", title: "manuale", type: "task", priority: "low" }],
      {
        publicUrl: "https://stubwise.example.com",
        projectName: "Acme",
        publish: async (_db, event, opts) => {
          calls.push({ event: event as unknown as DispatchedEvent, opts: opts ?? {} });
          return { published: 1 };
        },
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("una publish che lancia non rompe il batch (best-effort)", async () => {
    const project = await createProject();
    const result = await processEvents(testDb.db, project, [errorEvent()], {
      publicUrl: "https://stubwise.example.com",
      projectName: "Acme",
      publish: async () => {
        throw new Error("notifica esplosa");
      },
    });
    // L'ingestion è andata a buon fine nonostante la publish rotta.
    expect(result).toEqual({ created: 1, deduped: 0 });
    expect(await projectTickets(project.id)).toHaveLength(1);
  });
});
