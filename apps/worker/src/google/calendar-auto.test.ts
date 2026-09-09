import { randomUUID } from "node:crypto";
import { aiJobs, backlogItems, backlogJobs, milestones, projects, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executeAutoCalendarAction } from "./calendar-auto.js";

/**
 * ESECUZIONE AUTOMATICA di una serie (fase 7b, Task 5).
 *
 * Il filo conduttore di questo file è quello del docblock del modulo:
 * **nessuna scrittura qui dentro parte mai da un job d'agente**. Ogni test
 * che crea qualcosa lo riverifica guardando `ai_jobs`/`backlog_jobs`, non
 * solo l'oggetto atteso — è il test esplicito richiesto dal piano ("fallisce
 * se qualcuno un domani accodasse un job AI da questo percorso").
 */

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(backlogJobs);
  await db.delete(aiJobs);
  await db.delete(backlogItems);
  await db.delete(milestones);
  await db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

async function seedProject(name = "Acme"): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, ingestionKey: randomUUID() })
    .returning({ id: projects.id });
  return row!.id;
}

async function jobCounts(): Promise<{ ai: number; backlog: number }> {
  return {
    ai: (await db.select().from(aiJobs)).length,
    backlog: (await db.select().from(backlogJobs)).length,
  };
}

describe("executeAutoCalendarAction — milestone", () => {
  it("crea la milestone, senza nessun job", async () => {
    const projectId = await seedProject();
    const outcome = await executeAutoCalendarAction(db, {
      action: "milestone",
      projectId,
      name: "Pianificazione task entro il 2026-09-14",
      dueDate: "2026-09-14",
    });
    expect(outcome.type).toBe("milestone");
    const rows = await db.select().from(milestones).where(eqProject(projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Pianificazione task entro il 2026-09-14");
    expect(rows[0]!.dueDate?.toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(await jobCounts()).toEqual({ ai: 0, backlog: 0 });
  });

  it("una milestone con lo stesso nome esiste già: outcome 'exists', nessun duplicato", async () => {
    const projectId = await seedProject();
    const input = { action: "milestone" as const, projectId, name: "Ricorrente", dueDate: "2026-09-14" };
    const first = await executeAutoCalendarAction(db, input);
    const second = await executeAutoCalendarAction(db, { ...input, dueDate: "2026-09-21" });
    expect(first.type).toBe("milestone");
    expect(second.type).toBe("exists");
    const rows = await db.select().from(milestones).where(eqProject(projectId));
    expect(rows).toHaveLength(1);
  });
});

describe("executeAutoCalendarAction — backlog_item", () => {
  it("crea la voce di backlog con un testo deterministico, source 'manual', senza NESSUN job", async () => {
    const projectId = await seedProject();
    const outcome = await executeAutoCalendarAction(db, {
      action: "backlog_item",
      projectId,
      name: "Pianificazione task entro il 2026-09-14",
      dueDate: "2026-09-14",
    });
    expect(outcome.type).toBe("backlog_item");
    const rows = await db.select().from(backlogItems).where(eqBacklogProject(projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Pianificazione task entro il 2026-09-14");
    expect(rows[0]!.source).toBe("manual");
    // La rete di sicurezza esplicita del piano: nessun job, né AI né di intake.
    expect(await jobCounts()).toEqual({ ai: 0, backlog: 0 });
  });

  it("due occorrenze della stessa serie producono DUE voci indipendenti (nessun dedup per nome)", async () => {
    const projectId = await seedProject();
    await executeAutoCalendarAction(db, {
      action: "backlog_item",
      projectId,
      name: "Pianificazione task entro il 2026-09-14",
      dueDate: "2026-09-14",
    });
    await executeAutoCalendarAction(db, {
      action: "backlog_item",
      projectId,
      name: "Pianificazione task entro il 2026-09-21",
      dueDate: "2026-09-21",
    });
    const rows = await db.select().from(backlogItems).where(eqBacklogProject(projectId));
    expect(rows).toHaveLength(2);
  });
});

describe("executeAutoCalendarAction — dentro una transazione (fix di review, Task 2)", () => {
  it("accetta una tx aperta dal chiamante, e un errore SUCCESSIVO nella stessa transazione fa sparire l'oggetto appena creato", async () => {
    // Riproduce esattamente il pattern del poller (fase 7b, Task 2):
    // executeAutoCalendarAction dentro `db.transaction`, seguito da altre
    // scritture nella STESSA transazione. Se una di quelle scritture
    // fallisce, l'intera transazione va indietro — la voce di backlog
    // appena creata non deve sopravvivere: è la garanzia che protegge da
    // un crash del worker fra la creazione e i due UPDATE che il poller fa
    // subito dopo (calendar_events.outcome, notifications.status).
    const projectId = await seedProject();
    const attempt = db
      .transaction(async (tx) => {
        await executeAutoCalendarAction(tx, {
          action: "backlog_item",
          projectId,
          name: "Pianificazione task entro il 2026-09-14",
          dueDate: "2026-09-14",
        });
        // Il "crash" simulato: una scrittura successiva nella stessa
        // transazione che fallisce — esattamente la posizione dei due
        // UPDATE del poller rispetto alla creazione.
        throw new Error("simulato: crash prima degli UPDATE che seguono");
      })
      .catch((err: unknown) => err);
    const error = await attempt;
    expect(error).toBeInstanceOf(Error);

    const rows = await db.select().from(backlogItems).where(eqBacklogProject(projectId));
    expect(rows).toHaveLength(0);
  });
});

describe("executeAutoCalendarAction — reminder", () => {
  it("non crea NULLA: nessuna milestone, nessuna voce di backlog, nessun job", async () => {
    const projectId = await seedProject();
    const outcome = await executeAutoCalendarAction(db, {
      action: "reminder",
      projectId,
      name: "Pianificazione task entro il 2026-09-14",
      dueDate: "2026-09-14",
    });
    expect(outcome).toEqual({ type: "reminder" });
    expect(await db.select().from(milestones).where(eqProject(projectId))).toHaveLength(0);
    expect(await db.select().from(backlogItems).where(eqBacklogProject(projectId))).toHaveLength(0);
    expect(await jobCounts()).toEqual({ ai: 0, backlog: 0 });
  });
});

function eqProject(projectId: string) {
  return eq(milestones.projectId, projectId);
}
function eqBacklogProject(projectId: string) {
  return eq(backlogItems.projectId, projectId);
}
