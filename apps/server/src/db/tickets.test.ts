import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "@stubwise/db/testing";
import { seedGitAccount, startTestDb } from "@stubwise/db/testing";
import type { Db } from "@stubwise/db";
import { errorGroups, projects } from "@stubwise/db";
import { createTicket, ProjectNotFoundError } from "./tickets.js";

/**
 * Estrae il codice errore Postgres. Drizzle avvolge gli errori del driver
 * in DrizzleQueryError, quindi il codice può stare sull'errore stesso o
 * sulla sua `cause`.
 */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const err = error as { code?: unknown; cause?: unknown };
  if (typeof err.code === "string") return err.code;
  return pgErrorCode(err.cause);
}

/** Inserisce un progetto minimo valido, con slug e ingestion key univoci. */
async function insertProject(db: Db, slug: string) {
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: slug,
      slug,
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      ingestionKey: `ingestion-${slug}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project;
}

// Un container Postgres per file di test: l'avvio costa secondi, i singoli
// test si isolano usando progetti distinti.
let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("schema: tickets", () => {
  it("assegna numeri sequenziali per-progetto (1, poi 2)", async () => {
    const { db } = testDb;
    const project = await insertProject(db, "seq");

    const first = await createTicket(db, {
      projectId: project.id,
      title: "Primo ticket",
      type: "bug",
      priority: "high",
      source: "manual",
    });
    const second = await createTicket(db, {
      projectId: project.id,
      title: "Secondo ticket",
      type: "feature",
      priority: "low",
      source: "api",
    });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it("il contatore è indipendente tra progetti", async () => {
    const { db } = testDb;
    const a = await insertProject(db, "indip-a");
    const b = await insertProject(db, "indip-b");

    const ticketA = await createTicket(db, {
      projectId: a.id,
      title: "Ticket A",
      type: "task",
      priority: "medium",
      source: "manual",
    });
    const ticketB = await createTicket(db, {
      projectId: b.id,
      title: "Ticket B",
      type: "task",
      priority: "medium",
      source: "manual",
    });

    expect(ticketA.number).toBe(1);
    expect(ticketB.number).toBe(1);
  });

  it("5 createTicket concorrenti producono i numeri 1..5 senza duplicati", async () => {
    const { db } = testDb;
    const project = await insertProject(db, "concurrent");

    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createTicket(db, {
          projectId: project.id,
          title: `Ticket concorrente ${i}`,
          type: "bug",
          priority: "urgent",
          source: "sdk_error",
        }),
      ),
    );

    const numbers = created.map((ticket) => ticket.number).sort((x, y) => x - y);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it("rifiuta la creazione di un ticket su un progetto inesistente", async () => {
    const { db } = testDb;
    await expect(
      createTicket(db, {
        projectId: "00000000-0000-0000-0000-000000000000",
        title: "Orfano",
        type: "bug",
        priority: "low",
        source: "manual",
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe("schema: errorGroups", () => {
  it("rifiuta due gruppi con la stessa (projectId, fingerprint) con violazione unique (23505)", async () => {
    const { db } = testDb;
    const project = await insertProject(db, "fingerprint");
    const ticket = await createTicket(db, {
      projectId: project.id,
      title: "Errore raggruppato",
      type: "bug",
      priority: "high",
      source: "sdk_error",
    });

    await db.insert(errorGroups).values({
      projectId: project.id,
      fingerprint: "abc123",
      ticketId: ticket.id,
    });

    const otherTicket = await createTicket(db, {
      projectId: project.id,
      title: "Altro ticket",
      type: "bug",
      priority: "high",
      source: "sdk_error",
    });

    let caught: unknown;
    try {
      await db.insert(errorGroups).values({
        projectId: project.id,
        fingerprint: "abc123",
        ticketId: otherTicket.id,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(pgErrorCode(caught)).toBe("23505");
  });
});
