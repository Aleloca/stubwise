import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectDecisions, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { appendDecisionContext, retrieveDecisionContext } from "./decisions.js";

/**
 * Contesto delle DECISIONI nelle chat interne (fase 5).
 *
 * Stessa regola d'oro del retrieval dal grafo: **la chat non deve MAI peggiorare
 * per colpa di questo**. Nessun progetto, nessuna decisione pertinente, DB in
 * errore → `null`, e il system prompt torna identico a prima.
 */

let testDb: TestDb;
let db: Db;
let projectId: string;

const logger = { debug: vi.fn() };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function seedDecision(input: {
  title: string;
  decision: string;
  context?: string;
  consequences?: string;
  decidedAt?: Date;
  project?: string;
}): Promise<void> {
  await db.insert(projectDecisions).values({
    projectId: input.project ?? projectId,
    source: "manual",
    sourceKey: `manual:${randomUUID()}`,
    title: input.title,
    decision: input.decision,
    ...(input.context ? { context: input.context } : {}),
    ...(input.consequences ? { consequences: input.consequences } : {}),
    ...(input.decidedAt ? { decidedAt: input.decidedAt } : {}),
  });
}

describe("retrieveDecisionContext", () => {
  it("un progetto senza decisioni → null (chat identica a prima)", async () => {
    const { projectId: empty } = await seedRepository(db);
    expect(
      await retrieveDecisionContext(db, { projectId: empty, question: "come esportiamo?" }, logger),
    ).toBeNull();
  });

  it("trova le decisioni pertinenti alla domanda e le rende con contesto e conseguenze", async () => {
    await seedDecision({
      title: "Formato dell'export",
      decision: "CSV con separatore punto e virgola",
      context: "Valutato anche XLSX",
      consequences: "Nessuna dipendenza nuova",
    });

    const block = await retrieveDecisionContext(
      db,
      { projectId, question: "che formato usiamo per l'export?" },
      logger,
    );

    expect(block).not.toBeNull();
    expect(block).toContain("CSV con separatore punto e virgola");
    expect(block).toContain("Valutato anche XLSX");
    expect(block).toContain("Nessuna dipendenza nuova");
  });

  it("una domanda che non tocca nessuna decisione → null", async () => {
    expect(
      await retrieveDecisionContext(
        db,
        { projectId, question: "quale palette usiamo per i grafici?" },
        logger,
      ),
    ).toBeNull();
  });

  it("non pesca le decisioni di un ALTRO progetto", async () => {
    const { projectId: other } = await seedRepository(db);
    await seedDecision({
      title: "Autenticazione",
      decision: "Solo SSO aziendale",
      project: other,
    });

    const block = await retrieveDecisionContext(
      db,
      { projectId, question: "come funziona l'autenticazione?" },
      logger,
    );
    expect(block).toBeNull();
  });

  it("a parità di pertinenza tiene le più recenti, al massimo cinque", async () => {
    const { projectId: many } = await seedRepository(db);
    for (let i = 0; i < 8; i += 1) {
      await seedDecision({
        title: `Cache delle sessioni ${i}`,
        decision: `Scelta numero ${i} sulla cache`,
        decidedAt: new Date(Date.UTC(2026, 0, i + 1)),
        project: many,
      });
    }

    const block = await retrieveDecisionContext(
      db,
      { projectId: many, question: "come gestiamo la cache delle sessioni?" },
      logger,
    );

    expect(block).not.toBeNull();
    // Cinque voci: la più vecchia (2026-01-01, "numero 0") non c'è.
    expect(block!.match(/^### /gm)).toHaveLength(5);
    expect(block).toContain("Scelta numero 7 sulla cache");
    expect(block).not.toContain("Scelta numero 0 sulla cache");
  });

  it("una domanda senza parole utili → null, senza interrogare il DB", async () => {
    const failing = {
      select: () => {
        throw new Error("il DB non deve essere toccato");
      },
    } as unknown as Db;
    expect(
      await retrieveDecisionContext(failing, { projectId, question: "?? !! ..." }, logger),
    ).toBeNull();
  });

  it("errore del DB → null e una riga di log, mai un'eccezione", async () => {
    const failing = {
      select: () => {
        throw new Error("connessione persa");
      },
    } as unknown as Db;
    const log = { debug: vi.fn() };

    expect(
      await retrieveDecisionContext(failing, { projectId, question: "formato export" }, log),
    ).toBeNull();
    expect(log.debug).toHaveBeenCalled();
  });
});

describe("appendDecisionContext", () => {
  it("con null il system prompt resta identico byte per byte", () => {
    expect(appendDecisionContext("SYSTEM", null)).toBe("SYSTEM");
  });

  it("con un blocco lo appende in coda", () => {
    expect(appendDecisionContext("SYSTEM", "BLOCCO")).toBe("SYSTEM\n\nBLOCCO");
  });
});
