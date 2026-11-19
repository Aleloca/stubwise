import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLog, UNDO_OF_CLAUDE_SETTING, VIA_CLAUDE_SETTING } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0195 (19 nov 2026, area 9, F7, M-5 = a): `change_log` sa che una
 * voce l'ha scritta Claude (`via_claude_action_id`) e quale azione annulla
 * (`undo_of_action_id`), di DEFAULT dalle variabili di transazione
 * dell'esecutore. La tabella resta append-only.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const entry = (subjectId = randomUUID()) => ({ actorEmail: "a@example.com", actorKind: "user" as const, type: "project.renamed", subjectKind: "project", subjectId });

describe("migrazione 0195", () => {
  it("le due colonne prendono le variabili di transazione; fuori sono null", async () => {
    const action = randomUUID();
    const undone = randomUUID();
    const [inside] = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${VIA_CLAUDE_SETTING}, ${action}, true)`);
      await tx.execute(sql`select set_config(${UNDO_OF_CLAUDE_SETTING}, ${undone}, true)`);
      return tx.insert(changeLog).values(entry()).returning();
    });
    expect(inside).toMatchObject({ viaClaudeActionId: action, undoOfActionId: undone });
    const [outside] = await t.db.insert(changeLog).values(entry()).returning();
    expect(outside).toMatchObject({ viaClaudeActionId: null, undoOfActionId: null });
    // Una variabile azzerata (`''`, come la lascia l'esecutore) è null.
    const [cleared] = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${VIA_CLAUDE_SETTING}, '', true)`);
      return tx.insert(changeLog).values(entry()).returning();
    });
    expect(cleared!.viaClaudeActionId).toBeNull();
  });

  it("resta append-only: un UPDATE che scrive il segno di Claude è rifiutato", async () => {
    const [row] = await t.db.insert(changeLog).values(entry()).returning();
    await expect(t.db.update(changeLog).set({ viaClaudeActionId: randomUUID() }).where(eq(changeLog.id, row!.id))).rejects.toThrow();
    await expect(t.db.delete(changeLog).where(eq(changeLog.id, row!.id))).rejects.toThrow();
  });

  it("il migratore ha applicato 0194 e 0195 in fila, e TUTTO il journal nel suo ordine", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0194_graph_job_prune");
    expect(tags.slice(i, i + 2)).toEqual(["0194_graph_job_prune", "0195_change_log_via_claude"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const applied = (await t.db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as { rows?: { created_at: string }[] } & { created_at: string }[];
    expect(((applied.rows ?? applied) as { created_at: string }[]).map((r) => Number(r.created_at))).toEqual(whens);
  });
});
